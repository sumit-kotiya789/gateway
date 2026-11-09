import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 20, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000 });
  // An idle client dropped by the server (DB restart, failover, admin kill) is emitted here. Unhandled, it would crash
  // the process; pg already discards that client and the next query opens a new one. Query errors surface at callers.
  pool.on('error', () => {});
  // Same for a client that is checked out: if the server ends its session (idle-in-transaction timeout, restart), the
  // client emits 'error', and an unhandled 'error' event would crash the process. The query in flight still rejects,
  // and pg-pool drops the broken client on release.
  pool.on('connect', (client) => {
    client.on('error', () => {});
  });
  return { pool, db: drizzle(pool, { schema }) };
}

/** Transaction scoped to one merchant. RLS hides every other tenant's rows. */
export function withTenant<T>(db: Db, merchantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.merchant_id', ${merchantId}, true)`);
    return fn(tx);
  });
}

/** Cross-tenant transaction (auth lookups, admin, workers). Keep call sites few and obvious. */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system', 'on', true)`);
    return fn(tx);
  });
}

/** SQLSTATE of a database error, looking through wrapping `cause`s (drizzle wraps driver errors). */
export function pgCode(err: unknown): string | undefined {
  for (let e = err, i = 0; e && typeof e === 'object' && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}
