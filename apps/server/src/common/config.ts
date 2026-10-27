import { isIP } from 'node:net';
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Number of trusted reverse-proxy hops in front of the api (0 = none). Wrong value = spoofable client IPs.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),

    JWT_SECRET: secret(32),
    ADMIN_JWT_SECRET: secret(32),
    API_KEY_PEPPER: secret(32),
    DATA_KEK: z.base64().refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 bytes, base64'),
    DATA_KEK_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('local-1'),

    DASHBOARD_ORIGINS: csv,
    ADMIN_ORIGINS: csv,
    ADMIN_IP_ALLOWLIST: csv,

    // Public origin of the api (hosted checkout and payment-link URLs are built from it).
    PUBLIC_BASE_URL: z
      .url()
      .default('http://localhost:3000')
      .transform((u) => u.replace(/\/+$/, '')),

    // Email (M10). Without SMTP_URL (dev/test only) the worker logs recipient + subject instead of sending.
    SMTP_URL: z
      .union([z.literal(''), z.url()])
      .optional()
      .transform((v) => v || undefined),
    EMAIL_FROM: z.string().min(3).max(200).default('Gateway <no-reply@localhost>'),
    // Where links in emails point (verification, password reset). Must be one of DASHBOARD_ORIGINS.
    DASHBOARD_URL: z
      .url()
      .default('http://localhost:8080')
      .transform((u) => u.replace(/\/+$/, '')),

    SIGNUP_ENABLED: z.stringbool().default(true),
    FEATURE_CUSTODIAL: z.stringbool().default(false),
    // Lets webhooks reach private/loopback addresses (local receivers in dev and tests). Refused in production.
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.stringbool().default(false),
    // Live withdrawals at or above this amount (token units) need two different admins; below, one (D-090).
    WITHDRAWAL_TWO_PERSON_MIN: z.string().regex(/^\d+(\.\d+)?$/).default('10000'),
    // Custodial (M7): the worker asks the signer to sign sweeps and payouts. Worker only: it refuses to start without
    // them when FEATURE_CUSTODIAL is on; the api and watcher never get the HMAC secret.
    SIGNER_URL: z
      .union([z.literal(''), z.url()])
      .optional()
      .transform((v) => v || undefined),
    SIGNER_HMAC_SECRET: z
      .union([z.literal(''), secret(32)])
      .optional()
      .transform((v) => v || undefined),
    // mTLS to the signer (required in production): the worker's client certificate and the signer's CA.
    SIGNER_CLIENT_CERT_FILE: z.string().optional(),
    SIGNER_CLIENT_KEY_FILE: z.string().optional(),
    SIGNER_CA_FILE: z.string().optional(),
    // Bearer token for GET /metrics (Prometheus). Unset = no metrics route.
    METRICS_TOKEN: z
      .union([z.literal(''), secret(32)])
      .optional()
      .transform((v) => v || undefined),
  })
  .superRefine((c, ctx) => {
    if (c.JWT_SECRET === c.ADMIN_JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['ADMIN_JWT_SECRET'], message: 'must differ from JWT_SECRET' });
    }
    for (const entry of c.ADMIN_IP_ALLOWLIST) {
      const [ip, bits] = entry.split('/');
      if (!ip || !isIP(ip) || (bits !== undefined && !/^\d{1,3}$/.test(bits))) {
        ctx.addIssue({ code: 'custom', path: ['ADMIN_IP_ALLOWLIST'], message: 'must be comma-separated IPs or CIDRs' });
      }
    }
    if (c.NODE_ENV === 'production') {
      if (c.SIGNER_URL && (!c.SIGNER_URL.startsWith('https://') || !c.SIGNER_CLIENT_CERT_FILE || !c.SIGNER_CLIENT_KEY_FILE || !c.SIGNER_CA_FILE)) {
        ctx.addIssue({ code: 'custom', path: ['SIGNER_URL'], message: 'must be https with a client certificate (mTLS) in production' });
      }
      if (!c.PUBLIC_BASE_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'must be https in production' });
      }
      for (const key of ['DASHBOARD_ORIGINS', 'ADMIN_ORIGINS'] as const) {
        if (c[key].some((o) => !o.startsWith('https://'))) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'origins must be https in production' });
        }
      }
      if (c.WEBHOOK_ALLOW_PRIVATE_NETWORKS) {
        ctx.addIssue({ code: 'custom', path: ['WEBHOOK_ALLOW_PRIVATE_NETWORKS'], message: 'must be false in production (SSRF guard)' });
      }
      if (!c.SMTP_URL) {
        ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required in production (verification and security emails)' });
      }
      if (!c.DASHBOARD_URL.startsWith('https://') || !c.DASHBOARD_ORIGINS.includes(c.DASHBOARD_URL)) {
        ctx.addIssue({ code: 'custom', path: ['DASHBOARD_URL'], message: 'must be https and listed in DASHBOARD_ORIGINS in production' });
      }
      const shared = c.DASHBOARD_ORIGINS.filter((o) => c.ADMIN_ORIGINS.includes(o));
      if (shared.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['ADMIN_ORIGINS'], message: 'admin console must use its own origin' });
      }
    }
  });

export type Config = z.infer<typeof schema>;

/** Validates env at boot. Error lists offending keys only, never values (they may be secrets). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const known = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, env[k]]));
  const res = schema.safeParse(known);
  if (!res.success) {
    const keys = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${keys}`);
  }
  return res.data;
}
