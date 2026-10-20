// Envelope encryption for sensitive columns (TOTP secrets, webhook secrets).
// Each value gets its own random data key (DEK); the DEK is wrapped by a key-encryption key (KEK).
// The AAD binds a ciphertext to its column + row, so ciphertexts cannot be swapped between rows.
// Production KEK provider (AWS KMS / Vault) implements the same interface; see docs/DECISIONS.md D-010.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyEncryptionKey {
  readonly id: string;
  wrap(dek: Buffer, aad: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, aad: string): Promise<Buffer>;
}

function gcmSeal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function gcmOpen(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 28) throw new Error('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

/** Dev / single-host KEK held in process memory (loaded from the secret manager via env). */
export class LocalKek implements KeyEncryptionKey {
  readonly #key: Buffer;
  constructor(
    readonly id: string,
    key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('KEK must be 32 bytes');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('invalid KEK id');
    this.#key = Buffer.from(key);
  }
  wrap(dek: Buffer, aad: string): Promise<Buffer> {
    return Promise.resolve(gcmSeal(this.#key, dek, `kek|${aad}`));
  }
  unwrap(wrapped: Buffer, aad: string): Promise<Buffer> {
    return Promise.resolve(gcmOpen(this.#key, wrapped, `kek|${aad}`));
  }
}

/** keks[0] encrypts; any listed KEK can decrypt (rotation). Format: v1.<kekId>.<wrappedDek>.<payload> (base64url). */
export class Envelope {
  constructor(private readonly keks: readonly KeyEncryptionKey[]) {
    if (keks.length === 0) throw new Error('at least one KEK required');
  }

  async seal(plaintext: string, aad: string): Promise<string> {
    const kek = this.keks[0] as KeyEncryptionKey;
    const dek = randomBytes(32);
    try {
      const wrapped = await kek.wrap(dek, aad);
      const payload = gcmSeal(dek, Buffer.from(plaintext, 'utf8'), aad);
      return ['v1', kek.id, wrapped.toString('base64url'), payload.toString('base64url')].join('.');
    } finally {
      dek.fill(0);
    }
  }

  async open(sealed: string, aad: string): Promise<string> {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported ciphertext format');
    const [, kekId, wrapped, payload] = parts as [string, string, string, string];
    const kek = this.keks.find((k) => k.id === kekId);
    if (!kek) throw new Error('unknown KEK id');
    const dek = await kek.unwrap(Buffer.from(wrapped, 'base64url'), aad);
    try {
      return gcmOpen(dek, Buffer.from(payload, 'base64url'), aad).toString('utf8');
    } finally {
      dek.fill(0);
    }
  }
}
