-- Drops (limited releases), orders, idempotency records, the transactional
-- outbox and the notifications written by the queue consumer.

CREATE TABLE drops (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    description     text NOT NULL DEFAULT '',
    price_cents     bigint NOT NULL CHECK (price_cents > 0),
    total_stock     integer NOT NULL CHECK (total_stock > 0),
    remaining_stock integer NOT NULL,
    starts_at       timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- The database itself refuses to oversell, whatever the backend does.
    CONSTRAINT stock_in_range CHECK (remaining_stock BETWEEN 0 AND total_stock)
);
CREATE INDEX drops_starts_at_idx ON drops (starts_at DESC);

CREATE TABLE orders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id),
    drop_id     uuid NOT NULL REFERENCES drops (id),
    quantity    integer NOT NULL CHECK (quantity BETWEEN 1 AND 2),
    total_cents bigint NOT NULL CHECK (total_cents > 0),
    status      text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- One order per customer per drop: the anti-scalper rule.
    CONSTRAINT one_order_per_user_per_drop UNIQUE (user_id, drop_id)
);

-- Stored responses for Idempotency-Key replays.
CREATE TABLE idempotency_keys (
    user_id         uuid NOT NULL REFERENCES users (id),
    key             text NOT NULL,
    request_hash    text NOT NULL,
    response_status integer NOT NULL,
    response_body   jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- Transactional outbox: written in the same transaction as the order,
-- relayed to RabbitMQ by a background publisher.
CREATE TABLE outbox_events (
    id           bigserial PRIMARY KEY,
    event_id     uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    event_type   text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id),
    event_id   uuid NOT NULL UNIQUE, -- makes the consumer idempotent
    kind       text NOT NULL,
    message    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
