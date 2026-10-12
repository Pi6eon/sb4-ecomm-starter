CREATE TABLE short_links (
    code VARCHAR(8) PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id),
    created_by VARCHAR(254) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX short_links_product_created_idx
    ON short_links (product_id, created_at DESC);
