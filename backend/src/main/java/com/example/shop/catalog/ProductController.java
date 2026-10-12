package com.example.shop.catalog;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/products")
public class ProductController {
    private final CatalogService products;

    public ProductController(CatalogService products) {
        this.products = products;
    }

    @GetMapping
    List<Product> list() {
        return products.findActive();
    }

    @GetMapping("/{id}")
    Product get(@PathVariable UUID id) {
        return products.findActiveById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
    }
}
