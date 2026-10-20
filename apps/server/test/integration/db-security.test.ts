import { uuidv7 } from '@gw/core';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { audit } from '../../src/common/audit.js';
import { createDb, withSystem, withTenant } from '../../src/common/db.js';
import { apiKeys, auditLogs, merchants, merchantUsers } from '../../src/db/schema.js';
import { ownerPool, testEnv } from './helpers.js';

const { db, pool } = createDb(testEnv().DATABASE_URL);
const owner = ownerPool();
afterAll(async () => {
  await pool.end();
  await owner.end();
});

async function newMerchant(name = 'm') {
  return withSystem(db, async (tx) => {
    const [m] = await tx.insert(merchants).values({ name }).returning();
    if (!m) throw new Error('insert failed');
    return m.id;
  });
}

/** Drizzle wraps driver errors; the Postgres message is on cause. */
const isRls = (e: unknown) => /row-level security/.test(String((e as { cause?: { message?: string } }).cause?.message));

async function chainBreak(): Promise<string | null> {
  const r = await owner.query<{ b: string | null }>('select audit_verify()::text as b');
  return r.rows[0]?.b ?? null;
}

describe('append-only audit log', () => {
  it('app role cannot UPDATE, DELETE or TRUNCATE audit_logs', async () => {
    const mid = await newMerchant();
    await withTenant(db, mid, (tx) => audit(tx, { actorType: 'system', merchantId: mid, action: 'test.event' }));
    await expect(withSystem(db, (tx) => tx.update(auditLogs).set({ action: 'x' }).where(eq(auditLogs.merchantId, mid)))).rejects.toThrow();
    await expect(withSystem(db, (tx) => tx.delete(auditLogs).where(eq(auditLogs.merchantId, mid)))).rejects.toThrow();
    await expect(pool.query('truncate audit_logs')).rejects.toThrow();
  });

  it('even the table owner is blocked by trigger', async () => {
    await expect(owner.query(`update audit_logs set action = 'x' where seq = 1`)).rejects.toThrow(/append-only/);
    await expect(owner.query('delete from audit_logs where seq = 1')).rejects.toThrow(/append-only/);
    await expect(owner.query('truncate audit_logs')).rejects.toThrow(/append-only/);
  });

  it('app role cannot drop or alter tables', async () => {
    await expect(pool.query('drop table merchants')).rejects.toThrow();
    await expect(pool.query('alter table merchants add column x int')).rejects.toThrow();
    await expect(pool.query('create table evil (id int)')).rejects.toThrow();
  });

  it('client-supplied seq/at/hash are overwritten by the chain trigger', async () => {
    const mid = await newMerchant();
    const [row] = await withTenant(db, mid, (tx) =>
      tx
        .insert(auditLogs)
        .values({ seq: 999_999n, at: new Date(0), actorType: 'system', merchantId: mid, action: 'forged', hash: Buffer.alloc(32), prevHash: Buffer.alloc(32) })
        .returning(),
    );
    expect(row?.seq).not.toBe(999_999n);
    expect(row?.at.getTime()).toBeGreaterThan(0);
    expect(await chainBreak()).toBeNull();
  });

  it('chain stays intact under concurrent inserts from many tenants', async () => {
    const mids = await Promise.all(Array.from({ length: 5 }, () => newMerchant()));
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const mid = mids[i % mids.length] as string;
        return withTenant(db, mid, (tx) => audit(tx, { actorType: 'system', merchantId: mid, action: `burst.${i}` }));
      }),
    );
    expect(await chainBreak()).toBeNull();
    const seqs = await owner.query<{ n: string; mx: string }>('select count(*)::text n, max(seq)::text mx from audit_logs');
    expect(seqs.rows[0]?.n).toBe(seqs.rows[0]?.mx); // gap-free
  });

  it('rolled-back audit entries leave no gap and no break', async () => {
    const mid = await newMerchant();
    await expect(
      withTenant(db, mid, async (tx) => {
        await audit(tx, { actorType: 'system', merchantId: mid, action: 'will.rollback' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await withTenant(db, mid, (tx) => audit(tx, { actorType: 'system', merchantId: mid, action: 'after.rollback' }));
    expect(await chainBreak()).toBeNull();
  });

  it('audit payload redacts secret-named fields', async () => {
    const mid = await newMerchant();
    await withTenant(db, mid, (tx) => audit(tx, { actorType: 'system', merchantId: mid, action: 'redact.test', after: { password: 'hunter2', apiKey: 'sk_live_x', ok: 1 } }));
    const r = await owner.query<{ after: unknown }>(`select after from audit_logs where action = 'redact.test'`);
    const s = JSON.stringify(r.rows[0]?.after);
    expect(s).not.toContain('hunter2');
    expect(s).toContain('"ok":1');
  });

  // Runs last in this file: it tampers with the chain.
  it('tampering is detected by audit_verify()', async () => {
    const mid = await newMerchant();
    await withTenant(db, mid, (tx) => audit(tx, { actorType: 'system', merchantId: mid, action: 'tamper.target', after: { amount: '10' } }));
    const { rows } = await owner.query<{ seq: string }>(`select seq::text from audit_logs where action = 'tamper.target'`);
    const seq = rows[0]?.seq;
    const c = await owner.connect();
    try {
      // Simulates an attacker with superuser access who bypasses the trigger.
      await c.query('begin');
      await c.query('alter table audit_logs disable trigger audit_logs_no_update_delete');
      await c.query(`update audit_logs set after = '{"amount":"1000"}' where seq = $1`, [seq]);
      expect(await c.query<{ b: string }>('select audit_verify()::text as b').then((r) => r.rows[0]?.b)).toBe(seq);
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect(await chainBreak()).toBeNull();
  });
});

describe('row-level security', () => {
  it('tenant context sees only its own rows; no context sees nothing', async () => {
    const a = await newMerchant('A');
    const b = await newMerchant('B');
    for (const mid of [a, b]) {
      await withSystem(db, (tx) =>
        tx.insert(merchantUsers).values({ merchantId: mid, email: `${uuidv7()}@x.test`, passwordHash: 'h', role: 'owner' }),
      );
    }
    const seenByA = await withTenant(db, a, (tx) => tx.select().from(merchantUsers));
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((u) => u.merchantId === a)).toBe(true);
    expect(await withTenant(db, a, (tx) => tx.select().from(merchants))).toHaveLength(1);

    const noContext = await db.select().from(merchantUsers);
    expect(noContext).toHaveLength(0);
  });

  it('tenant context cannot insert or move rows into another tenant', async () => {
    const a = await newMerchant('A');
    const b = await newMerchant('B');
    await expect(
      withTenant(db, a, (tx) =>
        tx.insert(apiKeys).values({ merchantId: b, kind: 'secret', livemode: false, name: 'x', prefix: `sk_test_${uuidv7()}`, secretHash: 'h', scopes: ['read'] }),
      ),
    ).rejects.toSatisfy(isRls);
    const [u] = await withSystem(db, (tx) =>
      tx.insert(merchantUsers).values({ merchantId: a, email: `${uuidv7()}@x.test`, passwordHash: 'h', role: 'owner' }).returning(),
    );
    await expect(withTenant(db, a, (tx) => tx.update(merchantUsers).set({ merchantId: b }).where(eq(merchantUsers.id, u?.id ?? '')))).rejects.toSatisfy(isRls);
  });

  it('admin_users is invisible outside system context', async () => {
    const a = await newMerchant('A');
    await owner.query(`insert into admin_users (id, email, password_hash, role, totp_secret_enc) values ($1, $2, 'h', 'auditor', 'x')`, [uuidv7(), `${uuidv7()}@admin.test`]);
    expect((await withTenant(db, a, (tx) => tx.execute('select * from admin_users'))).rows).toHaveLength(0);
    expect((await withSystem(db, (tx) => tx.execute('select * from admin_users'))).rows.length).toBeGreaterThan(0);
  });
});
