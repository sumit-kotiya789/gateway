// MONEY-CRITICAL
// The only code that signs transactions (D-019, D-088). It takes an intent (kind + id of a database record), never a
// raw transaction: it re-reads the record, re-derives every address from its own seed, checks balances, limits and
// the kill switch, builds the transaction itself and records what it signed. One transaction per intent: asking
// again returns the same signed bytes, so the worker can rebroadcast without ever creating a second payment.
import { toMinorUnits } from '@gw/core';
import type pg from 'pg';
import { encodeFunctionData, erc20Abi, parseUnits, keccak256 } from 'viem';
import type { ChainRpc } from './chain.js';
import type { SignerConfig } from './config.js';
import { sameAddress, type Keyring } from './keys.js';

export type IntentKind = 'gas_topup' | 'sweep' | 'withdrawal' | 'treasury';
export interface Intent {
  kind: IntentKind;
  id: string;
}

export interface Signed {
  tx_hash: string;
  raw_tx: string;
  from: string;
  to: string;
  nonce: string;
  reused: boolean;
}

/** A request the signer will not sign. `code` is safe to return to the worker. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ChainRow {
  id: string;
  evm_chain_id: number;
  rpc_urls: string[];
  enabled: boolean;
  family: string;
}

/** What a handler wants signed. The core adds nonce, gas price and the signature. */
interface Plan {
  chain: ChainRow;
  rpc: ChainRpc;
  fromPath: string;
  from: string;
  /** Transaction `to`: the recipient for native transfers, the token contract for token transfers. */
  txTo: string;
  /** Who receives the value (logged and limited). */
  recipient: string;
  value: bigint;
  data?: `0x${string}`;
  gas: bigint;
  gasPrice: bigint;
  tokenId: string | null;
  amount: bigint;
}

export interface SignerDeps {
  pool: pg.Pool;
  keyring: Keyring;
  config: SignerConfig;
  rpcFor: (chain: ChainRow) => ChainRpc;
}

/** Gas top-ups cover the sweep at the current price plus this margin (percent). */
const TOPUP_MARGIN_PCT = 20n;

