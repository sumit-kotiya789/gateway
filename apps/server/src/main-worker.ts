// Worker process: BullMQ queues for background jobs. `maintenance`: invoice expiry, retention purges, ledger reconciliation,
// xpub changes whose cooldown elapsed.
// `webhooks`: outbound delivery, on its own queue so slow merchant endpoints never delay maintenance. `emails`: the email
// outbox (M10), likewise separate from a slow SMTP server. `custody`: sweeps and withdrawals (M7), only with
// FEATURE_CUSTODIAL.
// Every job handler is idempotent and safe to run on several workers at once.
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
import { BATCH, deliverDueWebhooks, purgeWebhookDeliveries } from './modules/webhooks/delivery.js';
import { applyDueXpubChanges } from './modules/xpubs/xpubs.js';
import { deliverDueEmails } from './modules/email/outbox.js';
import { createMailer, type Mailer } from './modules/email/mailer.js';
import { chainTxFor } from './modules/custody/chain-tx.js';
import { createSignerClient } from './modules/custody/signer-client.js';
import { advanceWithdrawals } from './modules/custody/payouts.js';
import { advanceTreasury } from './modules/custody/treasury.js';
import { advanceSweeps, planSweeps, type SweeperEnv } from './modules/custody/sweeper.js';

const QUEUE = 'maintenance';
const WEBHOOK_QUEUE = 'webhooks';
const EMAIL_QUEUE = 'emails';
const CUSTODY_QUEUE = 'custody';
const EMAIL_BATCHES_PER_JOB = 5;
/** Batches per delivery job: drains a backlog faster than one batch per tick, still yields between jobs. */
const WEBHOOK_BATCHES_PER_JOB = 10;
const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function runMaintenanceJob(deps: Deps, name: string): Promise<unknown> {
  switch (name) {
    case 'expire-invoices': {
      const expired = await expireDueInvoices(deps);
      if (expired.length > 0) deps.log.info({ count: expired.length }, 'invoices expired');
      return { expired: expired.length };
    }
    case 'reconcile-ledger': {
      // Custodial: also compare the hot wallets' on-chain balances with the ledger.
      const issues = await reconcileLedger(deps, deps.config.FEATURE_CUSTODIAL ? { chainTx: (c) => chainTxFor(c.rpcUrls) } : {});
      return { ok: issues.length === 0, issues: issues.length };
    }
    case 'purge-idempotency-keys': {
      const purged = await purgeIdempotencyKeys(deps);
      return { purged };
    }
    case 'apply-xpub-changes': {
      const r = await applyDueXpubChanges(deps);
      if (r.applied + r.failed > 0) deps.log.info(r, 'xpub changes processed');
      return r;
    }
    case 'purge-webhook-deliveries': {
      const purged = await purgeWebhookDeliveries(deps);
      return { purged };
    }
    default:
      throw new Error(`unknown maintenance job ${name}`);
  }
}

export async function runWebhookJob(deps: Deps): Promise<{ sent: number }> {
  let sent = 0;
  for (let i = 0; i < WEBHOOK_BATCHES_PER_JOB; i++) {
    const n = await deliverDueWebhooks(deps);
    sent += n;
    if (n < BATCH) break;
  }
  return { sent };
}

export async function runEmailJob(deps: Deps, mailer: Mailer): Promise<{ sent: number; failed: number }> {
  const total = { sent: 0, failed: 0 };
  for (let i = 0; i < EMAIL_BATCHES_PER_JOB; i++) {
    const r = await deliverDueEmails(deps, mailer);
    total.sent += r.sent;
    total.failed += r.failed;
    if (r.sent + r.failed === 0) break;
  }
  return total;
}

/** Plans new sweeps, then moves due sweeps, withdrawals and treasury transfers one step forward. */
export async function runCustodyJob(deps: Deps, env: SweeperEnv): Promise<Record<string, unknown>> {
  const planned = await planSweeps(deps);
  return { planned, sweeps: await advanceSweeps(deps, env), withdrawals: await advanceWithdrawals(deps, env), treasury: await advanceTreasury(deps, env) };
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
  await queue.upsertJobScheduler('apply-xpub-changes', { every: 60_000 }, { name: 'apply-xpub-changes', opts: jobOpts });
  await queue.upsertJobScheduler('purge-webhook-deliveries', { every: 86_400_000 }, { name: 'purge-webhook-deliveries', opts: jobOpts });
  const webhookQueue = new Queue(WEBHOOK_QUEUE, { connection });
  await webhookQueue.upsertJobScheduler('deliver-webhooks', { every: 5_000 }, { name: 'deliver-webhooks', opts: jobOpts });
  const emailQueue = new Queue(EMAIL_QUEUE, { connection });
  await emailQueue.upsertJobScheduler('send-emails', { every: 5_000 }, { name: 'send-emails', opts: jobOpts });
  const mailer = createMailer(config, log);

  const worker = new Worker(QUEUE, (job) => runMaintenanceJob(deps, job.name), { connection, concurrency: 1 });
  worker.on('failed', (job, err) => {
    log.error({ err, job: job?.name }, 'maintenance job failed');
  });
  const webhookWorker = new Worker(WEBHOOK_QUEUE, () => runWebhookJob(deps), { connection, concurrency: 1 });
  webhookWorker.on('failed', (_job, err) => {
    log.error({ err }, 'webhook delivery job failed');
  });
  const emailWorker = new Worker(EMAIL_QUEUE, () => runEmailJob(deps, mailer), { connection, concurrency: 1 });
  emailWorker.on('failed', (_job, err) => {
    log.error({ err }, 'email delivery job failed');
  });
  const closers: { close: () => Promise<void> }[] = [];
  if (config.FEATURE_CUSTODIAL) {
    const custodyQueue = new Queue(CUSTODY_QUEUE, { connection });
    await custodyQueue.upsertJobScheduler('sweeps', { every: 15_000 }, { name: 'sweeps', opts: jobOpts });
    const env: SweeperEnv = { signer: createSignerClient(config), chainTx: (c) => chainTxFor(c.rpcUrls) };
    const custodyWorker = new Worker(CUSTODY_QUEUE, () => runCustodyJob(deps, env), { connection, concurrency: 1 });
    custodyWorker.on('failed', (_job, err) => {
      log.error({ err }, 'custody job failed');
    });
    closers.push(custodyWorker, custodyQueue);
  }
  log.info('worker started');

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'worker shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    // Let the in-flight job finish, then release connections.
    Promise.all([worker.close(), webhookWorker.close(), emailWorker.close(), ...closers.map((c) => c.close())])
      .then(() => Promise.all([queue.close(), webhookQueue.close(), emailQueue.close()]))
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
