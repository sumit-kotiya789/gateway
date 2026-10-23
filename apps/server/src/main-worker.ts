// Worker process: BullMQ queues for background jobs. M3: invoice expiry, idempotency-key retention. M5: ledger reconciliation. Later: outbox dispatch, webhooks,
// reconciliation, sweeps. Every job handler is idempotent and safe to run on several workers at once.
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './common/config.js';
import { Envelope, LocalKek } from './common/crypto/envelope.js';
import { createDb } from './common/db.js';
import { createLogger } from './common/logger.js';
import type { Deps } from './deps.js';
import { purgeIdempotencyKeys } from './common/idempotency.js';
import { expireDueInvoices } from './modules/invoices/invoices.js';
import { reconcileLedger } from './modules/ledger/reconciliation.js';

const QUEUE = 'maintenance';
const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function runMaintenanceJob(deps: Deps, name: string): Promise<unknown> {
  switch (name) {
    case 'expire-invoices': {
      const expired = await expireDueInvoices(deps);
      if (expired.length > 0) deps.log.info({ count: expired.length }, 'invoices expired');
      return { expired: expired.length };
    }
    case 'reconcile-ledger': {
      const issues = await reconcileLedger(deps);
      return { ok: issues.length === 0, issues: issues.length };
    }
    case 'purge-idempotency-keys': {
      const purged = await purgeIdempotencyKeys(deps);
      return { purged };
    }
    default:
      throw new Error(`unknown maintenance job ${name}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const { db, pool } = createDb(config.DATABASE_URL);
  // BullMQ workers need blocking commands: no per-request retry limit on this connection.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const envelope = new Envelope([new LocalKek(config.DATA_KEK_ID, Buffer.from(config.DATA_KEK, 'base64'))]);
  const deps: Deps = { config, db, redis: connection, envelope, clock: Date.now, log };

  const queue = new Queue(QUEUE, { connection });
  // Idempotent: re-registering on every boot keeps exactly one schedule per job.
  const jobOpts = { removeOnComplete: 100, removeOnFail: 500 };
  await queue.upsertJobScheduler('expire-invoices', { every: 15_000 }, { name: 'expire-invoices', opts: jobOpts });
  await queue.upsertJobScheduler('reconcile-ledger', { every: 3_600_000 }, { name: 'reconcile-ledger', opts: jobOpts });
  await queue.upsertJobScheduler('purge-idempotency-keys', { every: 3_600_000 }, { name: 'purge-idempotency-keys', opts: jobOpts });

  const worker = new Worker(QUEUE, (job) => runMaintenanceJob(deps, job.name), { connection, concurrency: 1 });
  worker.on('failed', (job, err) => {
    log.error({ err, job: job?.name }, 'maintenance job failed');
  });
  log.info('worker started');

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'worker shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    // Let the in-flight job finish, then release connections.
    worker
      .close()
      .then(() => queue.close())
      .then(() => Promise.allSettled([pool.end(), connection.quit()]))
      .then(
        () => process.exit(0),
        (err: unknown) => {
          log.error({ err }, 'worker shutdown failed');
          process.exit(1);
        },
      );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && /main-worker\.(c?js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
