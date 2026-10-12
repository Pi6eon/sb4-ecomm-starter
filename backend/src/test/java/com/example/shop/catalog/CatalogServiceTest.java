package com.example.shop.catalog;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import tools.jackson.databind.json.JsonMapper;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

class CatalogServiceTest {
    private static final String LIST_KEY = "catalog:v1:active-products";
    private static final UUID PRODUCT_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private ProductRepository products;
    private StringRedisTemplate redis;
    private ValueOperations<String, String> values;
    private SimpleMeterRegistry metrics;
    private CatalogService catalog;

    @BeforeEach
    void setUp() {
        products = mock(ProductRepository.class);
        redis = mock(StringRedisTemplate.class);
        values = mock(ValueOperations.class);
        when(redis.opsForValue()).thenReturn(values);
        metrics = new SimpleMeterRegistry();
        catalog = new CatalogService(products, redis, JsonMapper.builder().build(), metrics, Duration.ofSeconds(30));
    }

    @Test
    void usesCachedCatalogWithoutQueryingPostgres() {
        Product product = product();
        when(values.get(LIST_KEY)).thenReturn("""
                [{"id":"11111111-1111-4111-8111-111111111111","name":"Notebook","description":"Paper goods","price":245.00,"currency":"THB","imageUrl":null}]
                """);

        assertEquals(List.of(product), catalog.findActive());
        assertEquals(1.0, metrics.counter("shop_catalog_cache_requests_total",
                "result", "hit", "kind", "list").count());
        verifyNoInteractions(products);
    }

    @Test
    void fallsBackToPostgresAndPopulatesCacheOnMiss() {
        Product product = product();
        when(values.get(LIST_KEY)).thenReturn(null);
        when(products.findActive()).thenReturn(List.of(product));

        assertEquals(List.of(product), catalog.findActive());
        verify(values).set(eq(LIST_KEY), contains("Notebook"), eq(Duration.ofSeconds(30)));
        verify(products).findActive();
    }

    @Test
    void fallsBackToPostgresWhenRedisIsUnavailable() {
        Product product = product();
        when(values.get(LIST_KEY)).thenThrow(new RedisConnectionFailureException("Redis unavailable"));
        when(products.findActive()).thenReturn(List.of(product));
        doThrow(new RedisConnectionFailureException("Redis unavailable"))
                .when(values).set(anyString(), anyString(), any(Duration.class));

        assertEquals(List.of(product), catalog.findActive());
        assertEquals(2.0, metrics.counter("shop_catalog_cache_errors_total",
                "operation", "read", "kind", "list").count()
                + metrics.counter("shop_catalog_cache_errors_total",
                "operation", "write", "kind", "list").count());
        verify(products).findActive();
    }

    @Test
    void cachesProductDetailIndependently() {
        Product product = product();
        when(values.get("catalog:v1:product:" + PRODUCT_ID)).thenReturn(null);
        when(products.findActiveById(PRODUCT_ID)).thenReturn(Optional.of(product));

        assertEquals(Optional.of(product), catalog.findActiveById(PRODUCT_ID));
        verify(values).set(eq("catalog:v1:product:" + PRODUCT_ID), contains("Notebook"), eq(Duration.ofSeconds(30)));
    }

    private static Product product() {
        return new Product(PRODUCT_ID, "Notebook", "Paper goods",
                new BigDecimal("245.00"), "THB", null);
    }
}
