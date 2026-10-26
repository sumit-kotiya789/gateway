// MONEY-CRITICAL
// Spots secret key material pasted where an xpub belongs (seed phrase, raw private key, WIF, extended private key).
// The input is never stored or echoed: callers record only the kind, and tell the user to treat the secret as exposed.
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';

export type SecretKind = 'mnemonic' | 'hex_private_key' | 'wif' | 'extended_private_key';

const b58c = createBase58check(sha256);
const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);
// Base58 prefixes of BIP32 / SLIP-132 private versions (xprv, tprv, yprv, zprv, Yprv, Zprv, uprv, vprv, Uprv, Vprv).
const EXTENDED_PRIVATE = /^[xtyzYZuvUV]prv[1-9A-HJ-NP-Za-km-z]{100,}$/;
const WIF_SHAPE = /^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/;

function isWif(s: string): boolean {
  if (!WIF_SHAPE.test(s)) return false;
  try {
    const raw = b58c.decode(s);
    // version byte 0x80 (mainnet) / 0xef (testnet) + 32-byte key (+ 0x01 compression flag)
    return (raw[0] === 0x80 || raw[0] === 0xef) && (raw.length === 33 || (raw.length === 34 && raw[33] === 0x01));
  } catch {
    return false;
  }
}

/** The kind of secret `input` looks like, or null. A plain xpub/tpub, an address or random text returns null. */
export function detectSecretMaterial(input: string): SecretKind | null {
  const s = input.trim();
  const words = s.split(/\s+/);
  if (MNEMONIC_LENGTHS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/i.test(w))) return 'mnemonic';
  if (/^(0x)?[0-9a-f]{64}$/i.test(s)) return 'hex_private_key';
  if (EXTENDED_PRIVATE.test(s)) return 'extended_private_key';
  if (isWif(s)) return 'wif';
  return null;
}
