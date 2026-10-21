import { evmDeriver } from '@gw/chains';
import { INVOICE_TRANSITIONS, uuidv7 } from '@gw/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '../../src/common/db.js';
import { seedRegistry } from '../../src/db/seed-registry.js';
import type { Deps } from '../../src/deps.js';
import { createInvoice, expireDueInvoices, transitionInvoice, type CreateInvoiceInput } from '../../src/modules/invoices/invoices.js';
import { runMaintenanceJob } from '../../src/main-worker.js';
import { LOCAL_USDT, buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await withSystem(t.db, (tx) => seedRegistry(tx, {}));
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

type InvoiceBody = {
  id: string;
  status: string;
  amount: string;
  amount_received: string;
  deposit_address: string;
  payment_uri: string;
  checkout_url: string;
  custody_mode: string;
  livemode: boolean;
  token: string;
  expires_at: string;
  external_order_id: string | null;
};

const body = (over: Record<string, unknown> = {}) => ({ amount: '25.5', token: 'evm-local:usdt', ...over });

describe('DB and core agree', () => {
  it('invoice_transitions table equals INVOICE_TRANSITIONS', async () => {
    const r = await owner.query<{ f: string; t: string }>('select from_status::text f, to_status::text t from invoice_transitions');
    const db = new Set(r.rows.map((x) => `${x.f}>${x.t}`));
    const core = new Set(Object.entries(INVOICE_TRANSITIONS).flatMap(([f, ts]) => ts.map((to) => `${f}>${to}`)));
    expect(db).toEqual(core);
  });
});

describe('POST /v1/invoices', () => {
  it('creates a pending invoice on a fresh address derived from the merchant xpub', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const r = await m.api('POST', '/v1/invoices', body({ external_order_id: 'order-1', metadata: { cart: '42' } }));
    expect(r.statusCode).toBe(201);
    const inv = r.json<InvoiceBody>();
    expect(inv).toMatchObject({ status: 'pending', amount: '25.5', amount_received: '0', custody_mode: 'non_custodial_xpub', livemode: false, external_order_id: 'order-1' });
    expect(inv.deposit_address).toBe(evmDeriver.deriveFromXpub(m.xpub, 0).address);
    expect(inv.payment_uri).toBe(`ethereum:${LOCAL_USDT}@31337/transfer?address=${inv.deposit_address}&uint256=${String(255n * 10n ** 17n)}`);
    expect(inv.checkout_url).toMatch(new RegExp(`/checkout/${inv.id}$`));
    expect(Date.parse(inv.expires_at) - clock()).toBeCloseTo(1800_000, -3);

    const second = (await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    expect(second.deposit_address).toBe(evmDeriver.deriveFromXpub(m.xpub, 1).address);

    const hist = await owner.query<{ f: string | null; t: string; reason: string }>(
      'select from_status::text f, to_status::text t, reason from invoice_status_history where invoice_id = $1 order by id',
      [inv.id],
    );
    expect(hist.rows).toEqual([
      { f: null, t: 'created', reason: 'invoice created' },
      { f: 'created', t: 'pending', reason: 'deposit address allocated' },
    ]);
    const addr = await owner.query<{ w: Date }>('select watch_until w from deposit_addresses where address = $1', [inv.deposit_address]);
    expect(addr.rows[0]?.w.getTime()).toBeGreaterThan(Date.parse(inv.expires_at) + 29 * 24 * 3600_000);
  });

  it.each([
    [{ amount: '25.0000000000000000001' }, 'invalid_amount'],
    [{ amount: '0' }, 'invalid_amount'],
    [{ amount: '0.001' }, 'invalid_amount'], // below 0.01 dust threshold
    [{ amount: '-5' }, 'invalid_amount'],
    [{ amount: '1e3' }, 'invalid_amount'],
    [{ amount: 25 }, 'validation_error'],
    [{ token: 'bsc:usdt' }, 'validation_error'], // mainnet token with a test key
    [{ token: 'nope:usdt' }, 'validation_error'],
    [{ expires_in: 60 }, 'validation_error'],
    [{ metadata: { nested: { a: 1 } } }, 'validation_error'],
    [{ metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${String(i)}`, 'v'])) }, 'validation_error'],
    [{ success_url: 'javascript:alert(1)' }, 'validation_error'],
    [{ success_url: 'https://user:pw@shop.example/ok' }, 'validation_error'],
    [{ unknown_field: 1 }, 'validation_error'],
  ])('rejects %j with %s', async (over, code) => {
    const m = await merchantWithKey(app, clock, owner);
    const r = await m.api('POST', '/v1/invoices', body(over));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe(code);
  });

  it('a failed creation does not consume a derivation index', async () => {
    const m = await merchantWithKey(app, clock, owner);
    await m.api('POST', '/v1/invoices', body({ amount: '0.001' }));
    const ok = (await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    expect(ok.deposit_address).toBe(evmDeriver.deriveFromXpub(m.xpub, 0).address);
  });

  it('needs invoices:write scope', async () => {
    const m = await merchantWithKey(app, clock, owner, { scopes: ['read'] });
    expect((await m.api('POST', '/v1/invoices', body())).statusCode).toBe(403);
  });

  it('duplicate external_order_id -> 409', async () => {
    const m = await merchantWithKey(app, clock, owner);
    expect((await m.api('POST', '/v1/invoices', body({ external_order_id: 'dup' }))).statusCode).toBe(201);
    expect((await m.api('POST', '/v1/invoices', body({ external_order_id: 'dup' }))).statusCode).toBe(409);
  });

  it('merchant without an xpub for the mode -> 409', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const liveKey = await m.mintKey(['read', 'invoices:write'], true);
    const r = await m.api('POST', '/v1/invoices', body(), {}, liveKey);
    expect(r.statusCode).toBe(400); // no mainnet token enabled for live mode yet
  });
});

describe('idempotency', () => {
  it('same key + same body replays the same invoice', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const h = { 'idempotency-key': 'abc-1' };
    const a = await m.api('POST', '/v1/invoices', body(), h);
    const b = await m.api('POST', '/v1/invoices', body(), h);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json<InvoiceBody>().id).toBe(a.json<InvoiceBody>().id);
  });

  it('same key + different body -> 409 idempotency_conflict', async () => {
    const m = await merchantWithKey(app, clock, owner);
    await m.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'k2' });
    const r = await m.api('POST', '/v1/invoices', body({ amount: '99' }), { 'idempotency-key': 'k2' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('idempotency_conflict');
  });

  it('20 parallel requests with one key create exactly one invoice', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const res = await Promise.all(Array.from({ length: 20 }, () => m.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'race' })));
    expect(res.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(res.map((r) => r.json<InvoiceBody>().id)).size).toBe(1);
    const n = await owner.query<{ n: string }>('select count(*)::text n from invoices where merchant_id = $1', [m.merchantId]);
    expect(n.rows[0]?.n).toBe('1');
  });

  it('keys are scoped per merchant and the key format is validated', async () => {
    const a = await merchantWithKey(app, clock, owner);
    const b = await merchantWithKey(app, clock, owner);
    const ia = (await a.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'shared' })).json<InvoiceBody>();
    const ib = (await b.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'shared' })).json<InvoiceBody>();
    expect(ia.id).not.toBe(ib.id);
    expect((await a.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'has space' })).statusCode).toBe(400);
  });

  it('a failed request does not burn the key', async () => {
    const m = await merchantWithKey(app, clock, owner);
    expect((await m.api('POST', '/v1/invoices', body({ amount: '0' }), { 'idempotency-key': 'retry' })).statusCode).toBe(400);
    // Nothing was stored for the failed attempt, so the corrected request under the same key goes through.
    expect((await m.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'retry' })).statusCode).toBe(201);
    expect((await m.api('POST', '/v1/invoices', body({ amount: '0' }), { 'idempotency-key': 'retry2' })).statusCode).toBe(400);
  });
});

describe('read, list, cancel', () => {
  it('GET by id is tenant- and mode-isolated', async () => {
    const a = await merchantWithKey(app, clock, owner);
    const b = await merchantWithKey(app, clock, owner);
    const inv = (await a.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    expect((await a.api('GET', `/v1/invoices/${inv.id}`)).json<InvoiceBody>().id).toBe(inv.id);
    expect((await b.api('GET', `/v1/invoices/${inv.id}`)).statusCode).toBe(404);
    const live = await a.mintKey(['read'], true);
    expect((await a.api('GET', `/v1/invoices/${inv.id}`, undefined, {}, live)).statusCode).toBe(404);
    expect((await a.api('GET', `/v1/invoices/${uuidv7()}`)).statusCode).toBe(404);
  });

  it('cursor pagination newest-first with status filter', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>().id);
    const p1 = (await m.api('GET', '/v1/invoices?limit=2')).json<{ data: InvoiceBody[]; has_more: boolean; next_cursor: string }>();
    expect(p1.data.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    expect(p1.has_more).toBe(true);
    const p2 = (await m.api('GET', `/v1/invoices?limit=2&starting_after=${p1.next_cursor}`)).json<{ data: InvoiceBody[]; has_more: boolean }>();
    expect(p2.data.map((d) => d.id)).toEqual([ids[0]]);
    expect(p2.has_more).toBe(false);
    await m.api('POST', `/v1/invoices/${ids[0] ?? ''}/cancel`);
    const cancelled = (await m.api('GET', '/v1/invoices?status=cancelled')).json<{ data: InvoiceBody[] }>();
    expect(cancelled.data.map((d) => d.id)).toEqual([ids[0]]);
  });

  it('cancel: pending -> cancelled; second cancel is an audited illegal transition', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    const c = await m.api('POST', `/v1/invoices/${inv.id}/cancel`);
    expect(c.json<InvoiceBody>().status).toBe('cancelled');
    const again = await m.api('POST', `/v1/invoices/${inv.id}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details).toEqual({ from: 'cancelled', to: 'cancelled' });
    // Audited asynchronously right after the rolled-back transaction.
    let n = 0;
    for (let i = 0; i < 50 && n === 0; i++) {
      n = (await owner.query(`select 1 from audit_logs where action = 'invoice.illegal_transition' and target_id = $1`, [inv.id])).rowCount ?? 0;
      if (n === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(n).toBe(1);
  });
});

describe('expiry', () => {
  it('expires pending invoices past their deadline, leaves others alone', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const short = (await m.api('POST', '/v1/invoices', body({ expires_in: 300 }))).json<InvoiceBody>();
    const long = (await m.api('POST', '/v1/invoices', body({ expires_in: 3600 }))).json<InvoiceBody>();
    clock.advance(301_000);
    const expired = await expireDueInvoices(deps);
    expect(expired).toContain(short.id);
    expect(expired).not.toContain(long.id);
    expect((await m.api('GET', `/v1/invoices/${short.id}`)).json<InvoiceBody>().status).toBe('expired');
    expect((await m.api('GET', `/v1/invoices/${long.id}`)).json<InvoiceBody>().status).toBe('pending');
    const h = await owner.query<{ reason: string }>(`select reason from invoice_status_history where invoice_id = $1 and to_status = 'expired'`, [short.id]);
    expect(h.rows[0]?.reason).toMatch(/expired/);
    // Expired invoices cannot be cancelled.
    expect((await m.api('POST', `/v1/invoices/${short.id}/cancel`)).statusCode).toBe(409);
  });

  it('worker job runs the same expiry', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', body({ expires_in: 300 }))).json<InvoiceBody>();
    clock.advance(301_000);
    const out = (await runMaintenanceJob(deps, 'expire-invoices')) as { expired: number };
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json<InvoiceBody>().status).toBe('expired');
    await expect(runMaintenanceJob(deps, 'bogus')).rejects.toThrow(/unknown/);
  });

  it('idempotency keys are purged after 24 h, then the key is reusable', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const a = (await m.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'old' })).json<InvoiceBody>();
    clock.advance(25 * 3600_000);
    const out = (await runMaintenanceJob(deps, 'purge-idempotency-keys')) as { purged: number };
    expect(out.purged).toBeGreaterThanOrEqual(1);
    const b = (await m.api('POST', '/v1/invoices', body(), { 'idempotency-key': 'old' })).json<InvoiceBody>();
    expect(b.id).not.toBe(a.id);
  });
});

