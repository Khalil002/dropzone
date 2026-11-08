import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodSchema } from "zod";
import { ApiError } from "./errors.js";

/** Express 4 does not forward rejected promises, so wrap async handlers. */
export const route = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function parse<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", detail);
  }
  return result.data;
}
