import { registerLocaleData } from '@angular/common';
import {
  HttpBackend,
  HttpErrorResponse,
  HttpEvent,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors
} from '@angular/common/http';
import localeTh from '@angular/common/locales/th';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideEffects } from '@ngrx/effects';
import { provideStore } from '@ngrx/store';
import { firstValueFrom, from, mergeMap, Observable, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBffIntegration } from './bff-integration-harness.js';
import { AppComponent } from './app.component';
import { bearerTokenInterceptor } from './bearer-token.interceptor';
import { Product } from './models';
import { ProductsEffects } from './state/products.effects';
import { shopReducer } from './state/shop.reducer';

interface BffResponse {
  statusCode: number;
  statusMessage: string;
  body: string;
  headers: Record<string, string | number | boolean | undefined>;
}

interface BackendRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface BffAdapter {
  inject(options: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<BffResponse>;
}

const product: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Field Notebook',
  description: 'A notebook for everyday notes',
  price: 245,
  currency: 'THB',
  imageUrl: null
};

class BffHttpBackend implements HttpBackend {
  constructor(private readonly bff: BffAdapter) {}

  handle(request: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return throwError(() => new Error(`Unsupported integration request method: ${request.method}`));
    }
    const headers: Record<string, string> = {};
    for (const name of request.headers.keys()) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    return from(this.bff.inject({
      method: request.method,
      url: request.urlWithParams,
      headers,
      payload: request.serializeBody() ?? undefined
    })).pipe(mergeMap((response) => {
      const body: unknown = response.body ? JSON.parse(response.body) : null;
      const responseHeaders = new HttpHeaders(
        Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, String(value)]))
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return throwError(() => new HttpErrorResponse({
          error: body,
          headers: responseHeaders,
          status: response.statusCode,
          statusText: response.statusMessage,
          url: request.urlWithParams
        }));
      }
      return of(new HttpResponse({
        body,
        headers: responseHeaders,
        status: response.statusCode,
        statusText: response.statusMessage,
        url: request.urlWithParams
      }));
    }));
  }
}

