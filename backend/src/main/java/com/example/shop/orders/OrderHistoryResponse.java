package com.example.shop.orders;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record OrderHistoryResponse(
        UUID id,
        String status,
        BigDecimal total,
        String currency,
        Instant createdAt,
        List<Item> items) {
    public record Item(String productName, int quantity, BigDecimal unitPrice) {}
}
