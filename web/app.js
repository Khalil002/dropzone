// dropzone web client: plain JS against the shared REST contract.
const state = {
  token: localStorage.getItem("dz.token"),
  user: null,
  drops: [],
  queue: {}, // dropId -> { status, position }
};

const $ = (sel) => document.querySelector(sel);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.title ?? `HTTP ${res.status}`);
    err.code = data?.code;
    err.status = res.status;
    throw err;
  }
  return { data, headers: res.headers };
}

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// --- session -----------------------------------------------------------------

async function loadMe() {
  if (!state.token) return renderSession();
  try {
    state.user = (await api("GET", "/me")).data;
  } catch {
    logout();
  }
  renderSession();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("dz.token");
  renderSession();
  renderDrops();
}

function renderSession() {
  const signedIn = Boolean(state.user);
  $("#auth").classList.toggle("hidden", signedIn);
  $("#mine").classList.toggle("hidden", !signedIn);
  $("#admin").classList.toggle("hidden", state.user?.role !== "admin");
  $("#session").innerHTML = signedIn
    ? `<span>${escapeHtml(state.user.email)}</span>
       <span class="pill">wallet ${money(state.user.balanceCents)}</span>
       <button class="ghost" id="logout">Log out</button>`
    : "";
  if (signedIn) {
    $("#logout").onclick = logout;
    loadMine();
  }
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = event.submitter?.dataset.mode ?? "login";
  const form = new FormData(event.target);
  try {
    const { data } = await api("POST", `/auth/${mode}`, {
      body: { email: form.get("email"), password: form.get("password") },
    });
    state.token = data.token;
    localStorage.setItem("dz.token", data.token);
    await loadMe();
    renderDrops();
    toast(mode === "register" ? "Account created, wallet credited" : "Welcome back");
  } catch (err) {
    toast(err.message);
  }
});

// --- admin -------------------------------------------------------------------

$("#drop-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const startsIn = Number(form.get("startsIn") || 0);
  try {
    await api("POST", "/drops", {
      body: {
        name: form.get("name"),
        description: form.get("description") || "",
        priceCents: Number(form.get("priceCents")),
        totalStock: Number(form.get("totalStock")),
        startsAt: new Date(Date.now() + startsIn * 1000).toISOString(),
      },
    });
    event.target.reset();
    toast("Drop scheduled");
    loadDrops();
  } catch (err) {
    toast(err.message);
  }
});

// --- drops & queue -----------------------------------------------------------

async function loadDrops() {
  try {
    const { data, headers } = await api("GET", "/drops");
    state.drops = data;
    $("#cache").textContent = `list cache: ${headers.get("x-cache") ?? "n/a"}`;
    renderDrops();
  } catch (err) {
    $("#drops").innerHTML = `<p class="muted">Could not load drops: ${escapeHtml(err.message)}</p>`;
  }
}

function queueLine(drop) {
  const q = state.queue[drop.id];
  if (!q) return "";
  if (q.status === "bought") return "Got them. Check your notifications.";
  if (q.status === "admitted") return "You're in. Check out before your slot expires.";
  return `In line: #${q.position}`;
}

function actionButton(drop) {
  if (!state.user) return `<button disabled>Log in to join</button>`;
  if (drop.status === "sold_out") return `<button disabled>Sold out</button>`;
  const q = state.queue[drop.id];
  if (q?.status === "bought") return `<button class="ghost" disabled>Purchased</button>`;
  if (q?.status === "admitted") {
    return `<div class="row">
      <select data-qty="${drop.id}"><option>1</option><option>2</option></select>
      <button data-buy="${drop.id}">Buy now</button></div>`;
  }
  if (q) return `<button class="ghost" disabled>Waiting…</button>`;
  return `<button data-join="${drop.id}">Join the line</button>`;
}

function renderDrops() {
  if (!state.drops.length) {
    $("#drops").innerHTML = `<p class="muted">No drops yet.</p>`;
    return;
  }
  $("#drops").innerHTML = state.drops.map((d) => `
    <article class="card drop">
      <span class="status ${d.status}">${d.status.replace("_", " ")}</span>
      <h3>${escapeHtml(d.name)}</h3>
      <p class="muted">${escapeHtml(d.description || "")}</p>
      <div class="price">${money(d.priceCents)}</div>
      <div class="stock"><div style="width:${(100 * d.remainingStock) / d.totalStock}%"></div></div>
      <div class="muted small">${d.remainingStock} / ${d.totalStock} left · ${
        d.status === "upcoming" ? `starts ${new Date(d.startsAt).toLocaleTimeString()}` : "live"
      }</div>
      <div class="queue">${queueLine(d)}</div>
      ${actionButton(d)}
    </article>`).join("");
}

$("#drops").addEventListener("click", async (event) => {
  const join = event.target.dataset.join;
  const buy = event.target.dataset.buy;
  try {
    if (join) {
      state.queue[join] = (await api("POST", `/drops/${join}/queue`)).data;
      renderDrops();
    }
    if (buy) {
      const quantity = Number(document.querySelector(`[data-qty="${buy}"]`).value);
      event.target.disabled = true;
      // A fresh key per click; a retry of the same click would reuse it.
      const key = crypto.randomUUID();
      const { data } = await api("POST", "/orders", {
        body: { dropId: buy, quantity },
        headers: { "idempotency-key": key },
      });
      state.queue[buy] = { status: "bought" };
      toast(`Order confirmed: ${money(data.totalCents)}`);
      await Promise.all([loadMe(), loadDrops()]);
    }
  } catch (err) {
    toast(err.code ? `${err.message} (${err.code})` : err.message);
    loadDrops();
  }
});

async function pollQueues() {
  const waiting = Object.entries(state.queue).filter(([, q]) => q.status === "waiting");
  for (const [dropId] of waiting) {
    try {
      state.queue[dropId] = (await api("GET", `/drops/${dropId}/queue`)).data;
    } catch { /* keep last known */ }
  }
  if (waiting.length) renderDrops();
}

// --- orders & notifications ----------------------------------------------------

async function loadMine() {
  if (!state.user) return;
  const names = Object.fromEntries(state.drops.map((d) => [d.id, d.name]));
  const [orders, notes] = await Promise.all([api("GET", "/orders"), api("GET", "/me/notifications")]);
  $("#orders").innerHTML = orders.data.length
    ? orders.data.map((o) => `<li><span>${o.quantity} × ${escapeHtml(names[o.dropId] ?? o.dropId.slice(0, 8))}</span><span>${money(o.totalCents)}</span></li>`).join("")
    : `<li class="empty">No orders yet</li>`;
  $("#notifications").innerHTML = notes.data.length
    ? notes.data.map((n) => `<li><span>${escapeHtml(n.message)}</span><span class="muted small">${new Date(n.createdAt).toLocaleTimeString()}</span></li>`).join("")
    : `<li class="empty">Nothing yet</li>`;
}

// --- boot --------------------------------------------------------------------

api("GET", "/health")
  .then(({ data }) => { $("#backend").textContent = `backend: ${data.backend}`; })
  .catch(() => { $("#backend").textContent = "backend: offline"; });

loadMe().then(loadDrops);
setInterval(loadDrops, 3000);
setInterval(pollQueues, 1000);
setInterval(loadMine, 4000);
