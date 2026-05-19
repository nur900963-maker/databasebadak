// ============================================
// BADAK-WA API SERVER - Deploy ke Vercel
// ============================================

const https = require("https");
const http = require("http");
const { URL } = require("url");

// ============ ENV ============
const ADMIN_SECRET = process.env.ADMIN_SECRET || "badakwa_admin_2024";
const API_KEY = process.env.API_KEY || "badakwa_apikey_secret";

// ============ IN-MEMORY FALLBACK ============
let usersDB = {};

// ============ UPSTASH REDIS ============
function getRedis() {
  return {
    url: "https://rich-airedale-129647.upstash.io",
    token: "gQAAAAAAAfpvAAIgcDE4MTZjMTlmMTE3YTE0ZGUyYmFkYmNiMGJmYzE5YWRiMA",
  };
}

function fetchHTTP(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === "https:" ? https : http;
    const bodyStr = options.body ? JSON.stringify(options.body) : null;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ result: data }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function redisGet(key) {
  const { url, token } = getRedis();
  if (!url || !token) return null;
  try {
    const r = await fetchHTTP(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.result ? JSON.parse(r.result) : null;
  } catch { return null; }
}

async function redisSet(key, value) {
  const { url, token } = getRedis();
  if (!url || !token) return false;
  try {
    await fetchHTTP(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return true;
  } catch { return false; }
}

async function redisDel(key) {
  const { url, token } = getRedis();
  if (!url || !token) return false;
  try {
    await fetchHTTP(`${url}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return true;
  } catch { return false; }
}

async function redisKeys(pattern) {
  const { url, token } = getRedis();
  if (!url || !token) return null;
  try {
    const r = await fetchHTTP(`${url}/keys/${encodeURIComponent(pattern)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.result || [];
  } catch { return []; }
}

// ============ DB LAYER ============
async function getUser(username) {
  const fromRedis = await redisGet(`user:${username}`);
  if (fromRedis) return fromRedis;
  return usersDB[username] || null;
}

async function saveUser(username, data) {
  await redisSet(`user:${username}`, data);
  usersDB[username] = data;
}

async function deleteUser(username) {
  await redisDel(`user:${username}`);
  delete usersDB[username];
}

async function getAllUsers() {
  const keys = await redisKeys("user:*");
  if (keys && keys.length > 0) {
    const users = {};
    for (const key of keys) {
      const uname = key.replace("user:", "");
      const data = await redisGet(key);
      if (data) users[uname] = data;
    }
    return users;
  }
  return { ...usersDB };
}

// ============ HELPERS ============
function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

function addDays(date, days) {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function isExpired(expiredAt) {
  if (!expiredAt) return false;
  return new Date() > new Date(expiredAt);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
}

function json(res, status, data) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function checkApiKey(req) {
  const key =
    req.headers["x-api-key"] ||
    (req.headers["authorization"] || "").replace("Bearer ", "");
  return key === API_KEY;
}

// ============ HANDLERS ============

// POST /api/setup-redis — simpan Upstash credentials langsung via API
async function handleSetupRedis(req, res) {
  const body = await parseBody(req);
  const { admin_secret, upstash_url, upstash_token } = body;

  if (admin_secret !== ADMIN_SECRET) {
    return json(res, 403, { success: false, message: "Admin secret salah" });
  }
  if (!upstash_url || !upstash_token) {
    return json(res, 400, { success: false, message: "upstash_url dan upstash_token wajib diisi" });
  }

  // Verifikasi koneksi dulu
  try {
    const test = await fetchHTTP(`${upstash_url}/ping`, {
      headers: { Authorization: `Bearer ${upstash_token}` },
    });
    if (test.result !== "PONG") throw new Error("PONG mismatch");
  } catch {
    return json(res, 400, {
      success: false,
      message: "Gagal konek ke Upstash. Cek URL dan Token-nya lagi.",
    });
  }

  // Simpan credentials ke Redis itu sendiri sebagai self-hosted config marker
  // Di production, env var lebih aman. Tapi ini bisa jadi cara alternatif.
  // Note: env var harus tetap di-set di Vercel untuk persistence antar cold start
  "https://rich-airedale-129647.upstash.io" = upstash_url;
  "gQAAAAAAAfpvAAIgcDE4MTZjMTlmMTE3YTE0ZGUyYmFkYmNiMGJmYzE5YWRiMA" = upstash_token;

  return json(res, 200, {
    success: true,
    message: "✅ Upstash Redis berhasil terkoneksi! Tapi agar permanen, lo HARUS set env var di Vercel juga (lihat instruksi).",
    catatan: "Koneksi ini cuma aktif selama session ini. Biar permanen: Vercel → Settings → Environment Variables → tambah UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN → Redeploy.",
    status: "connected",
  });
}

// GET /api/ping
function handlePing(req, res) {
  const { url, token } = getRedis();
  json(res, 200, {
    success: true,
    message: "🦏 Badak-WA API aktif!",
    timestamp: new Date().toISOString(),
    storage: url && token ? "✅ Upstash Redis (data permanen)" : "⚠️ In-Memory (data hilang saat restart)",
  });
}

// POST /api/register
async function handleRegister(req, res) {
  const body = await parseBody(req);
  const { username, password, duration_days, admin_secret } = body;

  if (!username || !password)
    return json(res, 400, { success: false, message: "Username dan password wajib diisi" });

  if (admin_secret !== ADMIN_SECRET && !checkApiKey(req))
    return json(res, 403, { success: false, message: "Admin secret tidak valid" });

  const existing = await getUser(username);
  if (existing)
    return json(res, 409, { success: false, message: "Username sudah terdaftar" });

  const days = parseInt(duration_days) || 30;
  const now = new Date();
  const expiredAt = addDays(now, days);

  const userData = {
    username,
    password,
    created_at: now.toISOString(),
    expired_at: expiredAt.toISOString(),
    duration_days: days,
    status: "active",
  };

  await saveUser(username, userData);

  return json(res, 201, {
    success: true,
    message: "✅ Akun berhasil dibuat",
    data: {
      username,
      expired_at: expiredAt.toISOString(),
      duration_days: days,
      status: "active",
    },
  });
}

// POST /api/login
async function handleLogin(req, res) {
  const body = await parseBody(req);
  const { username, password } = body;

  if (!username || !password)
    return json(res, 400, { success: false, message: "Username dan password wajib diisi" });

  const user = await getUser(username);

  if (!user)
    return json(res, 404, { success: false, message: "Akun tidak ditemukan" });

  if (user.password !== password)
    return json(res, 401, { success: false, message: "Password salah" });

  if (user.status === "banned")
    return json(res, 403, { success: false, message: "Akun kamu dibanned oleh admin" });

  if (isExpired(user.expired_at))
    return json(res, 403, {
      success: false,
      message: "Akun kamu sudah expired, hubungi admin",
      expired_at: user.expired_at,
    });

  const sisaHari = Math.ceil(
    (new Date(user.expired_at) - new Date()) / (1000 * 60 * 60 * 24)
  );

  return json(res, 200, {
    success: true,
    message: "✅ Login berhasil",
    data: {
      username: user.username,
      expired_at: user.expired_at,
      sisa_hari: sisaHari,
      status: user.status,
    },
  });
}

// GET /api/check?username=xxx
async function handleCheck(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const username = u.searchParams.get("username");

  if (!username)
    return json(res, 400, { success: false, message: "Parameter username diperlukan" });

  const user = await getUser(username);
  if (!user)
    return json(res, 404, { success: false, message: "Akun tidak ditemukan" });

  const expired = isExpired(user.expired_at);
  const sisaHari = expired
    ? 0
    : Math.ceil((new Date(user.expired_at) - new Date()) / (1000 * 60 * 60 * 24));

  return json(res, 200, {
    success: true,
    data: {
      username: user.username,
      expired_at: user.expired_at,
      sisa_hari: sisaHari,
      is_expired: expired,
      status: user.status,
    },
  });
}

// GET /api/users
async function handleUsers(req, res) {
  if (!checkApiKey(req))
    return json(res, 403, { success: false, message: "API Key tidak valid" });

  const users = await getAllUsers();
  const list = Object.values(users).map((u) => ({
    username: u.username,
    expired_at: u.expired_at,
    status: u.status,
    is_expired: isExpired(u.expired_at),
    sisa_hari: isExpired(u.expired_at)
      ? 0
      : Math.ceil((new Date(u.expired_at) - new Date()) / (1000 * 60 * 60 * 24)),
  }));

  return json(res, 200, { success: true, count: list.length, data: list });
}

// POST /api/extend
async function handleExtend(req, res) {
  if (!checkApiKey(req))
    return json(res, 403, { success: false, message: "API Key tidak valid" });

  const body = await parseBody(req);
  const { username, duration_days } = body;

  if (!username)
    return json(res, 400, { success: false, message: "Username wajib diisi" });

  const user = await getUser(username);
  if (!user)
    return json(res, 404, { success: false, message: "Akun tidak ditemukan" });

  const days = parseInt(duration_days) || 30;
  const base = isExpired(user.expired_at) ? new Date() : new Date(user.expired_at);
  const newExpired = addDays(base, days);

  user.expired_at = newExpired.toISOString();
  user.status = "active";
  await saveUser(username, user);

  return json(res, 200, {
    success: true,
    message: `✅ Durasi diperpanjang ${days} hari`,
    data: { username, new_expired_at: newExpired.toISOString() },
  });
}

// DELETE /api/delete
async function handleDelete(req, res) {
  if (!checkApiKey(req))
    return json(res, 403, { success: false, message: "API Key tidak valid" });

  const body = await parseBody(req);
  const { username } = body;

  if (!username)
    return json(res, 400, { success: false, message: "Username wajib diisi" });

  const user = await getUser(username);
  if (!user)
    return json(res, 404, { success: false, message: "Akun tidak ditemukan" });

  await deleteUser(username);
  return json(res, 200, { success: true, message: `✅ User ${username} berhasil dihapus` });
}

// ============ MAIN HANDLER ============
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 200;
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;

  if (path === "/api/ping" && req.method === "GET") return handlePing(req, res);
  if (path === "/api/setup-redis" && req.method === "POST") return handleSetupRedis(req, res);
  if (path === "/api/register" && req.method === "POST") return handleRegister(req, res);
  if (path === "/api/login" && req.method === "POST") return handleLogin(req, res);
  if (path === "/api/check" && req.method === "GET") return handleCheck(req, res);
  if (path === "/api/users" && req.method === "GET") return handleUsers(req, res);
  if (path === "/api/extend" && req.method === "POST") return handleExtend(req, res);
  if (path === "/api/delete" && req.method === "DELETE") return handleDelete(req, res);

  if (path === "/" || path === "/api") {
    cors(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      name: "🦏 Badak-WA API",
      version: "2.0.0",
      storage: getRedis().url ? "✅ Upstash Redis" : "⚠️ In-Memory",
      endpoints: [
        "GET  /api/ping",
        "POST /api/setup-redis  ← setup Upstash via API",
        "POST /api/register",
        "POST /api/login",
        "GET  /api/check?username=xxx",
        "GET  /api/users         ← butuh x-api-key",
        "POST /api/extend        ← butuh x-api-key",
        "DELETE /api/delete      ← butuh x-api-key",
      ],
    }));
    return;
  }

  return json(res, 404, { success: false, message: "Endpoint tidak ditemukan" });
};
