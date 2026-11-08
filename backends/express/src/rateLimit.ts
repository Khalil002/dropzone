import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { ApiError } from "./errors.js";
import { keys, redis } from "./redis.js";
import { rateWindow } from "./domain/rules.js";

/** Per-user fixed-window limiter in Redis, shared by the queue and checkout endpoints. */
export async function rateLimit(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { window, retryAfterSec } = rateWindow(Date.now(), config.rateLimitWindowSec);
    const key = keys.rateLimit(req.user!.id, window);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, config.rateLimitWindowSec);
    if (count > config.rateLimitMax) {
      return next(new ApiError(429, "RATE_LIMITED", "Too many requests", undefined, {
        "Retry-After": String(retryAfterSec),
      }));
    }
    next();
  } catch (err) {
    next(err);
  }
}