describe('AppComponent with the BFF and backend API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('loads backend products and completes guest checkout through the BFF', async () => {
    const harness = await startBffIntegration();
    const backendRequests: BackendRequest[] = harness.backendRequests;

    try {
      vi.stubGlobal('crypto', { randomUUID: () => '123e4567-e89b-12d3-a456-426614174001' });
      registerLocaleData(localeTh);
      TestBed.configureTestingModule({
        imports: [AppComponent],
        providers: [
          provideHttpClient(withInterceptors([bearerTokenInterceptor])),
          { provide: HttpBackend, useValue: new BffHttpBackend(harness.bff) },
          provideStore({ shop: shopReducer }),
          provideEffects([ProductsEffects])
        ]
      });
      const fixture = TestBed.createComponent(AppComponent);
      fixture.autoDetectChanges();
      await waitForProductCard(fixture);

      expect(fixture.nativeElement.querySelector('.product-card').textContent).toContain(product.name);
      expect(backendRequests.find((request) => request.path === '/api/v1/products')?.headers['authorization'])
        .toBe('Bearer anonymous-token');

      fixture.componentInstance.email = 'guest@example.com';
      await fixture.componentInstance.checkout([{ product, quantity: 2 }]);
      expect(backendRequests.some((request) => request.path === '/api/v1/orders')).toBe(false);
      await verifyGuestCheckout(fixture, 'guest@example.com', harness.verificationCode);
      await fixture.componentInstance.checkout([{ product, quantity: 2 }]);
      await fixture.whenStable();

      const orderRequest = backendRequests.find((request) => request.path === '/api/v1/orders');
      expect(harness.issuedTokens).toHaveLength(2);
      expect(backendRequests.some((request) =>
        request.path === '/api/v1/guest-access/checkout/request')).toBe(true);
      expect(backendRequests.some((request) =>
        request.path === '/api/v1/guest-access/checkout/verify')).toBe(true);
      expect(orderRequest?.headers['authorization']).toBe(`Bearer ${harness.issuedTokens[1]}`);
      expect(orderRequest?.headers['x-waiting-room-ticket']).toBe('123e4567-e89b-12d3-a456-426614174001');
      expect(orderRequest?.headers['idempotency-key']).toBe('123e4567-e89b-12d3-a456-426614174001');
      expect(orderRequest?.body).toEqual({ items: [{ productId: product.id, quantity: 2 }] });
      expect(fixture.nativeElement.querySelector('.checkout-panel .order-message').textContent).toContain('order-1');
    } finally {
      await harness.close();
    }
  });

  it('customer-registration-flow registers a customer through the BFF and opens email verification', async () => {
    const harness = await startBffIntegration();

    try {
      const fixture = await startCustomerFixture(harness);
      fixture.componentInstance.accountMode = 'register';
      fixture.componentInstance.accountEmail = 'flow-customer@example.local';
      fixture.componentInstance.accountPassword = 'FlowCustomerTest!2026';

      const registration = fixture.componentInstance.submitAccount();
      await waitForRequest(harness.backendRequests, '/api/v1/waiting-room/registration/tickets');
      const admission = harness.backendRequests.find((request) =>
        request.path === '/api/v1/waiting-room/registration/tickets');
      expect(admission?.body).toEqual({ ticketId: expect.any(String) });
      await registration;
      await fixture.whenStable();

      const registerRequest = harness.backendRequests.find((request) => request.path === '/api/v1/auth/register');
      expect(registerRequest?.headers['x-waiting-room-ticket']).toBe(admission?.body.ticketId);
      expect(registerRequest?.body).toEqual({
        email: 'flow-customer@example.local',
        password: 'FlowCustomerTest!2026'
      });
      expect(fixture.nativeElement.querySelector('#verification-token')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.account-panel .order-message').textContent)
        .toContain('token ยืนยัน');
    } finally {
      await harness.close();
    }
  });

  it('customer-verification-flow verifies an email through the BFF before login is allowed', async () => {
    const harness = await startBffIntegration({
      customer: {
        email: 'unverified@example.local',
        password: 'UnverifiedCustomer!2026',
        emailVerified: false
      }
    });

    try {
      const fixture = await startCustomerFixture(harness);
      fixture.componentInstance.accountEmail = 'unverified@example.local';
      fixture.componentInstance.verificationRequired = true;
      fixture.componentInstance.verificationToken = harness.verificationCode;

      const verification = fixture.componentInstance.verifyEmail();
      await verification;
      await fixture.whenStable();

      expect(harness.backendRequests.find((request) => request.path === '/api/v1/auth/verify-email')?.body)
        .toEqual({ token: harness.verificationCode });
      expect(fixture.componentInstance.verificationRequired).toBe(false);
      expect(fixture.nativeElement.querySelector('.account-panel .order-message').textContent)
        .toContain('ยืนยันอีเมลสำเร็จ');

      fixture.componentInstance.accountPassword = 'UnverifiedCustomer!2026';
      const login = fixture.componentInstance.submitAccount();
      await login;
      await fixture.whenStable();
      expect(fixture.componentInstance.customerSignedIn).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('customer-login-flow loads a signed-in customer profile and order history through the BFF', async () => {
    const harness = await startBffIntegration({
      customer: {
        email: 'verified@example.local',
        password: 'VerifiedCustomer!2026',
        displayName: 'Returning Customer'
      }
    });

    try {
      const fixture = await startCustomerFixture(harness);
      fixture.componentInstance.accountEmail = 'verified@example.local';
      fixture.componentInstance.accountPassword = 'VerifiedCustomer!2026';

      const login = fixture.componentInstance.submitAccount();
      await login;
      await fixture.whenStable();

      expect(fixture.componentInstance.customerSignedIn).toBe(true);
      expect(fixture.componentInstance.profile?.email).toBe('verified@example.local');
      expect(fixture.componentInstance.profileDisplayName).toBe('Returning Customer');
      expect(fixture.componentInstance.orderHistory[0]?.items[0]?.productName).toBe('Field Notebook');
      expect(harness.backendRequests.some((request) =>
        request.path === '/api/v1/profile' && request.headers.authorization === 'Bearer customer-token'))
        .toBe(true);
      expect(harness.backendRequests.some((request) =>
        request.path === '/api/v1/orders/history' && request.headers.authorization === 'Bearer customer-token'))
        .toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('customer-full-flow registers, verifies, logs in, checks out as a customer and guest, and loads both histories', async () => {
    const harness = await startBffIntegration();

    try {
      const fixture = await startCustomerFixture(harness);
      fixture.componentInstance.accountMode = 'register';
      fixture.componentInstance.accountEmail = 'full-flow@example.local';
      fixture.componentInstance.accountPassword = 'FullCustomerFlow!2026';

      const registration = fixture.componentInstance.submitAccount();
      await waitForRequest(harness.backendRequests, '/api/v1/waiting-room/registration/tickets');
      await registration;
      await fixture.whenStable();
      expect(fixture.componentInstance.verificationRequired).toBe(true);

      fixture.componentInstance.verificationToken = harness.verificationCode;
      const verification = fixture.componentInstance.verifyEmail();
      await verification;
      await fixture.whenStable();
      expect(fixture.componentInstance.verificationRequired).toBe(false);

      fixture.componentInstance.accountPassword = 'FullCustomerFlow!2026';
      const login = fixture.componentInstance.submitAccount();
      await login;
      await fixture.whenStable();

      expect(fixture.componentInstance.customerSignedIn).toBe(true);
      expect(fixture.componentInstance.profile?.email).toBe('full-flow@example.local');
      expect(fixture.componentInstance.orderHistory[0]?.items[0]?.productName).toBe('Field Notebook');
      expect(harness.backendRequests.map((request) => request.path)).toEqual(expect.arrayContaining([
        '/api/v1/auth/register',
        '/api/v1/auth/verify-email',
        '/api/v1/auth/login',
        '/api/v1/profile',
        '/api/v1/orders/history'
      ]));

      fixture.componentInstance.add(product);
      await fixture.whenStable();
      const customerCart = await firstValueFrom(fixture.componentInstance.cart$);
      await fixture.componentInstance.checkout(customerCart);
      await fixture.whenStable();

      const customerOrderRequest = harness.backendRequests.find((request) => request.path === '/api/v1/orders');
      expect(customerOrderRequest?.headers.authorization).toBeDefined();
      expect(customerOrderRequest?.body).toEqual({ items: [{ productId: product.id, quantity: 1 }] });
      expect(harness.ordersByEmail.get('full-flow@example.local')).toHaveLength(1);

      fixture.componentInstance.signOut();
      await fixture.whenStable();
      await loginCustomer(fixture, 'full-flow@example.local', 'FullCustomerFlow!2026');
      expect(fixture.componentInstance.orderHistory[0]?.id).toBe('order-1');

      fixture.componentInstance.signOut();
      await fixture.whenStable();
      const guestEmail = 'full-flow-guest@example.local';
      fixture.componentInstance.email = guestEmail;
      await verifyGuestCheckout(fixture, guestEmail, harness.verificationCode);
      fixture.componentInstance.add(product);
      await fixture.whenStable();
      const guestCart = await firstValueFrom(fixture.componentInstance.cart$);
      await fixture.componentInstance.checkout(guestCart);
      await fixture.whenStable();

      const guestOrderRequest = harness.backendRequests.filter((request) => request.path === '/api/v1/orders')[1];
      expect(guestOrderRequest?.headers.authorization).toBeDefined();
      expect(guestOrderRequest?.headers['x-waiting-room-ticket']).toBe('123e4567-e89b-12d3-a456-426614174001');
      expect(harness.ordersByEmail.get(guestEmail)).toHaveLength(1);
      expect(fixture.componentInstance.customerSignedIn).toBe(false);

      fixture.componentInstance.guestEmail = guestEmail;
      await fixture.componentInstance.requestGuestAccess();
      expect(fixture.componentInstance.guestCodeRequested).toBe(true);
      fixture.componentInstance.guestAccessCode = harness.verificationCode;
      await fixture.componentInstance.verifyGuestAccess();
      await fixture.whenStable();

      expect(fixture.componentInstance.profile?.accountType).toBe('guest');
      expect(fixture.componentInstance.orderHistory[0]?.id).toBe('order-2');
      expect(harness.backendRequests.map((request) => request.path)).toEqual(expect.arrayContaining([
        '/api/v1/guest-access/request',
        '/api/v1/guest-access/verify'
      ]));
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('customer-cart-checkout-flow submits the signed-in customer cart through the BFF', async () => {
    const harness = await startBffIntegration({
      customer: { email: 'customer-checkout@example.local', password: 'CustomerCheckout!2026', orders: [] }
    });

    try {
      const fixture = await startCustomerFixture(harness);
      await loginCustomer(fixture, 'customer-checkout@example.local', 'CustomerCheckout!2026');
      fixture.componentInstance.add(product);
      await fixture.whenStable();
      const cart = await firstValueFrom(fixture.componentInstance.cart$);

      await fixture.componentInstance.checkout(cart);
      await fixture.whenStable();

      const orderRequest = harness.backendRequests.find((request) => request.path === '/api/v1/orders');
      expect(orderRequest?.headers.authorization).toBe('Bearer customer-token');
      expect(orderRequest?.headers['x-waiting-room-ticket']).toBeUndefined();
      expect(orderRequest?.body).toEqual({ items: [{ productId: product.id, quantity: 1 }] });
      expect(fixture.nativeElement.querySelector('.checkout-panel .order-message').textContent).toContain('order-1');
      expect(fixture.componentInstance.customerSignedIn).toBe(true);
      expect(harness.ordersByEmail.get('customer-checkout@example.local')).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('customer-order-history-flow loads saved orders for the signed-in customer', async () => {
    const savedOrder = {
      id: 'customer-order-saved',
      status: 'PLACED',
      total: 735,
      currency: 'THB',
      createdAt: '2026-10-12T08:00:00Z',
      items: [{ productName: 'Field Notebook', quantity: 3, unitPrice: 245 }]
    };
    const harness = await startBffIntegration({
      customer: {
        email: 'customer-history@example.local',
        password: 'CustomerHistory!2026',
        orders: [savedOrder]
      }
    });

    try {
      const fixture = await startCustomerFixture(harness);
      await loginCustomer(fixture, 'customer-history@example.local', 'CustomerHistory!2026');

      expect(fixture.componentInstance.profile?.email).toBe('customer-history@example.local');
      expect(fixture.componentInstance.orderHistory).toEqual([savedOrder]);
      expect(fixture.nativeElement.querySelector('.history-order').textContent).toContain('customer-order-saved');
      expect(harness.backendRequests.some((request) =>
        request.path === '/api/v1/orders/history' && request.headers.authorization === 'Bearer customer-token'))
        .toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('guest-cart-checkout-flow submits the guest cart and associates the order with the checkout email', async () => {
    const harness = await startBffIntegration();

    try {
      const fixture = await startCustomerFixture(harness);
      const guestEmail = 'guest-checkout@example.local';
      fixture.componentInstance.email = guestEmail;
      await fixture.componentInstance.checkout([{ product, quantity: 1 }]);
      expect(harness.backendRequests.some((request) => request.path === '/api/v1/orders')).toBe(false);
      await verifyGuestCheckout(fixture, guestEmail, harness.verificationCode);
      fixture.componentInstance.add(product);
      await fixture.whenStable();
      const cart = await firstValueFrom(fixture.componentInstance.cart$);

      await fixture.componentInstance.checkout(cart);
      await fixture.whenStable();

      const orderRequest = harness.backendRequests.find((request) => request.path === '/api/v1/orders');
      expect(orderRequest?.headers.authorization).toBe('Bearer guest-token');
      expect(orderRequest?.headers['x-waiting-room-ticket']).toBe('123e4567-e89b-12d3-a456-426614174001');
      expect(orderRequest?.body).toEqual({ items: [{ productId: product.id, quantity: 1 }] });
      expect(fixture.nativeElement.querySelector('.order-message').textContent).toContain('order-1');
      expect(harness.ordersByEmail.get(guestEmail)).toHaveLength(1);
      expect(fixture.componentInstance.customerSignedIn).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('guest-order-history-flow verifies the checkout email before showing its orders', async () => {
    const guestEmail = 'guest-history@example.local';
    const savedOrder = {
      id: 'guest-order-saved',
      status: 'PLACED',
      total: 245,
      currency: 'THB',
      createdAt: '2026-10-12T08:00:00Z',
      items: [{ productName: 'Field Notebook', quantity: 1, unitPrice: 245 }]
    };
    const harness = await startBffIntegration({ guestOrders: { [guestEmail]: [savedOrder] } });

    try {
      const fixture = await startCustomerFixture(harness);
      fixture.componentInstance.guestEmail = guestEmail;
      await fixture.componentInstance.requestGuestAccess();
      expect(fixture.componentInstance.guestCodeRequested).toBe(true);

      fixture.componentInstance.guestAccessCode = harness.verificationCode;
      await fixture.componentInstance.verifyGuestAccess();
      await fixture.whenStable();

      expect(fixture.componentInstance.customerSignedIn).toBe(false);
      expect(fixture.componentInstance.profile?.accountType).toBe('guest');
      expect(fixture.componentInstance.orderHistory).toEqual([savedOrder]);
      expect(fixture.nativeElement.querySelector('.history-order').textContent).toContain('guest-order-saved');
      expect(harness.backendRequests.some((request) =>
        request.path === '/api/v1/guest-access/request')).toBe(true);
      expect(harness.backendRequests.some((request) =>
        request.path === '/api/v1/guest-access/verify')).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

async function startCustomerFixture(harness: Awaited<ReturnType<typeof startBffIntegration>>): Promise<ComponentFixture<AppComponent>> {
  vi.stubGlobal('crypto', { randomUUID: () => '123e4567-e89b-12d3-a456-426614174001' });
  registerLocaleData(localeTh);
  TestBed.configureTestingModule({
    imports: [AppComponent],
    providers: [
      provideHttpClient(withInterceptors([bearerTokenInterceptor])),
      { provide: HttpBackend, useValue: new BffHttpBackend(harness.bff) },
      provideStore({ shop: shopReducer }),
      provideEffects([ProductsEffects])
    ]
  });
  const fixture = TestBed.createComponent(AppComponent);
  fixture.autoDetectChanges();
  await waitForProductCard(fixture);
  return fixture;
}

async function waitForRequest(requests: BackendRequest[], path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (requests.some((request) => request.path === path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`The frontend did not send ${path} through the BFF`);
}

async function loginCustomer(
  fixture: ComponentFixture<AppComponent>,
  email: string,
  password: string
): Promise<void> {
  fixture.componentInstance.accountEmail = email;
  fixture.componentInstance.accountPassword = password;
  await fixture.componentInstance.submitAccount();
  await fixture.whenStable();
}

async function verifyGuestCheckout(
  fixture: ComponentFixture<AppComponent>,
  email: string,
  verificationCode: string
): Promise<void> {
  fixture.componentInstance.email = email;
  await fixture.componentInstance.requestGuestCheckoutCode();
  expect(fixture.componentInstance.guestCheckoutCodeRequested).toBe(true);
  fixture.componentInstance.guestCheckoutCode = verificationCode;
  await fixture.componentInstance.verifyGuestCheckoutCode();
  expect(fixture.componentInstance.guestCheckoutAccessToken).toBeDefined();
}

async function waitForProductCard(fixture: ComponentFixture<AppComponent>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    fixture.detectChanges();
    if (fixture.nativeElement.querySelector('.product-card')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The frontend did not render products returned by the backend');
}
