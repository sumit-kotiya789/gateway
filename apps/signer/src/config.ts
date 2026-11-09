// Signer configuration (M7b, D-088). Lives in the signer's own environment, not in the app database: limits and the
// cold-wallet allowlist cannot be changed by anyone who only controls the app or its database.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const secret = (min: number) => z.string().min(min, `must be at least ${String(min)} characters`);
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'a plain decimal');

/** Per-token limits in token units (D-088). A token without limits cannot be withdrawn or moved to treasury. */
const Limits = z.record(z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/), z.strictObject({ per_tx: decimal, per_day: decimal }));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SIGNER_HOST: z.string().min(1).default('127.0.0.1'),
    SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    // The signer connects as a LOGIN user in gw_signer (read-only except signer_signatures).
    SIGNER_DATABASE_URL: z.url(),
    // Shared with the worker: every request carries an HMAC of its body.
    SIGNER_HMAC_SECRET: secret(32),
    // Seed source. `local-file`: an AES-256-GCM sealed mnemonic. No KMS (D-010): in production the KEK must come from
    // SIGNER_SEED_KEK_FILE (written to tmpfs by the secret manager at boot), never from an env var.
    SIGNER_SEED_SOURCE: z.enum(['local-file']).default('local-file'),
    SIGNER_SEED_FILE: z.string().min(1).optional(),
    SIGNER_SEED_KEK: z
      .base64()
      .refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 bytes, base64')
      .optional(),
    SIGNER_SEED_KEK_FILE: z.string().min(1).optional(),
    // mTLS (required in production): server cert/key and the CA that issued the worker's client certificate.
    SIGNER_TLS_CERT_FILE: z.string().optional(),
    SIGNER_TLS_KEY_FILE: z.string().optional(),
    SIGNER_TLS_CLIENT_CA_FILE: z.string().optional(),
    SIGNER_LIMITS: z
      .string()
      .default('{}')
      .transform((s, ctx) => {
        try {
          return Limits.parse(JSON.parse(s));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be JSON like {"bsc:usdt":{"per_tx":"5000","per_day":"20000"}}' });
          return z.NEVER;
        }
      }),
    // Comma-separated cold wallet addresses treasury transfers may go to.
    SIGNER_COLD_ADDRESSES: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
      )
      .refine((a) => a.every((x) => /^0x[0-9a-f]{40}$/.test(x)), 'must be 0x addresses'),
    // Network fee ceilings: refuse to sign above them (protects the gas wallet from a spiking or lying RPC).
    SIGNER_MAX_GAS_PRICE_GWEI: decimal.default('20'),
    SIGNER_MAX_GAS_TOPUP: decimal.default('0.005'), // native coin units per top-up
    SIGNER_TOKEN_TRANSFER_GAS: z.coerce.number().int().min(21_000).max(500_000).default(100_000),
    // Forwarder flushes (D-097): at most this many signed per 24 h, each at most this much gas (the gas wallet pays).
    SIGNER_MAX_FORWARDS_PER_DAY: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    SIGNER_MAX_FORWARD_GAS: z.coerce.number().int().min(100_000).max(5_000_000).default(1_500_000),
    // Hot wallet policy (D-105): sign automatic hot -> cold transfers (no admin approval) for the excess over the cap
    // an admin set. Off by default: the operator of the signer host opts in. They can still only reach
    // SIGNER_COLD_ADDRESSES.
    SIGNER_AUTO_TO_COLD: z.stringbool().default(false),
    // Emergency stop from the signer's own config, independent of the admin switch in the database.
    SIGNER_PAUSED: z.stringbool().default(false),
  })
  .superRefine((c, ctx) => {
    // Env vars leak (docker inspect, /proc/<pid>/environ, crash reports): production takes the KEK from a file only.
    if (c.NODE_ENV === 'production' && !c.SIGNER_SEED_KEK_FILE) {
      ctx.addIssue({ code: 'custom', path: ['SIGNER_SEED_KEK_FILE'], message: 'required in production: the KEK comes from a secret-manager file, not an env var (D-010)' });
    }
    if (!c.SIGNER_SEED_FILE) ctx.addIssue({ code: 'custom', path: ['SIGNER_SEED_FILE'], message: 'required for local-file' });
    if (!c.SIGNER_SEED_KEK) ctx.addIssue({ code: 'custom', path: ['SIGNER_SEED_KEK'], message: 'required for local-file (or SIGNER_SEED_KEK_FILE)' });
    if (c.NODE_ENV === 'production' && !(c.SIGNER_TLS_CERT_FILE && c.SIGNER_TLS_KEY_FILE && c.SIGNER_TLS_CLIENT_CA_FILE)) {
      ctx.addIssue({ code: 'custom', path: ['SIGNER_TLS_CERT_FILE'], message: 'mTLS (cert, key, client CA) is required in production' });
    }
  });

export type SignerConfig = z.infer<typeof schema>;

/** Validates env at boot. Errors name keys only, never values. */
export function loadSignerConfig(env: Record<string, string | undefined> = process.env): SignerConfig {
  const known = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, env[k]]));
  if (known.SIGNER_SEED_KEK_FILE) {
    if (known.SIGNER_SEED_KEK) throw new Error('invalid signer configuration: SIGNER_SEED_KEK: set it or SIGNER_SEED_KEK_FILE, not both');
    try {
      known.SIGNER_SEED_KEK = readFileSync(known.SIGNER_SEED_KEK_FILE, 'utf8').trim();
    } catch {
      throw new Error('invalid signer configuration: SIGNER_SEED_KEK_FILE: cannot be read');
    }
  }
  const res = schema.safeParse(known);
  if (!res.success) {
    throw new Error(`invalid signer configuration: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return res.data;
}
