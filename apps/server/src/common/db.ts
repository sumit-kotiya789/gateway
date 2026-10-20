import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 20, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000 });
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
