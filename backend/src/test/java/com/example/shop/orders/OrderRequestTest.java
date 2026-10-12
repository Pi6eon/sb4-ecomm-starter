package com.example.shop.orders;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

class OrderRequestTest {
    @Test
    void preservesRequestedItems() {
        var productId = UUID.randomUUID();
        var request = new OrderRequest(List.of(new OrderRequest.Item(productId, 2)));

        assertEquals(productId, request.items().get(0).productId());
        assertEquals(2, request.items().get(0).quantity());
    }
}
