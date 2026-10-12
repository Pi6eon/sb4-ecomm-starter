package com.example.shop.orders;

import com.example.shop.catalog.Product;
import com.example.shop.catalog.ProductRepository;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.UUID;

import static org.springframework.http.HttpStatus.CONFLICT;

@Service
public class OrderService {
    private static final String ORDER_PLACED_EVENT = "OrderPlaced.v1";
    private final ProductRepository products;
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public OrderService(ProductRepository products, JdbcClient jdbc, ObjectMapper objectMapper) {
        this.products = products;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public OrderResponse create(String subject, String idempotencyKey, OrderRequest request) {
        String requestHash = requestHash(request);
        jdbc.sql("""
                INSERT INTO order_idempotency (customer_subject, idempotency_key, request_hash)
                VALUES (:subject, :key, :hash)
                ON CONFLICT (customer_subject, idempotency_key) DO NOTHING
                """).param("subject", subject).param("key", idempotencyKey).param("hash", requestHash).update();
        IdempotencyRecord record = jdbc.sql("""
                SELECT request_hash, order_id FROM order_idempotency
                WHERE customer_subject = :subject AND idempotency_key = :key FOR UPDATE
                """).param("subject", subject).param("key", idempotencyKey)
                .query((rs, row) -> new IdempotencyRecord(
                        rs.getString("request_hash"), rs.getObject("order_id", UUID.class)))
                .single();
        if (!MessageDigest.isEqual(record.requestHash().getBytes(StandardCharsets.US_ASCII),
                requestHash.getBytes(StandardCharsets.US_ASCII))) {
            throw new ResponseStatusException(CONFLICT, "Idempotency key was already used for another request");
        }
        if (record.orderId() != null) {
            return findOrder(subject, record.orderId());
        }
        Map<UUID, Product> productsById = products.findActiveByIds(
                        request.items().stream().map(OrderRequest.Item::productId).collect(Collectors.toSet()))
                .stream().collect(Collectors.toMap(Product::id, Function.identity()));
        List<ResolvedItem> items = request.items().stream().map(item -> {
            Product product = productsById.get(item.productId());
            if (product == null) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found");
            }
            if (item.quantity() < 1 || item.quantity() > 99) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Quantity must be between 1 and 99");
            }
            return new ResolvedItem(product, item.quantity());
        }).toList();
        for (ResolvedItem item : items) {
            int updated = jdbc.sql("""
                    UPDATE products SET available_quantity = available_quantity - :quantity
                    WHERE id = :id AND active = true AND available_quantity >= :quantity
                    """).param("id", item.product().id()).param("quantity", item.quantity()).update();
            if (updated != 1) {
                throw new ResponseStatusException(CONFLICT, "Insufficient stock for " + item.product().name());
            }
        }
        BigDecimal total = items.stream()
                .map(item -> item.product().price().multiply(BigDecimal.valueOf(item.quantity())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        UUID orderId = UUID.randomUUID();
        jdbc.sql("INSERT INTO orders (id, customer_subject, status, total, currency) VALUES (:id, :subject, 'PLACED', :total, 'THB')")
                .param("id", orderId).param("subject", subject).param("total", total).update();
        for (ResolvedItem item : items) {
            jdbc.sql("""
                    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
                    VALUES (:orderId, :productId, :name, :quantity, :price)
                    """)
                    .param("orderId", orderId)
                    .param("productId", item.product().id())
                    .param("name", item.product().name())
                    .param("quantity", item.quantity())
                    .param("price", item.product().price())
                    .update();
        }
        jdbc.sql("""
                UPDATE order_idempotency SET order_id = :orderId
                WHERE customer_subject = :subject AND idempotency_key = :key
                """).param("orderId", orderId).param("subject", subject).param("key", idempotencyKey).update();
        enqueueOrderPlacedEvent(orderId, total, "THB", items.size());
        return new OrderResponse(orderId, "PLACED", total, "THB");
    }

    public List<OrderResponse> findOrders(String subject, int limit, int offset) {
        return jdbc.sql("""
                SELECT id, status, total, currency FROM orders
                WHERE customer_subject = :subject
                ORDER BY created_at DESC, id DESC
                LIMIT :limit OFFSET :offset
                """).param("subject", subject).param("limit", limit).param("offset", offset)
                .query((rs, row) -> new OrderResponse(
                rs.getObject("id", UUID.class), rs.getString("status"),
                rs.getBigDecimal("total"), rs.getString("currency"))).list();
    }

    public List<OrderHistoryResponse> findOrderHistory(String subject, int limit, int offset) {
        List<OrderSummary> orders = jdbc.sql("""
                SELECT id, status, total, currency, created_at FROM orders
                WHERE customer_subject = :subject
                ORDER BY created_at DESC, id DESC
                LIMIT :limit OFFSET :offset
                """).param("subject", subject).param("limit", limit).param("offset", offset)
                .query((rs, row) -> new OrderSummary(
                        rs.getObject("id", UUID.class),
                        rs.getString("status"),
                        rs.getBigDecimal("total"),
                        rs.getString("currency"),
                        rs.getTimestamp("created_at").toInstant()))
                .list();
        if (orders.isEmpty()) return List.of();

        Map<UUID, List<OrderHistoryResponse.Item>> itemsByOrder = new HashMap<>();
        jdbc.sql("""
                SELECT order_id, product_name, quantity, unit_price
                FROM order_items WHERE order_id IN (:orderIds)
                ORDER BY id
                """).param("orderIds", orders.stream().map(OrderSummary::id).toList())
                .query((rs, row) -> new OrderItemRow(
                        rs.getObject("order_id", UUID.class),
                        new OrderHistoryResponse.Item(
                                rs.getString("product_name"),
                                rs.getInt("quantity"),
                                rs.getBigDecimal("unit_price"))))
                .list()
                .forEach(item -> itemsByOrder.computeIfAbsent(item.orderId(), ignored -> new ArrayList<>())
                        .add(item.item()));

        return orders.stream().map(order -> new OrderHistoryResponse(
                order.id(),
                order.status(),
                order.total(),
                order.currency(),
                order.createdAt(),
                itemsByOrder.getOrDefault(order.id(), List.of()))).toList();
    }

    public OrderResponse findOrder(String subject, UUID id) {
        return jdbc.sql("""
                SELECT id, status, total, currency FROM orders
                WHERE customer_subject = :subject AND id = :id
                """).param("subject", subject).param("id", id).query((rs, row) -> new OrderResponse(
                        rs.getObject("id", UUID.class), rs.getString("status"),
                        rs.getBigDecimal("total"), rs.getString("currency")))
                .optional()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found"));
    }

    private void enqueueOrderPlacedEvent(UUID orderId, BigDecimal total, String currency, int itemCount) {
        UUID eventId = UUID.randomUUID();
        try {
            String payload = objectMapper.writeValueAsString(new OrderPlacedEvent(
                    eventId, orderId, total, currency, itemCount, java.time.Instant.now()));
            jdbc.sql("""
                    INSERT INTO event_outbox (id, aggregate_id, event_type, payload)
                    VALUES (:id, :aggregateId, :eventType, CAST(:payload AS jsonb))
                    """).param("id", eventId)
                    .param("aggregateId", orderId)
                    .param("eventType", ORDER_PLACED_EVENT)
                    .param("payload", payload)
                    .update();
        } catch (JacksonException ex) {
            throw new IllegalStateException("Unable to serialize order event", ex);
        }
    }

    private String requestHash(OrderRequest request) {
        try {
            byte[] canonical = objectMapper.writeValueAsBytes(request);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical));
        } catch (JacksonException | NoSuchAlgorithmException ex) {
            throw new IllegalStateException("Unable to calculate idempotency request fingerprint", ex);
        }
    }

    private record IdempotencyRecord(String requestHash, UUID orderId) {}
    private record ResolvedItem(Product product, int quantity) {}
    private record OrderSummary(UUID id, String status, BigDecimal total, String currency, Instant createdAt) {}
    private record OrderItemRow(UUID orderId, OrderHistoryResponse.Item item) {}
    private record OrderPlacedEvent(
            UUID eventId, UUID orderId, BigDecimal total, String currency, int itemCount,
            java.time.Instant occurredAt) {}
}
