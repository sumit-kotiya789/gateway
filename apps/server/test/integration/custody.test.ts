import { randomBytes } from 'node:crypto';
import type { ChainConfig } from '@gw/core';
import { evmDeriver } from '@gw/chains';
import { eq } from 'drizzle-orm';
import { HDKey } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withSystem, withTenant } from '../../src/common/db.js';
import { seedRegistry } from '../../src/db/seed-registry.js';
import { chains, depositAddresses, merchants, merchantXpubs, tokens, walletAccounts } from '../../src/db/schema.js';
import { allocateDepositAddress, strategyFor } from '../../src/modules/custody/custody.js';
import { loadRegistry, verifyRegistry } from '../../src/modules/registry/registry.js';
import { CUSTODY_PATHS, buildTestApp, enable2fa, ensurePlatformCustody, ownerPool, signup, totpNow } from './helpers.js';

const t = buildTestApp();
const { app, db, clock } = t;
const owner = ownerPool();
const anvilUrl = inject('anvilUrl');
const seedEnv = { EVM_LOCAL_RPC_URL: anvilUrl };

let local: ChainConfig;
let bsc: ChainConfig;

/** Fresh random account-level key pair (xpub + tpub encodings of the same key). */
function newAccount() {
  const seed = randomBytes(32);
  const path = "m/44'/60'/0'";
  return {
    xpub: HDKey.fromMasterSeed(seed).derive(path).publicExtendedKey,
    tpub: HDKey.fromMasterSeed(seed, { private: 0x04358394, public: 0x043587cf }).derive(path).publicExtendedKey,
  };
}

async function merchant(mode: 'custodial' | 'non_custodial_xpub' | 'non_custodial_forwarder' = 'non_custodial_xpub') {
  return withSystem(db, async (tx) => {
    const [m] = await tx.insert(merchants).values({ name: 'm', custodyMode: mode }).returning();
    if (!m) throw new Error('insert failed');
    return m.id;
  });
}

async function addXpub(merchantId: string, xpub: string, livemode = false) {
  return withSystem(db, async (tx) => {
    const [x] = await tx
      .insert(merchantXpubs)
      .values({ merchantId, family: 'evm', livemode, xpub, keyFingerprint: evmDeriver.keyFingerprint(xpub) })
      .returning();
    if (!x) throw new Error('insert failed');
    return x.id;
  });
}

const alloc = (merchantId: string, chain: ChainConfig, livemode = false, custodialEnabled = false) =>
  withTenant(db, merchantId, (tx) => allocateDepositAddress(tx, { merchantId, livemode, chain }, { custodialEnabled }));

