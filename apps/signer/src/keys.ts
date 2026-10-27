// MONEY-CRITICAL
// Key derivation inside the signer. Paths are fixed by role (D-088); deposit addresses use the platform wallet
// account's base path. Every address the signer signs for is re-derived here and compared with the database.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { bytesToHex } from 'viem/utils';

/** Account-level paths per role and mode. Hot and gas wallets are child 0/0 of their account. */
export const PATHS = {
  deposits: { live: "m/44'/60'/0'", test: "m/44'/60'/1'" },
  hot: { live: "m/44'/60'/10'/0/0", test: "m/44'/60'/11'/0/0" },
  gas: { live: "m/44'/60'/20'/0/0", test: "m/44'/60'/21'/0/0" },
} as const;

const PATH_RE = /^m(\/\d+'?)+$/;

export class Keyring {
  private readonly root: HDKey;

  constructor(seed: Uint8Array) {
    this.root = HDKey.fromMasterSeed(seed);
  }

  static fromMnemonic(mnemonic: string): Keyring {
    return new Keyring(mnemonicToSeedSync(mnemonic));
  }

  /** Signing account at an absolute path. */
  account(path: string): PrivateKeyAccount {
    if (!PATH_RE.test(path)) throw new Error('invalid derivation path');
    const k = this.root.derive(path);
    if (!k.privateKey) throw new Error('derivation produced no private key');
    return privateKeyToAccount(bytesToHex(k.privateKey));
  }

  address(path: string): string {
    return this.account(path).address;
  }

  /** Account-level xpub (for wallet_accounts: the app derives deposit addresses from it without keys). */
  xpub(accountPath: string): string {
    return this.root.derive(accountPath).publicExtendedKey;
  }
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
