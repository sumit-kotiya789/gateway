// Signer HTTP interface (D-088). Two routes: GET /healthz and POST /v1/sign {kind, id}. Every sign request carries
// `x-signer-auth: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` keyed with SIGNER_HMAC_SECRET, within 60 seconds.
// Production also requires mTLS (main.ts). Errors never carry internals: a refusal code, or "internal error".
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Refusal, type Intent, type IntentKind, type Signed } from './signer.js';

const KINDS: readonly IntentKind[] = ['gas_topup', 'sweep', 'withdrawal', 'treasury'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 4096;
const TOLERANCE_S = 60;

export function authHeader(secret: string, body: string, nowS: number): string {
  return `t=${String(nowS)},v1=${createHmac('sha256', secret).update(`${String(nowS)}.${body}`).digest('hex')}`;
}

export function verifyAuth(secret: string, body: string, header: string | undefined, nowS: number): boolean {
  if (!header) return false;
  const parts = new Map(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = parts.get('t') ?? '';
  const v = parts.get('v1') ?? '';
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v) || Math.abs(nowS - Number(t)) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(v, 'hex'));
}

export function parseIntent(body: string): Intent | null {
  try {
    const v = JSON.parse(body) as { kind?: unknown; id?: unknown };
    if (typeof v.kind !== 'string' || !KINDS.includes(v.kind as IntentKind) || typeof v.id !== 'string' || !UUID.test(v.id)) return null;
    if (Object.keys(v).length !== 2) return null;
    return { kind: v.kind as IntentKind, id: v.id };
  } catch {
    return null;
  }
}

interface Log {
  info: (o: object, msg: string) => void;
  warn: (o: object, msg: string) => void;
  error: (o: object, msg: string) => void;
}

export function requestHandler(opts: { secret: string; sign: (i: Intent) => Promise<Signed>; log: Log; now?: () => number }) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const send = (res: ServerResponse, status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { status: 'ok' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/sign') {
      send(res, 404, { error: 'not_found' });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(res, 413, { error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers['x-signer-auth'];
      if (!verifyAuth(opts.secret, body, typeof auth === 'string' ? auth : undefined, now())) {
        opts.log.warn({ remote: req.socket.remoteAddress }, 'signer request refused: bad authentication');
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      const intent = parseIntent(body);
      if (!intent) {
        send(res, 400, { error: 'invalid_intent' });
        return;
      }
      opts.sign(intent).then(
        (signed) => {
          opts.log.info({ intent, tx_hash: signed.tx_hash, nonce: signed.nonce, reused: signed.reused }, 'signed');
          send(res, 200, signed);
        },
        (err: unknown) => {
          if (err instanceof Refusal) {
            opts.log.warn({ intent, code: err.code }, 'signer refused');
            send(res, 409, { error: err.code, message: err.message });
            return;
          }
          opts.log.error({ intent, err: (err as Error).message }, 'signer error');
          send(res, 500, { error: 'internal_error' });
        },
      );
    });
  };
}
