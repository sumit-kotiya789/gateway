import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
