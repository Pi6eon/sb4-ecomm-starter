import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { registerLocaleData } from '@angular/common';
import localeTh from '@angular/common/locales/th';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provideEffects } from '@ngrx/effects';
import { provideStore } from '@ngrx/store';
import { AuthSessionService } from './auth-session.service';
import { AppComponent } from './app.component';
import { bearerTokenInterceptor } from './bearer-token.interceptor';
import { Product } from './models';
import { ProductsEffects } from './state/products.effects';
import { shopReducer } from './state/shop.reducer';

const product: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Field Notebook',
  description: 'A notebook for everyday notes',
  price: 245,
  currency: 'THB',
  imageUrl: null
};

describe('AppComponent', () => {
  beforeEach(async () => {
    registerLocaleData(localeTh);
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideHttpClient(withInterceptors([bearerTokenInterceptor])),
        provideHttpClientTesting(),
        provideStore({ shop: shopReducer }),
        provideEffects([ProductsEffects])
      ]
    }).compileComponents();
    localStorage.clear();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('loads products through the API and adds the selected product to the cart', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    http.expectOne('/api/v1/auth/anonymous').flush({ accessToken: 'anonymous-token' });
    await fixture.whenStable();

    const productsRequest = http.expectOne('/api/v1/products');
    expect(productsRequest.request.headers.get('Authorization')).toBe('Bearer anonymous-token');
    productsRequest.flush([product]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.brand').textContent).toContain('everyday');
    expect(fixture.nativeElement.querySelector('.product-card').textContent).toContain(product.name);

    fixture.componentInstance.add(product);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cart-line').textContent).toContain(product.name);
    expect(JSON.parse(localStorage.getItem('shop.cart.v1') ?? '[]')).toEqual([{ product, quantity: 1 }]);
    expect(TestBed.inject(AuthSessionService).accessToken).toBe('anonymous-token');
  });

  it('registers, verifies, and signs in a customer through the account form', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.autoDetectChanges();

    http.expectOne('/api/v1/auth/anonymous').flush({ accessToken: 'anonymous-token' });
    await fixture.whenStable();
    http.expectOne('/api/v1/products').flush([product]);
    await fixture.whenStable();

    fixture.componentInstance.accountMode = 'register';
    fixture.componentInstance.accountEmail = 'customer@example.local';
    fixture.componentInstance.accountPassword = 'EverydayTest!2026';
    const registration = fixture.componentInstance.submitAccount();
    http.expectOne('/api/v1/waiting-room/registration/tickets').flush({
      ticketId: '123e4567-e89b-12d3-a456-426614174001',
      state: 'admitted',
      position: 0,
      retryAfterSeconds: 1
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('/api/v1/auth/register').flush({ message: 'Verification email sent.' });
    await registration;
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('#verification-token')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.account-panel .order-message').textContent)
      .toContain('token ยืนยัน');

    fixture.componentInstance.verificationToken = 'one-time-token';
    const verification = fixture.componentInstance.verifyEmail();
    http.expectOne('/api/v1/auth/verify-email').flush({ message: 'Email verified.' });
    await verification;
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('#verification-token')).toBeNull();
    expect(fixture.nativeElement.querySelector('.account-panel .order-message').textContent)
      .toContain('ยืนยันอีเมลสำเร็จ');

    const login = fixture.componentInstance.submitAccount();
    http.expectOne('/api/v1/auth/login').flush({
      accessToken: 'customer-access-token',
      refreshToken: 'customer-refresh-token',
      expiresIn: 900
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const profileRequest = http.expectOne('/api/v1/profile');
    expect(profileRequest.request.headers.get('Authorization')).toMatch(/^Bearer /);
    profileRequest.flush({ email: 'customer@example.local', displayName: 'Everyday Customer', accountType: 'customer' });
    const historyRequest = http.expectOne('/api/v1/orders/history');
    expect(historyRequest.request.headers.get('Authorization')).toMatch(/^Bearer /);
    historyRequest.flush([{
      id: '123e4567-e89b-12d3-a456-426614174009',
      status: 'PLACED',
      total: 490,
      currency: 'THB',
      createdAt: '2026-10-11T03:00:00Z',
      items: [{ productName: 'Field Notebook', quantity: 2, unitPrice: 245 }]
    }]);
    await login;
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.signout-button')).not.toBeNull();
    expect(fixture.componentInstance.profileDisplayName).toBe('Everyday Customer');
    expect(fixture.componentInstance.profile?.email).toBe('customer@example.local');
    expect(fixture.nativeElement.querySelector('.history-order').textContent).toContain('Field Notebook');
    expect(fixture.nativeElement.querySelector('.account-panel .order-message').textContent)
      .toContain('เข้าสู่ระบบแล้ว');
  });

  it('verifies a guest email before loading guest profile and order history', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.autoDetectChanges();

    http.expectOne('/api/v1/auth/anonymous').flush({ accessToken: 'anonymous-token' });
    await fixture.whenStable();
    http.expectOne('/api/v1/products').flush([product]);
    await fixture.whenStable();

    fixture.componentInstance.guestEmail = 'guest@example.local';
    const requestCode = fixture.componentInstance.requestGuestAccess();
    http.expectOne('/api/v1/guest-access/request').flush({
      message: 'If guest orders exist for this email, an access code will be sent.'
    });
    await requestCode;

    fixture.componentInstance.guestAccessCode = 'guest-email-code';
    const verify = fixture.componentInstance.verifyGuestAccess();
    http.expectOne('/api/v1/guest-access/verify').flush({ accessToken: 'verified-guest-token' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const profileRequest = http.expectOne('/api/v1/profile');
    expect(profileRequest.request.headers.get('Authorization')).toMatch(/^Bearer /);
    profileRequest.flush({ email: 'guest@example.local', displayName: null, accountType: 'guest' });
    const historyRequest = http.expectOne('/api/v1/orders/history');
    expect(historyRequest.request.headers.get('Authorization')).toMatch(/^Bearer /);
    historyRequest.flush([{
      id: '123e4567-e89b-12d3-a456-426614174009',
      status: 'PLACED',
      total: 490,
      currency: 'THB',
      createdAt: '2026-10-11T03:00:00Z',
      items: [{ productName: 'Field Notebook', quantity: 2, unitPrice: 245 }]
    }]);
    await verify;
    await fixture.whenStable();

    expect(fixture.componentInstance.customerSignedIn).toBe(false);
    expect(fixture.componentInstance.profile?.email).toBe('guest@example.local');
    expect(fixture.nativeElement.querySelector('.history-order').textContent).toContain('Field Notebook');
  });
});
