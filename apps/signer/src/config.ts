// Signer configuration (M7b, D-088). Lives in the signer's own environment, not in the app database: limits and the
// cold-wallet allowlist cannot be changed by anyone who only controls the app or its database.
import { z } from 'zod';
import type { OpenBaoSettings } from './openbao.js';

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
    // Seed source. `local-file`: dev/test only, an AES-256-GCM sealed mnemonic under SIGNER_SEED_KEK. `openbao`: the
    // mnemonic encrypted by an OpenBao (or Vault) Transit key, opened once at boot through AppRole (D-093).
    SIGNER_SEED_SOURCE: z.enum(['local-file', 'openbao']).default('local-file'),
    SIGNER_SEED_FILE: z.string().min(1).optional(),
    SIGNER_SEED_KEK: z
      .base64()
      .refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 bytes, base64')
      .optional(),
    SIGNER_OPENBAO_ADDR: z.url({ protocol: /^https?$/ }).optional(),
    SIGNER_OPENBAO_TRANSIT_MOUNT: z.string().regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, 'a mount path like transit').default('transit'),
    SIGNER_OPENBAO_TRANSIT_KEY: z.string().regex(/^[A-Za-z0-9_-]+$/, 'a key name like gateway-signer').default('gateway-signer'),
    SIGNER_OPENBAO_ROLE_ID: z.string().min(1).optional(),
    // The AppRole secret id is read from this file (never from the environment).
    SIGNER_OPENBAO_SECRET_ID_FILE: z.string().min(1).optional(),
    // CA that issued OpenBao's TLS certificate (default: system roots).
    SIGNER_OPENBAO_CA_FILE: z.string().min(1).optional(),
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
    // Emergency stop from the signer's own config, independent of the admin switch in the database.
    SIGNER_PAUSED: z.stringbool().default(false),
  })
  .superRefine((c, ctx) => {
    const need = (key: keyof typeof c, present: boolean) => {
      if (!present) ctx.addIssue({ code: 'custom', path: [key], message: `required for ${c.SIGNER_SEED_SOURCE}` });
    };
    need('SIGNER_SEED_FILE', Boolean(c.SIGNER_SEED_FILE));
    if (c.SIGNER_SEED_SOURCE === 'local-file') {
      if (c.NODE_ENV === 'production') {
        ctx.addIssue({ code: 'custom', path: ['SIGNER_SEED_SOURCE'], message: 'local-file is refused in production: use openbao (D-093)' });
      }
      need('SIGNER_SEED_KEK', Boolean(c.SIGNER_SEED_KEK));
    } else {
      need('SIGNER_OPENBAO_ADDR', Boolean(c.SIGNER_OPENBAO_ADDR));
      need('SIGNER_OPENBAO_ROLE_ID', Boolean(c.SIGNER_OPENBAO_ROLE_ID));
      need('SIGNER_OPENBAO_SECRET_ID_FILE', Boolean(c.SIGNER_OPENBAO_SECRET_ID_FILE));
      if (c.NODE_ENV === 'production' && c.SIGNER_OPENBAO_ADDR && !c.SIGNER_OPENBAO_ADDR.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['SIGNER_OPENBAO_ADDR'], message: 'must be https in production' });
      }
    }
    if (c.NODE_ENV === 'production' && !(c.SIGNER_TLS_CERT_FILE && c.SIGNER_TLS_KEY_FILE && c.SIGNER_TLS_CLIENT_CA_FILE)) {
      ctx.addIssue({ code: 'custom', path: ['SIGNER_TLS_CERT_FILE'], message: 'mTLS (cert, key, client CA) is required in production' });
    }
  });

/** The seed source and its settings, checked: what seedSource() and createSeed() take. */
export type SeedSettings =
  | { source: 'local-file'; file: string; kek: Buffer }
  | { source: 'openbao'; file: string; openbao: OpenBaoSettings };

export type SignerConfig = z.infer<typeof schema> & { SEED: SeedSettings };

/** Validates env at boot. Errors name keys only, never values. */
export function loadSignerConfig(env: Record<string, string | undefined> = process.env): SignerConfig {
  const known = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, env[k]]));
  const res = schema.safeParse(known);
  if (!res.success) {
    throw new Error(`invalid signer configuration: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const c = res.data;
  // The refinements above guarantee every value used here; the fallbacks only satisfy the types.
  const file = c.SIGNER_SEED_FILE ?? '';
  const SEED: SeedSettings =
    c.SIGNER_SEED_SOURCE === 'openbao'
      ? {
          source: 'openbao',
          file,
          openbao: {
            addr: c.SIGNER_OPENBAO_ADDR ?? '',
            mount: c.SIGNER_OPENBAO_TRANSIT_MOUNT,
            key: c.SIGNER_OPENBAO_TRANSIT_KEY,
            roleId: c.SIGNER_OPENBAO_ROLE_ID ?? '',
            secretIdFile: c.SIGNER_OPENBAO_SECRET_ID_FILE ?? '',
            ...(c.SIGNER_OPENBAO_CA_FILE ? { caFile: c.SIGNER_OPENBAO_CA_FILE } : {}),
          },
        }
      : { source: 'local-file', file, kek: Buffer.from(c.SIGNER_SEED_KEK ?? '', 'base64') };
  return { ...c, SEED };
}
