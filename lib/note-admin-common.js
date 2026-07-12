export function sendJson(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(status).json(payload);
}

export function readBearer(req) {
  const value = String(req.headers.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function supabaseBase() {
  return String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
}

export function anonKey() {
  return String(process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "");
}

export function serviceKey() {
  return String(process.env.SUPABASE_SERVICE_KEY || "");
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function configuredAdmins() {
  return new Set(
    String(process.env.NOTE_ADMIN_EMAILS || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean)
  );
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function serviceHeaders(json = false) {
  const key = serviceKey();
  const result = { apikey: key, Authorization: `Bearer ${key}` };
  if (json) result["Content-Type"] = "application/json";
  return result;
}

export async function serviceRequest(path, options = {}) {
  const base = supabaseBase();
  if (!base) throw new Error("Supabase URL が未設定です。");
  if (!serviceKey()) throw new Error("SUPABASE_SERVICE_KEY が未設定です。");

  const response = await fetch(`${base}${path}`, options);
  const text = await response.text().catch(() => "");
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data || {});
    const error = new Error(`Supabase error ${response.status}: ${detail.slice(0, 400)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function authenticatedUser(accessToken) {
  const base = supabaseBase();
  const anon = anonKey();
  if (!base || !anon) throw new Error("Supabase認証環境変数が未設定です。");

  const response = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return await response.json();
}

export async function requireAdmin(req) {
  const token = readBearer(req);
  if (!token) {
    const error = new Error("Googleログインが必要です。");
    error.status = 401;
    throw error;
  }

  const user = await authenticatedUser(token);
  const email = normalizeEmail(user?.email || user?.user_metadata?.email);
  if (!user?.id || !email) {
    const error = new Error("Googleログイン情報を確認できませんでした。");
    error.status = 401;
    throw error;
  }

  const admins = configuredAdmins();
  if (!admins.size) {
    const error = new Error("NOTE_ADMIN_EMAILS が未設定です。");
    error.status = 503;
    throw error;
  }
  if (!admins.has(email)) {
    const error = new Error("このGoogleアカウントには管理権限がありません。");
    error.status = 403;
    throw error;
  }

  return { user, email, token };
}

export function adminError(res, error, fallback = "管理処理に失敗しました。") {
  const status = Number(error?.status) || 500;
  console.error("note admin error", error);
  return sendJson(res, status, { ok: false, error: error?.message || fallback });
}
