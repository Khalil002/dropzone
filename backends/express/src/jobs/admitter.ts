import { config } from "../config.js";
import { pool } from "../db.js";
import { keys, redis } from "../redis.js";

/**
 * Admits the head of each live queue. The admission key is written before the member
 * leaves the queue, so a poll never sees someone as neither waiting nor admitted.
 * Running this on several instances at once is harmless: admitting twice is a no-op.
 */
export async function admitTick(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM drops WHERE starts_at <= now() AND remaining_stock > 0",
  );
  let admitted = 0;
  for (const { id } of rows) {
    const head = await redis.zrange(keys.queue(id), 0, config.admitBatch - 1);
    if (!head.length) continue;
    for (const userId of head) {
      await redis.set(keys.admitted(id, userId), "1", "EX", config.admissionTtlSec);
    }
    await redis.zrem(keys.queue(id), ...head);
    admitted += head.length;
  }
  return admitted;
}
