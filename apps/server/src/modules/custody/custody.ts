// MONEY-CRITICAL
// Custody strategy layer: where a payment's deposit address comes from. Every invoice gets a fresh address from an
// atomically incremented derivation index; an index is never handed out twice (DB counters only move forward).
// Non-custodial modes have no code path to keys, sweeps or withdrawals (see docs/CUSTODY.md); forwarder mode only asks
// the signer to pay gas for a flush whose destinations are fixed by the contract address (D-097).
import type { AllocationRequest, ChainConfig, CustodyMode, CustodyStrategy, DepositAddress } from '@gw/core';
import { AppError, uuidv7 } from '@gw/core';
import { MAX_NON_HARDENED_INDEX, deriverFor, forwarderAddress, forwarderFeeOn, forwarderSalt } from '@gw/chains';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { getAddress } from 'viem';
import type { Tx } from '../../common/db.js';
import { depositAddresses, forwarderParams, merchants, merchantXpubs, platformWallets, walletAccounts } from '../../db/schema.js';
import { currentPayoutAddress } from './payout-addresses.js';

function assertChainUsable(chain: ChainConfig, livemode: boolean): void {
  if (!chain.enabled) throw new AppError('validation_error', `chain ${chain.id} is not enabled`);
  if (chain.testnet === livemode) {
    throw new AppError('validation_error', livemode ? 'live mode requires a mainnet chain' : 'test mode requires a testnet chain');
  }
}

async function insertAddress(
  tx: Tx,
  req: AllocationRequest,
  src: { source: 'platform'; walletAccountId: string } | { source: 'merchant_xpub'; merchantXpubId: string },
  index: number,
  address: string,
  path: string,
): Promise<DepositAddress> {
  const [row] = await tx
    .insert(depositAddresses)
    .values({
      merchantId: req.merchantId,
      livemode: req.livemode,
      family: req.chain.family,
      chainId: req.chain.id,
      source: src.source,
      walletAccountId: src.source === 'platform' ? src.walletAccountId : null,
      merchantXpubId: src.source === 'merchant_xpub' ? src.merchantXpubId : null,
      derivationIndex: index,
      derivationPath: path,
      address,
    })
    .returning();
  if (!row) throw new Error('deposit address insert failed');
  return { id: row.id, address: row.address, chainId: row.chainId, source: row.source, derivationIndex: row.derivationIndex, derivationPath: row.derivationPath };
}

/** Index of the row just incremented. Safe as int: the WHERE guard keeps next_index - 1 <= 2^31 - 1. */
const claimedIndex = (col: typeof merchantXpubs.nextIndex | typeof walletAccounts.nextIndex) => sql<number>`(${col} - 1)::int`;

/** Funds land in merchant-controlled addresses derived from the merchant's own account xpub. */
export const nonCustodialXpubStrategy: CustodyStrategy<Tx> = {
  mode: 'non_custodial_xpub',
  async allocateDepositAddress(tx, req) {
    assertChainUsable(req.chain, req.livemode);
    const active = and(
      eq(merchantXpubs.merchantId, req.merchantId),
      eq(merchantXpubs.livemode, req.livemode),
      eq(merchantXpubs.family, req.chain.family),
      eq(merchantXpubs.status, 'active'),
    );
    // UPDATE ... RETURNING takes the row lock: concurrent allocations serialize and get distinct indices.
    // The lte guard makes an exhausted xpub return no row instead of overflowing the derivation range.
    const [x] = await tx
      .update(merchantXpubs)
      .set({ nextIndex: sql`${merchantXpubs.nextIndex} + 1` })
      .where(and(active, lte(merchantXpubs.nextIndex, MAX_NON_HARDENED_INDEX)))
      .returning({ id: merchantXpubs.id, xpub: merchantXpubs.xpub, index: claimedIndex(merchantXpubs.nextIndex) });
    if (!x) {
      const [exists] = await tx.select({ id: merchantXpubs.id }).from(merchantXpubs).where(active);
      throw new AppError(
        'conflict',
        exists
          ? 'derivation index space exhausted; register a new xpub'
          : `no active ${req.chain.family} xpub configured for ${req.livemode ? 'live' : 'test'} mode`,
      );
    }
    const { address, path } = deriverFor(req.chain.family).deriveFromXpub(x.xpub, x.index);
    return insertAddress(tx, req, { source: 'merchant_xpub', merchantXpubId: x.id }, x.index, address, path);
  },
  supportsWithdrawals: () => false,
};

/** Funds land in platform-derived addresses (seed only in the signer). Behind FEATURE_CUSTODIAL. */
export const custodialStrategy: CustodyStrategy<Tx> = {
  mode: 'custodial',
  async allocateDepositAddress(tx, req) {
    assertChainUsable(req.chain, req.livemode);
    const [w] = await tx
      .update(walletAccounts)
      .set({ nextIndex: sql`${walletAccounts.nextIndex} + 1` })
      .where(
        and(
          eq(walletAccounts.family, req.chain.family),
          eq(walletAccounts.livemode, req.livemode),
          lte(walletAccounts.nextIndex, MAX_NON_HARDENED_INDEX),
        ),
      )
      .returning({ id: walletAccounts.id, xpub: walletAccounts.xpub, basePath: walletAccounts.basePath, index: claimedIndex(walletAccounts.nextIndex) });
    // Missing or exhausted platform wallet is an operator problem, not a merchant one.
    if (!w) throw new AppError('service_unavailable', `no usable platform ${req.chain.family} wallet for ${req.livemode ? 'live' : 'test'} mode`);
    const { address, path } = deriverFor(req.chain.family).deriveFromXpub(w.xpub, w.index);
    return insertAddress(tx, req, { source: 'platform', walletAccountId: w.id }, w.index, address, `${w.basePath}/${path}`);
  },
  supportsWithdrawals: () => true,
};

