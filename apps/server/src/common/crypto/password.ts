import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

// OWASP 2024 minimum for argon2id: m=19 MiB, t=2, p=1.
const PARAMS = { parallelism: 1, iterations: 2, memorySize: 19_456, hashLength: 32 } as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128; // bounds hashing cost per request

export function hashPassword(password: string): Promise<string> {
  return argon2id({ ...PARAMS, password, salt: randomBytes(16), outputType: 'encoded' });
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/** Burn equivalent time when the account does not exist, so login timing does not reveal accounts. */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummy, password);
  return false;
}
