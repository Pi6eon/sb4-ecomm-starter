import { registerLocaleData } from '@angular/common';
import localeTh from '@angular/common/locales/th';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideEffects } from '@ngrx/effects';
import { provideStore } from '@ngrx/store';
import { AppComponent } from './app/app.component';
import { bearerTokenInterceptor } from './app/bearer-token.interceptor';
import { ProductsEffects } from './app/state/products.effects';
import { shopReducer } from './app/state/shop.reducer';

registerLocaleData(localeTh);

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(withInterceptors([bearerTokenInterceptor])),
    provideStore({ shop: shopReducer }),
    provideEffects([ProductsEffects])
  ]
}).catch((error: unknown) => console.error('Unable to start storefront', error));
