import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { route } from "../http.js";
import { notFound } from "../errors.js";

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/", route(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, COALESCE(a.balance_cents, 0) AS "balanceCents"
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.id = $1`,
    [req.user!.id],
  );
  if (!rows[0]) throw notFound("User");
  res.json(rows[0]);
}));

meRouter.get("/notifications", route(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, kind, message, created_at AS "createdAt" FROM notifications
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user!.id],
  );
  res.json(rows);
}));
