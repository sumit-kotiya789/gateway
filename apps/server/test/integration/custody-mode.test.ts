// Custody on / off is the merchant's own choice (D-098): the owner switches it in the dashboard (2FA), only while the
// platform has custody on (FEATURE_CUSTODIAL), never leaving funds stranded in custody, never after the first live
// invoice. Admins do not decide it. Withdrawals exist only while custody is on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fundCustodialMerchant } from './custody-sim.js';
import { adminAgent, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const on = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const off = buildTestApp(); // FEATURE_CUSTODIAL and FEATURE_FORWARDER unset
const owner = ownerPool();
const E18 = 10n ** 18n;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;

beforeAll(async () => {
  await Promise.all([on.app.ready(), off.app.ready()]);
  await ensureLocalRegistry(owner);
  await ensureLiveSimRegistry(owner);
  custody = await ensurePlatformCustody(owner);
});
afterAll(async () => {
  await Promise.all([on.close(), off.close()]);
  await owner.end();
});

type T = typeof on;
type M = Awaited<ReturnType<typeof merchantWithKey>>;
const code = (t: T, m: M) => {
  t.clock.advance(30_000);
  return { 'x-totp-code': totpNow(m.secret, t.clock()) };
};
const setMode = (t: T, m: M, mode: string, headers: Record<string, string> = code(t, m)) =>
  m.agent.req('PUT', '/v1/dashboard/settings/receiving-mode', { mode }, headers);
const modeOf = async (merchantId: string) => (await owner.query<{ m: string }>('select custody_mode::text m from merchants where id = $1', [merchantId])).rows[0]?.m;

describe('custody on / off, chosen by the merchant (D-098)', () => {
  it('the owner turns custody on with 2FA, audited; the dashboard then offers withdrawals; admins cannot switch it', async () => {
    const m = await merchantWithKey(on.app, on.clock, owner);
    expect((await m.agent.req('GET', '/v1/dashboard/settings/')).json()).toMatchObject({ receiving_mode: 'non_custodial_xpub', custodial_available: true });

    expect((await setMode(on, m, 'custodial', {})).statusCode).toBe(403); // no 2FA code
    expect(await modeOf(m.merchantId)).toBe('non_custodial_xpub');
    const r = await setMode(on, m, 'custodial');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ receiving_mode: 'custodial' });
    expect((await setMode(on, m, 'custodial')).json()).toEqual({ receiving_mode: 'custodial' }); // already: no-op
    const logs = await owner.query<{ before: unknown; after: unknown }>("select before, after from audit_logs where action = 'settings.receiving_mode' and merchant_id = $1", [m.merchantId]);
    expect(logs.rows).toEqual([{ before: { mode: 'non_custodial_xpub' }, after: { mode: 'custodial' } }]);
    const me = (await m.agent.req('GET', '/v1/dashboard/auth/me')).json<{ merchant: { custody_mode: string; withdrawals_enabled: boolean } }>();
    expect(me.merchant).toMatchObject({ custody_mode: 'custodial', withdrawals_enabled: true });

    // Not an admin decision: there is no admin route for it.
    const admin = await adminAgent(on, owner);
    expect((await admin.agent.req('PUT', `/admin/v1/merchants/${m.merchantId}/custody-mode`, { mode: 'non_custodial_xpub', reason: 'nope' }, admin.stepUp())).statusCode).toBe(404);

    // And back off again: nothing is held, nothing open.
    expect((await setMode(on, m, 'non_custodial_xpub')).json()).toEqual({ receiving_mode: 'non_custodial_xpub' });
  });

  it('turning custody off is refused while the platform holds or expects funds for the merchant', async () => {
    const funded = await fundCustodialMerchant({ app: on.app, clock: on.clock, deps: on.deps, owner, custody }, 5n * E18);
    const held = await setMode(on, funded, 'non_custodial_xpub');
    expect(held.statusCode).toBe(409);
    expect(held.json().error.details.reason).toBe('funds_in_custody');
    expect(await modeOf(funded.merchantId)).toBe('custodial');

    // No balance, but an open custody invoice could still bring money in.
    const m = await merchantWithKey(on.app, on.clock, owner);
    expect((await setMode(on, m, 'custodial')).statusCode).toBe(200);
    const inv = (await m.api('POST', '/v1/invoices', { amount: '1', token: 'evm-local:usdt' })).json<{ id: string; status: string }>();
    expect(inv.status).toBe('pending');
    const open = await setMode(on, m, 'non_custodial_xpub');
    expect(open.statusCode).toBe(409);
    expect(open.json().error.details.reason).toBe('open_custodial_invoices');
    expect((await m.api('POST', `/v1/invoices/${inv.id}/cancel`)).statusCode).toBe(200);
    expect((await setMode(on, m, 'non_custodial_xpub')).json()).toEqual({ receiving_mode: 'non_custodial_xpub' });
  });

  it('the choice is locked after the first live invoice', async () => {
    const m = await merchantWithKey(on.app, on.clock, owner, { livemode: true });
    expect((await setMode(on, m, 'custodial')).statusCode).toBe(200);
    const inv = (await m.api('POST', '/v1/invoices', { amount: '1', token: 'evm-mainsim:usdt' })).json<{ id: string }>();
    expect((await m.api('POST', `/v1/invoices/${inv.id}/cancel`)).statusCode).toBe(200);
    const r = await setMode(on, m, 'non_custodial_xpub');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.reason).toBe('mode_locked');
    expect(await modeOf(m.merchantId)).toBe('custodial');
  });

  it('custody off on the platform: custody cannot be turned on, and withdrawals can be neither requested nor approved', async () => {
    const m = await merchantWithKey(off.app, off.clock, owner, { scopes: ['read'] });
    expect((await m.agent.req('GET', '/v1/dashboard/settings/')).json()).toMatchObject({ custodial_available: false });
    const refused = await setMode(off, m, 'custodial');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.details.reason).toBe('custody_off');

    // A merchant who turned custody on earlier (the platform has since turned it off): balance kept, withdrawals paused.
    await owner.query("update merchants set custody_mode = 'custodial' where id = $1", [m.merchantId]);
    const me = (await m.agent.req('GET', '/v1/dashboard/auth/me')).json<{ merchant: { withdrawals_enabled: boolean } }>();
    expect(me.merchant.withdrawals_enabled).toBe(false);
    const dash = await m.agent.req('POST', '/v1/dashboard/withdrawals/', { livemode: false, token: 'evm-local:usdt', amount: '1' }, code(off, m));
    expect(dash.statusCode).toBe(403);
    expect(dash.json().error.details.reason).toBe('custody_off');
    const admin = await adminAgent(off, owner);
    const approve = await admin.agent.req('POST', `/admin/v1/withdrawals/${crypto.randomUUID()}/approve`, { reason: 'looks fine' }, admin.stepUp());
    expect(approve.statusCode).toBe(403);
    expect(approve.json().error.details.reason).toBe('custody_off');
  });
});
