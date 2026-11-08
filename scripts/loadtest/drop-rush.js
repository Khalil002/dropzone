// Flash-sale rush: USERS shoppers hit one drop with STOCK pairs at the same moment.
// Passes only if exactly STOCK orders succeed and the rest are cleanly turned away.
//
//   docker compose --profile loadtest run --rm k6
//   USERS=1000 STOCK=100 docker compose --profile loadtest run --rm k6
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8080/api";
const USERS = Number(__ENV.USERS || 300);
const STOCK = Number(__ENV.STOCK || 50);

const sold = new Counter("orders_confirmed");
const soldOut = new Counter("orders_sold_out");
const unexpected = new Counter("orders_unexpected");

export const options = {
  setupTimeout: "5m",
  scenarios: {
    rush: { executor: "per-vu-iterations", vus: USERS, iterations: 1, maxDuration: "5m" },
  },
  thresholds: {
    orders_unexpected: ["count==0"],
    orders_confirmed: [`count==${STOCK}`],
    http_req_failed: ["rate<0.5"], // 409 SOLD_OUT counts as "failed" in k6 terms
  },
};

const json = (token) => ({
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

export function setup() {
  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email: "admin@dropzone.local", password: "admin1234" }), json());
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  const admin = login.json("token");
  const drop = http.post(`${BASE}/drops`, JSON.stringify({
    name: `Load test ${Date.now()}`,
    description: "k6 rush",
    priceCents: 1000,
    totalStock: STOCK,
    startsAt: new Date(Date.now() - 1000).toISOString(),
  }), json(admin)).json();
  if (!drop.id) throw new Error(`could not create the drop: ${JSON.stringify(drop)}`);

  const tokens = [];
  const run = Date.now();
  for (let i = 0; i < USERS; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(USERS, i + 50); j++) {
      batch.push(["POST", `${BASE}/auth/register`,
        JSON.stringify({ email: `k6-${run}-${j}@load.test`, password: "password123" }), json()]);
    }
    for (const res of http.batch(batch)) tokens.push(res.json("token"));
  }
  return { dropId: drop.id, tokens };
}

export default function ({ dropId, tokens }) {
  const token = tokens[__VU - 1];
  http.post(`${BASE}/drops/${dropId}/queue`, null, json(token));

  // Poll the waiting room until the admitter lets us in, or the drop sells out.
  for (let i = 0; i < 120; i++) {
    const status = http.get(`${BASE}/drops/${dropId}/queue`, json(token)).json("status");
    if (status === "admitted") break;
    if (http.get(`${BASE}/drops/${dropId}`).json("status") === "sold_out") {
      soldOut.add(1); // turned away in the waiting room, never reached checkout
      return;
    }
    sleep(0.5);
  }

  const params = json(token);
  params.headers["idempotency-key"] = `k6-${__VU}-${dropId}`;
  const res = http.post(`${BASE}/orders`, JSON.stringify({ dropId, quantity: 1 }), params);
  if (res.status === 201) sold.add(1);
  else if (res.status === 409 && res.json("code") === "SOLD_OUT") soldOut.add(1);
  else unexpected.add(1);
}

export function teardown({ dropId }) {
  const drop = http.get(`${BASE}/drops/${dropId}`).json();
  check(drop, {
    "stock is exactly zero": (d) => d.remainingStock === 0,
    "drop reports sold_out": (d) => d.status === "sold_out",
  });
}
