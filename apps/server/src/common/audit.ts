import type { FastifyRequest } from 'fastify';
import { auditLogs } from '../db/schema.js';
import type { Tx } from './db.js';
import { redact } from './logger.js';

export type ActorType = 'merchant_user' | 'admin' | 'api_key' | 'system' | 'anonymous';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  merchantId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

/** Appends to the hash-chained audit log inside the caller's transaction (commits or rolls back with the action). */
export async function audit(tx: Tx, entry: AuditEntry, req?: FastifyRequest): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    merchantId: entry.merchantId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    // Same redaction as logs: secrets never enter the audit trail.
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    ip: req?.ip ?? null,
    userAgent: req?.headers['user-agent']?.slice(0, 512) ?? null,
    requestId: req?.id ?? null,
  });
}
