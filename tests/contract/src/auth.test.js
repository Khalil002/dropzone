import { describe, expect, it } from "vitest";
import { api, expectProblem, registerUser, SIGNUP_CREDIT, uniqueEmail } from "./client.js";

describe("health", () => {
  it("reports ok and names the backend", async () => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(["spring", "express", "dotnet"]).toContain(res.body.backend);
  });
});

describe("auth", () => {
  it("registers a customer and returns a token", async () => {
    const email = uniqueEmail("reg");
    const res = await api("POST", "/auth/register", { body: { email, password: "password123" } });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(res.body.user).toMatchObject({ email, role: "customer" });
  });

  it("normalises email case and rejects duplicates", async () => {
    const email = uniqueEmail("dup");
    expect((await api("POST", "/auth/register", { body: { email, password: "password123" } })).status).toBe(201);
    const again = await api("POST", "/auth/register", { body: { email: email.toUpperCase(), password: "password123" } });
    expectProblem(again, 409, "EMAIL_TAKEN");
  });

  it("validates the body", async () => {
    expectProblem(await api("POST", "/auth/register", { body: { email: "nope", password: "password123" } }), 400, "VALIDATION_ERROR");
    expectProblem(await api("POST", "/auth/register", { body: { email: uniqueEmail(), password: "short" } }), 400, "VALIDATION_ERROR");
  });

  it("logs in with the right password only", async () => {
    const { user } = await registerUser("login");
    const ok = await api("POST", "/auth/login", { body: { email: user.email, password: "password123" } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(user.id);
    expectProblem(await api("POST", "/auth/login", { body: { email: user.email, password: "wrong-pass" } }), 401, "INVALID_CREDENTIALS");
  });

  it("requires a valid token for /me and credits new wallets", async () => {
    expectProblem(await api("GET", "/me"), 401, "UNAUTHORIZED");
    expectProblem(await api("GET", "/me", { token: "not.a.token" }), 401, "UNAUTHORIZED");
    const { token, user } = await registerUser("me");
    const me = await api("GET", "/me", { token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: user.id, role: "customer", balanceCents: SIGNUP_CREDIT });
  });
});
