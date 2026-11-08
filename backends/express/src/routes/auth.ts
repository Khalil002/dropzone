import { Router } from "express";
import bcrypt from "bcryptjs";
import { config, PROMO_ACCOUNT_ID } from "../config.js";
import { isUniqueViolation, pool, withTransaction } from "../db.js";
import { credentialsSchema } from "../domain/schemas.js";
import { ApiError } from "../errors.js";
import { issueToken, type AuthUser } from "../auth.js";
import { parse, route } from "../http.js";

export const authRouter = Router();

authRouter.post("/register", route(async (req, res) => {
  const { email, password } = parse(credentialsSchema, req.body);
  const hash = await bcrypt.hash(password, 10);
  try {
    const user = await withTransaction(async (tx) => {
      const { rows } = await tx.query<AuthUser>(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role",
        [email, hash],
      );
      const created = rows[0];
      const account = await tx.query<{ id: string }>(
        "INSERT INTO accounts (user_id, kind) VALUES ($1, 'customer') RETURNING id", [created.id],
      );
      // Signup credit is a balanced ledger transaction: promo pays, customer receives.
      const credit = config.signupCreditCents;
      const ledger = await tx.query<{ id: string }>(
        "INSERT INTO ledger_transactions (kind, reference_id) VALUES ('signup_bonus', $1) RETURNING id", [created.id],
      );
      await tx.query(
        "INSERT INTO ledger_entries (transaction_id, account_id, amount_cents) VALUES ($1, $2, $3), ($1, $4, $5)",
        [ledger.rows[0].id, PROMO_ACCOUNT_ID, -credit, account.rows[0].id, credit],
      );
      await tx.query("UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1", [PROMO_ACCOUNT_ID, credit]);
      await tx.query("UPDATE accounts SET balance_cents = balance_cents + $2 WHERE id = $1", [account.rows[0].id, credit]);
      return created;
    });
    res.status(201).json({ token: issueToken(user), user });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered");
    throw err;
  }
}));

authRouter.post("/login", route(async (req, res) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const { rows } = await pool.query<AuthUser & { password_hash: string }>(
    "SELECT id, email, role, password_hash FROM users WHERE lower(email) = $1", [email],
  );
  const found = rows[0];
  if (!found || !(await bcrypt.compare(password, found.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  const user: AuthUser = { id: found.id, email: found.email, role: found.role };
  res.json({ token: issueToken(user), user });
}));
