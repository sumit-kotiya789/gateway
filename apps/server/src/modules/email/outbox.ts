// Email outbox (M10). enqueueEmail writes an encrypted row in the caller's transaction (an email exists iff the action
// committed); the worker leases due rows, sends them, then erases the payload. At-least-once, like webhooks (D-070).
import { uuidv7 } from '@gw/core';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { withSystem, type Tx } from '../../common/db.js';
import { emailOutbox, merchantUsers } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import type { EmailMessage, Mailer } from './mailer.js';
import type { Rendered } from './templates.js';

export const EMAIL_MAX_ATTEMPTS = 8;
/** Delay after attempt n (1-based): 1 min .. 12 h; ~1 day in total before giving up. */
const BACKOFF_S = [60, 300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
/** A claimed row is retried after this long if its worker died mid-send. */
const LEASE_MS = 120_000;

const aad = (id: string) => `email_outbox:${id}`;

export async function enqueueEmail(deps: Deps, tx: Tx, e: { merchantId: string | null; kind: string; to: string } & Rendered): Promise<void> {
  const id = uuidv7();
  const payload: EmailMessage = { to: e.to, subject: e.subject, text: e.text };
  const payloadEnc = await deps.envelope.seal(JSON.stringify(payload), aad(id));
  // Due "now" by the app clock, which is what the worker compares against.
  await tx.insert(emailOutbox).values({ id, merchantId: e.merchantId, kind: e.kind, payloadEnc, nextAttemptAt: new Date(deps.clock()) });
}

/** One email to every owner of the merchant (security and billing notices). */
export async function notifyOwners(deps: Deps, tx: Tx, merchantId: string, kind: string, msg: Rendered): Promise<void> {
  const owners = await tx
    .select({ email: merchantUsers.email })
    .from(merchantUsers)
    .where(and(eq(merchantUsers.merchantId, merchantId), eq(merchantUsers.role, 'owner')));
  for (const o of owners) await enqueueEmail(deps, tx, { merchantId, kind, to: o.email, ...msg });
}

/** Worker job: sends due emails. Safe on several workers (SKIP LOCKED claim + lease). */
export async function deliverDueEmails(deps: Deps, mailer: Mailer, batch = 20): Promise<{ sent: number; failed: number }> {
  const now = deps.clock();
  const claimed = await withSystem(deps.db, async (tx) => {
    const rows = await tx
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, new Date(now))))
      .orderBy(asc(emailOutbox.nextAttemptAt))
      .limit(batch)
      .for('update', { skipLocked: true });
    if (rows.length > 0) {
      await tx.update(emailOutbox).set({ nextAttemptAt: new Date(now + LEASE_MS) }).where(inArray(emailOutbox.id, rows.map((r) => r.id)));
    }
    return rows;
  });
  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    const attempts = row.attempts + 1;
    try {
      /* v8 ignore next -- invariant: pending rows carry a payload (CHECK email_outbox_payload) */
      if (!row.payloadEnc) throw new Error('pending email without payload');
      const msg = JSON.parse(await deps.envelope.open(row.payloadEnc, aad(row.id))) as EmailMessage;
      await mailer.send(msg);
      await withSystem(deps.db, (tx) =>
        tx.update(emailOutbox).set({ status: 'sent', payloadEnc: null, attempts, sentAt: new Date(deps.clock()), lastError: null }).where(eq(emailOutbox.id, row.id)),
      );
      sent++;
    } catch (err) {
      // Error code/name only: SMTP messages can contain the recipient address.
      const e = err as { code?: unknown; name?: unknown };
      const lastError = (typeof e.code === 'string' ? e.code : typeof e.name === 'string' ? e.name : 'error').slice(0, 100);
      const final = attempts >= EMAIL_MAX_ATTEMPTS;
      const delayS = BACKOFF_S[Math.min(attempts, BACKOFF_S.length) - 1] ?? 3600;
      await withSystem(deps.db, (tx) =>
        tx
          .update(emailOutbox)
          .set(final ? { status: 'failed', payloadEnc: null, attempts, lastError } : { attempts, lastError, nextAttemptAt: new Date(deps.clock() + delayS * 1000) })
          .where(eq(emailOutbox.id, row.id)),
      );
      deps.log.warn({ emailId: row.id, kind: row.kind, attempts, lastError, final }, 'email delivery failed');
      failed++;
    }
  }
  return { sent, failed };
}
