// MONEY-CRITICAL
// Seed source `openbao` (D-093): the mnemonic is encrypted by an OpenBao Transit key (HashiCorp Vault has the same API)
// that never leaves OpenBao; the seed file holds only that ciphertext. At boot the signer logs in with AppRole (role id
// from its environment, secret id from a file), asks Transit to decrypt once and revokes its token. Every decrypt is in
// OpenBao's audit log; disabling the AppRole or the key stops any copy of the file from being opened.
import { readFile, writeFile } from 'node:fs/promises';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { postJson } from './http.js';
import { seedFromMnemonic, type SeedSource } from './seed.js';

export interface OpenBaoSettings {
  /** https://openbao.internal:8200 (plain http only outside production). */
  addr: string;
  /** Transit mount path, e.g. `transit`. */
  mount: string;
  /** Transit key name, e.g. `gateway-signer`. */
  key: string;
  roleId: string;
  secretIdFile: string;
  caFile?: string;
}

interface SealedFile {
  v: number;
  source: string;
  key: string;
  ciphertext: string;
}

const object = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

class OpenBao {
  private constructor(
    private readonly s: OpenBaoSettings,
    private readonly ca: Buffer | undefined,
    private readonly token: string,
  ) {}

  /** AppRole login. Errors name the step and the HTTP status only, never the request. */
  static async login(s: OpenBaoSettings): Promise<OpenBao> {
    const ca = s.caFile ? await readFile(s.caFile) : undefined;
    const secretId = (await readFile(s.secretIdFile, 'utf8')).trim();
    const r = await postJson(new URL('/v1/auth/approle/login', s.addr), { role_id: s.roleId, secret_id: secretId }, {}, ca);
    const token = object(object(r.json).auth).client_token;
    if (r.status !== 200 || typeof token !== 'string' || token === '') throw new Error(`OpenBao login failed (HTTP ${String(r.status)})`);
    return new OpenBao(s, ca, token);
  }

  private async transit(op: 'encrypt' | 'decrypt', body: object): Promise<Record<string, unknown>> {
    const path = `/v1/${this.s.mount}/${op}/${encodeURIComponent(this.s.key)}`;
    const r = await postJson(new URL(path, this.s.addr), body, { 'x-vault-token': this.token }, this.ca);
    if (r.status !== 200) throw new Error(`OpenBao ${op} failed (HTTP ${String(r.status)})`);
    return object(object(r.json).data);
  }

  async encrypt(plaintext: string): Promise<string> {
    const ct = (await this.transit('encrypt', { plaintext: Buffer.from(plaintext, 'utf8').toString('base64') })).ciphertext;
    if (typeof ct !== 'string' || !ct.startsWith('vault:v')) throw new Error('OpenBao encrypt returned no ciphertext');
    return ct;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const pt = (await this.transit('decrypt', { ciphertext })).plaintext;
    if (typeof pt !== 'string') throw new Error('OpenBao decrypt returned no plaintext');
    return Buffer.from(pt, 'base64').toString('utf8');
  }

  /** Best effort: the token is useless after boot, so it should not outlive it. */
  async revoke(): Promise<void> {
    await postJson(new URL('/v1/auth/token/revoke-self', this.s.addr), {}, { 'x-vault-token': this.token }, this.ca).catch(() => undefined);
  }
}

export class OpenBaoSeed implements SeedSource {
  constructor(
    private readonly path: string,
    private readonly s: OpenBaoSettings,
  ) {}

  async load(): Promise<Uint8Array> {
    const f = JSON.parse(await readFile(this.path, 'utf8')) as Partial<SealedFile>;
    if (f.v !== 1 || f.source !== 'openbao' || typeof f.ciphertext !== 'string') throw new Error('seed file is not an OpenBao seed file');
    if (f.key !== this.s.key) throw new Error('seed file was made for another Transit key');
    const bao = await OpenBao.login(this.s);
    try {
      return seedFromMnemonic(await bao.decrypt(f.ciphertext));
    } finally {
      await bao.revoke();
    }
  }

  /** Creates a new 24-word mnemonic and writes it encrypted by Transit. Refuses to overwrite. Returns the mnemonic for backup. */
  static async create(path: string, s: OpenBaoSettings): Promise<string> {
    const mnemonic = generateMnemonic(wordlist, 256);
    const bao = await OpenBao.login(s);
    try {
      const sealed: SealedFile = { v: 1, source: 'openbao', key: s.key, ciphertext: await bao.encrypt(mnemonic) };
      await writeFile(path, JSON.stringify(sealed), { flag: 'wx', mode: 0o600 });
    } finally {
      await bao.revoke();
    }
    return mnemonic;
  }
}
