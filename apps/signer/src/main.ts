// Signer process (M7b). Loads the seed once, then serves sign requests from the worker only.
import { readFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import pg from 'pg';
import { rpcFor } from './chain.js';
import { loadSignerConfig } from './config.js';
import { Keyring } from './keys.js';
import { LocalFileSeed } from './seed.js';
import { requestHandler } from './server.js';
import { createSigner } from './signer.js';

const log = {
  info: (o: object, msg: string) => process.stdout.write(`${JSON.stringify({ level: 'info', msg, ...o })}\n`),
  warn: (o: object, msg: string) => process.stdout.write(`${JSON.stringify({ level: 'warn', msg, ...o })}\n`),
  error: (o: object, msg: string) => process.stderr.write(`${JSON.stringify({ level: 'error', msg, ...o })}\n`),
};

async function main(): Promise<void> {
  const config = loadSignerConfig();
  /* v8 ignore next -- config refuses local-file without both values */
  if (!config.SIGNER_SEED_FILE || !config.SIGNER_SEED_KEK) throw new Error('seed source not configured');
  const keyring = new Keyring(await new LocalFileSeed(config.SIGNER_SEED_FILE, Buffer.from(config.SIGNER_SEED_KEK, 'base64')).load());
  const pool = new pg.Pool({ connectionString: config.SIGNER_DATABASE_URL, max: 5 });
  const signer = createSigner({ pool, keyring, config, rpcFor: (c) => rpcFor(c.rpc_urls, process.env) });
  const handler = requestHandler({ secret: config.SIGNER_HMAC_SECRET, sign: signer.sign, log });
  const server =
    config.SIGNER_TLS_CERT_FILE && config.SIGNER_TLS_KEY_FILE && config.SIGNER_TLS_CLIENT_CA_FILE
      ? createHttps(
          {
            cert: readFileSync(config.SIGNER_TLS_CERT_FILE),
            key: readFileSync(config.SIGNER_TLS_KEY_FILE),
            ca: readFileSync(config.SIGNER_TLS_CLIENT_CA_FILE),
            requestCert: true,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.3',
          },
          handler,
        )
      : createHttp(handler);
  const tls = Boolean(config.SIGNER_TLS_CERT_FILE);
  server.listen(config.SIGNER_PORT, config.SIGNER_HOST, () => {
    log.info({ host: config.SIGNER_HOST, port: config.SIGNER_PORT, tls }, 'signer listening');
  });
  const stop = () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'signer failed to start');
  process.exit(1);
});
