(() => {
  "use strict";

  const VERSION = "v121-cloud-save-v1";
  const TABLE = "hunaken_user_data";
  const AUTH_SESSION_KEY = "hunaken_paid_auth_session_v1";
  const RECORDS_KEY = "hunaken_records";
  const BETS_KEY = "hunaken_betRecords";
  const RESTORE_RELOAD_KEY = "hunaken_cloud_restore_reloaded_v1";

  const runtimeEnv = window.__HUNAKEN_ENV__ || {};
  const supabaseUrl = String(runtimeEnv.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = String(runtimeEnv.VITE_SUPABASE_ANON_KEY || "");

  let busy = false;
  let currentUser = null;
  let lastCloudSignature = null;
  let lastCloudUpdatedAt = null;
  let statusEl = null;
  let saveButton = null;

  function safeJsonParse(raw, fallback) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function readSession() {
    try {
      return safeJsonParse(localStorage.getItem(AUTH_SESSION_KEY), null);
    } catch (_error) {
      return null;
    }
  }

  function writeSession(session) {
    try {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    } catch (_error) {
      // 端末側ストレージが利用できない場合は、現在のリクエストだけ継続する。
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
    if (!session?.access_token) throw new Error("Googleログイン情報を確認できません。再ログインしてください。");

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

  function readArray(key) {
    try {
      const value = safeJsonParse(localStorage.getItem(key), []);
      return Array.isArray(value) ? value : [];
    } catch (_error) {
      return [];
    }
  }

  function writeArray(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(Array.isArray(value) ? value : []));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function itemKey(item, type, index) {
    if (item && typeof item === "object") {
      if (item.key !== undefined && item.key !== null && String(item.key) !== "") return `key:${item.key}`;
      if (item.id !== undefined && item.id !== null && String(item.id) !== "") return `id:${item.id}`;
      const fallback = [item.date, item.venue, item.race, item.label, item.result, item.amount]
        .map((value) => String(value ?? ""))
        .join("|");
      if (fallback.replace(/\|/g, "")) return `fallback:${fallback}`;
    }
    return `${type}:index:${index}:${JSON.stringify(item)}`;
  }

  // 端末側を優先し、クラウドにしかない記録を末尾へ補う。
  // 同じIDの記録を二重化せず、別端末の記録だけを安全に追加する。
  function mergeArrays(localItems, cloudItems, type) {
    const local = Array.isArray(localItems) ? localItems : [];
    const cloud = Array.isArray(cloudItems) ? cloudItems : [];
    const result = [...local];
    const keys = new Set(local.map((item, index) => itemKey(item, type, index)));
    cloud.forEach((item, index) => {
      const key = itemKey(item, type, index);
      if (!keys.has(key)) {
        keys.add(key);
        result.push(item);
      }
    });
    return result;
  }

  function signature(records = readArray(RECORDS_KEY), betRecords = readArray(BETS_KEY)) {
    return JSON.stringify({ records, betRecords });
  }

  function setStatus(message, kind = "normal") {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = kind === "error" ? "#ff9b91" : kind === "success" ? "#79e4aa" : kind === "dirty" ? "#ffd166" : "#9db5cc";
  }

  function setBusy(next) {
    busy = next;
    if (saveButton) {
      saveButton.disabled = next;
      saveButton.style.opacity = next ? "0.65" : "1";
      saveButton.style.cursor = next ? "wait" : "pointer";
      saveButton.textContent = next ? "保存中…" : "今すぐ保存";
    }
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

  async function restoreCloud() {
    if (!supabaseUrl || !anonKey || busy) return;
    setBusy(true);
    setStatus("クラウド保存を確認中…");
    try {
      const session = await activeSession();
      currentUser = await fetchCurrentUser(session);
      const row = await fetchCloudRow(session, currentUser.id);
      if (!row) {
        lastCloudSignature = null;
        lastCloudUpdatedAt = null;
        setStatus("クラウド未保存です。現在の収支を「今すぐ保存」で保存できます。", "dirty");
        return;
      }

      const localRecords = readArray(RECORDS_KEY);
      const localBets = readArray(BETS_KEY);
      const mergedRecords = mergeArrays(localRecords, row.records, "records");
      const mergedBets = mergeArrays(localBets, row.bet_records, "bets");
      const before = signature(localRecords, localBets);
      const after = signature(mergedRecords, mergedBets);

      if (before !== after) {
        const recordOk = writeArray(RECORDS_KEY, mergedRecords);
        const betsOk = writeArray(BETS_KEY, mergedBets);
        if (!recordOk || !betsOk) {
          throw new Error("端末内への復元に失敗しました。通常ブラウザで開き直してください。");
        }

        let alreadyReloaded = false;
        try { alreadyReloaded = sessionStorage.getItem(RESTORE_RELOAD_KEY) === after; } catch (_error) { /* noop */ }
        if (!alreadyReloaded) {
          try { sessionStorage.setItem(RESTORE_RELOAD_KEY, after); } catch (_error) { /* noop */ }
          setStatus("✓ クラウドから復元しました。画面を更新します。", "success");
          window.setTimeout(() => window.location.reload(), 500);
          return;
        }
      }

      try { sessionStorage.removeItem(RESTORE_RELOAD_KEY); } catch (_error) { /* noop */ }
      const cloudSignature = signature(
        Array.isArray(row.records) ? row.records : [],
        Array.isArray(row.bet_records) ? row.bet_records : [],
      );
      lastCloudSignature = cloudSignature;
      lastCloudUpdatedAt = row.updated_at || null;
      const stamp = row.updated_at ? new Date(row.updated_at).toLocaleString("ja-JP") : "時刻不明";
      if (after !== cloudSignature) {
        setStatus(`クラウドから復元済み／未保存の端末記録があります（最終保存 ${stamp}）`, "dirty");
      } else {
        setStatus(`✓ クラウド保存から復元済み（最終保存 ${stamp}）`, "success");
      }
    } catch (error) {
      console.error(`[${VERSION}] restore failed`, error);
      setStatus(error?.message || "クラウド保存の確認に失敗しました。", "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveCloudNow() {
    if (!supabaseUrl || !anonKey || busy) return;
    setBusy(true);
    setStatus("クラウドへ保存中…");
    try {
      const session = await activeSession();
      currentUser = currentUser || await fetchCurrentUser(session);
      const records = readArray(RECORDS_KEY);
      const betRecords = readArray(BETS_KEY);
      const existing = await fetchCloudRow(session, currentUser.id);
      const payload = {
        records,
        bet_records: betRecords,
        updated_at: new Date().toISOString(),
      };

      let response;
      if (existing) {
        const params = new URLSearchParams();
        params.set("user_id", `eq.${currentUser.id}`);
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
          body: JSON.stringify({ user_id: currentUser.id, ...payload }),
        });
      }

      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        const details = safeJsonParse(raw, {});
        throw new Error(details?.message || `クラウド保存に失敗しました（${response.status}）`);
      }

      lastCloudSignature = signature(records, betRecords);
      lastCloudUpdatedAt = payload.updated_at;
      const stamp = new Date(payload.updated_at).toLocaleString("ja-JP");
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
    card.id = "hunaken-cloud-save-card";
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
      "cursor:pointer",
    ].join(";");
    saveButton.addEventListener("click", saveCloudNow);

    statusEl = document.createElement("div");
    statusEl.style.cssText = "font-size:11px;line-height:1.6;flex:1;min-width:180px;color:#9db5cc";
    statusEl.textContent = "クラウド保存を確認中…";

    const note = document.createElement("div");
    note.textContent = "予想履歴・舟券収支を、このGoogleアカウントに保存します。";
    note.style.cssText = "font-size:10px;line-height:1.6;margin-top:7px;color:#7895b1";

    controls.appendChild(saveButton);
    controls.appendChild(statusEl);
    card.appendChild(title);
    card.appendChild(controls);
    card.appendChild(note);
    return card;
  }

  function mountCard() {
    if (document.getElementById("hunaken-cloud-save-card")) return true;
    const verified = purchaseVerifiedElement();
    if (!verified) return false;
    const purchaseBox = verified.parentElement?.parentElement;
    if (!purchaseBox?.parentElement) return false;
    purchaseBox.insertAdjacentElement("afterend", makeCard());
    restoreCloud();
    return true;
  }

  function watchDirtyState() {
    window.setInterval(() => {
      if (busy || !statusEl || lastCloudSignature === null) return;
      const current = signature();
      if (current !== lastCloudSignature) {
        setStatus("未保存の変更があります。「今すぐ保存」を押してください。", "dirty");
      }
    }, 2000);
  }

  function start() {
    if (!supabaseUrl || !anonKey) return;
    if (!mountCard()) {
      const observer = new MutationObserver(() => {
        if (mountCard()) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(() => observer.disconnect(), 30_000);
    }
    watchDirtyState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
