import { resolve } from 'node:path';
import { runMigrations } from '../db/migrate.js';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  process.stderr.write('DATABASE_MIGRATION_URL is required (schema-owner role)\n');
  process.exit(1);
}
const folder = resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');
runMigrations(url, folder).then(
  () => process.stdout.write('migrations applied\n'),
  (err: unknown) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