export function createSigner(deps: SignerDeps) {
  const { pool, keyring, config } = deps;
  const maxGasPrice = parseUnits(config.SIGNER_MAX_GAS_PRICE_GWEI, 9);
  const maxTopup = parseUnits(config.SIGNER_MAX_GAS_TOPUP, 18);
  const tokenGas = BigInt(config.SIGNER_TOKEN_TRANSFER_GAS);

  async function one<T extends pg.QueryResultRow>(q: string, args: unknown[]): Promise<T | undefined> {
    return (await pool.query<T>(q, args)).rows[0];
  }

  async function chainOf(chainId: string): Promise<{ chain: ChainRow; rpc: ChainRpc; gasPrice: bigint }> {
    const chain = await one<ChainRow>('select id, evm_chain_id, rpc_urls, enabled, family from chains where id = $1', [chainId]);
    if (!chain?.enabled) throw new Refusal('chain_disabled', 'chain is disabled');
    const rpc = deps.rpcFor(chain);
    if ((await rpc.chainId()) !== chain.evm_chain_id) throw new Refusal('rpc_wrong_chain', 'RPC reports another chain id');
    const gasPrice = await rpc.gasPrice();
    if (gasPrice > maxGasPrice) throw new Refusal('gas_price_too_high', 'network gas price is above SIGNER_MAX_GAS_PRICE_GWEI');
    return { chain, rpc, gasPrice };
  }

  /** The active hot or gas wallet of a family and mode, verified against this signer's own derivation. */
  async function platformWallet(kind: 'hot' | 'gas', family: string, livemode: boolean): Promise<{ address: string; path: string }> {
    const w = await one<{ address: string; derivation_path: string }>(
      'select address, derivation_path from platform_wallets where kind = $1 and family = $2 and livemode = $3 and retired_at is null',
      [kind, family, livemode],
    );
    if (!w) throw new Refusal('no_platform_wallet', `no active ${kind} wallet`);
    if (!sameAddress(keyring.address(w.derivation_path), w.address)) {
      throw new Refusal('wallet_mismatch', `the registered ${kind} wallet is not derived from this signer's seed`);
    }
    return { address: w.address, path: w.derivation_path };
  }

  interface SweepRow {
    id: string;
    status: string;
    livemode: boolean;
    chain_id: string;
    token_id: string;
    from_address: string;
    to_address: string;
    amount: string;
    deposit_address_id: string;
    derivation_path: string;
    deposit_address: string;
    source: string;
    base_path: string;
    xpub: string;
    contract_address: string;
  }

  /** A sweep, its deposit address verified as derived from this seed and holding at least what is booked for it. */
  async function verifiedSweep(id: string, statuses: string[]): Promise<SweepRow> {
    const s = await one<SweepRow>(
      `select s.id, s.status, s.livemode, s.chain_id, s.token_id, s.from_address, s.to_address, s.amount::text,
              s.deposit_address_id, d.derivation_path, d.address as deposit_address, d.source, w.base_path, w.xpub, t.contract_address
       from sweeps s join deposit_addresses d on d.id = s.deposit_address_id join wallet_accounts w on w.id = d.wallet_account_id
       join tokens t on t.id = s.token_id where s.id = $1`,
      [id],
    );
    if (!s) throw new Refusal('not_found', 'sweep not found');
    if (!statuses.includes(s.status)) throw new Refusal('wrong_status', `sweep is ${s.status}`);
    // Platform address, under the wallet account's path, from an account key this seed derives, at exactly the
    // address the sweep moves (the DB guards say the same; the signer does not rely on them).
    const ours =
      s.source === 'platform' &&
      s.derivation_path.startsWith(`${s.base_path}/`) &&
      keyring.xpub(s.base_path) === s.xpub &&
      sameAddress(keyring.address(s.derivation_path), s.deposit_address) &&
      sameAddress(s.deposit_address, s.from_address);
    if (!ours) throw new Refusal('not_our_address', "deposit address is not derived from this signer's seed");
    // Never more than the confirmed payments to this address minus what earlier sweeps of it already moved.
    const b = await one<{ booked: string | null }>(
      `select (coalesce((select sum(p.amount) from payments p join invoices i on i.id = p.invoice_id
                         where i.deposit_address_id = $1 and p.status = 'confirmed'), 0)
             - coalesce((select sum(x.amount) from sweeps x where x.deposit_address_id = $1 and x.status = 'confirmed' and x.id <> $2), 0))::text as booked`,
      [s.deposit_address_id, s.id],
    );
    /* v8 ignore next -- an aggregate without GROUP BY returns exactly one row */
    if (!b?.booked) throw new Error('booked amount query returned no row');
    if (BigInt(s.amount) > BigInt(b.booked)) throw new Refusal('over_booked', 'sweep amount exceeds what is booked for the address');
    return s;
  }

  const handlers: Partial<Record<IntentKind, (id: string) => Promise<Plan>>> = {
    async gas_topup(id) {
      const s = await verifiedSweep(id, ['pending']);
      const { chain, rpc, gasPrice } = await chainOf(s.chain_id);
      const gas = await platformWallet('gas', chain.family, s.livemode);
      const need = (tokenGas * gasPrice * (100n + TOPUP_MARGIN_PCT)) / 100n;
      const have = await rpc.nativeBalance(s.deposit_address);
      const value = need - have;
      if (value <= 0n) throw new Refusal('not_needed', 'deposit address already holds enough for its sweep');
      if (value > maxTopup) throw new Refusal('over_limit', 'gas top-up above SIGNER_MAX_GAS_TOPUP');
      return { chain, rpc, fromPath: gas.path, from: gas.address, txTo: s.deposit_address, recipient: s.deposit_address, value, gas: 21_000n, gasPrice, tokenId: null, amount: value };
    },

    async sweep(id) {
      const s = await verifiedSweep(id, ['pending', 'gas_sent']);
      const { chain, rpc, gasPrice } = await chainOf(s.chain_id);
      const hot = await platformWallet('hot', chain.family, s.livemode);
      if (!sameAddress(hot.address, s.to_address)) throw new Refusal('wrong_destination', 'sweep does not go to the active hot wallet');
      const amount = BigInt(s.amount);
      if ((await rpc.tokenBalance(s.contract_address, s.deposit_address)) < amount) throw new Refusal('insufficient_funds', 'deposit address holds less than the sweep');
      if ((await rpc.nativeBalance(s.deposit_address)) < tokenGas * gasPrice) throw new Refusal('needs_gas', 'deposit address cannot pay the network fee yet');
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [hot.address as `0x${string}`, amount] });
      return { chain, rpc, fromPath: s.derivation_path, from: s.deposit_address, txTo: s.contract_address, recipient: hot.address, value: 0n, data, gas: tokenGas, gasPrice, tokenId: s.token_id, amount };
    },

    async withdrawal(id) {
      const w = await one<{
        status: string;
        livemode: boolean;
        merchant_id: string;
        chain_id: string;
        token_id: string;
        amount: string;
        to_address: string;
        payout_address_id: string;
        approvals_required: number;
        approvals: number;
        contract_address: string;
        merchant_status: string;
        custody_mode: string;
        frozen: boolean;
      }>(
        `select w.status, w.livemode, w.merchant_id, w.chain_id, w.token_id, w.amount::text, w.to_address, w.payout_address_id,
                w.approvals_required, cardinality(w.approved_by) as approvals, t.contract_address,
                m.status as merchant_status, m.custody_mode, 'payouts_frozen' = any (m.risk_flags) as frozen
         from withdrawals w join tokens t on t.id = w.token_id join merchants m on m.id = w.merchant_id where w.id = $1`,
        [id],
      );
      if (!w) throw new Refusal('not_found', 'withdrawal not found');
      if (w.status !== 'approved') throw new Refusal('wrong_status', `withdrawal is ${w.status}`);
      /* v8 ignore next -- the withdrawals guard only lets a withdrawal become approved with its approvals */
      if (w.approvals < w.approvals_required) throw new Refusal('not_approved', 'withdrawal lacks its approvals');
      if (w.merchant_status !== 'active' || w.custody_mode !== 'custodial') throw new Refusal('merchant_inactive', 'merchant is not an active custodial account');
      if (w.frozen) throw new Refusal('payouts_frozen', 'payouts are frozen for this merchant');
      const { chain, rpc, gasPrice } = await chainOf(w.chain_id);
      // Still the merchant's current payout address (a newer one, or a cancellation, stops older requests).
      const cur = await one<{ id: string; address: string }>(
        `select id, address from payout_addresses where merchant_id = $1 and livemode = $2 and family = $3 and cancelled_at is null and activates_at <= now()
         order by activates_at desc, created_at desc limit 1`,
        [w.merchant_id, w.livemode, chain.family],
      );
      if (cur?.id !== w.payout_address_id || !sameAddress(cur.address, w.to_address)) throw new Refusal('payout_address_changed', 'payout address is no longer current');
      // The amount is held for exactly this withdrawal, and nothing has released or paid it yet.
      const j = await one<{ hold: string; other: string }>(
        `select coalesce(sum(e.amount) filter (where j.kind = 'withdrawal_hold'), 0)::text as hold, count(*) filter (where j.kind <> 'withdrawal_hold')::text as other
         from ledger_journals j join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id and a.kind = 'merchant_withdrawing'
         where j.withdrawal_id = $1`,
        [id],
      );
      const amount = BigInt(w.amount);
      /* v8 ignore next -- the hold is posted in the request's own transaction; releases only follow final states */
      if (BigInt(j?.hold ?? '0') !== -amount || j?.other !== '0') throw new Refusal('hold_mismatch', 'withdrawal hold does not match');
      const hot = await platformWallet('hot', chain.family, w.livemode);
      if ((await rpc.tokenBalance(w.contract_address, hot.address)) < amount) throw new Refusal('insufficient_funds', 'hot wallet holds less than the withdrawal');
      if ((await rpc.nativeBalance(hot.address)) < tokenGas * gasPrice) throw new Refusal('needs_gas', 'hot wallet cannot pay the network fee');
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [w.to_address as `0x${string}`, amount] });
      return { chain, rpc, fromPath: hot.path, from: hot.address, txTo: w.contract_address, recipient: w.to_address, value: 0n, data, gas: tokenGas, gasPrice, tokenId: w.token_id, amount };
    },
  };

  /** Per-token daily and per-transaction limits for intents that pay out of the hot wallet (withdrawals, treasury). */
  async function checkLimits(kind: IntentKind, plan: Plan): Promise<void> {
    if (kind !== 'withdrawal' && kind !== 'treasury') return;
    // Payouts are token transfers: tokenId is always set here.
    const tokenId = plan.tokenId ?? '';
    const limits = config.SIGNER_LIMITS[tokenId];
    if (!limits) throw new Refusal('no_limits', 'no signer limits configured for this token');
    const t = await one<{ decimals: number }>('select decimals from tokens where id = $1', [tokenId]);
    /* v8 ignore next -- the plan's token came from the database just before */
    if (!t) throw new Refusal('not_found', 'token not found');
    if (plan.amount > toMinorUnits(limits.per_tx, t.decimals)) throw new Refusal('over_limit', 'amount above the per-transaction limit');
    const day = await one<{ total: string }>(
      `select coalesce(sum(amount), 0)::text as total from signer_signatures
       where token_id = $1 and intent_kind in ('withdrawal', 'treasury') and created_at > now() - interval '24 hours'`,
      [tokenId],
    );
    /* v8 ignore next -- an aggregate without GROUP BY returns exactly one row */
    if (!day) throw new Error('daily total query returned no row');
    if (BigInt(day.total) + plan.amount > toMinorUnits(limits.per_day, t.decimals)) throw new Refusal('over_limit', 'amount above the 24-hour limit');
  }

  async function priorSignature(intent: Intent): Promise<Signed | undefined> {
    const p = await one<{ tx_hash: string; raw_tx: string; from_address: string; to_address: string; nonce: string }>(
      'select tx_hash, raw_tx, from_address, to_address, nonce::text from signer_signatures where intent_kind = $1 and intent_id = $2',
      [intent.kind, intent.id],
    );
    return p && { tx_hash: p.tx_hash, raw_tx: p.raw_tx, from: p.from_address, to: p.to_address, nonce: p.nonce, reused: true };
  }

  async function sign(intent: Intent): Promise<Signed> {
    try {
      return await signOnce(intent);
    } catch (err) {
      // Two identical requests raced: the loser returns the winner's transaction.
      if ((err as { code?: string; constraint?: string }).constraint === 'signer_signatures_intent_uq') {
        const p = await priorSignature(intent);
        if (p) return p;
      }
      throw err;
    }
  }

  async function signOnce(intent: Intent): Promise<Signed> {
    const paused = config.SIGNER_PAUSED || (await one<{ paused: boolean }>('select paused from signer_controls where id = 1', []))?.paused !== false;
    if (paused) throw new Refusal('paused', 'signer is paused');
    const prior = await priorSignature(intent);
    if (prior) return prior;
    const handler = handlers[intent.kind];
    if (!handler) throw new Refusal('unsupported', `intent ${intent.kind} is not supported yet`);
    const plan = await handler(intent.id);
    await checkLimits(intent.kind, plan);

    const c = await pool.connect();
    try {
      await c.query('begin');
      // One nonce sequence per sender: serialize signers of the same address.
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`${plan.chain.id}:${plan.from.toLowerCase()}`]);
      const last = await c.query<{ n: string | null }>('select max(nonce)::text as n from signer_signatures where chain_id = $1 and lower(from_address) = lower($2)', [plan.chain.id, plan.from]);
      const fromDb = last.rows[0]?.n === null || last.rows[0]?.n === undefined ? 0n : BigInt(last.rows[0].n) + 1n;
      const pending = await plan.rpc.pendingNonce(plan.from);
      const nonce = pending > fromDb ? pending : fromDb;
      const account = keyring.account(plan.fromPath);
      /* v8 ignore next -- handlers derive `from` from this same path */
      if (!sameAddress(account.address, plan.from)) throw new Refusal('not_our_address', 'sender does not match its derivation');
      const raw = await account.signTransaction({
        type: 'legacy',
        chainId: plan.chain.evm_chain_id,
        nonce: Number(nonce),
        to: plan.txTo as `0x${string}`,
        value: plan.value,
        gas: plan.gas,
        gasPrice: plan.gasPrice,
        ...(plan.data ? { data: plan.data } : {}),
      });
      const txHash = keccak256(raw);
      await c.query(
        `insert into signer_signatures (id, intent_kind, intent_id, chain_id, from_address, to_address, token_id, amount, nonce, tx_hash, raw_tx)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [intent.kind, intent.id, plan.chain.id, plan.from, plan.recipient, plan.tokenId, plan.amount.toString(), nonce.toString(), txHash, raw],
      );
      await c.query('commit');
      return { tx_hash: txHash, raw_tx: raw, from: plan.from, to: plan.recipient, nonce: nonce.toString(), reused: false };
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
  }

  return { sign };
}

