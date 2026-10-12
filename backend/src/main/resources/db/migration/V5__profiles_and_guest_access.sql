ALTER TABLE customers ADD COLUMN display_name VARCHAR(100);

CREATE TABLE guest_profiles (
    email VARCHAR(254) PRIMARY KEY,
    display_name VARCHAR(100),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE guest_access_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX guest_access_tokens_email_created_idx
    ON guest_access_tokens (email, created_at DESC);
