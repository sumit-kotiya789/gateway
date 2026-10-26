import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';
import { detectSecretMaterial } from '../src/index.js';

const b58c = createBase58check(sha256);
const account = HDKey.fromMasterSeed(randomBytes(32)).derive("m/44'/60'/0'");
const key = randomBytes(32);
const wif = (version: number, compressed: boolean) => b58c.encode(Uint8Array.from([version, ...key, ...(compressed ? [1] : [])]));
/** Changes the last character, which always breaks the base58check checksum. */
const badChecksum = (s: string) => s.slice(0, -1) + (s.endsWith('1') ? '2' : '1');
const tprv = HDKey.fromMasterSeed(randomBytes(32), { private: 0x04358394, public: 0x043587cf }).derive("m/44'/60'/0'").privateExtendedKey;

describe('detectSecretMaterial', () => {
  it.each([
    ['12-word mnemonic', generateMnemonic(wordlist, 128), 'mnemonic'],
    ['24-word mnemonic', generateMnemonic(wordlist, 256), 'mnemonic'],
    ['mnemonic with extra whitespace', `  ${generateMnemonic(wordlist).replace(/ /g, '\n  ')} `, 'mnemonic'],
    ['hex key', Buffer.from(key).toString('hex'), 'hex_private_key'],
    ['0x hex key', `0x${Buffer.from(key).toString('hex')}`, 'hex_private_key'],
    ['xprv', account.privateExtendedKey, 'extended_private_key'],
    ['tprv', tprv, 'extended_private_key'],
    ['WIF compressed', wif(0x80, true), 'wif'],
    ['WIF uncompressed', wif(0x80, false), 'wif'],
    ['WIF testnet', wif(0xef, true), 'wif'],
  ])('%s', (_name, input, kind) => {
    expect(detectSecretMaterial(input)).toBe(kind);
  });

  it.each([
    ['xpub', account.publicExtendedKey],
    ['address', '0x95A55a7A590Ef82dACD78848050c58d10BAb7406'],
    ['11 words', 'one two three four five six seven eight nine ten eleven'],
    ['WIF with a bad checksum', badChecksum(wif(0x80, true))],
    ['WIF-shaped base58 with another version byte', b58c.encode(Uint8Array.from([0x81, ...key, 1]))],
    ['empty', ''],
  ])('%s is not a secret', (_name, input) => {
    expect(detectSecretMaterial(input)).toBeNull();
  });
});
