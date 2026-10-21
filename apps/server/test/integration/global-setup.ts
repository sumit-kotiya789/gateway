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

let pgc: StartedPostgreSqlContainer | undefined;
let rc: StartedRedisContainer | undefined;
let ac: StartedTestContainer | undefined;

export default async function setup(project: TestProject) {
  [pgc, rc, ac] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
    // Local EVM chain (chain id 31337), 1 block per transaction, standard test mnemonic.
    new GenericContainer('ghcr.io/foundry-rs/foundry:stable')
      .withEntrypoint(['anvil'])
      .withCommand(['--host', '0.0.0.0', '--chain-id', '31337'])
      .withExposedPorts(8545)
      .withWaitStrategy(Wait.forLogMessage(/Listening on/))
      .start(),
  ]);
  const ownerUrl = pgc.getConnectionUri();
  await runMigrations(ownerUrl, resolve(import.meta.dirname, '../../db/migrations'));

  // App connects as a non-owner LOGIN user in gw_app, exactly like production.
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  await c.query(`CREATE ROLE gateway_app LOGIN PASSWORD 'app' IN ROLE gw_app`);
  await c.end();
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'gateway_app';
  appUrl.password = 'app';

  project.provide('pgOwnerUrl', ownerUrl);
  project.provide('pgAppUrl', appUrl.toString());
  project.provide('redisUrl', rc.getConnectionUrl());
  project.provide('anvilUrl', `http://${ac.getHost()}:${String(ac.getMappedPort(8545))}`);

  return async () => {
    await Promise.all([pgc?.stop(), rc?.stop(), ac?.stop()]);
  };
}
