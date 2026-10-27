import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { AppError, type ErrorBody, type ErrorCode } from '@gw/core';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { pgCode } from './common/db.js';
import type { Deps } from './deps.js';
import { accountRoutes, apiKeyDashboardRoutes } from './modules/api-keys/api-keys.routes.js';
import { apiKeyPrefixFromHeader } from './modules/api-keys/api-keys.js';
import { auditDashboardRoutes } from './modules/audit/audit.routes.js';
import { registryDashboardRoutes, registryRoutes } from './modules/registry/registry.routes.js';
import { checkoutRoutes } from './modules/checkout/checkout.routes.js';
import { invoiceDashboardRoutes, invoiceRoutes } from './modules/invoices/invoices.routes.js';
import { feeTopupDashboardRoutes, ledgerDashboardRoutes, ledgerRoutes } from './modules/ledger/ledger.routes.js';
import { custodyAdminRoutes } from './modules/custody/custody.routes.js';
import { HttpMetrics, metricsRoutes } from './modules/metrics/metrics.js';
import { withdrawalAdminRoutes, withdrawalDashboardRoutes, withdrawalRoutes } from './modules/withdrawals/withdrawals.routes.js';
import { webhookDashboardRoutes } from './modules/webhooks/webhooks.routes.js';
import { xpubDashboardRoutes } from './modules/xpubs/xpubs.routes.js';
import { inviteAuthRoutes, teamDashboardRoutes } from './modules/team/team.routes.js';
import { exportDashboardRoutes, exportRoutes } from './modules/exports/exports.routes.js';
import { settingsDashboardRoutes } from './modules/settings/settings.routes.js';
import { paymentLinkRoutes, publicPayRoutes } from './modules/payment-links/payment-links.routes.js';
import { adminUserRoutes } from './modules/admin/admins.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { adminAuthRoutes } from './modules/auth/admin-auth.routes.js';
import { dashboardAuthRoutes } from './modules/auth/dashboard-auth.routes.js';
import { requireAdminNetwork } from './modules/auth/guards.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

function body(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }), request_id: requestId } };
}

/** Postgres error code, looking through driver/ORM wrappers. */
/** `deps` omitted = bare app (health + error model only), used by unit tests. */
export function buildApp(logger: FastifyBaseLogger, deps?: Deps) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 100 * 1024,
    trustProxy: (_addr: string, hop: number) => hop < (deps?.config.TRUST_PROXY_HOPS ?? 0),
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);
  app.decorateRequest('admin', null);
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  void app.register(helmet);
  void app.register(cookie);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(body(err.code, err.message, req.id, err.details));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({ path: v.instancePath.replace(/^\//, '').replace(/\//g, '.'), message: v.message }));
      return reply.status(400).send(body('validation_error', 'invalid request', req.id, details));
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
      return reply.status(400).send(body('validation_error', 'invalid request', req.id, details));
    }
    if (pgCode(err) === '23505') {
      return reply.status(409).send(body('conflict', 'resource already exists', req.id));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastify framework errors (bad JSON, body too large, rate limit): messages are safe.
      const code: ErrorCode = status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : 'validation_error';
      return reply.status(status).send(body(code, (err as Error).message, req.id));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('internal_error', 'internal error', req.id));
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send(body('not_found', 'route not found', req.id)));

  app.get('/healthz', { schema: { hide: true } }, () => ({ status: 'ok' }));

  if (!deps) return app;

  const http = new HttpMetrics();
  app.addHook('onResponse', async (req, reply) => {
    http.observe(req.method, req.routeOptions.url, reply.statusCode, reply.elapsedTime / 1000);
  });
  void app.register(metricsRoutes(deps, http));

  void app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    nameSpace: 'gw-rl:',
    ...(deps.redis ? { redis: deps.redis } : {}),
    // Redis outage must not take the API down; credential brute force is still stopped by DB lockout.
    skipOnError: true,
    keyGenerator: (req) => apiKeyPrefixFromHeader(req) ?? req.ip,
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, message: `rate limit exceeded, retry in ${ctx.after}` }),
  });

  void app.register(swagger, {
    openapi: { openapi: '3.1.0', info: { title: 'Gateway API', version: '1.0.0' } },
    transform: jsonSchemaTransform,
  });

  app.get('/readyz', { schema: { hide: true } }, async (req, reply) => {
    const checks: Record<string, boolean> = {};
    checks.db = await deps.db.execute(sql`select 1`).then(
      () => true,
      () => false,
    );
    if (deps.redis) {
      checks.redis = await deps.redis.ping().then(
        () => true,
        () => false,
      );
    }
    const ok = Object.values(checks).every(Boolean);
    if (!ok) req.log.warn({ checks }, 'readiness check failed');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable', checks });
  });

  app.get('/v1/openapi.json', { schema: { hide: true } }, () => app.swagger());

  void app.register(dashboardAuthRoutes(deps), { prefix: '/v1/dashboard/auth' });
  void app.register(apiKeyDashboardRoutes(deps), { prefix: '/v1/dashboard/api-keys' });
  void app.register(auditDashboardRoutes(deps), { prefix: '/v1/dashboard/audit-logs' });
  void app.register(invoiceDashboardRoutes(deps), { prefix: '/v1/dashboard/invoices' });
  void app.register(registryDashboardRoutes(deps), { prefix: '/v1/dashboard/tokens' });
  void app.register(webhookDashboardRoutes(deps), { prefix: '/v1/dashboard/webhooks' });
  void app.register(xpubDashboardRoutes(deps), { prefix: '/v1/dashboard/xpubs' });
  void app.register(ledgerDashboardRoutes(deps), { prefix: '/v1/dashboard/balances' });
  void app.register(feeTopupDashboardRoutes(deps), { prefix: '/v1/dashboard/fee-topups' });
  void app.register(teamDashboardRoutes(deps), { prefix: '/v1/dashboard/team' });
  void app.register(exportDashboardRoutes(deps), { prefix: '/v1/dashboard/exports' });
  void app.register(withdrawalDashboardRoutes(deps), { prefix: '/v1/dashboard/withdrawals' });
  void app.register(settingsDashboardRoutes(deps), { prefix: '/v1/dashboard/settings' });
  void app.register(inviteAuthRoutes(deps), { prefix: '/v1/dashboard/auth/invite' });
  void app.register(accountRoutes(deps), { prefix: '/v1' });
  void app.register(registryRoutes(deps), { prefix: '/v1' });
  void app.register(invoiceRoutes(deps), { prefix: '/v1' });
  void app.register(paymentLinkRoutes(deps), { prefix: '/v1' });
  void app.register(ledgerRoutes(deps), { prefix: '/v1' });
  void app.register(exportRoutes(deps), { prefix: '/v1' });
  void app.register(withdrawalRoutes(deps), { prefix: '/v1' });
  void app.register(checkoutRoutes(deps));
  void app.register(publicPayRoutes(deps));
  void app.register(
    async (admin) => {
      admin.addHook('onRequest', requireAdminNetwork(deps));
      await admin.register(adminAuthRoutes(deps), { prefix: '/auth' });
      await admin.register(adminRoutes(deps));
      await admin.register(adminUserRoutes(deps), { prefix: '/admins' });
      await admin.register(withdrawalAdminRoutes(deps), { prefix: '/withdrawals' });
      await admin.register(custodyAdminRoutes(deps), { prefix: '/custody' });
    },
    { prefix: '/admin/v1' },
  );

  return app;
}
