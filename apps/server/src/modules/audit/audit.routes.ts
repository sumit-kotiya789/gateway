import { AppError } from '@gw/core';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant } from '../../common/db.js';
import { auditLogs } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requirePermission, requireUser } from '../auth/guards.js';

export function auditDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      {
        preHandler: [requireUser(deps), requirePermission('audit:read')],
        schema: {
          querystring: z.strictObject({
            limit: z.coerce.number().int().min(1).max(100).default(50),
            starting_after: z.string().regex(/^\d{1,19}$/).optional(),
          }),
        },
      },
      async (req) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const { limit, starting_after } = req.query;
        const rows = await withTenant(deps.db, user.merchantId, (tx) =>
          tx
            .select()
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.merchantId, user.merchantId),
                // Platform admin actions are internal (reasons may be confidential, D-065); merchants see their effects.
                ne(auditLogs.actorType, 'admin'),
                starting_after === undefined ? undefined : lt(auditLogs.seq, BigInt(starting_after)),
              ),
            )
            .orderBy(desc(auditLogs.seq))
            .limit(limit + 1),
        );
        const page = rows.slice(0, limit);
        return {
          data: page.map((r) => ({
            seq: r.seq.toString(),
            at: r.at,
            actor_type: r.actorType,
            actor_id: r.actorId,
            action: r.action,
            target_type: r.targetType,
            target_id: r.targetId,
            ip: r.ip,
            after: r.after,
            hash: r.hash.toString('hex'),
          })),
          has_more: rows.length > limit,
          next_cursor: rows.length > limit ? page.at(-1)?.seq.toString() : null,
        };
      },
    );
  };
}
