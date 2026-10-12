import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Field Notebook',
  description: 'A notebook for everyday notes',
  price: 245,
  currency: 'THB',
  imageUrl: null
};

const sampleOrder = {
  id: '123e4567-e89b-12d3-a456-426614174009',
  status: 'PLACED',
  total: 490,
  currency: 'THB',
  createdAt: '2026-10-11T03:00:00Z',
  items: [{ productName: 'Field Notebook', quantity: 2, unitPrice: 245 }]
};

export async function startBffIntegration(options = {}) {
  const backendRequests = [];
  const issuedTokens = [];
  const customer = options.customer
    ? {
        ...options.customer,
        emailVerified: options.customer.emailVerified ?? true,
        displayName: options.customer.displayName ?? 'Test Customer'
      }
    : null;
  const registrationTickets = new Set();
  const verificationCode = 'test-email-verification-code';
  const ordersByEmail = new Map();
  let authenticatedCustomerEmail = null;
  let guestCheckoutCodeEmail = null;
  let verifiedCheckoutEmail = null;
  let verifiedGuestEmail = null;
  let orderSequence = 1;
  let registeredCustomer = null;
  if (customer) ordersByEmail.set(customer.email, options.customer.orders ?? [sampleOrder]);
  for (const [email, orders] of Object.entries(options.guestOrders ?? {})) {
    ordersByEmail.set(email.trim().toLowerCase(), orders);
  }
  const backend = createServer(async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : null;
    backendRequests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body
    });

    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'POST' && request.url === '/api/v1/auth/anonymous') {
      issuedTokens.push('anonymous-token');
      send(200, { accessToken: 'anonymous-token' });
    } else if (request.method === 'GET' && request.url === '/api/v1/products') {
      send(200, [product]);
    } else if (request.method === 'POST' && request.url === '/api/v1/waiting-room/registration/tickets') {
      const ticketId = typeof body === 'object' && body !== null && 'ticketId' in body
        ? body.ticketId
        : null;
      if (typeof ticketId !== 'string') {
        send(400, { message: 'Ticket ID is required.' });
        return;
      }
      registrationTickets.add(ticketId);
      send(200, { ticketId, state: 'admitted', position: 0, retryAfterSeconds: 1 });
    } else if (request.method === 'POST' && request.url === '/api/v1/auth/register') {
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      const ticket = request.headers['x-waiting-room-ticket'];
      if (!registrationTickets.has(ticket)) {
        send(403, { message: 'An active waiting-room ticket is required.' });
      } else if (!email || typeof body?.password !== 'string') {
        send(400, { message: 'Email and password are required.' });
      } else if (registeredCustomer?.email === email || customer?.email === email) {
        send(202, { message: 'If the email can be registered, a verification message will be sent.' });
      } else {
        registeredCustomer = { email, password: body.password, displayName: null, emailVerified: false };
        send(202, { message: 'If the email can be registered, a verification message will be sent.' });
      }
    } else if (request.method === 'POST' && request.url === '/api/v1/auth/verify-email') {
      if (body?.token !== verificationCode || (!registeredCustomer && !customer)) {
        send(400, { message: 'Invalid or expired verification code.' });
      } else {
        if (registeredCustomer) registeredCustomer.emailVerified = true;
        if (customer) customer.emailVerified = true;
        send(200, { message: 'Email verified.' });
      }
    } else if (request.method === 'POST' && request.url === '/api/v1/auth/login') {
      const account = [registeredCustomer, customer]
        .find((candidate) => candidate?.email === body?.email?.trim().toLowerCase());
      if (!account || account.password !== body?.password || !account.emailVerified) {
        send(401, { message: 'Invalid email or password.' });
      } else {
        authenticatedCustomerEmail = account.email;
        issuedTokens.push('customer-token');
        send(200, {
          accessToken: 'customer-token',
          refreshToken: 'customer-refresh-token',
          expiresIn: 900
        });
      }
    } else if (request.method === 'POST' && request.url === '/api/v1/auth/logout') {
      authenticatedCustomerEmail = null;
      send(200, { message: 'Logged out.' });
    } else if (request.method === 'GET' && request.url === '/api/v1/profile'
        && request.headers.authorization?.endsWith('verified-guest-token') && verifiedGuestEmail) {
      send(200, { email: verifiedGuestEmail, displayName: null, accountType: 'guest' });
    } else if (request.method === 'GET' && request.url === '/api/v1/profile') {
      if (request.headers.authorization !== 'Bearer customer-token') {
        send(403, { message: 'Customer access required.' });
      } else {
        const account = registeredCustomer ?? customer;
        send(200, { email: account.email, displayName: account.displayName, accountType: 'customer' });
      }
    } else if (request.method === 'GET' && request.url?.startsWith('/api/v1/orders/history')
        && request.headers.authorization?.endsWith('verified-guest-token') && verifiedGuestEmail) {
      send(200, ordersByEmail.get(verifiedGuestEmail) ?? []);
    } else if (request.method === 'GET' && request.url?.startsWith('/api/v1/orders/history')
        && request.headers.authorization?.endsWith('customer-token') && authenticatedCustomerEmail
        && ordersByEmail.has(authenticatedCustomerEmail)) {
      send(200, ordersByEmail.get(authenticatedCustomerEmail));
    } else if (request.method === 'POST' && request.url === '/api/v1/guest-access/request') {
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email) verifiedGuestEmail = email;
      send(202, { message: 'If guest orders exist for this email, an access code will be sent.' });
    } else if (request.method === 'POST' && request.url === '/api/v1/guest-access/checkout/request') {
      guestCheckoutCodeEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      send(202, { message: 'If the email is valid, a verification code will be sent.' });
    } else if (request.method === 'POST' && request.url === '/api/v1/guest-access/checkout/verify') {
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (body?.token !== verificationCode || !email || email !== guestCheckoutCodeEmail) {
        send(400, { message: 'Invalid or expired checkout verification code.' });
      } else {
        verifiedCheckoutEmail = email;
        issuedTokens.push('guest-token');
        send(200, { accessToken: 'guest-token' });
      }
    } else if (request.method === 'POST' && request.url === '/api/v1/guest-access/verify') {
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (body?.token !== verificationCode || !ordersByEmail.has(email)) {
        send(400, { message: 'Invalid or expired guest access code.' });
      } else {
        verifiedGuestEmail = email;
        send(200, { accessToken: 'verified-guest-token' });
      }
    } else if (request.method === 'GET' && request.url?.startsWith('/api/v1/orders/history')) {
      if (request.headers.authorization !== 'Bearer customer-token') {
        send(403, { message: 'Customer access required.' });
      } else {
        send(200, [{
          id: '123e4567-e89b-12d3-a456-426614174009',
          status: 'PLACED',
          total: 490,
          currency: 'THB',
          createdAt: '2026-10-11T03:00:00Z',
          items: [{ productName: 'Field Notebook', quantity: 2, unitPrice: 245 }]
        }]);
      }
    } else if (request.method === 'POST' && request.url === '/api/v1/waiting-room/checkout/tickets') {
      const ticketId = typeof body === 'object' && body !== null && 'ticketId' in body
        ? body.ticketId
        : null;
      send(200, { ticketId, state: 'admitted', position: 0, retryAfterSeconds: 1 });
    } else if (request.method === 'POST' && request.url === '/api/v1/orders'
        && request.headers.authorization?.endsWith('customer-token') && authenticatedCustomerEmail) {
      const items = createOrderItems(body?.items);
      const order = createOrder(orderSequence++, items);
      ordersByEmail.set(authenticatedCustomerEmail, [
        ...(ordersByEmail.get(authenticatedCustomerEmail) ?? []),
        order
      ]);
      send(200, { id: order.id, status: order.status, total: order.total, currency: order.currency });
    } else if (request.method === 'POST' && request.url === '/api/v1/orders'
        && request.headers.authorization?.endsWith('guest-token') && verifiedCheckoutEmail) {
      const items = createOrderItems(body?.items);
      const order = createOrder(orderSequence++, items);
      ordersByEmail.set(verifiedCheckoutEmail, [...(ordersByEmail.get(verifiedCheckoutEmail) ?? []), order]);
      send(200, { id: order.id, status: order.status, total: order.total, currency: order.currency });
    } else if (request.method === 'POST' && request.url === '/api/v1/orders') {
      send(200, { id: 'order-123', status: 'accepted', total: 490, currency: 'THB' });
    } else {
      send(404, { message: `Unexpected API request: ${request.method} ${request.url}` });
    }
  });

  await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', resolve);
  });
  const address = backend.address();
  if (!address || typeof address === 'string') {
    await closeServer(backend);
    throw new Error('The backend test server did not bind to a TCP port');
  }

  const bffPort = await reservePort();
  const entryUrl = pathToFileURL(resolve(process.cwd(), '..', 'bff', 'src', 'app.js')).href;
  const bffScript = `
    import { buildApp } from ${JSON.stringify(entryUrl)};
    const app = await buildApp({ logger: false });
    await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) });
    console.log('BFF_READY');
  `;
  const bffProcess = spawn(process.execPath, ['--input-type=module', '--eval', bffScript], {
    env: {
      ...process.env,
      API_URL: `http://127.0.0.1:${address.port}`,
      PORT: String(bffPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForBff(bffProcess);
  } catch (error) {
    await stopProcess(bffProcess);
    await closeServer(backend);
    throw error;
  }

  const bff = {
    async inject({ method, url, headers, payload }) {
      const response = await fetch(`http://127.0.0.1:${bffPort}${url}`, {
        method,
        headers,
        ...(payload === undefined ? {} : {
          body: typeof payload === 'string' ? payload : JSON.stringify(payload)
        })
      });
      return {
        statusCode: response.status,
        statusMessage: response.statusText,
        body: await response.text(),
        headers: Object.fromEntries(response.headers.entries())
      };
    }
  };

  return {
    bff,
    backendRequests,
    issuedTokens,
    ordersByEmail,
    verificationCode,
    async close() {
      try {
        await stopProcess(bffProcess);
      } finally {
        await closeServer(backend);
      }
    }
  };
}

function createOrderItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    productName: product.name,
    quantity: item.quantity,
    unitPrice: product.price
  }));
}

function createOrder(sequence, items) {
  return {
    id: `order-${sequence}`,
    status: 'PLACED',
    total: items.reduce((total, item) => total + item.quantity * item.unitPrice, 0),
    currency: 'THB',
    createdAt: '2026-10-12T08:00:00Z',
    items
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Unable to reserve a TCP port for the BFF test server');
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

function waitForBff(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`BFF startup timed out: ${output}`)), 10_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('BFF_READY')) finish();
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', finish);
    child.once('exit', (code) => {
      finish(new Error(`BFF exited before startup (code ${code}): ${output}`));
    });
  });
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}
