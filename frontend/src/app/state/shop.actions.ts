import { createAction, props } from '@ngrx/store';
import { CartLine, Product } from '../models';

export const loadProducts = createAction('[Catalog] Load products');
export const loadProductsSuccess = createAction(
  '[Catalog] Load products success',
  props<{ products: Product[] }>()
);
export const loadProductsFailure = createAction(
  '[Catalog] Load products failure',
  props<{ error: string }>()
);
export const addToCart = createAction('[Cart] Add product', props<{ product: Product }>());
export const removeFromCart = createAction('[Cart] Remove product', props<{ productId: string }>());
export const clearCart = createAction('[Cart] Clear cart');
export const restoreCart = createAction('[Cart] Restore', props<{ cart: CartLine[] }>());
