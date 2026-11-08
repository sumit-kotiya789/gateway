// Permanent deposit addresses per user (D-101): the merchant API (a web3 project's backend asks for its user's
// address) and the dashboard (lists). The project credits its user when a deposit invoice settles
// (`invoice.settled` with `kind: deposit` and the user's `customer_ref`).
import { AppError } from '@gw/core';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant } from '../../common/db.js';
import { depositAddresses, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { accountView, getDepositAccount, listDepositAccounts, openDepositAccount } from './deposit-accounts.js';

const CustomerRef = z.string().trim().min(1).max(200);
const TokenId = z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/);
const IdParams = z.strictObject({ id: z.uuid() });
const ListQuery = { customer_ref: CustomerRef.optional(), starting_after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) };

export function depositAccountRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    /** The user's deposit address for a token: existing (200) or new (201). Same user + token = same address. */
    app.post(
      '/deposit-accounts',
      { preHandler: requireApiKey(deps, 'invoices:write'), schema: { body: z.strictObject({ customer_ref: CustomerRef, token: TokenId }) } },
      async (req, reply) => {
        const k = req.apiKey;
        if (!k) throw new AppError('unauthorized', 'API key required');
        const out = await withTenant(deps.db, k.merchantId, async (tx) => {
          const { account, created } = await openDepositAccount(deps, tx, { merchantId: k.merchantId, livemode: k.livemode, customerRef: req.body.customer_ref, tokenId: req.body.token });
          const [a] = await tx.select({ address: depositAddresses.address }).from(depositAddresses).where(eq(depositAddresses.id, account.depositAddressId));
          const [t] = await tx.select({ decimals: tokens.decimals, symbol: tokens.symbol }).from(tokens).where(eq(tokens.id, account.tokenId));
          /* v8 ignore next -- foreign keys */
          if (!a || !t) throw new Error('deposit account address or token missing');
          if (created) {
            await audit(tx, { actorType: 'api_key', actorId: k.id, merchantId: k.merchantId, action: 'deposit_account.created', targetType: 'deposit_account', targetId: account.id, after: { customer_ref: account.customerRef, asset: account.tokenId, address: a.address } }, req);
          }
          return { created, view: accountView(account, a.address, t, 0n) };
        });
        return reply.status(out.created ? 201 : 200).send(out.view);
      },
    );

    app.get('/deposit-accounts', { preHandler: requireApiKey(deps, 'read'), schema: { querystring: z.strictObject(ListQuery) } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const q = req.query;
      return withTenant(deps.db, k.merchantId, (tx) =>
        listDepositAccounts(tx, k.merchantId, k.livemode, { limit: q.limit, ...(q.customer_ref ? { customerRef: q.customer_ref } : {}), ...(q.starting_after ? { startingAfter: q.starting_after } : {}) }),
      );
    });

    app.get('/deposit-accounts/:id', { preHandler: requireApiKey(deps, 'read'), schema: { params: IdParams } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, (tx) => getDepositAccount(tx, k.merchantId, k.livemode, req.params.id));
    });
  };
}

export function depositAccountDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  const Mode = { livemode: z.stringbool().default(false) };
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('invoices:read'), schema: { querystring: z.strictObject({ ...ListQuery, ...Mode }) } }, async (req) => {
      const u = authedUser(req);
      const q = req.query;
      return withTenant(deps.db, u.merchantId, (tx) =>
        listDepositAccounts(tx, u.merchantId, q.livemode, { limit: q.limit, ...(q.customer_ref ? { customerRef: q.customer_ref } : {}), ...(q.starting_after ? { startingAfter: q.starting_after } : {}) }),
      );
    });

    app.get('/:id', { preHandler: requirePermission('invoices:read'), schema: { params: IdParams, querystring: z.strictObject(Mode) } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, (tx) => getDepositAccount(tx, u.merchantId, req.query.livemode, req.params.id));
    });
  };
}
