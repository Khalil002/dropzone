-- Users, wallet accounts and a double-entry ledger.
-- Every backend shares this schema; migrations run once through Flyway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- One row per wallet. balance_cents is a cached sum of ledger_entries,
-- updated in the same transaction as the entries that change it.
CREATE TABLE accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('customer', 'revenue', 'promo')),
    balance_cents bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Customers can never go below zero; system accounts can.
    CONSTRAINT customer_balance_non_negative CHECK (kind <> 'customer' OR balance_cents >= 0),
    CONSTRAINT customer_has_user CHECK ((kind = 'customer') = (user_id IS NOT NULL))
);

CREATE TABLE ledger_transactions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL CHECK (kind IN ('signup_bonus', 'purchase')),
    reference_id uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
    id             bigserial PRIMARY KEY,
    transaction_id uuid NOT NULL REFERENCES ledger_transactions (id),
    account_id     uuid NOT NULL REFERENCES accounts (id),
    amount_cents   bigint NOT NULL CHECK (amount_cents <> 0),
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

-- Double-entry invariant: the entries of a transaction must sum to zero.
-- Checked at COMMIT so a transaction can insert its legs one by one.
CREATE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
    total bigint;
BEGIN
    SELECT COALESCE(SUM(amount_cents), 0) INTO total
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
    IF total <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced (sum = %)', NEW.transaction_id, total;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

-- System accounts with fixed ids so every backend can find them.
INSERT INTO accounts (id, kind) VALUES
    ('00000000-0000-0000-0000-000000000001', 'promo'),
    ('00000000-0000-0000-0000-000000000002', 'revenue');

-- Demo admin (password: admin1234). Change it before exposing the app.
INSERT INTO users (email, password_hash, role) VALUES
    ('admin@dropzone.local', '$2a$10$xF8ocmFkJC.T6MPuqkrzNOBOwXpdCb3TYDwweOlLfzUPE8BUg5PJu', 'admin');
