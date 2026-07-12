const VERSION = "v121-cloud-save-v3-v64-safe";
const TABLE = "hunaken_user_data";
const AUTH_SESSION_KEY = "hunaken_paid_auth_session_v1";
const RECORDS_KEY = "hunaken_records";
const BETS_KEY = "hunaken_betRecords";
const ACTIVE_USER_KEY = "hunaken_cloud_active_user_v3";
const MAX_RECORDS = 100;
const MAX_BETS = 300;

const runtimeEnv = window.__HUNAKEN_ENV__ || {};
const supabaseUrl = String(runtimeEnv.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey = String(runtimeEnv.VITE_SUPABASE_ANON_KEY || "");

const state = {
  version: VERSION,
  phase: "idle",
  ready: false,
  busy: false,
  user: null,
  userId: "",
  hadCloudRow: false,
  cloudRecords: [],
  cloudBets: [],
  cloudSignature: null,
  updatedAt: null,
  error: "",
};
window.__HUNAKEN_CLOUD_V3_STATE__ = state;

let statusEl = null;
let saveButton = null;
let dirtyTimer = null;
let logoutListenerInstalled = false;

function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function sortAndLimit(items, max) {
  return normalizeArray(items)
    .slice()
    .sort((a, b) => Number(b?.savedAt || b?.id?.split?.("_")?.[0] || 0) - Number(a?.savedAt || a?.id?.split?.("_")?.[0] || 0))
    .slice(0, max);
}

function normalizeRecords(value) {
  return sortAndLimit(value, MAX_RECORDS);
}

function normalizeBets(value) {
  return sortAndLimit(value, MAX_BETS);
}

function signature(records, bets) {
  return JSON.stringify({ records: normalizeRecords(records), betRecords: normalizeBets(bets) });
}

function sessionFromHash() {
  try {
    const hash = String(window.location?.hash || "").replace(/^#/, "");
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
  } catch (_error) {
    return null;
  }
}

function readSession() {
  try {
    const callbackSession = sessionFromHash();
    if (callbackSession) {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(callbackSession));
      try {
        window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
      } catch (_error) {
        // URL整理に失敗してもログイン処理は継続する。
      }
      return callbackSession;
    }
    return safeJsonParse(localStorage.getItem(AUTH_SESSION_KEY), null);
  } catch (_error) {
    return null;
  }
}

function writeSession(session) {
  try {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  } catch (_error) {
    // 認証本体側でも保存されるため、ここでは処理を止めない。
  }
}

function authHeaders(accessToken, json = false) {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken || anonKey}`,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function expiresAtMs(session) {
  const raw = Number(session?.expires_at || 0);
  if (!raw) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

async function activeSession() {
  let session = readSession();
  if (!session?.access_token) throw new Error("Googleログイン情報がありません。");

  const expiry = expiresAtMs(session);
  if (!expiry || Date.now() < expiry - 30_000) return session;
  if (!session.refresh_token) throw new Error("ログイン期限が切れました。再ログインしてください。");

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: authHeaders("", true),
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const raw = await response.text().catch(() => "");
  const data = safeJsonParse(raw, {});
  if (!response.ok || !data.access_token) {
    throw new Error("ログイン期限が切れました。再ログインしてください。");
  }

  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || session.refresh_token,
    token_type: data.token_type || "bearer",
    expires_at: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
  };
  writeSession(session);
  return session;
}

async function fetchCurrentUser(session) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: authHeaders(session.access_token),
  });
  const raw = await response.text().catch(() => "");
  const data = safeJsonParse(raw, {});
  if (!response.ok || !data?.id) {
    throw new Error("Googleログイン情報を確認できません。再ログインしてください。");
  }
  return data;
}

async function fetchCloudRow(session, userId) {
  const params = new URLSearchParams();
  params.set("select", "user_id,records,bet_records,updated_at");
  params.set("user_id", `eq.${userId}`);
  params.set("limit", "1");
  const response = await fetch(`${supabaseUrl}/rest/v1/${TABLE}?${params.toString()}`, {
    headers: authHeaders(session.access_token),
  });
  const raw = await response.text().catch(() => "");
  const rows = safeJsonParse(raw, []);
  if (!response.ok) {
    throw new Error(`クラウド読込に失敗しました（${response.status}）`);
  }
  return Array.isArray(rows) ? rows[0] || null : null;
}

function localArray(key) {
  try {
    const parsed = safeJsonParse(localStorage.getItem(key), []);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

async function appStorageArray(storageKey) {
  try {
    if (window.storage && typeof window.storage.get === "function") {
      const result = await window.storage.get(storageKey);
      const parsed = safeJsonParse(result?.value, null);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_error) {
    // localStorage を使用する。
  }
  return null;
}

async function readShadowData() {
  const localRecords = localArray(RECORDS_KEY);
  const localBets = localArray(BETS_KEY);
  if (localRecords.length || localBets.length) {
    return { records: normalizeRecords(localRecords), bets: normalizeBets(localBets) };
  }
  const [storedRecords, storedBets] = await Promise.all([
    appStorageArray("records"),
    appStorageArray("betRecords"),
  ]);
  return {
    records: normalizeRecords(storedRecords || localRecords),
    bets: normalizeBets(storedBets || localBets),
  };
}

async function writeShadowData(records, bets) {
  const normalizedRecords = normalizeRecords(records);
  const normalizedBets = normalizeBets(bets);
  const recordsJson = JSON.stringify(normalizedRecords);
  const betsJson = JSON.stringify(normalizedBets);

  localStorage.setItem(RECORDS_KEY, recordsJson);
  localStorage.setItem(BETS_KEY, betsJson);

  if (window.storage && typeof window.storage.set === "function") {
    await Promise.all([
      window.storage.set("records", recordsJson),
      window.storage.set("betRecords", betsJson),
    ]);
  }
  return { records: normalizedRecords, bets: normalizedBets };
}

async function clearShadowData() {
  try { localStorage.removeItem(RECORDS_KEY); } catch (_error) { /* noop */ }
  try { localStorage.removeItem(BETS_KEY); } catch (_error) { /* noop */ }
  if (window.storage && typeof window.storage.set === "function") {
    try {
      await Promise.all([
        window.storage.set("records", "[]"),
        window.storage.set("betRecords", "[]"),
      ]);
    } catch (_error) {
      // localStorage は既に消去済み。
    }
  }
}

function setActiveUser(userId) {
  try { localStorage.setItem(ACTIVE_USER_KEY, String(userId || "")); } catch (_error) { /* noop */ }
}

function activeUserId() {
  try { return String(localStorage.getItem(ACTIVE_USER_KEY) || ""); } catch (_error) { return ""; }
}

function clearActiveUser() {
  try { localStorage.removeItem(ACTIVE_USER_KEY); } catch (_error) { /* noop */ }
}

function setStatus(message, kind = "normal") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = kind === "error"
    ? "#ff9b91"
    : kind === "success"
      ? "#79e4aa"
      : kind === "dirty"
        ? "#ffd166"
        : "#9db5cc";
}

function setBusy(next) {
  state.busy = Boolean(next);
  if (!saveButton) return;
  const disabled = state.busy || !state.ready;
  saveButton.disabled = disabled;
  saveButton.style.opacity = disabled ? "0.58" : "1";
  saveButton.style.cursor = disabled ? "not-allowed" : "pointer";
  saveButton.textContent = state.busy ? "保存中…" : "今すぐ保存";
}

function applyStateFromRow(user, row, records, bets) {
  state.user = user;
  state.userId = String(user?.id || "");
  state.hadCloudRow = Boolean(row);
  state.cloudRecords = normalizeRecords(records);
  state.cloudBets = normalizeBets(bets);
  state.cloudSignature = signature(state.cloudRecords, state.cloudBets);
  state.updatedAt = row?.updated_at || null;
  state.error = "";
  state.ready = true;
  state.phase = "ready";
}

export async function bootstrapCloudData() {
  state.phase = "loading";
  state.ready = false;
  state.error = "";

  if (!supabaseUrl || !anonKey) {
    state.phase = "error";
    state.error = "クラウド保存の環境変数が未設定です。";
    await clearShadowData();
    return state;
  }

  try {
    const session = await activeSession();
    const user = await fetchCurrentUser(session);
    const userId = String(user.id);

    // v64方式：アカウントが変わった瞬間に前の端末データを消す。
    if (activeUserId() !== userId) {
      await clearShadowData();
      setActiveUser(userId);
    }

    const row = await fetchCloudRow(session, userId);
    const records = row ? normalizeRecords(row.records) : [];
    const bets = row ? normalizeBets(row.bet_records) : [];

    // v64方式：ログイン中はクラウドを唯一の正とし、端末データとマージしない。
    const written = await writeShadowData(records, bets);
    applyStateFromRow(user, row, written.records, written.bets);
    return state;
  } catch (error) {
    console.error(`[${VERSION}] bootstrap failed`, error);
    state.phase = "error";
    state.ready = false;
    state.error = error?.message || "クラウド保存の読込に失敗しました。";
    // 読込失敗時は古い別アカウントデータを画面へ出さない。保存ボタンも無効のまま。
    await clearShadowData();
    return state;
  }
}

async function patchOrInsertCloud(session, userId, existing, records, bets) {
  const updatedAt = new Date().toISOString();
  const payload = { records, bet_records: bets, updated_at: updatedAt };
  let response;

  if (existing) {
    const params = new URLSearchParams();
    params.set("user_id", `eq.${userId}`);
    // 取得後に別端末で更新された場合は上書きしないため、更新日時も条件に含める。
    if (existing.updated_at) params.set("updated_at", `eq.${existing.updated_at}`);
    response = await fetch(`${supabaseUrl}/rest/v1/${TABLE}?${params.toString()}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(session.access_token, true),
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });
  } else {
    response = await fetch(`${supabaseUrl}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: {
        ...authHeaders(session.access_token, true),
        Prefer: "return=representation",
      },
      body: JSON.stringify({ user_id: userId, ...payload }),
    });
  }

  const raw = await response.text().catch(() => "");
  const returned = safeJsonParse(raw, []);
  if (!response.ok) {
    const details = safeJsonParse(raw, {});
    throw new Error(details?.message || `クラウド保存に失敗しました（${response.status}）`);
  }
  if (existing && (!Array.isArray(returned) || returned.length !== 1)) {
    throw new Error("別端末でデータが更新されました。ページを再読み込みしてからやり直してください。");
  }
  return { updatedAt, row: Array.isArray(returned) ? returned[0] || null : null };
}

export async function saveCloudNow() {
  if (state.busy) return;
  if (!state.ready || !state.userId) {
    setStatus("クラウド読込が完了していないため保存できません。ページを再読み込みしてください。", "error");
    return;
  }

  setBusy(true);
  setStatus("クラウドへ保存中…");
  try {
    const session = await activeSession();
    const currentUser = await fetchCurrentUser(session);
    if (String(currentUser.id) !== state.userId || activeUserId() !== state.userId) {
      throw new Error("Googleアカウントが変更されています。ページを再読み込みしてください。");
    }

    const { records, bets } = await readShadowData();
    const latest = await fetchCloudRow(session, state.userId);
    const latestRecords = normalizeRecords(latest?.records);
    const latestBets = normalizeBets(latest?.bet_records);
    const latestSignature = signature(latestRecords, latestBets);

    // 読込後に無料版・別端末で更新されていたら、古い画面からの上書きを禁止。
    if ((latest?.updated_at || null) !== (state.updatedAt || null) && latestSignature !== state.cloudSignature) {
      throw new Error("無料版または別端末で新しい保存があります。ページを再読み込みしてから保存してください。");
    }

    const destructive = (latestRecords.length > 0 && records.length === 0)
      || (latestBets.length > 0 && bets.length === 0);
    if (destructive) {
      const ok = window.confirm(
        "クラウドに保存済みの履歴を0件で上書きしようとしています。\n\n履歴をすべて削除してクラウドへ保存する場合だけ『OK』を押してください。",
      );
      if (!ok) {
        setStatus("空データでの上書きを中止しました。", "dirty");
        return;
      }
    }

    const result = await patchOrInsertCloud(session, state.userId, latest, records, bets);
    const written = await writeShadowData(records, bets);
    state.hadCloudRow = true;
    state.cloudRecords = written.records;
    state.cloudBets = written.bets;
    state.cloudSignature = signature(written.records, written.bets);
    state.updatedAt = result.row?.updated_at || result.updatedAt;
    const stamp = new Date(state.updatedAt).toLocaleString("ja-JP");
    setStatus(`✓ クラウドへ保存しました（${stamp}）`, "success");
  } catch (error) {
    console.error(`[${VERSION}] save failed`, error);
    setStatus(error?.message || "クラウド保存に失敗しました。", "error");
  } finally {
    setBusy(false);
  }
}

function purchaseVerifiedElement() {
  return Array.from(document.querySelectorAll("span"))
    .find((element) => String(element.textContent || "").includes("購入者確認済み")) || null;
}

function makeCard() {
  const card = document.createElement("div");
  card.id = "hunaken-cloud-save-card-v3";
  card.style.cssText = [
    "background:#13243a",
    "border:1px solid #284766",
    "border-radius:12px",
    "padding:12px 14px",
    "margin:0 0 14px",
    "color:#e8eef5",
    "font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif",
    "box-sizing:border-box",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Googleログイン・クラウド保存";
  title.style.cssText = "font-size:13px;font-weight:900;margin-bottom:7px;color:#e8eef5";

  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";

  saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "今すぐ保存";
  saveButton.style.cssText = [
    "border:1px solid #3b75a8",
    "background:#1c4468",
    "color:#f3f8ff",
    "border-radius:9px",
    "padding:9px 13px",
    "font-size:12px",
    "font-weight:900",
  ].join(";");
  saveButton.addEventListener("click", saveCloudNow);

  statusEl = document.createElement("div");
  statusEl.style.cssText = "font-size:11px;line-height:1.6;flex:1;min-width:180px;color:#9db5cc";

  const note = document.createElement("div");
  note.textContent = "ログイン中はクラウドの履歴を正として読み込みます。端末データとの自動マージは行いません。";
  note.style.cssText = "font-size:10px;line-height:1.6;margin-top:7px;color:#7895b1";

  controls.appendChild(saveButton);
  controls.appendChild(statusEl);
  card.appendChild(title);
  card.appendChild(controls);
  card.appendChild(note);
  return card;
}

function updateInitialStatus() {
  if (state.ready) {
    const stamp = state.updatedAt ? new Date(state.updatedAt).toLocaleString("ja-JP") : "未保存";
    const counts = `予想${state.cloudRecords.length}件・収支${state.cloudBets.length}件`;
    setStatus(`✓ クラウドから読込済み（${counts}／最終保存 ${stamp}）`, "success");
  } else {
    setStatus(state.error || "クラウド読込が完了していません。", "error");
  }
  setBusy(false);
}

function mountCard() {
  if (document.getElementById("hunaken-cloud-save-card-v3")) return true;
  const verified = purchaseVerifiedElement();
  if (!verified) return false;
  const purchaseBox = verified.parentElement?.parentElement;
  if (!purchaseBox?.parentElement) return false;
  purchaseBox.insertAdjacentElement("afterend", makeCard());
  updateInitialStatus();
  return true;
}

function watchDirtyState() {
  if (dirtyTimer) window.clearInterval(dirtyTimer);
  dirtyTimer = window.setInterval(async () => {
    if (state.busy || !statusEl || !state.ready || state.cloudSignature === null) return;
    const { records, bets } = await readShadowData();
    if (signature(records, bets) !== state.cloudSignature) {
      setStatus("未保存の変更があります。「今すぐ保存」を押してください。", "dirty");
    }
  }, 2000);
}

function installLogoutClear() {
  if (logoutListenerInstalled) return;
  logoutListenerInstalled = true;
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button");
    if (!button || !String(button.textContent || "").includes("ログアウト")) return;
    state.ready = false;
    state.phase = "logged-out";
    state.user = null;
    state.userId = "";
    state.cloudSignature = null;
    clearActiveUser();
    void clearShadowData();
  }, true);
}

export function startCloudSaveUi() {
  installLogoutClear();
  if (!mountCard()) {
    const observer = new MutationObserver(() => {
      if (mountCard()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 30_000);
  }
  watchDirtyState();
}

export const __test = {
  normalizeRecords,
  normalizeBets,
  signature,
  readShadowData,
  writeShadowData,
  clearShadowData,
};
