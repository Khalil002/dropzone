import { describe, expect, it } from "vitest";
import {
  admit, api, createDrop, eventually, expectProblem, newKey, registerUser, SIGNUP_CREDIT,
} from "./client.js";

const checkout = (token, body, key = newKey()) =>
  api("POST", "/orders", { token, body, headers: key === null ? {} : { "idempotency-key": key } });

describe("checkout", () => {
  it("requires an Idempotency-Key and admission", async () => {
    const drop = await createDrop();
    const { token } = await registerUser("gate");
    expectProblem(await checkout(token, { dropId: drop.id, quantity: 1 }, null), 400, "IDEMPOTENCY_KEY_MISSING");
    expectProblem(await checkout(token, { dropId: drop.id, quantity: 3 }), 400, "VALIDATION_ERROR");
    expectProblem(await checkout(token, { dropId: drop.id, quantity: 1 }), 403, "NOT_ADMITTED");
  });

  it("refuses drops that have not started", async () => {
    const drop = await createDrop({ startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const { token } = await registerUser("early");
    expectProblem(await checkout(token, { dropId: drop.id, quantity: 1 }), 409, "DROP_NOT_LIVE");
  });

  it("charges the wallet, decrements stock and records the order", async () => {
    const drop = await createDrop({ priceCents: 7500, totalStock: 5 });
    const { token } = await registerUser("buyer");
    await admit(token, drop.id);

    const res = await checkout(token, { dropId: drop.id, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dropId: drop.id, quantity: 2, totalCents: 15000, status: "confirmed" });

    expect((await api("GET", "/me", { token })).body.balanceCents).toBe(SIGNUP_CREDIT - 15000);
    expect((await api("GET", `/drops/${drop.id}`)).body.remainingStock).toBe(3);
    const orders = await api("GET", "/orders", { token });
    expect(orders.body.map((o) => o.id)).toEqual([res.body.id]);
  });

  it("replays the same response for a repeated Idempotency-Key", async () => {
    const drop = await createDrop({ totalStock: 5 });
    const { token } = await registerUser("idem");
    await admit(token, drop.id);
    const key = newKey();

    const first = await checkout(token, { dropId: drop.id, quantity: 1 }, key);
    const second = await checkout(token, { dropId: drop.id, quantity: 1 }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await api("GET", `/drops/${drop.id}`)).body.remainingStock).toBe(4);

    expectProblem(await checkout(token, { dropId: drop.id, quantity: 2 }, key), 422, "IDEMPOTENCY_KEY_REUSED");
    expectProblem(await checkout(token, { dropId: drop.id, quantity: 1 }), 409, "ALREADY_ORDERED");
  });

  it("handles concurrent retries of one key as a single purchase", async () => {
    const drop = await createDrop({ totalStock: 5 });
    const { token } = await registerUser("race");
    await admit(token, drop.id);
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkout(token, { dropId: drop.id, quantity: 1 }, key)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await api("GET", `/drops/${drop.id}`)).body.remainingStock).toBe(4);
  });

  it("rejects purchases the wallet cannot cover", async () => {
    const drop = await createDrop({ priceCents: SIGNUP_CREDIT + 1 });
    const { token } = await registerUser("broke");
    await admit(token, drop.id);
    expectProblem(await checkout(token, { dropId: drop.id, quantity: 1 }), 402, "INSUFFICIENT_FUNDS");
    expect((await api("GET", `/drops/${drop.id}`)).body.remainingStock).toBe(10); // rolled back
    expect((await api("GET", "/me", { token })).body.balanceCents).toBe(SIGNUP_CREDIT);
  });

  it("never oversells under a concurrent rush", async () => {
    const stock = 5;
    const drop = await createDrop({ totalStock: stock, priceCents: 1000 });
    const buyers = await Promise.all(Array.from({ length: 15 }, (_, i) => registerUser(`rush${i}`)));
    await Promise.all(buyers.map((b) => admit(b.token, drop.id)));

    const results = await Promise.all(buyers.map((b) => checkout(b.token, { dropId: drop.id, quantity: 1 })));
    const sold = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);
    expect(sold).toHaveLength(stock);
    rejected.forEach((r) => expectProblem(r, 409, "SOLD_OUT"));

    const after = (await api("GET", `/drops/${drop.id}`)).body;
    expect(after).toMatchObject({ remainingStock: 0, status: "sold_out" });
  });

  it("delivers an order.confirmed notification through the queue", async () => {
    const drop = await createDrop({ name: "Notify Runner" });
    const { token } = await registerUser("notify");
    await admit(token, drop.id);
    expect((await checkout(token, { dropId: drop.id, quantity: 1 })).status).toBe(201);

    const notes = await eventually(async () => {
      const res = await api("GET", "/me/notifications", { token });
      return res.body.length ? res.body : undefined;
    });
    expect(notes[0]).toMatchObject({ kind: "order.confirmed", message: "Order confirmed: 1 x Notify Runner" });
  });
});
