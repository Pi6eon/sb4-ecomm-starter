import { createReducer, on } from '@ngrx/store';
import { CartLine, Product } from '../models';
import {
  addToCart,
  clearCart,
  loadProducts,
  loadProductsFailure,
  loadProductsSuccess,
  removeFromCart,
  restoreCart
} from './shop.actions';

export interface ShopState {
  products: Product[];
  cart: CartLine[];
  loading: boolean;
  error: string | null;
}

export const initialShopState: ShopState = {
  products: [],
  cart: [],
  loading: false,
  error: null
};

export const shopReducer = createReducer(
  initialShopState,
  on(loadProducts, (state) => ({ ...state, loading: true, error: null })),
  on(loadProductsSuccess, (state, { products }) => ({ ...state, products, loading: false })),
  on(loadProductsFailure, (state, { error }) => ({ ...state, loading: false, error })),
  on(addToCart, (state, { product }) => {
    const existing = state.cart.find((line) => line.product.id === product.id);
    const cart = existing
      ? state.cart.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line
        )
      : [...state.cart, { product, quantity: 1 }];
    return { ...state, cart };
  }),
  on(removeFromCart, (state, { productId }) => ({
    ...state,
    cart: state.cart.filter((line) => line.product.id !== productId)
  })),
  on(clearCart, (state) => ({ ...state, cart: [] })),
  on(restoreCart, (state, { cart }) => ({ ...state, cart }))
);
