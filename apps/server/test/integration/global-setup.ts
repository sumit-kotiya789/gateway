import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgOwnerUrl: string;
    pgAppUrl: string;
    redisUrl: string;
    anvilUrl: string;
  }
}

/**
 * Without Docker: point TEST_PG_URL (superuser, empty database), TEST_REDIS_URL and TEST_ANVIL_URL at services you run
 * yourself (tests that need Anvil fail without TEST_ANVIL_URL). Containers are used unless both PG and Redis are set.
 */
async function services() {
  const env = process.env;
  if (env.TEST_PG_URL && env.TEST_REDIS_URL) {
    return { ownerUrl: env.TEST_PG_URL, redisUrl: env.TEST_REDIS_URL, anvilUrl: env.TEST_ANVIL_URL ?? 'http://127.0.0.1:1', stop: async () => {} };
  }
  // Locals, not module state: each test project (integration, integration-global) runs this setup and owns its containers.
  const [pgc, rc, ac]: [StartedPostgreSqlContainer, StartedRedisContainer, StartedTestContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:8-alpine').start(),
    // Local EVM chain (chain id 31337), 1 block per transaction, standard test mnemonic.
    new GenericContainer('ghcr.io/foundry-rs/foundry:stable')
      .withEntrypoint(['anvil'])
      .withCommand(['--host', '0.0.0.0', '--chain-id', '31337'])
      .withExposedPorts(8545)
      .withWaitStrategy(Wait.forLogMessage(/Listening on/))
      .start(),
  ]);
  return {
    ownerUrl: pgc.getConnectionUri(),
    redisUrl: rc.getConnectionUrl(),
    anvilUrl: `http://${ac.getHost()}:${String(ac.getMappedPort(8545))}`,
    stop: async () => {
      await Promise.all([pgc.stop(), rc.stop(), ac.stop()]);
    },
  };
}

export default async function setup(project: TestProject) {
  const { ownerUrl, redisUrl, anvilUrl, stop } = await services();
  await runMigrations(ownerUrl, resolve(import.meta.dirname, '../../db/migrations'));

  // App connects as a non-owner LOGIN user in gw_app, exactly like production.
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  // Idempotent: with TEST_PG_URL both test projects set up the same database.
  await c.query(`DO $$ BEGIN CREATE ROLE gateway_app LOGIN PASSWORD 'app' IN ROLE gw_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  // New merchants start on every network here (production default: BNB Smart Chain, D-113): tests take live payments on
  // simulated mainnets, and the BSC row only exists once a test file seeds the registry. platform-settings.test.ts
  // covers the default itself.
  await c.query('update admin_settings set default_network = null');
  await c.end();
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'gateway_app';
  appUrl.password = 'app';

  project.provide('pgOwnerUrl', ownerUrl);
  project.provide('pgAppUrl', appUrl.toString());
  project.provide('redisUrl', redisUrl);
  project.provide('anvilUrl', anvilUrl);

  return stop;
}
