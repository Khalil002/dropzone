import { createHash } from "node:crypto";

export type DropStatus = "upcoming" | "live" | "sold_out";

/** sold_out wins over everything; otherwise a drop is live once it has started. */
export function dropStatus(remainingStock: number, startsAt: Date, now: Date = new Date()): DropStatus {
  if (remainingStock <= 0) return "sold_out";
  return startsAt.getTime() > now.getTime() ? "upcoming" : "live";
}

/**
 * Fingerprint of a checkout body, used to detect an Idempotency-Key reused
 * with a different payload. Every backend hashes the same string.
 */
export function checkoutRequestHash(dropId: string, quantity: number): string {
  return createHash("sha256").update(`${dropId.toLowerCase()}|${quantity}`).digest("hex");
}

/** Fixed-window rate limiting: which window a moment falls in, and seconds until it resets. */
export function rateWindow(nowMs: number, windowSec: number): { window: number; retryAfterSec: number } {
  const nowSec = Math.floor(nowMs / 1000);
  const window = Math.floor(nowSec / windowSec);
  const retryAfterSec = Math.max(1, (window + 1) * windowSec - nowSec);
  return { window, retryAfterSec };
}

export const orderTotal = (priceCents: number, quantity: number): number => priceCents * quantity;

export const notificationMessage = (quantity: number, dropName: string): string =>
  `Order confirmed: ${quantity} x ${dropName}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);

export const isValidIdempotencyKey = (key: string | undefined): key is string =>
  typeof key === "string" && key.length >= 8 && key.length <= 128;
