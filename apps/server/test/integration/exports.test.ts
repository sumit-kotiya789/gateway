import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool, uniqueEmail } from './helpers.js';
import { hashPassword } from '../../src/common/crypto/password.js';
import { uuidv7 } from '@gw/core';

const t = buildTestApp();
const { app, clock } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** Minimal RFC 4180 parser for the assertions (quoted cells, doubled quotes, CRLF rows). */
function parse(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i] as string;
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

async function teammate(merchantId: string, role: 'developer' | 'read_only') {
  const email = uniqueEmail(role);
  await owner.query('insert into merchant_users (id, merchant_id, email, password_hash, role) values ($1, $2, $3, $4, $5)', [uuidv7(), merchantId, email, await hashPassword('teammate password 1'), role]);
  const agent = new Agent(app);
  await agent.req('POST', '/v1/dashboard/auth/login', { email, password: 'teammate password 1' });
  return agent;
}

describe('CSV exports', () => {
  it('invoices: one row per invoice of the mode and range, formula cells neutralised, audited', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const a = await m.api('POST', '/v1/invoices', { amount: '12.5', token: 'evm-local:usdt', external_order_id: 'A,1 "x"', description: '=HYPERLINK("http://evil")' });
    const b = await m.api('POST', '/v1/invoices', { amount: '3', token: 'evm-local:usdt' });
    const r = await m.agent.req('GET', '/v1/dashboard/exports/invoices.csv?livemode=false');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="invoices-test-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    const rows = parse(r.body);
    expect(rows[0]?.slice(0, 3)).toEqual(['id', 'created_at', 'status']);
    const byId = new Map(rows.slice(1).map((x) => [x[0], x]));
    expect([...byId.keys()].sort()).toEqual([a.json<{ id: string }>().id, b.json<{ id: string }>().id].sort());
    const row = byId.get(a.json<{ id: string }>().id) ?? [];
    const col = (name: string) => row[(rows[0] ?? []).indexOf(name)];
    expect([col('status'), col('amount'), col('external_order_id'), col('description')]).toEqual(['pending', '12.5', 'A,1 "x"', `'=HYPERLINK("http://evil")`]);
    expect(parse((await m.agent.req('GET', '/v1/dashboard/exports/invoices.csv?livemode=true')).body)).toHaveLength(1); // header only
    const audit = await owner.query("select after from audit_logs where merchant_id = $1 and action = 'export.downloaded' order by seq limit 1", [m.merchantId]);
    expect(audit.rows[0]?.after).toMatchObject({ kind: 'invoices', livemode: false, rows: 2 });
  });

  it('payments export lists on-chain payments', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', { amount: '5', token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
    await owner.query(
      `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
       values (gen_random_uuid(), $1, false, $2, 'evm-local', 'evm-local:usdt', '0xabc', 0, '0x0000000000000000000000000000000000000001', $3, 5000000000000000000, 7, '0x01', now(), 2)`,
      [m.merchantId, inv.id, inv.deposit_address],
    );
    const rows = parse((await m.agent.req('GET', '/v1/dashboard/exports/payments.csv')).body);
    expect(rows).toHaveLength(2);
    const h = rows[0] ?? [];
    const p = rows[1] ?? [];
    expect([p[h.indexOf('invoice_id')], p[h.indexOf('amount')], p[h.indexOf('tx_hash')], p[h.indexOf('status')]]).toEqual([inv.id, '5', '0xabc', 'detected']);
  });

  it('range rules and permissions', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const q = (s: string) => m.agent.req('GET', `/v1/dashboard/exports/invoices.csv?${s}`);
    expect((await q('from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await q('from=2025-01-01&to=2026-01-02')).statusCode).toBe(400); // > 366 days
    expect((await q('from=2025-01-01&to=2025-12-31')).statusCode).toBe(200);
    expect((await q('from=bogus')).statusCode).toBe(400);
    expect((await (await teammate(m.merchantId, 'read_only')).req('GET', '/v1/dashboard/exports/invoices.csv')).statusCode).toBe(200);
    expect((await (await teammate(m.merchantId, 'developer')).req('GET', '/v1/dashboard/exports/invoices.csv')).statusCode).toBe(403);
    expect((await new Agent(app).req('GET', '/v1/dashboard/exports/invoices.csv')).statusCode).toBe(401);
  });
});
