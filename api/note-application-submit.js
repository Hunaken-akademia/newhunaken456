const PRODUCT_CODE = "hunaken_2026";
const FIXED_EXPIRES_AT = "2026-12-31T14:59:00.000Z";
const ALLOWED_TIERS = new Set(["regular_4000", "veteran_3000"]);
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);

function send(res, status, payload) {
  res.status(status).json(payload);
}

function readBearer(req) {
  const value = String(req.headers.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function supabaseBase() {
  return String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
}

function serviceKey() {
  return String(process.env.SUPABASE_SERVICE_KEY || "");
}

function serviceHeaders(json = false) {
  const key = serviceKey();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function serviceFetch(path, options = {}) {
  const base = supabaseBase();
  if (!base) throw new Error("Supabase URL が未設定です。");
  if (!serviceKey()) throw new Error("SUPABASE_SERVICE_KEY が未設定です。");
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text().catch(() => "");
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data || {});
    throw new Error(`Supabase error ${response.status}: ${detail.slice(0, 300)}`);
  }
  return data;
}

async function authenticatedUser(accessToken) {
  const base = supabaseBase();
  const anon = String(process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "");
  if (!base || !anon) throw new Error("Supabase認証環境変数が未設定です。");
  const response = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return await response.json();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validateBody(body, user) {
  const saleTier = String(body?.saleTier || "").trim();
  const noteBuyerName = String(body?.noteBuyerName || "").trim();
  const proofObjectPath = String(body?.proofObjectPath || "").trim();
  const purchasedAt = new Date(String(body?.purchasedAt || ""));

  if (!ALLOWED_TIERS.has(saleTier)) throw new Error("購入した記事の種類が不正です。");
  if (!noteBuyerName || noteBuyerName.length > 80) throw new Error("note購入者名を1〜80文字で入力してください。");
  if (!Number.isFinite(purchasedAt.getTime())) throw new Error("購入日時を確認してください。");
  if (purchasedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new Error("未来の購入日時は登録できません。");
  if (purchasedAt.getTime() < Date.parse("2026-01-01T00:00:00.000Z")) throw new Error("購入日時が販売対象期間より前です。");

  const prefix = `${user.id}/`;
  if (!proofObjectPath.startsWith(prefix) || proofObjectPath.includes("..") || proofObjectPath.includes("\\")) {
    throw new Error("購入証明の保存先が不正です。");
  }
  const extension = proofObjectPath.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("購入証明のファイル形式が不正です。");

  return {
    saleTier,
    noteBuyerName,
    purchasedAt: purchasedAt.toISOString(),
    proofObjectPath,
  };
}

async function existingPaidUser(email) {
  const qs = new URLSearchParams({
    select: "email,expires_at,plan",
    email: `eq.${email}`,
    limit: "1",
  });
  const rows = await serviceFetch(`/rest/v1/paid_users?${qs.toString()}`, {
    headers: serviceHeaders(false),
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function existingApplication(userId) {
  const qs = new URLSearchParams({
    select: "id,status,created_at,updated_at",
    user_id: `eq.${userId}`,
    product_code: `eq.${PRODUCT_CODE}`,
    limit: "1",
  });
  const rows = await serviceFetch(`/rest/v1/note_purchase_applications?${qs.toString()}`, {
    headers: serviceHeaders(false),
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createOrReplaceApplication(user, email, input) {
  const existing = await existingApplication(user.id);
  const common = {
    google_email: email,
    sale_tier: input.saleTier,
    note_buyer_name: input.noteBuyerName,
    purchased_at: input.purchasedAt,
    proof_object_path: input.proofObjectPath,
    status: "pending",
    proof_checked_at: null,
    proof_checked_by: null,
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    rejected_by: null,
    admin_note: null,
  };

  if (existing?.status === "approved") {
    return { existing, alreadyApproved: true };
  }

  if (existing) {
    const qs = new URLSearchParams({ id: `eq.${existing.id}` });
    const rows = await serviceFetch(`/rest/v1/note_purchase_applications?${qs.toString()}`, {
      method: "PATCH",
      headers: { ...serviceHeaders(true), Prefer: "return=representation" },
      body: JSON.stringify(common),
    });
    return { application: Array.isArray(rows) ? rows[0] : rows, replaced: true };
  }

  const payload = {
    user_id: user.id,
    google_email: email,
    product_code: PRODUCT_CODE,
    ...common,
  };
  const rows = await serviceFetch("/rest/v1/note_purchase_applications", {
    method: "POST",
    headers: { ...serviceHeaders(true), Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  return { application: Array.isArray(rows) ? rows[0] : rows, replaced: false };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "POSTのみ利用できます。" });
  }

  try {
    const token = readBearer(req);
    if (!token) return send(res, 401, { ok: false, error: "Googleログインが必要です。" });

    const user = await authenticatedUser(token);
    const email = normalizeEmail(user?.email || user?.user_metadata?.email);
    if (!user?.id || !email || !email.includes("@")) {
      return send(res, 401, { ok: false, error: "ログイン情報を確認できませんでした。" });
    }

    const paid = await existingPaidUser(email);
    if (paid && (!paid.expires_at || new Date(paid.expires_at).getTime() > Date.now())) {
      return send(res, 409, {
        ok: false,
        code: "ALREADY_ENTITLED",
        error: "このGoogleアカウントには、すでに利用権が付与されています。",
      });
    }

    const input = validateBody(req.body || {}, user);
    const result = await createOrReplaceApplication(user, email, input);
    if (result.alreadyApproved) {
      return send(res, 409, {
        ok: false,
        code: "ALREADY_APPROVED",
        error: "この申請はすでに承認されています。アプリで購入者情報を再確認してください。",
      });
    }

    return send(res, 200, {
      ok: true,
      status: "pending",
      applicationId: result.application?.id || null,
      replaced: Boolean(result.replaced),
      expiresAt: FIXED_EXPIRES_AT,
    });
  } catch (error) {
    console.error("note-application-submit error", error);
    return send(res, 400, { ok: false, error: error?.message || "申請を送信できませんでした。" });
  }
}
