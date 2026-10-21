import { AppError } from '@gw/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey as ViemHDKey, hdKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { must } from '../src/evm/deriver.js';
import { evmDeriver, parseAccountXpub } from '../src/index.js';

// Well-known Anvil/Hardhat test mnemonic. Public; never holds real funds.
const MNEMONIC = 'test test test test test test test test test test test junk';
const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const account = master.derive("m/44'/60'/0'");
const XPUB = account.publicExtendedKey;
const XPRV = account.privateExtendedKey;
const b58c = createBase58check(sha256);

function withVersion(key: string, version: number): string {
  const raw = b58c.decode(key);
  const out = new Uint8Array(raw);
  new DataView(out.buffer).setUint32(0, version);
  return b58c.encode(out);
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return ((e as AppError).details as { reason: string }).reason;
  }
}

describe('EVM derivation from account xpub', () => {
  it.each([
    [0, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    [1, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
    [2, '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
  ])('m/44h/60h/0h/0/%i = %s (published Anvil vectors)', (i, addr) => {
    expect(evmDeriver.deriveFromXpub(XPUB, i)).toEqual({ address: addr, path: `0/${i}` });
  });

  it('matches viem private-key derivation for 50 indices (independent implementation)', () => {
    expect(evmDeriver.deriveFromXpub(XPUB, 0).address).toBe(mnemonicToAccount(MNEMONIC).address);
    // viem bundles its own @scure/bip32 copy: build its master key with its own HDKey.
    const viemMaster = ViemHDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    for (let i = 0; i < 50; i++) {
      expect(evmDeriver.deriveFromXpub(XPUB, i).address).toBe(hdKeyToAccount(viemMaster, { addressIndex: i }).address);
    }
  });

  it('works at the top of the non-hardened range and rejects out-of-range indices', () => {
    expect(evmDeriver.deriveFromXpub(XPUB, 0x7fffffff).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    for (const bad of [-1, 0x80000000, 1.5, Number.NaN]) {
      expect(() => evmDeriver.deriveFromXpub(XPUB, bad)).toThrow(RangeError);
    }
  });

  it('tpub of the same key derives the same addresses and has the same fingerprint', () => {
    const tpub = withVersion(XPUB, 0x043587cf);
    expect(evmDeriver.deriveFromXpub(tpub, 0).address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(evmDeriver.keyFingerprint(tpub)).toBe(evmDeriver.keyFingerprint(XPUB));
    expect(evmDeriver.keyFingerprint(XPUB)).toMatch(/^[0-9a-f]{64}$/);
    const other = master.derive("m/44'/60'/1'").publicExtendedKey;
    expect(evmDeriver.keyFingerprint(other)).not.toBe(evmDeriver.keyFingerprint(XPUB));
  });
});

describe('xpub validation', () => {
  it('accepts an account-level xpub', () => {
    expect(() => {
      evmDeriver.validateXpub(XPUB);
    }).not.toThrow();
    expect(parseAccountXpub(XPUB).depth).toBe(3);
  });

  it('refuses extended private keys (xprv, tprv, SLIP-132 zprv/yprv)', () => {
    expect(reason(() => parseAccountXpub(XPRV))).toBe('private_key');
    expect(reason(() => parseAccountXpub(withVersion(XPRV, 0x04358394)))).toBe('private_key');
    expect(reason(() => parseAccountXpub(withVersion(XPRV, 0x04b2430c)))).toBe('private_key');
    expect(reason(() => parseAccountXpub(withVersion(XPRV, 0x049d7878)))).toBe('private_key');
  });

  it('error messages never echo the submitted key', () => {
    try {
      parseAccountXpub(XPRV);
    } catch (e) {
      expect((e as Error).message).not.toContain(XPRV.slice(4, 20));
      expect(JSON.stringify((e as AppError).details)).not.toContain(XPRV.slice(4, 20));
    }
  });

  it('rejects wrong depth (master, change-level)', () => {
    expect(reason(() => parseAccountXpub(master.publicExtendedKey))).toBe('depth');
    expect(reason(() => parseAccountXpub(account.deriveChild(0).publicExtendedKey))).toBe('depth');
  });

  it('rejects non-xpub public versions (zpub, ypub)', () => {
    expect(reason(() => parseAccountXpub(withVersion(XPUB, 0x04b24746)))).toBe('version');
    expect(reason(() => parseAccountXpub(withVersion(XPUB, 0x049d7cb2)))).toBe('version');
  });

  it('rejects a well-formed envelope carrying an invalid public key', () => {
    const raw = new Uint8Array(b58c.decode(XPUB));
    raw[45] = 0x05; // key prefix must be 0x02/0x03 for a compressed point
    expect(reason(() => parseAccountXpub(b58c.encode(raw)))).toBe('format');
  });

  it('rejects a valid-checksum payload of the wrong length', () => {
    const raw = b58c.decode(XPUB);
    const longer = new Uint8Array(79);
    longer.set(raw);
    expect(reason(() => parseAccountXpub(b58c.encode(longer)))).toBe('format');
  });

  it('must() refuses null/undefined key parts', () => {
    expect(must(new Uint8Array(1), 'x')).toHaveLength(1);
    expect(() => must<Uint8Array>(null, 'public key')).toThrow(/missing its public key/);
    expect(() => must<Uint8Array>(undefined, 'chain code')).toThrow(/chain code/);
  });

  it('rejects bad checksum and garbage', () => {
    const last = XPUB.at(-1) === 'a' ? 'b' : 'a';
    expect(reason(() => parseAccountXpub(XPUB.slice(0, -1) + last))).toBe('checksum');
    expect(reason(() => parseAccountXpub('xpub-not-a-key'))).toBe('format');
    expect(reason(() => parseAccountXpub(''))).toBe('format');
    expect(reason(() => parseAccountXpub(MNEMONIC))).toBe('format');
    expect(reason(() => parseAccountXpub(`0x${'ab'.repeat(32)}`))).toBe('format');
  });
});
