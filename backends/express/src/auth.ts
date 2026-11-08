import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

export type Role = "customer" | "admin";
export interface AuthUser { id: string; email: string; role: Role }

declare module "express-serve-static-core" {
  interface Request { user?: AuthUser }
}

const ISSUER = "dropzone";

/** HS256 token with the claims every backend reads: sub, email, role. */
export function issueToken(user: AuthUser): string {
  return jwt.sign({ email: user.email, role: user.role }, config.jwtSecret, {
    algorithm: "HS256", subject: user.id, issuer: ISSUER, expiresIn: config.jwtTtlSec,
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return next(new ApiError(401, "UNAUTHORIZED", "Missing bearer token"));
  }
  try {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER }) as jwt.JwtPayload;
    req.user = { id: String(claims.sub), email: String(claims.email), role: claims.role as Role };
    next();
  } catch {
    next(new ApiError(401, "UNAUTHORIZED", "Invalid or expired token"));
  }
}

export const requireRole = (role: Role) => (req: Request, _res: Response, next: NextFunction): void => {
  if (req.user?.role !== role) return next(new ApiError(403, "FORBIDDEN", `Requires role ${role}`));
  next();
};
