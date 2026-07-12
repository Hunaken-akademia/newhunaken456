const ENV = window.__HUNAKEN_ENV__ || {};
const SUPABASE_URL = String(ENV.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = String(ENV.VITE_SUPABASE_ANON_KEY || "");
const AUTH_SESSION_KEY = "hunaken_paid_auth_session_v1";
const MAX_BATCH = 50;

const $ = (id) => document.getElementById(id);
let session = null;
let user = null;
let applications = [];
const selected = new Set();

function showOnly(name) {
  $("loadingSection").classList.toggle("hidden", name !== "loading");
  $("loginSection").classList.toggle("hidden", name !== "login");
  $("deniedSection").classList.toggle("hidden", name !== "denied");
  $("adminSection").classList.toggle("hidden", name !== "admin");
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

function authHeaders(accessToken = "", json = false) {
  const result = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
  };
  if (json) result["Content-Type"] = "application/json";
  return result;
}

async function refreshSession(value) {
  if (!value?.refresh_token || !value?.expires_at || Date.now() < Number(value.expires_at)) return value;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: authHeaders("", true),
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
    headers: authHeaders(value.access_token),
  });
  if (!response.ok) throw new Error("Googleログイン情報を確認できませんでした。");
  return await response.json();
}

function startGoogleLogin() {
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: `${location.origin}/note-admin/`,
  });
  location.href = `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
}

async function api(path, options = {}) {
  session = await refreshSession(session);
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await response.text().catch(() => "");
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || raw || "管理処理に失敗しました。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function setMessage(text, kind = "ok") {
  const box = $("message");
  box.textContent = text;
  box.className = `notice ${kind}`;
}

function clearMessage() {
  $("message").className = "notice hidden";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(status) {
  return {
    pending: "確認待ち",
    proof_checked: "購入証明確認済み",
    approved: "承認済み",
    rejected: "却下済み",
  }[status] || status;
}

function tierLabel(tier) {
  return tier === "veteran_3000" ? "古参向け 3,000円" : "通常版 4,000円";
}

function updateBatchBar() {
  const validIds = applications
    .filter((app) => app.status === "proof_checked")
    .map((app) => app.id);
  for (const id of [...selected]) {
    if (!validIds.includes(id)) selected.delete(id);
  }
  $("selectedCount").textContent = String(selected.size);
  $("batchBar").classList.toggle("hidden", selected.size === 0);
  $("approveSelectedButton").disabled = selected.size === 0;

  const all = validIds.length > 0 && validIds.slice(0, MAX_BATCH).every((id) => selected.has(id));
  $("selectAll").checked = all;
  $("selectAll").indeterminate = selected.size > 0 && !all;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detail(label, value) {
  const box = el("div", "detail");
  box.append(el("span", "", label), el("strong", "", value));
  return box;
}

function renderCard(app) {
  const card = el("article", `applicationCard${selected.has(app.id) ? " checked" : ""}`);
  const top = el("div", "cardTop");

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "selectBox";
  check.checked = selected.has(app.id);
  check.disabled = app.status !== "proof_checked";
  check.setAttribute("aria-label", `${app.noteBuyerName}を選択`);
  check.addEventListener("change", () => {
    if (check.checked) {
      if (selected.size >= MAX_BATCH) {
        check.checked = false;
        setMessage("一度に選択できるのは50件までです。", "error");
        return;
      }
      selected.add(app.id);
    } else {
      selected.delete(app.id);
    }
    card.classList.toggle("checked", selected.has(app.id));
    updateBatchBar();
  });

  const identity = el("div", "cardIdentity");
  identity.append(el("h3", "", app.noteBuyerName), el("div", "email", app.googleEmail));
  const badge = el("span", `badge ${app.status}`, statusLabel(app.status));
  top.append(check, identity, badge);

  const details = el("div", "details");
  details.append(
    detail("購入した記事", tierLabel(app.saleTier)),
    detail("note購入日時", formatDate(app.purchasedAt)),
    detail("申請日時", formatDate(app.createdAt)),
    detail("証明確認日時", formatDate(app.proofCheckedAt)),
    detail("承認日時", formatDate(app.approvedAt)),
    detail("申請ID", app.id.slice(0, 8))
  );

  card.append(top, details);
  if (app.adminNote) card.append(el("div", "adminNote", app.adminNote));

  const actions = el("div", "cardActions");
  const proofButton = el("button", "proof", "購入証明を開く");
  proofButton.type = "button";
  proofButton.addEventListener("click", () => openProof(app));
  actions.append(proofButton);

  if (app.status === "pending") {
    const verify = el("button", "verify", "購入証明を確認済みにする");
    verify.type = "button";
    verify.addEventListener("click", () => markChecked(app, true, verify));
    actions.append(verify);
  }

  if (app.status === "proof_checked") {
    const unverify = el("button", "unverify", "確認済みを解除");
    unverify.type = "button";
    unverify.addEventListener("click", () => markChecked(app, false, unverify));
    const approve = el("button", "approveOne", "この1件を承認");
    approve.type = "button";
    approve.addEventListener("click", () => approveBatch([app.id]));
    actions.append(unverify, approve);
  }

  if (app.status === "pending" || app.status === "proof_checked" || app.status === "rejected") {
    const reject = el("button", "reject", app.status === "rejected" ? "却下理由を変更" : "却下する");
    reject.type = "button";
    reject.addEventListener("click", () => rejectApplication(app, reject));
    actions.append(reject);
  }

  card.append(actions);
  return card;
}

function render() {
  const list = $("applicationList");
  list.replaceChildren();
  $("applicationCount").textContent = String(applications.length);
  $("emptyState").classList.toggle("hidden", applications.length !== 0);
  applications.forEach((app) => list.append(renderCard(app)));
  updateBatchBar();
}

async function loadApplications() {
  clearMessage();
  $("reloadButton").disabled = true;
  try {
    const status = $("statusFilter").value;
    const data = await api(`/api/note-admin-list?status=${encodeURIComponent(status)}`);
    applications = data.applications || [];
    $("adminEmail").textContent = data.adminEmail || user?.email || "";
    showOnly("admin");
    render();
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 503) {
      $("deniedMessage").textContent = error.message;
      showOnly("denied");
    } else {
      showOnly("admin");
      setMessage(error.message, "error");
    }
  } finally {
    $("reloadButton").disabled = false;
  }
}

async function markChecked(app, checked, button) {
  if (checked && !confirm(`${app.noteBuyerName}さんの購入証明を「確認済み」にしますか？`)) return;
  button.disabled = true;
  try {
    await api("/api/note-admin-mark-checked", {
      method: "POST",
      body: JSON.stringify({ applicationId: app.id, checked }),
    });
    await loadApplications();
    setMessage(checked ? "購入証明を確認済みにしました。" : "確認済みを解除しました。", "ok");
  } catch (error) {
    setMessage(error.message, "error");
    button.disabled = false;
  }
}

async function rejectApplication(app, button) {
  const reason = prompt("購入者に表示する却下理由を入力してください。", app.adminNote || "購入証明の内容を確認できませんでした。正しい購入画面で再申請してください。");
  if (reason === null) return;
  const trimmed = reason.trim();
  if (!trimmed) return setMessage("却下理由を入力してください。", "error");
  if (!confirm(`${app.noteBuyerName}さんの申請を却下しますか？`)) return;

  button.disabled = true;
  try {
    await api("/api/note-admin-reject", {
      method: "POST",
      body: JSON.stringify({ applicationId: app.id, reason: trimmed }),
    });
    selected.delete(app.id);
    await loadApplications();
    setMessage("申請を却下しました。購入者は内容を直して再申請できます。", "ok");
  } catch (error) {
    setMessage(error.message, "error");
    button.disabled = false;
  }
}

async function approveBatch(ids) {
  const uniqueIds = [...new Set(ids)].slice(0, MAX_BATCH);
  const targets = applications.filter((app) => uniqueIds.includes(app.id));
  if (!targets.length) return;
  if (!targets.every((app) => app.status === "proof_checked")) {
    return setMessage("購入証明が確認済みの申請だけ承認できます。", "error");
  }
  const names = targets.slice(0, 5).map((app) => `・${app.noteBuyerName}`).join("\n");
  const extra = targets.length > 5 ? `\nほか${targets.length - 5}件` : "";
  if (!confirm(`${targets.length}件を承認し、paid_usersへ追加します。\n\n${names}${extra}\n\n既存の利用権は上書きしません。実行しますか？`)) return;

  $("approveSelectedButton").disabled = true;
  try {
    const data = await api("/api/note-admin-approve-batch", {
      method: "POST",
      body: JSON.stringify({ applicationIds: uniqueIds }),
    });
    const s = data.summary || {};
    selected.clear();
    await loadApplications();
    setMessage(
      `承認処理が完了しました。\n新規利用権：${s.approvedCreated || 0}件\n既存利用権を確認：${s.approvedExisting || 0}件\nすでに承認済み：${s.alreadyApproved || 0}件\n未確認のため未処理：${s.proofNotChecked || 0}件`,
      "ok"
    );
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    $("approveSelectedButton").disabled = false;
  }
}

async function openProof(app) {
  const modal = $("proofModal");
  modal.classList.remove("hidden");
  $("proofLoading").classList.remove("hidden");
  $("proofImage").classList.add("hidden");
  $("proofPdf").classList.add("hidden");
  $("openProofLink").classList.add("hidden");
  $("proofImage").removeAttribute("src");
  $("proofPdf").removeAttribute("src");

  try {
    const data = await api("/api/note-admin-proof-url", {
      method: "POST",
      body: JSON.stringify({ applicationId: app.id }),
    });
    $("proofLoading").classList.add("hidden");
    const isPdf = String(data.extension || "").toLowerCase() === "pdf";
    const media = isPdf ? $("proofPdf") : $("proofImage");
    media.src = data.url;
    media.classList.remove("hidden");
    $("openProofLink").href = data.url;
    $("openProofLink").classList.remove("hidden");
  } catch (error) {
    $("proofLoading").textContent = error.message;
  }
}

function closeProof() {
  $("proofModal").classList.add("hidden");
  $("proofImage").removeAttribute("src");
  $("proofPdf").removeAttribute("src");
  $("proofLoading").textContent = "読み込み中…";
}

async function boot() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    $("deniedMessage").textContent = "Supabase環境変数が未設定です。";
    showOnly("denied");
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
    await loadApplications();
  } catch (error) {
    clearSession();
    $("deniedMessage").textContent = error.message || "ログイン情報を確認できませんでした。";
    showOnly("denied");
  }
}

$("loginButton").addEventListener("click", startGoogleLogin);
$("logoutButton").addEventListener("click", () => { clearSession(); location.replace("/note-admin/"); });
$("deniedLogoutButton").addEventListener("click", () => { clearSession(); location.replace("/note-admin/"); });
$("reloadButton").addEventListener("click", loadApplications);
$("statusFilter").addEventListener("change", () => { selected.clear(); loadApplications(); });
$("selectAll").addEventListener("change", (event) => {
  selected.clear();
  if (event.target.checked) {
    applications.filter((app) => app.status === "proof_checked").slice(0, MAX_BATCH).forEach((app) => selected.add(app.id));
  }
  render();
});
$("approveSelectedButton").addEventListener("click", () => approveBatch([...selected]));
$("closeProofButton").addEventListener("click", closeProof);
$("proofModal").addEventListener("click", (event) => { if (event.target === $("proofModal")) closeProof(); });

document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeProof(); });

boot();
