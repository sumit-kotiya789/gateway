// Idempotency-Key support for state-changing merchant-API POSTs.
//
// The key is recorded in the SAME transaction as the side effect, after the work succeeds. A concurrent request with the
// same key blocks on the unique index until the first commits, then fails with a unique violation; its transaction
// (and its side effects) roll back and it replays the stored response instead. No lock service, no race window.
import { AppError } from '@gw/core';
import { and, eq, lt } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { sha256Hex } from './crypto/random.js';
import { withSystem, withTenant, type Tx } from './db.js';

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

/** JSON with sorted object keys, so semantically equal bodies hash equally. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

export function requestHash(method: string, route: string, body: unknown): string {
  return sha256Hex(`${method} ${route}\n${stableStringify(body ?? null)}`);
}

export const IDEMPOTENCY_RETENTION_MS = 24 * 3600_000;

/** Deletes keys older than the retention window (after that, a key may be reused). */
export async function purgeIdempotencyKeys(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock() - IDEMPOTENCY_RETENTION_MS);
  const rows = await withSystem(deps.db, (tx) => tx.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff)).returning({ id: idempotencyKeys.id }));
  return rows.length;
}

function isIdempotencyConflict(err: unknown): boolean {
  for (let e = err, i = 0; e && typeof e === 'object' && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const x = e as { code?: unknown; constraint?: unknown };
    if (x.code === '23505' && x.constraint === 'idempotency_keys_uq') return true;
  }
  return false;
}

/**
 * Runs `work` in a tenant transaction. With a key: a previous identical request replays its stored response;
 * a different request under the same key is rejected (409 idempotency_conflict).
 */
export async function withIdempotency(
  deps: Deps,
  scope: { merchantId: string; livemode: boolean },
  key: string | undefined,
  hash: string,
  work: (tx: Tx) => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (key === undefined) {
    const r = await withTenant(deps.db, scope.merchantId, work);
    return { ...r, replayed: false };
  }
  if (!KEY_RE.test(key)) throw new AppError('validation_error', 'Idempotency-Key must be 1-255 printable ASCII characters');

  const lookup = (tx: Tx) =>
    tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.merchantId, scope.merchantId), eq(idempotencyKeys.livemode, scope.livemode), eq(idempotencyKeys.key, key)))
      .then((rows) => rows[0]);

  const replay = (row: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
    if (row.requestHash !== hash) {
      throw new AppError('idempotency_conflict', 'Idempotency-Key was already used with a different request');
    }
    return { status: row.responseStatus, body: row.responseBody, replayed: true };
  };

  try {
    return await withTenant(deps.db, scope.merchantId, async (tx) => {
      const existing = await lookup(tx);
      if (existing) return replay(existing);
      const res = await work(tx);
      await tx.insert(idempotencyKeys).values({
        merchantId: scope.merchantId,
        livemode: scope.livemode,
        key,
        requestHash: hash,
        responseStatus: res.status,
        responseBody: JSON.parse(JSON.stringify(res.body)) as unknown,
      });
      return { ...res, replayed: false };
    });
  } catch (err) {
    if (!isIdempotencyConflict(err)) throw err;
    // A concurrent request with this key committed first; our side effects were rolled back.
    const row = await withTenant(deps.db, scope.merchantId, lookup);
    if (!row) throw err;
    return replay(row);
  }
}
