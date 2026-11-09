// Platform-wide console settings (D-107). These change rules for every test that runs at the same time, so they live
// in the integration-global project: own containers, one file at a time, after the parallel integration files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fundCustodialMerchant } from '../integration/custody-sim.js';
import { Agent, adminAgent, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, ownerPool, signup, totpNow, type merchantWithKey } from '../integration/helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true', WITHDRAWAL_TWO_PERSON_MIN: '100' });
const { app, clock, deps } = t;
const owner = ownerPool();
const B = '/admin/v1';
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;
let sa: Awaited<ReturnType<typeof adminAgent>>;

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await ensureLiveSimRegistry(owner);
  custody = await ensurePlatformCustody(owner);
  sa = await adminAgent(t, owner, 'superadmin');
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const put = (body: Record<string, unknown>) => sa.agent.req('PUT', `${B}/settings`, { reason: 'platform settings test', ...body }, sa.stepUp());

describe('merchant sign-ups and new-merchant defaults', () => {
  it('a superadmin closes sign-ups; new merchants start with the console defaults, existing ones keep theirs', async () => {
    const before = await signup(app);
    expect((await put({ signup_enabled: false })).json()).toMatchObject({ signup_enabled: false, platform: { signup_allowed: true } });
    try {
      const r = await new Agent(app).req('POST', '/v1/dashboard/auth/signup', { merchant_name: 'Closed', email: 'closed@example.test', password: 'correct horse battery' });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { message: 'signup is disabled' } });
    } finally {
      await put({ signup_enabled: true });
    }

    const defaults = { fee_bps: 250, fee_fixed: '0.5', fee_grace: '10', payout_fee: '0.25', underpay_tolerance_bps: 100 };
    expect((await put({ merchant_defaults: { ...defaults, fee_bps: 20_000 } })).statusCode).toBe(400);
    expect((await put({ merchant_defaults: { ...defaults, fee_fixed: '0.1234567' } })).statusCode).toBe(400);
    try {
      expect((await put({ merchant_defaults: defaults })).json()).toMatchObject({ merchant_defaults: defaults });
      const s = await signup(app);
      expect((await sa.agent.req('GET', `${B}/merchants/${s.merchantId}`)).json()).toMatchObject({
        fee_bps: 250,
        fee_fixed: '0.5',
        fee_grace: '10',
        payout_fee: '0.25',
        underpay_tolerance_bps: 100,
      });
      expect((await sa.agent.req('GET', `${B}/merchants/${before.merchantId}`)).json()).toMatchObject({ fee_bps: 100, underpay_tolerance_bps: 50 });
    } finally {
      await put({ merchant_defaults: { fee_bps: 100, fee_fixed: '0', fee_grace: '0', payout_fee: '0', underpay_tolerance_bps: 50 } });
    }
  });
});

