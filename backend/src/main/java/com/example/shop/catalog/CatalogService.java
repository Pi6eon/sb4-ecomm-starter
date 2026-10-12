package com.example.shop.catalog;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.MeterRegistry;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class CatalogService {
    private static final Logger log = LoggerFactory.getLogger(CatalogService.class);
    private static final String ACTIVE_PRODUCTS_KEY = "catalog:v1:active-products";
    private static final TypeReference<List<Product>> PRODUCT_LIST = new TypeReference<>() {};
    private final ProductRepository products;
    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final Duration ttl;
    private final MeterRegistry metrics;

    public CatalogService(
            ProductRepository products,
            StringRedisTemplate redis,
            ObjectMapper objectMapper,
            MeterRegistry metrics,
            @org.springframework.beans.factory.annotation.Value("${app.cache.catalog-ttl:PT30S}") Duration ttl) {
        this.products = products;
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.metrics = metrics;
        this.ttl = ttl;
    }

    public List<Product> findActive() {
        String cached = get(ACTIVE_PRODUCTS_KEY, "list");
        if (cached != null) {
            try {
                List<Product> result = objectMapper.readValue(cached, PRODUCT_LIST);
                metrics.counter("shop_catalog_cache_requests_total", "result", "hit", "kind", "list").increment();
                return result;
            } catch (JacksonException ex) {
                log.warn("Discarding invalid catalog list cache entry");
                delete(ACTIVE_PRODUCTS_KEY);
            }
        }
        metrics.counter("shop_catalog_cache_requests_total", "result", "miss", "kind", "list").increment();
        List<Product> result = products.findActive();
        put(ACTIVE_PRODUCTS_KEY, result, "list");
        return result;
    }

    public Optional<Product> findActiveById(UUID id) {
        String key = productKey(id);
        String cached = get(key, "product");
        if (cached != null) {
            try {
                Product result = objectMapper.readValue(cached, Product.class);
                metrics.counter("shop_catalog_cache_requests_total", "result", "hit", "kind", "product").increment();
                return Optional.of(result);
            } catch (JacksonException ex) {
                log.warn("Discarding invalid catalog product cache entry");
                delete(key);
            }
        }
        metrics.counter("shop_catalog_cache_requests_total", "result", "miss", "kind", "product").increment();
        Optional<Product> result = products.findActiveById(id);
        result.ifPresent(product -> put(key, product, "product"));
        return result;
    }

    private String get(String key, String kind) {
        try {
            return redis.opsForValue().get(key);
        } catch (DataAccessException ex) {
            cacheFailure("read", kind, ex);
            return null;
        }
    }

    private void put(String key, Object value, String kind) {
        try {
            redis.opsForValue().set(key, objectMapper.writeValueAsString(value), ttl);
        } catch (DataAccessException | JacksonException ex) {
            cacheFailure("write", kind, ex);
        }
    }

    private void delete(String key) {
        try {
            redis.delete(key);
        } catch (DataAccessException ex) {
            cacheFailure("delete", "invalid-entry", ex);
        }
    }

    private void cacheFailure(String operation, String kind, Exception ex) {
        metrics.counter("shop_catalog_cache_errors_total", "operation", operation, "kind", kind).increment();
        log.warn("Catalog cache {} failed for {} request; using database result", operation, kind, ex);
    }

    private static String productKey(UUID id) {
        return "catalog:v1:product:" + id;
    }
}
