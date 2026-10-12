import { AsyncPipe, CurrencyPipe, DatePipe, DOCUMENT, NgFor, NgIf } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { Store } from '@ngrx/store';
import { filter, firstValueFrom, take } from 'rxjs';
import { AuthSessionService } from './auth-session.service';
import { CartLine, OrderHistory, OrderResponse, Product, Profile, WaitingRoomTicket } from './models';
import { addToCart, clearCart, loadProducts, loadProductsFailure, removeFromCart, restoreCart } from './state/shop.actions';
import {
  selectCart,
  selectCartCount,
  selectCartTotal,
  selectError,
  selectLoading,
  selectProducts
} from './state/shop.selectors';

interface GuestTokenResponse {
  accessToken: string;
}

interface CustomerSessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface GuestAccessResponse {
  accessToken: string;
}

interface WaitingRoomClientState {
  ticketId: string;
}

interface CreatedShortLink {
  code: string;
  url: string;
  expiresAt: string;
  productId: string;
}

@Component({
  selector: 'shop-root',
  standalone: true,
  imports: [AsyncPipe, CurrencyPipe, DatePipe, FormsModule, NgFor, NgIf],
  template: `
    <header class="topbar">
      <a class="brand" href="/" aria-label="Everyday home"><span class="brand-mark">e.</span> everyday</a>
      <a class="cart-link" href="#cart" aria-label="ไปยังตะกร้าสินค้า">
        ตะกร้า <span class="cart-count">{{ cartCount$ | async }}</span>
      </a>
    </header>

    <aside *ngIf="waitingFlow" class="waiting-room" role="status" aria-live="polite">
      <p class="eyebrow">EVERYDAY WAITING ROOM</p>
      <strong>{{ waitingFlow === 'registration' ? 'กำลังเตรียมพื้นที่สมัครสมาชิก' : 'กำลังเตรียมพื้นที่ยืนยันคำสั่งซื้อ' }}</strong>
      <p>{{ waitingPosition > 0 ? 'ขณะนี้มีคิวก่อนหน้าคุณ ' + waitingPosition + ' ราย ระบบจะตรวจสอบคิวให้อัตโนมัติ' : 'ถึงคิวของคุณแล้ว กำลังดำเนินการต่อ...' }}</p>
    </aside>

    <main>
      <section class="hero">
        <p class="eyebrow">THOUGHTFULLY MADE · EVERYDAY LIVING</p>
        <h1>สิ่งดี ๆ<br><span>สำหรับทุกวัน</span></h1>
        <p class="hero-copy">ของใช้เรียบง่ายที่เลือกมาอย่างดี<br>เพื่อวันที่ธรรมดาให้พิเศษขึ้นอีกนิด</p>
        <a class="hero-link" href="#catalog">เลือกชมสินค้า <span aria-hidden="true">↓</span></a>
        <div class="hero-orb" aria-hidden="true"><span>made for<br>your everyday</span></div>
      </section>

      <section *ngIf="featuredProduct as product" class="product-detail" aria-labelledby="product-detail-title">
        <p class="eyebrow">PRODUCT DETAILS</p>
        <h2 id="product-detail-title">{{ product.name }}</h2>
        <p>{{ product.description }}</p>
        <strong>{{ product.price | currency:product.currency:'symbol':'1.0-0':'th-TH' }}</strong>
        <button class="checkout-button" type="button" (click)="add(product)">เพิ่มลงตะกร้า</button>
        <button *ngIf="customerSignedIn" class="checkout-button" type="button"
                (click)="createShortLink(product)" [disabled]="shareBusy">สร้างลิงก์แชร์</button>
        <ng-container *ngIf="createdShortLink?.productId === product.id">
          <a [href]="createdShortLink.url">{{ createdShortLink.url }}</a>
          <button class="signout-button" type="button" (click)="revokeShortLink(createdShortLink.code)">ยกเลิกลิงก์</button>
        </ng-container>
        <a href="/#catalog">กลับไปเลือกสินค้า</a>
      </section>

      <section class="catalog" id="catalog">
        <div class="section-heading">
          <div><p class="eyebrow">THE COLLECTION</p><h2>ของโปรดชิ้นใหม่</h2></div>
          <span class="collection-count">CURATED FOR YOU</span>
        </div>
        <p *ngIf="loading$ | async" class="notice" role="status">กำลังโหลดสินค้า...</p>
        <p *ngIf="error$ | async as error" class="notice error" role="alert">{{ error }}</p>
        <div class="product-grid">
          <article class="product-card" *ngFor="let product of products$ | async; let i = index">
            <div class="product-image" [class.alt-image]="i % 2 === 1">
              <img *ngIf="product.imageUrl" [src]="product.imageUrl" [alt]="product.name" loading="lazy">
              <span class="product-number">0{{ i + 1 }}</span>
              <button class="add-button" type="button" (click)="add(product)" aria-label="เพิ่มสินค้าลงตะกร้า">+</button>
            </div>
            <div class="product-info">
              <div><h3><a [href]="'/products/' + product.id">{{ product.name }}</a></h3><p>{{ product.description }}</p></div>
              <strong>{{ product.price | currency:product.currency:'symbol':'1.0-0':'th-TH' }}</strong>
            </div>
            <div class="product-share" *ngIf="customerSignedIn">
              <button type="button" (click)="createShortLink(product)" [disabled]="shareBusy">สร้างลิงก์แชร์</button>
              <ng-container *ngIf="createdShortLink?.productId === product.id">
                <a [href]="createdShortLink.url">{{ createdShortLink.url }}</a>
                <button type="button" (click)="revokeShortLink(createdShortLink.code)">ยกเลิกลิงก์</button>
              </ng-container>
            </div>
          </article>
        </div>
      </section>

      <section class="faq" aria-labelledby="faq-title">
        <p class="eyebrow">HELPFUL ANSWERS</p>
        <h2 id="faq-title">คำถามที่พบบ่อย</h2>
        <details><summary>สั่งซื้อโดยไม่สมัครสมาชิกได้หรือไม่?</summary><p>ได้ เลือกสินค้า ใส่อีเมลสำหรับรับข้อมูลคำสั่งซื้อ แล้วทำรายการในฐานะผู้เยี่ยมชมได้</p></details>
        <details><summary>ต้องรอใน waiting room นานแค่ไหน?</summary><p>ระบบแสดงตำแหน่งคิวและตรวจสอบให้อัตโนมัติ เมื่อถึงคิวจะดำเนินการสมัครหรือยืนยันคำสั่งซื้อต่อให้ทันที</p></details>
        <details><summary>จะเก็บสินค้าในตะกร้าไว้หลังปิดหน้าเว็บหรือไม่?</summary><p>ตะกร้าจะบันทึกไว้ในอุปกรณ์ของคุณจนกว่าจะสั่งซื้อหรือลบสินค้าออก</p></details>
      </section>

      <section class="checkout" id="cart">
        <div class="checkout-intro">
          <p class="eyebrow">YOUR EVERYDAY PICKS</p><h2>ตะกร้าของคุณ</h2>
          <p class="checkout-copy">สั่งซื้อได้ง่าย ๆ ไม่ต้องสมัครสมาชิก</p>
          <div class="account-panel">
            <p class="account-heading">{{ customerSignedIn ? 'เข้าสู่ระบบด้วยบัญชีลูกค้าแล้ว' : 'มีบัญชี everyday แล้ว?' }}</p>
            <div class="account-tabs" role="group" aria-label="การจัดการบัญชี" *ngIf="!customerSignedIn">
              <button type="button" [class.selected]="accountMode === 'login'" (click)="setAccountMode('login')">เข้าสู่ระบบ</button>
              <button type="button" [class.selected]="accountMode === 'register'" (click)="setAccountMode('register')">สมัครสมาชิก</button>
              <button type="button" [class.selected]="accountMode === 'forgot'" (click)="setAccountMode('forgot')">ลืมรหัสผ่าน</button>
            </div>
            <form *ngIf="!customerSignedIn && accountMode !== 'forgot' && accountMode !== 'reset'" (ngSubmit)="submitAccount()">
              <label for="account-email">อีเมลบัญชี</label>
              <input id="account-email" name="accountEmail" type="email" [(ngModel)]="accountEmail" required email autocomplete="email">
              <label for="account-password">รหัสผ่าน (อย่างน้อย 12 ตัวอักษร)</label>
              <input id="account-password" name="accountPassword" type="password" [(ngModel)]="accountPassword"
                     required minlength="12" maxlength="72"
                     [attr.autocomplete]="accountMode === 'register' ? 'new-password' : 'current-password'">
              <button class="account-submit" type="submit" [disabled]="accountBusy">
                {{ accountMode === 'register' ? 'ส่งลิงก์ยืนยันอีเมล' : 'เข้าสู่ระบบ' }}
              </button>
            </form>
            <form *ngIf="!customerSignedIn && (accountMode === 'forgot' || accountMode === 'reset')" (ngSubmit)="submitRecovery()">
              <label for="recovery-email">อีเมลบัญชี</label>
              <input id="recovery-email" name="recoveryEmail" type="email" [(ngModel)]="accountEmail" required email>
              <button class="account-submit" type="button" (click)="requestPasswordReset()" [disabled]="accountBusy">
                ขอ token รีเซ็ตรหัสผ่าน
              </button>
              <label for="recovery-token">token จากอีเมล</label>
              <input id="recovery-token" name="recoveryToken" [(ngModel)]="recoveryToken" autocomplete="one-time-code">
              <label for="new-password">รหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร)</label>
              <input id="new-password" name="newPassword" type="password" [(ngModel)]="newPassword" minlength="12" maxlength="72">
              <button class="account-submit" type="submit" [disabled]="accountBusy">ตั้งรหัสผ่านใหม่</button>
            </form>
            <form *ngIf="!customerSignedIn && verificationRequired" (ngSubmit)="verifyEmail()">
              <label for="verification-token">token ยืนยันอีเมลจากกล่องจดหมาย</label>
              <input id="verification-token" name="verificationToken" [(ngModel)]="verificationToken" required>
              <button class="account-submit" type="submit" [disabled]="accountBusy">ยืนยันอีเมล</button>
            </form>
            <section *ngIf="!customerSignedIn && !guestAccessToken" class="profile-access">
              <h3>ดูประวัติคำสั่งซื้อแบบผู้เยี่ยมชม</h3>
              <p>ยืนยันอีเมลที่ใช้สั่งซื้อเพื่อดูโปรไฟล์และประวัติของคุณ</p>
              <form (ngSubmit)="requestGuestAccess()">
                <label for="guest-access-email">อีเมลที่ใช้สั่งซื้อ</label>
                <input id="guest-access-email" name="guestAccessEmail" type="email"
                       [(ngModel)]="guestEmail" required email autocomplete="email">
                <button class="account-submit" type="submit" [disabled]="accountBusy">ส่งรหัสยืนยัน</button>
              </form>
              <form *ngIf="guestCodeRequested" (ngSubmit)="verifyGuestAccess()">
                <label for="guest-access-code">รหัสยืนยันจากอีเมล</label>
                <input id="guest-access-code" name="guestAccessCode" [(ngModel)]="guestAccessCode"
                       required autocomplete="one-time-code">
                <button class="account-submit" type="submit" [disabled]="accountBusy">ยืนยันและดูประวัติ</button>
              </form>
            </section>
            <section *ngIf="profile as currentProfile" class="profile-content">
              <h3>{{ currentProfile.accountType === 'customer' ? 'โปรไฟล์ลูกค้า' : 'โปรไฟล์ผู้เยี่ยมชม' }}</h3>
              <form (ngSubmit)="saveProfile()">
                <label for="profile-email">อีเมล</label>
                <input id="profile-email" name="profileEmail" type="email" [value]="currentProfile.email" readonly>
                <label for="profile-name">ชื่อที่ใช้แสดง</label>
                <input id="profile-name" name="profileName" [(ngModel)]="profileDisplayName" maxlength="100">
                <button class="account-submit" type="submit" [disabled]="accountBusy">บันทึกโปรไฟล์</button>
              </form>
              <h3>ประวัติคำสั่งซื้อ</h3>
              <p *ngIf="orderHistory.length === 0" class="empty-cart">ยังไม่มีคำสั่งซื้อ</p>
              <article class="history-order" *ngFor="let order of orderHistory">
                <div class="history-order-heading">
                  <strong>{{ order.id }}</strong>
                  <span>{{ order.status }} · {{ order.createdAt | date:'medium' }}</span>
                </div>
                <div class="history-order-item" *ngFor="let item of order.items">
                  <span>{{ item.productName }} × {{ item.quantity }}</span>
                  <span>{{ item.unitPrice * item.quantity | currency:order.currency:'symbol':'1.0-0':'th-TH' }}</span>
                </div>
                <strong class="history-order-total">รวม {{ order.total | currency:order.currency:'symbol':'1.0-0':'th-TH' }}</strong>
              </article>
            </section>
            <button *ngIf="customerSignedIn" class="signout-button" type="button" (click)="signOut()">ออกจากระบบ</button>
            <button *ngIf="guestAccessToken" class="signout-button" type="button" (click)="endGuestAccess()">ปิดประวัติผู้เยี่ยมชม</button>
            <p *ngIf="accountMessage" class="order-message" role="status">{{ accountMessage }}</p>
          </div>
        </div>
        <div class="checkout-panel">
          <ng-container *ngIf="cart$ | async as cart">
            <p *ngIf="cart.length === 0" class="empty-cart">ยังไม่มีสินค้าในตะกร้า — ลองเลือกชิ้นที่ชอบดูนะ</p>
            <div class="cart-line" *ngFor="let line of cart">
              <span>{{ line.product.name }} <small>× {{ line.quantity }}</small></span>
              <span>{{ line.product.price * line.quantity | currency:line.product.currency:'symbol':'1.0-0':'th-TH' }}
                <button class="remove-button" type="button" (click)="remove(line.product.id)" aria-label="นำสินค้าออก">×</button>
              </span>
            </div>
            <div class="cart-total" *ngIf="cart.length > 0">
              <span>รวมทั้งหมด</span><strong>{{ (cartTotal$ | async) ?? 0 | currency:'THB':'symbol':'1.0-0':'th-TH' }}</strong>
            </div>
            <form class="checkout-form" (ngSubmit)="checkout(cart)" *ngIf="cart.length > 0">
              <label for="email">อีเมลสำหรับรับข้อมูลคำสั่งซื้อ</label>
              <div class="checkout-fields">
                <input id="email" name="email" type="email" [(ngModel)]="email"
                       (ngModelChange)="onCheckoutEmailChange($event)" required email placeholder="you@example.com">
                <button *ngIf="!customerSignedIn && !guestCheckoutAccessToken" class="checkout-button"
                        type="button" (click)="requestGuestCheckoutCode()" [disabled]="submitting">
                  ส่งรหัส OTP
                </button>
                <button *ngIf="customerSignedIn || guestCheckoutAccessToken" class="checkout-button"
                        type="submit" [disabled]="submitting || (!customerSignedIn && !guestCheckoutEmailVerified)">
                  ยืนยันคำสั่งซื้อ <span aria-hidden="true">→</span>
                </button>
              </div>
              <ng-container *ngIf="!customerSignedIn && guestCheckoutCodeRequested && !guestCheckoutAccessToken">
                <label for="guest-checkout-code">รหัส OTP จากอีเมล</label>
                <div class="checkout-fields">
                  <input id="guest-checkout-code" name="guestCheckoutCode" [(ngModel)]="guestCheckoutCode"
                         required autocomplete="one-time-code">
                  <button class="checkout-button" type="button" (click)="verifyGuestCheckoutCode()"
                          [disabled]="submitting">ยืนยัน OTP</button>
                </div>
              </ng-container>
            </form>
          </ng-container>
          <p *ngIf="message" class="order-message" role="status">{{ message }}</p>
        </div>
      </section>
    </main>
    <footer><a class="brand" href="/"><span class="brand-mark">e.</span> everyday</a><span>ของดีที่อยู่กับคุณในทุกวัน</span><small>© 2026 Everyday Store</small></footer>
  `
})
export class AppComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly http = inject(HttpClient);
  private readonly authSession = inject(AuthSessionService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly document = inject(DOCUMENT);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  readonly products$ = this.store.select(selectProducts);
  readonly cart$ = this.store.select(selectCart);
  readonly cartCount$ = this.store.select(selectCartCount);
  readonly cartTotal$ = this.store.select(selectCartTotal);
  readonly loading$ = this.store.select(selectLoading);
  readonly error$ = this.store.select(selectError);
  email = '';
  guestCheckoutCode = '';
  guestCheckoutCodeRequested = false;
  guestCheckoutAccessToken: string | null = null;
  private guestCheckoutCodeEmail = '';
  private guestCheckoutVerifiedEmail = '';
  message = '';
  submitting = false;
  accountMode: 'login' | 'register' | 'forgot' | 'reset' = 'login';
  accountEmail = '';
  accountPassword = '';
  recoveryToken = '';
  newPassword = '';
  verificationToken = '';
  verificationRequired = false;
  accountMessage = '';
  accountBusy = false;
  customerSignedIn = false;
  guestEmail = '';
  guestAccessCode = '';
  guestCodeRequested = false;
  guestAccessToken: string | null = null;
  profile: Profile | null = null;
  profileDisplayName = '';
  orderHistory: OrderHistory[] = [];
  private checkoutIdempotencyKey: string | null = null;
  featuredProduct: Product | null = null;
  waitingFlow: 'registration' | 'checkout' | null = null;
  waitingPosition = 0;
  createdShortLink: CreatedShortLink | null = null;
  shareBusy = false;

  get guestCheckoutEmailVerified(): boolean {
    return this.guestCheckoutAccessToken !== null
      && this.guestCheckoutVerifiedEmail === this.email.trim().toLowerCase();
  }

  ngOnInit(): void {
    this.store.dispatch(restoreCart({ cart: this.readSavedCart() }));
    this.cart$.subscribe((cart) => this.saveCart(cart));
    this.installDiscoveryMetadata();
    void this.initializeAnonymousSession();
  }

  private async initializeAnonymousSession(): Promise<void> {
    try {
      const token = await firstValueFrom(this.http.post<GuestTokenResponse>('/api/v1/auth/anonymous', {}));
      this.authSession.setAccessToken(token.accessToken);
      this.store.dispatch(loadProducts());
      const products = await firstValueFrom(this.products$.pipe(
        filter((items) => items.length > 0),
        take(1)
      ));
      this.featuredProduct = products.find((product) =>
        this.document.location.pathname === `/products/${product.id}`) ?? null;
      this.updateProductMetadata(this.featuredProduct);
    } catch {
      this.store.dispatch(loadProductsFailure({ error: 'เชื่อมต่อบริการสินค้าไม่สำเร็จ' }));
    } finally {
      this.changeDetector.markForCheck();
    }
  }

  setAccountMode(mode: 'login' | 'register' | 'forgot'): void {
    this.accountMode = mode;
    this.accountMessage = '';
    this.verificationRequired = false;
  }

  async submitAccount(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    this.accountMessage = '';
    try {
      if (this.accountMode === 'register') {
        const ticket = await this.waitForAdmission('registration');
        await firstValueFrom(this.http.post('/api/v1/auth/register', {
          email: this.accountEmail,
          password: this.accountPassword
        }, { headers: { 'X-Waiting-Room-Ticket': ticket } }));
        this.verificationRequired = true;
        this.accountMessage = 'หากสมัครได้ ระบบส่ง token ยืนยันไปยังอีเมลแล้ว';
      } else {
        const session = await firstValueFrom(
          this.http.post<CustomerSessionResponse>('/api/v1/auth/login', {
            email: this.accountEmail,
            password: this.accountPassword
          })
        );
        this.authSession.setCustomerSession(session.accessToken, session.refreshToken);
        this.checkoutIdempotencyKey = null;
        this.customerSignedIn = true;
        this.accountMessage = 'เข้าสู่ระบบแล้ว คำสั่งซื้อใหม่จะผูกกับบัญชีของคุณ';
        await this.loadProfileAndHistory();
      }
    } catch {
      this.accountMessage = this.accountMode === 'register'
        ? 'สมัครหรือส่งอีเมลยืนยันไม่สำเร็จ กรุณาลองอีกครั้ง'
        : 'เข้าสู่ระบบไม่สำเร็จ ตรวจสอบข้อมูลหรือยืนยันอีเมลก่อน';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async verifyEmail(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    try {
      await firstValueFrom(this.http.post('/api/v1/auth/verify-email', { token: this.verificationToken }));
      this.accountMode = 'login';
      this.accountPassword = '';
      this.verificationRequired = false;
      this.accountMessage = 'ยืนยันอีเมลสำเร็จ เข้าสู่ระบบได้แล้ว';
    } catch {
      this.accountMessage = 'token ไม่ถูกต้องหรือหมดอายุ';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async requestPasswordReset(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    try {
      await firstValueFrom(this.http.post('/api/v1/auth/password/forgot', { email: this.accountEmail }));
      this.accountMode = 'reset';
      this.accountMessage = 'หากบัญชีมีอยู่ ระบบส่ง token รีเซ็ตไปยังอีเมลแล้ว';
    } catch {
      this.accountMessage = 'ไม่สามารถส่งคำขอได้ กรุณาลองใหม่ภายหลัง';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async submitRecovery(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    try {
      await firstValueFrom(this.http.post('/api/v1/auth/password/reset', {
        token: this.recoveryToken,
        newPassword: this.newPassword
      }));
      this.accountMode = 'login';
      this.accountPassword = '';
      this.newPassword = '';
      this.recoveryToken = '';
      this.accountMessage = 'เปลี่ยนรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบใหม่';
    } catch {
      this.accountMessage = 'token ไม่ถูกต้อง หมดอายุ หรือรหัสผ่านไม่ผ่านเงื่อนไข';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async requestGuestAccess(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    this.accountMessage = '';
    try {
      await firstValueFrom(this.http.post('/api/v1/guest-access/request', { email: this.guestEmail }));
      this.guestCodeRequested = true;
      this.accountMessage = 'หากมีคำสั่งซื้อที่ใช้อีเมลนี้ ระบบจะส่งรหัสยืนยันให้';
    } catch {
      this.accountMessage = 'ส่งคำขอไม่สำเร็จ กรุณาตรวจสอบอีเมลและลองใหม่';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async verifyGuestAccess(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    this.accountMessage = '';
    try {
      const session = await firstValueFrom(this.http.post<GuestAccessResponse>(
        '/api/v1/guest-access/verify',
        { email: this.guestEmail, token: this.guestAccessCode }
      ));
      this.guestAccessToken = session.accessToken;
      this.guestEmail = this.guestEmail.trim().toLowerCase();
      this.guestAccessCode = '';
      this.guestCodeRequested = false;
      await this.loadProfileAndHistory(session.accessToken);
    } catch {
      this.accountMessage = 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  onCheckoutEmailChange(email: string): void {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail !== this.guestCheckoutCodeEmail
        && normalizedEmail !== this.guestCheckoutVerifiedEmail) {
      this.guestCheckoutCode = '';
      this.guestCheckoutCodeRequested = false;
      this.guestCheckoutAccessToken = null;
      this.guestCheckoutCodeEmail = '';
      this.guestCheckoutVerifiedEmail = '';
    }
  }

  async requestGuestCheckoutCode(): Promise<void> {
    if (this.submitting || this.customerSignedIn) return;
    const email = this.email.trim().toLowerCase();
    if (!email) {
      this.message = 'กรุณากรอกอีเมลก่อนขอรหัส OTP';
      return;
    }
    this.submitting = true;
    this.message = '';
    try {
      await firstValueFrom(this.http.post('/api/v1/guest-access/checkout/request', { email }));
      this.guestCheckoutCodeEmail = email;
      this.guestCheckoutCode = '';
      this.guestCheckoutCodeRequested = true;
      this.message = 'ส่งรหัส OTP ไปยังอีเมลแล้ว กรุณายืนยันก่อนสั่งซื้อ';
    } catch {
      this.message = 'ส่งรหัส OTP ไม่สำเร็จ กรุณาตรวจสอบอีเมลแล้วลองอีกครั้ง';
    } finally {
      this.submitting = false;
      this.changeDetector.markForCheck();
    }
  }

  async verifyGuestCheckoutCode(): Promise<void> {
    if (this.submitting || this.customerSignedIn || !this.guestCheckoutCodeRequested) return;
    const email = this.email.trim().toLowerCase();
    if (!email || email !== this.guestCheckoutCodeEmail || !this.guestCheckoutCode.trim()) {
      this.message = 'กรุณาใช้รหัส OTP ที่ส่งไปยังอีเมลปัจจุบัน';
      return;
    }
    this.submitting = true;
    this.message = '';
    try {
      const session = await firstValueFrom(this.http.post<GuestAccessResponse>(
        '/api/v1/guest-access/checkout/verify',
        { email, token: this.guestCheckoutCode }
      ));
      if (this.email.trim().toLowerCase() !== email) {
        this.message = 'อีเมลเปลี่ยนระหว่างยืนยัน กรุณาขอรหัส OTP ใหม่';
        return;
      }
      this.guestCheckoutAccessToken = session.accessToken;
      this.guestCheckoutVerifiedEmail = email;
      this.guestCheckoutCode = '';
      this.guestCheckoutCodeRequested = false;
      this.message = 'ยืนยันอีเมลสำเร็จ สามารถยืนยันคำสั่งซื้อได้แล้ว';
    } catch {
      this.message = 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่';
    } finally {
      this.submitting = false;
      this.changeDetector.markForCheck();
    }
  }

  async saveProfile(): Promise<void> {
    if (this.accountBusy) return;
    this.accountBusy = true;
    try {
      const options = this.profileAuthorization();
      this.profile = await firstValueFrom(this.http.put<Profile>(
        '/api/v1/profile', { displayName: this.profileDisplayName }, options));
      this.profileDisplayName = this.profile.displayName ?? '';
      this.accountMessage = 'บันทึกโปรไฟล์แล้ว';
    } catch {
      this.accountMessage = 'บันทึกโปรไฟล์ไม่สำเร็จ กรุณาลองใหม่';
    } finally {
      this.accountBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  endGuestAccess(): void {
    this.guestAccessToken = null;
    this.profile = null;
    this.profileDisplayName = '';
    this.orderHistory = [];
    this.guestAccessCode = '';
    this.accountMessage = '';
  }

  private async loadProfileAndHistory(token?: string): Promise<void> {
    try {
      const options = this.profileAuthorization(token);
      const [profile, history] = await Promise.all([
        firstValueFrom(this.http.get<Profile>('/api/v1/profile', options)),
        firstValueFrom(this.http.get<OrderHistory[]>('/api/v1/orders/history', options))
      ]);
      this.profile = profile;
      this.profileDisplayName = profile.displayName ?? '';
      this.orderHistory = history;
    } catch {
      this.profile = null;
      this.orderHistory = [];
      this.accountMessage = 'โหลดโปรไฟล์หรือประวัติคำสั่งซื้อไม่สำเร็จ กรุณาลองใหม่';
    } finally {
      this.changeDetector.markForCheck();
    }
  }

  private profileAuthorization(token?: string): { headers?: HttpHeaders } {
    const accessToken = token ?? this.guestAccessToken;
    return accessToken
      ? { headers: new HttpHeaders({ Authorization: `Bearer ${accessToken}` }) }
      : {};
  }

  signOut(): void {
    const refreshToken = this.authSession.refreshToken;
    if (refreshToken) {
      void firstValueFrom(this.http.post('/api/v1/auth/logout', { refreshToken })).catch(() => {
        this.accountMessage = 'ออกจากระบบเฉพาะอุปกรณ์นี้แล้ว แต่ยกเลิก refresh token ที่เซิร์ฟเวอร์ไม่สำเร็จ';
        this.changeDetector.markForCheck();
      });
    }
    this.authSession.clear();
    this.customerSignedIn = false;
    this.accountMessage = '';
    this.profile = null;
    this.profileDisplayName = '';
    this.orderHistory = [];
    this.checkoutIdempotencyKey = null;
    void this.initializeAnonymousSession();
  }

  add(product: Product): void {
    this.store.dispatch(addToCart({ product }));
    this.checkoutIdempotencyKey = null;
    this.message = '';
  }

  remove(productId: string): void {
    this.store.dispatch(removeFromCart({ productId }));
    this.checkoutIdempotencyKey = null;
  }

  async createShortLink(product: Product): Promise<void> {
    if (this.shareBusy) return;
    this.shareBusy = true;
    try {
      const result = await firstValueFrom(this.http.post<Omit<CreatedShortLink, 'productId'>>(
        '/api/v1/short-links', { productId: product.id, expiresInSeconds: 2_592_000 }));
      this.createdShortLink = { ...result, productId: product.id };
      try {
        await navigator.clipboard.writeText(result.url);
        this.message = 'คัดลอกลิงก์แชร์แล้ว';
      } catch {
        this.message = `สร้างลิงก์แล้ว: ${result.url}`;
      }
    } catch {
      this.message = 'สร้างลิงก์แชร์ไม่สำเร็จ กรุณาลองใหม่';
    } finally {
      this.shareBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async revokeShortLink(code: string): Promise<void> {
    if (!code) return;
    try {
      await firstValueFrom(this.http.delete(`/api/v1/short-links/${code}`));
      this.createdShortLink = null;
      this.message = 'ยกเลิกลิงก์แชร์แล้ว';
    } catch {
      this.message = 'ยกเลิกลิงก์ไม่สำเร็จ กรุณาลองใหม่';
    } finally {
      this.changeDetector.markForCheck();
    }
  }

  async checkout(cart: CartLine[]): Promise<void> {
    if (cart.length === 0 || this.submitting) return;
    if (!this.customerSignedIn
        && (!this.guestCheckoutAccessToken
          || this.guestCheckoutVerifiedEmail !== this.email.trim().toLowerCase())) {
      this.message = 'ยืนยันอีเมลด้วยรหัส OTP ก่อนส่งคำสั่งซื้อ';
      return;
    }
    this.submitting = true;
    this.message = '';
    try {
      const accessToken = this.customerSignedIn
        ? this.authSession.accessToken
        : this.guestCheckoutAccessToken;
      if (!this.customerSignedIn) {
        const ticket = await this.waitForAdmission('checkout');
        this.authSession.setWaitingRoomTicket(ticket);
      }
      this.checkoutIdempotencyKey ??= crypto.randomUUID();
      const order = await firstValueFrom(
        this.http.post<OrderResponse>(
          '/api/v1/orders',
          { items: cart.map((line) => ({ productId: line.product.id, quantity: line.quantity })) },
          { headers: { Authorization: `Bearer ${accessToken}`, 'Idempotency-Key': this.checkoutIdempotencyKey } }
        )
      );
      this.store.dispatch(clearCart());
      this.checkoutIdempotencyKey = null;
      this.message = `รับคำสั่งซื้อ ${order.id} เรียบร้อยแล้ว ขอบคุณที่เลือก everyday`;
      this.email = '';
      this.guestCheckoutCode = '';
      this.guestCheckoutCodeRequested = false;
      this.guestCheckoutAccessToken = null;
      this.guestCheckoutCodeEmail = '';
      this.guestCheckoutVerifiedEmail = '';
    } catch {
      this.message = 'สั่งซื้อไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง';
    } finally {
      this.authSession.setWaitingRoomTicket(null);
      this.submitting = false;
      this.changeDetector.markForCheck();
    }
  }

  private async waitForAdmission(flow: 'registration' | 'checkout'): Promise<string> {
    this.waitingFlow = flow;
    this.waitingPosition = 0;
    const storageKey = `shop.waiting-room.${flow}`;
    let saved = this.readWaitingState(storageKey);
    try {
      for (;;) {
        let ticket: WaitingRoomTicket;
        if (saved) {
          ticket = await firstValueFrom(this.http.get<WaitingRoomTicket>(
            `/api/v1/waiting-room/${flow}/tickets/${saved.ticketId}`));
          if (ticket.state === 'expired') {
            localStorage.removeItem(storageKey);
            saved = null;
            continue;
          }
        } else {
          saved = { ticketId: crypto.randomUUID() };
          ticket = await firstValueFrom(this.http.post<WaitingRoomTicket>(
            `/api/v1/waiting-room/${flow}/tickets`, { ticketId: saved.ticketId }));
          localStorage.setItem(storageKey, JSON.stringify(saved));
        }
        this.waitingPosition = ticket.position;
        this.changeDetector.markForCheck();
        if (ticket.state === 'admitted') {
          localStorage.removeItem(storageKey);
          return ticket.ticketId;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, ticket.retryAfterSeconds) * 1000));
      }
    } finally {
      this.waitingFlow = null;
      this.changeDetector.markForCheck();
    }
  }

  private readWaitingState(storageKey: string): WaitingRoomClientState | null {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (typeof value === 'object' && value !== null
          && 'ticketId' in value && typeof value.ticketId === 'string'
          && /^[0-9a-f-]{36}$/i.test(value.ticketId)) {
        return { ticketId: value.ticketId };
      }
    } catch {
      localStorage.removeItem(storageKey);
    }
    return null;
  }

  private readSavedCart(): CartLine[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('shop.cart.v1') ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter((line): line is CartLine => this.isCartLine(line));
    } catch {
      localStorage.removeItem('shop.cart.v1');
      return [];
    }
  }

  private isCartLine(value: unknown): value is CartLine {
    if (typeof value !== 'object' || value === null || !('product' in value) || !('quantity' in value)) return false;
    const line = value as { product?: unknown; quantity?: unknown };
    if (!Number.isInteger(line.quantity) || Number(line.quantity) < 1 || Number(line.quantity) > 50) return false;
    if (typeof line.product !== 'object' || line.product === null) return false;
    const product = line.product as Partial<Product>;
    return typeof product.id === 'string' && typeof product.name === 'string'
      && typeof product.description === 'string' && typeof product.price === 'number'
      && typeof product.currency === 'string'
      && (product.imageUrl === null || typeof product.imageUrl === 'string');
  }

  private saveCart(cart: CartLine[]): void {
    try {
      localStorage.setItem('shop.cart.v1', JSON.stringify(cart));
    } catch (error) {
      console.warn('Unable to persist the cart in this browser', error);
    }
  }

  private installDiscoveryMetadata(): void {
    this.title.setTitle('Everyday — ของใช้ที่เลือกมาอย่างดี');
    this.meta.updateTag({ name: 'description', content: 'เลือกซื้อของใช้ประจำวันคุณภาพดี ส่งตรงถึงบ้าน' });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:site_name', content: 'Everyday' });
    this.setStructuredData(this.faqStructuredData());
  }

  private updateProductMetadata(product: Product | null): void {
    const canonical = product
      ? `${this.document.location.origin}/products/${product.id}`
      : `${this.document.location.origin}/`;
    this.title.setTitle(product ? `${product.name} — Everyday` : 'Everyday — ของใช้ที่เลือกมาอย่างดี');
    this.meta.updateTag({
      name: 'description',
      content: product ? `${product.name}: ${product.description}` : 'เลือกซื้อของใช้ประจำวันคุณภาพดี ส่งตรงถึงบ้าน'
    });
    this.meta.updateTag({ property: 'og:title', content: product ? `${product.name} — Everyday` : 'Everyday' });
    this.meta.updateTag({ property: 'og:description', content: product?.description ?? 'ของใช้ประจำวันคุณภาพดี' });
    this.meta.updateTag({ property: 'og:url', content: canonical });
    if (product?.imageUrl) this.meta.updateTag({ property: 'og:image', content: product.imageUrl });
    let link = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.rel = 'canonical';
      this.document.head.appendChild(link);
    }
    link.href = canonical;
    if (product) {
      this.setStructuredData({
        '@context': 'https://schema.org',
        '@graph': [
          this.faqStructuredData(),
          {
            '@type': 'Product',
            name: product.name,
            description: product.description,
            image: product.imageUrl,
            sku: product.id,
            offers: {
              '@type': 'Offer',
              price: product.price,
              priceCurrency: product.currency,
              availability: 'https://schema.org/InStock',
              url: canonical
            }
          }
        ]
      });
    } else {
      this.setStructuredData(this.faqStructuredData());
    }
  }

  private faqStructuredData(): Record<string, unknown> {
    return {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        ['สั่งซื้อโดยไม่สมัครสมาชิกได้หรือไม่?', 'ได้ เลือกสินค้าและทำรายการในฐานะผู้เยี่ยมชมได้'],
        ['ต้องรอใน waiting room นานแค่ไหน?', 'ระบบแสดงตำแหน่งคิวและตรวจสอบให้อัตโนมัติ'],
        ['จะเก็บสินค้าในตะกร้าไว้หลังปิดหน้าเว็บหรือไม่?', 'ตะกร้าบันทึกไว้ในอุปกรณ์จนกว่าจะสั่งซื้อหรือลบสินค้า']
      ].map(([name, text]) => ({
        '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text }
      }))
    };
  }

  private setStructuredData(data: object): void {
    let script = this.document.getElementById('structured-data');
    if (!script) {
      script = this.document.createElement('script');
      script.id = 'structured-data';
      script.setAttribute('type', 'application/ld+json');
      this.document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);
  }
}
