import { AppError } from '@gw/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { createLogger } from '../../src/common/logger.js';

function app() {
  const a = buildApp(createLogger('silent'));
  a.get('/app-error', () => {
    throw new AppError('conflict', 'already exists', { field: 'x' });
  });
  a.get('/boom', () => {
    throw new Error('db password=hunter2 leaked');
  });
  a.post('/zod', (req) => z.object({ a: z.string() }).strict().parse(req.body));
  return a;
}

describe('api app', () => {
  it('healthz returns ok with request id header', async () => {
    const res = await app().inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe incoming request id, replaces an unsafe one', async () => {
    const a = app();
    const ok = await a.inject({ url: '/healthz', headers: { 'x-request-id': 'abc-123_XYZ.9' } });
    expect(ok.headers['x-request-id']).toBe('abc-123_XYZ.9');
    const bad = await a.inject({ url: '/healthz', headers: { 'x-request-id': 'short' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown route -> 404 error envelope', async () => {
    const res = await app().inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    const b = res.json();
    expect(b.error.code).toBe('not_found');
    expect(b.error.request_id).toBe(res.headers['x-request-id']);
  });

  it('AppError -> mapped status and code with details', async () => {
    const res = await app().inject({ url: '/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'conflict', message: 'already exists', details: { field: 'x' } });
  });

  it('unexpected error -> 500 without leaking message', async () => {
    const res = await app().inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().error.code).toBe('internal_error');
  });

  it('zod error -> 400 validation_error with paths, unknown fields rejected', async () => {
    const res = await app().inject({ method: 'POST', url: '/zod', payload: { a: 1, extra: true } });
    expect(res.statusCode).toBe(400);
    const b = res.json();
    expect(b.error.code).toBe('validation_error');
    expect(JSON.stringify(b.error.details)).toContain('"path":"a"');
  });

  it('malformed JSON -> 400 envelope', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/zod',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('oversized body -> 413 payload_too_large', async () => {
    const res = await app().inject({ method: 'POST', url: '/zod', payload: { a: 'x'.repeat(200 * 1024) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });

  it('sets security headers', async () => {
    const res = await app().inject({ url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});
