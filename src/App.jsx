import { useState, useMemo, useEffect, useRef } from "react";

const PLACE_NO_BY_VENUE = {
  "桐生": 1, "戸田": 2, "江戸川": 3, "平和島": 4, "多摩川": 5, "浜名湖": 6,
  "蒲郡": 7, "常滑": 8, "津": 9, "三国": 10, "びわこ": 11, "住之江": 12,
  "尼崎": 13, "鳴門": 14, "丸亀": 15, "児島": 16, "宮島": 17, "徳山": 18,
  "下関": 19, "若松": 20, "芦屋": 21, "福岡": 22, "唐津": 23, "大村": 24,
};

const SUPABASE_URL = String(import.meta.env?.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = String(import.meta.env?.VITE_SUPABASE_ANON_KEY || "");
const CORRECTION_TABLE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);


const AUTH_SESSION_KEY = "hunaken_paid_auth_session_v1";
const PAID_TABLE = "paid_users";
const AUTH_REDIRECT_TO = (() => {
  try { return `${window.location.origin}${window.location.pathname}`; } catch (e) { return ""; }
})();

function authHeaders(accessToken = "", json = false) {
  const h = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function saveAuthSession(session) {
  try { localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session || null)); } catch (e) { /* noop */ }
}

function loadAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearAuthSession() {
  try { localStorage.removeItem(AUTH_SESSION_KEY); } catch (e) { /* noop */ }
}

function sessionFromHash() {
  try {
    const hash = String(window.location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    const sp = new URLSearchParams(hash);
    const access_token = sp.get("access_token");
    const refresh_token = sp.get("refresh_token");
    if (!access_token) return null;
    const expires_in = Number(sp.get("expires_in") || 3600);
    return {
      access_token,
      refresh_token,
      token_type: sp.get("token_type") || "bearer",
      expires_at: Date.now() + Math.max(60, expires_in - 60) * 1000,
    };
  } catch (e) { return null; }
}

async function refreshAuthSession(session) {
  if (!session?.refresh_token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return session;
  if (session.expires_at && Date.now() < Number(session.expires_at)) return session;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: authHeaders("", true),
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) throw new Error("ログイン期限が切れました。もう一度ログインしてください。");
  const data = await res.json();
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || session.refresh_token,
    token_type: data.token_type || "bearer",
    expires_at: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
  };
  saveAuthSession(next);
  return next;
}

async function fetchAuthUser(session) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(session.access_token, false) });
  if (!res.ok) throw new Error("ログイン情報を確認できませんでした。");
  return await res.json();
}

async function fetchPaidEntitlement(session, email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return { ok: false, reason: "メールアドレスを確認できませんでした。" };
  const qs = new URLSearchParams();
  qs.set("select", "email,plan,purchased_at,expires_at,note");
  qs.set("email", `eq.${normalized}`);
  qs.set("limit", "1");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${PAID_TABLE}?${qs.toString()}`, {
    headers: authHeaders(session.access_token, false),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`購入者判定に失敗しました。paid_usersのSQL/RLSを確認してください。${txt ? ` (${txt.slice(0, 120)})` : ""}`);
  }
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { ok: false, reason: "このGoogleメールは購入者リストに未登録です。", row: null };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "利用期限が切れています。", row };
  }
  return { ok: true, reason: "購入者確認済み", row };
}


async function createStripeCheckoutSession(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw new Error("Googleメールを確認できませんでした。先にGoogleログインしてください。");
  const res = await fetch("/api/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: normalized }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url) {
    throw new Error(data?.error || "決済ページを作成できませんでした。Vercel環境変数とStripe設定を確認してください。");
  }
  window.location.href = data.url;
}

function startGoogleLogin() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    alert("Supabase環境変数が未設定です。VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を確認してください。");
    return;
  }
  const qs = new URLSearchParams();
  qs.set("provider", "google");
  qs.set("redirect_to", AUTH_REDIRECT_TO);
  window.location.href = `${SUPABASE_URL}/auth/v1/authorize?${qs.toString()}`;
}

function AuthGateScreen({ mode, user, entitlement, authMsg, onLogin, onLogout, onRetry, onPurchase }) {
  const email = user?.email || user?.user_metadata?.email || "";
  const card = {
    minHeight: "100vh", background: "#0e1b2c", color: "#e8eef5",
    fontFamily: "'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif",
    padding: "28px 16px", display: "flex", alignItems: "center", justifyContent: "center",
  };
  const box = { width: "100%", maxWidth: 520, background: "#13243a", border: "1px solid #284766", borderRadius: 18, padding: 22, boxShadow: "0 16px 50px rgba(0,0,0,.25)" };
  const btn = { width: "100%", border: "none", borderRadius: 12, padding: "13px 16px", fontSize: 15, fontWeight: 900, cursor: "pointer", background: "#4ea1ff", color: "#061425", marginTop: 14 };
  const buyBtn = { ...btn, background: "#ffd166", color: "#1a2433" };
  if (mode === "loading") {
    return <div style={card}><div style={box}><div style={{ fontSize: 22, fontWeight: 900 }}>舟券アカデミア</div><p style={{ color: "#9db5cc" }}>ログイン状態と購入者情報を確認中…</p></div></div>;
  }
  if (mode === "config") {
    return <div style={card}><div style={box}><div style={{ fontSize: 22, fontWeight: 900 }}>設定が必要です</div><p style={{ color: "#ffb4a8", lineHeight: 1.7 }}>Vercel環境変数の VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。</p></div></div>;
  }
  if (mode === "login") {
    return (
      <div style={card}><div style={box}>
        <div style={{ fontSize: 11, letterSpacing: ".18em", color: "#7da3c8", marginBottom: 6 }}>購入者専用</div>
        <div style={{ fontSize: 24, fontWeight: 900 }}>舟券アカデミア 有料自動取得版</div>
        <p style={{ color: "#9db5cc", lineHeight: 1.8, fontSize: 13 }}>Googleログイン後、購入済みのメールだけツールを表示します。販売期間は2026/7/13〜2026/8/13、利用期限は2026/12/31 23:59までです。</p>
        <button onClick={onLogin} style={btn}>Googleでログイン</button>
        {authMsg ? <p style={{ color: "#ffb4a8", fontSize: 12, lineHeight: 1.7 }}>{authMsg}</p> : null}
        <p style={{ color: "#5f7f9f", fontSize: 11, lineHeight: 1.7, marginTop: 16 }}>本ツールは予想補助であり、的中や利益を保証するものではありません。</p>
      </div></div>
    );
  }
  return (
    <div style={card}><div style={box}>
      <div style={{ fontSize: 11, letterSpacing: ".18em", color: "#7da3c8", marginBottom: 6 }}>購入者判定</div>
      <div style={{ fontSize: 22, fontWeight: 900 }}>購入者専用です</div>
      <p style={{ color: "#9db5cc", lineHeight: 1.8, fontSize: 13 }}>ログイン中のGoogleメール：</p>
      <div style={{ background: "#0e1b2c", border: "1px solid #284766", borderRadius: 10, padding: 12, fontWeight: 800, wordBreak: "break-all" }}>{email || "不明"}</div>
      <p style={{ color: "#ffb4a8", lineHeight: 1.8, fontSize: 13 }}>{entitlement?.reason || authMsg || "購入者リストに登録されていません。"}</p>
      <button onClick={onPurchase} style={buyBtn}>購入して利用開始</button>
      <p style={{ color: "#9db5cc", lineHeight: 1.8, fontSize: 12 }}>
        決済完了後、Stripe Webhook が <b>paid_users</b> にこのGoogleメールを自動追加します。購入は1人1回まで、利用期限は2026/12/31 23:59までです。古参クーポンはStripe決済画面で入力できます。
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button onClick={onRetry} style={{ ...btn, marginTop: 0, background: "#5dd39e" }}>再確認</button>
        <button onClick={onLogout} style={{ ...btn, marginTop: 0, background: "#263b56", color: "#d9e8f7" }}>ログアウト</button>
      </div>
    </div></div>
  );
}

function publicSupabaseHeaders(json = false) {
  const h = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}


function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeRaceGrade(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "PG1") return "PG1";
  if (["SG", "G1", "G2", "G3"].includes(s)) return s;
  if (s.includes("SG")) return "SG";
  if (s.includes("PG1")) return "PG1";
  if (s.includes("G1")) return "G1";
  if (s.includes("G2")) return "G2";
  if (s.includes("G3")) return "G3";
  if (s.includes("一般")) return "一般";
  return s;
}

function raceRowMatchesCategory(r, p) {
  const grade = normalizeRaceGrade(r?.grade);
  if (p.grade && grade !== p.grade) return false;
  if (p.gradeSet && !p.gradeSet.includes(grade)) return false;
  if (p.ladies && r?.is_ladies !== true) return false;
  if (p.raceTypeIncludes && !String(r?.race_type || "").includes(p.raceTypeIncludes)) return false;
  if (p.night && r?.is_nighter !== true && !String(r?.race_title || "").includes("ナイター")) return false;
  if (p.fhold && r?.f_hold !== true) return false;
  return true;
}

const CORE_CATEGORY_PERIOD_LABELS = ["直近6ヶ月", "直近1年", "直近3ヶ月", "直近1ヶ月", "当地", "一般戦", "SG", "G1", "G2", "G3", "女子戦"];
const ST_PERIOD_LABELS = [...CORE_CATEGORY_PERIOD_LABELS, "初日", "最終日", "ナイター", "F持"];

function round1(v) {
  return Math.round(Number(v || 0) * 10) / 10;
}

function emptyRateStats() {
  return { win1: {}, ren2: {}, ren3: {}, n: {} };
}

function rateFromRows(rows, pred) {
  const n = rows.length;
  if (!n) return null;
  return round1((rows.filter(pred).length / n) * 100);
}

function buildRacerCourseStatsFromDb(rawRows, profiles, courses, venueName) {
  const stats = emptyRateStats();
  const placeNo = PLACE_NO_BY_VENUE[venueName] || null;
  const cats = [
    { label: "直近1年", days: 365 },
    { label: "直近6ヶ月", days: 180 },
    { label: "直近3ヶ月", days: 90 },
    { label: "直近1ヶ月", days: 30 },
    { label: "当地", days: 365, local: true },
    { label: "一般戦", days: 365, grade: "一般" },
    { label: "SG", days: 365, grade: "SG" },
    { label: "G1", days: 365, gradeSet: ["PG1", "G1"] },
    { label: "G2", days: 365, grade: "G2" },
    { label: "G3", days: 365, grade: "G3" },
    { label: "女子戦", days: 365, ladies: true },
  ];

  for (const c of cats) {
    stats.win1[c.label] = Array(6).fill(null);
    stats.ren2[c.label] = Array(6).fill(null);
    stats.ren3[c.label] = Array(6).fill(null);
    stats.n[c.label] = Array(6).fill(0);
  }

  for (let b = 1; b <= 6; b++) {
    const regno = Number(profiles?.[b]?.regNo || profiles?.[b]?.regno || profiles?.[b]?.registerNo || 0);
    const course = Number(courses?.[b] || b);
    if (!regno || !course) continue;

    for (const c of cats) {
      const from = daysAgoIso(c.days);
      const filtered = rawRows.filter((r) => {
        const rd = String(r.race_date || "").slice(0, 10);
        return Number(r.regno) === regno
          && Number(r.course) === course
          && rd >= from
          && (!c.local || !placeNo || Number(r.place_no) === placeNo)
          && raceRowMatchesCategory(r, c)
          && r.rank != null;
      });
      stats.n[c.label][b - 1] = filtered.length;
      stats.win1[c.label][b - 1] = rateFromRows(filtered, (r) => Number(r.rank) === 1);
      stats.ren2[c.label][b - 1] = rateFromRows(filtered, (r) => Number(r.rank) <= 2);
      stats.ren3[c.label][b - 1] = rateFromRows(filtered, (r) => Number(r.rank) <= 3);
    }
  }
  return stats;
}


function buildDbAverageStTableFromRows(rawRows, profiles, venueName, courses) {
  const placeNo = PLACE_NO_BY_VENUE[venueName] || null;
  const periods = [
    { label: "直近6ヶ月", days: 180 },
    { label: "直近1年", days: 365 },
    { label: "直近3ヶ月", days: 90 },
    { label: "直近1ヶ月", days: 30 },
    { label: "当地", days: 365, local: true },
    // 以下は大会区分データが貯まるまで自動では空になり得る。
    { label: "一般戦", days: 365, grade: "一般" },
    { label: "SG", days: 365, grade: "SG" },
    { label: "G1", days: 365, gradeSet: ["PG1", "G1"] },
    { label: "G2", days: 365, grade: "G2" },
    { label: "G3", days: 365, grade: "G3" },
    { label: "女子戦", days: 365, ladies: true },
    { label: "初日", days: 365, raceTypeIncludes: "初日" },
    { label: "最終日", days: 365, raceTypeIncludes: "最終日" },
    { label: "ナイター", days: 365, night: true },
    { label: "F持", days: 365, fhold: true },
  ];
  const out = {};
  const meta = {};
  for (const p of periods) {
    out[p.label] = Array(6).fill(null);
    meta[p.label] = Array(6).fill(null);
  }

  const MIN_COURSE_ST_ROWS = 3;

  for (let b = 1; b <= 6; b++) {
    const regno = Number(profiles?.[b]?.regNo || profiles?.[b]?.regno || profiles?.[b]?.registerNo || 0);
    const currentCourse = Number(courses?.[b] || b);
    if (!regno) continue;

    for (const p of periods) {
      const from = daysAgoIso(p.days);
      const baseRows = (rawRows || []).filter((r) => {
        const rd = String(r.race_date || "").slice(0, 10);
        const st = Number(r.st);
        if (Number(r.regno) !== regno || !Number.isFinite(st) || st < 0 || st > 0.6 || rd < from) return false;
        if (p.local && placeNo && Number(r.place_no) !== placeNo) return false;
        if (!raceRowMatchesCategory(r, p)) return false;
        return true;
      });

      const courseRows = currentCourse
        ? baseRows.filter((r) => Number(r.course) === currentCourse)
        : [];
      const useCourse = courseRows.length >= MIN_COURSE_ST_ROWS;
      const targetRows = useCourse ? courseRows : baseRows;

      if (targetRows.length) {
        const avg = targetRows.reduce((a, r) => a + Number(r.st), 0) / targetRows.length;
        out[p.label][b - 1] = avg;
        meta[p.label][b - 1] = {
          course: currentCourse || b,
          source: useCourse ? "course" : "all",
          nCourse: courseRows.length,
          nAll: baseRows.length,
          minCourseRows: MIN_COURSE_ST_ROWS,
        };
      } else {
        meta[p.label][b - 1] = {
          course: currentCourse || b,
          source: "none",
          nCourse: courseRows.length,
          nAll: baseRows.length,
          minCourseRows: MIN_COURSE_ST_ROWS,
        };
      }
    }
  }

  // UI側で「1C平均 / 全C平均」などを表示するための補助情報。
  out._meta = meta;
  return out;
}

function buildKimariFromDbRows(rows) {
  const mk = (days, opt = {}) => {
    const from = daysAgoIso(days);
    const target = (rows || []).filter((r) => {
      if (String(r.race_date || "").slice(0, 10) < from || Number(r.rank) !== 1) return false;
      return raceRowMatchesCategory(r, opt);
    });
    if (!target.length) return null;
    const total = target.length;
    const pct = (n) => round1((n / total) * 100);
    const byK = { "逃げ": 0, "差し": 0, "まくり": 0, "まくり差し": 0, "抜き": 0, "恵まれ": 0, "その他": 0 };
    const byCourseK = { "差し": Array(5).fill(0), "まくり": Array(5).fill(0), "まくり差し": Array(5).fill(0) };
    for (const r of target) {
      const k = String(r.kimarite || "その他").trim() || "その他";
      const kk = byK[k] != null ? k : "その他";
      byK[kk]++;
      const c = Number(r.course);
      if (c >= 2 && c <= 6) {
        if (k.includes("まくり差し")) byCourseK["まくり差し"][c - 2]++;
        else if (k.includes("まくり")) byCourseK["まくり"][c - 2]++;
        else if (k.includes("差し")) byCourseK["差し"][c - 2]++;
      }
    }
    return {
      nige: pct(byK["逃げ"]),
      nigashi: null,
      sasare: pct(byK["差し"]),
      sashi: byCourseK["差し"].map(pct),
      makurare: pct(byK["まくり"]),
      makuri: byCourseK["まくり"].map(pct),
      makuraresashi: pct(byK["まくり差し"]),
      makurizashi: byCourseK["まくり差し"].map(pct),
      n: total,
      source: "DB",
    };
  };
  return {
    "直近6ヶ月": mk(180),
    "直近1年": mk(365),
    "直近3ヶ月": mk(90),
    "直近1ヶ月": mk(30),
    "一般戦": mk(365, { grade: "一般" }),
    "SG": mk(365, { grade: "SG" }),
    "G1": mk(365, { gradeSet: ["PG1", "G1"] }),
    "G2": mk(365, { grade: "G2" }),
    "G3": mk(365, { grade: "G3" }),
    "女子戦": mk(365, { ladies: true }),
  };
}

async function fetchRestPages(table, baseQs, maxRows = 50000) {
  const all = [];
  const page = 1000;
  for (let offset = 0; offset < maxRows; offset += page) {
    const qs = new URLSearchParams(baseQs.toString());
    qs.set("limit", String(page));
    qs.set("offset", String(offset));
    const url = `${SUPABASE_URL}/rest/v1/${table}?${qs.toString()}`;
    const res = await fetch(url, { headers: publicSupabaseHeaders(false) });
    if (!res.ok) throw new Error(`${table} load failed: ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

async function fetchRaceMetaRows(days = 365, placeNo = null) {
  if (!CORRECTION_TABLE_ENABLED) return [];
  const qs = new URLSearchParams();
  qs.set("select", "race_date,place_no,race_no,grade,is_ladies,race_title,race_type");
  qs.set("race_date", `gte.${daysAgoIso(days)}`);
  if (placeNo) qs.set("place_no", `eq.${Number(placeNo)}`);
  qs.set("order", "race_date.desc");
  try {
    return await fetchRestPages("races", qs, 50000);
  } catch (e) {
    console.warn("race metadata load skipped", e);
    return [];
  }
}

function attachRaceMeta(resultRows, metaRows) {
  if (!Array.isArray(resultRows) || !resultRows.length || !Array.isArray(metaRows) || !metaRows.length) return resultRows || [];
  const meta = new Map();
  for (const r of metaRows) {
    const key = `${String(r.race_date || "").slice(0,10)}|${Number(r.place_no)}|${Number(r.race_no)}`;
    meta.set(key, r);
  }
  return resultRows.map((r) => {
    const key = `${String(r.race_date || "").slice(0,10)}|${Number(r.place_no)}|${Number(r.race_no)}`;
    const m = meta.get(key);
    return m ? { ...r, grade: m.grade || "", is_ladies: m.is_ladies === true, race_title: m.race_title || "", race_type: m.race_type || "" } : r;
  });
}

async function fetchRaceResultsForRacers(regnos, days = 365) {
  if (!CORRECTION_TABLE_ENABLED) throw new Error("Supabase ENVなし");
  const nums = [...new Set((regnos || []).map((v) => Number(v)).filter(Boolean))];
  if (!nums.length) return [];
  const qs = new URLSearchParams();
  qs.set("select", "regno,course,rank,place_no,race_date,race_no,st,is_f");
  qs.set("regno", `in.(${nums.join(",")})`);
  qs.set("race_date", `gte.${daysAgoIso(days)}`);
  qs.set("order", "race_date.desc");
  const rows = await fetchRestPages("race_results", qs, 50000);
  const metas = await fetchRaceMetaRows(days, null);
  return attachRaceMeta(rows, metas);
}


async function fetchRaceResultsForVenue(placeNo, days = 365) {
  if (!CORRECTION_TABLE_ENABLED) throw new Error("Supabase ENVなし");
  if (!placeNo) return [];
  const qs = new URLSearchParams();
  qs.set("select", "race_date,place_no,race_no,boat,course,rank,kimarite,regno,st,is_f");
  qs.set("place_no", `eq.${Number(placeNo)}`);
  qs.set("race_date", `gte.${daysAgoIso(days)}`);
  qs.set("order", "race_date.desc");
  const rows = await fetchRestPages("race_results", qs, 50000);
  const metas = await fetchRaceMetaRows(days, placeNo);
  return attachRaceMeta(rows, metas);
}

function buildEscapeSimulationFromDb(rows, currentCourses = {}, currentRows = null, racerStats = null, racerCat = "直近6ヶ月", sts = {}, fHold = {}, fSts = {}, wind = "無風") {
  const byRace = new Map();
  for (const r of rows || []) {
    if (r?.race_date == null || r?.place_no == null || r?.race_no == null) continue;
    if (r.rank == null || r.course == null) continue;
    const key = `${String(r.race_date).slice(0,10)}|${r.place_no}|${r.race_no}`;
    if (!byRace.has(key)) byRace.set(key, []);
    byRace.get(key).push(r);
  }

  const second = [0, 0, 0, 0, 0];
  const third = [0, 0, 0, 0, 0];
  const deme = [0, 0, 0, 0, 0];
  const failKimarite = { "差し": 0, "まくり": 0, "まくり差し": 0, "抜き": 0, "恵まれ": 0, "その他": 0 };
  const failWinCourse = [0, 0, 0, 0, 0]; // 2〜6コース
  let total = 0;
  let c1Win = 0;
  let nige = 0;
  let fail = 0;

  for (const raceRows of byRace.values()) {
    if (raceRows.length < 5) continue;
    const c1 = raceRows.find((r) => Number(r.course) === 1);
    const winner = raceRows.find((r) => Number(r.rank) === 1);
    if (!c1 || !winner) continue;
    total++;
    const c1Won = Number(c1.rank) === 1;
    if (c1Won) c1Win++;
    const isNige = c1Won && String(winner.kimarite || c1.kimarite || "").includes("逃げ");
    if (isNige) {
      nige++;
      const r2 = raceRows.find((r) => Number(r.rank) === 2);
      const r3 = raceRows.find((r) => Number(r.rank) === 3);
      const c2 = Number(r2?.course || 0);
      const c3 = Number(r3?.course || 0);
      if (c2 >= 2 && c2 <= 6) { second[c2 - 2]++; deme[c2 - 2]++; }
      if (c3 >= 2 && c3 <= 6) third[c3 - 2]++;
    } else {
      fail++;
      const wc = Number(winner.course || 0);
      if (wc >= 2 && wc <= 6) failWinCourse[wc - 2]++;
      const k = String(winner.kimarite || "その他").trim() || "その他";
      if (Object.prototype.hasOwnProperty.call(failKimarite, k)) failKimarite[k]++;
      else failKimarite["その他"]++;
    }
  }

  const pct = (n, d) => d ? round1((n / d) * 100) : null;
  const byBoatSecond = Array(5).fill(null);
  const byBoatThird = Array(5).fill(null);
  const byBoatDeme = Array(5).fill(null);
  const byCourseSecond = second.map((v) => pct(v, nige));
  const byCourseThird = third.map((v) => pct(v, nige));
  const byCourseDeme = deme.map((v) => pct(v, nige));

  // 現在の進入変更に合わせて、2〜6艇欄へ「その艇が入っているコース」の分布を割り当てる。
  for (let boat = 2; boat <= 6; boat++) {
    const course = Number(currentCourses?.[boat] || boat);
    if (course >= 2 && course <= 6) {
      byBoatSecond[boat - 2] = byCourseSecond[course - 2];
      byBoatThird[boat - 2] = byCourseThird[course - 2];
      byBoatDeme[boat - 2] = byCourseDeme[course - 2];
    }
  }

  const c1Boat = Number(Object.entries(currentCourses || {}).find(([, c]) => Number(c) === 1)?.[0] || 1);
  const r1 = currentRows?.find?.((r) => Number(r.boat) === c1Boat) || null;
  const c2Boat = Number(Object.entries(currentCourses || {}).find(([, c]) => Number(c) === 2)?.[0] || 2);
  const c3Boat = Number(Object.entries(currentCourses || {}).find(([, c]) => Number(c) === 3)?.[0] || 3);
  const r2 = currentRows?.find?.((r) => Number(r.boat) === c2Boat) || null;
  const r3 = currentRows?.find?.((r) => Number(r.boat) === c3Boat) || null;

  const baseNige = pct(nige, total);
  const c1WinRate = pct(c1Win, total);
  const c1RacerWin = racerStats?.win1?.[racerCat]?.[c1Boat - 1] ?? null;
  const c1RacerRen3 = racerStats?.ren3?.[racerCat]?.[c1Boat - 1] ?? null;

  const effSt = (b) => {
    const raw = fHold?.[b] && fSts?.[b] !== "" ? fSts[b] : sts?.[b];
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const st1 = effSt(c1Boat);
  const stOthers = [1,2,3,4,5,6].filter((b) => b !== c1Boat).map(effSt).filter((v) => v != null);
  const avgOthers = stOthers.length ? stOthers.reduce((a,b)=>a+b,0)/stOthers.length : null;
  const stAdv = st1 != null && avgOthers != null ? round1((avgOthers - st1) * 100) / 100 : null; // +なら1Cが早い

  let score = baseNige ?? c1WinRate ?? 50;
  if (c1RacerWin != null) score = score * 0.55 + c1RacerWin * 0.45;
  if (c1RacerRen3 != null && c1RacerRen3 >= 75) score += 2;
  if (r1?.diff != null) score += Number(r1.diff) * 5;
  if (r1?.windAdj != null) score += Number(r1.windAdj) * 0.25;
  if (stAdv != null) score += stAdv * 40;

  const wall2 = r2 ? ((r2.racerR3final ?? r2.racerR2final ?? 0) + (r2.diff || 0) * 5 - ((effSt(c2Boat) ?? 0.17) - 0.15) * 80) : null;
  const attack3 = r3 ? ((r3.racerR1final ?? r3.racerR3final ?? 0) + (r3.diff || 0) * 6 - ((effSt(c3Boat) ?? 0.17) - 0.15) * 90) : null;
  if (wall2 != null && wall2 >= 55) score += 3;
  if (wall2 != null && wall2 <= 35) score -= 4;
  if (attack3 != null && attack3 >= 45) score -= 4;

  score = Math.max(1, Math.min(99, round1(score)));
  const alert = score >= 70 ? "逃げ信頼" : score >= 55 ? "逃げ優勢" : score >= 45 ? "互角" : "逃げ崩れ警戒";

  return {
    source: "DB",
    n: total,
    nigeN: nige,
    failN: fail,
    win1: c1WinRate,
    nigeRate: baseNige,
    second: byBoatSecond,
    third: byBoatThird,
    deme: byBoatDeme,
    byCourseSecond,
    byCourseThird,
    byCourseDeme,
    failKimarite,
    failWinCourse: failWinCourse.map((v) => pct(v, fail)),
    c1Boat,
    c2Boat,
    c3Boat,
    c1RacerWin,
    c1RacerRen3,
    stAdv,
    wall2: wall2 == null ? null : round1(wall2),
    attack3: attack3 == null ? null : round1(attack3),
    trustScore: score,
    alert,
  };
}

// ════════════════════════════════════════════════
// ① 場別・コース別 1着率（平均＝基準値）%
//    [1コース, 2コース, 3コース, 4コース, 5コース, 6コース]
// ════════════════════════════════════════════════
const VENUES = {
  "桐生":   [50.2, 11.8, 13.6, 13.7, 8.6, 2.4],
  "戸田":   [44.5, 16.2, 16.1, 14.1, 6.7, 2.7],
  "江戸川": [47.0, 18.4, 14.5, 11.8, 6.6, 2.6],
  "平和島": [46.8, 15.6, 14.7, 13.1, 7.4, 3.1],
  "多摩川": [53.0, 14.0, 13.3, 10.7, 7.1, 2.3],
  "浜名湖": [52.6, 13.3, 15.5, 10.6, 7.0, 1.6],
  "蒲郡":   [57.6, 12.3, 12.2, 11.3, 5.4, 1.6],
  "常滑":   [58.9, 11.5, 10.7, 11.3, 6.6, 1.8],
  "津":     [58.0, 12.2, 12.0, 9.7, 6.5, 2.0],
  "三国":   [53.0, 14.9, 14.4, 10.5, 5.9, 1.7],
  "びわこ": [52.3, 13.4, 14.6, 10.9, 7.4, 2.0],
  "住之江": [57.9, 14.0, 11.6, 9.7, 5.6, 1.7],
  "尼崎":   [57.7, 12.1, 13.3, 9.6, 5.9, 1.7],
  "鳴門":   [46.6, 15.0, 15.8, 12.7, 8.3, 2.2],
  "丸亀":   [57.2, 12.9, 12.2, 9.8, 6.1, 2.3],
  "児島":   [57.7, 12.8, 12.4, 9.5, 5.2, 2.6],
  "宮島":   [56.1, 13.3, 12.5, 10.1, 6.9, 1.7],
  "徳山":   [63.2, 12.4, 10.5, 8.6, 4.3, 1.2],
  "下関":   [62.4, 12.1, 11.0, 8.7, 4.3, 2.0],
  "若松":   [57.1, 12.2, 11.7, 10.0, 6.7, 2.8],
  "芦屋":   [57.8, 11.1, 10.5, 11.9, 6.9, 2.2],
  "福岡":   [56.9, 14.4, 14.8, 9.1, 4.2, 1.1],
  "唐津":   [56.2, 14.9, 12.6, 10.0, 5.1, 1.7],
  "大村":   [63.0, 11.9, 11.7, 7.3, 5.2, 1.3],
};

// ════════════════════════════════════════════════
// ①-S 場別・季節別 コース別1着率（%）
//   各場ごとに { 春,夏,秋,冬 } の [1C,2C,3C,4C,5C,6C] 1着率。
//   データが入っている場・季節はこちらを優先し、無ければ通年VENUESを使う。
//   季節区分: 春=3〜5月 / 夏=6〜8月 / 秋=9〜11月 / 冬=12〜2月
//   ※ ユーザー提供データを順次ここに追加していく。
// ════════════════════════════════════════════════
const VENUES_SEASONAL = {
  "桐生": {
    春: [49.9, 14.4, 11.5, 14.1, 9.0, 2.2],
    夏: [48.1, 11.4, 12.4, 16.8, 9.2, 2.8],
    秋: [48.5, 11.0, 15.1, 13.5, 9.6, 2.9],
    冬: [50.3, 10.8, 13.0, 14.5, 10.5, 1.8],
  },
  "戸田": {
    春: [39.6, 17.9, 19.4, 14.6, 7.2, 2.3],
    夏: [45.0, 16.9, 14.8, 14.4, 7.0, 2.2],
    秋: [45.8, 15.5, 15.3, 13.4, 7.2, 3.8],
    冬: [44.2, 16.6, 17.5, 13.6, 7.7, 1.4],
  },
  "江戸川": {
    春: [48.8, 14.7, 16.6, 12.6, 5.8, 2.8],
    夏: [47.6, 20.2, 12.2, 13.9, 6.3, 0.9],
    秋: [47.5, 18.1, 15.4, 11.6, 6.6, 2.6],
    冬: [47.9, 18.9, 13.7, 12.0, 7.1, 2.7],
  },
  "平和島": {
    春: [49.1, 15.0, 16.5, 11.0, 7.4, 2.3],
    夏: [47.2, 17.5, 14.8, 13.3, 5.8, 2.6],
    秋: [49.4, 15.9, 14.3, 13.5, 5.0, 3.2],
    冬: [45.1, 13.0, 15.5, 16.1, 8.9, 2.7],
  },
  "多摩川": {
    春: [54.0, 14.9, 15.1, 9.4, 5.6, 1.6],
    夏: [51.5, 15.1, 14.8, 10.4, 6.9, 1.8],
    秋: [52.4, 12.6, 13.2, 11.6, 7.4, 3.2],
    冬: [56.2, 12.4, 10.8, 12.4, 6.1, 2.9],
  },
  "浜名湖": {
    春: [55.2, 13.4, 14.2, 10.6, 5.5, 2.1],
    夏: [48.2, 12.8, 17.2, 12.5, 8.2, 1.4],
    秋: [55.5, 14.2, 15.1, 8.7, 6.0, 1.3],
    冬: [55.3, 12.8, 13.1, 9.5, 7.9, 2.2],
  },
  "蒲郡": {
    春: [56.4, 12.3, 10.4, 13.7, 5.9, 2.1],
    夏: [51.7, 13.3, 15.8, 14.6, 4.0, 1.4],
    秋: [65.7, 11.4, 8.8, 8.4, 5.6, 0.7],
    冬: [58.3, 11.1, 11.9, 10.5, 6.9, 1.9],
  },
  "常滑": {
    春: [55.7, 13.8, 10.7, 11.1, 6.6, 2.5],
    夏: [60.4, 10.2, 11.8, 10.6, 6.1, 1.7],
    秋: [57.9, 12.1, 10.7, 11.7, 6.5, 1.3],
    冬: [58.4, 12.4, 10.9, 11.9, 6.2, 1.5],
  },
  "津": {
    春: [58.1, 13.8, 12.4, 10.0, 5.7, 0.7],
    夏: [55.3, 13.0, 11.8, 11.3, 7.7, 1.7],
    秋: [58.2, 12.1, 12.0, 8.2, 6.8, 3.0],
    冬: [62.1, 11.0, 9.9, 10.0, 5.8, 2.3],
  },
  "三国": {
    春: [49.1, 17.9, 15.0, 9.9, 7.2, 2.3],
    夏: [53.5, 14.0, 13.4, 10.5, 7.0, 2.3],
    秋: [51.4, 14.7, 18.1, 9.2, 5.3, 2.0],
    冬: [54.4, 14.4, 12.3, 11.8, 6.0, 2.1],
  },
  "びわこ": {
    春: [52.5, 13.9, 16.3, 9.4, 7.0, 1.6],
    夏: [51.0, 14.8, 14.2, 11.4, 7.7, 1.4],
    秋: [54.1, 12.7, 15.2, 10.6, 6.7, 2.0],
    冬: [54.3, 12.8, 12.9, 12.1, 7.1, 1.7],
  },
  "尼崎": {
    春: [61.4, 13.5, 10.9, 8.5, 5.0, 1.4],
    夏: [56.2, 11.7, 13.2, 10.9, 5.9, 2.6],
    秋: [61.1, 12.0, 10.9, 9.9, 5.1, 1.9],
    冬: [61.8, 10.1, 10.0, 11.2, 5.8, 2.1],
  },
  "住之江": {
    春: [61.8, 11.6, 11.0, 10.4, 4.5, 1.4],
    夏: [52.7, 14.7, 13.8, 11.2, 6.6, 2.0],
    秋: [55.7, 15.0, 11.2, 10.8, 6.4, 1.5],
    冬: [62.5, 11.3, 10.4, 8.7, 5.5, 2.2],
  },
  "鳴門": {
    春: [47.2, 15.2, 17.0, 10.0, 8.2, 3.2],
    夏: [48.4, 13.7, 14.2, 13.5, 8.6, 2.5],
    秋: [48.8, 13.3, 17.8, 11.6, 8.0, 1.6],
    冬: [48.6, 14.3, 16.3, 13.4, 7.3, 1.6],
  },
  "丸亀": {
    春: [59.1, 13.5, 11.6, 8.0, 6.7, 2.0],
    夏: [58.3, 13.1, 11.7, 8.2, 7.5, 2.1],
    秋: [55.3, 12.0, 12.0, 10.9, 7.8, 2.6],
    冬: [53.6, 13.6, 13.6, 10.3, 7.3, 3.2],
  },
  "児島": {
    春: [57.8, 11.0, 13.2, 10.6, 5.9, 2.2],
    夏: [58.7, 11.9, 12.9, 9.5, 5.2, 2.4],
    秋: [52.5, 13.4, 14.1, 11.0, 5.0, 4.1],
    冬: [54.7, 14.7, 13.8, 9.2, 5.6, 2.8],
  },
  "宮島": {
    春: [58.1, 12.5, 12.6, 10.7, 5.6, 1.7],
    夏: [58.5, 13.0, 10.5, 10.8, 6.4, 1.5],
    秋: [55.6, 12.5, 14.7, 10.1, 6.7, 1.5],
    冬: [57.9, 12.4, 14.9, 9.1, 5.3, 1.8],
  },
  "徳山": {
    春: [65.0, 10.7, 11.1, 7.9, 4.5, 1.2],
    夏: [66.1, 11.9, 10.7, 7.4, 4.2, 0.5],
    秋: [61.1, 10.5, 12.1, 11.6, 3.2, 1.9],
    冬: [62.0, 12.1, 11.2, 10.3, 4.0, 1.0],
  },
  "下関": {
    春: [64.5, 10.0, 11.6, 7.9, 5.4, 1.3],
    夏: [60.0, 12.1, 12.0, 10.5, 4.0, 2.1],
    秋: [61.6, 13.4, 10.8, 9.1, 4.1, 1.5],
    冬: [60.1, 11.5, 12.7, 9.6, 5.1, 1.6],
  },
  "若松": {
    春: [59.3, 15.7, 11.3, 8.2, 4.1, 1.9],
    夏: [55.1, 11.2, 11.5, 12.0, 7.6, 2.9],
    秋: [57.9, 13.0, 11.7, 9.4, 6.2, 2.8],
    冬: [64.0, 10.6, 10.4, 10.6, 4.0, 1.2],
  },
  "芦屋": {
    春: [61.8, 9.9, 10.0, 10.1, 7.3, 2.3],
    夏: [54.4, 10.6, 14.3, 10.9, 7.1, 3.4],
    秋: [60.1, 12.1, 8.3, 10.8, 7.0, 2.3],
    冬: [63.7, 8.3, 12.9, 9.1, 6.8, 1.3],
  },
  "福岡": {
    春: [62.0, 14.0, 14.8, 6.4, 2.5, 1.0],
    夏: [55.1, 15.2, 16.1, 9.2, 4.4, 1.0],
    秋: [56.4, 15.4, 15.3, 8.7, 3.9, 1.2],
    冬: [58.1, 16.5, 12.9, 8.6, 4.1, 0.7],
  },
  "唐津": {
    春: [57.9, 15.1, 11.4, 9.3, 5.7, 1.6],
    夏: [54.0, 15.7, 12.0, 10.5, 5.8, 2.5],
    秋: [53.3, 15.3, 13.1, 11.3, 7.0, 1.4],
    冬: [57.3, 13.5, 12.3, 8.5, 7.1, 1.9],
  },
  "大村": {
    春: [59.0, 13.0, 10.7, 10.5, 6.7, 1.3],
    夏: [57.5, 14.1, 13.1, 7.6, 6.8, 1.4],
    秋: [65.7, 9.3, 12.4, 7.7, 4.1, 1.1],
    冬: [65.8, 10.4, 9.5, 8.4, 5.0, 1.7],
  },
};

// 季節の集計期間ラベル
const SEASON_PERIOD = { "春": "3〜5月", "夏": "6〜8月", "秋": "9〜11月", "冬": "12〜2月" };

// 買い目の「表示順」を整える: 1着→2着→3着の順に若い艇番（1号艇寄り）を先に並べる。
//   ※ これは表示専用。点数選択（当たりやすい目を残す）ロジックには一切影響しない。
function sortTicketsForDisplay(tickets) {
  if (!Array.isArray(tickets)) return tickets;
  const key = (t) => String(t).split("-").map((n) => parseInt(n, 10) || 99);
  return [...tickets].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const da = ka[i] ?? 99, db = kb[i] ?? 99;
      if (da !== db) return da - db;
    }
    return 0;
  });
}

// 買い目をフォーメーション表記に圧縮する（表示専用）。
//   例: ["1-2-3","1-2-5","1-2-6"] → ["1-2-356"]
//       ["1-2-5","1-2-6","1-3-5","1-3-6"] → ["1-23-56"]
//   ※ 展開すると元の点数集合に完全一致する組み合わせだけをまとめる（過不足ゼロ）。
//   ※ 内部の点数カウントやオッズ計算には使わない。あくまで画面表示用。
function compressTickets(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0) return [];
  const set = new Set(tickets);
  // 1着でグループ化
  const byFirst = {};
  tickets.forEach((t) => {
    const [a, b, c] = String(t).split("-");
    if (a == null || b == null || c == null) return;
    (byFirst[a] = byFirst[a] || []).push([b, c]);
  });
  const out = [];
  Object.keys(byFirst).sort((x, y) => +x - +y).forEach((a) => {
    const pairs = byFirst[a];
    // 2着 → {3着の集合}
    const map = {};
    pairs.forEach(([b, c]) => { (map[b] = map[b] || new Set()).add(c); });
    // 3着集合が同一の2着をまとめる
    const used = new Set();
    const seconds = Object.keys(map).sort((x, y) => +x - +y);
    seconds.forEach((b) => {
      if (used.has(b)) return;
      const thirdSet = map[b];
      const thirdKey = [...thirdSet].sort((x, y) => +x - +y).join(",");
      // 同じ3着集合を持つ2着を集める
      const group2 = [b];
      used.add(b);
      seconds.forEach((b2) => {
        if (used.has(b2)) return;
        const k2 = [...map[b2]].sort((x, y) => +x - +y).join(",");
        if (k2 === thirdKey) { group2.push(b2); used.add(b2); }
      });
      // この (1着, 2着group, 3着set) を直積展開したとき、全て元集合に含まれるか確認
      const thirds = [...thirdSet].sort((x, y) => +x - +y);
      let valid = true;
      for (const b2 of group2) for (const c of thirds) {
        if (!set.has(`${a}-${b2}-${c}`)) { valid = false; break; }
      }
      const sortNums = (arr) => arr.map(Number).sort((x, y) => x - y).join("");
      if (valid) {
        out.push(`${a}-${sortNums(group2)}-${sortNums(thirds)}`);
      } else {
        // 念のため: まとめられない場合は個別表記で出す
        group2.forEach((b2) => thirds.forEach((c) => out.push(`${a}-${b2}-${c}`)));
      }
    });
  });
  return out;
}

// 日付(YYYY-MM-DD)から季節を返す
function seasonOf(dateStr) {
  let m = 1;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) m = parseInt(dateStr.slice(5, 7), 10);
  else m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return "春";
  if (m >= 6 && m <= 8) return "夏";
  if (m >= 9 && m <= 11) return "秋";
  return "冬";
}

// 場名＋日付から、使うべきコース別1着率配列を返す（季節データ優先・無ければ通年）
function getVenueBase(venue, dateStr) {
  const season = seasonOf(dateStr);
  const sv = VENUES_SEASONAL[venue];
  if (sv && Array.isArray(sv[season])) return { base: sv[season], season, seasonal: true };
  return { base: VENUES[venue], season, seasonal: false };
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchLatestCorrectionTables() {
  if (!CORRECTION_TABLE_ENABLED) return null;
  const query = "id=eq.latest&select=id,updated_at,days,wind_k,venue_base,venue_base_season,wind&limit=1";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/correction_tables?${query}`, {
    headers: publicSupabaseHeaders(false),
  });
  if (!res.ok) throw new Error(`correction_tables load failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function buildCorrectionCache(table) {
  const venueBaseByPlace = {};
  const venueCountsByPlace = {};
  const venueBaseSeasonByPlace = {};
  const venueSeasonCountsByPlace = {};

  for (const row of Array.isArray(table?.venue_base) ? table.venue_base : []) {
    const placeNo = Number(row.place_no);
    const course = Number(row.course);
    const win1 = toFiniteNumber(row.win1);
    const n = toFiniteNumber(row.n);
    if (!placeNo || course < 1 || course > 6 || win1 == null) continue;
    if (!venueBaseByPlace[placeNo]) venueBaseByPlace[placeNo] = Array(6).fill(null);
    if (!venueCountsByPlace[placeNo]) venueCountsByPlace[placeNo] = Array(6).fill(null);
    venueBaseByPlace[placeNo][course - 1] = win1;
    venueCountsByPlace[placeNo][course - 1] = n;
  }

  // DB補正の季節別場平均。行形式は {place_no, season, course, win1, n} を想定。
  // seasonが 1〜4 / spring,summer,autumn,winter / 春夏秋冬 のどれでも拾う。
  const normalizeSeason = (v) => {
    const x = String(v ?? "").trim().toLowerCase();
    if (["春", "spring", "spr", "1", "3-5", "3〜5"].includes(x)) return "春";
    if (["夏", "summer", "sum", "2", "6-8", "6〜8"].includes(x)) return "夏";
    if (["秋", "autumn", "fall", "aut", "3", "9-11", "9〜11"].includes(x)) return "秋";
    if (["冬", "winter", "win", "4", "12-2", "12〜2"].includes(x)) return "冬";
    return null;
  };
  for (const row of Array.isArray(table?.venue_base_season) ? table.venue_base_season : []) {
    const placeNo = Number(row.place_no);
    const season = normalizeSeason(row.season ?? row.season_name ?? row.season_key ?? row.season_no);
    const course = Number(row.course);
    const win1 = toFiniteNumber(row.win1);
    const n = toFiniteNumber(row.n);
    if (!placeNo || !season || course < 1 || course > 6 || win1 == null) continue;
    if (!venueBaseSeasonByPlace[placeNo]) venueBaseSeasonByPlace[placeNo] = {};
    if (!venueSeasonCountsByPlace[placeNo]) venueSeasonCountsByPlace[placeNo] = {};
    if (!venueBaseSeasonByPlace[placeNo][season]) venueBaseSeasonByPlace[placeNo][season] = Array(6).fill(null);
    if (!venueSeasonCountsByPlace[placeNo][season]) venueSeasonCountsByPlace[placeNo][season] = Array(6).fill(null);
    venueBaseSeasonByPlace[placeNo][season][course - 1] = win1;
    venueSeasonCountsByPlace[placeNo][season][course - 1] = n;
  }

  const windAgg = {};
  for (const row of Array.isArray(table?.wind) ? table.wind : []) {
    const placeNo = Number(row.place_no);
    const bin = Number(row.wspd_bin);
    const course = Number(row.course);
    const n = Math.max(0, Number(row.n || 0));
    const diff = toFiniteNumber(row.shrunk_win1_diff);
    if (!placeNo || !Number.isFinite(bin) || course < 1 || course > 6 || diff == null || n <= 0) continue;
    const key = `${placeNo}|${bin}`;
    if (!windAgg[key]) windAgg[key] = Array.from({ length: 6 }, () => ({ sum: 0, n: 0 }));
    windAgg[key][course - 1].sum += diff * n;
    windAgg[key][course - 1].n += n;
  }

  const windByPlaceBin = {};
  for (const [key, arr] of Object.entries(windAgg)) {
    const [placeNo, bin] = key.split("|");
    if (!windByPlaceBin[placeNo]) windByPlaceBin[placeNo] = {};
    windByPlaceBin[placeNo][bin] = arr.map((x) => x.n > 0 ? +(x.sum / x.n).toFixed(1) : null);
  }

  return {
    raw: table || null,
    updatedAt: table?.updated_at || null,
    days: table?.days || null,
    windK: table?.wind_k || null,
    venueBaseByPlace,
    venueCountsByPlace,
    venueBaseSeasonByPlace,
    venueSeasonCountsByPlace,
    windByPlaceBin,
  };
}

function windBinFromLabel(label) {
  if (!label || label === "無風") return 0;
  const m = String(label).match(/(\d+)/);
  if (!m) return null;
  const speed = Number(m[1]);
  if (!Number.isFinite(speed)) return null;
  if (speed === 0) return 0;
  if (speed <= 2) return 1;
  if (speed <= 4) return 2;
  if (speed <= 6) return 3;
  if (speed <= 8) return 4;
  return 5;
}

function getVenueBaseWithCorrections(venue, dateStr, correctionCache) {
  const fallback = getVenueBase(venue, dateStr);
  const placeNo = PLACE_NO_BY_VENUE[venue];
  const curSeason = fallback.season;

  // 優先順位: DB季節別 → DB通年 → 固定季節別 → 固定通年
  const dbSeasonBase = placeNo && curSeason ? correctionCache?.venueBaseSeasonByPlace?.[placeNo]?.[curSeason] : null;
  if (Array.isArray(dbSeasonBase) && dbSeasonBase.filter((v) => v != null).length === 6) {
    return {
      ...fallback,
      base: dbSeasonBase.map((v) => +Number(v).toFixed(1)),
      seasonal: true,
      dynamic: true,
      sourceLabel: `DB季節別・${curSeason}`,
    };
  }

  const dbBase = placeNo ? correctionCache?.venueBaseByPlace?.[placeNo] : null;
  if (Array.isArray(dbBase) && dbBase.filter((v) => v != null).length === 6) {
    return { ...fallback, base: dbBase.map((v) => +Number(v).toFixed(1)), seasonal: false, dynamic: true, sourceLabel: "DB通年" };
  }
  return { ...fallback, dynamic: false, sourceLabel: fallback.seasonal ? `固定季節別・${curSeason}` : "固定通年" };
}

function getWindAdjWithCorrections(venue, windLabel, course, correctionCache) {
  const placeNo = PLACE_NO_BY_VENUE[venue];
  const bin = windBinFromLabel(windLabel);
  const arr = placeNo != null && bin != null ? correctionCache?.windByPlaceBin?.[placeNo]?.[bin] : null;
  const db = Array.isArray(arr) ? toFiniteNumber(arr[course - 1]) : null;
  if (db != null) return { value: db, dynamic: true };

  const fixed = WIND?.[windLabel]?.[course - 1] != null && WIND?.["無風"]?.[course - 1] != null
    ? +(WIND[windLabel][course - 1] - WIND["無風"][course - 1]).toFixed(1)
    : 0;
  return { value: fixed, dynamic: false };
}


// ════════════════════════════════════════════════
// ②' 風別・コース別 1着率（全国平均）%
//    [1コース, 2コース, 3コース, 4コース, 5コース, 6コース]
//    補正は「無風」との差で計算
// ════════════════════════════════════════════════
const WIND = {
  "無風":           [58.1, 14.0, 11.3, 10.0, 5.1, 1.5],
  "向かい風1m":     [57.2, 13.4, 12.2, 9.8, 5.6, 1.9],
  "向かい風2m":     [54.6, 13.8, 12.3, 10.9, 6.5, 2.0],
  "向かい風3m":     [53.1, 13.7, 13.2, 11.4, 6.5, 2.2],
  "向かい風4m":     [52.6, 13.8, 12.9, 11.8, 6.5, 2.4],
  "向かい風5m以上": [48.4, 14.0, 14.4, 13.1, 7.5, 2.7],
  "追い風1m":       [58.3, 14.7, 10.8, 9.6, 5.0, 1.7],
  "追い風2m":       [56.4, 15.8, 11.5, 9.9, 4.7, 1.7],
  "追い風3m":       [53.3, 16.1, 12.4, 11.0, 5.3, 1.8],
  "追い風4m":       [51.3, 15.8, 13.8, 11.5, 5.7, 1.9],
  "追い風5m以上":   [47.0, 17.8, 14.2, 12.6, 6.5, 2.1],
  "左横風1m":       [59.3, 13.3, 11.2, 9.8, 5.1, 1.4],
  "左横風2m":       [58.0, 13.6, 11.2, 10.6, 5.1, 1.5],
  "左横風3m以上":   [55.8, 13.8, 12.2, 11.2, 5.5, 1.6],
  "右横風1m":       [57.5, 13.4, 11.5, 10.3, 5.6, 1.7],
  "右横風2m":       [54.3, 13.9, 12.7, 10.4, 6.7, 2.0],
  "右横風3m以上":   [52.0, 15.1, 13.3, 11.6, 5.6, 2.4],
};

// ════════════════════════════════════════════════
// ② 号艇別 補正テーブル（差＝平均−合計値で参照）
//    [下限(以上), 上限(未満), 1着, 2着, 3着, 3連対]
// ════════════════════════════════════════════════
const TABLES = {
  1: [
    [-Infinity, -0.4, -24, 4, -5, -25], [-0.4, -0.2, -20, 0, 1, -19],
    [-0.2, 0, -12, 4, 1, -7], [0, 0.2, -10, 4, 1, -5],
    [0.2, 0.4, -4, 1, 0, -3], [0.4, 0.6, 2, 0, 0, 2],
    [0.6, 0.8, 6, -3, 1, 5], [0.8, Infinity, 10, -2, -2, 6],
  ],
  2: [
    [-Infinity, -0.4, -1, -9, -3, -14], [-0.4, -0.2, -6, -2, 5, -3],
    [-0.2, 0, -2, -2, -1, -5], [0, 0.2, -4, 0, 1, -3],
    [0.2, 0.4, 1, 0, 1, 3], [0.4, 0.6, 6, 4, -1, 9],
    [0.6, 0.8, 10, 5, -3, 12], [0.8, Infinity, 8, 11, 1, 20],
  ],
  3: [
    [-Infinity, -0.8, -8, -2, -4, -14], [-0.8, -0.6, -1, -9, -9, -19],
    [-0.6, -0.4, -2, -3, 0, -5], [-0.4, -0.2, -3, -1, -1, -4],
    [-0.2, 0, -2, 1, -1, -2], [0, 0.2, 0, 0, 3, 3],
    [0.2, 0.4, 5, 0, 4, 9], [0.4, 0.6, 3, 6, -1, 9],
    [0.6, 0.8, 13, 6, -4, 15], [0.8, Infinity, 7, 14, 1, 22],
  ],
  4: [
    [-Infinity, -0.8, -6, -7, -7, -20], [-0.8, -0.6, -4, -8, 3, -9],
    [-0.6, -0.4, -2, -3, -3, -9], [-0.4, -0.2, -1, -3, 0, -4],
    [-0.2, 0, -1, 1, 0, 0], [0, 0.2, 1, 3, 2, 5],
    [0.2, 0.4, 4, 5, 1, 10], [0.4, 0.6, 6, 8, 1, 15],
    [0.6, 0.8, 6, 8, 3, 18], [0.8, Infinity, 5, 0, 13, 18],
  ],
  5: [
    [-Infinity, -0.8, -1, -2, -9, -12], [-0.8, -0.6, -3, -1, -3, -7],
    [-0.6, -0.4, -2, -2, 0, -4], [-0.4, -0.2, 1, 0, -2, -1],
    [-0.2, 0, 1, 1, -1, -3], [0, 0.2, 1, 2, 1, 4],
    [0.2, 0.4, 1, 0, 10, 11], [0.4, 0.6, 1, 4, 5, 11],
    [0.6, 0.8, 9, 5, 1, 15], [0.8, Infinity, 13, 10, 3, 26],
  ],
  6: [
    [-Infinity, -0.8, -1, -3, -7, -11], [-0.8, -0.6, -1, 1, -2, -3],
    [-0.6, -0.4, 0, -2, 0, -1], [-0.4, -0.2, 0, -1, -1, -3],
    [-0.2, 0, 0, 1, -2, -1], [0, 0.2, 0, 1, 4, 5],
    [0.2, 0.4, 0, 0, 3, 3], [0.4, 0.6, 0, 1, 8, 10],
    [0.6, 0.8, 0, 14, 6, 20], [0.8, Infinity, 11, 4, 9, 25],
  ],
};

function lookup(boat, diff) {
  const rows = TABLES[boat];
  for (let i = 0; i < rows.length; i++) {
    const [lo, hi, w1, w2, w3, top3] = rows[i];
    if (diff >= lo && diff < hi) {
      // tier: 0=最も遅い段階, rows.length-1=最も速い段階。tierMax=段階数
      return { w1, w2, w3, top3, tier: i, tierMax: rows.length };
    }
  }
  return { w1: 0, w2: 0, w3: 0, top3: 0, tier: 0, tierMax: rows.length };
}

const LANE = {
  1: { bg: "#f5f5f0", fg: "#1a1a1a" },
  2: { bg: "#1a1a1a", fg: "#ffffff" },
  3: { bg: "#d93025", fg: "#ffffff" },
  4: { bg: "#1a73e8", fg: "#ffffff" },
  5: { bg: "#f9c513", fg: "#1a1a1a" },
  6: { bg: "#188038", fg: "#ffffff" },
};


const VENUE_ORDER = [
  "桐生", "戸田", "江戸川", "平和島",
  "多摩川", "浜名湖", "蒲郡", "常滑",
  "津", "三国", "びわこ", "住之江",
  "尼崎", "鳴門", "丸亀", "児島",
  "宮島", "徳山", "下関", "若松",
  "芦屋", "福岡", "唐津", "大村",
];

const AUTO_FETCH_VENUES = Object.keys(VENUES);
const NO_ORIGINAL_DISPLAY_VENUES = ["江戸川"];
const usesDisplayCorrection = (venueName) => !NO_ORIGINAL_DISPLAY_VENUES.includes(venueName);
const MORNING_VENUES = ["三国", "鳴門", "徳山", "芦屋", "唐津"];
const NIGHT_VENUES = ["桐生", "蒲郡", "住之江", "丸亀", "下関", "若松"];

function raceScheduleProfile(venueName) {
  if (MORNING_VENUES.includes(venueName)) return { start: 8 * 60 + 35, interval: 30 };
  if (NIGHT_VENUES.includes(venueName)) return { start: 15 * 60 + 15, interval: 27 };
  return { start: 10 * 60 + 40, interval: 30 };
}

function autoRaceForVenue(venueName, now = new Date()) {
  const { start, interval } = raceScheduleProfile(venueName);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const margin = 8;
  for (let i = 0; i < 12; i++) {
    const deadline = start + i * interval;
    if (minutes <= deadline - margin) return String(i + 1);
  }
  return "12";
}

// ライブ中は基本的に公式締切の次Rを使う。
// ただし、公式スケジュール取得失敗/古いキャッシュ/1R固定の事故が起きた時は、
// 場ごとの概算時刻で「今より前のR」に戻らないように補正する。
function deadlineMinutesFromText(deadline) {
  const m = String(deadline || "").match(/([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function jstMinutesNowClient(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now).reduce((acc, p) => { if (p.type !== "literal") acc[p.type] = p.value; return acc; }, {});
    const h = Number(parts.hour === "24" ? "0" : parts.hour);
    return h * 60 + Number(parts.minute || 0);
  } catch (e) {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function isDeadlineStillLive(deadline, now = new Date()) {
  const m = deadlineMinutesFromText(deadline);
  if (m == null) return null;
  // 締切直後に公式側の表示が数十秒ズレることがあるため、2分だけ猶予。
  return m >= jstMinutesNowClient(now) - 2;
}

// 公式締切が取れている時は公式の次Rを最優先。
// 以前の版は「概算時刻の方が進んでいたら概算を優先」していたため、
// 多摩川のように1R開始が遅い場で 8Rなのに11Rへ飛ぶ事故が起きていた。
function chooseLiveRaceNo(venueName, resolvedRaceNo, resolvedDeadline = "") {
  const fallback = Number(autoRaceForVenue(venueName));
  const official = Number(resolvedRaceNo || 0);
  const live = isDeadlineStillLive(resolvedDeadline);

  if (official >= 1 && official <= 12) {
    // 公式締切が未来なら絶対に公式を使う。
    if (live === true) return String(official);
    // 締切文字列が無い場合も、公式が2R以降なら公式を信用。
    if (live === null && official > 1) return String(official);
    // 1R固定かつ締切が過ぎている/不明な時だけ概算で救済。
    if (official === 1 && fallback > 1 && live !== true) return String(Math.min(fallback, 12));
    return String(official);
  }
  return String(fallback || 1);
}

function displayRaceForVenueCard(venueName, status) {
  const officialRace = status?.nextRace ? String(status.nextRace) : "";
  if (!officialRace) return "";
  return chooseLiveRaceNo(venueName, officialRace, status?.nextDeadline || "");
}

function todayDateValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const FIELDS = [
  { key: "tenji", label: "展示" },
  { key: "isshu", label: "1周" },
  { key: "mawari", label: "回り足" },
  { key: "chokusen", label: "直線" },
];

const empty = () => ({ tenji: "", isshu: "", mawari: "", chokusen: "" });

// 平均ST選択肢 0.00〜0.40
const ST_OPTIONS = Array.from({ length: 41 }, (_, i) => (i / 100).toFixed(2));

// チルト選択肢 -0.5〜+3.0（0.5刻み）
const TILT_OPTIONS = ["-0.5", "0.0", "0.5", "1.0", "1.5", "2.0", "2.5", "3.0"];

// 共通: 3連単の組み立て
function buildTicketsPure(firsts, seconds, thirds, cap) {
  const out = [];
  for (const a of firsts) for (const b of seconds) {
    if (b === a) continue;
    for (const c of thirds) {
      if (c === a || c === b) continue;
      const t = `${a}-${b}-${c}`;
      if (!out.includes(t)) out.push(t);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// 指定区分(cat)の枠別成績で 本線・対抗・穴 の買い目を生成（期間比較用の簡易版）
// rows: aiEvalのresult.rows（各艇のadj等を含む）, racerStats: 全区分の成績, order: 総合評価順
function genPeriodBets(rows, racerStats, cat, order, circleBoats, meritBoats, timeBoats) {
  if (!rows || !racerStats) return null;
  const rated = rows.map((r) => {
    const i = r.boat - 1;
    const w1 = racerStats.win1?.[cat]?.[i];
    const r2 = racerStats.ren2?.[cat]?.[i];
    const r3 = racerStats.ren3?.[cat]?.[i];
    return {
      boat: r.boat,
      r1: w1 != null ? w1 + (r.w1 || 0) : null,
      r2: r2 != null ? r2 + (r.w1 || 0) + (r.w2 || 0) : null,
      r3: r3 != null ? r3 + (r.top3 || 0) : null,
    };
  });
  const byKey = (k) => rated.filter((x) => x[k] != null).sort((a, b) => b[k] - a[k]).map((x) => x.boat);
  const rank1 = byKey("r1"), rank2 = byKey("r2"), rank3 = byKey("r3");
  const r1 = rank1.length ? rank1 : order;
  const r2 = rank2.length ? rank2 : order;
  const r3 = rank3.length ? rank3 : order;

  // 本線
  const honFirst = [...new Set([r1[0], ...(circleBoats || [])])].filter(Boolean);
  const honSecond = [...new Set([...r2.slice(0, 3), r1[0]])].filter(Boolean);
  const honThird = [...new Set([...r3.slice(0, 4), ...r2.slice(0, 2)])].filter(Boolean);
  const honmei = buildTicketsPure(honFirst, honSecond, honThird, 12);
  const honSet = new Set(honmei);

  // 対抗（1着率1・2位頭、3連対率1位を軸）
  const taikou = [];
  const pushT = (t) => { if (t && !taikou.includes(t) && !honSet.has(t)) taikou.push(t); };
  const a1 = r1[0], a2 = r1[1], axis = r3[0];
  if (a1 && a2) {
    for (const head of [a1, a2]) {
      if (axis && axis !== head) {
        for (const c of order) { if (c !== head && c !== axis) pushT(`${head}-${axis}-${c}`); if (taikou.length >= 12) break; }
        for (const b of order) { if (b !== head && b !== axis) pushT(`${head}-${b}-${axis}`); if (taikou.length >= 12) break; }
      }
      if (taikou.length >= 12) break;
    }
  }

  // 穴（頭=1着率1・2位＋タイム抜群艇、妙味艇を絡める）
  const ana = [];
  const pushA = (t) => { if (t && !ana.includes(t)) ana.push(t); };
  const heads = [];
  for (const b of r1.slice(0, 2)) if (b && !heads.includes(b)) heads.push(b);
  for (const b of (timeBoats || [])) if (b && !heads.includes(b)) heads.push(b);
  if (heads.length === 0) heads.push(order[0]);
  const merits = (meritBoats || []).slice();
  if (merits.length > 0) {
    for (const head of heads) {
      for (const m of merits) {
        if (m === head) continue;
        const others = order.filter((b) => b !== head && b !== m);
        for (const c of others) { pushA(`${head}-${m}-${c}`); if (ana.length >= 12) break; }
        for (const b of others) { pushA(`${head}-${b}-${m}`); if (ana.length >= 12) break; }
        if (ana.length >= 12) break;
      }
      if (ana.length >= 12) break;
    }
  } else {
    for (const head of r1.slice(1, 3)) {
      if (!head) continue;
      const partners = order.filter((b) => b !== head).slice(0, 4);
      for (const t of buildTicketsPure([head], partners, partners, 6)) { pushA(t); if (ana.length >= 12) break; }
      if (ana.length >= 12) break;
    }
  }

  // 総合評価マーク（簡易: 期間で変わる枠別成績の良し悪し＋順位）
  //   1着率順の上位3艇を ◎○△、それ以外を ✕ とする簡易版（期間比較の目安）
  const markByBoat = {};
  const topOrder = rank1.length ? rank1 : order;
  topOrder.forEach((b, i) => { markByBoat[b] = i === 0 ? "◎" : i === 1 ? "○" : i === 2 ? "△" : "✕"; });

  return { honmei, taikou, ana, rank: topOrder, markByBoat };
}


export default function App() {
  const [venue, setVenue] = useState("");
  const [raceNo, setRaceNo] = useState("1");        // 1〜12R
  const [raceDate, setRaceDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });


  // ── Googleログイン＋購入者判定（paid_users） ──
  const [authLoading, setAuthLoading] = useState(true);
  const [authSession, setAuthSession] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [paidEntitlement, setPaidEntitlement] = useState(null);
  const [authMsg, setAuthMsg] = useState("");

  const logoutPaidUser = () => {
    clearAuthSession();
    setAuthSession(null);
    setAuthUser(null);
    setPaidEntitlement(null);
    setAuthMsg("");
  };

  const startPurchase = async () => {
    const email = String(authUser?.email || authUser?.user_metadata?.email || "").trim().toLowerCase();
    try {
      setAuthMsg("決済ページを作成中です…");
      await createStripeCheckoutSession(email);
    } catch (e) {
      console.error(e);
      setAuthMsg(e?.message || "決済ページを開けませんでした。");
    }
  };

  const checkPaidLogin = async (baseSession = null) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setAuthMsg("Supabase環境変数が未設定です。");
      setAuthLoading(false);
      return;
    }
    setAuthLoading(true);
    let checkoutNotice = "";
    try {
      const sp = new URLSearchParams(window.location.search || "");
      if (sp.get("checkout") === "success") checkoutNotice = "決済完了を確認中です。数秒後に再確認してください。";
      if (sp.get("checkout") === "cancelled") checkoutNotice = "決済がキャンセルされました。";
      if (sp.has("checkout")) window.history.replaceState(null, document.title, window.location.pathname + window.location.hash);
    } catch (e) { /* noop */ }
    setAuthMsg(checkoutNotice);
    try {
      let session = baseSession || sessionFromHash() || loadAuthSession();
      if (sessionFromHash()) {
        window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
      }
      if (!session?.access_token) {
        setAuthSession(null);
        setAuthUser(null);
        setPaidEntitlement(null);
        return;
      }
      session = await refreshAuthSession(session);
      saveAuthSession(session);
      setAuthSession(session);
      const user = await fetchAuthUser(session);
      setAuthUser(user);
      const email = String(user?.email || user?.user_metadata?.email || "").trim().toLowerCase();
      const ent = await fetchPaidEntitlement(session, email);
      setPaidEntitlement(ent);
    } catch (e) {
      console.error(e);
      clearAuthSession();
      setAuthSession(null);
      setAuthUser(null);
      setPaidEntitlement(null);
      setAuthMsg(e?.message || "ログイン確認に失敗しました。");
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    checkPaidLogin();
  }, []);
  const [wind, setWind] = useState("無風");
  const [correctionTable, setCorrectionTable] = useState(null);
  const [correctionStatus, setCorrectionStatus] = useState("固定補正");
  const [courses, setCourses] = useState({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 });
  const [sts, setSts] = useState({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });
  const [fHold, setFHold] = useState({ 1: false, 2: false, 3: false, 4: false, 5: false, 6: false });
  const [fSts, setFSts] = useState({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" }); // "" = 不明
  const [tilts, setTilts] = useState({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });
  const [weights, setWeights] = useState({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });

  const setWeight = (b, v) => setWeights((p) => ({ ...p, [b]: v }));

  const setTilt = (b, v) => setTilts((p) => ({ ...p, [b]: v }));

  const setSt = (b, v) => setSts((p) => ({ ...p, [b]: v }));
  const toggleF = (b) => setFHold((p) => ({ ...p, [b]: !p[b] }));
  const setFSt = (b, v) => setFSts((p) => ({ ...p, [b]: v }));

  // ── テキスト貼り付けからの自動入力（枠別情報一括のみ表示） ──
  const [openPanel, setOpenPanel] = useState(null); // "basic"
  const [pTexts, setPTexts] = useState({ basic: "", tenji: "", st: "", motor: "", racer: "", kimari: "", odds: "" });
  const [pMsgs, setPMsgs] = useState({ basic: "", tenji: "", st: "", motor: "", racer: "", kimari: "", odds: "" });
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoMsg, setAutoMsg] = useState("");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [autoRefreshInfo, setAutoRefreshInfo] = useState("");
  const [salesEnded, setSalesEnded] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [venueNotHeld, setVenueNotHeld] = useState(false);
  const [officialSchedule, setOfficialSchedule] = useState(null);
  const [venueStatuses, setVenueStatuses] = useState({});
  const [venueStatusLoading, setVenueStatusLoading] = useState(false);
  const [prefetchInfo, setPrefetchInfo] = useState("");
  const autoBusyRef = useRef(false);
  const lastAutoFetchKeyRef = useRef("");
  const lastAutoFetchAtRef = useRef(0);
  const manualRaceSelectUntilRef = useRef(0);
  const prefetchBusyKeysRef = useRef(new Set());
  const lastPrefetchAtByKeyRef = useRef({});
  const autoRefreshEnabledRef = useRef(autoRefreshEnabled);
  useEffect(() => { autoRefreshEnabledRef.current = autoRefreshEnabled; }, [autoRefreshEnabled]);

  // 展示・1周・回り足は、一度6艇分そろったら固定扱い。
  // 3分ごとの自動更新では、固定データを再取得せず変動するオッズだけ更新する。
  const hasCompleteAutoStaticData = (venueName = venue) => {
    try {
      if (!usesDisplayCorrection(venueName)) return true;
      return [1, 2, 3, 4, 5, 6].every((b) => {
        const r = inputs?.[b] || {};
        return ["tenji", "isshu", "mawari"].every((k) => String(r[k] ?? "").trim() !== "");
      });
    } catch (e) {
      return false;
    }
  };

  const setPText = (k, v) => setPTexts((p) => ({ ...p, [k]: v }));
  const setPMsg = (k, v) => setPMsgs((p) => ({ ...p, [k]: v }));

  // モーター情報 {no, rate, win1, ren2, ren3}
  const [motors, setMotors] = useState({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null });
  const [racerProfiles, setRacerProfiles] = useState({});
  const [dbRacerRows, setDbRacerRows] = useState([]);
  const [dbRacerStatus, setDbRacerStatus] = useState("DB選手成績：未取得");

  // オッズ一覧 odds[firstBoat] = { "2-3": 22.2, ... }（3連単 1着→"2着-3着":オッズ）
  const [odds, setOdds] = useState(null);

  // ── 結果出目・保存レコード ──
  const [resultDigits, setResultDigits] = useState({ first: "", second: "", third: "" });
  const [records, setRecords] = useState([]);       // 保存した予想＋結果
  const [saveMsg, setSaveMsg] = useState("");
  // 集計の絞り込み（的中率・AI収支・自分の収支に共通で適用）
  const [statPeriod, setStatPeriod] = useState("all");   // "all" | "month" | "last30"
  const [statVenue, setStatVenue] = useState("all");     // "all" | 場名
  // 各買い目で実際に買う点数（このレース用）。未設定キーは「全点」扱い
  const [betLimits, setBetLimits] = useState({}); // {本線:6, 対抗:4, 穴:8, 超穴:3}
  const setBetLimit = (label, n) => setBetLimits((p) => ({ ...p, [label]: n }));
  // 「買い目組む」: 対象の組み合わせ(最大4)と点数を選んでAIに厳選させる
  const [pickerParts, setPickerParts] = useState(["本線"]);
  const [pickerCount, setPickerCount] = useState(6);
  const [pickerMode, setPickerMode] = useState("balance"); // "hit"=当たりやすさ / "ev"=期待値 / "balance"=バランス
  const [pickerAlloc, setPickerAlloc] = useState("even"); // 配分: "even"=均等ミックス / "solid"=堅い順優先 / "ana"=穴寄り

  // ── 舟券の収支記録 ──
  // 記録関連（予想の保存・結果入力・的中率・AI収支・舟券収支・バックアップ）の表示フラグ。
  // Webアプリ版（Vercel）では localStorage に永続保存されるため有効。
  const SHOW_RECORDS = true;
  const [betRecords, setBetRecords] = useState([]); // 確定した購入履歴
  const [betMsg, setBetMsg] = useState("");
  const [cart, setCart] = useState([]);  // 記録前の買い目リスト [{id,label,tickets,amountPerPoint}]
  const [payoutOddsInput, setPayoutOddsInput] = useState(""); // 配当(100円あたり)
  const [easyMode, setEasyMode] = useState(true); // 表示モード: true=かんたん / false=詳細
  const [betDraft, setBetDraft] = useState({
    source: "自由",   // "本線"|"対抗"|"穴"|"自由"
    f1: [], f2: [], f3: [],  // フォーメーション選択
  });
  const setBD = (k, v) => setBetDraft((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    (async () => {
      let loaded = null;
      try {
        const r = await window.storage.get("betRecords");
        if (r && r.value) loaded = JSON.parse(r.value);
      } catch (e) { /* noop */ }
      if (!loaded) {
        try {
          const ls = localStorage.getItem("hunaken_betRecords");
          if (ls) loaded = JSON.parse(ls);
        } catch (e) { /* noop */ }
      }
      if (loaded) setBetRecords(loaded);
    })();
  }, []);

  const persistBets = async (updater) => {
    let computed;
    setBetRecords((prev) => {
      computed = typeof updater === "function" ? updater(prev) : updater;
      return computed;
    });
    const json = JSON.stringify(computed);
    try { await window.storage.set("betRecords", json); } catch (e) { /* noop */ }
    try { localStorage.setItem("hunaken_betRecords", json); } catch (e) { /* noop */ }
  };
  const setResultDigit = (k, v) => setResultDigits((p) => ({ ...p, [k]: v }));

  // 起動時に保存レコードを読み込み
  useEffect(() => {
    (async () => {
      let loaded = null;
      try {
        const r = await window.storage.get("records");
        if (r && r.value) loaded = JSON.parse(r.value);
      } catch (e) { /* noop */ }
      if (!loaded) {
        try {
          const ls = localStorage.getItem("hunaken_records");
          if (ls) loaded = JSON.parse(ls);
        } catch (e) { /* noop */ }
      }
      if (loaded) setRecords(loaded);
    })();
  }, []);

  const persistRecords = async (updater) => {
    // updater は配列、または (prev)=>next の関数
    let computed;
    setRecords((prev) => {
      computed = typeof updater === "function" ? updater(prev) : updater;
      return computed;
    });
    const json = JSON.stringify(computed);
    try { await window.storage.set("records", json); } catch (e) { /* noop */ }
    try { localStorage.setItem("hunaken_records", json); } catch (e) { /* noop */ }
  };

  // ── データのバックアップ（エクスポート/インポート） ──
  const [ioMsg, setIoMsg] = useState("");
  const [exportText, setExportText] = useState(""); // フォールバック用（コピー保存）
  const [importText, setImportText] = useState(""); // テキスト復元用
  const exportData = async () => {
    let json = "";
    try {
      const payload = {
        app: "hunaken-academia",
        version: 1,
        exportedAt: new Date().toISOString(),
        records,      // 予想・結果・的中
        betRecords,   // 舟券収支
      };
      json = JSON.stringify(payload, null, 2);
    } catch (e) {
      setIoMsg("✗ 書き出しデータの作成に失敗しました");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `hunaken-backup-${stamp}.json`;

    // ① Web Share API（iOS Safari対応。共有シートから「ファイルに保存」を選べる）
    try {
      if (navigator.canShare && typeof File !== "undefined") {
        const file = new File([json], filename, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "舟券アカデミア バックアップ" });
          setIoMsg(`✓ 共有しました（「ファイルに保存」でiPhoneのファイルアプリに保存できます）`);
          return;
        }
      }
    } catch (e) {
      // ユーザーがキャンセルした場合などはここに来る。下のフォールバックは出さず終了。
      if (e && e.name === "AbortError") { setIoMsg("共有をキャンセルしました"); return; }
      // それ以外は次の手段へ
    }

    // ② ダウンロード方式（PC・Android向け）
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setIoMsg(`✓ バックアップを書き出しました（予想${records.length}件・収支${betRecords.length}件）`);
      return;
    } catch (e) {
      // ③ 最終手段: テキスト表示でコピー保存してもらう
      setExportText(json);
      setIoMsg("お使いの環境では自動保存できませんでした。下のテキストを全選択してコピーし、メモ等に貼り付けて保存してください。");
    }
  };
  const importData = (file, mode) => {
    // mode: "replace"=置き換え / "merge"=追記（IDが無いので件数で単純結合）
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => { await applyImport(reader.result, mode); };
    reader.readAsText(file);
  };
  // テキスト（コピペ）からの復元
  const importFromText = async (text, mode) => {
    if (!text || !text.trim()) { setIoMsg("✗ テキストが空です"); return; }
    await applyImport(text, mode);
  };
  // ファイル/テキスト共通の取り込み処理
  const applyImport = async (raw, mode) => {
    try {
      const data = JSON.parse(raw);
      const inRec = Array.isArray(data.records) ? data.records : null;
      const inBet = Array.isArray(data.betRecords) ? data.betRecords : null;
      if (!inRec && !inBet) { setIoMsg("✗ このデータには記録が見つかりません"); return; }
      if (mode === "replace") {
        if (inRec) await persistRecords(inRec);
        if (inBet) await persistBets(inBet);
        setIoMsg(`✓ 読み込みました（置き換え：予想${inRec ? inRec.length : 0}件・収支${inBet ? inBet.length : 0}件）`);
      } else {
        let addedR = 0, addedB = 0;
        if (inRec) {
          await persistRecords((prev) => {
            const seen = new Set(prev.map((x) => JSON.stringify(x)));
            const adds = inRec.filter((x) => !seen.has(JSON.stringify(x)));
            addedR = adds.length;
            return [...prev, ...adds];
          });
        }
        if (inBet) {
          await persistBets((prev) => {
            const seen = new Set(prev.map((x) => JSON.stringify(x)));
            const adds = inBet.filter((x) => !seen.has(JSON.stringify(x)));
            addedB = adds.length;
            return [...prev, ...adds];
          });
        }
        setIoMsg(`✓ 追記しました（予想+${addedR}件・収支+${addedB}件）`);
      }
    } catch (e) {
      setIoMsg("✗ 読み込みに失敗しました（形式を確認してください）");
    }
  };

  // すべてのコピペ欄・入力をクリア（保存レコードは消さない）
  const allClear = () => {
    setPTexts({ basic: "", tenji: "", st: "", motor: "", racer: "", kimari: "", odds: "" });
    setPMsgs({ basic: "", tenji: "", st: "", motor: "", racer: "", kimari: "", odds: "" });
    setSts({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });
    setFHold({ 1: false, 2: false, 3: false, 4: false, 5: false, 6: false });
    setFSts({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });
    setTilts({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });
    setWeights({ 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" });
    setCourses({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 });
    setMotors({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null });
    setRacerProfiles({});
    setDbRacerRows([]);
    setDbRacerStatus("DB選手成績：未取得");
    setOdds(null);
    setKimari(null); setNigeSim(null); setDbNigeRows([]); setNigeStatus("逃げシミュ：未取得"); setRacerStats(null); setStTable(null); setStMeta(null);
    setResultDigits({ first: "", second: "", third: "" });
    setAutoMsg("");
    setSaveMsg("");
  };

  // 決まり手・逃げシミュレーション（枠別情報）
  const KIMARI_PERIODS = CORE_CATEGORY_PERIOD_LABELS;
  const [kimari, setKimari] = useState(null);       // {期間:{nige,nigashi,sasare,sashi[5],makurare,makuri[5],makuraresashi,makurizashi[5]}}
  const [kimariPeriod, setKimariPeriod] = useState("直近6ヶ月");
  const [nigeSim, setNigeSim] = useState(null);     // {win1,nigeRate,second[5],third[5],deme[5]}
  const [dbNigeRows, setDbNigeRows] = useState([]);
  const [nigeStatus, setNigeStatus] = useState("逃げシミュ：未取得");

  // 選手成績 {win:{区分:[6]}, ren2:{区分:[6]}, ren3:{区分:[6]}}
  const RACER_CATS = CORE_CATEGORY_PERIOD_LABELS;
  const [racerStats, setRacerStats] = useState(null);
  const [racerCat, setRacerCat] = useState("直近6ヶ月");
  // 期間比較（買い目の被りを見る）
  const [cmpA, setCmpA] = useState("直近6ヶ月");
  const [cmpB, setCmpB] = useState("直近3ヶ月");
  const [cmpMode, setCmpMode] = useState("all"); // "all"=全部反映 / "overlap"=被りのみ反映

  // ── 平均ST表（基本情報ページ）の期間選択 ──
  const ST_PERIODS = ST_PERIOD_LABELS;
  const [stTable, setStTable] = useState(null);
  const [stMeta, setStMeta] = useState(null);
  const [stPeriod, setStPeriod] = useState("直近3ヶ月");

  const applyStTable = (table, period) => {
    const row = table[period];
    if (row) {
      const ns = {};
      for (let b = 1; b <= 6; b++) {
        const v = row[b - 1];
        ns[b] = (v != null && v >= 0 && v <= 0.6) ? Math.min(0.4, v).toFixed(2) : "";
      }
      setSts((p) => ({ ...p, ...ns }));
      setStMeta(table?._meta?.[period] || null);
    } else {
      setStMeta(null);
    }
    // F持: F持ち時の平均STとして保存（F持ちスイッチは手動）
    const f = table["F持"];
    if (f) {
      const nf = {};
      for (let b = 1; b <= 6; b++) {
        const v = f[b - 1];
        nf[b] = (v != null && v >= 0 && v <= 0.6) ? Math.min(0.4, v).toFixed(2) : "";
      }
      setFSts(nf);
    }
  };

  // ラベルの後ろから数値を6個読む共通関数を作るヘルパ
  const makeRowReader = (text) => {
    let cursor = 0;
    return (label, { allowDash = false } = {}) => {
      const i = text.indexOf(label, cursor);
      if (i === -1) return null;
      const pos = i + label.length;
      const seg = text.slice(pos);
      const re = allowDash
        ? /-?(?:\d+\.\d+|\.\d+)|[-−ー]|\d+/g
        : /-?(?:\d+\.\d+|\.\d+|\d+)/g;
      const vals = [];
      let m;
      while (vals.length < 6 && (m = re.exec(seg))) {
        if (allowDash && /^[-−ー]$/.test(m[0])) vals.push(null);
        else vals.push(Number(m[0]));
      }
      if (vals.length < 6) return null;
      cursor = pos + re.lastIndex;
      return vals;
    };
  };

  // ① 展示タイム（直前情報 or BOATCAST）
  const parseTenji = () => {
    setPMsg("tenji", "");
    try {
      const text = pTexts.tenji;
      const readRow = makeRowReader(text);

      const shinnyu = readRow("進入", { allowDash: true });
      const tenjiRow = readRow("展示", { allowDash: true });
      const isshuRow = readRow("周回", { allowDash: true }) || readRow("一周", { allowDash: true }) || readRow("半周ラップ", { allowDash: true }) || readRow("半周", { allowDash: true });
      const mawariRow = readRow("周り足", { allowDash: true }) || readRow("まわり足", { allowDash: true });
      const chokusenRow = readRow("直線", { allowDash: true });
      readRow("ST", { allowDash: true });   // 無視（平均ST欄を上書きしないため）
      const weightRow = readRow("体重", { allowDash: true });
      readRow("調整重量", { allowDash: true }); // 無視
      const tiltRow = readRow("チルト", { allowDash: true });

      if (tenjiRow && isshuRow && mawariRow) {
        const tiltSet = TILT_OPTIONS.map(Number);
        const newTilts = {};
        const newWeights = {};

        setInputs((prev) => {
          const next = { ...prev };
          for (let b = 1; b <= 6; b++) {
            const i = b - 1;
            next[b] = {
              tenji: tenjiRow[i] >= 5.5 && tenjiRow[i] <= 7.8 ? String(tenjiRow[i]) : prev[b].tenji,
              isshu: isshuRow[i] >= 15 && isshuRow[i] <= 45 ? String(isshuRow[i]) : prev[b].isshu,
              mawari: mawariRow[i] >= 4.0 && mawariRow[i] <= 15 ? String(mawariRow[i]) : prev[b].mawari,
              chokusen: chokusenRow && chokusenRow[i] >= 4.0 && chokusenRow[i] <= 15 ? String(chokusenRow[i]) : prev[b].chokusen,
            };
          }
          return next;
        });

        if (shinnyu && shinnyu.every((v) => v >= 1 && v <= 6 && Number.isInteger(v))) {
          const c = {};
          for (let b = 1; b <= 6; b++) c[b] = shinnyu[b - 1];
          setCourses(c);
        }
        if (weightRow) {
          for (let b = 1; b <= 6; b++) {
            const v = weightRow[b - 1];
            if (v >= 40 && v <= 70) newWeights[b] = String(v);
          }
          if (Object.keys(newWeights).length > 0) setWeights((p) => ({ ...p, ...newWeights }));
        }
        if (tiltRow) {
          for (let b = 1; b <= 6; b++) {
            if (tiltRow[b - 1] == null) continue;
            const snapped = (Math.round(tiltRow[b - 1] * 2) / 2).toFixed(1);
            if (tiltSet.includes(Number(snapped))) newTilts[b] = snapped;
          }
          if (Object.keys(newTilts).length > 0) setTilts((p) => ({ ...p, ...newTilts }));
        }

        setPMsg("tenji", "✓ 6艇分を読み取りました（進入・展示・1周・回り足・直線・体重・チルト）");
        return;
      }

      // フォールバック: BOATCAST形式（一周をアンカーに前後から拾う）
      const tokens = (text.match(/-?(?:\d+\.\d+|\.\d+|\d+)/g) || []).map(Number);
      const anchors = [];
      tokens.forEach((v, i) => {
        if (v >= 30 && v <= 45 && anchors.length < 6) anchors.push(i);
      });
      if (anchors.length === 0) {
        setPMsg("tenji", "タイムが見つかりません。表の部分をコピーして貼り付けてください");
        return;
      }
      const tiltSet = TILT_OPTIONS.map(Number);
      const newInputs = {};
      const newTilts = {};
      anchors.forEach((idx, k) => {
        const b = k + 1;
        const isshu = tokens[idx];
        let mawari = null;
        if (tokens[idx + 1] != null && tokens[idx + 1] >= 4.0 && tokens[idx + 1] <= 8.5) {
          mawari = tokens[idx + 1];
        }
        let chokusen = null;
        if (tokens[idx + 2] != null && tokens[idx + 2] >= 4.0 && tokens[idx + 2] <= 8.5) {
          chokusen = tokens[idx + 2];
        }
        let tenji = null;
        if (tokens[idx + 3] != null && tokens[idx + 3] >= 5.5 && tokens[idx + 3] <= 7.8) {
          tenji = tokens[idx + 3];
        }
        // 近くにある 1.0 / 1.5 は調整体重の可能性が高いため、
        // フォールバック解析ではチルトを推測しない。
        // チルトは「チルト」行またはAPIの明示列からだけ反映する。
        let tilt = null;
        newInputs[b] = {
          tenji: tenji != null ? String(tenji) : "",
          isshu: String(isshu),
          mawari: mawari != null ? String(mawari) : "",
          chokusen: chokusen != null ? String(chokusen) : "",
        };
        if (tilt != null) newTilts[b] = tilt.toFixed(1);
      });
      setInputs((prev) => {
        const next = { ...prev };
        for (const b of Object.keys(newInputs)) {
          next[b] = {
            tenji: newInputs[b].tenji || prev[b].tenji,
            isshu: newInputs[b].isshu || prev[b].isshu,
            mawari: newInputs[b].mawari || prev[b].mawari,
            chokusen: newInputs[b].chokusen || prev[b].chokusen,
          };
        }
        return next;
      });
      if (Object.keys(newTilts).length > 0) setTilts((p) => ({ ...p, ...newTilts }));
      setPMsg("tenji", `✓ ${anchors.length}艇分を読み取りました。数値を確認してください`);
    } catch (e) {
      setPMsg("tenji", "解析に失敗しました。表の部分だけを貼り付けてみてください");
    }
  };

  const applyBoatcastMeta = (data) => {
    const racers = Array.isArray(data?.racers) ? data.racers : [];
    if (!racers.length && !data?.motors) return { racerCount: 0, motorCount: 0, fCount: 0, stCount: 0 };

    const profiles = {};
    const motorMap = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
    const fMap = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
    const stMap = { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" };

    racers.forEach((r) => {
      const b = Number(r.boat);
      if (!b || b < 1 || b > 6) return;
      profiles[b] = {
        grade: r.grade || "",
        regNo: r.regNo || "",
        name: r.name || "",
        branch: r.branch || "",
        birthplace: r.birthplace || "",
        age: r.age || "",
        fl: r.fl || "",
        isFemale: !!r.isFemale,
      };
      motorMap[b] = (r.motorNo || r.motorRen2 != null || r.motorRen3 != null)
        ? {
            no: r.motorNo || null,
            ren2: r.motorRen2 != null ? Number(r.motorRen2) : null,
            ren3: r.motorRen3 != null ? Number(r.motorRen3) : null,
          }
        : null;
      fMap[b] = !!r.fHold;
      if (r.avgST !== "" && r.avgST != null) stMap[b] = String(r.avgST);
    });

    if (data?.motors && typeof data.motors === "object") {
      Object.entries(data.motors).forEach(([k, m]) => {
        const b = Number(k);
        if (!b || b < 1 || b > 6 || !m) return;
        motorMap[b] = {
          no: m.no || m.motorNo || null,
          ren2: m.ren2 != null ? Number(m.ren2) : null,
          ren3: m.ren3 != null ? Number(m.ren3) : null,
        };
      });
    }

    // レースを切り替えた時に直近レースのF持ち・モーター・選手プロフィールを引きずらないよう、
    // 自動取得データはマージではなく、そのレースの6艇分として丸ごと置き換える。
    if (racers.length) setRacerProfiles(profiles);
    setMotors(motorMap);
    setFHold(fMap);
    setSts(stMap);

    return {
      racerCount: Object.keys(profiles).length,
      motorCount: Object.values(motorMap).filter(Boolean).length,
      fCount: Object.values(fMap).filter(Boolean).length,
      stCount: Object.values(stMap).filter(Boolean).length,
    };
  };

  const formatApiFetchedAt = (iso) => {
    if (!iso) return "時刻不明";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "時刻不明";
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const apiCacheNote = (data, label = "共有キャッシュ") => {
    if (!data || !data.cached) return "";
    const age = Number.isFinite(Number(data.cacheAgeSec)) ? `${data.cacheAgeSec}秒前` : "時刻不明";
    return `／データ取得済・${age}`;
  };
  const applyBoatcastRows = (rows, { displayDisabled = false } = {}) => {
    if (!Array.isArray(rows) || !rows.length || displayDisabled) return;

    setInputs((prev) => {
      const next = { ...prev };
      for (let b = 1; b <= 6; b++) {
        next[b] = { ...next[b], tenji: "", isshu: "", mawari: "", chokusen: "" };
      }
      rows.forEach((r) => {
        const b = Number(r.boat);
        if (!b || b < 1 || b > 6) return;
        next[b] = {
          ...next[b],
          tenji: r.tenji || "",
          isshu: r.isshu || "",
          mawari: r.mawari || "",
          chokusen: r.chokusen || "",
        };
      });
      return next;
    });

    const nextWeights = { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" };
    const nextTilts = { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" };
    const nextCourses = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    rows.forEach((r) => {
      const b = Number(r.boat);
      if (!b || b < 1 || b > 6) return;
      nextWeights[b] = r.weight || "";
      const rawTilt = String(r.tilt ?? "").trim().replace(/[＋]/g, "+").replace(/[－−ー]/g, "-");
      const tiltNum = Number(rawTilt);
      // API側で調整体重との分離済み。念のため、空/不正値は反映しない。
      nextTilts[b] = rawTilt !== "" && Number.isFinite(tiltNum) && tiltNum >= -0.5 && tiltNum <= 3.0 ? tiltNum.toFixed(1) : "";
      if (r.course && Number(r.course) >= 1 && Number(r.course) <= 6) nextCourses[b] = Number(r.course);
    });
    setWeights(nextWeights);
    setTilts(nextTilts);
    setCourses(nextCourses);
  };


  // 3分更新用：展示・モーター等の固定データ取得後は、変動するオッズだけを更新する
  const fetchOfficialOddsOnly = async (override = {}) => {
    const targetVenue = override.venue || venue;
    const targetRaceNo = override.raceNo || raceNo;
    const targetDate = override.raceDate || raceDate;
    if (!targetVenue) return;
    if (salesEnded && !override.ignoreSalesEnded && override.background) {
      setAutoMsg(`${targetVenue}は本日の発売終了です。復習用データは当日中のみ手動で表示できます。`);
      return;
    }
    if (!AUTO_FETCH_VENUES.includes(targetVenue)) return;
    if (!override.force && autoBusyRef.current) return;
    autoBusyRef.current = true;
    setAutoLoading(true);
    try {
      const qs = new URLSearchParams({ action: "odds", venue: targetVenue, race: String(targetRaceNo), date: targetDate });
      const res = await fetch(`/api/yoso?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "オッズ取得に失敗しました");
      if (data.venue && String(data.venue) !== String(targetVenue)) throw new Error("別場のキャッシュ応答を検出しました");
      if (data.race && String(data.race) !== String(targetRaceNo)) throw new Error("別レースのキャッシュ応答を検出しました");
      if (data.odds && Object.keys(data.odds).length >= 10) {
        setOdds(data.odds);
        const cacheNote = apiCacheNote(data, "オッズ共有キャッシュ");
        setPMsg("odds", `✓ ${targetVenue}${targetRaceNo}Rの3連単オッズ ${Object.keys(data.odds).length}点を更新しました${cacheNote}`);
        setAutoMsg(`${targetVenue}${targetRaceNo}Rのオッズを更新しました${cacheNote}。`);
        setAutoRefreshInfo("");
      } else {
        throw new Error(data.error || "3連単オッズを十分に取得できませんでした");
      }
    } catch (e) {
      setAutoMsg(`オッズ更新失敗：${e.message || e}`);
      setAutoRefreshInfo(`オッズ自動更新エラー：${e.message || e}`);
    } finally {
      autoBusyRef.current = false;
      setAutoLoading(false);
    }
  };

  // 公式サイト（許可済み想定）の展示データを自動取得
  // 合算値は「展示＋1周＋回り足」。直線は取得・表示するが合算には含めない。
  // 画面上に展示系の生数値は出さず、内部計算のみに使う仕様は維持。
  const fetchOfficialYoso = async (override = {}) => {
    const targetVenue = override.venue || venue;
    const targetRaceNo = override.raceNo || raceNo;
    const targetDate = override.raceDate || raceDate;
    const requestKey = `${targetVenue}_${targetDate}_${targetRaceNo}`;
    const nowMs = Date.now();
    if (!targetVenue) return;
    if (override.oddsOnly || (override.background && hasCompleteAutoStaticData(targetVenue))) {
      return fetchOfficialOddsOnly(override);
    }
    if (salesEnded && !override.ignoreSalesEnded && override.background) {
      setAutoMsg(`${targetVenue}は本日の発売終了です。復習用データは当日中のみ手動で表示できます。`);
      return;
    }
    if (!override.force && autoBusyRef.current) return;
    if (!override.force && lastAutoFetchKeyRef.current === requestKey && nowMs - lastAutoFetchAtRef.current < 30000) return;
    lastAutoFetchKeyRef.current = requestKey;
    lastAutoFetchAtRef.current = nowMs;
    autoBusyRef.current = true;
    setAutoMsg(override.background ? `自動更新中：${targetVenue}${targetRaceNo}Rを確認しています…` : "");
    if (!AUTO_FETCH_VENUES.includes(targetVenue)) {
      setAutoMsg(`${targetVenue || "未選択"}の自動取得に対応していません。`);
      autoBusyRef.current = false;
      return;
    }
    setAutoLoading(true);
    try {
      const qs = new URLSearchParams({
        venue: targetVenue,
        race: String(targetRaceNo),
        date: targetDate,
      });
      const res = await fetch(`/api/yoso?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "取得に失敗しました");
      if (data.venue && String(data.venue) !== String(targetVenue)) throw new Error("別場のキャッシュ応答を検出しました");
      if (data.race && String(data.race) !== String(targetRaceNo)) throw new Error("別レースのキャッシュ応答を検出しました");

      // 選手/モーター/F持ち/平均ST/風/オッズは、展示公開前でも反映できるものは先に反映する。
      const meta = applyBoatcastMeta(data);
      const w = data.weather || {};
      const windKey = w.windKey && WIND[w.windKey] ? w.windKey : "";
      if (windKey) setWind(windKey);
      const windNote = windKey
        ? `／風も自動入力：${windKey}`
        : w.windSpeed
          ? `／風速${w.windSpeed}m取得（風向きは手動確認）`
          : "";
      const cacheNote = apiCacheNote(data, "BOATCAST共有キャッシュ");
      const metaNote = meta.racerCount || meta.motorCount || meta.fCount
        ? `／選手${meta.racerCount}名・モーター${meta.motorCount}艇・F持ち${meta.fCount}艇も自動反映`
        : "";
      let oddsNote = "";
      if (data.odds && Object.keys(data.odds).length >= 10) {
        setOdds(data.odds);
        oddsNote = `／3連単オッズ${Object.keys(data.odds).length}点も自動取得`;
        setPMsg("odds", `✓ ${targetVenue}${targetRaceNo}Rの3連単オッズ ${Object.keys(data.odds).length}点を自動取得しました（合成オッズに反映）`);
      } else if (AUTO_FETCH_VENUES.includes(targetVenue)) {
        oddsNote = "／オッズは未取得";
      }

      const rows = data.rows || [];
      const displayDisabled = data.displayDisabled || !usesDisplayCorrection(targetVenue);
      if (!displayDisabled && rows.length < 6) {
        const reasonCode = data.displayReasonCode || "";
        let msg = `${targetVenue}${targetRaceNo}Rは公開展示待ちです。`;
        if (reasonCode === "five_boat") msg = `${targetVenue}${targetRaceNo}R：エラー。5艇レースのため。`;
        else if (reasonCode === "display_shortage") msg = `${targetVenue}${targetRaceNo}R：エラー。展示情報不足のため。`;
        setPMsg("tenji", msg);
        setAutoMsg(msg);
        setAutoRefreshInfo(msg);
        return;
      }

      applyBoatcastRows(rows, { displayDisabled });

      const simpleFetchMsg = `${targetVenue}${targetRaceNo}Rのデータを取得しました${cacheNote}。`;
      setPMsg("tenji", simpleFetchMsg);
      setAutoMsg(simpleFetchMsg);
      setAutoRefreshInfo("");
    } catch (e) {
      setAutoMsg(`取得失敗：${e.message || e}`);
      setAutoRefreshInfo(`自動更新エラー：${e.message || e}`);
    } finally {
      autoBusyRef.current = false;
      setAutoLoading(false);
    }
  };


  const normalizeVenueStatus = (data) => {
    if (!data) return null;
    const status = data.status || (data.noRace ? "未開催" : data.allClosed ? "発売終了" : data.nextRace ? "発売中" : "未確認");
    return {
      ok: data.ok !== false,
      venue: data.venue,
      status,
      noRace: !!data.noRace || status === "未開催",
      allClosed: !!data.allClosed || status === "発売終了",
      nextRace: data.nextRace ? String(data.nextRace) : "",
      nextDeadline: data.nextDeadline || "",
      nextDeadlineMinutes: data.nextDeadlineMinutes ?? null,
      scheduleCount: data.scheduleCount ?? (Array.isArray(data.schedule) ? data.schedule.length : 0),
      grade: data.grade || data.rank || "",
      eventDay: data.eventDay || data.dayText || "",
      eventName: data.eventName || "",
      error: data.error || "",
      cached: !!data.cached,
    };
  };



  const prefetchStorageKey = (v, d, r) => `hunaken_prefetch_yoso_v109_${v}_${d}_${r}`;

  const storePrefetchPayload = (v, d, r, data) => {
    try {
      localStorage.setItem(prefetchStorageKey(v, d, r), JSON.stringify({ savedAt: Date.now(), data }));
    } catch (e) {}
  };

  const readPrefetchPayload = (v, d, r) => {
    try {
      const raw = localStorage.getItem(prefetchStorageKey(v, d, r));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.data || Date.now() - Number(parsed.savedAt || 0) > 4 * 60 * 1000) return null;
      return parsed.data;
    } catch (e) {
      return null;
    }
  };

  const applyPrefetchedYosoPayload = (data, targetVenue, targetRaceNo, targetDate) => {
    const rows = data?.rows || [];
    if (!Array.isArray(rows) || rows.length < 6) return false;

    applyBoatcastRows(rows, { displayDisabled: !!data?.displayDisabled || !usesDisplayCorrection(targetVenue) });

    const meta = applyBoatcastMeta(data);

    const w = data.weather || {};
    const windKey = w.windKey && WIND[w.windKey] ? w.windKey : "";
    if (windKey) setWind(windKey);
    if (data.odds && Object.keys(data.odds).length >= 10) {
      setOdds(data.odds);
      setPMsg("odds", `✓ ${targetVenue}${targetRaceNo}Rの3連単オッズ ${Object.keys(data.odds).length}点を事前取得済みデータから反映しました`);
    }
    const windNote = windKey ? `／風も自動入力：${windKey}` : "";
    const metaNote = meta.racerCount || meta.motorCount || meta.fCount ? `／選手・モーター・F持ちも反映` : "";
    const oddsNote = data.odds && Object.keys(data.odds).length >= 10 ? `／3連単オッズ${Object.keys(data.odds).length}点も反映` : "";
    const simpleFetchMsg = `${targetVenue}${targetRaceNo}Rのデータを取得しました。`;
    setPMsg("tenji", simpleFetchMsg);
    setAutoMsg(simpleFetchMsg);
    setAutoRefreshInfo("");
    return true;
  };

  const tryApplyPrefetchedYoso = (v, r, d) => {
    const data = readPrefetchPayload(v, d, r);
    if (!data) return false;
    return applyPrefetchedYosoPayload(data, v, r, d);
  };

  const minutesUntilDeadline = (hhmm) => {
    const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const deadlineMin = Number(m[1]) * 60 + Number(m[2]);
    const now = new Date();
    return deadlineMin - (now.getHours() * 60 + now.getMinutes());
  };

  // 締切15分前から、対応場の次Rをサーバー側キャッシュへ先読みする。
  // 画面を開いている間だけ動く。ユーザーが場をタップした時は、通常取得でも3分キャッシュから即返りやすくなる。
  const prefetchApproachingAutoRaces = async (statuses, targetDate = todayDateValue()) => {
    if (!autoRefreshEnabledRef.current || document.hidden) return;
    if (targetDate !== todayDateValue()) return;
    const raw = Object.values(statuses || {});
    const candidates = raw
      .filter((st) => st && AUTO_FETCH_VENUES.includes(st.venue) && !st.noRace && !st.allClosed && st.nextRace && st.nextDeadline)
      .map((st) => ({ ...st, leftMin: minutesUntilDeadline(st.nextDeadline) }))
      .filter((st) => st.leftMin != null && st.leftMin <= 15 && st.leftMin >= -1)
      .sort((a, b) => a.leftMin - b.leftMin)
      .slice(0, 8);

    if (!candidates.length) {
      setPrefetchInfo("");
      return;
    }

    const done = [];
    for (const st of candidates) {
      const key = `${st.venue}_${targetDate}_${st.nextRace}`;
      const nowMs = Date.now();
      if (prefetchBusyKeysRef.current.has(key)) continue;
      if (lastPrefetchAtByKeyRef.current[key] && nowMs - lastPrefetchAtByKeyRef.current[key] < 150000) continue;
      prefetchBusyKeysRef.current.add(key);
      lastPrefetchAtByKeyRef.current[key] = nowMs;
      try {
        const existing = readPrefetchPayload(st.venue, targetDate, st.nextRace);
        if (existing && Array.isArray(existing.rows) && existing.rows.length >= 6) {
          const qs = new URLSearchParams({ action: "odds", venue: st.venue, race: String(st.nextRace), date: targetDate });
          const res = await fetch(`/api/yoso?${qs.toString()}`);
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok && data.odds && Object.keys(data.odds).length >= 10) {
            storePrefetchPayload(st.venue, targetDate, st.nextRace, { ...existing, odds: data.odds, oddsCount: data.oddsCount, oddsUrl: data.oddsUrl, oddsUpdatedAt: data.fetchedAt });
            done.push(`${st.venue}${st.nextRace}Rオッズ`);
          }
        } else {
          const qs = new URLSearchParams({ venue: st.venue, race: String(st.nextRace), date: targetDate });
          const res = await fetch(`/api/yoso?${qs.toString()}`);
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok && Array.isArray(data.rows) && data.rows.length >= 6) {
            storePrefetchPayload(st.venue, targetDate, st.nextRace, data);
            done.push(`${st.venue}${st.nextRace}R`);
          }
        }
      } catch (e) {
        // 15分前でも場によってはまだ展示が出ていないことがあるため、失敗は次回3分後に再試行する。
      } finally {
        prefetchBusyKeysRef.current.delete(key);
      }
    }
    if (done.length) {
      const t = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
      setPrefetchInfo("");
    } else {
      setPrefetchInfo("");
    }
  };

  const refreshVenueStatuses = async (targetDate = todayDateValue(), opts = {}) => {
    if (!opts.silent) setVenueStatusLoading(true);
    try {
      const qs = new URLSearchParams({ action: "schedules", date: targetDate });
      const res = await fetch(`/api/yoso?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "開催状況を取得できませんでした");
      const next = {};
      const raw = data.statusesByVenue || {};
      Object.keys(raw).forEach((v) => {
        next[v] = normalizeVenueStatus(raw[v]);
      });
      setVenueStatuses(next);
      prefetchApproachingAutoRaces(next, targetDate);
      return next;
    } catch (e) {
      if (!opts.silent) setAutoRefreshInfo(`開催状況の取得に失敗しました（${e.message || e}）`);
      return null;
    } finally {
      if (!opts.silent) setVenueStatusLoading(false);
    }
  };


  const resolveNextRaceFromOfficial = async (v, targetDate = todayDateValue(), opts = {}) => {
    const fallbackRace = autoRaceForVenue(v);
    if (!v) return { raceNo: fallbackRace, allClosed: false, fallback: true };
    try {
      if (!opts.silent) setAutoRefreshInfo(`${v}の公式締切時刻を確認中…`);
      const qs = new URLSearchParams({ action: "schedule", venue: v, date: targetDate });
      const res = await fetch(`/api/yoso?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "締切時刻の取得に失敗しました");

      setOfficialSchedule(data);
      const normalized = normalizeVenueStatus(data);
      setVenueStatuses((p) => ({ ...p, [v]: normalized }));
      setVenueNotHeld(!!normalized?.noRace);
      setSalesEnded(!!normalized?.allClosed);

      if (normalized?.noRace) {
        setAutoRefreshInfo(`${v}は本日未開催です（公式締切時刻で判定）`);
        return { noRace: true, allClosed: false, raceNo: "", data };
      }

      if (normalized?.allClosed) {
        setReviewMode(true);
        setAutoRefreshInfo(`${v}は本日の全レース発売終了です。当日中のみ復習用に閲覧できます。`);
        return { allClosed: true, raceNo: String(raceNo || "12"), data };
      }

      setReviewMode(false);
      const nextRace = String(data.nextRace || fallbackRace);
      const deadline = data.nextDeadline ? `／締切${data.nextDeadline}` : "";
      setAutoRefreshInfo(`公式締切で判定：${v}${nextRace}R${deadline}（次回も約3分後に再判定）`);
      return { allClosed: false, raceNo: nextRace, deadline: data.nextDeadline || "", data };
    } catch (e) {
      setSalesEnded(false);
      setVenueNotHeld(false);
      setOfficialSchedule(null);
      setAutoRefreshInfo(`公式締切時刻の取得に失敗。暫定で${v}${fallbackRace}Rを選択します（${e.message || e}）`);
      return { raceNo: fallbackRace, allClosed: false, fallback: true, error: e.message || String(e) };
    }
  };

  const selectVenueQuick = async (v) => {
    const today = todayDateValue();
    manualRaceSelectUntilRef.current = 0;
    setVenue(v);
    setRaceDate(today);
    setSalesEnded(false);
    setReviewMode(false);
    setVenueNotHeld(false);
    resetRaceAutoData();
    setAutoMsg(`${v}の公式締切時刻を確認中…`);

    const resolved = await resolveNextRaceFromOfficial(v, today);
    if (resolved.noRace) {
      setRaceNo("1");
      resetRaceAutoData();
      setAutoMsg(`${v}は本日未開催です`);
      return;
    }
    if (resolved.allClosed) {
      const reviewRace = raceNo && String(raceNo) !== "" ? String(raceNo) : "12";
      setRaceNo(reviewRace);
      setReviewMode(true);
      resetRaceAutoData();
      setAutoMsg(`${v}は本日の全レース発売終了です。当日中の復習用に${reviewRace}Rを表示します。`);
      if (AUTO_FETCH_VENUES.includes(v)) {
        window.setTimeout(() => fetchOfficialYoso({ venue: v, raceNo: reviewRace, raceDate: today, force: true, ignoreSalesEnded: true }), 80);
      }
      return;
    }

    const nextRace = chooseLiveRaceNo(v, resolved.raceNo, resolved.deadline);
    setRaceNo(nextRace);
    resetRaceAutoData();
    if (AUTO_FETCH_VENUES.includes(v)) {
      const deadline = resolved.deadline ? `（締切${resolved.deadline}）` : "";
      const appliedPrefetch = tryApplyPrefetchedYoso(v, nextRace, today);
      if (!appliedPrefetch) {
        setAutoMsg(`${v}${nextRace}Rを公式締切時刻で自動選択しました${deadline}。取得します…`);
        window.setTimeout(() => fetchOfficialYoso({ venue: v, raceNo: nextRace, raceDate: today, force: true, ignoreSalesEnded: true }), 80);
      }
    } else {
      setAutoMsg(`${v}${nextRace}Rを公式締切時刻で自動選択しました。展示等の自動取得は順次対応予定です。`);
    }
  };

  // 完全自動更新：場・R・日付が選ばれたら自動取得し、開いている間だけ3分ごとに公式締切で次R判定＋再取得
  useEffect(() => {
    if (!autoRefreshEnabled || salesEnded || !venue || !AUTO_FETCH_VENUES.includes(venue)) return;
    const t = window.setTimeout(() => {
      fetchOfficialYoso({ venue, raceNo, raceDate, background: true });
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshEnabled, salesEnded, venue, raceNo, raceDate]);

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const run = async (force = false) => {
      if (!venue || !AUTO_FETCH_VENUES.includes(venue)) return;
      if (document.hidden) return;
      const today = todayDateValue();
      const resolved = await resolveNextRaceFromOfficial(venue, today, { silent: true });
      if (resolved.noRace) {
        setRaceDate(today);
        setRaceNo("1");
        resetRaceAutoData();
        setAutoMsg(`${venue}は本日未開催です`);
        return;
      }
      if (resolved.allClosed) {
        setRaceDate(today);
        setReviewMode(true);
        setAutoMsg(`${venue}は本日の全レース発売終了です。復習用データは当日中のみ表示できます。`);
        return;
      }
      const nextRace = chooseLiveRaceNo(venue, resolved.raceNo, resolved.deadline);
      const manualHold = manualRaceSelectUntilRef.current && manualRaceSelectUntilRef.current > Date.now();
      const targetRace = manualHold ? String(raceNo || nextRace) : nextRace;
      if (!manualHold && raceNo !== nextRace) {
        setRaceNo(nextRace);
        resetRaceAutoData();
      }
      if (raceDate !== today) setRaceDate(today);
      fetchOfficialYoso({ venue, raceNo: targetRace, raceDate: today, background: true, force, ignoreSalesEnded: true, oddsOnly: hasCompleteAutoStaticData() });
    };
    run(true);
    const id = window.setInterval(() => run(false), 180000);
    const onFocus = () => run(false);
    const onVisibility = () => { if (!document.hidden) run(false); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshEnabled, venue, raceNo, raceDate]);

  // 開催場カード用：全24場の公式締切状況を定期取得（未開催／発売終了／次R）
  useEffect(() => {
    const today = todayDateValue();
    refreshVenueStatuses(today);
    const id = window.setInterval(() => refreshVenueStatuses(todayDateValue(), { silent: true }), 180000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ② 平均ST表（基本情報: 今期〜ナイター・F持）
  const parseStPaste = (overrideText = null, msgKey = "st") => {
    setPMsg(msgKey, "");
    try {
      let text = overrideText ?? pTexts.st;
      const stStart = text.indexOf("平均ST");
      if (stStart !== -1) {
        let stEnd = text.length;
        for (const endLabel of ["ST順位", "1着率", "2連対率", "3連対率", "逃げシミュレーション", "決まり手"]) {
          const j = text.indexOf(endLabel, stStart + 3);
          if (j !== -1) stEnd = Math.min(stEnd, j);
        }
        text = text.slice(stStart, stEnd);
      }
      let cur = 0;
      const table = {};
      for (const lb of ST_PERIODS) {
        const i = text.indexOf(lb, cur);
        if (i === -1) { table[lb] = null; continue; }
        cur = i + lb.length;
        const seg = text.slice(cur);
        const re = /\d+\.\d+|\.\d+|[-−ー]/g;
        const vals = [];
        let m;
        while (vals.length < 6 && (m = re.exec(seg))) {
          vals.push(/^[-−ー]$/.test(m[0]) ? null : Number(m[0]));
        }
        if (vals.length === 6) {
          table[lb] = vals;
          cur += re.lastIndex;
        } else {
          table[lb] = null;
        }
      }
      if (ST_PERIODS.some((p) => table[p])) {
        setStTable(table);
        applyStTable(table, stPeriod);
        setPMsg(msgKey, `✓ 平均ST表を読み取り「${stPeriod}」のSTとF持を反映しました。期間プルダウンで切替できます`);
        return true;
      } else {
        setPMsg(msgKey, "平均ST表が見つかりません。平均STの表をコピーしてください");
        return false;
      }
    } catch (e) {
      setPMsg(msgKey, "解析に失敗しました。表の部分だけを貼り付けてみてください");
      return false;
    }
  };

  // ④ 選手成績（枠別情報: 1着率・2連対率・3連対率 × 区分）
  const parseRacer = (overrideText = null, msgKey = "racer") => {
    setPMsg(msgKey, "");
    try {
      const text = overrideText ?? pTexts.racer;

      // セクションを次のセクション開始位置までで切り出す
      const sectionText = (label, nextLabels) => {
        const i = text.indexOf(label);
        if (i === -1) return null;
        let end = text.length;
        for (const nl of nextLabels) {
          const j = text.indexOf(nl, i + label.length);
          if (j !== -1) end = Math.min(end, j);
        }
        return text.slice(i + label.length, end);
      };

      // セクション内で各区分の行（6艇分）を読む。順序に依存せず各ラベルを毎回先頭から探す
      const parseSection = (sec) => {
        if (sec == null) return null;
        const row = (labels) => {
          for (const label of labels) {
            let from = 0;
            // 同じラベルが複数回出る場合に備え、6個読めるまで次の出現位置を試す
            while (true) {
              const i = sec.indexOf(label, from);
              if (i === -1) break;
              const pos = i + label.length;
              // 次のラベル候補までを範囲にして、混入を防ぐ
              const seg = sec.slice(pos);
              const re = /\d+\.\d+|[-−ー]/g;
              const vals = [];
              let m;
              while (vals.length < 6 && (m = re.exec(seg))) {
                vals.push(/^[-−ー]$/.test(m[0]) ? null : Number(m[0]));
              }
              if (vals.length === 6) return vals;
              from = pos;
            }
          }
          return null;
        };
        // 「直近」+数字（6/3/1）の行を、間の空白・改行を許容して読む
        const recentRow = (num) => {
          let from = 0;
          while (true) {
            const i = sec.indexOf("直近", from);
            if (i === -1) break;
            // 「直近」の後ろ、数字までの間に空白/改行のみを許す
            const after = sec.slice(i + 2);
            const mm = after.match(/^[\s　]*(\d)/);
            if (mm && Number(mm[1]) === num) {
              const pos = i + 2 + mm.index + mm[0].length; // 数字の直後
              const seg = sec.slice(pos);
              const re = /\d+\.\d+|[-−ー]/g;
              const vals = [];
              let m;
              while (vals.length < 6 && (m = re.exec(seg))) {
                vals.push(/^[-−ー]$/.test(m[0]) ? null : Number(m[0]));
              }
              if (vals.length === 6) return vals;
            }
            from = i + 2;
          }
          return null;
        };

        return {
          "直近1年": row(["今期", "直近1年"]),
          "直近6ヶ月": recentRow(6),
          "直近3ヶ月": recentRow(3),
          "直近1ヶ月": recentRow(1),
          "当地": row(["当地"]),
          "一般戦": row(["一般戦"]),
          "SG": row(["SG"]),
          "G1": row(["G1"]),
          "G2": row(["G2"]),
          "G3": row(["G3"]),
          "女子戦": row(["女子戦"]),
        };
      };

      const s1 = sectionText("1着率", ["2連対率", "3連対率"]);
      const s2 = sectionText("2連対率", ["3連対率"]);
      const s3 = sectionText("3連対率", []);
      if (!s1 && !s2 && !s3) {
        setPMsg(msgKey, "1着率〜3連対率が見つかりません。枠別情報の表をコピーしてください");
        return false;
      }
      const win1 = parseSection(s1);
      const ren2 = parseSection(s2);
      const ren3 = parseSection(s3);

      const clean = (sec) => {
        const out = {};
        for (const k of RACER_CATS) {
          const arr = sec ? sec[k] : null;
          out[k] = arr ? arr.map((v) => (v != null && v >= 0 && v <= 100 ? v : null)) : null;
        }
        return out;
      };
      const stats = { win1: clean(win1), ren2: clean(ren2), ren3: clean(ren3) };
      if (!RACER_CATS.some((k) => stats.win1[k] || stats.ren2[k] || stats.ren3[k])) {
        setPMsg(msgKey, "成績を読み取れませんでした。表の部分だけを貼り付けてください");
        return false;
      }
      setRacerStats(stats);
      setPMsg(msgKey, `✓ 枠別成績を読み取りました（区分「${racerCat}」で予想に反映中。プルダウンで切替可）`);
      return true;
    } catch (e) {
      setPMsg(msgKey, "解析に失敗しました。表の部分だけを貼り付けてみてください");
      return false;
    }
  };

  // ⑤ モーター情報（番号・勝率・1着率・2連対率・3連対率）
  const parseMotor = () => {
    setPMsg("motor", "");
    try {
      const text = pTexts.motor;
      const readRow = makeRowReader(text);

      const noRow = readRow("番号");
      readRow("ランク");  // 無視（カーソル送り）
      readRow("貢献P");   // 無視
      const rateRow = readRow("勝率");
      const win1Row = readRow("1着率");
      const ren2Row = readRow("2連対率");
      const ren3Row = readRow("3連対率");

      if (!rateRow && !ren2Row) {
        setPMsg("motor", "モーター表が見つかりません。番号〜3連対率の行をコピーしてください");
        return;
      }
      const nm = {};
      for (let b = 1; b <= 6; b++) {
        const i = b - 1;
        nm[b] = {
          no: noRow && Number.isInteger(noRow[i]) && noRow[i] >= 1 && noRow[i] <= 99 ? noRow[i] : null,
          rate: rateRow && rateRow[i] >= 0 && rateRow[i] <= 10 ? rateRow[i] : null,
          win1: win1Row && win1Row[i] >= 0 && win1Row[i] <= 100 ? win1Row[i] : null,
          ren2: ren2Row && ren2Row[i] >= 0 && ren2Row[i] <= 100 ? ren2Row[i] : null,
          ren3: ren3Row && ren3Row[i] >= 0 && ren3Row[i] <= 100 ? ren3Row[i] : null,
        };
      }
      setMotors(nm);
      setPMsg("motor", "✓ モーター情報を読み取りました（各艇カードに表示）");
    } catch (e) {
      setPMsg("motor", "解析に失敗しました。表の部分だけを貼り付けてみてください");
    }
  };

  // ⑥ 決まり手・逃げシミュレーション（枠別情報）
  const parseKimari = (overrideText = null, msgKey = "kimari") => {
    setPMsg(msgKey, "");
    try {
      const text = overrideText ?? pTexts.kimari;
      const readN = (seg, n) => {
        if (seg == null) return null;
        const m = seg.match(/\d+\.\d+/g);
        return m && m.length >= n ? m.slice(0, n).map(Number) : null;
      };

      // 逃げシミュレーション
      let nige = null;
      const simIdx = text.indexOf("逃げシミュレーション");
      if (simIdx !== -1) {
        const simEnd = text.indexOf("決まり手", simIdx);
        const sim = text.slice(simIdx, simEnd === -1 ? text.length : simEnd);
        const after = (label) => {
          const i = sim.indexOf(label);
          return i === -1 ? null : sim.slice(i + label.length);
        };
        const head = readN(after("逃がし2着率"), 7); // 1着・逃げ・逃がし2着×5
        const third = readN(after("逃がし3着率"), 5);
        const deme = readN(after("出目確率"), 5);
        if (head) {
          nige = {
            win1: head[0], nigeRate: head[1],
            second: head.slice(2), third, deme,
          };
        }
      }

      // 決まり手（直近6ヶ月・直近1年）
      const parseKim = (seg) => {
        if (seg == null) return null;
        let cur = 0;
        const rowAfter = (label, n) => {
          const i = seg.indexOf(label, cur);
          if (i === -1) return null;
          const pos = i + label.length;
          const m = (seg.slice(pos).match(/\d+\.\d+/g) || []).slice(0, n);
          if (m.length < n) return null;
          cur = pos;
          return m.map(Number);
        };
        const nigeRow = rowAfter("逃し", 2);        // [逃げ, 逃し]
        const sashiRow = rowAfter("差し", 6);       // [差され, 差し2..6]
        const makuriRow = rowAfter("捲り", 6);      // [捲られ, 捲り2..6]
        const mzRow = rowAfter("捲り差し", 6);      // [捲られ差, 捲り差し2..6]
        if (!nigeRow && !sashiRow && !makuriRow) return null;
        return {
          nige: nigeRow ? nigeRow[0] : null,
          nigashi: nigeRow ? nigeRow[1] : null,
          sasare: sashiRow ? sashiRow[0] : null,
          sashi: sashiRow ? sashiRow.slice(1) : null,
          makurare: makuriRow ? makuriRow[0] : null,
          makuri: makuriRow ? makuriRow.slice(1) : null,
          makuraresashi: mzRow ? mzRow[0] : null,
          makurizashi: mzRow ? mzRow.slice(1) : null,
        };
      };

      const kimIdx = text.indexOf("決まり手");
      let kim = null;
      if (kimIdx !== -1) {
        const i6 = text.indexOf("直近6ヶ月", kimIdx);
        const i1 = text.indexOf("直近1年", kimIdx);
        const seg6 = i6 !== -1 ? text.slice(i6, i1 !== -1 ? i1 : text.length) : null;
        const seg1 = i1 !== -1 ? text.slice(i1) : null;
        const k6 = parseKim(seg6);
        const k1 = parseKim(seg1);
        if (k6 || k1) kim = { "直近6ヶ月": k6, "直近1年": k1 };
      }

      if (!nige && !kim) {
        setPMsg(msgKey, "逃げシミュレーション・決まり手が見つかりません。枠別情報の該当表をコピーしてください");
        return false;
      }
      if (nige) setNigeSim({ ...nige, source: "貼付" });
      if (kim) setKimari(kim);
      const got = [nige ? "逃げシミュ" : null, kim ? "決まり手" : null].filter(Boolean).join("・");
      setPMsg(msgKey, `✓ ${got}を読み取りました（決まり手は「${kimariPeriod}」で評価。期間切替可）`);
      return true;
    } catch (e) {
      setPMsg(msgKey, "解析に失敗しました。表の部分だけを貼り付けてみてください");
      return false;
    }
  };

  // オッズ一覧（3連単）の貼り付け解析
  const parseOdds = () => {
    setPMsg("odds", "");
    try {
      const text = pTexts.odds;
      const rawLines = text.split(/\n/).map((l) => l.replace(/\s+$/, ""));
      // 区切りはタブ優先、無ければ空白
      const splitCells = (line) => line.includes("\t")
        ? line.split("\t").map((c) => c.trim()).filter((c) => c !== "")
        : line.trim().split(/[ 　]+/).filter((c) => c !== "");
      const isBoatNo = (x) => /^[1-6]$/.test(String(x || ""));
      const isOddsNo = (x) => /^\d+(?:\.\d+)?$/.test(String(x || "").replace(/,/g, ""));
      const toOdds = (x) => Number(String(x || "").replace(/,/g, ""));

      // 唐津・三国スマホ版などの縦並び形式
      // 例: 「1 選手名」→「2 3 31.9」→「4 51.3」→ ...
      const parseSequentialOdds = () => {
        const out = {};
        let first = null;
        let second = null;
        const usable = rawLines.map((l) => l.trim()).filter(Boolean);
        for (const line of usable) {
          if (/更新ボタン|レース情報|Copyright/.test(line)) break;
          const cells = splitCells(line);
          if (cells.length === 0) continue;
          const isHeader = cells.length >= 2
            && isBoatNo(cells[0])
            && !isOddsNo(cells[1])
            && !/合成|単勝|複勝|3連単|2連単|3連複|人気|高配当|更新/.test(line);
          if (isHeader) {
            first = Number(cells[0]);
            second = null;
            continue;
          }
          if (!first) continue;

          // 新しい2着列: 2着 3着 オッズ
          if (cells.length >= 3 && isBoatNo(cells[0]) && isBoatNo(cells[1]) && isOddsNo(cells[2])) {
            second = Number(cells[0]);
            const third = Number(cells[1]);
            const o = toOdds(cells[2]);
            if (second !== first && third !== first && third !== second && o > 0) {
              out[`${first}-${second}-${third}`] = o;
            }
            // 同じ行に続きの「3着 オッズ」がある場合も拾う
            for (let i = 3; i + 1 < cells.length; i += 2) {
              const t = Number(cells[i]);
              const oo = toOdds(cells[i + 1]);
              if (second && t >= 1 && t <= 6 && t !== first && t !== second && oo > 0) {
                out[`${first}-${second}-${t}`] = oo;
              }
            }
            continue;
          }

          // 同じ2着列の続き: 3着 オッズ
          if (second && cells.length >= 2 && isBoatNo(cells[0]) && isOddsNo(cells[1])) {
            const third = Number(cells[0]);
            const o = toOdds(cells[1]);
            if (third !== first && third !== second && o > 0) {
              out[`${first}-${second}-${third}`] = o;
            }
            for (let i = 2; i + 1 < cells.length; i += 2) {
              const t = Number(cells[i]);
              const oo = toOdds(cells[i + 1]);
              if (t >= 1 && t <= 6 && t !== first && t !== second && oo > 0) {
                out[`${first}-${second}-${t}`] = oo;
              }
            }
          }
        }
        return out;
      };

      // 従来の横テーブル形式
      const parseGridOdds = () => {
        const blocks = [];
        let cur = null;
        for (const line of rawLines) {
          if (line.trim() === "") continue;
          const cells = splitCells(line);
          const isHeader = cells.length >= 2
            && isBoatNo(cells[0])
            && !/^[\d.]/.test(cells[1])
            && !/合成|単/.test(line);
          if (isHeader) {
            if (cur) blocks.push(cur);
            cur = { first: Number(cells[0]), rows: [] };
          } else if (cur && !/合成|単/.test(line)) {
            cur.rows.push(cells);
          }
        }
        if (cur) blocks.push(cur);

        const out = {};
        for (const blk of blocks) {
          const first = blk.first;
          const rows = blk.rows;
          if (rows.length === 0) continue;
          // 1行目: 各列「2着 3着 オッズ」の3つ組
          const colSeconds = [];
          const r0 = rows[0];
          for (let i = 0; i + 2 < r0.length + 1; i += 3) {
            const sec = Number(r0[i]), third = Number(r0[i + 1]), o = toOdds(r0[i + 2]);
            if ([sec, third].every((x) => x >= 1 && x <= 6) && o > 0) {
              colSeconds.push(sec);
              if (third !== first && third !== sec) out[`${first}-${sec}-${third}`] = o;
            }
          }
          // 2行目以降: 各列「3着 オッズ」の2つ組
          for (let ri = 1; ri < rows.length; ri++) {
            const toks = rows[ri];
            for (let ci = 0; ci < colSeconds.length; ci++) {
              const third = Number(toks[ci * 2]);
              const o = toOdds(toks[ci * 2 + 1]);
              const sec = colSeconds[ci];
              if (third >= 1 && third <= 6 && o > 0 && third !== first && third !== sec) {
                out[`${first}-${sec}-${third}`] = o;
              }
            }
          }
        }
        return out;
      };

      const seq = parseSequentialOdds();
      const grid = parseGridOdds();
      // 唐津・三国の縦並びは120点近く取れるので、より多く読めた方を採用
      const result = Object.keys(seq).length >= Object.keys(grid).length ? seq : grid;

      if (Object.keys(result).length < 10) {
        setPMsg("odds", "オッズを十分に読み取れませんでした。締切前の3連単オッズ一覧（丸亀・蒲郡・下関・住之江・唐津・三国・鳴門・児島・福岡・平和島・びわこ・常滑・浜名湖対応）を丸ごとコピーしてください。自動取得できない時もここへ貼れば反映できます");
        return;
      }
      setOdds(result);
      setPMsg("odds", `✓ オッズ ${Object.keys(result).length}点を読み取りました（買い目の合成オッズに反映）`);
    } catch (e) {
      setPMsg("odds", "解析に失敗しました。表の部分だけを貼り付けてみてください");
    }
  };

  const parseBasicInfo = () => {
    setPMsg("basic", "");
    const text = pTexts.basic;
    const okRacer = parseRacer(text, "basic");
    const okSt = parseStPaste(text, "basic");
    const okKimari = parseKimari(text, "basic");
    const got = [okRacer ? "枠別成績(貼付)" : null, okSt ? "平均ST" : null, okKimari ? "決まり手/逃げ" : null].filter(Boolean);
    if (got.length) {
      setPMsg("basic", `✓ ${got.join("・")}を一括読み取りしました`);
      return true;
    }
    setPMsg("basic", "平均ST・決まり手/逃げを読み取れませんでした。枠別成績はDBから自動反映されます。");
    return false;
  };

  const PANELS = {
    basic: {
      title: "📋 補助データ一括",
      help: "平均ST・逃げシミュレーション・決まり手を貼り付け補助で読み取ります。枠別成績はDBから自動反映されます。",
      parse: parseBasicInfo,
    },
  };

  const setCourse = (boat, c) =>
    setCourses((p) => ({ ...p, [boat]: Number(c) }));
  const [inputs, setInputs] = useState({
    1: empty(), 2: empty(), 3: empty(), 4: empty(), 5: empty(), 6: empty(),
  });

  const emptyBoatMap = (value) => ({ 1: value, 2: value, 3: value, 4: value, 5: value, 6: value });

  const resetRaceAutoData = () => {
    setInputs({ 1: empty(), 2: empty(), 3: empty(), 4: empty(), 5: empty(), 6: empty() });
    setWeights(emptyBoatMap(""));
    setTilts(emptyBoatMap(""));
    setCourses({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 });
    setSts(emptyBoatMap(""));
    setFHold(emptyBoatMap(false));
    setFSts(emptyBoatMap(""));
    setMotors(emptyBoatMap(null));
    setRacerProfiles({});
    setOdds(null);
    setWind("無風");
  };

  const set = (boat, key, v) =>
    setInputs((p) => ({ ...p, [boat]: { ...p[boat], [key]: v } }));

  const correctionCache = useMemo(() => buildCorrectionCache(correctionTable), [correctionTable]);

  useEffect(() => {
    let alive = true;
    async function run() {
      if (!CORRECTION_TABLE_ENABLED) {
        if (alive) setCorrectionStatus(`固定補正（ENVなし URL:${SUPABASE_URL ? "有" : "無"} KEY:${SUPABASE_ANON_KEY ? "有" : "無"}）`);
        return;
      }
      try {
        setCorrectionStatus("補正読込中");
        const table = await fetchLatestCorrectionTables();
        if (!alive) return;
        if (table) {
          setCorrectionTable(table);
          setCorrectionStatus(`DB補正 ${table.days || 365}日`);
        } else {
          setCorrectionStatus("固定補正（latestなし）");
        }
      } catch (e) {
        console.error("correction_tables load error", e);
        if (alive) setCorrectionStatus(`固定補正（${String(e?.message || e).slice(0, 80)}）`);
      }
    }
    run();
    return () => { alive = false; };
  }, []);


  useEffect(() => {
    let alive = true;
    const regnos = [1, 2, 3, 4, 5, 6]
      .map((b) => Number(racerProfiles?.[b]?.regNo || 0))
      .filter(Boolean);
    if (!regnos.length) {
      setDbRacerRows([]);
      setDbRacerStatus("DB選手成績：選手未取得");
      return () => { alive = false; };
    }
    if (!CORRECTION_TABLE_ENABLED) {
      setDbRacerStatus("DB選手成績：ENVなし");
      return () => { alive = false; };
    }
    setDbRacerStatus("DB選手成績：読込中");
    fetchRaceResultsForRacers(regnos, 365)
      .then((rows) => {
        if (!alive) return;
        setDbRacerRows(Array.isArray(rows) ? rows : []);
        setDbRacerStatus(`DB選手成績：読込済 ${Array.isArray(rows) ? rows.length : 0}走`);
      })
      .catch((e) => {
        console.error("race_results course stats load error", e);
        if (alive) {
          setDbRacerRows([]);
          setDbRacerStatus(`DB選手成績：失敗 ${String(e?.message || e).slice(0, 60)}`);
        }
      });
    return () => { alive = false; };
  }, [JSON.stringify([1,2,3,4,5,6].map((b) => racerProfiles?.[b]?.regNo || "")), venue]);

  useEffect(() => {
    if (!dbRacerRows.length || !Object.keys(racerProfiles || {}).length) return;
    const stats = buildRacerCourseStatsFromDb(dbRacerRows, racerProfiles, courses, venue);
    setRacerStats(stats);
  }, [dbRacerRows, racerProfiles, courses, venue]);

  useEffect(() => {
    if (!dbRacerRows.length || !Object.keys(racerProfiles || {}).length) return;
    const dbSt = buildDbAverageStTableFromRows(dbRacerRows, racerProfiles, venue, courses);
    setStTable((prev) => ({ ...(prev || {}), ...dbSt }));
    // 自動取得後は選択中の期間をDB平均STで反映。貼付がある場合も同じキーは最新DBで上書き。
    const selected = dbSt?.[stPeriod];
    if (selected && selected.some((v) => v != null)) applyStTable({ ...(stTable || {}), ...dbSt }, stPeriod);
  }, [dbRacerRows, racerProfiles, venue, courses, stPeriod]);

  useEffect(() => {
    let alive = true;
    const placeNo = PLACE_NO_BY_VENUE[venue] || null;
    if (!placeNo) {
      setDbNigeRows([]);
      setNigeStatus("逃げシミュ：場未選択");
      return () => { alive = false; };
    }
    if (!CORRECTION_TABLE_ENABLED) {
      setNigeStatus("逃げシミュ：ENVなし");
      return () => { alive = false; };
    }
    setNigeStatus("逃げシミュ：DB読込中");
    fetchRaceResultsForVenue(placeNo, 365)
      .then((rows) => {
        if (!alive) return;
        setDbNigeRows(Array.isArray(rows) ? rows : []);
        setNigeStatus(`逃げシミュ：DB読込済 ${Array.isArray(rows) ? rows.length : 0}行`);
      })
      .catch((e) => {
        console.error("escape simulation db load error", e);
        if (alive) {
          setDbNigeRows([]);
          setNigeStatus(`逃げシミュ：失敗 ${String(e?.message || e).slice(0, 60)}`);
        }
      });
    return () => { alive = false; };
  }, [venue]);

  useEffect(() => {
    if (!dbNigeRows.length) return;
    const dbKimari = buildKimariFromDbRows(dbNigeRows);
    if (dbKimari && Object.values(dbKimari).some(Boolean)) setKimari((prev) => ({ ...(prev || {}), ...dbKimari }));
  }, [dbNigeRows]);

  const result = useMemo(() => {
    if (!venue) return null;
    const useDisplayCorrection = usesDisplayCorrection(venue);
    const sums = {};
    let avg = 0;
    if (useDisplayCorrection) {
      for (let b = 1; b <= 6; b++) {
        const { tenji, isshu, mawari } = inputs[b];
        const t = parseFloat(tenji), i = parseFloat(isshu), m = parseFloat(mawari);
        // 合算値は「展示＋1周＋回り足」。直線は参考指標として表示・保存するが、合算・平均との差には含めない。
        if ([t, i, m].some((x) => isNaN(x))) return null;
        sums[b] = t + i + m;
      }
      avg = Object.values(sums).reduce((a, b) => a + b, 0) / 6;
    } else {
      for (let b = 1; b <= 6; b++) sums[b] = 0;
    }
    const zeroAdj = { w1: 0, w2: 0, w3: 0, top3: 0, tier: 0, tierMax: 1 };
    const venueBaseInfo = getVenueBaseWithCorrections(venue, raceDate, correctionCache);
    const { base, season: curSeason, seasonal: usingSeasonal, dynamic: usingDynamicVenueBase } = venueBaseInfo;
    const rows = [];
    for (let b = 1; b <= 6; b++) {
      const diff = useDisplayCorrection ? avg - sums[b] : 0; // プラス＝良化
      const course = courses[b];
      const adj = useDisplayCorrection ? lookup(course, diff) : zeroAdj;             // 江戸川は展示補正なし
      const baseRate = base[course - 1];            // 進入コースの基本場平均1着率（季節別・場別）
      const windInfo = getWindAdjWithCorrections(venue, wind, course, correctionCache);
      const windAdj = windInfo.value; // 無風基準の風補正（DB補正優先、取れなければ固定WIND）
      const final1 = baseRate + adj.w1;             // 基準 + タイム補正。風補正はここに混ぜない（二重反映防止）
      // 本人の枠別成績ベース（選手成績貼り付け時のみ）
      const rW1 = racerStats?.win1?.[racerCat]?.[b - 1] ?? null;
      const rR2 = racerStats?.ren2?.[racerCat]?.[b - 1] ?? null;
      const rR3 = racerStats?.ren3?.[racerCat]?.[b - 1] ?? null;
      const racerR1final = rW1 != null ? rW1 + adj.w1 : null;            // 本人1着率＋1着補正
      const racerR2final = rR2 != null ? rR2 + adj.w1 + adj.w2 : null;   // 本人2連対率＋補正
      const racerR3final = rR3 != null ? rR3 + adj.top3 : null;          // 本人3連対率＋補正
      rows.push({
        boat: b, course, sum: sums[b], diff, baseRate, windAdj, final1,
        racerW1: rW1, racerR2: rR2, racerR3: rR3,
        racerR1final, racerR2final, racerR3final,
        ...adj,
      });
    }
    const rank = [...rows].sort((a, b) => b.final1 - a.final1);
    const hasRacer = rows.some((r) => r.racerR1final != null || r.racerR3final != null);
    const sortKey = (r) => r.racerR1final ?? (r.racerR3final != null ? r.racerR3final - 100 : -999);
    const racerRank = hasRacer
      ? [...rows].sort((a, b) => sortKey(b) - sortKey(a))
      : null;
    const dup = new Set(Object.values(courses)).size !== 6;
    return { avg, rows, rank, racerRank, dup, season: curSeason, usingSeasonal };
  }, [inputs, venue, wind, courses, racerStats, racerCat, raceDate]);

  useEffect(() => {
    if (!dbNigeRows.length || !result?.rows?.length) return;
    const sim = buildEscapeSimulationFromDb(dbNigeRows, courses, result.rows, racerStats, racerCat, sts, fHold, fSts, wind);
    if (sim && sim.n) {
      setNigeSim(sim);
      setNigeStatus(`逃げシミュ：DB反映 ${sim.n}R`);
    }
  }, [dbNigeRows, courses, result, racerStats, racerCat, sts, fHold, fSts, wind]);

  // スリット予測（平均ST／F持ちはF後STを優先、不明はそのままマーク表示）
  const slit = useMemo(() => {
    const rows = [];
    for (let b = 1; b <= 6; b++) {
      if (sts[b] === "") return null; // 全艇の平均ST選択で表示
      const baseSt = parseFloat(sts[b]);
      let st = baseSt;
      let mark = null;
      if (fHold[b]) {
        if (fSts[b] !== "") {
          st = parseFloat(fSts[b]);
          mark = "F";
        } else {
          mark = "F?"; // F持ちだがF後ST不明 → 平均STのまま
        }
      }
      rows.push({ boat: b, course: courses[b], st, mark });
    }
    rows.sort((a, b) => a.course - b.course);
    return rows;
  }, [sts, fHold, fSts, courses]);

  // 指定区分(cat)の枠別成績で rows を作り直す（タイム・風・補正は共通、racerR*finalのみ差し替え）
  const rowsForCat = (baseRows, cat) => baseRows.map((r) => {
    const i = r.boat - 1;
    const rW1 = racerStats?.win1?.[cat]?.[i] ?? null;
    const rR2 = racerStats?.ren2?.[cat]?.[i] ?? null;
    const rR3 = racerStats?.ren3?.[cat]?.[i] ?? null;
    return {
      ...r,
      racerW1: rW1, racerR2: rR2, racerR3: rR3,
      racerR1final: rW1 != null ? rW1 + (r.w1 || 0) : null,
      racerR2final: rR2 != null ? rR2 + (r.w1 || 0) + (r.w2 || 0) : null,
      racerR3final: rR3 != null ? rR3 + (r.top3 || 0) : null,
    };
  });

  // 総合AI評価（枠別成績・展示タイム・モーター・風の4項目）。rows を渡すと同じロジックで評価
  const evaluateRows = (rows) => {
    if (!rows) return null;

    // ST（F持ちはF時STを優先）
    const effSt = {};
    for (let b = 1; b <= 6; b++) {
      if (sts[b] !== "") {
        effSt[b] = fHold[b] && fSts[b] !== "" ? parseFloat(fSts[b]) : parseFloat(sts[b]);
      }
    }
    const stVals = Object.values(effSt);
    const stAvg = stVals.length >= 2 ? stVals.reduce((a, c) => a + c, 0) / stVals.length : null;

    const motorVals = Object.values(motors).filter((m) => m && (m.ren3 != null || m.ren2 != null)).map((m) => m.ren3 ?? m.ren2);
    const motorAvg = motorVals.length >= 2 ? motorVals.reduce((a, c) => a + c, 0) / motorVals.length : null;
    // モーター上位2機（3連対率順）。3連対率がない場合だけ2連対率で補完。
    const motorTop2 = new Set(
      Object.entries(motors)
        .filter(([, m]) => m && (m.ren3 != null || m.ren2 != null))
        .sort((a, b) => (b[1].ren3 ?? b[1].ren2 ?? -Infinity) - (a[1].ren3 ?? a[1].ren2 ?? -Infinity))
        .slice(0, 2)
        .map(([b]) => Number(b))
    );

    const r1Vals = rows.filter((r) => r.racerR1final != null).map((r) => r.racerR1final);
    const r1Avg = r1Vals.length >= 2 ? r1Vals.reduce((a, c) => a + c, 0) / r1Vals.length : null;
    const r2Vals = rows.filter((r) => r.racerR2final != null).map((r) => r.racerR2final);
    const r2Avg = r2Vals.length >= 2 ? r2Vals.reduce((a, c) => a + c, 0) / r2Vals.length : null;
    const r3Vals = rows.filter((r) => r.racerR3final != null).map((r) => r.racerR3final);
    const r3Avg = r3Vals.length >= 2 ? r3Vals.reduce((a, c) => a + c, 0) / r3Vals.length : null;

    const evals = rows.map((r) => {
      const m = motors[r.boat];
      // 4項目判定: true=良 / false=良くない / null=データなし
      const crit = {
        racer: (r.racerR1final == null && r.racerR2final == null && r.racerR3final == null)
          ? null
          : (r.racerR1final != null && r1Avg != null && r.racerR1final >= r1Avg + 1)
            || (r.racerR2final != null && r2Avg != null && r.racerR2final >= r2Avg + 2)
            || (r.racerR3final != null && r3Avg != null && r.racerR3final >= r3Avg + 3),
        time: r.diff >= 0.1,
        motor: m && (m.ren2 != null || m.ren3 != null)
          ? (motorTop2.has(r.boat) || (m.ren3 != null && m.ren3 >= 60))
          : null,
        wind: wind === "無風" ? null : r.windAdj >= 0.5,
      };
      const goods = Object.values(crit).filter((v) => v === true).length;
      const mark = goods >= 3 ? "◎" : goods === 2 ? "○" : goods === 1 ? "△" : "✕";

      // 注意マーク
      const warns = [];
      if (fHold[r.boat]) warns.push("F持ち注意");
      if (stAvg != null && effSt[r.boat] != null && effSt[r.boat] - stAvg >= 0.03) {
        warns.push("ST遅め注意");
      }
      if (crit.motor === true && r.diff < 0) {
        warns.push("タイム不発でもモーター良・警戒");
      }
      if (tilts[r.boat] !== "" && parseFloat(tilts[r.boat]) >= 1.0) {
        warns.push("チルト跳ね・伸び警戒");
      }
      const plus = [];
      if (stAvg != null && effSt[r.boat] != null && stAvg - effSt[r.boat] >= 0.03) {
        plus.push("スリット先行候補");
      }

      // 中立の補足情報（決まり手の関係性分析などで使用）
      const infos = [];

      // 2連対率・3連対率の評価（1着率だけで切らない）
      if (r.racerR3final != null && r3Avg != null) {
        const v3 = r.racerR3final.toFixed(1);
        const lo1 = r.racerR1final != null && r1Avg != null && r.racerR1final <= r1Avg - 1;
        const hi1 = r.racerR1final != null && r1Avg != null && r.racerR1final >= r1Avg + 1;
        const hi3 = r.racerR3final >= r3Avg + 3;
        const lo3 = r.racerR3final <= r3Avg - 5;
        if (lo1 && hi3) {
          if (crit.time === true) {
            plus.push(`1着率は低めだが3連対率${v3}%＋タイム良で2・3着残し有力`);
          } else {
            infos.push(`1着率低めも3連対率${v3}%で3着残しの目`);
          }
        } else if (hi1 && lo3) {
          infos.push(`1着率上位だが3連対率${v3}%は平凡、買うなら頭`);
        } else if (lo3 && crit.time === false) {
          infos.push(`3連対率${v3}%と低調で軽視も`);
        }
      }
      if (r.racerR2final != null && r2Avg != null && r.racerR2final >= r2Avg + 3 && crit.time === true) {
        plus.push(`2連対率${r.racerR2final.toFixed(1)}%上位で相手筆頭級`);
      }

      // 逃げシミュレーション
      if (nigeSim && r.boat >= 2) {
        const v2 = nigeSim.second?.[r.boat - 2];
        if (v2 != null && v2 >= 30) plus.push(`逃がし2着${v2}%（1-${r.boat}本線級）`);
      }

      // 2連対率・3連対率の評価（1着率だけでなく連対面も見る）
      if (r3Avg != null && r.racerR3final != null) {
        const r1d = r1Avg != null && r.racerR1final != null ? r.racerR1final - r1Avg : null;
        const r2d = r2Avg != null && r.racerR2final != null ? r.racerR2final - r2Avg : null;
        const r3d = r.racerR3final - r3Avg;
        if (r1d != null && r1d <= -2 && r3d >= 2) {
          if (crit.time === true) {
            plus.push("1着率は低いが3連対率上位＋タイム良で2・3着残し有力");
          } else {
            infos.push("1着率低めでも3連対率は上位、2・3着の紐で一考");
          }
        }
        if (r2d != null && r2d >= 3 && (r1d == null || r1d < 2)) {
          plus.push("2連対率上位で2着軸候補");
        }
        if (r1d != null && r1d >= 3 && r3d <= -2) {
          infos.push("1着率高め・3連対率低めの勝つか飛ぶかタイプ");
        }
        if (r3d <= -5) {
          warns.push("3連対率低く紐でも過信禁物");
        }
      }

      // 同マーク内の並び用スコア（場平均は参考程度の重みのみ）
      // ST反映強化: 平均STとの差を連続的にスコアへ。速い(小さい)ほど加点、遅いほど減点。
      //   F持ちは平均並み扱い（リスクは別途warnで表現）。係数はモーター等とバランスを取った値。
      const stDiff = (stAvg != null && effSt[r.boat] != null && !fHold[r.boat])
        ? (stAvg - effSt[r.boat]) : 0; // 正=平均より速い
      const stScore = Math.max(-4, Math.min(4, stDiff * 80)); // 0.05差で±4程度に収まるよう調整

      // 各要素のスコア寄与（重みバー表示用）。プラス＝評価を押し上げた要素。
      const cRacer = (r.racerR1final != null && r1Avg != null ? (r.racerR1final - r1Avg) * 0.3 : 0);
      const cDiff = r.diff * 5;
      const cMotor = (m && m.ren2 != null && motorAvg != null ? (m.ren2 - motorAvg) * 0.1 : 0);
      const cWind = r.windAdj * 0.5;
      const cBase = r.final1 * 0.05;
      const cGoods = goods * 10;
      const breakdown = {
        成績: cRacer,   // 枠別成績（本人1着率）
        展示: cDiff,    // 展示・周り足タイム差
        モーター: cMotor,
        風: cWind,
        ST: stScore,
        枠基準: cBase,  // 基本場平均＋展示補正ベース（風は含めない）
        総合印: cGoods, // 4項目チェック（枠/展/機/風）の合計
      };
      const score = cGoods + cRacer + cDiff + cMotor + cWind + cBase + stScore;

      return { ...r, crit, goods, mark, warns, plus, infos, score, stDiff, breakdown };
    });

    // 決まり手の関係性分析（1号艇の被決まり手率 × 各艇の決まり手率 × 気配）
    const km = kimari ? kimari[kimariPeriod] : null;
    if (km) {
      const b1 = evals.find((r) => r.boat === 1);
      if (b1) {
        if (km.nige != null && km.nige >= 40) b1.plus.push(`逃げ率${km.nige}%と高水準`);
        else if (km.nige != null && km.nige <= 25) b1.warns.push(`逃げ率${km.nige}%と低調`);

        const types = [
          { key: "sashi", name: "差し", def: km.sasare, defName: "差され",
            hi: [15, 15], mid: [10, 10], low: [8, 8] },
          { key: "makuri", name: "捲り", def: km.makurare, defName: "捲られ",
            hi: [20, 10], mid: [15, 8], low: [10, 6] },
          { key: "makurizashi", name: "捲り差し", def: km.makuraresashi, defName: "捲られ差",
            hi: [15, 8], mid: [10, 6], low: [8, 5] },
        ];
        for (const t of types) {
          const arr = km[t.key];
          if (!arr || t.def == null) continue;
          // 率が最大の攻め手
          let mb = 0, mv = -1;
          arr.forEach((v, i) => { if (v != null && v > mv) { mv = v; mb = i + 2; } });
          const atk = evals.find((r) => r.boat === mb);
          const atkGood = atk && (atk.crit.time === true || atk.crit.racer === true);

          if (t.def >= t.hi[0] && mv >= t.hi[1]) {
            // 例: 差され20% × 差し28% → 要警戒
            b1.warns.push(`${t.defName}${t.def}%×${mb}号艇の${t.name}${mv}%で要警戒`);
            if (atk) atk.plus.push(`${t.name}${mv}%で1号艇を脅かす`);
          } else if (t.def >= t.mid[0] && mv >= t.mid[1]) {
            b1.warns.push(`${t.defName}${t.def}%・${mb}号艇の${t.name}${mv}%に注意`);
            if (atk) atk.plus.push(`${t.name}${mv}%`);
          } else if (atkGood && mv >= t.mid[1]) {
            // 率は中位でも気配が良い攻め手は数字以上に警戒
            b1.warns.push(`${mb}号艇が気配上位で${t.name}${mv}%、数字以上に警戒`);
            if (atk) atk.plus.push(`気配良く${t.name}一撃も`);
          } else {
            // 率は低い。ただし気配の良い艇がいるなら「それでも薄いかも」を明示
            const goodAtk = evals
              .filter((r) => r.boat >= 2 && (r.crit.time === true || r.crit.racer === true))
              .sort((a, b) => b.goods - a.goods)[0];
            if (goodAtk) {
              const v = arr[goodAtk.boat - 2];
              if (v != null && t.def <= t.low[0] && v <= t.low[1]) {
                b1.infos.push(
                  `${goodAtk.boat}号艇は気配上位だが${t.name}${v}%・${t.defName}${t.def}%と低く、${t.name}決着は薄めか`
                );
              }
            }
          }
        }
      }
    }

    const ranked = [...evals].sort((a, b) => b.score - a.score);
    ranked.forEach((r, i) => { r.rankPos = i + 1; });

    // ── 項目別の配点（連続値・レース内で最小0〜最大満点に正規化）──
    //   成績/展示/モーター/ST: 20点満点、枠基準/風: 10点満点。差の大きさを点数に反映（接戦は僅差、大差は開く）。
    {
      // 指標が大きいほど良い前提。順位だけではなく「差の大きさ」を配点に反映する。
      const rankPoints = (getVal, step) => {
        const maxPts = step * 5; // step=4→20点満点, step=2→10点満点
        const arr = ranked.map((r) => ({ r, v: getVal(r) }));
        const finite = arr.filter((x) => x.v != null && Number.isFinite(x.v)).map((x) => x.v);
        const pointsOf = {};
        if (!finite.length) { arr.forEach((x) => { pointsOf[x.r.boat] = 0; }); return pointsOf; }
        const mn = Math.min(...finite), mx = Math.max(...finite);
        arr.forEach((x) => {
          if (x.v == null || !Number.isFinite(x.v)) { pointsOf[x.r.boat] = 0; return; }
          pointsOf[x.r.boat] = mx === mn ? Math.round(maxPts / 2) : Math.round(maxPts * (x.v - mn) / (mx - mn));
        });
        return pointsOf;
      };

      // 展示の指標: 自コース補正テーブルの「段階(tier)」を段階数で正規化（0〜1、枠の段階差を吸収）
      //   さらに 3〜6号艇が上位2段階に乗ったら最上位級扱い（+0.25 のゲタ）。
      //   ※連続値配点に合わせ、ゲタを+100→+0.25に調整（他艇の点数分布を潰さないため）。
      const tenjiVal = (r) => {
        if (r.tier == null || r.tierMax == null) return -Infinity;
        let v = r.tier / (r.tierMax - 1); // 0〜1
        const isOuter = r.course >= 3;
        const topTwoTier = r.tier >= r.tierMax - 2; // 上位2段階
        if (isOuter && topTwoTier) v += 0.25;       // 外枠の好タイムは展示1位級に
        return v;
      };

      const ptSeisek = rankPoints((r) => (r.racerR1final ?? -Infinity), 4); // 補正込み1着率
      const ptTenji  = rankPoints(tenjiVal, 4);                              // 展示（段階ベース）
      const ptMotor  = rankPoints((r) => (motors[r.boat]?.ren3 ?? motors[r.boat]?.ren2 ?? -Infinity), 4); // モーター3連対率優先
      const ptWaku   = rankPoints((r) => (r.final1 ?? -Infinity), 2);        // 枠基準（基本場平均＋展示補正／風なし）10点満点
      const ptSt     = rankPoints((r) => (r.stDiff ?? -Infinity), 4);        // ST（速いほど＋）20点満点
      const ptKaze   = rankPoints((r) => (r.windAdj ?? -Infinity), 2);       // 風補正

      ranked.forEach((r) => {
        const ps = {
          成績: ptSeisek[r.boat], 展示: ptTenji[r.boat], モーター: ptMotor[r.boat],
          枠基準: ptWaku[r.boat], ST: ptSt[r.boat], 風: ptKaze[r.boat],
        };
        r.points = ps;
        r.pointTotal = ps.成績 + ps.展示 + ps.モーター + ps.枠基準 + ps.ST + ps.風; // 100点満点
      });
    }

    // レース全体の判定
    const maxG = Math.max(...evals.map((r) => r.goods));
    const topN = evals.filter((r) => r.goods === maxG).length;
    let badge, badgeColor;
    if (maxG >= 3 && topN === 1) { badge = "本命"; badgeColor = "#2e9e6b"; }
    else if (maxG >= 3 && topN === 2) { badge = "やや本命"; badgeColor = "#5a9e2e"; }
    else if (maxG >= 2 && topN === 1) { badge = "やや本命"; badgeColor = "#5a9e2e"; }
    else if (maxG >= 2) { badge = "混戦"; badgeColor = "#b8893d"; }
    else { badge = "大混戦・波乱含み"; badgeColor = "#b3463f"; }

    const usedData = [
      rows.some((r) => r.racerR1final != null || r.racerR3final != null) ? `枠別成績(${racerCat})` : null,
      "展示タイム",
      motorAvg != null ? "モーター" : null,
      wind !== "無風" ? "風" : null,
      stAvg != null ? "平均ST(注意判定)" : null,
      kimari ? `決まり手(${kimariPeriod})` : null,
      nigeSim ? "逃げシミュ" : null,
      "場別コース率(参考)",
    ].filter(Boolean);

    // ── 買い目の自動生成（3連単・最大12点） ──
    const order = ranked.map((r) => r.boat);          // AI評価順の艇番
    const marks = Object.fromEntries(ranked.map((r) => [r.boat, r.mark]));

    // 予想1着率／2連対率／3連対率 ランキング（result から艇番順）
    const byRate = (key) => [...rows]
      .filter((r) => r[key] != null)
      .sort((a, b) => b[key] - a[key])
      .map((r) => r.boat);
    const rank1 = byRate("racerR1final"); // 予想1着率順
    const rank2 = byRate("racerR2final"); // 予想2連対率順
    const rank3 = byRate("racerR3final"); // 予想3連対率順
    // データ無いときは総合評価順で代替
    const r1 = rank1.length ? rank1 : order;
    const r2 = rank2.length ? rank2 : order;
    const r3 = rank3.length ? rank3 : order;

    // ◎が付いた艇（3連対率が低くても積極採用）
    const circleBoats = ranked.filter((r) => r.mark === "◎").map((r) => r.boat);

    const buildTickets = (firsts, seconds, thirds, cap) => {
      const out = [];
      for (const a of firsts) {
        for (const b of seconds) {
          if (b === a) continue;
          for (const c of thirds) {
            if (c === a || c === b) continue;
            const t = `${a}-${b}-${c}`;
            if (!out.includes(t)) out.push(t);
            if (out.length >= cap) return out;
          }
        }
      }
      return out;
    };

    // ST順（速い順）。F持ちは除外。2・3着の精度を上げるのに使う（改善C）
    const stRank = order
      .map((b) => ({ b, st: fHold[b] ? null : Number(fSts[b] ?? sts[b]) }))
      .filter((x) => Number.isFinite(x.st))
      .sort((a, b) => a.st - b.st)
      .map((x) => x.b);

    // 本線（改善B・C）: 1着率1位を1着固定（頭を1艇に集約）。
    //   2着=2連対率上位＋ST速い艇、3着=3連対率上位＋ST速い艇
    const honHead = r1[0];
    let honSecond = [...new Set([...r2.slice(0, 2), ...stRank.slice(0, 2), r3[0]])]
      .filter((b) => b && b !== honHead);
    let honThird = [...new Set([...r3.slice(0, 3), ...r2.slice(0, 2), ...stRank.slice(0, 2)])]
      .filter((b) => b && b !== honHead);
    // 相手候補が少ないと本線が極端に減るため、評価上位順で補完して最低限の点数を確保
    const honFill = order.filter((b) => b && b !== honHead);
    for (const b of honFill) { if (!honSecond.includes(b)) honSecond.push(b); }
    for (const b of honFill) { if (!honThird.includes(b)) honThird.push(b); }
    // まず本来の優先候補で組み、6点に満たなければ補完候補込みで最大6点まで広げる
    const honPref2 = [...new Set([...r2.slice(0, 2), ...stRank.slice(0, 2), r3[0]])].filter((b) => b && b !== honHead);
    const honPref3 = [...new Set([...r3.slice(0, 3), ...r2.slice(0, 2), ...stRank.slice(0, 2)])].filter((b) => b && b !== honHead);
    let honTickets = buildTickets([honHead], honPref2, honPref3, 12);
    const HON_MIN = 4, HON_TARGET = 6;
    if (honTickets.length < HON_TARGET) {
      const more = buildTickets([honHead], honSecond, honThird, Math.max(HON_TARGET, honTickets.length));
      for (const t of more) { if (!honTickets.includes(t)) honTickets.push(t); if (honTickets.length >= HON_TARGET) break; }
    }
    // それでも最低点に満たない場合（相手が極端に少ない）は全評価艇で最低4点を埋める
    if (honTickets.length < HON_MIN) {
      const all = buildTickets([honHead], honFill, honFill, HON_MIN);
      for (const t of all) { if (!honTickets.includes(t)) honTickets.push(t); if (honTickets.length >= HON_MIN) break; }
    }
    const honmei = {
      label: "本線",
      desc: "1着率1位を1着固定／2・3着＝2連・3連対率上位＋ST速い艇",
      tickets: honTickets,
    };

    // ── 展開連動: 決まり手から「1号艇を脅かす濃い攻め手艇」を抽出 ──
    //   シナリオ（展開予想）と同じ決まり手データを使い、まくり/差し/まくり差しが濃い艇を特定。
    //   これを対抗・穴の頭候補に格上げして、展開を買い目の頭構成に反映する。
    //   本線（1着率1位頭固定）の根幹は変えない。
    const scenarioHeads = []; // 展開上位の攻め手艇（濃い順）
    let nigeDominant = false;  // 逃げが濃厚か（=1号艇頭を厚く）
    if (km) {
      const arrAt2 = (arr, b) => (arr && arr[b - 2] != null ? arr[b - 2] : 0);
      // 1号艇の崩れやすさ（差され・まくられ・まくられ差の最大）
      const oneVuln = Math.max(km.sasare ?? 0, km.makurare ?? 0, km.makuraresashi ?? 0);
      nigeDominant = km.nige != null && km.nige >= 55 && oneVuln < 14;
      // 各攻め手艇のスコア = 自分の攻め率 × 1号艇の崩れやすさ係数
      const cand = [];
      for (let b = 2; b <= 6; b++) {
        const atk = Math.max(arrAt2(km.makuri, b), arrAt2(km.sashi, b), arrAt2(km.makurizashi, b));
        if (atk <= 0) continue;
        // 気配が良い攻め手は数字以上に評価
        const ev = ranked.find((r) => r.boat === b);
        const kehaiBonus = ev && (ev.crit.time === true || ev.crit.motor === true) ? 1.2 : 1.0;
        const domScore = atk * (1 + oneVuln / 100) * kehaiBonus;
        cand.push({ boat: b, atk, domScore });
      }
      cand.sort((a, b) => b.domScore - a.domScore);
      // 攻め率が一定以上 かつ 1号艇に隙がある場合のみ採用（薄い展開で頭を増やさない）
      for (const c of cand) {
        if (c.atk >= 12 && oneVuln >= 12) scenarioHeads.push(c.boat);
        else if (c.atk >= 18) scenarioHeads.push(c.boat); // 単独で強い攻め手
        if (scenarioHeads.length >= 2) break;
      }
    }

    // 対抗（改善B・C）: 1着率2位を1着に置く＝本線(1位頭)の裏。
    //   3連対率1位を軸に、2・3着はST速い艇＋上位で構成。本線と被る目は除外
    const honSet = new Set(honmei.tickets);
    const taikouTickets = [];
    const pushUnique = (t) => {
      if (!t) return;
      if (!taikouTickets.includes(t) && !honSet.has(t)) taikouTickets.push(t);
    };
    const a1 = r1[0], a2 = r1[1];      // 1着率1位・2位
    const axis = r3[0];                // 3連対率1位（軸）
    // 相手候補：3連対率上位＋ST速い艇（精度C）
    const partners2 = [...new Set([...r3.slice(0, 4), ...stRank.slice(0, 3), ...order.slice(0, 4)])].filter(Boolean);
    // ⓪ 展開連動: 濃い攻め手艇（まくり/差し濃厚）を頭にした目を優先的に入れる
    let taikouFlowNote = "";
    if (scenarioHeads.length > 0) {
      taikouFlowNote = `／展開濃厚艇${scenarioHeads.join("・")}号を頭に反映`;
      for (const h of scenarioHeads) {
        // 攻め手艇 → 1号艇 → 上位（1号艇を負かす本線の裏）
        const others = partners2.filter((b) => b !== h);
        for (const c of others) { if (c !== 1) pushUnique(`${h}-1-${c}`); if (taikouTickets.length >= 6) break; }
        // 攻め手艇 → 上位 → 1号艇
        for (const b of others) { if (b !== 1) pushUnique(`${h}-${b}-1`); if (taikouTickets.length >= 6) break; }
        if (taikouTickets.length >= 6) break;
      }
    }
    if (a2) {
      // ① 主軸：1着率2位を1着に（本線の裏）。軸(3連対率1位)を絡める
      const head = a2;
      if (axis && axis !== head) {
        for (const c of partners2) { if (c !== head && c !== axis) pushUnique(`${head}-${axis}-${c}`); if (taikouTickets.length >= 12) break; }
        for (const b of partners2) { if (b !== head && b !== axis) pushUnique(`${head}-${b}-${axis}`); if (taikouTickets.length >= 12) break; }
      }
      // ② 1着率2位頭で相手に流す
      if (taikouTickets.length < 12) {
        for (const b of partners2) {
          if (b === head) continue;
          for (const c of partners2) { if (c !== head && c !== b) pushUnique(`${head}-${b}-${c}`); if (taikouTickets.length >= 12) break; }
          if (taikouTickets.length >= 12) break;
        }
      }
    }
    // ③ 1着率1位の折り返し（本線で拾えない2着づけ）も少し補完
    if (taikouTickets.length < 12 && a1 && a2) {
      for (const c of partners2) { if (c !== a1 && c !== a2) pushUnique(`${a2}-${a1}-${c}`); if (taikouTickets.length >= 12) break; }
    }
    // ③ それでも空きがあれば上位フォーメーションで補完
    if (taikouTickets.length < 12) {
      const top4 = order.slice(0, 4);
      const more = buildTickets(top4.slice(0, 2), top4, top4, 12);
      for (const t of more) { pushUnique(t); if (taikouTickets.length >= 12) break; }
    }
    const taikou = {
      label: "対抗",
      desc: "1着率2位を1着に置く本線の裏／3連対率1位を軸＋ST反映（本線と被る目は除外）" + taikouFlowNote,
      tickets: taikouTickets,
    };

    // 穴: 「本命とは差別化された妙味艇」を必ず絡める。根拠を明確化し、薄い目は埋めない。
    //   頭 = 評価1・2位（本命軸）＋ タイム抜群の妙味艇（一発頭）
    //   妙味艇の根拠: A=展示タイム抜群 / B=モーター良 / C=人気落とし（今期↓だが他区分↑）
    let ana;
    {
      // ── 妙味艇を根拠付きで抽出 ──
      // 全体の展示タイム差の基準（上位かどうか）
      const diffVals = ranked.map((r) => r.diff).filter((d) => d != null);
      const diffSorted = [...diffVals].sort((a, b) => b - a);
      const diffTopThresh = diffSorted.length ? diffSorted[Math.min(1, diffSorted.length - 1)] : 0.1; // 上位2番手相当
      // 人気薄判定: その艇が絡む3連単の平均オッズ（高いほど人気薄）
      const meanOdds = (b) => {
        if (!odds) return null;
        const vals = Object.entries(odds)
          .filter(([k]) => k.split("-").includes(String(b)))
          .map(([, v]) => v);
        return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
      };
      const oddsMeans = ranked.map((r) => meanOdds(r.boat)).filter((v) => v != null);
      const oddsMedian = oddsMeans.length
        ? [...oddsMeans].sort((a, b) => a - b)[Math.floor(oddsMeans.length / 2)]
        : null;
      // 「人気落とし」: 選択期間(racerCat)の1着率が平均以下だが、他区分の最高1着率が選択期間＋3%以上
      const w1cur = (i) => racerStats?.win1?.[racerCat]?.[i] ?? null;
      const w1best = (i) => {
        if (!racerStats?.win1) return null;
        let best = null;
        for (const cat of Object.keys(racerStats.win1)) {
          if (cat === racerCat) continue;
          const v = racerStats.win1[cat]?.[i];
          if (v != null && (best == null || v > best)) best = v;
        }
        return best;
      };

      // 評価順位（rankPos: 1が最上位）。本命=上位2艇は「妙味」から除外（差別化のため）
      const topBoats = ranked.slice(0, 2).map((r) => r.boat);
      const merits = []; // { boat, reasons[] }
      for (const r of ranked) {
        if (topBoats.includes(r.boat)) continue; // 本命そのものは妙味にしない
        const reasons = [];
        // 根拠A: 展示タイム抜群（展示✓ かつ タイム差が上位相当）
        if (r.crit.time === true && r.diff != null && r.diff >= diffTopThresh) {
          reasons.push("展示タイム抜群");
        }
        // 根拠B: モーター良
        if (r.crit.motor === true) {
          reasons.push("モーター良");
        }
        // 根拠C: 人気落とし（選択期間↓・他区分↑）
        const i = r.boat - 1;
        const cur = w1cur(i), best = w1best(i);
        if (cur != null && best != null && r1Avg != null && cur <= r1Avg && best >= cur + 3) {
          reasons.push(`直近6ヶ月等は好成績（${best.toFixed(0)}%）も直近1年で人気落とし`);
        }
        if (reasons.length === 0) continue;
        // 人気薄フィルタ: オッズがあれば中央値以上（人気薄）を優先採用。なければ評価中位以下のみ。
        const mo = meanOdds(r.boat);
        const isUnpopular = oddsMedian != null
          ? (mo == null || mo >= oddsMedian)
          : r.rankPos >= 3; // オッズ無いときは評価3位以下を人気薄扱い
        if (!isUnpopular) continue;
        merits.push({ boat: r.boat, reasons, mo: mo ?? 0 });
      }
      // 妙味艇は人気薄（オッズ高い）順に並べる
      merits.sort((a, b) => b.mo - a.mo);
      const meritBoats = merits.map((m) => m.boat);

      // ── 頭の決定 ──
      // 本命軸（評価1・2位）＋ タイム抜群の妙味艇（一発頭）＋ 展開濃厚な攻め手艇
      const heads = [];
      for (const b of ranked.slice(0, 2).map((r) => r.boat)) if (!heads.includes(b)) heads.push(b);
      for (const m of merits) {
        if (m.reasons.includes("展示タイム抜群") && !heads.includes(m.boat)) heads.push(m.boat);
      }
      // 展開連動: まくり/差しが濃厚な攻め手艇を穴の頭に追加（荒れの主役を頭で押さえる）
      for (const h of scenarioHeads) if (!heads.includes(h)) heads.push(h);
      if (heads.length === 0) heads.push(order[0]);

      // ── 買い目組成: 各頭に妙味艇を必ず2着or3着で絡める。根拠ある目だけ。 ──
      const tickets = [];
      const cap = 12;
      const pushU = (t) => { if (t && !tickets.includes(t)) tickets.push(t); };

      if (meritBoats.length > 0) {
        // 相手（2・3着の埋め）は評価上位＋妙味艇
        const fillers = [...new Set([...order.slice(0, 3), ...meritBoats])];
        // (1) まず「頭→妙味艇→上位相手」「頭→上位相手→妙味艇」を根拠の濃い順に
        for (const m of meritBoats) {
          for (const head of heads) {
            if (m === head) {
              // 妙味艇が頭の場合は、相手に上位艇＋他妙味艇
              const others = fillers.filter((b) => b !== head);
              for (const a of others) for (const c of others) {
                if (a !== c) { pushU(`${head}-${a}-${c}`); if (tickets.length >= cap) break; }
              }
            } else {
              const others = fillers.filter((b) => b !== head && b !== m);
              for (const c of others) { pushU(`${head}-${m}-${c}`); if (tickets.length >= cap) break; } // 妙味艇2着
              for (const b of others) { pushU(`${head}-${b}-${m}`); if (tickets.length >= cap) break; } // 妙味艇3着
            }
            if (tickets.length >= cap) break;
          }
          if (tickets.length >= cap) break;
        }
      } else {
        // 妙味艇なし → 中穴（評価2・3位頭で軽め4点まで）
        for (const head of ranked.slice(1, 3).map((r) => r.boat)) {
          if (!head) continue;
          const partners = order.filter((b) => b !== head).slice(0, 3);
          for (const t of buildTickets([head], partners, partners, 4)) { pushU(t); if (tickets.length >= 4) break; }
          if (tickets.length >= 4) break;
        }
      }

      const headStr = heads.slice(0, 3).join("・");
      const meritStr = merits.slice(0, 2).map((m) => `${m.boat}号艇(${m.reasons[0]})`).join("、");
      const anaFlowNote = scenarioHeads.length ? `／展開濃厚艇${scenarioHeads.join("・")}号を頭に追加` : "";
      ana = {
        label: "穴",
        desc: (meritBoats.length
          ? `頭${headStr}に妙味艇を絡めた穴／妙味の根拠: ${meritStr}`
          : `妙味艇が見当たらず、評価2・3位頭の中穴（軽め）`) + anaFlowNote,
        tickets,
      };
    }

    // 合成オッズ（オッズ貼り付け時）= 1 ÷ Σ(1/各点オッズ)
    const compOdds = (tickets) => {
      if (!odds) return null;
      const vals = tickets.map((t) => odds[t]).filter((o) => o != null && o > 0);
      if (vals.length === 0) return null;
      const inv = vals.reduce((a, o) => a + 1 / o, 0);
      return { odds: 1 / inv, covered: vals.length, total: tickets.length };
    };

    // 超穴: 本線〜穴の買い目の中から、合成オッズ10倍超 かつ 当たりそうな組み合わせを12点以内
    //   当たりそう = AI評価順位の合計が小さい順（上位艇で構成される目を優先）
    const rankPos = Object.fromEntries(order.map((b, i) => [b, i])); // 0が最上位
    const allTickets = [...new Set([...honmei.tickets, ...taikou.tickets, ...ana.tickets])];
    const likeliness = (t) => t.split("-").reduce((a, b) => a + (rankPos[Number(b)] ?? 9), 0);
    // オッズがある時だけ「当たりそう順」に並べ、合成10倍超を維持できる範囲で詰める
    let choBet;
    if (odds) {
      const withOdds = allTickets.filter((t) => odds[t] > 0).sort((a, b) => likeliness(a) - likeliness(b));
      // 当たりそうな順に足していき、合成が10倍を切らない範囲で最大12点
      const picked = [];
      for (const t of withOdds) {
        const trial = [...picked, t];
        const c = compOdds(trial);
        if (trial.length <= 12 && c && c.odds > 10) picked.push(t);
        if (picked.length >= 12) break;
      }
      if (picked.length >= 1) {
        choBet = {
          label: "超穴",
          desc: "合成10倍超を狙える買い目（当たりそうな順に最大12点）",
          tickets: picked,
        };
      } else {
        // 合成10倍超の組がない → 1点勝負（最大3点）。当たりそう＋高配当の単発
        const single = withOdds
          .filter((t) => odds[t] > 10)
          .sort((a, b) => likeliness(a) - likeliness(b))
          .slice(0, 3);
        choBet = {
          label: "超穴",
          desc: single.length ? "合成10倍超の組がないため1点勝負（最大3点）" : "該当なし",
          tickets: single,
        };
      }
    } else {
      // オッズ未入力時は配当不明 → 評価上位3艇で当たりそうな高配当狙いの目を最大3点
      const cand = allTickets.sort((a, b) => likeliness(a) - likeliness(b)).slice(0, 3);
      choBet = {
        label: "超穴",
        desc: "オッズ未取得のため目安（オッズが自動取得されると合成10倍超で精選）",
        tickets: cand,
      };
    }

    [honmei, taikou, ana].forEach((b) => { b.comp = compOdds(b.tickets); });

    const bets = [honmei, taikou, ana];

    // ── スコア→確率→期待値 ──
    //   1着確率: コース別の場平均1着率(final1)を土台(prior)に、当日評価スコアで補正して正規化。
    //   3連単確率: Harville式 P(a-b-c)=pa×pb/(1-pa)×pc/(1-pa-pb)（一次近似）。
    //   期待値 EV = 推定確率×オッズ。EV>1 は「市場より割安（妙味）」の目安。
    const meanScore = ranked.reduce((a, r) => a + (r.score || 0), 0) / Math.max(1, ranked.length);
    const winProb = {};
    {
      let zSum = 0;
      for (const r of ranked) {
        const baseP = Math.max(1, r.final1 ?? r.baseRate ?? 10);
        const w = baseP * Math.exp(0.08 * ((r.score || 0) - meanScore));
        winProb[r.boat] = w; zSum += w;
      }
      for (const b of Object.keys(winProb)) winProb[b] = zSum > 0 ? winProb[b] / zSum : 0;
    }
    const probMap = {};
    const boatsAll = ranked.map((r) => r.boat);
    for (const pa1 of boatsAll) for (const pb2 of boatsAll) for (const pc3 of boatsAll) {
      if (pa1 === pb2 || pa1 === pc3 || pb2 === pc3) continue;
      const pa = winProb[pa1], pb = winProb[pb2], pc = winProb[pc3];
      const d1 = 1 - pa, d2 = 1 - pa - pb;
      if (d1 <= 0 || d2 <= 0) continue;
      const p = pa * (pb / d1) * (pc / d2);
      if (Number.isFinite(p) && p > 0) probMap[`${pa1}-${pb2}-${pc3}`] = p;
    }
    let evList = [];
    if (odds) {
      const seenEv = new Set();
      for (const bset of bets) {
        for (const t of bset.tickets) {
          if (seenEv.has(t)) continue;
          seenEv.add(t);
          const o = odds[t];
          const p = probMap[t];
          if (o > 0 && p != null) evList.push({ t, from: bset.label, p, o, ev: p * o });
        }
      }
      evList.sort((x, y) => y.ev - x.ev);
    }

    // ── 段階的フィルター＋決まり手シナリオ ──
    // 気配順位(order)を土台に、ST→モーター→F持ち→風で頭を1〜2艇に確定
    const stOf = (b) => { const v = fHold[b] ? null : Number(fSts[b] ?? sts[b]); return Number.isFinite(v) ? v : null; };
    const headScore = (b) => {
      const rk = ranked.find((r) => r.boat === b);
      let s = (6 - order.indexOf(b)); // 気配上位ほど高い
      const st = stOf(b); if (st != null) s += (0.20 - st) * 8; // STが速いほど加点
      if (rk?.crit?.motor === true) s += 1.2;
      if (rk?.crit?.time === true) s += 1.0;
      if (fHold[b]) s -= 2.5;        // F持ちは強気に行きにくい
      // 風補正
      if (wind.includes("追い風") && b === 1) s += 0.8;          // 追い風は逃げ有利
      if (wind.includes("向かい風") && b >= 4) s += 0.6;         // 向かい風はまくり差し有利
      return s;
    };
    const headRank = [...order].sort((a, b) => headScore(b) - headScore(a));
    const heads = headRank.slice(0, 2); // 頭1〜2艇に確定

    // 決まり手シナリオ（決まり手率データから可能性が高い2〜3個を採用）
    let scenarios = [];
    if (km) {
      const cand = [];
      // 逃げ（1号艇）
      if (km.nige != null) cand.push({ type: "逃げ", boat: 1, rate: km.nige });
      // 2〜6号艇のまくり・まくり差し・差し
      const arrAt = (arr, boat) => (arr && arr[boat - 2] != null ? arr[boat - 2] : null);
      for (let b = 2; b <= 6; b++) {
        const mk = arrAt(km.makuri, b);
        const mz = arrAt(km.makurizashi, b);
        const sa = arrAt(km.sashi, b);
        if (mk != null && mk > 0) cand.push({ type: "まくり", boat: b, rate: mk });
        if (mz != null && mz > 0) cand.push({ type: "まくり差し", boat: b, rate: mz });
        if (sa != null && sa > 0) cand.push({ type: "差し", boat: b, rate: sa });
      }
      // 気配で重み付け（気配上位の決まり手ほど現実味）→ rate × 気配係数
      const weighted = cand.map((c) => {
        const pos = order.indexOf(c.boat);
        const kehai = pos >= 0 ? (1 + (6 - pos) * 0.06) : 1;
        return { ...c, score: c.rate * kehai };
      }).sort((a, b) => b.score - a.score);

      // 上位2〜3シナリオ（rateが一定以上のもの優先、最低2つ）
      const picked = weighted.filter((c) => c.rate >= 10).slice(0, 3);
      const top = picked.length >= 2 ? picked : weighted.slice(0, 2);

      scenarios = top.map((c) => {
        const head = c.boat;
        // 相手：気配上位＋（1号艇は軸として絡める）
        const partners = order.filter((b) => b !== head);
        let tickets = [];
        if (c.type === "逃げ") {
          // 1-相手-相手（気配上位で流す）
          const s2 = partners.slice(0, 3), s3 = partners.slice(0, 4);
          tickets = buildTicketsPure([1], s2, s3, 8);
        } else {
          // 外の決まり手：頭-（1号艇/気配上位）-（気配上位）
          const inner = [1, ...partners.filter((b) => b !== 1)].filter(Boolean);
          const s2 = inner.slice(0, 3), s3 = inner.slice(0, 4);
          tickets = buildTicketsPure([head], s2, s3, 8);
        }
        const label = c.type === "逃げ" ? `逃げ（1号艇）`
          : `${c.type}（${head}号艇）`;
        return {
          type: c.type, boat: head, rate: c.rate,
          label,
          desc: c.type === "逃げ"
            ? `1号艇の逃げ率${c.rate}%。1号艇先マイから気配上位へ`
            : `${head}号艇の${c.type}率${c.rate}%。外から${c.type}が決まる展開`,
          tickets,
        };
      });
    }

    const flow = { heads, headRank, scenarios };

    // ── 推奨点数（荒れ度＋決まり手で算出） ──
    //   競艇は1号艇信頼度が高く「絞り」が効く競技。荒れ度バッジを基準に、
    //   決まり手（逃げ率・差され/まくられ率）で本命寄り/荒れ寄りに微調整する。
    let recommend;
    {
      // 基準: バッジで本命度を点数化（堅いほど少点数で勝負）
      const baseByBadge = {
        "本命": { total: 5, lean: "honmei" },
        "やや本命": { total: 7, lean: "honmei" },
        "混戦": { total: 10, lean: "mid" },
        "大混戦・波乱含み": { total: 14, lean: "ana" },
      };
      const base = baseByBadge[badge] || { total: 10, lean: "mid" };
      let total = base.total;
      let lean = base.lean;
      const notes = [];

      if (km) {
        // 逃げ率が高い → 1号艇頭が堅い → 点数を絞る・本命寄り
        if (km.nige != null) {
          if (km.nige >= 55) { total -= 2; lean = lean === "ana" ? "mid" : "honmei"; notes.push(`逃げ率${km.nige}%と高く堅め`); }
          else if (km.nige <= 30) { total += 2; if (lean === "honmei") lean = "mid"; notes.push(`逃げ率${km.nige}%と低く波乱含み`); }
        }
        // 差され・まくられ率が高い → 1号艇が飛ぶ → 荒れ寄り・点数増
        const threat = Math.max(km.sasare ?? 0, km.makurare ?? 0, km.makuraresashi ?? 0);
        if (threat >= 20) { total += 2; lean = "ana"; notes.push(`1号艇が崩れる決まり手が${threat}%と高く荒れ警戒`); }
        else if (threat >= 14) { total += 1; if (lean === "honmei") lean = "mid"; notes.push(`1号艇を脅かす決まり手あり`); }
      }

      // 点数は3〜18点に収める
      total = Math.max(3, Math.min(18, total));

      // 配分の目安（本線・対抗・穴・超穴）
      let dist;
      if (lean === "honmei") dist = { 本線: 0.5, 対抗: 0.3, 穴: 0.2, 超穴: 0 };
      else if (lean === "ana") dist = { 本線: 0.2, 対抗: 0.25, 穴: 0.3, 超穴: 0.25 };
      else dist = { 本線: 0.35, 対抗: 0.3, 穴: 0.25, 超穴: 0.1 };
      const alloc = {};
      for (const k of ["本線", "対抗", "穴", "超穴"]) alloc[k] = Math.round(total * dist[k]);

      const leanLabel = lean === "honmei" ? "本命寄り（手堅く絞る）" : lean === "ana" ? "荒れ寄り（穴を厚く）" : "バランス";
      recommend = { total, lean, leanLabel, alloc, notes };
    }

    // ── 自信度メーター ──
    //   データの揃い具合（多いほど自信↑）×評価の分離度（1・2位が突出していれば自信↑）で算出。
    //   荒れ度が高い（混戦）ほど自信は下がる。見送り判断の目安に。
    let confidence;
    {
      // 1）データ充足度（最大40点）: 使っている入力が多いほど高い
      let dataPts = 0;
      const hasRacer = rows.some((r) => r.racerR1final != null || r.racerR3final != null);
      if (hasRacer) dataPts += 14;          // 選手成績
      dataPts += 8;                         // 展示・1周・回り足（合算対象）＋直線（参考指標）
      if (motorAvg != null) dataPts += 6;   // モーター
      if (kimari) dataPts += 6;             // 決まり手
      if (Number(payoutOddsInput) > 0) dataPts += 6;  // オッズ
      dataPts = Math.min(40, dataPts);

      // 2）評価の分離度（最大40点）: 1位と2位、2位と3位のスコア差が大きいほど自信↑
      const sc = ranked.map((r) => r.score);
      const gap12 = sc.length >= 2 ? sc[0] - sc[1] : 0;
      const gap23 = sc.length >= 3 ? sc[1] - sc[2] : 0;
      const sepPts = Math.min(40, Math.max(0, gap12 * 2.5 + gap23 * 1.2));

      // 3）荒れ度ペナルティ（最大-20点）
      const badgePenalty = { "本命": 0, "やや本命": -4, "混戦": -12, "大混戦・波乱含み": -20 };
      const penalty = badgePenalty[badge] ?? -8;

      // 合計（20スタート＋充足＋分離＋ペナルティ）を0〜100に丸め
      let total = Math.round(20 + dataPts + sepPts + penalty);
      total = Math.max(5, Math.min(100, total));

      let level, color, advice;
      if (total >= 70) { level = "高"; color = "#5dd39e"; advice = "評価が明確で勝負しやすいレース"; }
      else if (total >= 45) { level = "中"; color = "#e0b07a"; advice = "標準的。買い目を絞るのが無難"; }
      else { level = "低"; color = "#e08a8a"; advice = "読みづらい。少点数か見送りも検討"; }

      const reasons = [];
      if (dataPts < 25) reasons.push("入力データが少なめ");
      if (sepPts < 12) reasons.push("上位艇の評価が拮抗");
      if (penalty <= -12) reasons.push("荒れ度が高い");
      if (reasons.length === 0) reasons.push("データが揃い評価も明確");

      confidence = { total, level, color, advice, reasons };
    }

    return { ranked, badge, badgeColor, usedData, bets, flow, recommend, confidence, winProb, probMap, evList };
  };

  // メイン評価（選択中の区分）
  const aiEval = useMemo(
    () => (result ? evaluateRows(result.rows) : null),
    [result, sts, fHold, fSts, motors, tilts, wind, racerCat, kimari, kimariPeriod, nigeSim, odds]
  );

  // ── 予想＋買い目を保存 ──
  const saveRecord = async () => {
    if (!aiEval) { setSaveMsg("先に展示タイムなどを入力して評価を出してください"); return; }
    if (!venue) { setSaveMsg("開催場を選択してください"); return; }
    const key = `${raceDate}_${venue}_${raceNo}R`;
    const rec = {
      key, date: raceDate, venue, race: raceNo,
      ranked: aiEval.ranked.map((r) => ({ boat: r.boat, mark: r.mark })),
      bets: aiEval.bets.map((b) => ({ label: b.label, tickets: b.tickets })),
      result: null, // 結果は後から入力
      savedAt: Date.now(),
    };
    await persistRecords((prev) => [rec, ...prev.filter((r) => r.key !== key)]);
    setSaveMsg(`✓ ${key} を保存しました`);
  };

  // ── 結果出目を保存レコードに反映 ──
  const saveResult = async () => {
    const { first, second, third } = resultDigits;
    if (![first, second, third].every((x) => /^[1-6]$/.test(x))) {
      setSaveMsg("結果は1〜6で1着・2着・3着すべて入力してください"); return;
    }
    if (new Set([first, second, third]).size !== 3) {
      setSaveMsg("結果の艇番が重複しています"); return;
    }
    const key = `${raceDate}_${venue}_${raceNo}R`;
    const trio = `${first}-${second}-${third}`;
    const odds = Number(payoutOddsInput) || null;
    const curBets = aiEval ? aiEval.bets.map((b) => {
      let tk = b.tickets;
      if (cmpMode === "overlap" && periodCompare) {
        if (b.label === "本線") tk = b.tickets.filter((t) => periodCompare.honmei.overlap.includes(t));
        if (b.label === "対抗") tk = b.tickets.filter((t) => periodCompare.taikou.overlap.includes(t));
        if (b.label === "穴") tk = b.tickets.filter((t) => periodCompare.ana.overlap.includes(t));
      }
      return { label: b.label, tickets: tk };
    }) : [];
    const curRanked = aiEval ? aiEval.ranked.map((r) => ({ boat: r.boat, mark: r.mark })) : [];

    await persistRecords((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx >= 0) {
        const copy = [...prev];
        const p = copy[idx];
        copy[idx] = {
          ...p, result: trio, payoutOdds: odds,
          bets: (p.bets && p.bets.length) ? p.bets : curBets,
          ranked: (p.ranked && p.ranked.length) ? p.ranked : curRanked,
          betLimits: { ...betLimits },
        };
        return copy;
      }
      return [{ key, date: raceDate, venue, race: raceNo, ranked: curRanked, bets: curBets, result: trio, payoutOdds: odds, betLimits: { ...betLimits }, savedAt: Date.now() }, ...prev];
    });

    // 同じ日付・場・レースの「自分の舟券記録」にも結果・配当を反映
    const sameRace = (b) => b.date === raceDate && b.venue === (venue || "—") && b.race === raceNo;
    await persistBets((prev) => prev.some(sameRace)
      ? prev.map((b) => {
          if (!sameRace(b)) return b;
          const hit = b.tickets.includes(trio);
          const hitAmt = hit ? (b.perTicket ? (b.perTicket[trio] || 0) : (b.amountPerPoint || 0)) : 0;
          const payout = hit && odds > 0 ? Math.round((hitAmt / 100) * odds) : 0;
          return { ...b, result: trio, hit, payoutOdds: odds || null, payout };
        })
      : prev);

    setSaveMsg(`✓ ${key} の結果 ${trio}${odds ? `（配当${odds}）` : ""} を保存しました`);
  };

  // ── 集計の絞り込み（期間・場）を records / betRecords に適用 ──
  const statFilter = useMemo(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const byPeriodVenue = (list, getDate, getVenue, getRaceKey) => {
      let arr = list;
      if (statVenue !== "all") arr = arr.filter((x) => getVenue(x) === statVenue);
      if (statPeriod === "month") {
        arr = arr.filter((x) => String(getDate(x) || "").slice(0, 7) === ym);
      } else if (statPeriod === "last30") {
        // レース単位で日付降順の直近30レースに含まれるものだけ残す
        const keys = [...new Set(arr.map(getRaceKey))]
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))  // 新しい順（キー先頭が日付）
          .slice(0, 30);
        const keep = new Set(keys);
        arr = arr.filter((x) => keep.has(getRaceKey(x)));
      }
      return arr;
    };
    const recs = byPeriodVenue(
      records,
      (r) => r.date,
      (r) => r.venue,
      (r) => `${r.date}_${r.venue}_${r.race}`,
    );
    const bets = byPeriodVenue(
      betRecords,
      (b) => b.date,
      (b) => b.venue,
      (b) => `${b.date}_${b.venue}_${b.race}`,
    );
    return { recs, bets };
  }, [records, betRecords, statPeriod, statVenue]);

  // 絞り込みで使う「場の一覧」（記録に出てくる場だけ）
  const statVenueList = useMemo(() => {
    const s = new Set();
    records.forEach((r) => r.venue && s.add(r.venue));
    betRecords.forEach((b) => b.venue && b.venue !== "—" && s.add(b.venue));
    return [...s];
  }, [records, betRecords]);

  // ── 的中率の集計（結果が入っているレコードが対象） ──
  const hitStats = useMemo(() => {
    const judged = statFilter.recs.filter((r) => r.result && r.bets && r.bets.length);
    const labels = ["本線", "対抗", "穴"];
    const per = Object.fromEntries(labels.map((l) => [l, { hit: 0, total: 0 }]));
    let comboHit = 0;
    for (const r of judged) {
      let any = false;
      for (const l of labels) {
        const bet = r.bets.find((b) => b.label === l);
        if (!bet) continue;
        per[l].total += 1;
        if (bet.tickets.includes(r.result)) { per[l].hit += 1; any = true; }
      }
      if (any) comboHit += 1;
    }
    return { judged: judged.length, per, comboHit };
  }, [statFilter]);


  // ── 見送りAI ──
  //   「買わないレースを買わない」ための判定。自信度×荒れ度×期待値から
  //   勝負 / 慎重 / 見送り推奨 を明示する。
  const miokuri = useMemo(() => {
    if (!aiEval || !aiEval.confidence) return null;
    const conf = aiEval.confidence.total;
    const bestEv = aiEval.evList && aiEval.evList.length ? aiEval.evList[0].ev : null;
    const rough = aiEval.badge === "混戦" || aiEval.badge === "大混戦・波乱含み";
    const reasons = [];
    let verdict = "慎重";
    let color = "#f9c513";
    if (conf < 45) reasons.push(`自信度${conf}と低く根拠が弱い`);
    if (rough && bestEv != null && bestEv < 0.9) reasons.push("荒れ模様なのに妙味のある目が無い");
    if (aiEval.badge === "大混戦・波乱含み" && conf < 60) reasons.push("大混戦で評価が割れている");
    if (reasons.length) {
      verdict = "見送り推奨";
      color = "#e08a8a";
    } else if (conf >= 70 && (bestEv == null || bestEv >= 1.0)) {
      verdict = "勝負";
      color = "#5dd39e";
      reasons.push(`自信度${conf}で評価が明確`);
      if (bestEv != null && bestEv >= 1.0) reasons.push(`期待値${bestEv.toFixed(2)}の妙味あり`);
    } else {
      if (conf < 70) reasons.push(`自信度${conf}`);
      if (bestEv != null && bestEv < 1.0) reasons.push("オッズ妙味は薄め");
      if (rough) reasons.push("荒れ模様");
      if (!reasons.length) reasons.push("決め手不足");
    }
    return { verdict, color, reasons };
  }, [aiEval]);

  // ── 展開リハーサル（スタート隊形のモンテカルロ試走） ──
  //   平均ST・進入・当日評価スコアから、スタート隊形を1000回試走して決まり手の出現分布を出す。
  const tenkaiRehearsal = useMemo(() => {
    if (!aiEval || !slit || !Array.isArray(slit) || slit.length !== 6) return null;
    let seed = 0;
    const key = `${raceDate}_${venue}_${raceNo}`;
    for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
    const mulberry32 = (a) => () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rnd = mulberry32(seed || 1);
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const byCourse = {};
    slit.forEach((e) => { byCourse[e.course] = e; });
    if (!byCourse[1]) return null;
    const scores = {};
    aiEval.ranked.forEach((r) => { scores[r.boat] = r.score || 0; });
    const vals = slit.map((e) => scores[e.boat] ?? 0);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const pow = {};
    slit.forEach((e) => { pow[e.boat] = mx === mn ? 0.5 : ((scores[e.boat] ?? 0) - mn) / (mx - mn); });
    const ITERS = 1000;
    const tally = {};
    const winCount = {};
    slit.forEach((e) => { winCount[e.boat] = 0; });
    const addResult = (kind, boat) => {
      const k = `${kind}(${boat})`;
      tally[k] = (tally[k] || 0) + 1;
      winCount[boat] += 1;
    };
    for (let i = 0; i < ITERS; i++) {
      const s = {};
      slit.forEach((e) => { s[e.course] = Math.abs(e.st) + gauss() * 0.05 - (e.course >= 4 ? 0.01 : 0); });
      const c1 = byCourse[1];
      let attacker = null, attackKind = null;
      for (const c of [4, 3, 5, 6]) {
        const e = byCourse[c];
        if (!e) continue;
        const adv = s[1] - s[c];
        const th = 0.055 - 0.05 * pow[e.boat];
        if (adv > th + rnd() * 0.03) {
          attacker = e;
          attackKind = (c === 3 || c === 4) && adv < th + 0.05 && rnd() < 0.45 ? "まくり差し" : "まくり";
          break;
        }
      }
      if (attacker) { addResult(attackKind, attacker.boat); continue; }
      const c2 = byCourse[2];
      if (c2) {
        const gap = s[2] - s[1];
        const sashiP = Math.max(0, 0.30 - gap * 3) * (0.4 + 0.8 * pow[c2.boat]) * (1 - 0.5 * pow[c1.boat]);
        if (rnd() < sashiP) { addResult("差し", c2.boat); continue; }
      }
      if (rnd() < 0.04) {
        const cand = slit.filter((e) => e.course >= 3).sort((a, b) => pow[b.boat] - pow[a.boat])[0];
        if (cand && rnd() < pow[cand.boat] * 0.6) { addResult("抜き", cand.boat); continue; }
      }
      addResult("逃げ", c1.boat);
    }
    const patterns = Object.entries(tally)
      .map(([k, n]) => ({ k, pct: (n / ITERS) * 100 }))
      .sort((a, b) => b.pct - a.pct);
    const winPct = slit
      .map((e) => ({ boat: e.boat, course: e.course, pct: (winCount[e.boat] / ITERS) * 100 }))
      .sort((a, b) => b.pct - a.pct);
    return { iters: ITERS, patterns, winPct };
  }, [aiEval, slit, raceDate, venue, raceNo]);

  // ── AI予想の収支（もし機械的に買っていたら・1点100円固定） ──
  const aiLedger = useMemo(() => {
    const PER = 100; // 1点100円
    const judged = statFilter.recs.filter((r) => r.result && r.payoutOdds && r.bets && r.bets.length);
    const patterns = [
      { key: "honmei", name: "本線", parts: ["本線"] },
      { key: "taikou", name: "対抗", parts: ["対抗"] },
      { key: "ana", name: "穴", parts: ["穴"] },
      { key: "h_t", name: "本線＋対抗", parts: ["本線", "対抗"] },
      { key: "h_a", name: "本線＋穴", parts: ["本線", "穴"] },
      { key: "t_a", name: "対抗＋穴", parts: ["対抗", "穴"] },
      { key: "h_t_a", name: "本線＋対抗＋穴", parts: ["本線", "対抗", "穴"] },
      { key: "all", name: "本線＋対抗＋穴", parts: ["本線", "対抗", "穴"] },
    ];
    const stats = {};
    for (const p of patterns) stats[p.key] = { name: p.name, races: 0, spent: 0, ret: 0, hit: 0 };

    for (const r of judged) {
      const odds = r.payoutOdds;
      const limits = r.betLimits || {}; // {本線:6, 対抗:4, ...} レースごとの点数設定
      for (const p of patterns) {
        // このパターンの合成買い目（各買い目は上位 limit 点まで・重複除外）
        const set = new Set();
        for (const part of p.parts) {
          const bet = r.bets.find((b) => b.label === part);
          if (!bet) continue;
          const lim = limits[part] != null ? limits[part] : bet.tickets.length; // 未設定なら全点
          for (const t of bet.tickets.slice(0, lim)) set.add(t);
        }
        if (set.size === 0) continue;
        const s = stats[p.key];
        s.races += 1;
        s.spent += set.size * PER;
        if (set.has(r.result)) {
          s.hit += 1;
          s.ret += Math.round((PER / 100) * odds);
        }
      }
    }
    return { judged: judged.length, patterns, stats };
  }, [statFilter]);

  // ── 期間比較（買い目の被り） ──
  const periodCompare = useMemo(() => {
    if (!aiEval || !result?.rows || !racerStats) return null;
    const evA = evaluateRows(rowsForCat(result.rows, cmpA));
    const evB = evaluateRows(rowsForCat(result.rows, cmpB));
    if (!evA || !evB) return null;
    const ticketsOf = (ev, label) => (ev.bets.find((b) => b.label === label)?.tickets) || [];
    const setBoth = (label) => {
      const a = ticketsOf(evA, label), b = ticketsOf(evB, label);
      const sb = new Set(b);
      return { a, b, overlap: a.filter((t) => sb.has(t)) };
    };
    const evalView = (ev) => ({
      rank: ev.ranked.map((r) => r.boat),
      mark: Object.fromEntries(ev.ranked.map((r) => [r.boat, r.mark])),
      crit: Object.fromEntries(ev.ranked.map((r) => [r.boat, r.crit])),
    });
    return {
      honmei: setBoth("本線"),
      taikou: setBoth("対抗"),
      ana: setBoth("穴"),
      evalA: evalView(evA),
      evalB: evalView(evB),
    };
  }, [aiEval, result, racerStats, cmpA, cmpB, sts, fHold, fSts, motors, tilts, wind, kimari, kimariPeriod, nigeSim, odds]);

  // ── 「買い目組む」: 選んだ対象（カード）順を尊重してラウンドロビン抽出 ──
  //   各カードの並び順（＝そのカードの狙い・軸）を保ったまま、配分方式に従って拾う。
  //   選び方(pickerMode)はカード内の並べ替えに使う。配分(pickerAlloc)はカード間の取り方を決める。
  const pickedTickets = useMemo(() => {
    if (!aiEval) return null;
    const order = aiEval.ranked.map((r) => r.boat);
    const rankPos = Object.fromEntries(order.map((b, i) => [b, i]));
    const likeli = (t) => t.split("-").reduce((a, b) => a + (rankPos[Number(b)] ?? 9), 0);

    // カード内を「選び方」で並べ替える共通関数
    const sortInCard = (tk) => {
      if (pickerMode === "hit") {
        return [...tk].sort((a, b) => likeli(a) - likeli(b));
      } else if (pickerMode === "ev") {
        const pseudoProb = (t) => 1 / (1 + likeli(t));
        const ev = (t) => {
          const o = odds && odds[t] > 0 ? odds[t] : null;
          if (o == null) return -1;
          return pseudoProb(t) * o;
        };
        return [...tk].sort((a, b) => ev(b) - ev(a));
      } else {
        const score = (t) => {
          let s = likeli(t);
          if (odds && odds[t] > 0) s -= Math.min(1.5, Math.log10(odds[t]) * 0.5);
          return s;
        };
        return [...tk].sort((a, b) => score(a) - score(b));
      }
    };

    // 選んだ対象（カード）ごとに、買い目リスト（カード本来の並び順）を取り出す
    const cards = []; // { part, tickets[] }
    let poolCount = 0;
    const seenForCount = new Set();
    for (const part of pickerParts) {
      let tk;
      if (part.startsWith("シナリオ")) {
        const idx = Number(part.replace("シナリオ", "")) - 1;
        const sc = aiEval.flow?.scenarios?.[idx];
        tk = sc ? [...sc.tickets] : [];
      } else {
        const bet = aiEval.bets.find((b) => b.label === part);
        if (!bet) continue;
        tk = [...bet.tickets];
        if (cmpMode === "overlap" && periodCompare) {
          const ovKey = part === "本線" ? "honmei" : part === "対抗" ? "taikou" : part === "穴" ? "ana" : null;
          if (ovKey) tk = tk.filter((t) => periodCompare[ovKey].overlap.includes(t));
        }
      }
      // 選び方でカード内を並べ替え（カード本来の意図＋選び方の折衷）
      tk = sortInCard(tk);
      cards.push({ part, tickets: tk });
      for (const t of tk) { if (!seenForCount.has(t)) { seenForCount.add(t); poolCount++; } }
    }
    if (poolCount === 0) return { tickets: [], comp: null, pool: 0 };

    // 配分方式に応じてカードの取り出し順を決める
    //   even = 全カードを1点ずつ交互（カード入力順）
    //   solid = 堅いカード優先（本線→対抗→穴→超穴→シナリオ）
    //   ana = 穴寄り優先（超穴→穴→対抗→本線→シナリオ）
    const solidRank = (part) => {
      const map = { "本線": 0, "対抗": 1, "穴": 2, "超穴": 3 };
      if (part in map) return map[part];
      return 5; // シナリオは後ろ
    };
    let orderedCards = cards.map((c, i) => ({ ...c, _i: i }));
    if (pickerAlloc === "solid") {
      orderedCards.sort((a, b) => solidRank(a.part) - solidRank(b.part) || a._i - b._i);
    } else if (pickerAlloc === "ana") {
      orderedCards.sort((a, b) => solidRank(b.part) - solidRank(a.part) || a._i - b._i);
    }
    // even はカード入力順のまま

    // ラウンドロビンで1点ずつ拾う。重複目はスキップして次を取る。
    const picked = [];
    const used = new Set();
    const cursors = orderedCards.map(() => 0);
    let safety = 0;
    while (picked.length < pickerCount && safety < poolCount * orderedCards.length + 10) {
      let advanced = false;
      for (let c = 0; c < orderedCards.length && picked.length < pickerCount; c++) {
        const list = orderedCards[c].tickets;
        // このカードから未使用の次の目を1点拾う
        while (cursors[c] < list.length) {
          const t = list[cursors[c]];
          cursors[c]++;
          if (!used.has(t)) { used.add(t); picked.push(t); advanced = true; break; }
        }
      }
      safety++;
      if (!advanced) break; // 全カード尽きた
    }

    // 合成オッズ
    let comp = null;
    if (odds) {
      const vals = picked.map((t) => odds[t]).filter((o) => o != null && o > 0);
      if (vals.length) {
        const inv = vals.reduce((a, o) => a + 1 / o, 0);
        comp = { odds: 1 / inv, covered: vals.length, total: picked.length };
      }
    }
    return { tickets: picked, comp, pool: poolCount };
  }, [aiEval, pickerParts, pickerCount, pickerMode, pickerAlloc, cmpMode, periodCompare, odds]);

  const deleteRecord = async (key) => {
    await persistRecords((prev) => prev.filter((r) => r.key !== key));
  };
  // 保存済みレースの点数設定を後から変更（AI収支が再計算される）
  const updateRecordLimit = async (key, label, n) => {
    await persistRecords((prev) => prev.map((r) =>
      r.key === key ? { ...r, betLimits: { ...(r.betLimits || {}), [label]: n } } : r
    ));
  };

  // 舟券を1点記録（本線/対抗/穴 または 自由入力）
  // 買い目をカートに追加（フォーメーション or 本線/対抗/穴）
  // 「買い目組む」で厳選した買い目をカートに追加
  const addPickedToCart = () => {
    if (!pickedTickets || pickedTickets.tickets.length === 0) { setBetMsg("先に対象と点数を選んでください"); return; }
    const modeStr = pickerMode === "hit" ? "堅" : pickerMode === "ev" ? "妙味" : "均";
    const label = `AI厳選${modeStr}(${pickerParts.join("＋")}・${pickedTickets.tickets.length}点)`;
    const line = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      label, tickets: pickedTickets.tickets, amountPerPoint: 100,
      perTicket: null, expanded: false,
    };
    setCart((c) => [...c, line]);
    setBetMsg(`✓ ${label} をリストに追加`);
  };

  const addToCart = () => {
    const { source, f1, f2, f3 } = betDraft;
    let tickets = [];
    let label = source;
    if (source === "自由") {
      if (!(f1.length && f2.length && f3.length)) {
        setBetMsg("1着・2着・3着の艇番をそれぞれ選んでください"); return;
      }
      for (const a of f1) for (const b of f2) for (const c of f3) {
        if (a !== b && b !== c && a !== c) {
          const t = `${a}-${b}-${c}`;
          if (!tickets.includes(t)) tickets.push(t);
        }
      }
      if (tickets.length === 0) { setBetMsg("有効な組み合わせがありません"); return; }
      label = `${f1.join("")}-${f2.join("")}-${f3.join("")}`;
    } else {
      const bet = aiEval?.bets?.find((b) => b.label === source);
      if (!bet || bet.tickets.length === 0) { setBetMsg(`${source}の買い目がありません（先に評価を出してください）`); return; }
      // 「被りだけ使う」モードなら共通買い目に絞る
      let srcTickets = bet.tickets;
      if (cmpMode === "overlap" && periodCompare) {
        const ovKey = source === "本線" ? "honmei" : source === "対抗" ? "taikou" : source === "穴" ? "ana" : null;
        if (ovKey) srcTickets = bet.tickets.filter((t) => periodCompare[ovKey].overlap.includes(t));
        if (srcTickets.length === 0) { setBetMsg(`${source}の被り買い目がありません（全部の買い目を使うに切り替えてください）`); return; }
      }
      const lim = betLimits[source] != null ? Math.min(betLimits[source], srcTickets.length) : srcTickets.length;
      tickets = srcTickets.slice(0, lim);
    }
    const line = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      label, tickets, amountPerPoint: 100,  // ベース100円（一律）
      perTicket: null,  // {ticket: 金額} 個別設定（nullなら一律）
      expanded: false,
    };
    setCart((c) => [...c, line]);
    setBetMsg(`✓ ${label}（${tickets.length}点）をリストに追加`);
    setBetDraft((p) => ({ ...p, f1: [], f2: [], f3: [] }));
  };

  const updateCartAmount = (id, val) => {
    const amt = Number(String(val).replace(/[^\d]/g, ""));
    setCart((c) => c.map((l) => (l.id === id ? { ...l, amountPerPoint: amt } : l)));
  };
  const removeFromCart = (id) => setCart((c) => c.filter((l) => l.id !== id));

  // 個別設定の開閉（開くとき perTicket を一律金額で初期化）
  const toggleExpand = (id) => setCart((c) => c.map((l) => {
    if (l.id !== id) return l;
    if (l.expanded) return { ...l, expanded: false };
    const pt = l.perTicket || Object.fromEntries(l.tickets.map((t) => [t, l.amountPerPoint || 0]));
    return { ...l, expanded: true, perTicket: pt };
  }));
  // 個別設定をやめて一律に戻す
  const resetToFlat = (id) => setCart((c) => c.map((l) => (l.id === id ? { ...l, perTicket: null, expanded: false } : l)));
  // 1点ごとの金額変更
  const setTicketAmount = (id, ticket, val) => {
    const amt = Number(String(val).replace(/[^\d]/g, ""));
    setCart((c) => c.map((l) => (l.id === id ? { ...l, perTicket: { ...l.perTicket, [ticket]: amt } } : l)));
  };
  // 1買い目の合計金額
  const lineTotal = (l) => l.perTicket
    ? l.tickets.reduce((a, t) => a + (l.perTicket[t] || 0), 0)
    : l.tickets.length * (l.amountPerPoint || 0);

  // カート合計
  const cartTotal = useMemo(() => {
    let pts = 0, amt = 0;
    for (const l of cart) { pts += l.tickets.length; amt += lineTotal(l); }
    return { pts, amt };
  }, [cart]);

  // カートをこのレースの購入として確定（結果出目・配当を反映）
  const commitCart = async () => {
    if (cart.length === 0) { setBetMsg("リストに買い目がありません"); return; }
    // 結果は上の「結果の出目（3連単）」の選択を使用
    const { first, second, third } = resultDigits;
    const res = `${first}-${second}-${third}`;
    const hasResult = /^[1-6]-[1-6]-[1-6]$/.test(res) && new Set([first, second, third]).size === 3;
    const odds = Number(payoutOddsInput);
    const recs = cart.map((l) => {
      const amount = lineTotal(l);
      const hit = hasResult && l.tickets.includes(res);
      // 的中点の購入額（個別ならその点の金額、一律なら amountPerPoint）
      const hitAmt = hit ? (l.perTicket ? (l.perTicket[res] || 0) : (l.amountPerPoint || 0)) : 0;
      const payout = hit && odds > 0 ? Math.round((hitAmt / 100) * odds) : 0;
      return {
        id: l.id, date: raceDate, venue: venue || "—", race: raceNo,
        label: l.label, points: l.tickets.length, tickets: l.tickets,
        amountPerPoint: l.perTicket ? null : l.amountPerPoint,
        perTicket: l.perTicket || null,
        amount,
        result: hasResult ? res : null,
        hit: hasResult ? hit : null,
        payoutOdds: odds > 0 ? odds : null,
        payout,
      };
    });
    await persistBets((prev) => [...recs, ...prev]);
    const totalAmt = recs.reduce((a, r) => a + r.amount, 0);
    const totalPay = recs.reduce((a, r) => a + (r.payout || 0), 0);
    setBetMsg(`✓ ${recs.length}件・${totalAmt.toLocaleString()}円を記録${hasResult ? `／払戻 ${totalPay.toLocaleString()}円` : ""}`);
    setCart([]);
  };

  const deleteBet = async (id) => {
    await persistBets((prev) => prev.filter((b) => b.id !== id));
  };

  // 収支の集計
  const betStats = useMemo(() => {
    const races = new Set();
    let spent = 0, ret = 0, hit = 0, judged = 0;
    for (const b of statFilter.bets) {
      races.add(`${b.date}_${b.venue}_${b.race}`);
      spent += b.amount;
      ret += b.payout || 0;
      if (b.result) { judged += 1; if (b.hit) hit += 1; }
    }
    return {
      raceCount: races.size,
      betCount: statFilter.bets.length,
      spent, ret,
      hitRate: judged ? (hit / judged * 100) : null,
      roi: spent ? (ret / spent * 100) : null,
      judged, hit,
    };
  }, [statFilter]);

  const fmt = (n, d = 2) => n.toFixed(d);
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  const col = (n) => (n > 0 ? "#5dd39e" : n < 0 ? "#ff8a80" : "#9db5cc");

  const venueCardRank = (st, v) => {
    const raw = String(st?.grade || st?.rank || "").toUpperCase();
    if (/SG/.test(raw)) return "SG";
    if (/G1|Ｇ1|GⅠ|ＧⅠ/.test(raw)) return "G1";
    if (/G2|Ｇ2|GⅡ|ＧⅡ/.test(raw)) return "G2";
    if (/G3|Ｇ3|GⅢ|ＧⅢ/.test(raw)) return "G3";
    return AUTO_FETCH_VENUES.includes(v) ? "一般" : "準備";
  };

  const venueCardDay = (st) => {
    const raw = String(st?.eventDay || "").trim();
    if (raw) return raw;
    if (st?.status === "発売中" || st?.nextRace) return "本日開催";
    return "";
  };

  const venueCardMark = (v, st) => {
    const r = Number(st?.nextRace || 0);
    const t = String(st?.nextDeadline || "");
    const hour = Number((t.match(/^(\d{1,2}):/) || [])[1] || 0);
    const night = NIGHT_VENUES.includes(v) || hour >= 17;
    const morning = MORNING_VENUES.includes(v) || (hour > 0 && hour < 13);
    if (night) return { text: "宵", bg: "rgba(111,92,255,0.24)", color: "#d5ccff" };
    if (morning) return { text: "朝", bg: "rgba(46,170,255,0.22)", color: "#9fdcff" };
    if (r >= 10) return { text: "終盤", bg: "rgba(255,184,77,0.22)", color: "#ffd28a" };
    return { text: "昼", bg: "rgba(93,211,158,0.18)", color: "#7ee2aa" };
  };

  const pill = (v) => (
    <span style={{
      display: "inline-block", minWidth: 44, textAlign: "center",
      padding: "5px 7px", borderRadius: 8, fontWeight: 800, fontSize: 12,
      background: v > 0 ? "rgba(46,158,107,0.22)" : v < 0 ? "rgba(217,75,67,0.22)" : "#1d3149",
      color: v > 0 ? "#5dd39e" : v < 0 ? "#ff8a80" : "#9db5cc",
    }}>{sign(v)}%</span>
  );

  const systemErrors = [
    correctionStatus && /失敗|failed|error|エラー/i.test(correctionStatus) ? `補正: ${correctionStatus}` : null,
    dbRacerStatus && /失敗|ENVなし|エラー|error/i.test(dbRacerStatus) ? dbRacerStatus : null,
    nigeStatus && /失敗|ENVなし|エラー|error/i.test(nigeStatus) ? nigeStatus : null,
    autoMsg && /エラー|不足|失敗|failed|error/i.test(autoMsg) ? autoMsg : null,
  ].filter(Boolean);
  const systemReady = !!venue && !systemErrors.length && (stTable || racerStats || kimari || nigeSim || result);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return <AuthGateScreen mode="config" authMsg={authMsg} />;
  }
  if (authLoading) {
    return <AuthGateScreen mode="loading" authMsg={authMsg} />;
  }
  if (!authUser) {
    return <AuthGateScreen mode="login" authMsg={authMsg} onLogin={startGoogleLogin} />;
  }
  if (!paidEntitlement?.ok) {
    return <AuthGateScreen mode="unpaid" user={authUser} entitlement={paidEntitlement} authMsg={authMsg} onLogout={logoutPaidUser} onRetry={() => checkPaidLogin(authSession)} onPurchase={startPurchase} />;
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#0e1b2c", color: "#e8eef5",
      fontFamily: "'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif",
      padding: "16px 12px 48px",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <header style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.25em", color: "#7da3c8", marginBottom: 4 }}>
            舟券アカデミア評価
          </div>
          <h1 style={{ fontSize: 21, fontWeight: 800, margin: 0 }}>
            場別コース率 × タイム補正
          </h1>
          <p style={{ fontSize: 12, color: "#9db5cc", margin: "6px 0 0", lineHeight: 1.6 }}>
            場ごとの基本場平均1着率を基準に、展示タイム＋1周（桐生は半周ラップ）＋まわり足の
            差（平均−合計）を内部計算に使います。風はAI評価内の風項目で1回だけ反映します。
            進入・風向きが変わる場合は各艇のコースや風プルダウンを変更してください。
          </p>
        </header>

        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
          background: "#13243a", border: "1px solid #284766", borderRadius: 12,
          padding: "9px 11px", marginBottom: 14, fontSize: 12, color: "#9db5cc",
        }}>
          <div>
            <span style={{ color: "#5dd39e", fontWeight: 900 }}>✓ 購入者確認済み</span>
            <span style={{ marginLeft: 8, wordBreak: "break-all" }}>{authUser?.email || authUser?.user_metadata?.email || ""}</span>
          </div>
          <button onClick={logoutPaidUser} style={{
            border: "1px solid #2c4762", background: "#0e1b2c", color: "#d9e8f7",
            borderRadius: 999, padding: "6px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer",
          }}>ログアウト</button>
        </div>

        {/* 初期画面：開催場一覧 */}
        <section style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 2 }}>開催場一覧</div>
              <div style={{ fontSize: 12, color: "#9db5cc" }}>開催中の場は次Rを自動選択。発売終了後は当日中のみ復習表示できます</div>
            </div>
            <button
              onClick={() => { const v = venue || "蒲郡"; selectVenueQuick(v); }}
              disabled={autoLoading}
              style={{
                padding: "8px 10px", borderRadius: 999, border: "1px solid #2c4762",
                background: "#16273c", color: "#e8eef5", fontSize: 11, fontWeight: 800,
                cursor: autoLoading ? "wait" : "pointer", whiteSpace: "nowrap",
              }}
            >
              {autoLoading ? "更新中…" : "次R更新"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {VENUE_ORDER.map((v) => {
              const selected = venue === v;
              const autoOk = AUTO_FETCH_VENUES.includes(v);
              const st = venueStatuses[v];
              const noRace = !!(st?.noRace || st?.status === "未開催");
              const allClosed = !!(st?.allClosed || st?.status === "発売終了");
              const loading = !st || venueStatusLoading;
              const cardRace = st ? displayRaceForVenueCard(v, st) : "";
              const held = !!(st && !noRace && !allClosed && cardRace);
              const heldText = loading ? "確認中" : noRace ? "開催なし" : allClosed ? "復習可" : "本日開催";
              const raceLine = noRace
                ? "未開催"
                : allClosed
                  ? "復習表示"
                  : held
                    ? `${cardRace}R / ${st.nextDeadline || "締切確認中"}`
                    : "確認中";
              const disabled = noRace;
              return (
                <button
                  key={v}
                  onClick={() => { if (!disabled) selectVenueQuick(v); }}
                  disabled={disabled}
                  title={disabled ? `${v}は本日未開催です` : `${v}を選択`}
                  style={{
                    minHeight: 104,
                    padding: 0,
                    borderRadius: 8,
                    cursor: disabled ? "not-allowed" : "pointer",
                    background: selected
                      ? "linear-gradient(180deg, #314c79 0%, #1f3552 100%)"
                      : disabled
                        ? "linear-gradient(180deg, #35383b 0%, #2d3032 100%)"
                        : allClosed
                          ? "linear-gradient(180deg, #293342 0%, #202b38 100%)"
                          : "linear-gradient(180deg, #22344f 0%, #17263b 100%)",
                    color: disabled ? "#8b9198" : "#e8eef5",
                    border: selected ? "2px solid #6c8cff" : disabled ? "1px solid #3f4245" : "1px solid #2c4762",
                    boxShadow: selected ? "0 0 0 2px rgba(108,140,255,0.18)" : "none",
                    textAlign: "left",
                    overflow: "hidden",
                    opacity: disabled ? 0.62 : 1,
                  }}
                >
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: "8px 7px", background: disabled ? "rgba(255,255,255,0.04)" : "rgba(113,143,190,0.18)",
                    borderBottom: "1px solid rgba(255,255,255,0.06)",
                  }}>
                    <span style={{ textAlign: "center", fontSize: 19, fontWeight: 900, lineHeight: 1.1 }}>{v}</span>
                  </div>
                  <div style={{ padding: "8px 7px 9px", textAlign: "center" }}>
                    <div style={{ fontSize: 12, color: disabled ? "#8b9198" : "#c4d3e6", fontWeight: 800, minHeight: 20 }}>
                      {heldText}
                    </div>
                    <div style={{
                      marginTop: 5,
                      fontSize: noRace || allClosed ? 13 : 15,
                      color: noRace ? "#9ba0a5" : allClosed ? "#ffd28a" : "#fff",
                      fontWeight: 900,
                      letterSpacing: "0.02em",
                    }}>{raceLine}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* 日付・場・レースの選択 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#7da3c8", marginBottom: 6 }}>日付</div>
          <select
            value={raceDate}
            onChange={(e) => setRaceDate(e.target.value)}
            style={{
              width: "100%", padding: "11px 12px", fontSize: 16, marginBottom: 12,
              background: "#16273c", color: "#fff",
              border: "1px solid #2c4762", borderRadius: 10,
            }}
          >
            {(() => {
              const opts = [];
              const base = new Date();
              for (let i = -3; i <= 7; i++) {
                const d = new Date(base);
                d.setDate(base.getDate() + i);
                const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                const wd = ["日","月","火","水","木","金","土"][d.getDay()];
                opts.push(<option key={val} value={val}>{`${d.getMonth() + 1}/${d.getDate()}（${wd}）`}</option>);
              }
              // 現在の値が範囲外でも選べるように
              if (!opts.some((o) => o.props.value === raceDate)) {
                opts.unshift(<option key={raceDate} value={raceDate}>{raceDate}</option>);
              }
              return opts;
            })()}
          </select>

          <div style={{ fontSize: 11, color: "#7da3c8", marginBottom: 6 }}>開催場を選択</div>
          <select
            value={venue}
            onChange={(e) => { const v = e.target.value; if (v) selectVenueQuick(v); else setVenue(""); }}
            style={{
              width: "100%", padding: "11px 12px", fontSize: 16,
              background: "#16273c", color: venue ? "#fff" : "#7da3c8",
              border: "1px solid #2c4762", borderRadius: 10,
            }}
          >
            <option value="">― 場を選んでください ―</option>
            {Object.keys(VENUES).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          <div style={{ fontSize: 11, color: "#7da3c8", margin: "12px 0 6px" }}>レース（自動で次Rを選択／手動変更も可）</div>
          <select
            value={raceNo}
            onChange={(e) => {
              const nr = e.target.value;
              manualRaceSelectUntilRef.current = Date.now() + 10 * 60 * 1000;
              setRaceNo(nr);
              setVenueNotHeld(false);
              resetRaceAutoData();
              if (salesEnded && venue) {
                setReviewMode(true);
                window.setTimeout(() => fetchOfficialYoso({ venue, raceNo: nr, raceDate: raceDate || todayDateValue(), force: true, ignoreSalesEnded: true }), 80);
              } else {
                setSalesEnded(false);
                setReviewMode(false);
                if (venue && AUTO_FETCH_VENUES.includes(venue)) {
                  setAutoMsg(`${venue}${nr}Rを手動選択しました。取得します…`);
                  window.setTimeout(() => fetchOfficialYoso({ venue, raceNo: nr, raceDate: raceDate || todayDateValue(), force: true, ignoreSalesEnded: true }), 80);
                }
              }
            }}
            disabled={venueNotHeld}
            style={{
              width: "100%", padding: "11px 12px", fontSize: 16,
              background: "#16273c", color: "#fff",
              border: "1px solid #2c4762", borderRadius: 10,
            }}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={String(n)}>{n}R</option>
            ))}
          </select>
          {venue && !venueNotHeld && (() => {
            const st = venueStatuses[venue];
            const sched = officialSchedule && officialSchedule.venue === venue && Array.isArray(officialSchedule.schedule) ? officialSchedule.schedule : [];
            const hit = sched.find((x) => String(x.race) === String(raceNo));
            const deadline = hit?.deadline || (st && String(st.nextRace) === String(raceNo) ? st.nextDeadline : "");
            return deadline ? (
              <div style={{
                marginTop: 8, padding: "9px 10px", borderRadius: 8,
                background: "rgba(61,122,184,0.16)", color: "#dcecff",
                border: "1px solid rgba(90,135,255,0.35)", fontSize: 13, fontWeight: 900,
              }}>
                締切時刻：{deadline}　<span style={{ fontSize: 11, color: "#9db5cc" }}>※公式締切時刻ベース</span>
              </div>
            ) : null;
          })()}

          {salesEnded && venue && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: 8,
              background: "rgba(217,75,67,0.18)", color: "#ffb3ad",
              border: "1px solid rgba(217,75,67,0.35)", fontSize: 12, fontWeight: 800,
            }}>
              {venue}は本日の全レース発売終了です。当日中のみ復習用データを表示できます。
            </div>
          )}
          {venueNotHeld && venue && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: 8,
              background: "rgba(125,163,200,0.14)", color: "#b8cce0",
              border: "1px solid #2c4762", fontSize: 12, fontWeight: 800,
            }}>
              {venue}は本日未開催です
            </div>
          )}

          {venue && (
            <div style={{
              fontSize: 12, fontWeight: 700, color: "#e8eef5",
              marginTop: 12, marginBottom: 6,
              paddingLeft: 8, borderLeft: "3px solid #3d7ab8",
            }}>
              基本場平均1着率
              {venue && (() => {
                const info = getVenueBaseWithCorrections(venue, raceDate, correctionCache);
                const { season, seasonal, dynamic } = info;
                return null;
              })()}
            </div>
          )}

          {venue && (
            <div style={{
              display: "flex", gap: 4, fontSize: 11,
              color: "#9db5cc", flexWrap: "wrap",
            }}>
              {getVenueBaseWithCorrections(venue, raceDate, correctionCache).base.map((r, i) => (
                <span key={i} style={{
                  background: "#16273c", borderRadius: 6, padding: "4px 8px",
                }}>
                  {i + 1}C <b style={{ color: "#fff" }}>{r}%</b>
                </span>
              ))}
            </div>
          )}

          {/* 風の選択 */}
          <div style={{ fontSize: 11, color: "#7da3c8", marginTop: 16, marginBottom: 6 }}>
            風を選択
          </div>
          <select
            value={wind}
            onChange={(e) => setWind(e.target.value)}
            style={{
              width: "100%", padding: "11px 12px", fontSize: 16,
              background: "#16273c", color: "#fff",
              border: "1px solid #2c4762", borderRadius: 10,
            }}
          >
            {Object.keys(WIND).map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>

          {/* 風による増減値は内部計算のみ。画面には直接表示しない。 */}
        </div>

        {/* コピペ欄は廃止。自動取得・DB成績・共有キャッシュで反映する。 */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 10, flexWrap: "wrap",
        }}>
          <div style={{
            padding: "9px 12px", borderRadius: 10,
            background: "#123326", color: "#7ee2aa",
            fontSize: 12, fontWeight: 700,
            border: "1px solid #1c7047",
          }}>
            ✓ 取得済
          </div>
          <button
            onClick={allClear}
            style={{
              padding: "10px 14px", borderRadius: 10, cursor: "pointer",
              background: "#3a2030", color: "#ff8a80", fontSize: 13, fontWeight: 700,
              border: "1px solid #5e2d3a", marginLeft: "auto",
            }}
          >
            🗑 オールクリア
          </button>
        </div>
        {(autoMsg || systemReady || systemErrors.length > 0) && (
          <div style={{
            margin: "-2px 0 10px", padding: "8px 10px", borderRadius: 8,
            background: systemErrors.length ? "#3a2030" : "#123326",
            color: systemErrors.length ? "#ff8a80" : "#7ee2aa",
            border: systemErrors.length ? "1px solid #5e2d3a" : "1px solid #1c7047",
            fontSize: 12, fontWeight: 700,
          }}>
            {systemErrors.length ? systemErrors.join(" ／ ") : `✓ ${venue || ""}${raceNo || ""}R 取得済`}
          </div>
        )}

        {/* 平均STの期間切替 */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 10, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "#7da3c8" }}>平均STの期間</span>
          <select
            value={stPeriod}
            onChange={(e) => {
              setStPeriod(e.target.value);
              if (stTable) applyStTable(stTable, e.target.value);
            }}
            style={{
              padding: "8px 10px", fontSize: 14, fontWeight: 700,
              background: "#16273c", color: "#fff",
              border: "1px solid #2c4762", borderRadius: 8,
            }}
          >
            {ST_PERIODS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {stTable ? (
            <span style={{ fontSize: 11, color: "#5dd39e" }}>✓ 取得済</span>
          ) : systemErrors.length ? null : (
            <span style={{ fontSize: 11, color: "#7da3c8" }}>取得待ち</span>
          )}
        </div>

        {/* 選手成績の区分切替 */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 10, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "#7da3c8" }}>選手成績の区分</span>
          <select
            value={racerCat}
            onChange={(e) => setRacerCat(e.target.value)}
            style={{
              padding: "8px 10px", fontSize: 14, fontWeight: 700,
              background: "#16273c", color: "#fff",
              border: "1px solid #2c4762", borderRadius: 8,
            }}
          >
            {RACER_CATS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {racerStats ? (
            <span style={{ fontSize: 11, color: "#5dd39e" }}>✓ 取得済</span>
          ) : systemErrors.length ? (
            <span style={{ fontSize: 11, color: "#ff8a80" }}>{systemErrors.find((x) => String(x).includes("選手成績")) || "取得エラー"}</span>
          ) : (
            <span style={{ fontSize: 11, color: "#7da3c8" }}>取得待ち</span>
          )}
        </div>

        {/* 決まり手の期間切替 */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 10, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "#7da3c8" }}>決まり手の期間</span>
          <select
            value={kimariPeriod}
            onChange={(e) => setKimariPeriod(e.target.value)}
            style={{
              padding: "8px 10px", fontSize: 14, fontWeight: 700,
              background: "#16273c", color: "#fff",
              border: "1px solid #2c4762", borderRadius: 8,
            }}
          >
            {KIMARI_PERIODS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {kimari ? (
            <span style={{ fontSize: 11, color: "#5dd39e" }}>✓ 取得済</span>
          ) : systemErrors.length ? null : (
            <span style={{ fontSize: 11, color: "#7da3c8" }}>取得待ち</span>
          )}
          {nigeSim ? (
            <span style={{ fontSize: 11, color: "#5dd39e" }}>✓ 取得済</span>
          ) : systemErrors.length ? (
            <span style={{ fontSize: 11, color: "#ff8a80" }}>{systemErrors.find((x) => String(x).includes("逃げ")) || "取得エラー"}</span>
          ) : (
            <span style={{ fontSize: 11, color: "#7da3c8" }}>取得待ち</span>
          )}
        </div>

        <div style={{ display: "grid", gap: 8, marginBottom: 24 }}>
          {[1, 2, 3, 4, 5, 6].map((b) => {
            const noOriginalDisplay = !usesDisplayCorrection(venue);
            const hasHiddenTiming = !noOriginalDisplay && ["tenji", "isshu", "mawari", "chokusen"].some((k) => String(inputs[b][k] ?? "").trim() !== "");
            return (
            <div key={b} style={{
              display: "grid", gridTemplateColumns: "44px 72px 1fr",
              gap: 8, alignItems: "center",
              background: "#16273c", borderRadius: 10, padding: "8px 10px",
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: LANE[b].bg, color: LANE[b].fg,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 800, fontSize: 17,
                border: b === 1 ? "1px solid #ccc" : "none",
              }}>{b}</div>
              {racerProfiles[b] && (
                <div style={{
                  gridColumn: "2 / -1", display: "flex", gap: 6, alignItems: "baseline",
                  flexWrap: "wrap", padding: "2px 0 4px", borderBottom: "1px solid #1d3149",
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 900, color: "#7da3c8",
                    background: "#0e1b2c", border: "1px solid #2c4762", borderRadius: 5, padding: "2px 6px",
                  }}>
                    {racerProfiles[b].grade}{racerProfiles[b].regNo ? ` / ${racerProfiles[b].regNo}` : ""}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 900, color: "#fff", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {racerProfiles[b].name}
                    {racerProfiles[b].isFemale && <span title="女子選手" style={{ color: "#ff6b8a", fontSize: 15, lineHeight: 1 }}>♥</span>}
                  </span>
                  <span style={{ fontSize: 11, color: "#9db5cc" }}>
                    {racerProfiles[b].branch}{racerProfiles[b].birthplace ? ` / ${racerProfiles[b].birthplace}` : ""}{racerProfiles[b].age ? ` / ${racerProfiles[b].age}歳` : ""}
                  </span>
                  {racerProfiles[b].fl && (
                    <span style={{ fontSize: 10, fontWeight: 900, color: "#ff8a80", background: "#3a2030", borderRadius: 5, padding: "2px 6px" }}>
                      {racerProfiles[b].fl}
                    </span>
                  )}
                </div>
              )}
              <div>
                <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 2 }}>コース</div>
                <select
                  value={courses[b]}
                  onChange={(e) => setCourse(b, e.target.value)}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    background: "#0e1b2c",
                    color: courses[b] !== b ? "#f9c513" : "#fff",
                    border: "1px solid #2c4762", borderRadius: 6,
                    padding: "7px 4px", fontSize: 15, fontWeight: 700,
                  }}
                >
                  {[1, 2, 3, 4, 5, 6].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div style={{ alignSelf: "stretch", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 4 }}>{noOriginalDisplay ? "展示補正" : "展示データ"}</div>
                <div style={{
                  display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 6,
                  padding: "6px 10px", borderRadius: 999,
                  background: noOriginalDisplay ? "#233044" : hasHiddenTiming ? "#143125" : "#2a2230",
                  color: noOriginalDisplay ? "#9db5cc" : hasHiddenTiming ? "#5dd39e" : "#d3a9cf",
                  border: noOriginalDisplay ? "1px solid #344b68" : hasHiddenTiming ? "1px solid #245740" : "1px solid #5b4257",
                  fontSize: 12, fontWeight: 700,
                }}>
                  {noOriginalDisplay ? "なし" : hasHiddenTiming ? "✓ 取得済" : "未取得"}
                </div>
                <div style={{ fontSize: 10, color: "#5e7a92", marginTop: 4, lineHeight: 1.4 }}>
                  {noOriginalDisplay ? "江戸川はオリジナル展示なし。内部補正にも使いません" : "展示・1周・回り足・直線は内部計算のみに使用"}
                </div>
              </div>

              {/* ST・F持ち・チルト（カード2段目） */}
              <div style={{
                gridColumn: "1 / -1", display: "flex", gap: 8,
                alignItems: "flex-end", flexWrap: "wrap",
                borderTop: "1px solid #1d3149", paddingTop: 8, marginTop: 2,
              }}>
                <div style={{ minWidth: 72 }}>
                  <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 2 }}>チルト</div>
                  <select
                    value={tilts[b]}
                    onChange={(e) => setTilt(b, e.target.value)}
                    style={{
                      width: "100%", background: "#0e1b2c",
                      color: tilts[b] === "" ? "#7da3c8"
                        : parseFloat(tilts[b]) >= 1.0 ? "#f9c513" : "#fff",
                      border: parseFloat(tilts[b]) >= 1.0 ? "1px solid #6b5a1d" : "1px solid #2c4762",
                      borderRadius: 6, padding: "7px 6px", fontSize: 14, fontWeight: 700,
                    }}
                  >
                    <option value="">―</option>
                    {TILT_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                {tilts[b] !== "" && parseFloat(tilts[b]) >= 1.0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: "4px 7px",
                    borderRadius: 5, background: "#6b5a1d", color: "#f9c513",
                    marginBottom: 6, whiteSpace: "nowrap",
                  }}>⚡伸び警戒</span>
                )}

                <div style={{ minWidth: 112 }}>
                  <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 2 }}>
                    平均ST{stMeta?.[b - 1]?.source === "course" ? `（${stMeta[b - 1].course}C）` : stMeta?.[b - 1]?.source === "all" ? "（全C）" : ""}
                  </div>
                  <select
                    value={sts[b]}
                    onChange={(e) => setSt(b, e.target.value)}
                    style={{
                      width: "100%", background: "#0e1b2c", color: sts[b] === "" ? "#7da3c8" : "#fff",
                      border: "1px solid #2c4762", borderRadius: 6,
                      padding: "7px 6px", fontSize: 14,
                    }}
                  >
                    <option value="">―</option>
                    {ST_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  {stMeta?.[b - 1] && stMeta[b - 1].source !== "none" && (
                    <div style={{ fontSize: 9, color: "#7da3c8", marginTop: 3, lineHeight: 1.35 }}>
                      {stMeta[b - 1].source === "course"
                        ? `${stMeta[b - 1].course}C平均 n=${stMeta[b - 1].nCourse}`
                        : `全C平均 n=${stMeta[b - 1].nAll}（${stMeta[b - 1].course}C n=${stMeta[b - 1].nCourse}不足）`}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => toggleF(b)}
                  style={{
                    padding: "8px 12px", fontSize: 13, fontWeight: 700,
                    borderRadius: 6, cursor: "pointer",
                    background: fHold[b] ? "#b3463f" : "#0e1b2c",
                    color: fHold[b] ? "#fff" : "#7da3c8",
                    border: fHold[b] ? "1px solid #d96b63" : "1px solid #2c4762",
                  }}
                >
                  F持ち{fHold[b] ? "✓" : ""}
                </button>

                {fHold[b] && (
                  <div style={{ minWidth: 110 }}>
                    <div style={{ fontSize: 10, color: "#d96b63", marginBottom: 2 }}>F持ち時の平均ST</div>
                    <select
                      value={fSts[b]}
                      onChange={(e) => setFSt(b, e.target.value)}
                      style={{
                        width: "100%", background: "#0e1b2c",
                        color: fSts[b] === "" ? "#f9c513" : "#fff",
                        border: "1px solid #6b3530", borderRadius: 6,
                        padding: "7px 6px", fontSize: 14,
                      }}
                    >
                      <option value="">－</option>
                      {ST_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ minWidth: 72 }}>
                  <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 2 }}>体重(kg)</div>
                  <input
                    type="number" inputMode="decimal" step="0.1"
                    value={weights[b]}
                    onChange={(e) => setWeight(b, e.target.value)}
                    placeholder="―"
                    style={{
                      width: "100%", boxSizing: "border-box",
                      background: "#0e1b2c", color: "#fff",
                      border: "1px solid #2c4762", borderRadius: 6,
                      padding: "7px 8px", fontSize: 14,
                    }}
                  />
                </div>
              </div>

              {/* モーター情報（カード3段目） */}
              {motors[b] && (
                <div style={{
                  gridColumn: "1 / -1", display: "flex", gap: 6,
                  flexWrap: "wrap", alignItems: "center",
                  borderTop: "1px solid #1d3149", paddingTop: 7, marginTop: 2,
                  fontSize: 11, color: "#9db5cc",
                }}>
                  <span style={{
                    background: "#0e1b2c", borderRadius: 5, padding: "3px 7px",
                    fontWeight: 800, color: "#7da3c8",
                  }}>
                    モーター{motors[b].no != null ? ` ${motors[b].no}号機` : ""}
                  </span>
                  {motors[b].rate != null && (
                    <span>勝率 <b style={{ color: "#fff" }}>{motors[b].rate.toFixed(2)}</b></span>
                  )}
                  {motors[b].win1 != null && (
                    <span>1着 <b style={{ color: "#fff" }}>{motors[b].win1}%</b></span>
                  )}
                  {motors[b].ren2 != null && (
                    <span>2連 <b style={{ color: "#fff" }}>{motors[b].ren2}%</b></span>
                  )}
                  {motors[b].ren3 != null && (
                    <span>3連 <b style={{ color: motors[b].ren3 >= 50 ? "#5dd39e" : "#fff" }}>{motors[b].ren3}%</b></span>
                  )}
                </div>
              )}

              {/* 選手成績（カード4段目） */}
              {racerStats && (racerStats.win1?.[racerCat]?.[b - 1] != null
                || racerStats.ren2?.[racerCat]?.[b - 1] != null
                || racerStats.ren3?.[racerCat]?.[b - 1] != null) && (
                <div style={{
                  gridColumn: "1 / -1", display: "flex", gap: 6,
                  flexWrap: "wrap", alignItems: "center",
                  borderTop: "1px solid #1d3149", paddingTop: 7, marginTop: 2,
                  fontSize: 11, color: "#9db5cc",
                }}>
                  <span style={{
                    background: "#0e1b2c", borderRadius: 5, padding: "3px 7px",
                    fontWeight: 800, color: "#7da3c8",
                  }}>枠別DB（{racerCat}・{courses[b]}コース{racerStats.n?.[racerCat]?.[b - 1] ? ` n=${racerStats.n[racerCat][b - 1]}` : ""}）</span>
                  {racerStats.win1?.[racerCat]?.[b - 1] != null && (
                    <span>1着 <b style={{ color: "#fff" }}>{racerStats.win1[racerCat][b - 1]}%</b></span>
                  )}
                  {racerStats.ren2?.[racerCat]?.[b - 1] != null && (
                    <span>2連 <b style={{ color: "#fff" }}>{racerStats.ren2[racerCat][b - 1]}%</b></span>
                  )}
                  {racerStats.ren3?.[racerCat]?.[b - 1] != null && (
                    <span>3連 <b style={{ color: racerStats.ren3[racerCat][b - 1] >= 50 ? "#5dd39e" : "#fff" }}>{racerStats.ren3[racerCat][b - 1]}%</b></span>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>

        {/* スリット予測 */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 8 }}>
            スリット予測（平均STベース）
          </div>
          {!slit ? (
            <div style={{
              textAlign: "center", padding: "20px 16px", borderRadius: 10,
              border: "1px dashed #2c4762", color: "#7da3c8", fontSize: 12,
            }}>
              6艇すべての平均STを選択するとスリット隊形を表示します
            </div>
          ) : (
            <div style={{
              background: "#16273c", borderRadius: 10, padding: "14px 12px",
              position: "relative",
            }}>
              {/* スリットライン（右端） */}
              <div style={{
                position: "absolute", top: 10, bottom: 10, right: 56,
                width: 2, background: "#d96b63", opacity: 0.8,
              }} />
              <div style={{
                position: "absolute", top: 0, right: 8, fontSize: 9, color: "#d96b63",
              }}>スリット</div>

              <div style={{ display: "grid", gap: 6 }}>
                {slit.map((r) => {
                  // ST 0.00 → ライン到達(100%) / 0.25 → 0%
                  const pct = Math.max(0, Math.min(1, (0.25 - r.st) / 0.25));
                  return (
                    <div key={r.boat} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 22, fontSize: 10, color: "#7da3c8", flexShrink: 0 }}>
                        {r.course}C
                      </span>
                      <div style={{ flex: 1, position: "relative", height: 26, marginRight: 56 }}>
                        <div style={{
                          position: "absolute", left: 0, top: "50%",
                          width: `${pct * 100}%`, height: 3,
                          transform: "translateY(-50%)",
                          background: "#2c4762", borderRadius: 2,
                        }} />
                        <div style={{
                          position: "absolute", top: "50%",
                          left: `calc(${pct * 100}% - 13px)`,
                          transform: "translateY(-50%)",
                          display: "flex", alignItems: "center", gap: 3,
                        }}>
                          <span style={{
                            display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                            background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                            alignItems: "center", justifyContent: "center",
                            fontWeight: 800, fontSize: 14,
                            border: r.boat === 1 ? "1px solid #ccc" : "none",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
                          }}>{r.boat}</span>
                          {r.mark && (
                            <span style={{
                              fontSize: 9, fontWeight: 800, padding: "1px 4px",
                              borderRadius: 4,
                              background: r.mark === "F" ? "#b3463f" : "#6b5a1d",
                              color: "#fff", whiteSpace: "nowrap",
                            }}>{r.mark}</span>
                          )}
                          {tilts[r.boat] !== "" && parseFloat(tilts[r.boat]) >= 1.0 && (
                            <span style={{ fontSize: 11 }}>⚡</span>
                          )}
                        </div>
                      </div>
                      <span style={{ width: 34, fontSize: 11, color: "#9db5cc", textAlign: "right", flexShrink: 0 }}>
                        .{(r.st.toFixed(2)).split(".")[1]}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 9, color: "#7da3c8", marginTop: 10, lineHeight: 1.5 }}>
                F＝F持ち時の平均STを使用 ／ F?＝F持ちだがST不明のため通常の平均STで表示 ／ ⚡＝チルト+1.0以上の伸び警戒
              </div>
            </div>
          )}
        </div>

        {/* 結果 */}
        {!result ? (
          <div style={{
            textAlign: "center", padding: "28px 16px", borderRadius: 10,
            border: "1px dashed #2c4762", color: "#7da3c8", fontSize: 13,
          }}>
            {venue ? "6艇すべてのタイムを入力すると結果が表示されます" : "まず開催場を選択してください"}
          </div>
        ) : (
          <>
            {/* レースヘッダ */}
            <div style={{
              display: "flex", alignItems: "baseline", gap: 10,
              flexWrap: "wrap", marginBottom: 10,
            }}>
              <span style={{ fontSize: 19, fontWeight: 800, color: "#fff" }}>
                {venue}
              </span>
              <span style={{ fontSize: 12, color: "#9db5cc" }}>{wind}</span>
              {aiEval && (
                <span style={{
                  fontSize: 11, fontWeight: 800, padding: "4px 10px",
                  borderRadius: 999, background: aiEval.badgeColor, color: "#fff",
                }}>{aiEval.badge}</span>
              )}
              {aiEval?.confidence && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 11, fontWeight: 700, padding: "4px 10px",
                  borderRadius: 999, background: "#16263a",
                  border: `1px solid ${aiEval.confidence.color}`, color: aiEval.confidence.color,
                }}>
                  自信度 {aiEval.confidence.level}
                  <span style={{
                    display: "inline-block", width: 44, height: 6, borderRadius: 3,
                    background: "#0d1722", overflow: "hidden", position: "relative",
                  }}>
                    <span style={{
                      position: "absolute", left: 0, top: 0, height: "100%",
                      width: `${aiEval.confidence.total}%`, background: aiEval.confidence.color,
                    }} />
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{aiEval.confidence.total}</span>
                </span>
              )}
            </div>
            {aiEval?.confidence && (
              <div style={{ fontSize: 11, color: "#9db5cc", margin: "-2px 0 10px", lineHeight: 1.6 }}>
                {aiEval.confidence.advice}
                <span style={{ color: "#5e7a92" }}>　／　{aiEval.confidence.reasons.join("・")}</span>
              </div>
            )}


            {/* 見送りAI: 勝負／慎重／見送り推奨 の明示 */}
            {miokuri && (
              <div style={{
                border: `1px solid ${miokuri.color}`, background: "#0e1b2c",
                borderRadius: 10, padding: "10px 14px", marginBottom: 12,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 10, color: "#7da3c8", letterSpacing: "0.18em" }}>見送りAI</span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: miokuri.color }}>{miokuri.verdict}</span>
                </div>
                <div style={{ fontSize: 11, color: "#9db5cc", marginTop: 4, lineHeight: 1.6 }}>
                  {miokuri.reasons.join("・")}
                </div>
                <div style={{ fontSize: 9, color: "#5e7a92", marginTop: 4 }}>
                  ※「買わない」も戦略のひとつ。判定は目安です。最終判断はご自身で。
                </div>
              </div>
            )}

            {result.dup && (
              <div style={{
                fontSize: 12, color: "#f9c513", background: "#2e2710",
                border: "1px solid #6b5a1d", borderRadius: 8,
                padding: "8px 10px", marginBottom: 12,
              }}>
                ⚠ 同じコースに複数の艇が入っています。進入を確認してください。
              </div>
            )}

            {/* 展示系の合計・平均との差表は非表示（内部計算には反映） */}

            {/* 枠別成績＋補正の予想ランキング */}
            {result.racerRank && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8" }}>
                    予想1着率
                  </span>
                  <select
                    value={racerCat}
                    onChange={(e) => setRacerCat(e.target.value)}
                    style={{
                      fontSize: 12, padding: "5px 8px", background: "#16273c", color: "#fff",
                      border: "1px solid #2c4762", borderRadius: 8, marginLeft: "auto",
                    }}
                  >
                    {RACER_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gap: 6, marginBottom: 28 }}>
                  {result.racerRank.map((r, i) => {
                    const main = r.racerR1final ?? r.racerR3final;
                    if (main == null) return (
                      <div key={r.boat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 18, fontSize: 12, color: "#7da3c8" }}>{i + 1}.</span>
                        <span style={{
                          display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                          background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                          alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14,
                          border: r.boat === 1 ? "1px solid #ccc" : "none", flexShrink: 0,
                        }}>{r.boat}</span>
                        <span style={{ fontSize: 11, color: "#7da3c8" }}>この区分のデータなし</span>
                      </div>
                    );
                    const vals = result.racerRank
                      .map((x) => x.racerR1final ?? x.racerR3final)
                      .filter((v) => v != null);
                    const max = Math.max(...vals, 1);
                    const w = Math.max((main / max) * 100, 0);
                    return (
                      <div key={r.boat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 18, fontSize: 12, color: "#7da3c8" }}>{i + 1}.</span>
                        <span style={{
                          display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                          background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                          alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14,
                          border: r.boat === 1 ? "1px solid #ccc" : "none", flexShrink: 0,
                        }}>{r.boat}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ height: 18, background: "#16273c", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${w}%`, height: "100%", background: "#5a87b8" }} />
                          </div>
                          <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 2 }}>
                            {r.racerR1final != null && (
                              <>1着 {fmt(r.racerR1final, 1)}%</>
                            )}
                            {r.racerR2final != null && (
                              <>　2連 {fmt(r.racerR2final, 1)}%</>
                            )}
                            {r.racerR3final != null && (
                              <>　3連 {fmt(r.racerR3final, 1)}%</>
                            )}
                          </div>
                        </div>
                        <span style={{ width: 56, textAlign: "right", fontWeight: 800, fontSize: 16 }}>
                          {fmt(main, 1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* 予想2連対率 */}
            {result.racerRank && (
              <>
                <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 8 }}>
                  予想2連対率
                </div>
                <div style={{ display: "grid", gap: 6, marginBottom: 28 }}>
                  {[...result.rows]
                    .sort((a, b) => ((b.racerR2final) ?? -999) - ((a.racerR2final) ?? -999))
                    .map((r, i) => {
                      const main = r.racerR2final;
                      const vals = result.rows.map((x) => x.racerR2final).filter((v) => v != null);
                      const max = Math.max(...vals, 1);
                      return (
                        <div key={r.boat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 18, fontSize: 12, color: "#7da3c8" }}>{i + 1}.</span>
                          <span style={{
                            display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                            background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                            alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14,
                            border: r.boat === 1 ? "1px solid #ccc" : "none", flexShrink: 0,
                          }}>{r.boat}</span>
                          {main == null ? (
                            <span style={{ fontSize: 11, color: "#7da3c8" }}>この区分のデータなし</span>
                          ) : (
                            <>
                              <div style={{ flex: 1 }}>
                                <div style={{ height: 18, background: "#16273c", borderRadius: 4, overflow: "hidden" }}>
                                  <div style={{ width: `${Math.max((main / max) * 100, 0)}%`, height: "100%", background: "#5a87b8" }} />
                                </div>
                                <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 2 }}>
                                  {r.racerR2 != null ? `${r.racerR2}%` : "−"} <span style={{ color: col(r.w1 + r.w2) }}>{sign(+(r.w1 + r.w2).toFixed(1))}%</span>
                                </div>
                              </div>
                              <span style={{ width: 56, textAlign: "right", fontWeight: 800, fontSize: 16 }}>
                                {fmt(main, 1)}%
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })}
                </div>
              </>
            )}

            {/* 予想3連対率 */}
            {result.racerRank && (
              <>
                <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 8 }}>
                  予想3連対率
                </div>
                <div style={{ display: "grid", gap: 6, marginBottom: 28 }}>
                  {[...result.rows]
                    .sort((a, b) => ((b.racerR3final) ?? -999) - ((a.racerR3final) ?? -999))
                    .map((r, i) => {
                      const main = r.racerR3final;
                      const vals = result.rows.map((x) => x.racerR3final).filter((v) => v != null);
                      const max = Math.max(...vals, 1);
                      return (
                        <div key={r.boat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 18, fontSize: 12, color: "#7da3c8" }}>{i + 1}.</span>
                          <span style={{
                            display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                            background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                            alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14,
                            border: r.boat === 1 ? "1px solid #ccc" : "none", flexShrink: 0,
                          }}>{r.boat}</span>
                          {main == null ? (
                            <span style={{ fontSize: 11, color: "#7da3c8" }}>この区分のデータなし</span>
                          ) : (
                            <>
                              <div style={{ flex: 1 }}>
                                <div style={{ height: 18, background: "#16273c", borderRadius: 4, overflow: "hidden" }}>
                                  <div style={{ width: `${Math.max((main / max) * 100, 0)}%`, height: "100%", background: "#5a87b8" }} />
                                </div>
                                <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 2 }}>
                                  3連 {r.racerR3final != null ? `${fmt(r.racerR3final, 1)}%` : "−"}
                                </div>
                              </div>
                              <span style={{ width: 56, textAlign: "right", fontWeight: 800, fontSize: 16 }}>
                                {fmt(main, 1)}%
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })}
                </div>
              </>
            )}

            {/* 予想1着率ランキング */}
            <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 8 }}>
              進入反映後の基本1着率
            </div>
            <div style={{ display: "grid", gap: 6, marginBottom: 28 }}>
              {[...result.rows]
                .sort((a, b) => b.baseRate - a.baseRate)
                .map((r, i) => {
                const venue1 = r.baseRate;
                const all = result.rows.map((x) => x.baseRate);
                const max = Math.max(...all, 1);
                const w = Math.max((venue1 / max) * 100, 0);
                return (
                  <div key={r.boat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 18, fontSize: 12, color: "#7da3c8" }}>{i + 1}.</span>
                    <span style={{
                      display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                      background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                      alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14,
                      border: r.boat === 1 ? "1px solid #ccc" : "none", flexShrink: 0,
                    }}>{r.boat}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ height: 18, background: "#16273c", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${w}%`, height: "100%", background: "#3d7ab8" }} />
                      </div>
                      <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 2 }}>
                        {r.course}コース進入
                        {tilts[r.boat] !== "" && parseFloat(tilts[r.boat]) >= 1.0 && (
                          <span style={{ color: "#f9c513", fontWeight: 800 }}> ⚡伸び警戒</span>
                        )}
                      </div>
                    </div>
                    <span style={{ width: 56, textAlign: "right", fontWeight: 800, fontSize: 16 }}>
                      {fmt(venue1, 1)}%
                    </span>
                  </div>
                );
              })}
            </div>


            {/* 展開リハーサル（当日気配ベースのモンテカルロ試走・固定シード） */}
            {tenkaiRehearsal && (
              <div style={{ background: "#16273c", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2 }}>
                  展開リハーサル（AIが{tenkaiRehearsal.iters}回試走した展開分布）
                </div>
                <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 8, lineHeight: 1.6 }}>
                  各艇の平均ST・F持ち・進入・当日評価から、スタート隊形を{tenkaiRehearsal.iters}回シミュレート。
                  「レースがどう動きやすいか」の出現率です。
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {tenkaiRehearsal.patterns.slice(0, 6).map((p) => (
                    <div key={p.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#cfe0f0", fontWeight: 700, minWidth: 100 }}>{p.k.replace("(", "（").replace(")", "号艇）")}</span>
                      <div style={{ flex: 1, height: 8, background: "#0e1b2c", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(100, p.pct)}%`, height: "100%", background: "#7ac8e8" }} />
                      </div>
                      <span style={{ fontSize: 11, color: "#f5c518", fontVariantNumeric: "tabular-nums", minWidth: 46, textAlign: "right" }}>
                        {p.pct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 9, color: "#5e7a92", marginTop: 6, lineHeight: 1.5 }}>
                  ※ DB逃げシミュレーションとは別物の、当日気配ベースの試走です。参考指標としてご利用ください。
                </div>
              </div>
            )}

            {/* 逃げシミュレーション */}
            {nigeSim && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 8 }}>
                  逃げシミュレーション（DB強化版・進入変更対応）
                </div>
                {(() => {
                  const byBoat = Object.fromEntries(result.rows.map((r) => [r.boat, r]));
                  const adjNige = byBoat[1] ? nigeSim.nigeRate + byBoat[1].w1 : null;
                  return (
                    <>
                      <div style={{
                        background: "#16273c", borderRadius: 10, padding: "10px 12px",
                        marginBottom: 8, fontSize: 12, color: "#9db5cc",
                        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
                      }}>
                        <span style={{
                          display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                          background: LANE[1].bg, color: LANE[1].fg,
                          alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14,
                          border: "1px solid #ccc",
                        }}>1</span>
                        <span>1着 <b style={{ color: "#fff" }}>{nigeSim.win1}%</b></span>
                        <span>逃げ <b style={{ color: "#fff" }}>{nigeSim.nigeRate}%</b></span>
                        {adjNige != null && (
                          <span style={{ color: "#7da3c8" }}>内部反映済</span>
                        )}
                      </div>
                      {nigeSim.trustScore != null && (
                        <div style={{
                          background: "#0e1b2c", border: "1px solid #2c4762", borderRadius: 10,
                          padding: "10px 12px", marginBottom: 8, color: "#9db5cc", fontSize: 12,
                          display: "grid", gap: 6,
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 900, color: nigeSim.trustScore >= 70 ? "#5dd39e" : nigeSim.trustScore < 45 ? "#ff7b7b" : "#f9c513" }}>
                              イン逃げ信頼度：{nigeSim.trustScore}%（{nigeSim.alert}）
                            </span>
                            <span>母数 <b style={{ color: "#fff" }}>{nigeSim.n}</b>R / 逃げ <b style={{ color: "#fff" }}>{nigeSim.nigeN}</b>回</span>
                          </div>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {nigeSim.c1RacerWin != null && <span>1C本人1着 <b style={{ color: "#fff" }}>{nigeSim.c1RacerWin}%</b></span>}
                            {nigeSim.stAdv != null && <span>ST優位 <b style={{ color: nigeSim.stAdv > 0 ? "#5dd39e" : "#ff7b7b" }}>{nigeSim.stAdv > 0 ? "+" : ""}{nigeSim.stAdv.toFixed(2)}</b></span>}
                            {nigeSim.wall2 != null && <span>2C壁性能 <b style={{ color: nigeSim.wall2 >= 55 ? "#5dd39e" : nigeSim.wall2 <= 35 ? "#ff7b7b" : "#fff" }}>{nigeSim.wall2}</b></span>}
                            {nigeSim.attack3 != null && <span>3C攻撃警戒 <b style={{ color: nigeSim.attack3 >= 45 ? "#ff7b7b" : "#fff" }}>{nigeSim.attack3}</b></span>}
                          </div>
                          <div style={{
                            marginTop: 2, padding: "8px 9px", borderRadius: 8,
                            background: "rgba(22,39,60,0.78)", border: "1px solid #223c58",
                            fontSize: 10.5, lineHeight: 1.65, color: "#9db5cc",
                          }}>
                            <div><b style={{ color: "#dbe8f5" }}>上の「1着・逃げ」</b>：その開催場全体の1コース成績です。例：逃げ52%なら「この場で1コースが逃げた割合」。</div>
                            <div><b style={{ color: "#dbe8f5" }}>1C本人1着</b>：今日1号艇に入っている選手本人が、DB上で1コースに入った時の1着率です。場全体ではなく本人成績なので、上の逃げ率とズレます。</div>
                            <div><b style={{ color: "#dbe8f5" }}>イン逃げ信頼度</b>：場全体の逃げ率だけではなく、本人1C成績・ST優位・展示評価・風・2C壁性能・3C攻撃警戒を加味した総合評価です。単純な逃げ率ではありません。</div>
                            <div><b style={{ color: "#dbe8f5" }}>ST優位</b>：1号艇の平均STが他艇よりどれだけ先行しやすいか。プラスが大きいほど逃げに追い風、マイナスは遅れ警戒。</div>
                            <div><b style={{ color: "#dbe8f5" }}>2C壁性能</b>：2コース艇が壁になって1号艇を逃がしやすい度合い。100点満点目安の内部指数で、標準は50点前後。55点以上は壁として優秀、35点以下は壁が弱く差し・まくりを許しやすい。</div>
                            <div><b style={{ color: "#dbe8f5" }}>3C攻撃警戒</b>：3コース艇のまくり・まくり差し等の攻撃力。100点満点目安の内部指数で、標準は35点前後。45点以上は攻撃警戒、55点以上は強警戒。高いほどイン逃げ失敗リスクとして見る。</div>
                          </div>
                          {nigeSim.failKimarite && (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
                              <span style={{ color: "#7da3c8" }}>逃げ失敗時：</span>
                              {Object.entries(nigeSim.failKimarite).filter(([,v]) => v).map(([k,v]) => (
                                <span key={k}>{k} <b style={{ color: "#fff" }}>{v}</b></span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 480 }}>
                          <thead>
                            <tr style={{ color: "#7da3c8", fontSize: 10 }}>
                              {["艇", "進入", "逃がし2着", "逃がし3着", "1-X出目"].map((h, i) => (
                                <th key={h} style={{
                                  padding: "5px 6px", textAlign: i === 0 ? "left" : "center",
                                  borderBottom: "1px solid #2c4762", whiteSpace: "nowrap",
                                }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {[2, 3, 4, 5, 6].map((b) => {
                              const i = b - 2;
                              const r = byBoat[b];
                              const s2 = nigeSim.second?.[i];
                              const s3 = nigeSim.third?.[i];
                              const dm = nigeSim.deme?.[i];
                              const a2 = s2 != null && r ? s2 + r.w2 : null;
                              const a3 = s3 != null && r ? s3 + r.w3 : null;
                              return (
                                <tr key={b} style={{ borderBottom: "1px solid #1d3149" }}>
                                  <td style={{ padding: "7px 6px" }}>
                                    <span style={{
                                      display: "inline-flex", width: 22, height: 22, borderRadius: 5,
                                      background: LANE[b].bg, color: LANE[b].fg,
                                      alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12,
                                    }}>{b}</span>
                                  </td>
                                  <td style={{ padding: "7px 6px", textAlign: "center", color: "#9db5cc" }}>
                                    {courses[b] || b}C
                                  </td>
                                  <td style={{ padding: "7px 6px", textAlign: "center", color: "#e8eef5" }}>
                                    {s2 != null ? `${s2}%` : "−"}
                                  </td>
                                  <td style={{ padding: "7px 6px", textAlign: "center", color: "#e8eef5" }}>
                                    {s3 != null ? `${s3}%` : "−"}
                                  </td>
                                  <td style={{ padding: "7px 6px", textAlign: "center", color: "#9db5cc" }}>
                                    {dm != null ? `1-${b} ${dm}%` : "−"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 4 }}>
                        進入変更時は「艇番」ではなく現在の進入コースに合わせて逃がし率・DB枠別成績を再反映します。
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* 総合AI評価 */}
            {aiEval && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                }}>
                  <span style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8" }}>
                    総合AI評価（全要素を加味したランキング）
                  </span>
                  <span style={{
                    fontSize: 11, fontWeight: 800, padding: "3px 10px",
                    borderRadius: 999, background: aiEval.badgeColor, color: "#fff",
                  }}>{aiEval.badge}</span>
                </div>
                <div style={{ fontSize: 11, color: "#7da3c8", background: "#16273c", border: "1px solid #243a55", borderRadius: 8, padding: "8px 10px", marginBottom: 10, lineHeight: 1.6 }}>
                  並び順（◎○△✕）は枠・決まり手まで含めた<b style={{ color: "#cfe0f0" }}>総合的な本命度</b>です。各艇の<b style={{ color: "#cfe0f0" }}>合計点</b>は当日の6項目（成績・展示・ﾓｰﾀｰ・ST・枠基準・風）の出来を点数化したもので、<b style={{ color: "#cfe0f0" }}>別軸</b>です。印は下位でも合計点が高い艇は「機力・スタートは良い＝一発の妙味」、その逆は「枠の利で買われている」と読めます。
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {aiEval.ranked.map((r) => (
                    <div key={r.boat} style={{
                      background: "#16273c", borderRadius: 10, padding: "10px 12px",
                      border: r.mark === "◎" ? "1px solid #f9c513"
                        : r.rankPos === 1 ? "1px solid #3d7ab8" : "1px solid transparent",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "#7da3c8", width: 18 }}>{r.rankPos}.</span>
                        <span style={{
                          fontSize: 20, fontWeight: 800, width: 26,
                          color: r.mark === "◎" ? "#f9c513"
                            : r.mark === "○" ? "#5dd39e"
                            : r.mark === "△" ? "#e8eef5" : "#7a8da0",
                        }}>{r.mark}</span>
                        <span style={{
                          display: "inline-flex", width: 26, height: 26, borderRadius: 6,
                          background: LANE[r.boat].bg, color: LANE[r.boat].fg,
                          alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14,
                          border: r.boat === 1 ? "1px solid #ccc" : "none", flexShrink: 0,
                        }}>{r.boat}</span>
                        <span style={{ fontSize: 11, color: "#7da3c8" }}>{r.course}C進入</span>
                        <span style={{ fontSize: 11, color: "#7da3c8", marginLeft: "auto" }}>
                          良 {r.goods}/4 ｜ 枠基準参考 {fmt(r.final1, 1)}%
                        </span>
                      </div>

                      {/* 合計点バー（100点満点・項目別配点の合計） */}
                      {(() => {
                        const total = r.pointTotal ?? 0;
                        const w = Math.max(3, total); // 100点満点 → 幅%
                        const barColor = r.rankPos === 1 ? "#f9c513" : "#3d7ab8";
                        return (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                              <span style={{ fontSize: 10, color: "#5e7a92" }}>合計点<span style={{ fontSize: 9 }}>（当日の6項目の出来）</span></span>
                              <span style={{ fontSize: 13, fontWeight: 800, color: barColor, fontVariantNumeric: "tabular-nums" }}>
                                {total}<span style={{ fontSize: 9, color: "#5e7a92", fontWeight: 400 }}> /100</span>
                              </span>
                            </div>
                            <div style={{ height: 6, background: "#0e1b2c", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ width: `${w}%`, height: "100%", background: barColor }} />
                            </div>
                          </div>
                        );
                      })()}

                      {/* 4項目の判定チップ */}
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
                        {[
                          ["枠別成績", r.crit.racer],
                          ["展示タイム", r.crit.time],
                          ["モーター", r.crit.motor],
                          ["風", r.crit.wind],
                        ].map(([label, v]) => (
                          <span key={label} style={{
                            fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 6,
                            background: v === true ? "rgba(46,158,107,0.22)" : v === false ? "#1d3149" : "transparent",
                            color: v === true ? "#5dd39e" : v === false ? "#7a8da0" : "#4a5d70",
                            border: v === null ? "1px dashed #2c4762" : "1px solid transparent",
                          }}>
                            {v === true ? "✓" : v === false ? "✗" : "−"} {label}
                          </span>
                        ))}
                      </div>

                      {/* 評価の内訳（項目別配点） */}
                      {r.points && (() => {
                        const maxOf = { 成績: 20, 展示: 20, モーター: 20, ST: 20, 枠基準: 10, 風: 10 };
                        const items = ["成績", "展示", "モーター", "枠基準", "ST", "風"]
                          .map((k) => ({ k, pt: r.points[k] ?? 0, max: maxOf[k] }))
                          .sort((a, b) => (b.pt / b.max) - (a.pt / a.max)); // 達成率の高い順
                        const color = (ratio) => ratio >= 0.7 ? "#5dd39e" : "#7db0e0";
                        return (
                          <div style={{ marginTop: 9, background: "#0e1b2c", borderRadius: 8, padding: "8px 10px" }}>
                            <div style={{ fontSize: 9, letterSpacing: "0.15em", color: "#5e7a92", marginBottom: 6 }}>
                              評価の内訳（項目別の配点・この6艇の中での順位）
                            </div>
                            {items.map((it) => {
                              const ratio = it.pt / it.max;
                              return (
                                <div key={it.k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 10, color: "#9db5cc", width: 44, flexShrink: 0 }}>{it.k}</span>
                                  <div style={{ flex: 1, height: 10, background: "#0a1420", borderRadius: 3, overflow: "hidden" }}>
                                    <div style={{ width: `${ratio * 100}%`, height: "100%", background: color(ratio), borderRadius: 3 }} />
                                  </div>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: color(ratio), width: 52, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                                    {it.pt}<span style={{ fontSize: 9, color: "#5e7a92", fontWeight: 400 }}>/{it.max}</span>
                                  </span>
                                </div>
                              );
                            })}
                            <div style={{ fontSize: 9, color: "#5e7a92", marginTop: 5, lineHeight: 1.5 }}>
                              成績・展示・ﾓｰﾀｰ・ST=各20点、枠基準・風=各10点。この6艇の中で最も良い艇が満点、最も悪い艇が0点になるよう、差の大きさに応じて配点（接戦は僅差、大差は開く）。
                            </div>
                          </div>
                        );
                      })()}

                      {/* 注意・プラス材料 */}
                      {(r.warns.length > 0 || r.plus.length > 0 || r.infos.length > 0) && (
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                          {r.warns.map((wtext) => (
                            <span key={wtext} style={{
                              fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 6,
                              background: "rgba(249,197,19,0.15)", color: "#f9c513",
                            }}>⚠ {wtext}</span>
                          ))}
                          {r.plus.map((ptext) => (
                            <span key={ptext} style={{
                              fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 6,
                              background: "rgba(61,122,184,0.2)", color: "#7db4e8",
                            }}>＋ {ptext}</span>
                          ))}
                          {r.infos.map((itext) => (
                            <span key={itext} style={{
                              fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 6,
                              background: "#1d3149", color: "#9db5cc",
                            }}>○ {itext}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 10, lineHeight: 1.6 }}>
                  判定: 枠別成績・展示タイム・モーター・風 の4項目中、良が3つ以上＝◎／2つ＝○／1つ＝△／0＝✕。
                  場平均は参考表示のみ。−はデータ未入力。
                  使用データ: {aiEval.usedData.join("・")}
                </div>

                {/* 買い目の提案 */}
                {aiEval.bets && (
                  <div style={{ marginTop: 18 }}>
                    {/* 期間比較（買い目の被り） */}
                    {periodCompare && (
                      <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 14, border: "1px solid #243b56" }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                          期間で買い目を見比べる
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                          <select value={cmpA} onChange={(e) => setCmpA(e.target.value)}
                            style={{ fontSize: 13, padding: "7px 9px", background: "#0e1b2c", color: "#fff", border: "1px solid #2c4762", borderRadius: 8 }}>
                            {RACER_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <span style={{ color: "#7da3c8", fontSize: 12 }}>と</span>
                          <select value={cmpB} onChange={(e) => setCmpB(e.target.value)}
                            style={{ fontSize: 13, padding: "7px 9px", background: "#0e1b2c", color: "#fff", border: "1px solid #2c4762", borderRadius: 8 }}>
                            {RACER_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <span style={{ color: "#7da3c8", fontSize: 12 }}>を比較</span>
                        </div>

                        {["honmei", "taikou", "ana"].map((kk) => {
                          const lbl = kk === "honmei" ? "本線" : kk === "taikou" ? "対抗" : "穴";
                          const c = kk === "honmei" ? "#3d7ab8" : kk === "taikou" ? "#5a9e2e" : "#b8893d";
                          const pc = periodCompare[kk];
                          // 両期間の全買い目（和集合）を表示。被っている目は青で強調。
                          const overlapSet = new Set(pc.overlap);
                          const allUnion = [...new Set([...pc.a, ...pc.b])];
                          // 並び: 被り目を先頭にまとめ、各グループ内は若い艇番順（1号艇寄り）
                          const tkKey = (t) => String(t).split("-").map((n) => parseInt(n, 10) || 99);
                          allUnion.sort((x, y) => {
                            const ox = overlapSet.has(x) ? 0 : 1;
                            const oy = overlapSet.has(y) ? 0 : 1;
                            if (ox !== oy) return ox - oy;
                            const kx = tkKey(x), ky = tkKey(y);
                            for (let i = 0; i < 3; i++) { if ((kx[i] ?? 99) !== (ky[i] ?? 99)) return (kx[i] ?? 99) - (ky[i] ?? 99); }
                            return 0;
                          });
                          return (
                            <div key={kk} style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: c, marginBottom: 4 }}>{lbl}</div>
                              <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 4 }}>
                                全{allUnion.length}点（うち被り <span style={{ color: "#6fb3ff", fontWeight: 700 }}>{pc.overlap.length}点</span>）：
                                {allUnion.length
                                  ? (() => {
                                      // 被り目・非被り目を分けて圧縮（色分けを保つ）
                                      const ovList = allUnion.filter((t) => overlapSet.has(t));
                                      const nonList = allUnion.filter((t) => !overlapSet.has(t));
                                      const chip = (t, on) => (
                                        <span key={(on ? "o-" : "n-") + t} style={{
                                          display: "inline-block",
                                          background: on ? "#16365e" : "#1a2738",
                                          color: on ? "#6fb3ff" : "#8aa0b8",
                                          border: on ? "1px solid #2f6db5" : "1px solid #243b56",
                                          borderRadius: 5, padding: "2px 7px", margin: "2px 3px",
                                          fontWeight: on ? 800 : 600,
                                        }}>{t}</span>
                                      );
                                      return [
                                        ...compressTickets(ovList).map((t) => chip(t, true)),
                                        ...compressTickets(nonList).map((t) => chip(t, false)),
                                      ];
                                    })()
                                  : <span style={{ color: "#5e7a92" }}>買い目なし</span>}
                              </div>
                              <div style={{ fontSize: 10, color: "#5e7a92" }}>
                                {cmpA}：{pc.a.length}点 ／ {cmpB}：{pc.b.length}点　
                                <span style={{ color: "#6fb3ff" }}>■</span> 被り
                              </div>
                            </div>
                          );
                        })}

                        {/* 総合評価を左右で比較 */}
                        {periodCompare.evalA && periodCompare.evalB && (
                          <div style={{ marginTop: 6, marginBottom: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#cfe0f0", marginBottom: 6 }}>総合評価の比較</div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                              {[["A", cmpA, periodCompare.evalA], ["B", cmpB, periodCompare.evalB]].map(([side, name, ev]) => (
                                <div key={side} style={{ background: "#0e1b2c", borderRadius: 8, padding: "8px 10px" }}>
                                  <div style={{ fontSize: 11, color: "#7da3c8", marginBottom: 6, textAlign: "center" }}>{name}</div>
                                  <div style={{ display: "grid", gap: 4 }}>
                                    {ev.rank.map((b, i) => {
                                      const m = ev.mark[b];
                                      const mc = m === "◎" ? "#f9c513" : m === "○" ? "#5dd39e" : m === "△" ? "#9db5cc" : "#5e7a92";
                                      const cr = ev.crit?.[b] || {};
                                      const items = [["枠", cr.racer], ["展", cr.time], ["機", cr.motor], ["風", cr.wind]];
                                      return (
                                        <div key={b} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                          <span style={{ fontSize: 11, color: "#5e7a92", width: 14 }}>{i + 1}</span>
                                          <span style={{
                                            fontSize: 13, fontWeight: 800, color: "#fff",
                                            width: 20, height: 20, borderRadius: 4, textAlign: "center", lineHeight: "20px",
                                            background: "#1a2d44", flexShrink: 0,
                                          }}>{b}</span>
                                          <span style={{ fontSize: 13, fontWeight: 800, color: mc, width: 16 }}>{m}</span>
                                          <span style={{ display: "flex", gap: 2 }}>
                                            {items.map(([lbl, v]) => {
                                              const col = v === true ? "#2c6e3f" : v === false ? "#5e2d2d" : "#1f2d3d";
                                              const tc = v === true ? "#7fe3a8" : v === false ? "#e08a8a" : "#5e7a92";
                                              return (
                                                <span key={lbl} title={lbl} style={{
                                                  fontSize: 9, fontWeight: 700, color: tc, background: col,
                                                  borderRadius: 3, padding: "1px 3px", minWidth: 13, textAlign: "center",
                                                }}>{lbl}</span>
                                              );
                                            })}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div style={{ fontSize: 10, color: "#5e7a92", marginTop: 4 }}>
                              ※ メインと同じ4項目（枠別成績・展示・モーター・風）で評価。期間で変わるのは枠別成績ぶんです。
                            </div>
                          </div>
                        )}

                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                          {[["all", "全部の買い目を使う"], ["overlap", "被りだけ使う"]].map(([m, t]) => (
                            <button key={m} onClick={() => setCmpMode(m)}
                              style={{
                                fontSize: 12, fontWeight: 700, padding: "7px 12px", borderRadius: 8, cursor: "pointer",
                                background: cmpMode === m ? "#3d7ab8" : "#0e1b2c",
                                color: cmpMode === m ? "#fff" : "#9db5cc", border: "1px solid #2c4762",
                              }}>{t}</button>
                          ))}
                        </div>
                        <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 6, lineHeight: 1.6 }}>
                          上は両期間の全買い目を表示し、<span style={{ color: "#6fb3ff" }}>青い目</span>が2期間で被っている買い目です。「被りだけ使う」を選ぶと、本線・対抗・穴は被り目だけに絞られ、保存・AI収支もその買い目で計算されます。
                        </div>
                      </div>
                    )}

                    {/* 展開・決まり手シナリオ */}
                    {aiEval.flow && (
                      <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 14, border: "1px solid #243b56" }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 4 }}>
                          展開予想（気配→ST→モーター→F→風で絞り込み）
                        </div>
                        <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 8, lineHeight: 1.6, background: "#10202f", borderRadius: 6, padding: "6px 9px" }}>
                          こちらは「レースがどう決まるか」の<b style={{ color: "#a9c8e8" }}>展開</b>から組む買い目です。決まり手率（逃げ・差し・まくり）をもとに、起こりやすい決着パターンごとに目を出します。展開を読んで狙いたいとき向け。（下の本線〜穴は「どの艇が強いか」の総合評価から組みます）
                        </div>
                        <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 10 }}>
                          頭候補：
                          {aiEval.flow.heads.map((b, i) => (
                            <span key={b} style={{
                              display: "inline-block", background: "#1a2d44", color: "#fff", fontWeight: 800,
                              borderRadius: 6, padding: "2px 9px", margin: "0 4px",
                            }}>{b}号艇{i === 0 ? "（本命）" : ""}</span>
                          ))}
                        </div>

                        {aiEval.flow.scenarios && aiEval.flow.scenarios.length > 0 ? (
                          <div style={{ display: "grid", gap: 8 }}>
                            {aiEval.flow.scenarios.map((sc, i) => {
                              const sccol = sc.type === "逃げ" ? "#3d7ab8" : sc.type === "差し" ? "#5a9e2e" : "#b8893d";
                              return (
                                <div key={i} style={{ background: "#0e1b2c", borderRadius: 8, padding: "10px 12px", borderLeft: `4px solid ${sccol}` }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                                    <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", background: sccol, borderRadius: 6, padding: "2px 10px" }}>
                                      シナリオ{i + 1}
                                    </span>
                                    <span style={{ fontSize: 13, fontWeight: 800, color: "#e8eef5" }}>{sc.label}</span>
                                    <span style={{ fontSize: 11, color: "#7da3c8", marginLeft: "auto" }}>{sc.type}率 {sc.rate}%</span>
                                  </div>
                                  <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 6 }}>{sc.desc}</div>
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    {compressTickets(sortTicketsForDisplay(sc.tickets)).map((t) => (
                                      <span key={t} style={{
                                        fontSize: 13, fontWeight: 700, color: "#e8eef5",
                                        background: "#16273c", borderRadius: 6, padding: "5px 9px",
                                        fontVariantNumeric: "tabular-nums",
                                      }}>{t}</span>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                            <div style={{ fontSize: 10, color: "#5e7a92", lineHeight: 1.6 }}>
                              ※ 決まり手率データから可能性の高い展開を抽出。買い目はその展開での目安です。
                            </div>
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: "#5e7a92" }}>
                            枠別情報一括から決まり手データを読み込むと、展開別シナリオが表示されます。
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 10 }}>
                      AI評価に基づく買い目（3連単）
                    </div>
                    <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 10, lineHeight: 1.6, background: "#10202f", borderRadius: 6, padding: "6px 9px" }}>
                      こちらは「どの艇が強いか」の<b style={{ color: "#a9c8e8" }}>総合評価</b>から組む買い目です。枠別成績・展示・モーター・風・STを点数化し、評価上位の艇を本線（堅実）→対抗→穴（高配当）の順に並べます。総合力でバランス良く狙いたいとき向け。（上の展開予想は「どう決まるか」の展開から組みます）
                    </div>
                    {false && aiEval.recommend && (
                      <div style={{ background: "#13283d", borderRadius: 10, padding: "12px 14px", marginBottom: 12, border: "1px solid #2c4f74" }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#cfe4f7" }}>おすすめ点数</span>
                          <span style={{ fontSize: 20, fontWeight: 900, color: "#6fb3ff" }}>{aiEval.recommend.total}点</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#9db5cc" }}>{aiEval.recommend.leanLabel}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 6 }}>
                          配分の目安：
                          {["本線", "対抗", "穴", "超穴"].filter((k) => aiEval.recommend.alloc[k] > 0).map((k, i, arr) => (
                            <span key={k}>{k} {aiEval.recommend.alloc[k]}点{i < arr.length - 1 ? " ／ " : ""}</span>
                          ))}
                        </div>
                        {aiEval.recommend.notes.length > 0 && (
                          <div style={{ fontSize: 10, color: "#7da3c8", lineHeight: 1.6 }}>
                            理由：{aiEval.recommend.notes.join("、")}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: "#5e7a92", marginTop: 6, lineHeight: 1.5 }}>
                          ※ レースの荒れ度（{aiEval.badge}）と決まり手から算出した目安です。各買い目の点数プルダウンで調整できます。
                        </div>
                      </div>
                    )}
                    {/* 期待値ランキング（推定確率×オッズ）: オッズ入力/取得時のみ表示 */}
                    {aiEval.evList && aiEval.evList.length > 0 && (
                      <div style={{ background: "#16273c", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2 }}>
                          期待値ランキング（推定確率 × オッズ）
                        </div>
                        <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 8, lineHeight: 1.6 }}>
                          AIの推定的中確率とオッズを掛けた「割安度」です。<b style={{ color: "#7fe3a8" }}>1.0以上＝市場の評価より妙味あり</b>。
                          当たりやすさではなく「買う価値」の順です。
                        </div>
                        <div style={{ display: "grid", gap: 4 }}>
                          {aiEval.evList.slice(0, 8).map((e) => {
                            const good = e.ev >= 1.0;
                            return (
                              <div key={e.t} style={{
                                display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                                background: "#0e1b2c", borderRadius: 7, padding: "6px 9px", flexWrap: "wrap",
                              }}>
                                <span style={{ fontWeight: 800, color: "#cfe0f0", minWidth: 52 }}>{e.t}</span>
                                <span style={{ color: "#7da3c8", fontSize: 10 }}>{e.from}</span>
                                <span style={{ color: "#9db5cc" }}>推定 {(e.p * 100).toFixed(1)}%</span>
                                <span style={{ color: "#f5c518" }}>{e.o.toFixed(1)}倍</span>
                                <span style={{
                                  marginLeft: "auto", fontWeight: 800,
                                  color: good ? "#5dd39e" : "#8aa0b8",
                                }}>EV {e.ev.toFixed(2)}{good ? " ◎" : ""}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 9, color: "#5e7a92", marginTop: 6, lineHeight: 1.5 }}>
                          ※ 推定確率はコース別場平均を土台に当日評価で補正した近似値（Harville式）。本命側をやや高めに見積もる癖があります。参考指標としてご利用ください。
                        </div>
                      </div>
                    )}
                    <div style={{ display: "grid", gap: 10 }}>
                      {aiEval.bets.map((bet) => {
                        const color = bet.label === "本線" ? "#3d7ab8"
                          : bet.label === "対抗" ? "#5a9e2e"
                          : bet.label === "超穴" ? "#9c5ec7" : "#b8893d";
                        // 期間「被りのみ」モード: 本線〜超穴を共通買い目だけに絞る
                        let baseTickets = bet.tickets;
                        if (cmpMode === "overlap" && periodCompare) {
                          if (bet.label === "本線") baseTickets = bet.tickets.filter((t) => periodCompare.honmei.overlap.includes(t));
                          if (bet.label === "対抗") baseTickets = bet.tickets.filter((t) => periodCompare.taikou.overlap.includes(t));
                          if (bet.label === "穴") baseTickets = bet.tickets.filter((t) => periodCompare.ana.overlap.includes(t));
                        }
                        const maxPts = baseTickets.length;
                        const lim = betLimits[bet.label] != null ? Math.min(betLimits[bet.label], maxPts) : maxPts;
                        const shown = baseTickets.slice(0, lim);
                        // 表示点数に応じた合成オッズ
                        let compShown = null;
                        if (odds) {
                          const vals = shown.map((t) => odds[t]).filter((o) => o != null && o > 0);
                          if (vals.length) {
                            const inv = vals.reduce((a, o) => a + 1 / o, 0);
                            compShown = { odds: 1 / inv, covered: vals.length, total: shown.length };
                          }
                        }
                        return (
                          <div key={bet.label} style={{
                            background: "#16273c", borderRadius: 10, padding: "12px 14px",
                            borderLeft: `4px solid ${color}`,
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                              <span style={{
                                fontSize: 13, fontWeight: 800, color: "#fff",
                                background: color, borderRadius: 6, padding: "3px 10px",
                              }}>{bet.label}</span>
                              <span style={{ fontSize: 11, color: "#9db5cc" }}>{bet.desc}</span>
                              <span style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
                                {maxPts > 0 ? (
                                  <>
                                    <select
                                      value={lim}
                                      onChange={(e) => setBetLimit(bet.label, Number(e.target.value))}
                                      style={{
                                        fontSize: 12, padding: "4px 6px", background: "#0e1b2c", color: "#fff",
                                        border: "1px solid #2c4762", borderRadius: 6,
                                      }}
                                    >
                                      {Array.from({ length: maxPts }, (_, i) => i + 1).map((n) => (
                                        <option key={n} value={n}>{n}点</option>
                                      ))}
                                    </select>
                                    <span style={{ fontSize: 10, color: "#5e7a92" }}>/{maxPts}</span>
                                  </>
                                ) : (
                                  <span style={{ fontSize: 11, color: "#e08a8a" }}>被りなし</span>
                                )}
                              </span>
                            </div>
                            {compShown ? (
                              <div style={{ fontSize: 12, color: "#5dd39e", fontWeight: 800, marginBottom: 6 }}>
                                合成オッズ 約{compShown.odds.toFixed(1)}倍
                                {compShown.covered < compShown.total && (
                                  <span style={{ fontSize: 10, color: "#7da3c8", fontWeight: 400 }}>
                                    （{compShown.covered}/{compShown.total}点のオッズで計算）
                                  </span>
                                )}
                              </div>
                            ) : !odds ? (
                              <div style={{ fontSize: 10, color: "#8a98a8", marginBottom: 6 }}>
                                オッズ未取得のため合成オッズは表示できません（自動取得できると計算されます）
                              </div>
                            ) : null}
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {compressTickets(sortTicketsForDisplay(shown)).map((t) => (
                                <span key={t} style={{
                                  fontSize: 13, fontWeight: 700, color: "#e8eef5",
                                  background: "#0e1b2c", borderRadius: 6, padding: "5px 9px",
                                  fontVariantNumeric: "tabular-nums",
                                }}>{t}</span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 8, lineHeight: 1.6 }}>
                      本線＝1位を1着固定で手堅く／対抗＝1着率1・2位の折り返し＋本線で抜けた目を補完／穴＝成績地味でも展示・モーター良の艇＋1着率2・3位を頭。
                      買い目はあくまで目安です。最終判断はご自身で。
                    </div>

                    {/* 買い目を組む（AI厳選） */}
                    {pickedTickets && (
                      <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginTop: 16, border: "1px solid #243b56" }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                          買い目を組む（AIが厳選）
                        </div>
                        <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 8 }}>
                          対象（最大4つまで選択）{cmpMode === "overlap" ? "・被り買い目から" : ""}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                          {["本線", "対抗", "穴"].map((p) => {
                            const sel = pickerParts.includes(p);
                            const c = p === "本線" ? "#3d7ab8" : p === "対抗" ? "#5a9e2e" : p === "超穴" ? "#9c5ec7" : "#b8893d";
                            return (
                              <button
                                key={p}
                                onClick={() => setPickerParts((prev) =>
                                  prev.includes(p) ? prev.filter((x) => x !== p) : (prev.length >= 4 ? prev : [...prev, p])
                                )}
                                style={{
                                  fontSize: 13, fontWeight: 700, padding: "7px 14px", borderRadius: 8, cursor: "pointer",
                                  background: sel ? c : "#0e1b2c", color: sel ? "#fff" : "#9db5cc",
                                  border: `1px solid ${sel ? c : "#2c4762"}`,
                                }}
                              >{p}</button>
                            );
                          })}
                          {/* シナリオ（決まり手データがある時のみ） */}
                          {aiEval.flow?.scenarios?.map((sc, i) => {
                            const p = `シナリオ${i + 1}`;
                            const sel = pickerParts.includes(p);
                            const c = "#c77dce";
                            return (
                              <button
                                key={p}
                                onClick={() => setPickerParts((prev) =>
                                  prev.includes(p) ? prev.filter((x) => x !== p) : (prev.length >= 4 ? prev : [...prev, p])
                                )}
                                style={{
                                  fontSize: 12, fontWeight: 700, padding: "7px 11px", borderRadius: 8, cursor: "pointer",
                                  background: sel ? c : "#0e1b2c", color: sel ? "#fff" : "#9db5cc",
                                  border: `1px solid ${sel ? c : "#2c4762"}`,
                                }}
                              >シナリオ{i + 1}<span style={{ fontSize: 10, opacity: 0.85 }}>（{sc.type}）</span></button>
                            );
                          })}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                          <span style={{ fontSize: 12, color: "#9db5cc" }}>点数</span>
                          <select
                            value={pickerCount}
                            onChange={(e) => setPickerCount(Number(e.target.value))}
                            style={{
                              fontSize: 13, padding: "6px 10px", background: "#0e1b2c", color: "#fff",
                              border: "1px solid #2c4762", borderRadius: 8,
                            }}
                          >
                            {Array.from({ length: Math.max(1, Math.min(20, pickedTickets.pool)) }, (_, i) => i + 1).map((n) => (
                              <option key={n} value={n}>{n}点</option>
                            ))}
                          </select>
                          <span style={{ fontSize: 10, color: "#5e7a92" }}>（候補 {pickedTickets.pool}点から厳選）</span>
                        </div>

                        <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 6 }}>並び順</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                          {[["hit", "当たりやすさ重視", "堅い順"], ["ev", "期待値重視", "妙味・高配当"], ["balance", "バランス", "堅さ＋配当"]].map(([m, t, sub]) => (
                            <button
                              key={m}
                              onClick={() => setPickerMode(m)}
                              style={{
                                display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                                fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 8, cursor: "pointer",
                                background: pickerMode === m ? "#3d7ab8" : "#0e1b2c",
                                color: pickerMode === m ? "#fff" : "#9db5cc", border: "1px solid #2c4762",
                              }}
                            >
                              <span>{t}</span>
                              <span style={{ fontSize: 9, fontWeight: 500, color: pickerMode === m ? "#cfe4f7" : "#5e7a92" }}>{sub}</span>
                            </button>
                          ))}
                        </div>
                        {pickerMode === "ev" && !odds && (
                          <div style={{ fontSize: 10, color: "#e0b07a", marginBottom: 8 }}>
                            ※ 期待値重視はオッズが必要です。オッズが自動取得されると精度が上がります。
                          </div>
                        )}

                        {pickerParts.length >= 2 && (
                          <>
                            <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 6 }}>配分（カードの取り方）</div>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                              {[["even", "均等ミックス", "1点ずつ交互"], ["solid", "堅い順優先", "本命カード多め"], ["ana", "穴寄り", "高配当カード多め"]].map(([m, t, sub]) => (
                                <button
                                  key={m}
                                  onClick={() => setPickerAlloc(m)}
                                  style={{
                                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                                    fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 8, cursor: "pointer",
                                    background: pickerAlloc === m ? "#3d7ab8" : "#0e1b2c",
                                    color: pickerAlloc === m ? "#fff" : "#9db5cc", border: "1px solid #2c4762",
                                  }}
                                >
                                  <span>{t}</span>
                                  <span style={{ fontSize: 9, fontWeight: 500, color: pickerAlloc === m ? "#cfe4f7" : "#5e7a92" }}>{sub}</span>
                                </button>
                              ))}
                            </div>
                          </>
                        )}

                        {pickedTickets.tickets.length > 0 ? (
                          <>
                            {pickedTickets.comp ? (
                              <div style={{ fontSize: 12, color: "#5dd39e", fontWeight: 800, marginBottom: 6 }}>
                                合成オッズ 約{pickedTickets.comp.odds.toFixed(1)}倍
                                {pickedTickets.comp.covered < pickedTickets.comp.total && (
                                  <span style={{ fontSize: 10, color: "#7da3c8", fontWeight: 400 }}>
                                    （{pickedTickets.comp.covered}/{pickedTickets.comp.total}点のオッズで計算）
                                  </span>
                                )}
                              </div>
                            ) : !odds ? (
                              <div style={{ fontSize: 10, color: "#8a98a8", marginBottom: 6 }}>
                                オッズ未取得のため合成オッズは表示できません（自動取得できると計算されます）
                              </div>
                            ) : null}
                            {pickedTickets.tickets.length > 0 && (
                              <div style={{ fontSize: 10, color: "#8a98a8", marginBottom: 6 }}>
                                実 {pickedTickets.tickets.length} 点
                                {pickedTickets.tickets.length < pickerCount && (
                                  <span>（指定 {pickerCount} 点だが、根拠ある目が尽きたためここまで）</span>
                                )}
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                              {compressTickets(sortTicketsForDisplay(pickedTickets.tickets)).map((t) => (
                                <span key={t} style={{
                                  fontSize: 13, fontWeight: 700, color: "#fff",
                                  background: "#2a3f5c", borderRadius: 6, padding: "5px 9px",
                                  fontVariantNumeric: "tabular-nums",
                                }}>{t}</span>
                              ))}
                            </div>
                            {SHOW_RECORDS && (
                            <button
                              onClick={addPickedToCart}
                              style={{
                                padding: "9px 16px", borderRadius: 8, cursor: "pointer",
                                background: "#5a9e2e", color: "#fff", fontSize: 13, fontWeight: 700, border: "none",
                              }}
                            >この買い目をリストに追加</button>
                            )}
                          </>
                        ) : (
                          <div style={{ fontSize: 11, color: "#e08a8a" }}>
                            対象を選んでください（被りモードで共通なしの場合は「全部の買い目を使う」に切り替え）
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: "#5e7a92", marginTop: 8, lineHeight: 1.6 }}>
                          {pickerMode === "hit" && "当たりやすさ重視：各カード内をAI評価の堅い順に並べて拾います。"}
                          {pickerMode === "ev" && "期待値重視：各カード内を当たりやすさ×配当が高い順に並べて拾います（妙味・高配当）。"}
                          {pickerMode === "balance" && "バランス：各カード内を当たりやすさ軸＋配当を少し加味した順に並べて拾います。"}
                          {pickerParts.length >= 2 && (
                            <>
                              <br />
                              {pickerAlloc === "even" && "配分：選んだカードから1点ずつ交互に拾います（各カードの狙いを均等に反映）。"}
                              {pickerAlloc === "solid" && "配分：堅いカード（本線→対抗→穴）から多めに拾います。"}
                              {pickerAlloc === "ana" && "配分：配当が付くカード（穴→対抗→本線）から多めに拾います。"}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {SHOW_RECORDS && (<>
        {/* 保存・結果入力・的中率 */}
        <div style={{ marginTop: 28, borderTop: "1px solid #1d3149", paddingTop: 18 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 10 }}>
            予想の保存・結果入力・的中率
          </div>

          {/* 対象レース表示 */}
          <div style={{ fontSize: 11, color: "#7da3c8", marginBottom: 12 }}>
            対象：{raceDate}／{venue || "場未選択"}／{raceNo}R
          </div>

          {/* 結果出目＋配当の入力（収支にも反映） */}
          <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#9db5cc", marginBottom: 8 }}>結果の出目（3連単）</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {["first", "second", "third"].map((k, i) => (
                <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <select
                    value={resultDigits[k]}
                    onChange={(e) => setResultDigit(k, e.target.value)}
                    style={{
                      padding: "9px 10px", fontSize: 16, background: "#0e1b2c", color: "#fff",
                      border: "1px solid #2c4762", borderRadius: 8, minWidth: 64,
                    }}
                  >
                    <option value="">{i === 0 ? "1着" : i === 1 ? "2着" : "3着"}</option>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={String(n)}>{n}</option>
                    ))}
                  </select>
                  {i < 2 && <span style={{ color: "#7da3c8" }}>-</span>}
                </span>
              ))}
            </div>

            <div style={{ fontSize: 12, color: "#9db5cc", margin: "12px 0 6px" }}>配当（100円あたりの払戻額）</div>
            <input
              value={payoutOddsInput}
              onChange={(e) => setPayoutOddsInput(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal" placeholder="例 580（100円→580円）"
              style={{
                width: "100%", boxSizing: "border-box", padding: "9px 10px", fontSize: 16, marginBottom: 10,
                background: "#0e1b2c", color: "#fff", border: "1px solid #2c4762", borderRadius: 8,
              }}
            />

            <button
              onClick={saveResult}
              style={{
                padding: "9px 16px", borderRadius: 8, cursor: "pointer",
                background: "#5a9e2e", color: "#fff", fontSize: 13, fontWeight: 700, border: "none",
              }}
            >
              結果・配当を保存
            </button>
            <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 8, lineHeight: 1.6 }}>
              <b style={{ color: "#5dd39e" }}>予想の保存ボタンを押し忘れても大丈夫です。</b>結果を入れて保存すれば、その予想ごと自動で記録されます（的中率・収支に反映）。<br />
              ここで入れた結果の出目と配当が、下の舟券収支の払戻金・回収率にも自動で反映されます。
              買い目リストの「このレースの購入を記録する」を押すと、この結果・配当を使って計算されます。
            </div>
          </div>

          {saveMsg && (
            <div style={{
              fontSize: 12, marginBottom: 12,
              color: saveMsg.startsWith("✓") ? "#5dd39e" : "#ff8a80",
            }}>{saveMsg}</div>
          )}

          {/* 集計の絞り込み（期間・場） */}
          {(records.length > 0 || betRecords.length > 0) && (
            <div style={{ background: "#16273c", borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#9db5cc", marginBottom: 8 }}>集計の絞り込み（的中率・収支に反映）</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {[["all", "全期間"], ["month", "今月"], ["last30", "直近30レース"]].map(([k, lbl]) => {
                  const on = statPeriod === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setStatPeriod(k)}
                      style={{
                        padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 700,
                        background: on ? "#3d7ab8" : "#0e1b2c", color: on ? "#fff" : "#9db5cc",
                        border: on ? "1px solid #5a9ed8" : "1px solid #2c4762",
                      }}
                    >{lbl}</button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#9db5cc" }}>場：</span>
                <select
                  value={statVenue}
                  onChange={(e) => setStatVenue(e.target.value)}
                  style={{
                    fontSize: 13, padding: "6px 10px", background: "#0e1b2c", color: "#fff",
                    border: "1px solid #2c4762", borderRadius: 7,
                  }}
                >
                  <option value="all">すべての場</option>
                  {statVenueList.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                {(statPeriod !== "all" || statVenue !== "all") && (
                  <button
                    onClick={() => { setStatPeriod("all"); setStatVenue("all"); }}
                    style={{
                      fontSize: 11, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                      background: "none", color: "#7da3c8", border: "1px solid #2c4762",
                    }}
                  >絞り込み解除</button>
                )}
              </div>
            </div>
          )}

          {/* 的中率の集計 */}
          {hitStats.judged > 0 && (
            <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                的中率（結果入力済み {hitStats.judged} レース）
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {["本線", "対抗", "穴"].map((l) => {
                  const s = hitStats.per[l];
                  const rate = s.total ? (s.hit / s.total * 100).toFixed(1) : "—";
                  const color = l === "本線" ? "#3d7ab8" : l === "対抗" ? "#5a9e2e" : "#b8893d";
                  return (
                    <div key={l} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        fontSize: 12, fontWeight: 800, color: "#fff", background: color,
                        borderRadius: 6, padding: "2px 10px", minWidth: 44, textAlign: "center",
                      }}>{l}</span>
                      <span style={{ fontSize: 14, fontWeight: 800, color: "#e8eef5" }}>{rate}%</span>
                      <span style={{ fontSize: 11, color: "#7da3c8" }}>（{s.hit}/{s.total}）</span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, paddingTop: 6, borderTop: "1px solid #1d3149" }}>
                  <span style={{
                    fontSize: 12, fontWeight: 800, color: "#0e1b2c", background: "#f9c513",
                    borderRadius: 6, padding: "2px 10px", minWidth: 44, textAlign: "center",
                  }}>合計</span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "#f9c513" }}>
                    {(hitStats.comboHit / hitStats.judged * 100).toFixed(1)}%
                  </span>
                  <span style={{ fontSize: 11, color: "#7da3c8" }}>
                    （{hitStats.comboHit}/{hitStats.judged}・いずれか1つでも的中）
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* AI予想の収支（もし機械的に買っていたら・1点100円） */}
          {aiLedger.judged > 0 && (
            <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2 }}>
                AI予想の収支（全部1点100円で買ったら・{aiLedger.judged}レース）
              </div>
              <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 10 }}>
                結果・配当を保存したレースを対象に、AIの買い目を機械的に買った場合の回収率です（自分の収支とは別）。
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {aiLedger.patterns.map((p) => {
                  const s = aiLedger.stats[p.key];
                  if (!s || s.races === 0) return null;
                  const roi = s.spent ? (s.ret / s.spent * 100) : 0;
                  const hitRate = s.races ? (s.hit / s.races * 100) : 0;
                  const pos = roi >= 100;
                  return (
                    <div key={p.key} style={{
                      display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 6, alignItems: "center",
                      background: "#0e1b2c", borderRadius: 8, padding: "8px 10px",
                    }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#cfe0f0" }}>{s.name}</span>
                      <span style={{ fontSize: 11, color: "#9db5cc" }}>
                        的中 {hitRate.toFixed(0)}%<span style={{ color: "#5e7a92" }}>（{s.hit}/{s.races}）</span>
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: pos ? "#5dd39e" : "#ff8a80", textAlign: "right" }}>
                        回収 {roi.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: "#5e7a92", marginTop: 8, lineHeight: 1.6 }}>
                ※ 各パターンの購入額は「点数×100円」。複数パターン合算は買い目の重複を除いて計算しています。
              </div>
            </div>
          )}

          {/* 保存レコード一覧 */}
          {records.length > 0 && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ fontSize: 12, color: "#9db5cc", cursor: "pointer" }}>
                保存したレース（{statFilter.recs.length}件{(statPeriod !== "all" || statVenue !== "all") ? "・絞り込み中" : ""}）
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {statFilter.recs.map((r) => {
                  const hit = r.result && r.bets && r.bets.some((b) => b.tickets.includes(r.result));
                  return (
                    <div key={r.key} style={{
                      background: "#0e1b2c", borderRadius: 8, padding: "8px 10px", fontSize: 12,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "#9db5cc" }}>{r.date.slice(5)}／{r.venue}／{r.race}R</span>
                        {r.result
                          ? <span style={{ color: hit ? "#5dd39e" : "#ff8a80", fontWeight: 700 }}>
                              結果 {r.result} {r.bets && r.bets.length ? (hit ? "的中" : "不的中") : ""}
                              {r.payoutOdds ? <span style={{ color: "#7da3c8", fontWeight: 400 }}>（配当{r.payoutOdds}）</span> : null}
                            </span>
                          : <span style={{ color: "#7da3c8" }}>結果未入力</span>}
                        <button
                          onClick={() => deleteRecord(r.key)}
                          style={{
                            marginLeft: "auto", background: "none", border: "none",
                            color: "#5e7a92", cursor: "pointer", fontSize: 12,
                          }}
                        >削除</button>
                      </div>
                      {/* 点数の後から変更（AI収支が再計算される） */}
                      {r.bets && r.bets.length > 0 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                          {r.bets.map((b) => {
                            const maxP = b.tickets.length;
                            if (!maxP) return null;
                            const cur = (r.betLimits && r.betLimits[b.label] != null) ? Math.min(r.betLimits[b.label], maxP) : maxP;
                            const c = b.label === "本線" ? "#3d7ab8" : b.label === "対抗" ? "#5a9e2e" : b.label === "超穴" ? "#9c5ec7" : "#b8893d";
                            return (
                              <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                <span style={{ color: c, fontWeight: 700 }}>{b.label}</span>
                                <select
                                  value={cur}
                                  onChange={(e) => updateRecordLimit(r.key, b.label, Number(e.target.value))}
                                  style={{
                                    fontSize: 11, padding: "2px 4px", background: "#16273c", color: "#fff",
                                    border: "1px solid #2c4762", borderRadius: 5,
                                  }}
                                >
                                  {Array.from({ length: maxP }, (_, i) => i + 1).map((n) => (
                                    <option key={n} value={n}>{n}</option>
                                  ))}
                                </select>
                                <span style={{ color: "#5e7a92" }}>/{maxP}</span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          )}
          <div style={{ fontSize: 10, color: "#5e7a92", lineHeight: 1.6 }}>
            ※ 保存データはこの端末内にのみ記録されます（ボートレース日和のデータは保存していません）。
          </div>

          {/* データのバックアップ */}
          <div style={{ marginTop: 14, background: "#10202f", borderRadius: 8, padding: "12px 14px", border: "1px solid #243b56" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#cfe4f7", marginBottom: 4 }}>データのバックアップ</div>
            <div style={{ fontSize: 10, color: "#7da3c8", lineHeight: 1.6, marginBottom: 10 }}>
              端末のデータ消去や機種変更で記録は消えます。ときどき書き出して保存しておくと安心です。iPhoneでは「書き出す」を押すと共有メニューが出るので「ファイルに保存」を選んでください。保存したファイルは「読み込む」で戻せます（別端末への移行も可）。
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={exportData}
                style={{ fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", background: "#3d7ab8", color: "#fff", border: "none" }}
              >書き出す（バックアップ）</button>
              <label style={{ fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", background: "#0e1b2c", color: "#9db5cc", border: "1px solid #2c4762" }}>
                読み込む（追記）
                <input type="file" accept="application/json,.json" style={{ display: "none" }}
                  onChange={(e) => { importData(e.target.files[0], "merge"); e.target.value = ""; }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", background: "#0e1b2c", color: "#c98", border: "1px solid #5a3b2c" }}>
                読み込む（置き換え）
                <input type="file" accept="application/json,.json" style={{ display: "none" }}
                  onChange={(e) => {
                    if (window.confirm("現在の記録を、読み込むファイルの内容で置き換えます。よろしいですか？")) importData(e.target.files[0], "replace");
                    e.target.value = "";
                  }} />
              </label>
            </div>
            {ioMsg && <div style={{ fontSize: 11, color: ioMsg.startsWith("✓") ? "#5dd39e" : ioMsg.startsWith("✗") ? "#e08a8a" : "#cbb27a", marginTop: 8, lineHeight: 1.6 }}>{ioMsg}</div>}

            {exportText && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, color: "#9db5cc", marginBottom: 4 }}>↓このテキストを全選択してコピーし、メモ等に保存してください</div>
                <textarea
                  readOnly
                  value={exportText}
                  onFocus={(e) => e.target.select()}
                  style={{ width: "100%", height: 120, fontSize: 10, background: "#0a1521", color: "#cbd6e2", border: "1px solid #243b56", borderRadius: 6, padding: 8, fontFamily: "monospace" }}
                />
                <button
                  onClick={() => setExportText("")}
                  style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, cursor: "pointer", background: "#0e1b2c", color: "#9db5cc", border: "1px solid #2c4762", marginTop: 6 }}
                >閉じる</button>
              </div>
            )}

            <details style={{ marginTop: 10 }}>
              <summary style={{ fontSize: 11, color: "#7da3c8", cursor: "pointer" }}>テキストから復元する（ファイルが使えないとき）</summary>
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, color: "#9db5cc", marginBottom: 4 }}>バックアップのテキストを貼り付けて読み込めます</div>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder='{"app":"hunaken-academia", ... }'
                  style={{ width: "100%", height: 90, fontSize: 10, background: "#0a1521", color: "#cbd6e2", border: "1px solid #243b56", borderRadius: 6, padding: 8, fontFamily: "monospace" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button
                    onClick={() => { importFromText(importText, "merge"); }}
                    style={{ fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "#0e1b2c", color: "#9db5cc", border: "1px solid #2c4762" }}
                  >貼り付けて追記</button>
                  <button
                    onClick={() => { if (window.confirm("現在の記録を貼り付けた内容で置き換えます。よろしいですか？")) importFromText(importText, "replace"); }}
                    style={{ fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "#0e1b2c", color: "#c98", border: "1px solid #5a3b2c" }}
                  >貼り付けて置き換え</button>
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* 舟券の収支記録 */}
        <div style={{ marginTop: 28, borderTop: "1px solid #1d3149", paddingTop: 18 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7da3c8", marginBottom: 10 }}>
            舟券の収支記録（3連単）
          </div>

          {/* 集計サマリー */}
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
            gap: 8, marginBottom: 14,
          }}>
            {[
              ["購入レース", `${betStats.raceCount}`],
              ["購入金額", `${betStats.spent.toLocaleString()}円`],
              ["払戻金額", `${betStats.ret.toLocaleString()}円`],
              ["収支", `${(betStats.ret - betStats.spent).toLocaleString()}円`],
              ["的中率", betStats.hitRate == null ? "—" : `${betStats.hitRate.toFixed(1)}%`],
              ["回収率", betStats.roi == null ? "—" : `${betStats.roi.toFixed(1)}%`],
            ].map(([label, val], i) => {
              const isMoney = label === "収支";
              const pos = betStats.ret - betStats.spent >= 0;
              const isRoi = label === "回収率";
              const roiPos = (betStats.roi ?? 0) >= 100;
              const color = isMoney ? (pos ? "#5dd39e" : "#ff8a80")
                : isRoi && betStats.roi != null ? (roiPos ? "#5dd39e" : "#ff8a80") : "#e8eef5";
              return (
                <div key={i} style={{ background: "#16273c", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: "#7da3c8", marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color }}>{val}</div>
                </div>
              );
            })}
          </div>

          {/* 舟券を追加 */}
          <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#9db5cc", marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              買い目をリストに追加
              {periodCompare && (
                <span style={{
                  fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 8px",
                  background: cmpMode === "overlap" ? "#1c3a2a" : "#1a2d44",
                  color: cmpMode === "overlap" ? "#7fe3a8" : "#9db5cc",
                }}>
                  {cmpMode === "overlap" ? "被り買い目のみ追加" : "全部の買い目を追加"}
                </span>
              )}
            </div>

            {/* 買い目ソース選択 */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {["本線", "対抗", "穴", "自由"].map((s) => (
                <button
                  key={s}
                  onClick={() => setBD("source", s)}
                  style={{
                    padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
                    background: betDraft.source === s ? "#3d7ab8" : "#0e1b2c",
                    color: betDraft.source === s ? "#fff" : "#9db5cc",
                    border: "1px solid #2c4762",
                  }}
                >{s}</button>
              ))}
            </div>

            {betDraft.source === "自由" && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: "#7da3c8", marginBottom: 6 }}>
                  フォーメーション（1着・2着・3着の艇番を選択 → 自動で組み合わせ）
                </div>
                {[["f1", "1着"], ["f2", "2着"], ["f3", "3着"]].map(([key, lbl]) => {
                  const allSel = betDraft[key].length === 6;
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: "#9db5cc", width: 32 }}>{lbl}</span>
                      {[1, 2, 3, 4, 5, 6].map((n) => {
                        const sel = betDraft[key].includes(n);
                        return (
                          <button
                            key={n}
                            onClick={() => setBetDraft((p) => ({
                              ...p,
                              [key]: sel ? p[key].filter((x) => x !== n) : [...p[key], n].sort(),
                            }))}
                            style={{
                              width: 36, height: 36, borderRadius: 8, cursor: "pointer",
                              fontSize: 15, fontWeight: 800,
                              background: sel ? "#3d7ab8" : "#0e1b2c",
                              color: sel ? "#fff" : "#7da3c8",
                              border: sel ? "1px solid #5a87b8" : "1px solid #2c4762",
                            }}
                          >{n}</button>
                        );
                      })}
                      <button
                        onClick={() => setBetDraft((p) => ({ ...p, [key]: allSel ? [] : [1, 2, 3, 4, 5, 6] }))}
                        style={{
                          height: 36, padding: "0 10px", borderRadius: 8, cursor: "pointer",
                          fontSize: 13, fontWeight: 800,
                          background: allSel ? "#5a9e2e" : "#0e1b2c",
                          color: allSel ? "#fff" : "#9db5cc",
                          border: "1px solid #2c4762",
                        }}
                      >全</button>
                    </div>
                  );
                })}
                {(() => {
                  const { f1, f2, f3 } = betDraft;
                  let pts = 0;
                  for (const a of f1) for (const b of f2) for (const c of f3)
                    if (a !== b && b !== c && a !== c) pts++;
                  return (
                    <div style={{ fontSize: 11, color: pts ? "#5dd39e" : "#7da3c8", marginTop: 2 }}>
                      {pts > 0 ? `${pts}点になります` : "1着・2着・3着をそれぞれ選んでください"}
                    </div>
                  );
                })()}
              </div>
            )}

            <button
              onClick={addToCart}
              style={{
                padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                background: "#3d7ab8", color: "#fff", fontSize: 13, fontWeight: 700, border: "none",
              }}
            >＋ リストに追加</button>
            <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 8, lineHeight: 1.6 }}>
              「自由」は1着・2着・3着を選んでテレボートのフォーメーションのように追加できます（「全」で1〜6一括）。
              1頭流し＋別の頭など、複数の買い目を続けて追加できます。本線・対抗・穴はそのまま追加されます。
            </div>
            {betMsg && (
              <div style={{ fontSize: 12, marginTop: 8, color: betMsg.startsWith("✓") ? "#5dd39e" : "#ff8a80" }}>{betMsg}</div>
            )}
          </div>

          {/* 買い目リスト（カート） */}
          {cart.length > 0 && (
            <div style={{ background: "#16273c", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#9db5cc", marginBottom: 8 }}>
                買い目リスト（{raceDate.slice(5)}／{venue || "場未選択"}／{raceNo}R）
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {cart.map((l) => (
                  <div key={l.id} style={{ background: "#0e1b2c", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#cfe0f0" }}>{l.label}</span>
                      <span style={{ fontSize: 11, color: "#7da3c8" }}>{l.tickets.length}点</span>
                      <button
                        onClick={() => removeFromCart(l.id)}
                        style={{ marginLeft: "auto", background: "none", border: "none", color: "#5e7a92", cursor: "pointer", fontSize: 12 }}
                      >削除</button>
                    </div>

                    {!l.expanded ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, color: "#9db5cc" }}>一律 1点</span>
                        <input
                          value={l.perTicket ? "" : l.amountPerPoint}
                          placeholder={l.perTicket ? "個別設定中" : ""}
                          onChange={(e) => updateCartAmount(l.id, e.target.value)}
                          inputMode="numeric"
                          style={{
                            width: 80, padding: "6px 8px", fontSize: 15,
                            background: "#16273c", color: "#fff", border: "1px solid #2c4762", borderRadius: 6,
                          }}
                        />
                        <span style={{ fontSize: 11, color: "#9db5cc" }}>円</span>
                        <button
                          onClick={() => toggleExpand(l.id)}
                          style={{
                            fontSize: 11, color: "#7da3c8", background: "#16273c",
                            border: "1px solid #2c4762", borderRadius: 6, padding: "5px 10px", cursor: "pointer",
                          }}
                        >個別設定</button>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#e8eef5", marginLeft: "auto" }}>
                          小計 {lineTotal(l).toLocaleString()}円
                        </span>
                      </div>
                    ) : (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontSize: 11, color: "#9db5cc" }}>1点ごとに金額を設定（円）</span>
                          <span style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => resetToFlat(l.id)}
                              style={{ fontSize: 11, color: "#7da3c8", background: "none", border: "none", cursor: "pointer" }}>
                              一律に戻す
                            </button>
                            <button onClick={() => toggleExpand(l.id)}
                              style={{ fontSize: 11, color: "#5dd39e", background: "none", border: "none", cursor: "pointer" }}>
                              閉じる
                            </button>
                          </span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
                          {sortTicketsForDisplay(l.tickets).map((t) => (
                            <div key={t} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 12, color: "#cfe0f0", fontWeight: 700, minWidth: 46 }}>{t}</span>
                              <input
                                value={l.perTicket?.[t] ?? 0}
                                onChange={(e) => setTicketAmount(l.id, t, e.target.value)}
                                inputMode="numeric"
                                style={{
                                  width: 64, padding: "5px 7px", fontSize: 14,
                                  background: "#16273c", color: "#fff", border: "1px solid #2c4762", borderRadius: 6,
                                }}
                              />
                              <span style={{ fontSize: 11, color: "#9db5cc" }}>円</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#e8eef5", marginTop: 6, textAlign: "right" }}>
                          小計 {lineTotal(l).toLocaleString()}円
                        </div>
                      </div>
                    )}

                    {!l.expanded && (
                      <div style={{ fontSize: 10, color: "#5e7a92", marginTop: 4, wordBreak: "break-all" }}>
                        {l.tickets.join("  ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", marginTop: 10 }}>
                合計 {cartTotal.pts}点 ／ {cartTotal.amt.toLocaleString()}円
              </div>

              <button
                onClick={commitCart}
                style={{
                  marginTop: 10, padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                  background: "#5a9e2e", color: "#fff", fontSize: 13, fontWeight: 700, border: "none",
                }}
              >このレースの購入を記録する</button>
              <div style={{ fontSize: 10, color: "#7da3c8", marginTop: 8, lineHeight: 1.6 }}>
                上の「結果の出目（3連単）」と配当を入れてから押すと、払戻金・回収率まで反映されます。
                結果が未確定なら、金額だけ決めて先に記録してもOK（払戻は0で記録されます）。
              </div>
            </div>
          )}

          {/* 舟券履歴 */}
          {betRecords.length > 0 && (
            <details>
              <summary style={{ fontSize: 12, color: "#9db5cc", cursor: "pointer" }}>
                舟券の履歴（{betRecords.length}件）
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {betRecords.map((b) => (
                  <div key={b.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    background: "#0e1b2c", borderRadius: 8, padding: "8px 10px", fontSize: 12, flexWrap: "wrap",
                  }}>
                    <span style={{ color: "#9db5cc" }}>{b.date.slice(5)}／{b.venue}／{b.race}R</span>
                    <span style={{ color: "#cfe0f0", fontWeight: 700 }}>{b.label}</span>
                    <span style={{ color: "#9db5cc" }}>{b.amount.toLocaleString()}円</span>
                    {b.result
                      ? <span style={{ color: b.hit ? "#5dd39e" : "#ff8a80", fontWeight: 700 }}>
                          {b.result} {b.hit ? `的中 +${b.payout.toLocaleString()}円` : "不的中"}
                          {b.payoutOdds ? <span style={{ color: "#7da3c8", fontWeight: 400 }}>（配当{b.payoutOdds}）</span> : null}
                        </span>
                      : <span style={{ color: "#7da3c8" }}>結果未入力</span>}
                    <button
                      onClick={() => deleteBet(b.id)}
                      style={{ marginLeft: "auto", background: "none", border: "none", color: "#5e7a92", cursor: "pointer", fontSize: 12 }}
                    >削除</button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        </>)}

        {/* ご利用にあたって */}
        <div style={{
          marginTop: 32, paddingTop: 16, borderTop: "1px solid #1d3149",
          fontSize: 10, color: "#7da3c8", lineHeight: 1.8,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4, letterSpacing: "0.1em" }}>
            【ご利用にあたって】
          </div>
          本ツール「舟券アカデミア評価」の著作権は舟券アカデミアに帰属します。<br />
          ・本ツールのコード改変、複製、再配布、転売、貸与を禁止します。<br />
          ・本ツールの内容・画面・ロジックを無断で公開、配布、販売する行為を禁じます。<br />
          ・舟券アカデミアに無断での商用利用（販売・有料配布・収益目的での再公開など）を固く禁じます。<br />
          ・本ツールは的中を保証するものではありません。舟券の購入は自己責任でお願いします。<br />
          <div style={{ marginTop: 6, textAlign: "right", color: "#4a5d70" }}>
            © 舟券アカデミア
          </div>
        </div>
      </div>
    </div>
  );
}
