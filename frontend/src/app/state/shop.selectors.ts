import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ShopState } from './shop.reducer';

export const selectShop = createFeatureSelector<ShopState>('shop');
export const selectProducts = createSelector(selectShop, (state) => state.products);
export const selectCart = createSelector(selectShop, (state) => state.cart);
export const selectLoading = createSelector(selectShop, (state) => state.loading);
export const selectError = createSelector(selectShop, (state) => state.error);
export const selectCartCount = createSelector(selectCart, (cart) =>
  cart.reduce((count, line) => count + line.quantity, 0)
);
export const selectCartTotal = createSelector(selectCart, (cart) =>
  cart.reduce((total, line) => total + line.product.price * line.quantity, 0)
);
