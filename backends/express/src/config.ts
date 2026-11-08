const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const str = (name: string, fallback: string): string => process.env[name] || fallback;

export const config = {
  port: num("PORT", 8000),
  db: {
    host: str("DB_HOST", "localhost"),
    port: num("DB_PORT", 5432),
    database: str("DB_NAME", "dropzone"),
    user: str("DB_USER", "dropzone"),
    password: str("DB_PASSWORD", "dropzone"),
  },
  redis: { host: str("REDIS_HOST", "localhost"), port: num("REDIS_PORT", 6379) },
  rabbit: {
    host: str("RABBITMQ_HOST", "localhost"),
    port: num("RABBITMQ_PORT", 5672),
    user: str("RABBITMQ_USER", "guest"),
    password: str("RABBITMQ_PASSWORD", "guest"),
  },
  jwtSecret: str("JWT_SECRET", "change-me-to-a-long-random-secret-of-32-bytes"),
  jwtTtlSec: num("JWT_TTL_SEC", 3600),
  signupCreditCents: num("SIGNUP_CREDIT_CENTS", 50000),
  admitBatch: num("ADMIT_BATCH", 50),
  admitIntervalMs: num("ADMIT_INTERVAL_MS", 1000),
  admissionTtlSec: num("ADMISSION_TTL_SEC", 600),
  rateLimitMax: num("RATE_LIMIT_MAX", 20),
  rateLimitWindowSec: num("RATE_LIMIT_WINDOW_SEC", 10),
  cacheTtlSec: num("CACHE_TTL_SEC", 2),
};

export const PROMO_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";
export const REVENUE_ACCOUNT_ID = "00000000-0000-0000-0000-000000000002";
