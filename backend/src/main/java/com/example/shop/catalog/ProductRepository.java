package com.example.shop.catalog;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.Collection;
import java.util.UUID;

@Repository
public class ProductRepository {
    private static final RowMapper<Product> PRODUCT_MAPPER = (rs, row) -> new Product(
            rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("description"),
            rs.getBigDecimal("price"), rs.getString("currency"), rs.getString("image_url"));
    private final JdbcClient jdbc;

    public ProductRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public List<Product> findActive() {
        return jdbc.sql("SELECT id, name, description, price, currency, image_url FROM products WHERE active = true ORDER BY name")
                .query(PRODUCT_MAPPER).list();
    }

    public Optional<Product> findActiveById(UUID id) {
        return jdbc.sql("SELECT id, name, description, price, currency, image_url FROM products WHERE id = :id AND active = true")
                .param("id", id).query(PRODUCT_MAPPER).optional();
    }

    public List<Product> findActiveByIds(Collection<UUID> ids) {
        if (ids.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("""
                SELECT id, name, description, price, currency, image_url
                FROM products WHERE active = TRUE AND id IN (:ids)
                """).param("ids", ids).query(PRODUCT_MAPPER).list();
    }
}
