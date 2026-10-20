import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './common/config.js';
import { Envelope, LocalKek } from './common/crypto/envelope.js';
import { createDb } from './common/db.js';
import { createLogger } from './common/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', (err: unknown) => {
    logger.warn({ err }, 'redis error');
  });
  const envelope = new Envelope([new LocalKek(config.DATA_KEK_ID, Buffer.from(config.DATA_KEK, 'base64'))]);
  const app = buildApp(logger, { config, db, redis, envelope, clock: Date.now });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    app
      .close()
      .then(() => Promise.allSettled([pool.end(), redis.quit()]))
      .then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  // Logger may not exist yet (config failure). Config errors carry key names only.
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
