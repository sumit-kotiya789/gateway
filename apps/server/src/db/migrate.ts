import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../common/db.js';

/** Applies pending migrations. Must run as the schema-owner role, never as the app role. */
export async function runMigrations(ownerUrl: string, migrationsFolder: string): Promise<void> {
  const { db, pool } = createDb(ownerUrl);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
