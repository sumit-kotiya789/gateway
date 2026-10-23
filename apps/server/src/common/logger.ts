import { pino, type DestinationStream, type Logger } from 'pino';

const SECRET_KEY_RE =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|priv[-_]?key|mnemonic|seed|xprv|totp|recovery|signature/i;
// Value patterns that are always secrets regardless of key name. Hex is NOT redacted by value:
// tx hashes and private keys share a format, so keys are protected by key-name rules above.
const SECRET_VALUE_RES: RegExp[] = [/\b(sk|pk)_(live|test)_[A-Za-z0-9_]+/g, /\bwhsec_[A-Za-z0-9]+/g, /\b[xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{20,}/g];
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function redactString(s: string): string {
  return SECRET_VALUE_RES.reduce((acc, re) => acc.replace(re, REDACTED), s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (value instanceof Error) {
    return { type: value.name, message: redactString(value.message), stack: value.stack && redactString(value.stack) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  // Class instances (e.g. Fastify req/res) pass through to their pino serializers, which emit allowlisted fields only.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }), log: (obj) => redact(obj) as Record<string, unknown> },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((a) => (typeof a === 'string' ? redactString(a) : a)) as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
}
