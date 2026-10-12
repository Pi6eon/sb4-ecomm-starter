package com.example.shop.orders;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Repository
public class OrderOutboxRepository {
    private final JdbcClient jdbc;

    public OrderOutboxRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public List<OutboxEvent> claimBatch(int batchSize, long leaseSeconds) {
        return jdbc.sql("""
                WITH candidates AS (
                    SELECT id
                    FROM event_outbox
                    WHERE published_at IS NULL
                      AND available_at <= CURRENT_TIMESTAMP
                      AND (locked_until IS NULL OR locked_until <= CURRENT_TIMESTAMP)
                    ORDER BY available_at, created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT :batchSize
                )
                UPDATE event_outbox AS outbox
                SET locked_until = CURRENT_TIMESTAMP + (:leaseSeconds * INTERVAL '1 second'),
                    attempts = attempts + 1
                FROM candidates
                WHERE outbox.id = candidates.id
                RETURNING outbox.id, outbox.aggregate_id, outbox.event_type, outbox.payload::text, outbox.attempts
                """).param("batchSize", batchSize).param("leaseSeconds", leaseSeconds)
                .query((rs, row) -> new OutboxEvent(
                        rs.getObject("id", UUID.class),
                        rs.getObject("aggregate_id", UUID.class),
                        rs.getString("event_type"),
                        rs.getString("payload"),
                        rs.getInt("attempts")))
                .list();
    }

    public void markPublished(UUID id) {
        jdbc.sql("""
                UPDATE event_outbox
                SET published_at = CURRENT_TIMESTAMP, locked_until = NULL, last_error = NULL
                WHERE id = :id AND published_at IS NULL
                """).param("id", id).update();
    }

    public void releaseForRetry(UUID id, int attempts, String errorCode) {
        jdbc.sql("""
                UPDATE event_outbox
                SET locked_until = NULL,
                    available_at = CURRENT_TIMESTAMP
                        + (LEAST(300, (1 << LEAST(:attempts, 8))) * INTERVAL '1 second'),
                    last_error = :error
                WHERE id = :id AND published_at IS NULL
                """).param("id", id)
                .param("attempts", attempts)
                .param("error", errorCode)
                .update();
    }

    public record OutboxEvent(UUID id, UUID aggregateId, String eventType, String payload, int attempts) {}
}