describe('admin IP allowlist', () => {
  it('enforced on every admin route when on (404 elsewhere, even login); never locks out the admin switching it on', async () => {
    const outside = { 'x-forwarded-for': '198.51.100.7' };
    expect((await sa.agent.req('GET', `${B}/settings`)).json()).toMatchObject({ ip_allowlist_enabled: false, ip_allowlist: [], request_ip: sa.agent.ip });
    for (const cidr of ['not-an-ip', '10.0.0.0/33', '10.0.0.1/8/1', '::1/129']) {
      expect((await put({ ip_allowlist: [{ cidr, label: 'bad' }] })).statusCode).toBe(400);
    }
    expect((await put({ ip_allowlist_enabled: true })).statusCode).toBe(400); // nothing on the list yet
    const lockout = await put({ ip_allowlist_enabled: true, ip_allowlist: [{ cidr: '192.0.2.1', label: 'elsewhere' }] });
    expect(lockout.statusCode).toBe(409);
    expect(lockout.json()).toMatchObject({ error: { details: { reason: 'self_lockout' } } });

    // Every test agent sits in 10.0.0.0/8; requests without a proxy header come from 127.0.0.1.
    const list = [
      { cidr: '10.0.0.0/8', label: 'Office VPN' },
      { cidr: '127.0.0.1', label: '' },
      { cidr: '10.0.0.0/8', label: 'duplicate' },
    ];
    try {
      const on = await put({ ip_allowlist_enabled: true, ip_allowlist: list });
      expect(on.json()).toMatchObject({ ip_allowlist_enabled: true, ip_allowlist: [{ cidr: '10.0.0.0/8', label: 'Office VPN' }, { cidr: '127.0.0.1', label: '' }] });
      expect((await sa.agent.req('GET', `${B}/auth/me`)).statusCode).toBe(200);
      expect((await sa.agent.req('GET', `${B}/auth/me`, undefined, outside)).statusCode).toBe(404);
      expect((await new Agent(app, 'http://admin.test').req('POST', `${B}/auth/login`, { email: 'x@example.test', password: 'x' }, outside)).statusCode).toBe(404);
      // An empty list while on is refused (the database refuses it too).
      expect((await put({ ip_allowlist: [] })).statusCode).toBe(400);
      const a = await owner.query(`select after from audit_logs where action = 'admin.settings_updated' and actor_id = $1 order by seq desc limit 1`, [sa.id]);
      expect(a.rows[0]?.after).toMatchObject({ ip_allowlist_enabled: true, ip_allowlist: [{ cidr: '10.0.0.0/8' }, { cidr: '127.0.0.1' }] });
    } finally {
      await put({ ip_allowlist_enabled: false });
    }
    expect((await sa.agent.req('GET', `${B}/auth/me`, undefined, outside)).statusCode).toBe(200);
  });
});

describe('two-admin withdrawal threshold', () => {
  type M = Awaited<ReturnType<typeof merchantWithKey>>;
  const code = (m: M) => {
    clock.advance(30_000);
    return { 'x-totp-code': totpNow(m.secret, clock()) };
  };
  const withdraw = async (m: M, amount: string) =>
    (await m.agent.req('POST', '/v1/dashboard/withdrawals/', { livemode: true, token: 'evm-mainsim:usdt', amount }, code(m))).json<{ approvals_required: number }>().approvals_required;

  it('the console lowers it, never above the server ceiling; null goes back to the ceiling; new requests only', async () => {
    const m = await fundCustodialMerchant({ app, clock, deps, owner, custody }, 500n * 10n ** 18n, true);
    await owner.query(
      `insert into payout_addresses (id, merchant_id, livemode, family, address, created_by, activates_at) values (gen_random_uuid(), $1, true, 'evm', $2, $3, now() - interval '1 day')`,
      [m.merchantId, '0x00000000000000000000000000000000000beef1', m.userId],
    );
    expect((await sa.agent.req('GET', `${B}/settings`)).json()).toMatchObject({ withdrawal_two_person_min: null, withdrawal_two_person_effective: '100', platform: { withdrawal_two_person_max: '100' } });
    expect(await withdraw(m, '50')).toBe(1);

    expect((await put({ withdrawal_two_person_min: '150' })).statusCode).toBe(400); // above the ceiling
    expect((await put({ withdrawal_two_person_min: '0' })).statusCode).toBe(400);
    expect((await put({ withdrawal_two_person_min: '12.5' })).statusCode).toBe(400);
    try {
      expect((await put({ withdrawal_two_person_min: '40' })).json()).toMatchObject({ withdrawal_two_person_min: '40', withdrawal_two_person_effective: '40' });
      expect(await withdraw(m, '50')).toBe(2);
      expect(await withdraw(m, '39')).toBe(1);
      expect(await withdraw(m, '40')).toBe(2);
    } finally {
      expect((await put({ withdrawal_two_person_min: null })).json()).toMatchObject({ withdrawal_two_person_min: null, withdrawal_two_person_effective: '100' });
    }
    expect(await withdraw(m, '50')).toBe(1);
    // Requests made under the lower threshold keep what they needed then.
    const kept = await owner.query<{ approvals_required: number }>('select approvals_required from withdrawals where merchant_id = $1 order by created_at', [m.merchantId]);
    expect(kept.rows.map((r) => r.approvals_required)).toEqual([1, 2, 1, 2, 1]);
  });
});
