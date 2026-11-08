import pg from "pg";
import { config } from "./config.js";

// Return bigint columns (cents, bigserial) as JS numbers; amounts stay well below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({ ...config.db, max: 20 });

/** Runs fn inside BEGIN/COMMIT, rolling back on any thrown error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (err: unknown, constraint?: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505" &&
  (constraint === undefined || (err as { constraint?: string }).constraint === constraint);
