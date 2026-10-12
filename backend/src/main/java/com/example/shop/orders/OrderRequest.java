package com.example.shop.orders;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.UUID;

public record OrderRequest(@NotEmpty @Size(max = 50) List<@Valid Item> items) {
    public record Item(@NotNull UUID productId, @Positive int quantity) {}
}
