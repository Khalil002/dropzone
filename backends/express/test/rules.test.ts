import { describe, expect, it } from "vitest";
import {
  checkoutRequestHash, dropStatus, isUuid, isValidIdempotencyKey, notificationMessage, orderTotal, rateWindow,
} from "../src/domain/rules.js";
import { checkoutSchema, credentialsSchema, newDropSchema } from "../src/domain/schemas.js";

describe("dropStatus", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("is sold_out with no stock, even before start", () => {
    expect(dropStatus(0, new Date("2027-01-01T00:00:00Z"), now)).toBe("sold_out");
  });
  it("is upcoming before start and live from start", () => {
    expect(dropStatus(5, new Date("2026-01-01T12:00:01Z"), now)).toBe("upcoming");
    expect(dropStatus(5, now, now)).toBe("live");
  });
});

describe("checkoutRequestHash", () => {
  it("matches the value every backend computes", () => {
    const expected = "29a1d8a96621022b392fc68a5458ca86d949f47552fcc41265514498316a5ffa";
    expect(checkoutRequestHash("00000000-0000-0000-0000-000000000ABC", 2)).toBe(expected);
    expect(checkoutRequestHash("a", 1)).not.toBe(checkoutRequestHash("a", 2));
  });
});

describe("rateWindow", () => {
  it("buckets time into fixed windows", () => {
    expect(rateWindow(100_000, 10)).toEqual({ window: 10, retryAfterSec: 10 });
    expect(rateWindow(109_500, 10)).toEqual({ window: 10, retryAfterSec: 1 });
    expect(rateWindow(110_000, 10).window).toBe(11);
  });
});

describe("small helpers", () => {
  it("computes totals and messages", () => {
    expect(orderTotal(7500, 2)).toBe(15000);
    expect(notificationMessage(1, "Runner")).toBe("Order confirmed: 1 x Runner");
  });
  it("validates uuids and idempotency keys", () => {
    expect(isUuid("9b2c1e0a-1111-4222-8333-444455556666")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("long-enough")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
  });
});

describe("schemas", () => {
  it("lowercases emails and enforces password length", () => {
    expect(credentialsSchema.parse({ email: " A@B.io ", password: "password1" }).email).toBe("a@b.io");
    expect(credentialsSchema.safeParse({ email: "a@b.io", password: "short" }).success).toBe(false);
  });
  it("caps checkout quantity at 2", () => {
    const dropId = "9b2c1e0a-1111-4222-8333-444455556666";
    expect(checkoutSchema.safeParse({ dropId, quantity: 2 }).success).toBe(true);
    expect(checkoutSchema.safeParse({ dropId, quantity: 3 }).success).toBe(false);
  });
  it("requires an ISO start time and positive price", () => {
    const base = { name: "x", priceCents: 1, totalStock: 1, startsAt: "2026-01-01T00:00:00Z" };
    expect(newDropSchema.parse(base).description).toBe("");
    expect(newDropSchema.safeParse({ ...base, startsAt: "tomorrow" }).success).toBe(false);
    expect(newDropSchema.safeParse({ ...base, priceCents: 0 }).success).toBe(false);
  });
});
