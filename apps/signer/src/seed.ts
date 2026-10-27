// MONEY-CRITICAL
// Where the platform seed comes from (D-010, D-088). Only this file and keys.ts ever see key material, and only
// inside the signer process. `local-file` is for development and tests: the mnemonic sealed with AES-256-GCM under
// SIGNER_SEED_KEK. Production refuses it (config.ts) until a KMS-backed source is implemented.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const AAD = Buffer.from('gateway-signer-seed:v1');

interface SealedSeed {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

export interface SeedSource {
  /** BIP39 seed bytes (64). Callers keep it in memory only. */
  load(): Promise<Uint8Array>;
}

const TAG_BYTES = 16;

function seal(mnemonic: string, kek: Buffer): SealedSeed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: TAG_BYTES });
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(mnemonic, 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function open(s: SealedSeed, kek: Buffer): string {
  if (s.v !== 1) throw new Error('unsupported seed file version');
  // A pinned tag length: a truncated tag is refused instead of checked against fewer bytes.
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(s.iv, 'base64'), { authTagLength: TAG_BYTES });
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8');
}

export class LocalFileSeed implements SeedSource {
  constructor(
    private readonly path: string,
    private readonly kek: Buffer,
  ) {}

  async load(): Promise<Uint8Array> {
    let mnemonic: string;
    try {
      mnemonic = open(JSON.parse(await readFile(this.path, 'utf8')) as SealedSeed, this.kek);
    } catch {
      // Never say more: a wrong KEK and a tampered file look the same on purpose.
      throw new Error('seed file cannot be opened (wrong SIGNER_SEED_KEK or damaged file)');
    }
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error('seed file does not hold a valid mnemonic');
    return mnemonicToSeedSync(mnemonic);
  }

  /** Creates a new 24-word mnemonic and writes it sealed. Refuses to overwrite. Returns the mnemonic for backup. */
  static async create(path: string, kek: Buffer): Promise<string> {
    const mnemonic = generateMnemonic(wordlist, 256);
    await writeFile(path, JSON.stringify(seal(mnemonic, kek)), { flag: 'wx', mode: 0o600 });
    return mnemonic;
  }
}
