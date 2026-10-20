import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import { AppError, type ErrorBody, type ErrorCode } from '@gw/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

function body(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }), request_id: requestId } };
}

export function buildApp(logger: FastifyBaseLogger): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 100 * 1024,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  void app.register(helmet);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(body(err.code, err.message, req.id, err.details));
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
      return reply.status(400).send(body('validation_error', 'invalid request', req.id, details));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastify framework errors (bad JSON, body too large, unsupported media type): messages are safe.
      const code: ErrorCode = status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : 'validation_error';
      return reply.status(status).send(body(code, (err as Error).message, req.id));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('internal_error', 'internal error', req.id));
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send(body('not_found', 'route not found', req.id)));

  app.get('/healthz', () => ({ status: 'ok' }));

  return app;
}
