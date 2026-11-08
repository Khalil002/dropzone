import { randomUUID } from "node:crypto";

export const API_URL = (process.env.API_URL ?? "http://localhost:8000/api").replace(/\/$/, "");
export const SIGNUP_CREDIT = Number(process.env.SIGNUP_CREDIT_CENTS ?? 50000);
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? "admin@dropzone.local",
  password: process.env.ADMIN_PASSWORD ?? "admin1234",
};

/** Minimal fetch wrapper: returns status, headers and parsed JSON body. */
export async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

export const uniqueEmail = (tag = "user") => `${tag}-${randomUUID().slice(0, 12)}@test.local`;

export async function registerUser(tag) {
  const res = await api("POST", "/auth/register", { body: { email: uniqueEmail(tag), password: "password123" } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

let adminToken;
export async function admin() {
  if (!adminToken) {
    const res = await api("POST", "/auth/login", { body: ADMIN });
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
    adminToken = res.body.token;
  }
  return adminToken;
}

export async function createDrop(overrides = {}) {
  const res = await api("POST", "/drops", {
    token: await admin(),
    body: {
      name: `Test drop ${randomUUID().slice(0, 6)}`,
      description: "contract test",
      priceCents: 12000,
      totalStock: 10,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      ...overrides,
    },
  });
  if (res.status !== 201) throw new Error(`create drop failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function eventually(fn, { timeoutMs = 15_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Join the queue and wait for the admitter to let us in. */
export async function admit(token, dropId) {
  const joined = await api("POST", `/drops/${dropId}/queue`, { token });
  if (joined.status !== 200) throw new Error(`join failed: ${joined.status}`);
  await eventually(async () => {
    const res = await api("GET", `/drops/${dropId}/queue`, { token });
    return res.body?.status === "admitted";
  });
}

export const newKey = () => `key-${randomUUID()}`;

export const expectProblem = (res, status, code) => {
  if (res.status !== status || res.body?.code !== code) {
    throw new Error(`expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (!String(res.headers.get("content-type")).includes("application/problem+json")) {
    throw new Error(`expected problem+json, got ${res.headers.get("content-type")}`);
  }
};
