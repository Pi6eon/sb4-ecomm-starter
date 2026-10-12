import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import proxy from '@fastify/http-proxy';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { Counter, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export async function buildApp(options = {}) {
  const redis = options.redis ?? (process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
    : undefined);
  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics, prefix: 'shop_bff_' });
  const requests = new Counter({
    name: 'shop_bff_http_requests_total',
    help: 'Total HTTP responses served by the BFF.',
    labelNames: ['method', 'route', 'status'],
    registers: [metrics]
  });
  const requestDuration = new Histogram({
    name: 'shop_bff_http_request_duration_seconds',
    help: 'HTTP response duration in seconds for the BFF.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metrics]
  });
  const app = Fastify({
    trustProxy: Number(process.env.TRUST_PROXY_HOPS ?? 0),
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      base: { appName: process.env.APP_NAME ?? 'shop-bff' }
    },
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)
        ? supplied
        : randomUUID();
    }
  });
  app.decorate('metricsRegistry', metrics);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    delete request.headers.expect;
    request.metricsStartedAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/metrics') return;
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: String(reply.statusCode)
    };
    requests.inc(labels);
    requestDuration.observe(labels, Number(process.hrtime.bigint() - request.metricsStartedAt) / 1e9);
  });

  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    keyGenerator: (request) => {
      const email = request.body && typeof request.body === 'object'
        && 'email' in request.body && typeof request.body.email === 'string'
        ? request.body.email.trim().toLowerCase()
        : null;
      if (request.url.startsWith('/api/v1/auth/') && email) {
        const digest = createHash('sha256').update(email).digest('hex');
        return `auth:${request.ip}:${digest}`;
      }
      const authorization = request.headers.authorization;
      if (authorization) {
        const digest = createHash('sha256').update(authorization).digest('hex');
        return `token:${request.ip}:${digest}`;
      }
      return `ip:${request.ip}`;
    },
    ...(redis ? { redis } : {})
  });
  if (redis) {
    app.addHook('onClose', async () => {
      await redis.quit();
    });
  }

  app.get('/health', async () => ({ status: 'UP' }));

  await app.register(proxy, {
    upstream: process.env.API_URL ?? 'http://localhost:8080',
    prefix: '/api',
    rewritePrefix: '/api',
    httpMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']
  });

  return app;
}

export function buildMetricsApp(metrics) {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', metrics.contentType);
    return metrics.metrics();
  });
  return app;
}