/** Drizzle wraps driver errors; the Postgres message is on cause. */
const pgMsg = (re: RegExp) => (e: unknown) => re.test((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message);

beforeAll(async () => {
  await app.ready();
  await withSystem(db, (tx) => seedRegistry(tx, seedEnv));
  const reg = await withSystem(db, (tx) => loadRegistry(tx));
  local = reg.chains.find((c) => c.id === 'evm-local') as ChainConfig;
  bsc = { ...(reg.chains.find((c) => c.id === 'bsc') as ChainConfig), enabled: true };
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('registry seed', () => {
  it('seeds BSC mainnet USDT with 18 decimals and keeps mainnet disabled', async () => {
    const reg = await withSystem(db, (tx) => loadRegistry(tx));
    const usdt = reg.tokens.find((x) => x.id === 'bsc:usdt');
    expect(usdt).toMatchObject({ contractAddress: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, minAmount: 10n ** 16n });
    expect(usdt?.confirmationTiers.map((x) => x.confirmations)).toEqual([30, 60]);
    expect(reg.chains.find((c) => c.id === 'bsc')?.enabled).toBe(false);
  });

  it('is idempotent and never re-enables what an operator disabled', async () => {
    await owner.query(`update tokens set enabled = false where id = 'bsc:usdt'`);
    await withSystem(db, (tx) => seedRegistry(tx, seedEnv));
    await withSystem(db, (tx) => seedRegistry(tx, seedEnv));
    const r = await owner.query<{ enabled: boolean; n: string }>(`select enabled, (select count(*) from tokens)::text n from tokens where id = 'bsc:usdt'`);
    expect(r.rows[0]?.enabled).toBe(false);
    await owner.query(`update tokens set enabled = true where id = 'bsc:usdt'`);
  });

  it('refuses a seed that changes a token contract or decimals', async () => {
    await expect(owner.query(`update tokens set contract_address = '0x0000000000000000000000000000000000000001' where id = 'bsc:usdt'`)).rejects.toThrow(/immutable/);
    await expect(owner.query(`update tokens set decimals = 6 where id = 'bsc:usdt'`)).rejects.toThrow(/immutable/);
    await expect(owner.query(`update chains set evm_chain_id = 1 where id = 'bsc'`)).rejects.toThrow(/immutable/);
    await expect(t.pool.query(`delete from tokens where id = 'bsc:usdt'`)).rejects.toThrow();
  });
});

describe('registry verification (RPC network id + on-chain decimals)', () => {
  it('passes for a correctly configured local chain', async () => {
    const { anvilAccount, deploy } = await import('../../../../packages/chains/test/support/anvil.js');
    const addr = await deploy(anvilUrl, 'MockERC20', ['Mock USDT', 'USDT', 18], anvilAccount(8));
    const tok = { id: 'evm-local:usdt', chainId: 'evm-local', symbol: 'USDT', name: 'm', contractAddress: addr, decimals: 18, minConfirmations: 2, confirmationTiers: [], minAmount: 1n, enabled: true };
    expect(await verifyRegistry({ chains: [local], tokens: [tok] }, seedEnv)).toEqual([]);
    // Wrong decimals in config
    const wrong = await verifyRegistry({ chains: [local], tokens: [{ ...tok, decimals: 6 }] }, seedEnv);
    expect(wrong.join()).toMatch(/decimals on-chain 18, config 6/);
  });

  it('detects an RPC pointing at the wrong network', async () => {
    const mislabeled = { ...bsc, rpcUrls: ['${EVM_LOCAL_RPC_URL}'] };
    const problems = await verifyRegistry({ chains: [mislabeled], tokens: [] }, seedEnv);
    expect(problems.join()).toMatch(/network id 31337, expected 56/);
    expect(problems.join()).not.toContain(anvilUrl);
  });

  it('reports missing RPC env and unreachable RPCs without leaking URLs', async () => {
    const noEnv = await verifyRegistry({ chains: [{ ...local, rpcUrls: ['${NOPE_RPC}'] }], tokens: [] }, {});
    expect(noEnv.join()).toMatch(/NOPE_RPC/);
    const dead = await verifyRegistry({ chains: [{ ...local, rpcUrls: ['http://127.0.0.1:1/secret-key'] }], tokens: [] }, {});
    expect(dead.join()).toMatch(/unreachable/);
    expect(dead.join()).not.toContain('secret-key');
  });
});

describe('non-custodial allocation', () => {
  it('derives sequential addresses from the merchant xpub', async () => {
    const mid = await merchant();
    const { xpub } = newAccount();
    await addXpub(mid, xpub);
    const got = [await alloc(mid, local), await alloc(mid, local), await alloc(mid, local)];
    expect(got.map((a) => a.derivationIndex)).toEqual([0, 1, 2]);
    for (const a of got) {
      expect(a.address).toBe(evmDeriver.deriveFromXpub(xpub, a.derivationIndex).address);
      expect(a).toMatchObject({ source: 'merchant_xpub', custodyMode: 'non_custodial_xpub', derivationPath: `0/${String(a.derivationIndex)}` });
    }
  });

  it('50 concurrent allocations get 50 distinct, gap-free indices', async () => {
    const mid = await merchant();
    await addXpub(mid, newAccount().xpub);
    const res = await Promise.all(Array.from({ length: 50 }, () => alloc(mid, local)));
    const idx = res.map((a) => a.derivationIndex).sort((a, b) => a - b);
    expect(idx).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(new Set(res.map((a) => a.address)).size).toBe(50);
  });

  it('rolled-back allocation hands out no address and leaves no gap', async () => {
    const mid = await merchant();
    await addXpub(mid, newAccount().xpub);
    await expect(
      withTenant(db, mid, async (tx) => {
        await allocateDepositAddress(tx, { merchantId: mid, livemode: false, chain: local }, { custodialEnabled: false });
        throw new Error('invoice creation failed');
      }),
    ).rejects.toThrow('invoice creation failed');
    expect((await alloc(mid, local)).derivationIndex).toBe(0);
  });

  it('no active xpub -> 409; test xpub is not used for live mode', async () => {
    const mid = await merchant();
    await expect(alloc(mid, local)).rejects.toMatchObject({ code: 'conflict' });
    await addXpub(mid, newAccount().xpub, false);
    await expect(alloc(mid, bsc, true)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('mode/chain mismatches are refused', async () => {
    const mid = await merchant();
    await addXpub(mid, newAccount().xpub);
    await expect(alloc(mid, local, true)).rejects.toMatchObject({ code: 'validation_error' }); // live on testnet
    await expect(alloc(mid, { ...local, enabled: false })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('suspended merchant cannot allocate', async () => {
    const mid = await merchant();
    await addXpub(mid, newAccount().xpub);
    await owner.query(`update merchants set status = 'suspended' where id = $1`, [mid]);
    await expect(alloc(mid, local)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('custody mode selection', () => {
  it('custodial is refused while the feature flag is off', async () => {
    const mid = await merchant('custodial');
    await expect(alloc(mid, local)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('custodial with flag on uses the platform wallet and full path', async () => {
    const mid = await merchant('custodial');
    // One test-mode platform wallet per family, shared by every test file (deterministic test seed).
    const { xpub } = await ensurePlatformCustody(owner);
    const a = await alloc(mid, local, false, true);
    expect(a).toMatchObject({ source: 'platform', custodyMode: 'custodial', derivationPath: `${CUSTODY_PATHS.deposits}/0/${String(a.derivationIndex)}` });
    expect(a.address).toBe(evmDeriver.deriveFromXpub(xpub, a.derivationIndex).address);
  });

  it('only custodial supports withdrawals (non-custodial has no withdrawal path)', () => {
    expect(strategyFor('non_custodial_xpub', { custodialEnabled: true }).supportsWithdrawals()).toBe(false);
    expect(strategyFor('custodial', { custodialEnabled: true }).supportsWithdrawals()).toBe(true);
  });

  it('custodial without a platform wallet for the mode -> 503', async () => {
    const mid = await merchant('custodial');
    await expect(alloc(mid, bsc, true, true)).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('unknown merchant -> 404', async () => {
    await expect(withSystem(db, (tx) => allocateDepositAddress(tx, { merchantId: '00000000-0000-7000-8000-000000000000', livemode: false, chain: local }, { custodialEnabled: false }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('exhausted index space -> 409, never wraps or reuses', async () => {
    const mid = await merchant();
    const x = await addXpub(mid, newAccount().xpub);
    await owner.query('update merchant_xpubs set next_index = 2147483647 where id = $1', [x]);
    expect((await alloc(mid, local)).derivationIndex).toBe(2147483647); // last valid index
    await expect(alloc(mid, local)).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/exhausted/) as unknown });
  });

  it('forwarder mode is not available', async () => {
    const mid = await merchant('non_custodial_forwarder');
    await expect(alloc(mid, local)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('database guards (bypassing application code)', () => {
  it('non-custodial merchant can never get a platform-wallet address', async () => {
    const mid = await merchant();
    const [w] = await withSystem(db, (tx) => tx.select().from(walletAccounts).where(eq(walletAccounts.livemode, false)));
    await expect(
      withSystem(db, (tx) =>
        tx.insert(depositAddresses).values({ merchantId: mid, livemode: false, family: 'evm', chainId: 'evm-local', source: 'platform', walletAccountId: w?.id ?? '', derivationIndex: 999_999, derivationPath: 'x', address: '0x00000000000000000000000000000000000000aa' }),
      ),
    ).rejects.toSatisfy(pgMsg(/not allowed for custody mode/));
  });

  it("a merchant can never get an address from another merchant's xpub", async () => {
    const a = await merchant();
    const b = await merchant();
    const xa = await addXpub(a, newAccount().xpub);
    await expect(
      withSystem(db, (tx) =>
        tx.insert(depositAddresses).values({ merchantId: b, livemode: false, family: 'evm', chainId: 'evm-local', source: 'merchant_xpub', merchantXpubId: xa, derivationIndex: 0, derivationPath: '0/0', address: '0x00000000000000000000000000000000000000bb' }),
      ),
    ).rejects.toSatisfy(pgMsg(/foreign key/));
  });

  it('live address on a testnet chain is rejected', async () => {
    const mid = await merchant();
    const x = await addXpub(mid, newAccount().xpub, true);
    await expect(
      withSystem(db, (tx) =>
        tx.insert(depositAddresses).values({ merchantId: mid, livemode: true, family: 'evm', chainId: 'evm-local', source: 'merchant_xpub', merchantXpubId: x, derivationIndex: 0, derivationPath: '0/0', address: '0x00000000000000000000000000000000000000cc' }),
      ),
    ).rejects.toSatisfy(pgMsg(/mainnet chain/));
  });

  it('address mapping is immutable and undeletable; counters never go backwards', async () => {
    const mid = await merchant();
    const x = await addXpub(mid, newAccount().xpub);
    const a = await alloc(mid, local);
    await expect(withSystem(db, (tx) => tx.update(depositAddresses).set({ address: '0x00000000000000000000000000000000000000dd' }).where(eq(depositAddresses.id, a.id)))).rejects.toSatisfy(pgMsg(/immutable/));
    await expect(withSystem(db, (tx) => tx.delete(depositAddresses).where(eq(depositAddresses.id, a.id)))).rejects.toThrow();
    await expect(owner.query('delete from deposit_addresses where id = $1', [a.id])).rejects.toThrow(/append-only/);
    await expect(withSystem(db, (tx) => tx.update(merchantXpubs).set({ nextIndex: 0 }).where(eq(merchantXpubs.id, x)))).rejects.toSatisfy(pgMsg(/backwards/));
    await expect(withSystem(db, (tx) => tx.update(merchantXpubs).set({ xpub: newAccount().xpub }).where(eq(merchantXpubs.id, x)))).rejects.toSatisfy(pgMsg(/immutable/));
  });

  it('the same key cannot be registered twice, even in tpub encoding or by another merchant', async () => {
    const { xpub, tpub } = newAccount();
    await addXpub(await merchant(), xpub);
    await expect(addXpub(await merchant(), tpub)).rejects.toSatisfy(pgMsg(/duplicate key|already registered/));
  });

  it("a merchant cannot register the platform wallet's key", async () => {
    const [w] = await withSystem(db, (tx) => tx.select().from(walletAccounts).where(eq(walletAccounts.livemode, false)));
    await expect(addXpub(await merchant(), w?.xpub ?? '')).rejects.toSatisfy(pgMsg(/already registered/));
  });

  it('RLS: merchants see only their own xpubs and addresses', async () => {
    const a = await merchant();
    const b = await merchant();
    await addXpub(a, newAccount().xpub);
    await alloc(a, local);
    const seenByB = await withTenant(db, b, async (tx) => ({
      x: await tx.select().from(merchantXpubs),
      d: await tx.select().from(depositAddresses),
    }));
    expect(seenByB.x).toHaveLength(0);
    expect(seenByB.d).toHaveLength(0);
  });
});

describe('GET /v1/chains and /v1/tokens', () => {
  it('test key sees enabled testnets only; amounts are decimal strings', async () => {
    await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
      values ('evm-local:usdt', 'evm-local', 'USDT', 'Local mock USDT', '0x5FbDB2315678afecb367f032d93F642f64180aa3', 18, 2, 10000000000000000, true)
      on conflict do nothing`);
    const s = await signup(app);
    const { secret } = await enable2fa(s.agent, clock);
    clock.advance(30_000);
    const key = (
      await s.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: false, scopes: ['read'] }, { 'x-totp-code': totpNow(secret, clock()) })
    ).json<{ key: string }>().key;
    const auth = { authorization: `Bearer ${key}` };

    const ch = (await app.inject({ url: '/v1/chains', headers: auth })).json<{ data: { id: string; testnet: boolean }[] }>();
    // Other test files register extra testnet chains in the shared DB: assert the rule, not an exact list.
    expect(ch.data.map((c) => c.id)).toEqual(expect.arrayContaining(['nexis', 'evm-local']));
    expect(ch.data.map((c) => c.id)).not.toContain('bsc');
    expect(ch.data.map((c) => c.id)).not.toContain('bsc-testnet'); // seeded disabled: Nexis is the test network
    expect(ch.data.every((c) => c.testnet)).toBe(true);

    const tk = (await app.inject({ url: '/v1/tokens', headers: auth })).json<{ data: { id: string; min_amount: string }[] }>();
    expect(tk.data.find((x) => x.id === 'evm-local:usdt')?.min_amount).toBe('0.01');
    expect(tk.data.some((x) => x.id === 'bsc:usdt')).toBe(false);

    expect((await app.inject({ url: '/v1/chains' })).statusCode).toBe(401);
  });

  it('registry tables expose no secrets: RPC placeholders, not keys', async () => {
    const r = await owner.query<{ rpc_urls: string[] }>(`select rpc_urls from chains where id = 'bsc'`);
    expect(r.rows[0]?.rpc_urls[0]).toBe('${BSC_RPC_URL}');
    const [row] = await withSystem(db, (tx) => tx.select().from(chains).where(eq(chains.id, 'bsc')));
    expect(row?.testnet).toBe(false);
    const [tok] = await withSystem(db, (tx) => tx.select().from(tokens).where(eq(tokens.id, 'bsc:usdt')));
    expect(typeof tok?.minAmount).toBe('bigint');
  });
});
