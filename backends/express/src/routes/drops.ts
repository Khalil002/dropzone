import { Router } from "express";
import { config } from "../config.js";
import { pool } from "../db.js";
import { dropStatus, isUuid } from "../domain/rules.js";
import { newDropSchema } from "../domain/schemas.js";
import { ApiError, notFound } from "../errors.js";
import { requireAuth, requireRole } from "../auth.js";
import { parse, route } from "../http.js";
import { rateLimit } from "../rateLimit.js";
import { keys, redis } from "../redis.js";

interface DropRow {
  id: string; name: string; description: string; price_cents: number;
  total_stock: number; remaining_stock: number; starts_at: Date;
}

const DROP_COLUMNS = "id, name, description, price_cents, total_stock, remaining_stock, starts_at";

export const toDrop = (row: DropRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  priceCents: row.price_cents,
  totalStock: row.total_stock,
  remainingStock: row.remaining_stock,
  startsAt: row.starts_at.toISOString(),
  status: dropStatus(row.remaining_stock, row.starts_at),
});

export async function findDrop(id: string): Promise<DropRow | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await pool.query<DropRow>(`SELECT ${DROP_COLUMNS} FROM drops WHERE id = $1`, [id]);
  return rows[0];
}

export const invalidateDropsCache = () => redis.del(keys.dropsCache);

export const dropsRouter = Router();

// Cache-aside: the list is served from Redis for CACHE_TTL_SEC and dropped on writes.
dropsRouter.get("/", route(async (_req, res) => {
  const cached = await redis.get(keys.dropsCache);
  if (cached) {
    res.set("X-Cache", "HIT").type("application/json").send(cached);
    return;
  }
  const { rows } = await pool.query<DropRow>(`SELECT ${DROP_COLUMNS} FROM drops ORDER BY starts_at DESC LIMIT 100`);
  const body = JSON.stringify(rows.map(toDrop));
  await redis.set(keys.dropsCache, body, "EX", config.cacheTtlSec);
  res.set("X-Cache", "MISS").type("application/json").send(body);
}));

dropsRouter.post("/", requireAuth, requireRole("admin"), route(async (req, res) => {
  const input = parse(newDropSchema, req.body);
  const { rows } = await pool.query<DropRow>(
    `INSERT INTO drops (name, description, price_cents, total_stock, remaining_stock, starts_at)
     VALUES ($1, $2, $3, $4, $4, $5) RETURNING ${DROP_COLUMNS}`,
    [input.name, input.description, input.priceCents, input.totalStock, input.startsAt],
  );
  await invalidateDropsCache();
  res.status(201).json(toDrop(rows[0]));
}));

dropsRouter.get("/:dropId", route(async (req, res) => {
  const drop = await findDrop(req.params.dropId);
  if (!drop) throw notFound("Drop");
  res.json(toDrop(drop));
}));

// --- Waiting room -----------------------------------------------------------

// Queue membership is checked before admission: the admitter writes the admission key
// before removing someone from the queue, so this order never misses a person.
async function queueStatus(dropId: string, userId: string) {
  const rank = await redis.zrank(keys.queue(dropId), userId);
  if (rank !== null) return { status: "waiting", position: rank + 1 };
  if (await redis.exists(keys.admitted(dropId, userId))) return { status: "admitted", position: null };
  return null;
}

dropsRouter.post("/:dropId/queue", requireAuth, rateLimit, route(async (req, res) => {
  const drop = await findDrop(req.params.dropId);
  if (!drop) throw notFound("Drop");
  const userId = req.user!.id;
  const existing = await queueStatus(drop.id, userId);
  if (existing) {
    res.json(existing);
    return;
  }
  // A monotonically increasing ticket number gives strict first-come order.
  const ticket = await redis.incr(keys.queueSeq(drop.id));
  await redis.zadd(keys.queue(drop.id), "NX", ticket, userId);
  res.json(await queueStatus(drop.id, userId));
}));

dropsRouter.get("/:dropId/queue", requireAuth, route(async (req, res) => {
  const drop = await findDrop(req.params.dropId);
  if (!drop) throw notFound("Drop");
  const status = await queueStatus(drop.id, req.user!.id);
  if (!status) throw new ApiError(404, "NOT_IN_QUEUE", "You have not joined this drop's queue");
  res.json(status);
}));
