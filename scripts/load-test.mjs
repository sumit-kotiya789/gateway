// Load test (M11): creates invoices at a fixed concurrency and reports throughput, latency percentiles and errors.
// Staging only, with TEST-mode keys (every invoice uses a derivation index). Each key is rate limited (300/min), so
// pass several keys to measure the server rather than the limiter; 429s are counted separately.
//
//   API_URL=https://staging.example.com API_KEYS=sk_test_a,sk_test_b CONCURRENCY=20 DURATION_S=60 \
//     node scripts/load-test.mjs
import { randomUUID } from 'node:crypto';

const url = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const keys = (process.env.API_KEYS ?? '').split(',').filter(Boolean);
const concurrency = Number(process.env.CONCURRENCY ?? 10);
const durationMs = Number(process.env.DURATION_S ?? 30) * 1000;
const token = process.env.TOKEN ?? 'evm-local:usdt';
if (keys.length === 0) throw new Error('set API_KEYS (comma-separated test-mode secret keys)');

const latencies = [];
const statuses = new Map();
let sent = 0;
const end = Date.now() + durationMs;

async function worker(n) {
  while (Date.now() < end) {
    const key = keys[sent++ % keys.length];
    const t0 = performance.now();
    let status;
    try {
      const r = await fetch(`${url}/v1/invoices`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ amount: '1.5', token, metadata: { load_test: String(n) } }),
      });
      await r.arrayBuffer();
      status = String(r.status);
    } catch (err) {
      status = `error:${err?.cause?.code ?? err?.name ?? 'unknown'}`;
    }
    if (status === '201') latencies.push(performance.now() - t0);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
latencies.sort((a, b) => a - b);
const pct = (p) => (latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]) : '-');
const ok = statuses.get('201') ?? 0;
process.stdout.write(
  `${JSON.stringify(
    {
      concurrency,
      duration_s: durationMs / 1000,
      requests: sent,
      created_per_s: Math.round((ok / (durationMs / 1000)) * 10) / 10,
      latency_ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: pct(100) },
      statuses: Object.fromEntries(statuses),
    },
    null,
    2,
  )}\n`,
);
// Non-zero exit when anything other than 201/429 came back: usable as a CI/staging gate.
process.exit([...statuses.keys()].some((s) => s !== '201' && s !== '429') ? 1 : 0);
