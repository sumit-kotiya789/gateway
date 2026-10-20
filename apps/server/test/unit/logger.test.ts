import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../src/common/logger.js';

describe('redact', () => {
  it('redacts secret-named keys at any depth', () => {
    const out = redact({
      password: 'p',
      nested: { apiKey: 'k', private_key: 'pk', deeper: [{ mnemonic: 'm', ok: 1 }] },
      headers: { authorization: 'Bearer x', cookie: 'c' },
      webhookSecret: 's',
      totpSecret: 't',
    });
    const s = JSON.stringify(out);
    for (const v of ['"p"', '"k"', '"pk"', '"m"', 'Bearer x', '"c"', '"s"', '"t"']) expect(s).not.toContain(v);
    expect(s).toContain('"ok":1');
  });

  it('redacts API keys and extended private keys by value', () => {
    const xprv =
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
    const s = JSON.stringify(redact({ msg: `key sk_live_ABCdef123 and ${xprv} and pk_test_zz` }));
    expect(s).not.toContain('ABCdef123');
    expect(s).not.toContain(xprv);
    expect(s).not.toContain('pk_test_zz');
  });

  it('keeps tx hashes (hex is not value-redacted)', () => {
    const h = `0x${'ab'.repeat(32)}`;
    expect(redact({ txHash: h })).toEqual({ txHash: h });
  });

  it('truncates very deep structures', () => {
    let o: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) o = { child: o };
    expect(JSON.stringify(redact(o))).toContain('[TRUNCATED]');
  });

  it('passes class instances through untouched for pino serializers', () => {
    class Req {
      method = 'GET';
    }
    const r = new Req();
    expect((redact({ req: r }) as { req: unknown }).req).toBe(r);
  });

  it('serializes errors with redacted message', () => {
    const out = redact({ err: new Error('bad sk_test_SECRET') }) as { err: { message: string } };
    expect(out.err.message).not.toContain('SECRET');
  });
});

describe('createLogger', () => {
  it('applies redaction to emitted lines including message strings', async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger('info', dest);
    log.info({ user: { password: 'hunter2' } }, 'login with sk_live_LEAKED');
    await new Promise((r) => setImmediate(r));
    const out = lines.join('');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('LEAKED');
    expect(JSON.parse(out).level).toBe('info');
  });
});
