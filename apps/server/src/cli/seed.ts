// `pnpm db:seed`: idempotent registry seed (chains + tokens). Safe to re-run.
import { createDb, withSystem } from '../common/db.js';
import { seedRegistry } from '../db/seed-registry.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
const { db, pool } = createDb(url);
withSystem(db, (tx) => seedRegistry(tx, process.env))
  .then((n) => process.stdout.write(`registry seeded: ${String(n.chains)} chains, ${String(n.tokens)} tokens\n`))
  .catch((err: unknown) => {
    process.stderr.write(`seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
