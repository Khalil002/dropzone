import type { NextFunction, Request, Response } from "express";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "EMAIL_TAKEN"
  | "INVALID_CREDENTIALS"
  | "NOT_IN_QUEUE"
  | "NOT_ADMITTED"
  | "DROP_NOT_LIVE"
  | "SOLD_OUT"
  | "ALREADY_ORDERED"
  | "INSUFFICIENT_FUNDS"
  | "IDEMPOTENCY_KEY_MISSING"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RATE_LIMITED";

/** An error that maps straight onto an RFC 7807 problem response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly title: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(title);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found`);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.set(err.headers);
    res.status(err.status).type("application/problem+json").json({
      type: "about:blank",
      title: err.title,
      status: err.status,
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
    });
    return;
  }
  // Malformed JSON bodies from express.json()
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).type("application/problem+json").json({
      type: "about:blank", title: "Malformed JSON body", status: 400, code: "VALIDATION_ERROR",
    });
    return;
  }
  console.error(err);
  res.status(500).type("application/problem+json").json({
    type: "about:blank", title: "Internal server error", status: 500, code: "INTERNAL",
  });
}
