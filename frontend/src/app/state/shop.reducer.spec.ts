import { describe, expect, it } from 'vitest';
import { Product } from '../models';
import { addToCart, clearCart, removeFromCart, restoreCart } from './shop.actions';
import { initialShopState, shopReducer } from './shop.reducer';
import { selectCartCount, selectCartTotal } from './shop.selectors';

describe('shopReducer', () => {
  const product: Product = {
    id: 'product-1',
    name: 'Notebook',
    description: 'Paper goods',
    price: 245,
    currency: 'THB',
    imageUrl: null
  };

  it('increments the quantity when the same product is added twice', () => {
    const once = shopReducer(initialShopState, addToCart({ product }));
    const twice = shopReducer(once, addToCart({ product }));

    expect(twice.cart).toEqual([{ product, quantity: 2 }]);
    expect(selectCartCount.projector(twice.cart)).toBe(2);
    expect(selectCartTotal.projector(twice.cart)).toBe(490);
  });

  it('removes a product and clears the cart', () => {
    const populated = shopReducer(initialShopState, addToCart({ product }));
    const removed = shopReducer(populated, removeFromCart({ productId: product.id }));
    expect(removed.cart).toEqual([]);

    const cleared = shopReducer(populated, clearCart());
    expect(cleared.cart).toEqual([]);
  });

  it('restores a previously persisted cart', () => {
    const restored = shopReducer(initialShopState, restoreCart({ cart: [{ product, quantity: 2 }] }));
    expect(restored.cart).toEqual([{ product, quantity: 2 }]);
  });
});
