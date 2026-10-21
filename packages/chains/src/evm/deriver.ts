// MONEY-CRITICAL
// Deposit addresses come from here. A wrong address = funds sent where nobody (or the wrong party) can spend them.
// Public derivation only: an extended PRIVATE key is refused before it is parsed into a key object.
import type { AddressDeriver } from '@gw/core';
import { AppError } from '@gw/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { bytesToHex, publicKeyToAddress } from 'viem/utils';

const b58c = createBase58check(sha256);

// BIP32 version bytes.
const XPUB = 0x0488b21e;
const TPUB = 0x043587cf;
const XPRV = 0x0488ade4;
const TPRV = 0x04358394;
// SLIP-132 private versions (yprv, zprv, Yprv, Zprv, uprv, vprv, Uprv, Vprv): also refused as private material.
const PRIVATE_VERSIONS = new Set([XPRV, TPRV, 0x049d7878, 0x04b2430c, 0x0295b005, 0x02aa7a99, 0x044a4e28, 0x045f18bc, 0x024285b5, 0x02575048]);

const ACCOUNT_DEPTH = 3; // m / purpose' / coin_type' / account'
export const MAX_NON_HARDENED_INDEX = 0x7fffffff;

function invalid(reason: string, message: string): AppError {
  return new AppError('validation_error', message, { reason });
}

/** Parses and validates an account-level extended public key. Never echoes the input in errors. */
export function parseAccountXpub(xpub: string): HDKey {
  if (typeof xpub !== 'string' || xpub.length < 100 || xpub.length > 120 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(xpub)) {
    throw invalid('format', 'not an extended public key');
  }
  let raw: Uint8Array;
  try {
    raw = b58c.decode(xpub);
  } catch {
    throw invalid('checksum', 'extended key checksum is invalid');
  }
  if (raw.length !== 78) throw invalid('format', 'not an extended public key');
  const version = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
  if (PRIVATE_VERSIONS.has(version)) throw invalid('private_key', 'extended PRIVATE keys are refused; supply the account xpub');
  if (version !== XPUB && version !== TPUB) throw invalid('version', 'unsupported extended key version; expected xpub or tpub');

  const versions = version === XPUB ? { public: XPUB, private: XPRV } : { public: TPUB, private: TPRV };
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(xpub, versions);
  } catch {
    throw invalid('format', 'not an extended public key');
  }
  if (key.privateKey) throw invalid('private_key', 'extended PRIVATE keys are refused; supply the account xpub');
  if (key.depth !== ACCOUNT_DEPTH) throw invalid('depth', `expected an account-level key (depth ${ACCOUNT_DEPTH}), got depth ${key.depth}`);
  return key;
}

/** HDKey fields are nullable in its types; a missing public part means a corrupted key, never "skip". */
export function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`extended key is missing its ${what}`);
  return v;
}

function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_NON_HARDENED_INDEX) {
    throw new RangeError(`derivation index out of range: ${index}`);
  }
}

/** EIP-55 address of account/0/index (external chain). */
export function deriveEvmAddress(account: HDKey, index: number): string {
  assertIndex(index);
  const child = account.deriveChild(0).deriveChild(index);
  const pub = must(child.publicKey, 'public key');
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  return publicKeyToAddress(bytesToHex(uncompressed));
}

export const evmDeriver: AddressDeriver = {
  family: 'evm',
  validateXpub(xpub) {
    parseAccountXpub(xpub);
  },
  keyFingerprint(xpub) {
    const k = parseAccountXpub(xpub);
    const pub = must(k.publicKey, 'public key');
    const chainCode = must(k.chainCode, 'chain code');
    const buf = new Uint8Array(pub.length + chainCode.length);
    buf.set(pub);
    buf.set(chainCode, pub.length);
    return bytesToHex(sha256(buf)).slice(2);
  },
  deriveFromXpub(xpub, index) {
    return { address: deriveEvmAddress(parseAccountXpub(xpub), index), path: `0/${index}` };
  },
};
