import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgOwnerUrl: string;
    pgAppUrl: string;
    redisUrl: string;
  }
}

let pgc: StartedPostgreSqlContainer | undefined;
let rc: StartedRedisContainer | undefined;

export default async function setup(project: TestProject) {
  [pgc, rc] = await Promise.all([new PostgreSqlContainer('postgres:17-alpine').start(), new RedisContainer('redis:7-alpine').start()]);
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

  return async () => {
    await Promise.all([pgc?.stop(), rc?.stop()]);
  };
}
