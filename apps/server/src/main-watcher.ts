// Watcher process: one scan loop per enabled chain, leader-elected per chain (several watcher processes may run).
// Registry changes (chains/tokens enabled or disabled) take effect on restart.
import type { ChainConfig, TokenConfig } from '@gw/core';
import { adapterFor, resolveRpcUrls } from '@gw/chains';
import { loadConfig } from './common/config.js';
import { Envelope, LocalKek } from './common/crypto/envelope.js';
import { createDb, withSystem } from './common/db.js';
import { createLogger } from './common/logger.js';
import type { Deps } from './deps.js';
import { loadRegistry, verifyRegistry } from './modules/registry/registry.js';
import { AdvisoryLock } from './modules/watcher/leader.js';
import { FencedError, becomeLeader, scanTick } from './modules/watcher/scanner.js';

const STANDBY_MS = 5_000;
const VERIFY_RETRY_MS = 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export async function runChain(deps: Deps, chain: ChainConfig, tokens: TokenConfig[], env: Record<string, string | undefined>, signal: AbortSignal) {
  const log = deps.log.child({ chain: chain.id });
  // Same pre-flight as `pnpm chains:verify`: never scan a chain whose RPC reports another network or wrong decimals.
  for (;;) {
    const problems = await verifyRegistry({ chains: [chain], tokens }, env);
    if (problems.length === 0) break;
    log.error({ problems }, 'registry verification failed; not scanning');
    await sleep(VERIFY_RETRY_MS, signal);
    if (signal.aborted) return;
  }
  const adapter = adapterFor(chain, resolveRpcUrls(chain.rpcUrls, env).urls);
  const lock = new AdvisoryLock(deps.config.DATABASE_URL, `watcher:${chain.id}`);
  let epoch: number | null = null;

  while (!signal.aborted) {
    try {
      if (epoch === null) {
        if (!(await lock.acquire())) {
          await sleep(STANDBY_MS, signal);
          continue;
        }
        epoch = await becomeLeader(deps, adapter, chain);
        log.info({ epoch }, 'leading chain scanner');
      } else if (!(await lock.held())) {
        log.warn('lost leader lock');
        epoch = null;
        continue;
      }
      const r = await scanTick({ deps, adapter, chain, tokens, epoch });
      const lag = r.latest - r.to;
      if (lag > BigInt(chain.reorgDepth)) log.warn({ lag: lag.toString() }, 'scanner behind chain head');
      if (r.found > 0 || r.decisions > 0) log.info({ to: r.to.toString(), found: r.found, decisions: r.decisions }, 'scan tick');
    } catch (err) {
      if (err instanceof FencedError) {
        log.warn('fenced out by a newer leader');
        epoch = null;
        await lock.release();
      } else {
        log.error({ err }, 'scan tick failed');
      }
    }
    await sleep(chain.blockTimeMs, signal);
  }
  await lock.release();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const { db, pool } = createDb(config.DATABASE_URL);
  const envelope = new Envelope([new LocalKek(config.DATA_KEK_ID, Buffer.from(config.DATA_KEK, 'base64'))]);
  const deps: Deps = { config, db, redis: null, envelope, clock: Date.now, log };

  const reg = await withSystem(db, (tx) => loadRegistry(tx));
  const chains = reg.chains.filter((c) => c.enabled);
  if (chains.length === 0) log.warn('no enabled chains; watcher idle');
  const stop = new AbortController();
  const loops = chains.map((c) =>
    runChain(deps, c, reg.tokens.filter((t) => t.enabled && t.chainId === c.id), process.env, stop.signal),
  );
  log.info({ chains: chains.map((c) => c.id) }, 'watcher started');

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'watcher shutting down');
    setTimeout(() => process.exit(1), 30_000).unref();
    stop.abort();
    void Promise.allSettled(loops)
      .then(() => pool.end())
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await Promise.all(loops);
}

if (process.argv[1] && /main-watcher\.(c?js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
