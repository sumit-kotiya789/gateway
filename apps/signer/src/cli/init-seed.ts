// Creates the signer's seed (development and test only; production needs a KMS, D-010) and prints the public values
// to register in the app: platform deposit xpubs and the hot and gas wallet addresses. `--show-mnemonic` also shows
// the 24 words once, for an offline backup. Only the JSON goes to stdout (`> custody.json`); notes and the words go to
// stderr, so the mnemonic never lands in that file.
import { Keyring, PATHS } from '../keys.js';
import { LocalFileSeed } from '../seed.js';
import { loadSignerConfig } from '../config.js';

async function main(): Promise<void> {
  const config = loadSignerConfig();
  /* v8 ignore next -- config refuses local-file without both values */
  if (!config.SIGNER_SEED_FILE || !config.SIGNER_SEED_KEK) throw new Error('SIGNER_SEED_FILE and SIGNER_SEED_KEK are required');
  const mnemonic = await LocalFileSeed.create(config.SIGNER_SEED_FILE, Buffer.from(config.SIGNER_SEED_KEK, 'base64'));
  const k = Keyring.fromMnemonic(mnemonic);
  const out = {
    wallet_accounts: (['live', 'test'] as const).map((m) => ({ livemode: m === 'live', base_path: PATHS.deposits[m], xpub: k.xpub(PATHS.deposits[m]) })),
    platform_wallets: (['hot', 'gas'] as const).flatMap((kind) =>
      (['live', 'test'] as const).map((m) => ({ kind, livemode: m === 'live', derivation_path: PATHS[kind][m], address: k.address(PATHS[kind][m]) })),
    ),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write('Register these with `pnpm platform:register <file>` (server). Fund each gas wallet with a little native coin.\n');
  if (process.argv.includes('--show-mnemonic')) {
    process.stderr.write(`\nMNEMONIC (shown once; write it down offline, never store it digitally):\n${mnemonic}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
