import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildApp, buildMetricsApp } from '../src/app.js';

test('health reports the BFF as available and returns a request ID', async () => {
  const app = await buildApp({ logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'UP' });
    assert.ok(response.headers['x-request-id']);
  } finally {
    await app.close();
  }
});

test('metrics expose request counts without exposing request data', async () => {
  const app = await buildApp({ logger: false });
  const metricsApp = buildMetricsApp(app.metricsRegistry);
  try {
    await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer must-not-appear-in-metrics' }
    });
    const publicResponse = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(publicResponse.statusCode, 404);
    const response = await metricsApp.inject({ method: 'GET', url: '/metrics' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/plain/);
    assert.match(response.body, /shop_bff_http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
    assert.match(response.body, /shop_bff_http_request_duration_seconds_bucket/);
    assert.doesNotMatch(response.body, /must-not-appear-in-metrics/);
  } finally {
    await metricsApp.close();
    await app.close();
  }
});

test('API requests are forwarded with the request ID', async () => {
  const upstream = Fastify();
  upstream.get('/api/v1/products', async (request) => ({
    requestId: request.headers['x-request-id'],
    products: []
  }));
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const previousApiUrl = process.env.API_URL;
  process.env.API_URL = address;
  const app = await buildApp({ logger: false });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { 'x-request-id': 'test-request-1' }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { requestId: 'test-request-1', products: [] });
  } finally {
    await app.close();
    await upstream.close();
    if (previousApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = previousApiUrl;
  }
});

test('proxy preserves API conflict status and error body', async () => {
  const upstream = Fastify();
  upstream.post('/api/v1/orders', async (_request, reply) => {
    return reply.code(409).send({ message: 'Idempotency key conflict' });
  });
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const previousApiUrl = process.env.API_URL;
  process.env.API_URL = address;
  const app = await buildApp({ logger: false });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json' },
      payload: { items: [] }
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { message: 'Idempotency key conflict' });
  } finally {
    await app.close();
    await upstream.close();
    if (previousApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = previousApiUrl;
  }
});

test('proxy removes Expect because the request body is already buffered by the BFF', async () => {
  const upstream = Fastify();
  upstream.post('/api/v1/auth/register', async (request) => ({
    expectHeader: request.headers.expect ?? null,
    accepted: Boolean(request.body)
  }));
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const previousApiUrl = process.env.API_URL;
  process.env.API_URL = address;
  const app = await buildApp({ logger: false });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { expect: '100-continue', 'content-type': 'application/json' },
      payload: { email: 'shopper@example.com' }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { expectHeader: null, accepted: true });
  } finally {
    await app.close();
    await upstream.close();
    if (previousApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = previousApiUrl;
  }
});
