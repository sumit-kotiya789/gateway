// API key format: <sk|pk>_<live|test>_<10-char id><32-char secret>, base62 (~190 bits of secret).
// Stored: the public prefix (lookup) + HMAC-SHA256(pepper, full key). The full key is shown once.
import { AppError, type ApiKeyScope } from '@gw/core';
import { eq } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { hmacSha256Hex, randomBase62, safeEqual } from '../../common/crypto/random.js';
import { withSystem } from '../../common/db.js';
import { apiKeys, merchants } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { ipAllowed } from '../auth/guards.js';

const KEY_RE = /^(sk|pk)_(live|test)_([0-9A-Za-z]{10})([0-9A-Za-z]{32})$/;
const LAST_USED_RESOLUTION_MS = 60_000;

export type ApiKeyKind = 'secret' | 'publishable';

export interface AuthedApiKey {
  id: string;
  merchantId: string;
  kind: ApiKeyKind;
  livemode: boolean;
  scopes: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: AuthedApiKey | null;
  }
}

export function generateApiKey(kind: ApiKeyKind, livemode: boolean): { key: string; prefix: string } {
  const prefix = `${kind === 'secret' ? 'sk' : 'pk'}_${livemode ? 'live' : 'test'}_${randomBase62(10)}`;
  return { key: `${prefix}${randomBase62(32)}`, prefix };
}

export function parseApiKey(raw: string): { prefix: string; kind: ApiKeyKind; livemode: boolean } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { prefix: `${m[1]}_${m[2]}_${m[3]}`, kind: m[1] === 'sk' ? 'secret' : 'publishable', livemode: m[2] === 'live' };
}

export function hashApiKey(pepper: string, key: string): string {
  return hmacSha256Hex(pepper, key);
}

/** Prefix for rate-limit keying and logs. Never the full key. */
export function apiKeyPrefixFromHeader(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return parseApiKey(h.slice(7))?.prefix ?? null;
}

async function authenticate(deps: Deps, req: FastifyRequest): Promise<AuthedApiKey> {
  const fail = () => new AppError('unauthorized', 'invalid API key');
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new AppError('unauthorized', 'API key required');
  const raw = h.slice(7);
  const parsed = parseApiKey(raw);
  if (!parsed) throw fail();
  const now = deps.clock();
  const row = await withSystem(deps.db, async (tx) => {
    const [r] = await tx
      .select({ key: apiKeys, merchantStatus: merchants.status })
      .from(apiKeys)
      .innerJoin(merchants, eq(merchants.id, apiKeys.merchantId))
      .where(eq(apiKeys.prefix, parsed.prefix));
    return r;
  });
  // Hash compare runs even when the prefix is unknown, so timing does not reveal valid prefixes.
  const expected = row?.key.secretHash ?? '0'.repeat(64);
  const matches = safeEqual(hashApiKey(deps.config.API_KEY_PEPPER, raw), expected);
  if (!row || !matches) throw fail();
  const k = row.key;
  if (k.revokedAt || (k.expiresAt && k.expiresAt.getTime() <= now) || row.merchantStatus !== 'active') throw fail();
  if (k.ipAllowlist && !ipAllowed(req.ip, k.ipAllowlist)) throw new AppError('forbidden', 'request IP not allowed for this key');
  if (!k.lastUsedAt || now - k.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await withSystem(deps.db, (tx) => tx.update(apiKeys).set({ lastUsedAt: new Date(now) }).where(eq(apiKeys.id, k.id)));
  }
  return { id: k.id, merchantId: k.merchantId, kind: k.kind, livemode: k.livemode, scopes: k.scopes };
}

export function requireApiKey(deps: Deps, scope: ApiKeyScope): preHandlerAsyncHookHandler {
  return async (req) => {
    const key = await authenticate(deps, req);
    req.apiKey = key;
    if (!key.scopes.includes(scope)) throw new AppError('forbidden', `API key lacks scope ${scope}`);
  };
}
