import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { issueToken, requireAuth, requireRole } from "../src/auth.js";
import { ApiError, errorHandler } from "../src/errors.js";

const reqWith = (authorization?: string) =>
  ({ header: (name: string) => (name === "authorization" ? authorization : undefined) }) as unknown as Request;

describe("requireAuth", () => {
  it("accepts a token it issued and exposes the claims", () => {
    const token = issueToken({ id: "u1", email: "a@b.io", role: "admin" });
    const req = reqWith(`Bearer ${token}`);
    const next = vi.fn();
    requireAuth(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ id: "u1", email: "a@b.io", role: "admin" });
  });

  it("rejects missing and tampered tokens with 401", () => {
    for (const header of [undefined, "Bearer", "Basic abc", "Bearer a.b.c"]) {
      const next = vi.fn();
      requireAuth(reqWith(header), {} as Response, next);
      expect(next.mock.calls[0][0]).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    }
  });
});

describe("requireRole", () => {
  it("forbids other roles", () => {
    const next = vi.fn();
    requireRole("admin")({ user: { id: "u", email: "e", role: "customer" } } as Request, {} as Response, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});

describe("errorHandler", () => {
  it("renders ApiError as problem+json with extra headers", () => {
    const res = { set: vi.fn(), status: vi.fn(), type: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    res.type.mockReturnValue(res);
    errorHandler(new ApiError(429, "RATE_LIMITED", "Too many", undefined, { "Retry-After": "3" }),
      {} as Request, res as unknown as Response, vi.fn());
    expect(res.set).toHaveBeenCalledWith({ "Retry-After": "3" });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.type).toHaveBeenCalledWith("application/problem+json");
    expect(res.json).toHaveBeenCalledWith({ type: "about:blank", title: "Too many", status: 429, code: "RATE_LIMITED" });
  });
});