/**
 * Funds land on a CREATE2 forwarder address (D-097) that commits to the merchant's current payout address, the platform
 * fee wallet, the invoice token, the fee rate and the fee cap (the fee on the invoice amount). No key exists for it:
 * once deployed, the contract can only send what it holds to those two addresses. The committed values are stored in
 * forwarder_params (DB-guarded) so the worker and, independently, the signer can rebuild the address before flushing.
 */
export const forwarderStrategy: CustodyStrategy<Tx> = {
  mode: 'non_custodial_forwarder',
  async allocateDepositAddress(tx, req) {
    assertChainUsable(req.chain, req.livemode);
    const terms = req.terms;
    if (!terms) throw new Error('forwarder allocation needs the invoice terms');
    const factory = req.chain.forwarderFactory;
    if (!factory) throw new AppError('validation_error', `wallet-address payments are not available on chain ${req.chain.id}`);
    const payout = await currentPayoutAddress(tx, req.merchantId, req.livemode, req.chain.family);
    if (!payout) {
      throw new AppError('conflict', `no active payout wallet address configured for ${req.livemode ? 'live' : 'test'} mode`);
    }
    const [fee] = await tx
      .select()
      .from(platformWallets)
      .where(and(eq(platformWallets.kind, 'fee'), eq(platformWallets.family, req.chain.family), eq(platformWallets.livemode, req.livemode), isNull(platformWallets.retiredAt)));
    // A missing fee wallet is an operator problem, not a merchant one.
    /* v8 ignore next -- operator misconfiguration; retiring the shared test fee wallet would disturb test files running in
       parallel. The forwarder_params DB guard refuses the same case (an inactive or non-fee wallet). */
    if (!fee) throw new AppError('service_unavailable', `no platform fee wallet for ${req.livemode ? 'live' : 'test'} mode`);

    const id = uuidv7();
    const salt = forwarderSalt(id);
    const params = {
      merchant: getAddress(payout.address),
      feeRecipient: getAddress(fee.address),
      token: getAddress(terms.tokenContract),
      feeBps: terms.feeBps,
      feeCap: terms.feeCap ?? forwarderFeeOn(terms.amountExpected, terms.feeBps),
    };
    const address = forwarderAddress(factory, salt, params);
    const [row] = await tx
      .insert(depositAddresses)
      .values({
        id,
        merchantId: req.merchantId,
        livemode: req.livemode,
        family: req.chain.family,
        chainId: req.chain.id,
        source: 'forwarder',
        walletAccountId: null,
        merchantXpubId: null,
        derivationIndex: 0,
        derivationPath: 'create2',
        address,
      })
      .returning();
    if (!row) throw new Error('deposit address insert failed');
    await tx.insert(forwarderParams).values({
      depositAddressId: id,
      merchantId: req.merchantId,
      livemode: req.livemode,
      chainId: req.chain.id,
      tokenId: terms.tokenId,
      factory: getAddress(factory),
      salt,
      payoutAddressId: payout.id,
      merchantAddress: params.merchant,
      feeWalletId: fee.id,
      feeRecipient: params.feeRecipient,
      tokenContract: params.token,
      feeBps: params.feeBps,
      feeCap: params.feeCap,
    });
    return { id: row.id, address: row.address, chainId: row.chainId, source: row.source, derivationIndex: row.derivationIndex, derivationPath: row.derivationPath };
  },
  supportsWithdrawals: () => false,
};

export interface StrategyOptions {
  custodialEnabled: boolean;
  forwarderEnabled?: boolean;
}

export function strategyFor(mode: CustodyMode, opts: StrategyOptions): CustodyStrategy<Tx> {
  switch (mode) {
    case 'non_custodial_xpub':
      return nonCustodialXpubStrategy;
    case 'custodial':
      if (!opts.custodialEnabled) throw new AppError('forbidden', 'custodial mode is not enabled on this deployment');
      return custodialStrategy;
    case 'non_custodial_forwarder':
      if (!opts.forwarderEnabled) throw new AppError('forbidden', 'wallet-address (forwarder) mode is not enabled on this deployment');
      return forwarderStrategy;
    default: {
      const never: never = mode;
      throw new Error(`unknown custody mode ${String(never)}`);
    }
  }
}

/** Allocates a fresh deposit address for a merchant, per its custody mode. Runs inside the caller's transaction. */
export async function allocateDepositAddress(
  tx: Tx,
  req: AllocationRequest,
  opts: StrategyOptions,
): Promise<DepositAddress & { custodyMode: CustodyMode }> {
  const [m] = await tx.select({ mode: merchants.custodyMode, status: merchants.status }).from(merchants).where(eq(merchants.id, req.merchantId));
  if (!m) throw new AppError('not_found', 'merchant not found');
  if (m.status !== 'active') throw new AppError('forbidden', 'merchant is suspended');
  const addr = await strategyFor(m.mode, opts).allocateDepositAddress(tx, req);
  return { ...addr, custodyMode: m.mode };
}
