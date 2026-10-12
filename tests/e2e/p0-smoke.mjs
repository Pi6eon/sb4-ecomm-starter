import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3000';
const managementBase = process.env.MANAGEMENT_BASE_URL ?? 'http://localhost:8081';
const mailpitBase = process.env.MAILPIT_BASE_URL ?? 'http://localhost:8025';
const bffMetricsBase = process.env.BFF_METRICS_BASE_URL ?? 'http://localhost:13001';

async function request(base, path, { expectedStatus = 200, ...options } = {}) {
  const response = await fetch(new URL(path, base), options);
  const body = await response.text();
  const responseHeaders = Object.fromEntries(response.headers.entries());
  assert.equal(response.status, expectedStatus,
    `${options.method ?? 'GET'} ${path}: expected ${expectedStatus}, got ${response.status}; headers=${JSON.stringify(responseHeaders)} body=${body}`);
  return { response, body };
}

async function jsonRequest(base, path, payload, { expectedStatus = 200, headers = {} } = {}) {
  const result = await request(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    expectedStatus
  });
  return { ...result, json: JSON.parse(result.body) };
}

async function waitForMessage(email, subject) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/api/v1/messages?limit=50', mailpitBase));
    if (response.ok) {
      const { messages } = await response.json();
      const message = messages.find((candidate) =>
        candidate.To.some((recipient) => recipient.Address === email)
        && candidate.Subject === subject);
      if (message) {
        const token = message.Snippet.match(/(?:Token|Code):\s*([A-Za-z0-9_-]+)/)?.[1];
        assert.ok(token, `${subject} message did not contain an action token`);
        return token;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Timed out waiting for ${subject} email`);
}

async function registerVerifiedCustomer(email, password) {
  const ticket = await waitingRoomTicket('registration');
  await jsonRequest(apiBase, '/api/v1/auth/register', { email, password }, {
    expectedStatus: 202,
    headers: { 'X-Waiting-Room-Ticket': ticket }
  });
  const token = await waitForMessage(email, 'Verify your Everyday account');
  await jsonRequest(apiBase, '/api/v1/auth/verify-email', { token });
  const { json } = await jsonRequest(apiBase, '/api/v1/auth/login', { email, password });
  return json;
}

async function waitingRoomTicket(flow) {
  const ticketId = randomUUID();
  let { json: ticket } = await jsonRequest(apiBase, `/api/v1/waiting-room/${flow}/tickets`, { ticketId });
  const deadline = Date.now() + 30_000;
  while (ticket.state === 'queued' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ticket.retryAfterSeconds * 1000));
    const status = await request(apiBase, `/api/v1/waiting-room/${flow}/tickets/${ticketId}`);
    ticket = JSON.parse(status.body);
  }
  assert.equal(ticket.state, 'admitted', `Waiting-room ${flow} ticket was not admitted`);
  return ticketId;
}

const email = `ci-${randomUUID()}@example.test`;
const password = 'SecureIntegrationPassword42!';
const customer = await registerVerifiedCustomer(email, password);
assert.equal(customer.tokenType, 'Bearer');
assert.ok(customer.refreshToken);

const productsResponse = await request(apiBase, '/api/v1/products', {
  headers: { authorization: `Bearer ${customer.accessToken}` }
});
const products = JSON.parse(productsResponse.body);
assert.ok(products.length > 0, 'Catalog should have at least one seeded product');
const sitemap = await request(apiBase, '/api/v1/discovery/sitemap.xml');
assert.match(sitemap.body, /\/products\/11111111-1111-4111-8111-111111111111/);
const robots = await request(apiBase, '/api/v1/discovery/robots.txt');
assert.match(robots.body, /Sitemap:/);
await request(apiBase, '/api/v1/products', {
  headers: { authorization: `Bearer ${customer.accessToken}` }
});

const orderBody = { items: [{ productId: products[0].id, quantity: 1 }] };
const idempotencyKey = randomUUID();
const orderHeaders = {
  authorization: `Bearer ${customer.accessToken}`,
  'idempotency-key': idempotencyKey
};
const { json: order } = await jsonRequest(apiBase, '/api/v1/orders', orderBody, { headers: orderHeaders });
const { json: replay } = await jsonRequest(apiBase, '/api/v1/orders', orderBody, { headers: orderHeaders });
assert.equal(replay.id, order.id, 'An identical retry must replay the original order');
const { body: orderPageBody } = await request(apiBase, '/api/v1/orders?limit=10&offset=0', {
  headers: { authorization: `Bearer ${customer.accessToken}` }
});
const orderPage = JSON.parse(orderPageBody);
assert.ok(orderPage.some((entry) => entry.id === order.id), 'Paginated order history must contain the new order');

await jsonRequest(apiBase, '/api/v1/orders', {
  items: [{ productId: products[0].id, quantity: 2 }]
}, { expectedStatus: 409, headers: orderHeaders });

const guestEmail = `other-${randomUUID()}@example.test`;
await request(apiBase, '/api/v1/auth/guest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: guestEmail }),
  expectedStatus: 404
});
await jsonRequest(apiBase, '/api/v1/guest-access/checkout/request', { email: guestEmail }, {
  expectedStatus: 202
});
const guestCode = await waitForMessage(guestEmail, 'Your Everyday guest checkout verification code');
const guest = await jsonRequest(apiBase, '/api/v1/guest-access/checkout/verify', {
  email: guestEmail,
  token: guestCode
});
await jsonRequest(apiBase, '/api/v1/guest-access/checkout/verify', {
  email: guestEmail,
  token: guestCode
}, { expectedStatus: 400 });
const guestOrderBody = { items: [{ productId: products[1].id, quantity: 1 }] };
const guestOrderHeaders = {
  authorization: `Bearer ${guest.json.accessToken}`,
  'idempotency-key': randomUUID()
};
await jsonRequest(apiBase, '/api/v1/orders', guestOrderBody, {
  expectedStatus: 403,
  headers: guestOrderHeaders
});
guestOrderHeaders['X-Waiting-Room-Ticket'] = await waitingRoomTicket('checkout');
const { json: guestOrder } = await jsonRequest(apiBase, '/api/v1/orders', guestOrderBody, {
  headers: guestOrderHeaders
});
guestOrderHeaders['X-Waiting-Room-Ticket'] = await waitingRoomTicket('checkout');
const { json: guestReplay } = await jsonRequest(apiBase, '/api/v1/orders', guestOrderBody, {
  headers: guestOrderHeaders
});
assert.equal(guestReplay.id, guestOrder.id, 'A guest checkout retry must remain idempotent');

const shortLink = await jsonRequest(apiBase, '/api/v1/short-links', { productId: products[0].id }, {
  headers: { authorization: `Bearer ${customer.accessToken}` }
});
await jsonRequest(apiBase, '/api/v1/short-links', { productId: products[0].id }, {
  expectedStatus: 403,
  headers: { authorization: `Bearer ${guest.accessToken}` }
});
const redirect = await request(apiBase, `/api/v1/short-links/${shortLink.json.code}`, {
  redirect: 'manual',
  expectedStatus: 302
});
assert.match(redirect.response.headers.get('location'), new RegExp(`/products/${products[0].id}$`));
await request(apiBase, `/api/v1/short-links/${shortLink.json.code}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${customer.accessToken}` },
  expectedStatus: 204
});
await request(apiBase, `/api/v1/short-links/${shortLink.json.code}`, { expectedStatus: 410 });

await request(apiBase, `/api/v1/orders/${order.id}`, {
  headers: { authorization: `Bearer ${guest.json.accessToken}` },
  expectedStatus: 404
});

const rotated = await jsonRequest(apiBase, '/api/v1/auth/refresh', {
  refreshToken: customer.refreshToken
});
assert.notEqual(rotated.json.refreshToken, customer.refreshToken);
await jsonRequest(apiBase, '/api/v1/auth/refresh', {
  refreshToken: customer.refreshToken
}, { expectedStatus: 401 });
await jsonRequest(apiBase, '/api/v1/auth/logout', {
  refreshToken: rotated.json.refreshToken
});
await jsonRequest(apiBase, '/api/v1/auth/refresh', {
  refreshToken: rotated.json.refreshToken
}, { expectedStatus: 401 });

await jsonRequest(apiBase, '/api/v1/auth/password/forgot', { email }, { expectedStatus: 202 });
const resetToken = await waitForMessage(email, 'Reset your Everyday password');
const newPassword = 'NewIntegrationPassword43!';
await jsonRequest(apiBase, '/api/v1/auth/password/reset', {
  token: resetToken,
  newPassword
});
await jsonRequest(apiBase, '/api/v1/auth/login', { email, password: newPassword });
await jsonRequest(apiBase, '/api/v1/auth/login', { email, password }, { expectedStatus: 401 });

const apiMetrics = await request(managementBase, '/actuator/prometheus');
assert.match(apiMetrics.body, /http_server_requests_seconds_count/);
assert.match(apiMetrics.body, /shop_catalog_cache_requests_total\{kind="list",result="hit"\}/);
const eventDeadline = Date.now() + 20_000;
let eventPublished = false;
while (Date.now() < eventDeadline) {
  const metrics = await request(managementBase, '/actuator/prometheus');
  eventPublished = /shop_order_outbox_published_total\{event_type="OrderPlaced\.v1"\} [1-9]/.test(metrics.body);
  if (eventPublished) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.ok(eventPublished, 'Order event was not acknowledged by Kafka from the transactional outbox');
const bffMetrics = await request(bffMetricsBase, '/metrics');
assert.match(bffMetrics.body, /shop_bff_http_requests_total/);
assert.doesNotMatch(bffMetrics.body, new RegExp(email));

console.log('E2E passed: identity, FIFO admission, guest checkout, short links, SEO discovery, and API/BFF metrics.');
