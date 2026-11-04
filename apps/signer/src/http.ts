// Minimal JSON-over-HTTP(S) POST for the signer's own outbound calls (OpenBao). No client library: node:http(s) only.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const TIMEOUT_MS = 10_000;
const MAX_BODY = 1024 * 1024;

export interface JsonResponse {
  status: number;
  /** Parsed body, or null when it is empty or not JSON. */
  json: unknown;
}

/** POSTs `body` as JSON. HTTPS verifies the server against `ca` when given, else the system roots (TLS 1.2+). */
export function postJson(url: URL, body: object, headers: Record<string, string> = {}, ca?: Buffer): Promise<JsonResponse> {
  const data = JSON.stringify(body);
  const tls = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (tls ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), ...headers },
        timeout: TIMEOUT_MS,
        ...(tls ? { ca, minVersion: 'TLSv1.2' as const } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error('response too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Not JSON (or empty, e.g. 204): callers only read bodies of successful calls.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}
