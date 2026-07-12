const ENV = window.__HUNAKEN_ENV__ || {};
const SUPABASE_URL = String(ENV.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = String(ENV.VITE_SUPABASE_ANON_KEY || "");
const AUTH_SESSION_KEY = "hunaken_paid_auth_session_v1";
const BUCKET = "note-purchase-proofs";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const $ = (id) => document.getElementById(id);
const sections = {
  loading: $("loadingSection"),
  login: $("loginSection"),
  form: $("formSection"),
  success: $("successSection"),
};

let session = null;
let user = null;
let currentApplication = null;

function showOnly(name) {
  Object.entries(sections).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
}

function headers(accessToken = "", json = false) {
  const result = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
  };
  if (json) result["Content-Type"] = "application/json";
  return result;
}

function saveSession(value) {
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(value));
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null"); }
  catch { return null; }
}

function clearSession() {
  localStorage.removeItem(AUTH_SESSION_KEY);
}

function sessionFromHash() {
  const hash = String(location.hash || "").replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  if (!accessToken) return null;
  const expiresIn = Number(params.get("expires_in") || 3600);
  return {
    access_token: accessToken,
    refresh_token: params.get("refresh_token") || "",
    token_type: params.get("token_type") || "bearer",
    expires_at: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  };
}

async function refreshSession(value) {
  if (!value?.refresh_token || !value?.expires_at || Date.now() < Number(value.expires_at)) return value;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: headers("", true),
    body: JSON.stringify({ refresh_token: value.refresh_token }),
  });
  if (!response.ok) throw new Error("ログイン期限が切れました。もう一度Googleログインしてください。");
  const data = await response.json();
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || value.refresh_token,
    token_type: data.token_type || "bearer",
    expires_at: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
  };
  saveSession(next);
  return next;
}

async function fetchUser(value) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: headers(value.access_token),
  });
  if (!response.ok) throw new Error("Googleログイン情報を確認できませんでした。");
  return await response.json();
}

function startGoogleLogin() {
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: `${location.origin}/note-activation/`,
  });
  location.href = `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
}

async function fetchCurrentApplication() {
  const params = new URLSearchParams({
    select: "id,status,sale_tier,note_buyer_name,purchased_at,created_at,updated_at,admin_note",
    user_id: `eq.${user.id}`,
    product_code: "eq.hunaken_2026",
    limit: "1",
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/note_purchase_applications?${params.toString()}`, {
    headers: headers(session.access_token),
  });
  if (!response.ok) return null;
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

function displayStatus(application) {
  const box = $("currentStatus");
  if (!application) {
    box.className = "notice hidden";
    return;
  }
  const labels = {
    pending: ["申請確認待ち", "購入証明を確認しています。", "warn"],
    proof_checked: ["購入証明確認済み", "管理者の最終承認待ちです。", "warn"],
    approved: ["承認済み", "利用権が付与されています。有料版で再確認してください。", "ok"],
    rejected: ["再申請が必要です", application.admin_note || "申請内容を確認し、正しい購入証明で再申請してください。", "error"],
  };
  const [title, message, kind] = labels[application.status] || ["申請状態", application.status, "warn"];
  box.className = `notice ${kind}`;
  box.textContent = `${title}\n${message}`;

  if (application.status === "approved") {
    $("applicationForm").classList.add("hidden");
  }
}

function extensionFor(file) {
  const byType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
  };
  return byType[file.type] || "";
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function uploadProof(file) {
  if (!ALLOWED_TYPES.has(file.type)) throw new Error("JPEG・PNG・WebP・PDFのいずれかを選択してください。");
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) throw new Error("購入証明は5MB以内にしてください。");
  const ext = extensionFor(file);
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = `${user.id}/${Date.now()}-${random}.${ext}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodedPath(path)}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": file.type,
      "x-upsert": "false",
      "Cache-Control": "3600",
    },
    body: file,
  });
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    let detail = raw;
    try { detail = JSON.parse(raw)?.message || raw; } catch { /* noop */ }
    throw new Error(`購入証明を保存できませんでした。${detail ? ` ${String(detail).slice(0, 160)}` : ""}`);
  }
  return path;
}

async function submitApplication(event) {
  event.preventDefault();
  const button = $("submitButton");
  const message = $("submitMessage");
  const file = $("proofFile").files?.[0];

  message.className = "notice hidden";
  if (!$("declaration").checked) return;
  if (!file) {
    message.className = "notice error";
    message.textContent = "購入証明を選択してください。";
    return;
  }

  button.disabled = true;
  button.textContent = "購入証明を保存中…";
  try {
    session = await refreshSession(session);
    const proofObjectPath = await uploadProof(file);
    button.textContent = "申請を送信中…";

    const localValue = $("purchasedAt").value;
    const purchasedAt = new Date(localValue);
    if (!Number.isFinite(purchasedAt.getTime())) throw new Error("購入日時を確認してください。");

    const response = await fetch("/api/note-application-submit", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        saleTier: $("saleTier").value,
        noteBuyerName: $("noteBuyerName").value.trim(),
        purchasedAt: purchasedAt.toISOString(),
        proofObjectPath,
      }),
    });
    const raw = await response.text().catch(() => "");
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok || !data.ok) throw new Error(data.error || raw || "申請を送信できませんでした。");

    showOnly("success");
  } catch (error) {
    message.className = "notice error";
    message.textContent = error?.message || "申請を送信できませんでした。";
    button.disabled = false;
    button.textContent = "申請を送信する";
  }
}

function updateSubmitState() {
  const file = $("proofFile").files?.[0];
  const ready = Boolean(
    $("declaration").checked &&
    $("noteBuyerName").value.trim() &&
    $("purchasedAt").value &&
    file
  );
  $("submitButton").disabled = !ready;
}

async function boot() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    $("configError").textContent = "Supabase環境変数が未設定です。管理者へ連絡してください。";
    $("configError").classList.remove("hidden");
    showOnly("login");
    $("loginButton").disabled = true;
    return;
  }

  const hashSession = sessionFromHash();
  if (hashSession) {
    saveSession(hashSession);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  session = hashSession || loadSession();
  if (!session?.access_token) {
    showOnly("login");
    return;
  }

  try {
    session = await refreshSession(session);
    user = await fetchUser(session);
    const email = String(user?.email || user?.user_metadata?.email || "").trim().toLowerCase();
    if (!user?.id || !email) throw new Error("Googleメールを確認できませんでした。");
    $("userEmail").textContent = email;
    currentApplication = await fetchCurrentApplication();
    displayStatus(currentApplication);
    showOnly("form");
  } catch (error) {
    clearSession();
    showOnly("login");
    $("configError").textContent = error?.message || "ログイン情報を確認できませんでした。";
    $("configError").className = "notice error";
  }
}

$("loginButton").addEventListener("click", startGoogleLogin);
$("logoutButton").addEventListener("click", () => {
  clearSession();
  location.replace("/note-activation/");
});
$("applicationForm").addEventListener("submit", submitApplication);
$("proofFile").addEventListener("change", () => {
  const file = $("proofFile").files?.[0];
  $("fileLabel").textContent = file ? file.name : "購入証明を選択";
  updateSubmitState();
});
["noteBuyerName", "purchasedAt", "saleTier", "declaration"].forEach((id) => {
  $(id).addEventListener(id === "saleTier" ? "change" : "input", updateSubmitState);
  $(id).addEventListener("change", updateSubmitState);
});

boot();
