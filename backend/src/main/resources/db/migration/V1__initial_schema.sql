CREATE TABLE products (
    id UUID PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '',
    price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'THB',
    image_url VARCHAR(1000),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id UUID PRIMARY KEY,
    customer_subject VARCHAR(254) NOT NULL,
    status VARCHAR(24) NOT NULL,
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'THB',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX orders_customer_created_idx ON orders (customer_subject, created_at DESC);

CREATE TABLE order_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    product_name VARCHAR(160) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0)
);

CREATE INDEX order_items_order_idx ON order_items (order_id);

INSERT INTO products (id, name, description, price, image_url) VALUES
('11111111-1111-4111-8111-111111111111', 'Everyday Tote', 'A lightweight everyday carry bag.', 590.00, 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=900'),
('22222222-2222-4222-8222-222222222222', 'Ceramic Cup', 'Hand-finished ceramic cup, 320 ml.', 320.00, 'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=900'),
('33333333-3333-4333-8333-333333333333', 'Desk Notebook', 'Recycled-paper notebook with 160 pages.', 245.00, 'https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=900');
