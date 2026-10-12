import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import https from 'node:https';

const apiBase = process.env.API_BASE_URL ?? 'http://localhost:8080';
const targetRps = Number(process.env.PERF_RPS ?? 1);
const durationSeconds = Number(process.env.PERF_DURATION_SECONDS ?? 60);
const p95LimitMs = Number(process.env.PERF_P95_LIMIT_MS ?? 250);
const maxErrorRate = Number(process.env.PERF_MAX_ERROR_RATE ?? 0.01);

assert.ok(Number.isInteger(targetRps) && targetRps > 0 && targetRps <= 50,
  'PERF_RPS must be an integer between 1 and 50');
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 10 && durationSeconds <= 3600,
  'PERF_DURATION_SECONDS must be an integer between 10 and 3600');

function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(target, {
      method,
      headers: { connection: 'close', ...headers },
      timeout: 5000
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('HTTP request timed out')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const tokenResponse = await request(new URL('/api/v1/auth/anonymous', apiBase), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}'
});
assert.equal(tokenResponse.status, 200, 'Unable to obtain anonymous catalog token');
const { accessToken } = JSON.parse(tokenResponse.body);
const samples = [];
let failures = 0;
const start = performance.now();
const intervalMs = 1000 / targetRps;
const requestCount = targetRps * durationSeconds;
const pending = new Set();

for (let index = 0; index < requestCount; index += 1) {
  const dueAt = start + index * intervalMs;
  const waitMs = dueAt - performance.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const task = (async () => {
    const requestStart = performance.now();
    try {
      const response = await request(new URL('/api/v1/products', apiBase), {
        headers: { authorization: `Bearer ${accessToken}` }
      });
      if (response.status !== 200) failures += 1;
    } catch {
      failures += 1;
    } finally {
      samples.push(performance.now() - requestStart);
    }
  })();
  pending.add(task);
  task.finally(() => pending.delete(task));
}
await Promise.all(pending);

samples.sort((left, right) => left - right);
const percentile = (value) => samples[Math.max(0, Math.ceil(samples.length * value) - 1)] ?? 0;
const errorRate = failures / requestCount;
const result = {
  workload: `${targetRps} catalog GET/s for ${durationSeconds}s`,
  started: requestCount,
  completed: samples.length,
  failures,
  errorRate,
  p50Ms: Number(percentile(0.50).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  p99Ms: Number(percentile(0.99).toFixed(2)),
  threshold: { p95Ms: p95LimitMs, maxErrorRate }
};
console.log(JSON.stringify(result, null, 2));
assert.equal(samples.length, requestCount, 'Not all scheduled requests completed');
assert.ok(errorRate <= maxErrorRate, `Error rate ${errorRate} exceeds ${maxErrorRate}`);
assert.ok(percentile(0.95) <= p95LimitMs, `p95 ${percentile(0.95)}ms exceeds ${p95LimitMs}ms`);
