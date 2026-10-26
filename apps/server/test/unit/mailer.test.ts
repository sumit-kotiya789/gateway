import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/common/logger.js';
import { createMailer } from '../../src/modules/email/mailer.js';

const msg = { to: 'someone@example.test', subject: 'Reset your password', text: 'secret link https://x/#/reset?token=abc' };

describe('mailer', () => {
  it('without SMTP_URL drops the email and logs the subject only (no recipient, no body)', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    await createMailer({ SMTP_URL: undefined, EMAIL_FROM: 'G <g@x.test>' }, createLogger('warn', sink)).send(msg);
    const out = lines.join('');
    expect(out).toContain('Reset your password');
    expect(out).not.toContain('someone@example.test');
    expect(out).not.toContain('token=abc');
  });

  it('with SMTP_URL sends over SMTP; an unreachable relay rejects (the outbox retries)', async () => {
    const m = createMailer({ SMTP_URL: 'smtp://127.0.0.1:1', EMAIL_FROM: 'G <g@x.test>' }, createLogger('silent'));
    await expect(m.send(msg)).rejects.toMatchObject({ code: expect.any(String) });
  });
});
