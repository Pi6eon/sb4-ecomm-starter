import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, map, of, switchMap } from 'rxjs';
import { Product } from '../models';
import { loadProducts, loadProductsFailure, loadProductsSuccess } from './shop.actions';

@Injectable()
export class ProductsEffects {
  private readonly actions$ = inject(Actions);
  private readonly http = inject(HttpClient);

  readonly loadProducts$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadProducts),
      switchMap(() =>
        this.http.get<Product[]>('/api/v1/products').pipe(
          map((products) => loadProductsSuccess({ products })),
          catchError(() => of(loadProductsFailure({ error: 'โหลดสินค้าไม่สำเร็จ กรุณาลองใหม่' })))
        )
      )
    )
  );
}
