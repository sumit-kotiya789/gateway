// Sends email over SMTP (nodemailer). Without SMTP_URL (dev/test only; production config refuses it) it logs the
// recipient-free fact that an email was dropped, so no link or address ends up in logs.
import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Config } from '../../common/config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

export function createMailer(config: Pick<Config, 'SMTP_URL' | 'EMAIL_FROM'>, log: Logger): Mailer {
  const url = config.SMTP_URL;
  if (!url) {
    return {
      send: async (m) => {
        log.warn({ subject: m.subject }, 'SMTP_URL not set: email dropped');
      },
    };
  }
  const transport = nodemailer.createTransport(url);
  return {
    send: async (m) => {
      await transport.sendMail({ from: config.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
