CREATE TABLE event_outbox (
    id UUID PRIMARY KEY,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(120) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error VARCHAR(500)
);

CREATE INDEX event_outbox_pending_idx
    ON event_outbox (available_at, created_at)
    WHERE published_at IS NULL;

DROP INDEX orders_customer_created_idx;
CREATE INDEX orders_customer_created_id_idx
    ON orders (customer_subject, created_at DESC, id DESC)
    INCLUDE (status, total, currency);

CREATE INDEX products_active_name_id_idx
    ON products (name, id)
    WHERE active = TRUE;