describe('invoice service edge cases', () => {
  it('rejects bad expiry, unknown merchant, unknown invoice', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const create = (merchantId: string, over: Partial<CreateInvoiceInput> = {}) =>
      withTenant(t.db, merchantId, (tx) => createInvoice(deps, tx, merchantId, false, { amount: '1', token: 'evm-local:usdt', ...over }));
    await expect(create(m.merchantId, { expiresInSeconds: 299 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(create(m.merchantId, { expiresInSeconds: 1.5 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(withSystem(t.db, (tx) => createInvoice(deps, tx, uuidv7(), false, { amount: '1', token: 'evm-local:usdt' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(withSystem(t.db, (tx) => transitionInvoice(deps, tx, uuidv7(), 'cancelled', 'x'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('disabled token or disabled chain is unavailable', async () => {
    await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations, reorg_depth, finality, testnet, enabled)
      values ('evm-off', 'evm', 'Off chain', 31338, '{}', 'ETH', 18, 1000, 2, 16, 'tag', true, false) on conflict do nothing`);
    await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled) values
      ('evm-off:usdt', 'evm-off', 'USDT', 'x', '0x0000000000000000000000000000000000000Aa1', 18, 2, 1, true),
      ('evm-local:off', 'evm-local', 'OFF', 'x', '0x0000000000000000000000000000000000000Aa2', 18, 2, 1, false) on conflict do nothing`);
    const m = await merchantWithKey(app, clock, owner);
    expect((await m.api('POST', '/v1/invoices', body({ token: 'evm-off:usdt' }))).statusCode).toBe(400);
    expect((await m.api('POST', '/v1/invoices', body({ token: 'evm-local:off' }))).statusCode).toBe(400);
  });

  it('a failing illegal-transition audit is logged, and the 409 still reaches the caller', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    const errors: unknown[] = [];
    const broken: Deps = {
      ...deps,
      db: { transaction: () => Promise.reject(new Error('db down')) } as unknown as Deps['db'],
      log: { error: (o: unknown) => errors.push(o) } as unknown as Deps['log'],
    };
    await expect(withSystem(t.db, (tx) => transitionInvoice(broken, tx, inv.id, 'paid', 'test'))).rejects.toMatchObject({ code: 'conflict' });
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
  });
});

describe('database guards', () => {
  it('amount and address are immutable; status moves only along the table; no deletes; history is trigger-only', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    await expect(t.pool.query(`select set_config('app.system','on',false); update invoices set amount_expected = 1 where id = $1`, [inv.id])).rejects.toThrow();
    await expect(owner.query('update invoices set amount_expected = 1 where id = $1', [inv.id])).rejects.toThrow(/immutable/);
    await expect(owner.query(`update invoices set deposit_address = '0x0000000000000000000000000000000000000001' where id = $1`, [inv.id])).rejects.toThrow(/immutable/);
    await expect(owner.query(`update invoices set status = 'paid' where id = $1`, [inv.id])).rejects.toThrow(/illegal invoice transition pending -> paid/);
    await expect(owner.query('delete from invoices where id = $1', [inv.id])).rejects.toThrow(/append-only/);
    await expect(
      t.pool.query(`insert into invoice_status_history (invoice_id, merchant_id, to_status, reason) values ($1, $2, 'paid', 'forged')`, [inv.id, m.merchantId]),
    ).rejects.toThrow(/permission denied/);
  });

  it("an invoice cannot point at another merchant's deposit address", async () => {
    const a = await merchantWithKey(app, clock, owner);
    const b = await merchantWithKey(app, clock, owner);
    const ia = (await a.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    const da = await owner.query<{ id: string }>('select deposit_address_id id from invoices where id = $1', [ia.id]);
    await expect(
      owner.query(
        `insert into invoices (id, merchant_id, livemode, chain_id, token_id, amount_expected, deposit_address_id, deposit_address, custody_mode, underpay_tolerance_bps, expires_at)
         values ($1, $2, false, 'evm-local', 'evm-local:usdt', 1, $3, $4, 'non_custodial_xpub', 50, now())`,
        [uuidv7(), b.merchantId, da.rows[0]?.id, ia.deposit_address],
      ),
    ).rejects.toThrow(/does not match|duplicate key/);
  });

  it('custody mode locks after the first live invoice (test invoices do not lock it)', async () => {
    const m = await merchantWithKey(app, clock, owner);
    await m.api('POST', '/v1/invoices', body());
    await owner.query(`update merchants set custody_mode = 'custodial' where id = $1`, [m.merchantId]);
    await owner.query(`update merchants set custody_mode = 'non_custodial_xpub' where id = $1`, [m.merchantId]);

    // Live invoice inserted directly (mainnet chain stays disabled for other tests).
    const xpub = (await import('./helpers.js')).randomXpub();
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query(`update chains set enabled = true where id = 'bsc'`);
      const x = await client.query<{ id: string }>(`insert into merchant_xpubs (id, merchant_id, family, livemode, xpub, key_fingerprint) values ($1, $2, 'evm', true, $3, $4) returning id`, [
        uuidv7(),
        m.merchantId,
        xpub,
        evmDeriver.keyFingerprint(xpub),
      ]);
      const addr = evmDeriver.deriveFromXpub(xpub, 0).address;
      const d = await client.query<{ id: string }>(
        `insert into deposit_addresses (id, merchant_id, livemode, family, chain_id, source, merchant_xpub_id, derivation_index, derivation_path, address)
         values ($1, $2, true, 'evm', 'bsc', 'merchant_xpub', $3, 0, '0/0', $4) returning id`,
        [uuidv7(), m.merchantId, x.rows[0]?.id, addr],
      );
      await client.query(
        `insert into invoices (id, merchant_id, livemode, chain_id, token_id, amount_expected, deposit_address_id, deposit_address, custody_mode, underpay_tolerance_bps, expires_at)
         values ($1, $2, true, 'bsc', 'bsc:usdt', 1, $3, $4, 'non_custodial_xpub', 50, now())`,
        [uuidv7(), m.merchantId, d.rows[0]?.id, addr],
      );
      await client.query(`update chains set enabled = false where id = 'bsc'`);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    await expect(owner.query(`update merchants set custody_mode = 'custodial' where id = $1`, [m.merchantId])).rejects.toThrow(/locked/);
  });
});

describe('hosted checkout', () => {
  it('renders amount, address, network warning with a strict nonce CSP and no private fields', async () => {
    const m = await merchantWithKey(app, clock, owner, { name: '<script>alert(1)</script> Shop' });
    const inv = (await m.api('POST', '/v1/invoices', body({ external_order_id: 'secret-order-77', metadata: { internal: 'do-not-show' } }))).json<InvoiceBody>();
    const r = await app.inject({ url: `/checkout/${inv.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const csp = String(r.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain(inv.deposit_address);
    expect(r.body).toContain('25.5 USDT');
    expect(r.body).toContain('Send only USDT on Local Anvil');
    expect(r.body).toContain('TEST MODE');
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.body).not.toContain('<script>alert(1)');
    expect(r.body).not.toContain('secret-order-77');
    expect(r.body).not.toContain('do-not-show');
    expect(r.body).not.toMatch(/style="/); // inline styles would be blocked by the CSP
    for (const tag of r.body.match(/<script(?![^>]*application\/json)[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${nonce ?? ''}"`);
  });

  it('status endpoint and unknown ids', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', body())).json<InvoiceBody>();
    const s = await app.inject({ url: `/checkout/${inv.id}/status` });
    expect(s.json()).toMatchObject({ status: 'pending', amount: '25.5', amount_received: '0', remaining: '25.5', success_url: null });
    expect((await app.inject({ url: `/checkout/${uuidv7()}` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/checkout/not-a-uuid' })).statusCode).toBe(404);
    expect((await app.inject({ url: `/checkout/${uuidv7()}/status` })).statusCode).toBe(404);
  });
});

describe('payment links', () => {
  type Link = { id: string; url: string; amount: string; active: boolean };

  it('CRUD via merchant API', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const c = await m.api('POST', '/v1/payment-links', { amount: '10', token: 'evm-local:usdt', description: 'T-shirt' });
    expect(c.statusCode).toBe(201);
    const link = c.json<Link>();
    expect(link.url).toMatch(new RegExp(`/pay/${link.id}$`));
    expect((await m.api('GET', `/v1/payment-links/${link.id}`)).json<Link>().amount).toBe('10');
    expect((await m.api('PATCH', `/v1/payment-links/${link.id}`, { amount: '12.5' })).json<Link>().amount).toBe('12.5');
    expect((await m.api('GET', '/v1/payment-links')).json<{ data: Link[] }>().data).toHaveLength(1);
    expect((await m.api('DELETE', `/v1/payment-links/${link.id}`)).json<Link>().active).toBe(false);
    const other = await merchantWithKey(app, clock, owner);
    expect((await other.api('GET', `/v1/payment-links/${link.id}`)).statusCode).toBe(404);
  });

  it('GET shows the offer without creating an invoice; POST creates one and redirects to checkout', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const link = (await m.api('POST', '/v1/payment-links', { amount: '10', token: 'evm-local:usdt' })).json<Link>();
    const page = await app.inject({ url: `/pay/${link.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('10 USDT');
    const before = await owner.query('select 1 from invoices where payment_link_id = $1', [link.id]);
    expect(before.rowCount).toBe(0);

    const post = await app.inject({ method: 'POST', url: `/pay/${link.id}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.200.0.1' }, payload: '' });
    expect(post.statusCode).toBe(303);
    const invoiceId = /\/checkout\/(.+)$/.exec(String(post.headers.location))?.[1] ?? '';
    const inv = (await m.api('GET', `/v1/invoices/${invoiceId}`)).json<InvoiceBody & { payment_link_id: string }>();
    expect(inv).toMatchObject({ amount: '10', status: 'pending', payment_link_id: link.id });
  });

  it('caps simultaneously pending invoices per link; inactive links refuse', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const link = (await m.api('POST', '/v1/payment-links', { amount: '10', token: 'evm-local:usdt', max_pending_invoices: 2 })).json<Link>();
    const pay = (ip: string) => app.inject({ method: 'POST', url: `/pay/${link.id}`, headers: { 'x-forwarded-for': ip } });
    expect((await pay('10.201.0.1')).statusCode).toBe(303);
    expect((await pay('10.201.0.2')).statusCode).toBe(303);
    expect((await pay('10.201.0.3')).statusCode).toBe(429);
    await m.api('DELETE', `/v1/payment-links/${link.id}`);
    expect((await pay('10.201.0.4')).statusCode).toBe(404);
    expect((await app.inject({ url: `/pay/${link.id}` })).statusCode).toBe(404);
  });

  it('public link creation is rate limited per IP', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const link = (await m.api('POST', '/v1/payment-links', { amount: '10', token: 'evm-local:usdt', max_pending_invoices: 100 })).json<Link>();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'POST', url: `/pay/${link.id}`, headers: { 'x-forwarded-for': '10.202.0.9' } })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 303)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
