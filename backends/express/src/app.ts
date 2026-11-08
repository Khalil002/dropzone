import express from "express";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import { errorHandler, notFound } from "./errors.js";
import { route } from "./http.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { dropsRouter } from "./routes/drops.js";
import { ordersRouter } from "./routes/orders.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();
  api.get("/health", route(async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      res.json({ status: "ok", backend: "express" });
    } catch {
      res.status(503).json({ status: "degraded", backend: "express" });
    }
  }));
  api.use("/auth", authRouter);
  api.use("/me", meRouter);
  api.use("/drops", dropsRouter);
  api.use("/orders", ordersRouter);
  api.use((_req, _res, next) => next(notFound("Route")));

  app.use("/api", api);
  app.use(errorHandler);
  return app;
}
