package com.example.shop.orders;

import java.math.BigDecimal;
import java.util.UUID;

public record OrderResponse(UUID id, String status, BigDecimal total, String currency) {}
