import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fundCustodialMerchant } from './custody-sim.js';
import { LOCAL_USDT, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const CHAIN = 'evm-wl';
const X = '0x00000000000000000000000000000000000CaFE1';
const Y = '0x00000000000000000000000000000000000CAfE2';
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await ensureLiveSimRegistry(owner);
  await owner.query(
    `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations, reorg_depth, finality, testnet, enabled)
     values ($1, 'evm', 'Whitelist test chain', 31351, $2, 'ETH', 18, 1000, 2, 16, 'tag', true, true) on conflict do nothing`,
    [CHAIN, ['http://127.0.0.1:1']],
  );
  await owner.query(
    `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
     values ($1, $2, 'USDT', 'Whitelist USDT', $3, 18, 2, 10000000000000000, true) on conflict do nothing`,
    [`${CHAIN}:usdt`, CHAIN, LOCAL_USDT],
  );
  custody = await ensurePlatformCustody(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const W = '/v1/dashboard/security/whitelist';
const code = (m: { secret: string }) => {
  clock.advance(30_000);
  return { 'x-totp-code': totpNow(m.secret, clock()) };
};
/** The API usage row is written after the response: poll briefly. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await fn();
  for (let i = 0; i < 40 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await fn();
  }
  return v;
}

describe('payout address whitelist (D-109)', () => {
  it('while on, payouts go only to active whitelisted addresses; on at once, off scheduled; CSV-style batches report bad lines', async () => {
    const m = await fundCustodialMerchant({ app, clock, deps, owner, custody }, 50n * E18, false, CHAIN);
    const key = await m.mintKey(['read', 'payouts:write']);
    const pay = (to: string) => m.api('POST', '/v1/payouts', { customer_ref: 'user-1', to_address: to, token: `${CHAIN}:usdt`, amount: '1' }, {}, key);
    expect((await m.agent.req('GET', `${W}/?livemode=false`)).json()).toMatchObject({ addresses: { enabled: false, disable_at: null, active: 0 }, ips: { enabled: false, entries: [] }, activation_hours: 24, disable_hours: 48 });
    expect((await pay(X)).statusCode).toBe(201); // off: any address

    expect((await m.agent.req('PUT', `${W}/addresses`, { livemode: false, enabled: true })).statusCode).toBe(403); // 2FA
    expect((await m.agent.req('PUT', `${W}/addresses`, { livemode: false, enabled: true }, code(m))).json()).toEqual({ enabled: true, disable_at: null });
    const refused = await pay(X);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { details: { reason: 'address_not_whitelisted' } } });

    const add = await m.agent.req(
      'POST',
      `${W}/addresses`,
      { livemode: false, entries: [{ address: X, label: 'Treasury' }, { address: X.toLowerCase(), label: 'dup' }, { address: '0x00000000000000000000000000000000000CAfE1x', label: '' }, { address: '0x00000000000000000000000000000000000cafE2', label: 'typo' }] },
      code(m),
    );
    expect(add.statusCode).toBe(201);
    const body = add.json<{ added: { address: string; label: string; status: string }[]; skipped: number; invalid: { reason: string }[] }>();
    expect(body.added).toMatchObject([{ address: X, label: 'Treasury', status: 'active' }]); // test mode: at once
    expect(body.invalid.map((i) => i.reason)).toEqual(['not an EVM address', 'checksum does not match: check for a typo']);
    expect((await m.agent.req('POST', `${W}/addresses`, { livemode: false, entries: [{ address: X }] }, code(m))).json()).toMatchObject({ added: [], skipped: 1 });
    expect((await pay(X)).statusCode).toBe(201);
    expect((await pay(Y)).statusCode).toBe(403);
    expect((await m.agent.req('GET', `${W}/addresses?livemode=false&q=treas`)).json()).toMatchObject({ data: [{ address: X }] });

    // The database refuses it too (a copy of the accepted payout, to a non-whitelisted address).
    const [last] = (await owner.query<{ id: string }>("select id from withdrawals where merchant_id = $1 and kind = 'customer' order by created_at desc limit 1", [m.merchantId])).rows;
    await expect(
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, status, approvals_required, requested_by, next_attempt_at)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, $2, fee, status, approvals_required, requested_by, now() from withdrawals where id = $1`,
        [last?.id, Y],
      ),
    ).rejects.toThrow(/only to active whitelisted addresses/);

    // Off is scheduled (owners emailed) and the whitelist stays on until then; on again cancels.
    const off = (await m.agent.req('PUT', `${W}/addresses`, { livemode: false, enabled: false }, code(m))).json<{ enabled: boolean; disable_at: string }>();
    expect(off.enabled).toBe(true);
    expect(Date.parse(off.disable_at) - clock()).toBeGreaterThan(47 * 3_600_000);
    expect((await pay(Y)).statusCode).toBe(403);
    expect((await owner.query("select 1 from email_outbox where merchant_id = $1 and kind = 'whitelist_disable_scheduled'", [m.merchantId])).rowCount).toBe(1);
    await expect(owner.query('update merchant_security_settings set addresses_test = false where merchant_id = $1', [m.merchantId])).rejects.toThrow(/scheduled time/);
    expect((await m.agent.req('PUT', `${W}/addresses`, { livemode: false, enabled: true }, code(m))).json()).toEqual({ enabled: true, disable_at: null });
    // Once the scheduled time has passed it reads as off everywhere.
    await m.agent.req('PUT', `${W}/addresses`, { livemode: false, enabled: false }, code(m));
    await owner.query("update merchant_security_settings set addresses_test_disable_at = now() - interval '1 minute' where merchant_id = $1", [m.merchantId]);
    expect((await pay(Y)).statusCode).toBe(201);
    expect((await m.agent.req('GET', `${W}/?livemode=false`)).json()).toMatchObject({ addresses: { enabled: false, disable_at: null } });
    // The next change applies the due switch-off first; switching on again then works as usual.
    expect((await m.agent.req('PUT', `${W}/addresses`, { livemode: false, enabled: true }, code(m))).json()).toEqual({ enabled: true, disable_at: null });
    // An address that is not active yet is refused with its own reason.
    await owner.query(
      "insert into whitelisted_addresses (id, merchant_id, livemode, family, address, label, activates_at) values (gen_random_uuid(), $1, false, 'evm', $2, 'later', now() + interval '1 hour')",
      [m.merchantId, Y],
    );
    expect((await pay(Y)).json()).toMatchObject({ error: { details: { reason: 'address_pending' } } });
    // Live mode has its own switch, scheduled and applied the same way.
    await m.agent.req('PUT', `${W}/addresses`, { livemode: true, enabled: true }, code(m));
    await m.agent.req('PUT', `${W}/addresses`, { livemode: true, enabled: false }, code(m));
    await owner.query("update merchant_security_settings set addresses_live_disable_at = now() - interval '1 minute' where merchant_id = $1", [m.merchantId]);
    expect((await m.agent.req('GET', `${W}/?livemode=true`)).json()).toMatchObject({ addresses: { enabled: false } });
    expect((await m.agent.req('PUT', `${W}/addresses`, { livemode: true, enabled: false }, code(m))).json()).toEqual({ enabled: false, disable_at: null });

    // Removing tightens at once (no code needed); live addresses wait the activation time.
    const x = (await m.agent.req('GET', `${W}/addresses?livemode=false`)).json<{ data: { id: string; address: string }[] }>().data.find((a) => a.address === X);
    expect((await m.agent.req('POST', `${W}/addresses/${x?.id ?? ''}/remove`)).statusCode).toBe(204);
    expect((await m.agent.req('GET', `${W}/addresses?livemode=false`)).json<{ data: { address: string; status: string }[] }>().data.map((a) => [a.address, a.status])).toEqual([[Y, 'pending']]);
    const live = (await m.agent.req('POST', `${W}/addresses`, { livemode: true, entries: [{ address: Y }] }, code(m))).json<{ added: { status: string; activates_at: string }[] }>();
    expect(live.added[0]?.status).toBe('pending');
    expect(Date.parse(live.added[0]?.activates_at ?? '') - clock()).toBeGreaterThan(23 * 3_600_000);
    const audit = await owner.query<{ action: string }>("select action from audit_logs where merchant_id = $1 and action like 'whitelist.%' order by seq", [m.merchantId]);
    expect(audit.rows.map((r) => r.action)).toEqual([
      'whitelist.addresses', 'whitelist.address_added', 'whitelist.addresses', 'whitelist.addresses', 'whitelist.addresses', 'whitelist.addresses',
      'whitelist.addresses', 'whitelist.addresses', 'whitelist.address_removed', 'whitelist.address_added',
    ]);
  });
});

describe('API IP whitelist (D-109) and key analytics (D-110)', () => {
  it('secret keys work only from listed IPs while on; every request lands in the key analytics and fingerprint', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    expect((await m.agent.req('PUT', `${W}/ips`, { enabled: true }, code(m))).statusCode).toBe(400); // no entries
    expect((await m.agent.req('PUT', `${W}/ips`, { entries: [{ cidr: '10.0.0.0/33' }] }, code(m))).statusCode).toBe(400);
    const on = await m.agent.req('PUT', `${W}/ips`, { enabled: true, entries: [{ cidr: '192.0.2.0/24', label: 'Office' }] }, code(m));
    expect(on.json()).toMatchObject({ enabled: true, entries: [{ cidr: '192.0.2.0/24', label: 'Office' }] });

    const blocked = await m.api('GET', '/v1/account', undefined, { ...from('198.51.100.9'), 'user-agent': 'curl/8.4.0' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { details: { reason: 'ip_not_whitelisted' } } });
    for (let i = 0; i < 3; i++) expect((await m.api('GET', '/v1/account', undefined, { ...from('192.0.2.7'), 'user-agent': 'node-fetch/3' })).statusCode).toBe(200);
    expect((await m.api('GET', '/v1/invoices/00000000-0000-7000-8000-000000000000', undefined, { ...from('192.0.2.7'), 'user-agent': 'node-fetch/3' })).statusCode).toBe(404);

    const keys = (await m.agent.req('GET', '/v1/dashboard/api-keys/')).json<{ data: { id: string }[] }>().data;
    const id = keys[0]?.id ?? '';
    type A = { totals: { requests: number; errors: number; blocked: number; clients: number }; series: { ok: number }[]; routes: { route: string; requests: number }[]; clients: { ip: string; user_agent: string; requests: number; blocked: number; new: boolean; in_ip_whitelist: boolean | null }[]; statuses: Record<string, number> };
    const a = await eventually(
      async () => (await m.agent.req('GET', `/v1/dashboard/api-keys/${id}/analytics?days=1`)).json<A>(),
      (v) => v.totals.requests >= 4 && v.totals.blocked >= 1,
    );
    expect(a.series).toHaveLength(24);
    expect(a.totals).toMatchObject({ requests: 4, errors: 1, blocked: 1, clients: 2 });
    expect(a.statuses).toMatchObject({ '2xx': 3, '4xx': 1, blocked: 1 });
    expect(a.routes[0]).toMatchObject({ route: 'GET /v1/account', requests: 3 });
    expect(a.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ip: '192.0.2.7', user_agent: 'node-fetch/3', requests: 4, blocked: 0, new: true, in_ip_whitelist: true }),
        expect.objectContaining({ ip: '198.51.100.9', user_agent: 'curl/8.4.0', requests: 1, blocked: 1, in_ip_whitelist: false }),
      ]),
    );
    const usage = (await m.agent.req('GET', '/v1/dashboard/api-keys/usage?livemode=false&days=7')).json<{ data: { key_id: string; requests: number; clients: number; spark: number[] }[] }>();
    expect(usage.data.find((u) => u.key_id === id)).toMatchObject({ requests: 4, clients: 2 });

    // Off is scheduled: still enforced until then.
    expect((await m.agent.req('PUT', `${W}/ips`, { enabled: false }, code(m))).json()).toMatchObject({ enabled: true, disable_at: expect.any(String) });
    expect((await m.api('GET', '/v1/account', undefined, from('198.51.100.9'))).statusCode).toBe(403);
    // Once the time has passed it is off for the API too, and the next edit applies the switch-off.
    await owner.query("update merchant_security_settings set ips_disable_at = now() - interval '1 minute' where merchant_id = $1", [m.merchantId]);
    expect((await m.api('GET', '/v1/account', undefined, from('198.51.100.9'))).statusCode).toBe(200);
    expect((await m.agent.req('PUT', `${W}/ips`, { entries: [] }, code(m))).json()).toEqual({ enabled: false, disable_at: null, entries: [] });
    // Another merchant cannot read this key's analytics.
    const other = await merchantWithKey(app, clock, owner);
    expect((await other.agent.req('GET', `/v1/dashboard/api-keys/${id}/analytics`)).statusCode).toBe(404);
  });
});

describe('dashboard overview (D-110)', () => {
  it('one call: series, period totals with the previous period, funnel, recent invoices, API traffic, security posture', async () => {
    const m = await merchantWithKey(app, clock, owner);
    await m.api('POST', '/v1/invoices', { amount: '12.5', token: 'evm-local:usdt' });
    await m.api('POST', '/v1/invoices', { amount: '3', token: 'evm-local:usdt' });
    type O = { series: { created: number }[]; current: { created: number; paid: number; conversion: number }; previous: { created: number }; funnel: { created: number }; recent: { amount: string; symbol: string; status: string }[]; open: number; api: { requests: number }[]; security: Record<string, unknown> };
    const o = await eventually(
      async () => (await m.agent.req('GET', '/v1/dashboard/overview?livemode=false&days=7')).json<O>(),
      (v) => v.api.reduce((s, d) => s + d.requests, 0) >= 2,
    );
    expect(o.series).toHaveLength(7);
    expect(o.series.reduce((s, d) => s + d.created, 0)).toBe(2);
    expect(o.current).toMatchObject({ created: 2, paid: 0, conversion: 0 });
    expect(o.previous.created).toBe(0);
    expect(o.funnel.created).toBe(2);
    expect(o.open).toBe(2);
    expect(o.recent.map((r) => [r.amount, r.symbol, r.status])).toEqual([['3', 'USDT', 'pending'], ['12.5', 'USDT', 'pending']]);
    expect(o.security).toMatchObject({ totp: true, address_whitelist: false, ip_whitelist: false, api_keys: 1, team_members: 1, team_with_2fa: 1 });
    expect((await m.agent.req('GET', '/v1/dashboard/overview?livemode=false&days=5')).statusCode).toBe(400);
  });
});
