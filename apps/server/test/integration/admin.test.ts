import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_ORIGIN,
  Agent,
  adminAgent,
  buildTestApp,
  createAdmin as createAdminRow,
  enable2fa,
  ensureLocalRegistry,
  merchantWithKey,
  ownerPool,
  signup,
  totpNow,
  uniqueEmail,
} from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const createAdmin = (role = 'operator') => createAdminRow(owner, deps, role);

const adminLogin = (agent: Agent, body: Record<string, unknown>) =>
  agent.req('POST', '/admin/v1/auth/login', body, { 'x-forwarded-for': `10.88.0.${Math.floor(Math.random() * 250)}` });

describe('admin auth domain', () => {
  it('requires password AND TOTP; issues admin-scoped cookies', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    const agent = new Agent(app, ADMIN_ORIGIN);
    expect((await adminLogin(agent, { email: a.email, password: a.password, code: '000000' })).statusCode).toBe(401);
    expect((await adminLogin(agent, { email: a.email, password: 'wrong wrong wrong', code: totpNow(a.secret, clock()) })).statusCode).toBe(401);
    const ok = await adminLogin(agent, { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find((c) => c.name === 'gw_admin_at')).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/admin' });
    expect((await agent.req('GET', '/admin/v1/auth/me')).json()).toMatchObject({ id: a.id, role: 'operator' });
  });

  it('merchant session cannot reach admin routes; admin token cannot reach dashboard', async () => {
    const { agent } = await signup(app);
    const asAdmin = new Agent(app, ADMIN_ORIGIN);
    asAdmin.cookies.set('gw_admin_at', agent.cookies.get('gw_at') ?? '');
    expect((await asAdmin.req('GET', '/admin/v1/auth/me')).statusCode).toBe(401);

    const a = await createAdmin();
    clock.advance(30_000);
    const ag = new Agent(app, ADMIN_ORIGIN);
    await adminLogin(ag, { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    const cross = new Agent(app);
    cross.cookies.set('gw_at', ag.cookies.get('gw_admin_at') ?? '');
    expect((await cross.req('GET', '/v1/dashboard/auth/me')).statusCode).toBe(401);
  });

  it('login from dashboard origin is refused', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    const r = await adminLogin(new Agent(app), { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    expect(r.statusCode).toBe(403);
  });

  it('disabled admin is cut off immediately, even with a live token', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    const ag = new Agent(app, ADMIN_ORIGIN);
    await adminLogin(ag, { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    expect((await ag.req('GET', '/admin/v1/auth/me')).statusCode).toBe(200);
    await owner.query('update admin_users set disabled_at = now() where id = $1', [a.id]);
    expect((await ag.req('GET', '/admin/v1/auth/me')).statusCode).toBe(401);
  });

  it('admin login is audited', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    await adminLogin(new Agent(app, ADMIN_ORIGIN), { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    const r = await owner.query(`select 1 from audit_logs where actor_id = $1 and action = 'admin.login'`, [a.id]);
    expect(r.rowCount).toBe(1);
  });
});

describe('admin IP allowlist', () => {
  const restricted = buildTestApp({ ADMIN_IP_ALLOWLIST: '192.0.2.0/24', TRUST_PROXY_HOPS: '1' });
  beforeAll(async () => {
    await restricted.app.ready();
  });
  afterAll(async () => {
    await restricted.close();
  });

  it('non-allowlisted IP gets 404 on every admin route', async () => {
    const r = await restricted.app.inject({ method: 'POST', url: '/admin/v1/auth/login', headers: { 'x-forwarded-for': '198.51.100.1' }, payload: {} });
    expect(r.statusCode).toBe(404);
    const ok = await restricted.app.inject({
      method: 'POST',
      url: '/admin/v1/auth/login',
      headers: { 'x-forwarded-for': '192.0.2.10', origin: ADMIN_ORIGIN },
      payload: { email: 'nobody@x.test', password: 'x', code: '000000' },
    });
    expect(ok.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------- M5b: admin console API

describe('admin console', () => {
  const B = '/admin/v1';
  type MerchantView = { id: string; name: string; status: string; risk_flags: string[] };

  it('every console route needs an admin session and the right role', async () => {
    expect((await new Agent(app, ADMIN_ORIGIN).req('GET', `${B}/merchants`)).statusCode).toBe(401);
    const { merchantId } = await signup(app);
    const auditor = await adminAgent(t, owner, 'auditor');
    expect((await auditor.agent.req('GET', `${B}/merchants`)).statusCode).toBe(200);
    expect((await auditor.agent.req('GET', `${B}/audit-logs`)).statusCode).toBe(200);
    expect((await auditor.agent.req('POST', `${B}/merchants/${merchantId}/suspend`, { reason: 'test reason' })).statusCode).toBe(403);
    expect((await auditor.agent.req('POST', `${B}/registry/token/evm-local:usdt/disable`, { reason: 'test reason' })).statusCode).toBe(403);
    const op = await adminAgent(t, owner);
    expect((await op.agent.req('GET', `${B}/audit-logs`)).statusCode).toBe(403);
    expect((await op.agent.req('POST', `${B}/registry/token/evm-local:usdt/enable`, { reason: 'test reason' }, op.stepUp())).statusCode).toBe(403);
    // Admin mutations need a reason.
    expect((await op.agent.req('POST', `${B}/merchants/${merchantId}/suspend`, {})).statusCode).toBe(400);
    expect((await op.agent.req('POST', `${B}/merchants/${merchantId}/suspend`, { reason: ' ' })).statusCode).toBe(400);
  });

  it('merchants: search by name, id or user email; detail lists users and balances', async () => {
    const name = `Zebra ${uniqueEmail('n')}`;
    const s = await signup(app, name);
    const { agent } = await adminAgent(t, owner, 'auditor');
    const ids = async (q: string) => (await agent.req('GET', `${B}/merchants?q=${encodeURIComponent(q)}`)).json<{ data: MerchantView[] }>().data.map((m) => m.id);
    expect(await ids(name.slice(6, 20))).toEqual([s.merchantId]);
    expect(await ids(s.email.toUpperCase())).toEqual([s.merchantId]);
    expect(await ids(s.merchantId)).toEqual([s.merchantId]);
    expect(await ids('%')).not.toContain(s.merchantId); // LIKE wildcards are literal
    const page = (await agent.req('GET', `${B}/merchants?limit=1`)).json<{ data: unknown[]; has_more: boolean; next_cursor: string }>();
    expect(page).toMatchObject({ data: [expect.anything()], has_more: true });
    expect((await agent.req('GET', `${B}/merchants?limit=1&starting_after=${page.next_cursor}`)).json<{ data: MerchantView[] }>().data[0]?.id).not.toBe(page.next_cursor);

    const d = (await agent.req('GET', `${B}/merchants/${s.merchantId}`)).json<{ balances: { livemode: boolean; data: { received: string; prepaid_fees: string; fee_status: string }[] }[] }>();
    expect(d).toMatchObject({ id: s.merchantId, name, status: 'active', risk_flags: [], users: [{ email: s.email, role: 'owner', totp_enabled: false }] });
    // Live balances list every usable live token (other test files may add some), all blocked until a top-up.
    expect(d.balances[0]).toEqual({ livemode: false, data: [] });
    expect(d.balances[1]?.livemode).toBe(true);
    expect(d.balances[1]?.data.every((b) => b.received === '0' && b.prepaid_fees === '0' && b.fee_status === 'blocked')).toBe(true);
    expect((await agent.req('GET', `${B}/merchants/00000000-0000-7000-8000-000000000000`)).statusCode).toBe(404);
  });

  it('suspend kills API keys and new invoices; reactivation needs step-up; admin entries stay out of the merchant audit log', async () => {
    await ensureLocalRegistry(owner);
    const m = await merchantWithKey(app, clock, owner);
    const op = await adminAgent(t, owner);
    const url = `${B}/merchants/${m.merchantId}`;
    expect((await op.agent.req('POST', `${url}/suspend`, { reason: 'chargeback spike' })).json()).toMatchObject({ status: 'suspended' });
    expect((await op.agent.req('POST', `${url}/suspend`, { reason: 'chargeback spike' })).statusCode).toBe(409);
    expect((await m.api('GET', '/v1/balances')).statusCode).toBe(401);
    const inv = await m.agent.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '10', token: 'evm-local:usdt' });
    expect(inv.json()).toMatchObject({ error: { message: 'merchant is suspended' } });

    expect((await op.agent.req('POST', `${url}/reactivate`, { reason: 'cleared' })).statusCode).toBe(403);
    expect((await op.agent.req('POST', `${url}/reactivate`, { reason: 'cleared' }, { 'x-totp-code': '000000' })).statusCode).toBe(403);
    expect((await op.agent.req('POST', `${url}/reactivate`, { reason: 'cleared' }, op.stepUp())).json()).toMatchObject({ status: 'active' });
    expect((await m.api('GET', '/v1/balances')).statusCode).toBe(200);

    const a = await owner.query<{ action: string; actor_id: string; after: { reason: string } }>(
      `select action, actor_id, after from audit_logs where merchant_id = $1 and actor_type = 'admin' order by seq`,
      [m.merchantId],
    );
    expect(a.rows).toEqual([
      { action: 'admin.merchant_suspended', actor_id: op.id, after: { status: 'suspended', reason: 'chargeback spike' } },
      { action: 'admin.merchant_reactivated', actor_id: op.id, after: { status: 'active', reason: 'cleared' } },
    ]);
    const failed = await owner.query(`select 1 from audit_logs where actor_id = $1 and action = 'admin.step_up_failed'`, [op.id]);
    expect(failed.rowCount).toBe(2);
    const mine = (await m.agent.req('GET', '/v1/dashboard/audit-logs/')).json<{ data: { actor_type: string }[] }>().data;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((e) => e.actor_type === 'admin')).toBe(false);
  });

  it('risk flags: set (deduplicated), filter, clear', async () => {
    const s = await signup(app);
    const op = await adminAgent(t, owner);
    const put = (flags: string[]) =>
      app.inject({
        method: 'PUT',
        url: `${B}/merchants/${s.merchantId}/risk-flags`,
        payload: { flags, reason: 'manual review' },
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: [...op.agent.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'x-csrf-token': op.agent.cookies.get('gw_admin_csrf') ?? '',
        },
      });
    expect((await put(['under_review', 'payouts_frozen', 'under_review'])).json()).toMatchObject({ risk_flags: ['payouts_frozen', 'under_review'] });
    const flagged = (await op.agent.req('GET', `${B}/merchants?flag=payouts_frozen&limit=100`)).json<{ data: MerchantView[] }>().data;
    expect(flagged.map((x) => x.id)).toContain(s.merchantId);
    expect((await put(['nope'])).statusCode).toBe(400);
    expect((await put([])).json()).toMatchObject({ risk_flags: [] });
  });

  it('2FA reset: step-up; clears TOTP and recovery codes, revokes sessions; password-only login works after', async () => {
    const s = await signup(app);
    await enable2fa(s.agent, clock);
    const op = await adminAgent(t, owner);
    const url = `${B}/merchants/${s.merchantId}/users/${s.userId}/reset-2fa`;
    const reason = { reason: 'lost phone, identity verified' };
    expect((await op.agent.req('POST', url, reason)).statusCode).toBe(403);
    expect((await op.agent.req('POST', url, reason, op.stepUp())).statusCode).toBe(204);
    expect((await op.agent.req('POST', url, reason, op.stepUp())).statusCode).toBe(409);
    const other = await signup(app);
    expect((await op.agent.req('POST', `${B}/merchants/${other.merchantId}/users/${s.userId}/reset-2fa`, reason, op.stepUp())).statusCode).toBe(404);

    const u = await owner.query('select totp_secret_enc, totp_enabled_at from merchant_users where id = $1', [s.userId]);
    expect(u.rows[0]).toEqual({ totp_secret_enc: null, totp_enabled_at: null });
    expect((await owner.query('select 1 from recovery_codes where user_id = $1', [s.userId])).rowCount).toBe(0);
    expect((await owner.query('select 1 from sessions where user_id = $1 and revoked_at is null', [s.userId])).rowCount).toBe(0);
    expect((await s.agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
    const login = await new Agent(app).req('POST', '/v1/dashboard/auth/login', { email: s.email, password: s.password });
    expect(login.json()).toMatchObject({ mfa_required: false });
  });

  it('kill switch: disabling a token or chain stops new invoices at once; enabling needs superadmin + step-up', async () => {
    // Own chain + token: other test files create invoices on evm-local in parallel.
    await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
        default_confirmations, reorg_depth, finality, testnet, enabled)
      values ('evm-ks', 'evm', 'Kill switch test', 999998, '{}', 'ETH', 18, 1000, 2, 8, 'confirmations', true, true) on conflict do nothing`);
    await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
      values ('evm-ks:usdt', 'evm-ks', 'USDT', 'ks', '0x4444444444444444444444444444444444444444', 6, 2, 10000, true) on conflict do nothing`);
    const m = await merchantWithKey(app, clock, owner);
    const create = async () => (await m.api('POST', '/v1/invoices', { amount: '10', token: 'evm-ks:usdt' })).statusCode;
    expect(await create()).toBe(201);

    const op = await adminAgent(t, owner);
    const sa = await adminAgent(t, owner, 'superadmin');
    const reason = { reason: 'rpc compromised' };
    expect((await op.agent.req('POST', `${B}/registry/token/evm-ks:usdt/disable`, reason)).statusCode).toBe(204);
    expect((await op.agent.req('POST', `${B}/registry/token/evm-ks:usdt/disable`, reason)).statusCode).toBe(409);
    expect(await create()).toBe(400);
    const reg = (await op.agent.req('GET', `${B}/registry`)).json<{ tokens: { id: string; enabled: boolean }[] }>();
    expect(reg.tokens.find((x) => x.id === 'evm-ks:usdt')?.enabled).toBe(false);

    expect((await sa.agent.req('POST', `${B}/registry/token/evm-ks:usdt/enable`, reason)).statusCode).toBe(403);
    expect((await sa.agent.req('POST', `${B}/registry/token/evm-ks:usdt/enable`, reason, sa.stepUp())).statusCode).toBe(204);
    expect(await create()).toBe(201);

    expect((await op.agent.req('POST', `${B}/registry/chain/evm-ks/disable`, reason)).statusCode).toBe(204);
    expect(await create()).toBe(400);
    expect((await sa.agent.req('POST', `${B}/registry/chain/evm-ks/enable`, reason, sa.stepUp())).statusCode).toBe(204);
    expect(await create()).toBe(201);
    expect((await op.agent.req('POST', `${B}/registry/chain/nope-chain/disable`, reason)).statusCode).toBe(404);

    const a = await owner.query<{ action: string }>(`select action from audit_logs where target_id in ('evm-ks', 'evm-ks:usdt') order by seq`);
    expect(a.rows.map((r) => r.action)).toEqual(['admin.token_disabled', 'admin.token_enabled', 'admin.chain_disabled', 'admin.chain_enabled']);
  });

  it('audit log: prefix, actor and merchant filters, cursor, chain verification', async () => {
    const s = await signup(app);
    const op = await adminAgent(t, owner);
    await op.agent.req('POST', `${B}/merchants/${s.merchantId}/suspend`, { reason: 'audit filter test' });
    const { agent } = await adminAgent(t, owner, 'auditor');
    type Row = { seq: string; action: string; merchant_id: string | null; actor_id: string | null; after: unknown };
    const get = async (qs: string) => (await agent.req('GET', `${B}/audit-logs?${qs}`)).json<{ data: Row[]; has_more: boolean; next_cursor: string }>();

    const byMerchant = await get(`merchant_id=${s.merchantId}`);
    expect(byMerchant.data.every((r) => r.merchant_id === s.merchantId)).toBe(true);
    expect(byMerchant.data[0]).toMatchObject({ action: 'admin.merchant_suspended', actor_id: op.id, after: { reason: 'audit filter test' } });
    const prefixed = await get('action=admin.merchant_&limit=1');
    expect(prefixed.data[0]?.action.startsWith('admin.merchant_')).toBe(true);
    const next = await get(`action=admin.&limit=1&starting_after=${prefixed.next_cursor}`);
    expect(BigInt(next.data[0]?.seq ?? '0')).toBeLessThan(BigInt(prefixed.next_cursor));
    expect((await get('action=admin_merchant')).data).toEqual([]); // '_' is literal, not a LIKE wildcard matching '.'
    expect((await get(`actor_id=${op.id}`)).data.every((r) => r.actor_id === op.id)).toBe(true);

    expect((await agent.req('GET', `${B}/audit-logs/verify`)).json()).toEqual({ intact: true, first_bad_seq: null });
  });
});
