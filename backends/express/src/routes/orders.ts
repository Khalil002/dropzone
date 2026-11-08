import { Router } from "express";
import type { PoolClient } from "pg";
import { REVENUE_ACCOUNT_ID } from "../config.js";
import { isUniqueViolation, pool, withTransaction } from "../db.js";
import { checkoutRequestHash, dropStatus, isValidIdempotencyKey, orderTotal } from "../domain/rules.js";
import { checkoutSchema } from "../domain/schemas.js";
import { ApiError, notFound } from "../errors.js";
import { requireAuth } from "../auth.js";
import { parse, route } from "../http.js";
import { rateLimit } from "../rateLimit.js";
import { keys, redis } from "../redis.js";
import { findDrop, invalidateDropsCache } from "./drops.js";

interface OrderRow { id: string; drop_id: string; quantity: number; total_cents: number; status: string; created_at: Date }

const toOrder = (row: OrderRow) => ({
  id: row.id,
  dropId: row.drop_id,
  quantity: row.quantity,
  totalCents: row.total_cents,
  status: row.status,
  createdAt: row.created_at.toISOString(),
});

interface StoredResponse { request_hash: string; response_status: number; response_body: unknown }

async function storedResponse(db: Pick<PoolClient, "query">, userId: string, key: string) {
  const { rows } = await db.query<StoredResponse>(
    "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2",
    [userId, key],
  );
  return rows[0];
}

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

ordersRouter.get("/", route(async (req, res) => {
  const { rows } = await pool.query<OrderRow>(
    `SELECT id, drop_id, quantity, total_cents, status, created_at FROM orders
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user!.id],
  );
  res.json(rows.map(toOrder));
}));

ordersRouter.post("/", rateLimit, route(async (req, res) => {
  const userId = req.user!.id;
  const key = req.header("idempotency-key");
  if (!isValidIdempotencyKey(key)) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_MISSING", "Idempotency-Key header (8-128 chars) is required");
  }
  const input = parse(checkoutSchema, req.body);
  const requestHash = checkoutRequestHash(input.dropId, input.quantity);

  const replay = (stored: StoredResponse) => {
    if (stored.request_hash !== requestHash) {
      throw new ApiError(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different body");
    }
    res.set("Idempotent-Replayed", "true").status(stored.response_status).json(stored.response_body);
  };

  const earlier = await storedResponse(pool, userId, key);
  if (earlier) return replay(earlier);

  const drop = await findDrop(input.dropId);
  if (!drop) throw notFound("Drop");
  const status = dropStatus(drop.remaining_stock, drop.starts_at);
  if (status === "upcoming") throw new ApiError(409, "DROP_NOT_LIVE", "This drop has not started yet");
  if (!(await redis.exists(keys.admitted(drop.id, userId)))) {
    throw new ApiError(403, "NOT_ADMITTED", "Wait in the queue until you are admitted");
  }

  const outcome = await withTransaction(async (tx) => {
    // Serialise concurrent requests that share a key, then re-check for a stored response.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))", [userId, key]);
    const raced = await storedResponse(tx, userId, key);
    if (raced) return { raced };

    const dup = await tx.query("SELECT 1 FROM orders WHERE user_id = $1 AND drop_id = $2", [userId, drop.id]);
    if (dup.rowCount) throw new ApiError(409, "ALREADY_ORDERED", "You already bought this drop");

    // Conditional decrement: never oversells, even under heavy concurrency.
    const stock = await tx.query<{ price_cents: number; name: string }>(
      `UPDATE drops SET remaining_stock = remaining_stock - $2
        WHERE id = $1 AND remaining_stock >= $2 RETURNING price_cents, name`,
      [drop.id, input.quantity],
    );
    if (!stock.rowCount) throw new ApiError(409, "SOLD_OUT", "Not enough stock left");
    const { price_cents: price, name } = stock.rows[0];
    const total = orderTotal(price, input.quantity);

    // Lock the wallet row so concurrent purchases cannot both spend the same balance.
    const wallet = await tx.query<{ id: string; balance_cents: number }>(
      "SELECT id, balance_cents FROM accounts WHERE user_id = $1 FOR UPDATE", [userId],
    );
    if (!wallet.rowCount || wallet.rows[0].balance_cents < total) {
      throw new ApiError(402, "INSUFFICIENT_FUNDS", "Wallet balance is too low");
    }
    const walletId = wallet.rows[0].id;

    let order: OrderRow;
    try {
      const inserted = await tx.query<OrderRow>(
        `INSERT INTO orders (user_id, drop_id, quantity, total_cents) VALUES ($1, $2, $3, $4)
         RETURNING id, drop_id, quantity, total_cents, status, created_at`,
        [userId, drop.id, input.quantity, total],
      );
      order = inserted.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, "ALREADY_ORDERED", "You already bought this drop");
      throw err;
    }

    const ledger = await tx.query<{ id: string }>(
      "INSERT INTO ledger_transactions (kind, reference_id) VALUES ('purchase', $1) RETURNING id", [order.id],
    );
    await tx.query(
      "INSERT INTO ledger_entries (transaction_id, account_id, amount_cents) VALUES ($1, $2, $3), ($1, $4, $5)",
      [ledger.rows[0].id, walletId, -total, REVENUE_ACCOUNT_ID, total],
    );
    await tx.query("UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1", [walletId, total]);
    await tx.query("UPDATE accounts SET balance_cents = balance_cents + $2 WHERE id = $1", [REVENUE_ACCOUNT_ID, total]);

    await tx.query(
      "INSERT INTO outbox_events (event_type, payload) VALUES ('order.confirmed', $1)",
      [{ orderId: order.id, userId, dropId: drop.id, dropName: name, quantity: input.quantity, totalCents: total }],
    );

    const body = toOrder(order);
    await tx.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, 201, $4)`,
      [userId, key, requestHash, body],
    );
    return { body };
  });

  if ("raced" in outcome) return replay(outcome.raced!);
  await invalidateDropsCache();
  res.status(201).json(outcome.body);
}));
