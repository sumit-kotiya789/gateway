// `pnpm chains:verify`: every enabled chain's RPCs report the right network id and every enabled token's on-chain
// decimals() matches config. Exits non-zero on any problem. The watcher runs the same check at boot (M4).
import { createDb, withSystem } from '../common/db.js';
import { loadRegistry, verifyRegistry } from '../modules/registry/registry.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
const { db, pool } = createDb(url);
withSystem(db, (tx) => loadRegistry(tx))
  .then((reg) => verifyRegistry(reg, process.env))
  .then((problems) => {
    if (problems.length > 0) {
      process.stderr.write(`registry verification FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('registry verified: network ids and token decimals match\n');
    }
  })
  .catch((err: unknown) => {
    process.stderr.write(`verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
