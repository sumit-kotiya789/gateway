// Worker side of the signer (M7, D-088): sends intents, never transactions. HMAC on every body; mTLS when configured
// (required in production).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Config } from '../../common/config.js';

export type IntentKind = 'gas_topup' | 'sweep' | 'withdrawal' | 'treasury';

export interface SignedTx {
  tx_hash: string;
  raw_tx: string;
  from: string;
  to: string;
  nonce: string;
  reused: boolean;
}

export type SignResult = { ok: true; tx: SignedTx } | { ok: false; code: string; message: string };

export interface SignerClient {
  sign(kind: IntentKind, id: string): Promise<SignResult>;
}

export function createSignerClient(config: Config): SignerClient {
  const url = config.SIGNER_URL;
  const secret = config.SIGNER_HMAC_SECRET;
  if (!url || !secret) throw new Error('SIGNER_URL and SIGNER_HMAC_SECRET are required for custodial operations');
  const target = new URL('/v1/sign', url);
  const tls =
    config.SIGNER_CLIENT_CERT_FILE && config.SIGNER_CLIENT_KEY_FILE && config.SIGNER_CA_FILE
      ? { cert: readFileSync(config.SIGNER_CLIENT_CERT_FILE), key: readFileSync(config.SIGNER_CLIENT_KEY_FILE), ca: readFileSync(config.SIGNER_CA_FILE), minVersion: 'TLSv1.3' as const }
      : {};
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return {
    sign: (kind, id) =>
      new Promise<SignResult>((resolve, reject) => {
        const body = JSON.stringify({ kind, id });
        const t = Math.floor(Date.now() / 1000);
        const auth = `t=${String(t)},v1=${createHmac('sha256', secret).update(`${String(t)}.${body}`).digest('hex')}`;
        const req = send(
          target,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-signer-auth': auth }, timeout: 15_000, ...tls },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              let data: { error?: string; message?: string } = {};
              try {
                data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof data;
              } catch {
                // fall through with an empty body
              }
              if (res.statusCode === 200) resolve({ ok: true, tx: data as unknown as SignedTx });
              else if (res.statusCode === 409) resolve({ ok: false, code: data.error ?? 'refused', message: data.message ?? '' });
              else reject(new Error(`signer answered HTTP ${String(res.statusCode)}`));
            });
          },
        );
        req.on('timeout', () => req.destroy(new Error('signer timeout')));
        req.on('error', reject);
        req.end(body);
      }),
  };
}
