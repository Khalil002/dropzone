import { describe, expect, it } from "vitest";
import { admin, api, createDrop, expectProblem, registerUser } from "./client.js";

describe("drops", () => {
  it("only admins can create drops", async () => {
    const { token } = await registerUser("cust");
    const res = await api("POST", "/drops", {
      token,
      body: { name: "x", priceCents: 100, totalStock: 1, startsAt: new Date().toISOString() },
    });
    expectProblem(res, 403, "FORBIDDEN");
    expectProblem(await api("POST", "/drops", { body: {} }), 401, "UNAUTHORIZED");
  });

  it("validates new drops", async () => {
    const res = await api("POST", "/drops", {
      token: await admin(),
      body: { name: "", priceCents: 0, totalStock: 1, startsAt: "yesterday" },
    });
    expectProblem(res, 400, "VALIDATION_ERROR");
  });

  it("creates, lists and fetches a drop with a computed status", async () => {
    const live = await createDrop({ totalStock: 3 });
    expect(live).toMatchObject({ totalStock: 3, remainingStock: 3, status: "live", priceCents: 12000 });
    const upcoming = await createDrop({ startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(upcoming.status).toBe("upcoming");

    const one = await api("GET", `/drops/${live.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(live);

    const list = await api("GET", "/drops");
    expect(list.status).toBe(200);
    expect(list.body.map((d) => d.id)).toEqual(expect.arrayContaining([live.id, upcoming.id]));
  });

  it("serves the list from cache on repeat reads", async () => {
    await createDrop(); // invalidates the cache
    const first = await api("GET", "/drops");
    const second = await api("GET", "/drops");
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(second.body).toEqual(first.body);
  });

  it("returns 404 for unknown or malformed ids", async () => {
    expectProblem(await api("GET", "/drops/00000000-0000-0000-0000-00000000ffff"), 404, "NOT_FOUND");
    expectProblem(await api("GET", "/drops/not-a-uuid"), 404, "NOT_FOUND");
  });
});
