ALTER TABLE guest_access_tokens
    ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'history';

ALTER TABLE guest_access_tokens
    ADD CONSTRAINT guest_access_tokens_purpose_check CHECK (purpose IN ('history', 'checkout'));
