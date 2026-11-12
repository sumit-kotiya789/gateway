// Per-merchant network (D-113): the merchant chooses one mainnet (owner or admin + 2FA); new receiving objects on other
// chains are refused, what exists keeps working, test mode is untouched, and the database only accepts a mainnet.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '../../src/common/db.js';
import { merchants } from '../../src/db/schema.js';
import { LOCAL_USDT, adminAgent, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
const A = 'evm-mainsim';
const B = 'evm-mainsim2';

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await ensureLiveSimRegistry(owner);
  // A second simulated mainnet (never reachable: nothing here talks to an RPC).
  await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
      default_confirmations, reorg_depth, finality, testnet, enabled)
    values ('${B}', 'evm', 'Second simulated mainnet', 31339, $1, 'ETH', 18, 1000, 2, 16, 'tag', false, true)
    on conflict do nothing`, [['http://127.0.0.1:1']]);
  await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
    values ('${B}:usdt', '${B}', 'USDT', 'Simulated USDT 2', $1, 18, 2, 10000000000000000, true)
    on conflict do nothing`, [LOCAL_USDT]);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

type M = Awaited<ReturnType<typeof merchantWithKey>>;
const ids = (r: { json: () => unknown }) => (r.json() as { data: { id: string }[] }).data.map((x) => x.id);
const invoice = (m: M, token: string) => m.api('POST', '/v1/invoices', { amount: '5', token });

describe('merchant network (D-113)', () => {
  it('limits new invoices, payment links and deposit accounts to one mainnet; existing ones keep working', async () => {
    const m = await merchantWithKey(app, clock, owner, { livemode: true, scopes: ['read', 'invoices:write'] });
    // Live xpub merchants pay fees in advance (D-076): a grace lets this test create live invoices.
    await owner.query('update merchants set fee_grace = 1000 where id = $1', [m.merchantId]);

    // Before: every enabled mainnet.
    expect(ids(await m.api('GET', '/v1/tokens'))).toEqual(expect.arrayContaining([`${A}:usdt`, `${B}:usdt`]));
    const before = (await invoice(m, `${B}:usdt`)).json<{ id: string }>();
    const link = (await m.api('POST', '/v1/payment-links', { amount: '5', token: `${B}:usdt` })).json<{ id: string }>();
    expect((await m.api('POST', '/v1/deposit-accounts', { customer_ref: 'u1', token: `${B}:usdt` })).statusCode).toBe(201);
    expect((await app.inject({ url: `/pay/${link.id}` })).statusCode).toBe(200);

    // The merchant chooses: 2FA required, enabled mainnets only, audited.
    const code = () => {
      clock.advance(30_000);
      return { 'x-totp-code': totpNow(m.secret, clock()) };
    };
    const put = (network: string | null, h: Record<string, string> = code()) => m.agent.req('PUT', '/v1/dashboard/settings/network', { network }, h);
    const settings = (await m.agent.req('GET', '/v1/dashboard/settings/')).json<{ network: string | null; networks: { id: string }[] }>();
    expect(settings.network).toBeNull();
    expect(settings.networks.map((n) => n.id)).toEqual(expect.arrayContaining([A, B]));
    expect(settings.networks.map((n) => n.id)).not.toContain('evm-local');
    expect((await put(A, {})).statusCode).toBe(403);
    expect((await put('evm-local')).statusCode).toBe(400);
    expect((await put('eth')).statusCode).toBe(400); // a mainnet that is switched off (seeded off, D-112)
    expect((await put('nope')).statusCode).toBe(400);
    const set = await put(A);
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ network: A });
    expect((await put(A)).json()).toEqual({ network: A }); // unchanged: no second audit entry
    const { rows } = await owner.query(`select before, after from audit_logs where merchant_id = $1 and action = 'settings.network'`, [m.merchantId]);
    expect(rows).toEqual([{ before: { network: null }, after: { network: A } }]);
    // Admins see it, read-only.
    const op = await adminAgent(t, owner, 'auditor');
    expect((await op.agent.req('GET', `/admin/v1/merchants/${m.merchantId}`)).json()).toMatchObject({ network: A });

    // Listings show only that network: API and dashboard.
    expect(ids(await m.api('GET', '/v1/chains'))).toEqual([A]);
    expect(ids(await m.api('GET', '/v1/tokens'))).toEqual([`${A}:usdt`]);
    const dash = (await m.agent.req('GET', '/v1/dashboard/tokens/?livemode=true')).json<{ data: { id: string }[]; network: string | null }>();
    expect(dash).toMatchObject({ network: A, data: [{ id: `${A}:usdt` }] });
    expect((await m.agent.req('GET', '/v1/dashboard/auth/me')).json()).toMatchObject({ merchant: { network: A } });

    // New receiving objects on another chain are refused, with a clear reason.
    const refused = await invoice(m, `${B}:usdt`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'validation_error', message: expect.stringContaining('receives payments on Simulated mainnet only') } });
    expect((await m.api('POST', '/v1/payment-links', { amount: '5', token: `${B}:usdt` })).statusCode).toBe(400);
    expect((await m.api('POST', '/v1/deposit-accounts', { customer_ref: 'u1', token: `${B}:usdt` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/pay/${link.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/pay/${link.id}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' })).statusCode).toBe(404);

    // Its own network works; what already exists is untouched.
    expect((await invoice(m, `${A}:usdt`)).statusCode).toBe(201);
    expect((await m.api('POST', '/v1/deposit-accounts', { customer_ref: 'u2', token: `${A}:usdt` })).statusCode).toBe(201);
    expect((await m.api('GET', `/v1/invoices/${before.id}`)).json()).toMatchObject({ id: before.id, status: 'pending', token: `${B}:usdt` });

    // Test mode is never restricted.
    const testKey = await m.mintKey(['read'], false);
    expect(ids(await m.api('GET', '/v1/tokens', undefined, {}, testKey))).toContain('evm-local:usdt');

    // Back to every network.
    expect((await put(null)).json()).toEqual({ network: null });
    expect(ids(await m.api('GET', '/v1/tokens'))).toEqual(expect.arrayContaining([`${A}:usdt`, `${B}:usdt`]));
    expect((await invoice(m, `${B}:usdt`)).statusCode).toBe(201);
  });

  it('the database only accepts a mainnet as a network', async () => {
    const m = await merchantWithKey(app, clock, owner, { livemode: true });
    const setTo = (allowedChainId: string | null) => (tx: Parameters<Parameters<typeof withSystem>[1]>[0]) =>
      tx.update(merchants).set({ allowedChainId }).where(eq(merchants.id, m.merchantId));
    await expect(withTenant(deps.db, m.merchantId, setTo('evm-local'))).rejects.toThrow();
    await expect(withSystem(deps.db, setTo('evm-local'))).rejects.toThrow();
    await withTenant(deps.db, m.merchantId, setTo(A));
    await withTenant(deps.db, m.merchantId, setTo(null));
    const [row] = await withSystem(deps.db, (tx) => tx.select({ n: merchants.allowedChainId }).from(merchants).where(eq(merchants.id, m.merchantId)));
    expect(row?.n).toBeNull();
  });
});
