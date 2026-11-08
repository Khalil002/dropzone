import { describe, expect, it } from "vitest";
import { admit, api, createDrop, expectProblem, RATE_LIMIT_MAX, registerUser } from "./client.js";

describe("waiting room", () => {
  it("is 404 until you join", async () => {
    const drop = await createDrop();
    const { token } = await registerUser("q");
    expectProblem(await api("GET", `/drops/${drop.id}/queue`, { token }), 404, "NOT_IN_QUEUE");
    expectProblem(await api("POST", "/drops/00000000-0000-0000-0000-00000000ffff/queue", { token }), 404, "NOT_FOUND");
  });

  it("hands out first-come places and keeps them on re-join", async () => {
    const drop = await createDrop({ startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const a = await registerUser("qa");
    const b = await registerUser("qb");
    const first = await api("POST", `/drops/${drop.id}/queue`, { token: a.token });
    const second = await api("POST", `/drops/${drop.id}/queue`, { token: b.token });
    expect(first.body).toEqual({ status: "waiting", position: 1 });
    expect(second.body).toEqual({ status: "waiting", position: 2 });
    const rejoin = await api("POST", `/drops/${drop.id}/queue`, { token: a.token });
    expect(rejoin.body).toEqual({ status: "waiting", position: 1 });
  });

  it("admits people once the drop is live", async () => {
    const drop = await createDrop();
    const { token } = await registerUser("qadmit");
    await admit(token, drop.id);
    const res = await api("GET", `/drops/${drop.id}/queue`, { token });
    expect(res.body).toEqual({ status: "admitted", position: null });
  });

  it("rate limits bursts per user with Retry-After", async () => {
    const drop = await createDrop({ startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const { token } = await registerUser("burst");
    const results = await Promise.all(
      Array.from({ length: RATE_LIMIT_MAX + 5 }, () => api("POST", `/drops/${drop.id}/queue`, { token })),
    );
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expectProblem(limited[0], 429, "RATE_LIMITED");
    expect(Number(limited[0].headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
