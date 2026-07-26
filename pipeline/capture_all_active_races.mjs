const VENUES = [
  "桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"
];

const BASE = String(process.env.APP_BASE_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const TOKEN = String(process.env.CAPTURE_TOKEN || "");
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CAPTURE_CONCURRENCY || 5)));
const AI_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.AI_CAPTURE_CONCURRENCY || 2)));
const AUTH_SESSION_JSON = String(process.env.AUTOMATION_AUTH_SESSION_JSON || "").trim();
const AI_SAVE_BEFORE_MINUTES = Math.max(5, Math.min(30, Number(process.env.AI_SAVE_BEFORE_MINUTES || 20)));

function jstNow() {
  const p = new Intl.DateTimeFormat("ja-JP", { timeZone:"Asia/Tokyo", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false })
    .formatToParts(new Date()).reduce((a,x)=>{ if(x.type!=="literal") a[x.type]=x.value; return a; },{});
  const h = Number(p.hour === "24" ? "0" : p.hour);
  return { date:`${p.year}-${p.month}-${p.day}`, ymd:`${p.year}${p.month}${p.day}`, minutes:h*60+Number(p.minute||0) };
}

async function getJson(url, headers={}) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data={}; try { data=JSON.parse(text); } catch {}
  if (!r.ok || !data.ok) throw new Error(`${r.status} ${data.error || text.slice(0,180)}`);
  return data;
}

async function mapLimit(items, limit, fn) {
  let i=0; const out=[];
  async function worker(){ while(true){ const n=i++; if(n>=items.length) return; try{ out[n]=await fn(items[n]); }catch(e){ out[n]={ok:false,error:e.message||String(e)}; } } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

const now=jstNow();
console.log(`capture-all-active-races start ${now.date} ${now.minutes}min JST`);

const schedules = await mapLimit(VENUES, CONCURRENCY, async venue => {
  const u = `${BASE}/api/yoso?action=schedule&venue=${encodeURIComponent(venue)}&date=${now.date}`;
  const data = await getJson(u);
  return { venue, schedule:data.schedule||[], noRace:!!data.noRace };
});

const jobs=[];
for (const s of schedules) {
  if (!s?.venue || s.noRace || !Array.isArray(s.schedule)) continue;
  for (const r of s.schedule) {
    const left = Number(r.deadlineMinutes) - now.minutes;
    // 展示・オッズは締切30分前〜締切後90分まで取得する。
    // 公式結果は一時的な取得失敗を取り残さないよう、当日の終了済み全レースを毎回確認する。
    const race = Number(r.race);
    const captureNeeded = left <= 30 && left >= -90;
    const resultNeeded = left <= -1;
    if ((captureNeeded || resultNeeded) && Number.isInteger(race) && race >= 1 && race <= 12) {
      jobs.push({ venue:s.venue, race, left, final:resultNeeded, captureNeeded });
    }
  }
}

console.log(`capture/result jobs=${jobs.length}`);
const results = await mapLimit(jobs, CONCURRENCY, async j => {
  let data = { rows: [], oddsCount: 0 };
  let rows = 0;
  if (j.captureNeeded) {
    const q = new URLSearchParams({ action:"capture", venue:j.venue, race:String(j.race), date:now.date, final:j.final?"1":"0", t:String(Date.now()) });
    data = await getJson(`${BASE}/api/yoso?${q}`, TOKEN ? {"x-capture-token":TOKEN} : {});
    rows = Array.isArray(data.rows) ? data.rows.length : 0;
    // ナイター場などで展示公開が遅れる場合、締切15分前以降だけ同一run内で再確認する。
    if (rows < 6 && j.left <= 15 && j.left >= -2) {
      await new Promise((resolve) => setTimeout(resolve, 35000));
      q.set("t", String(Date.now()));
      data = await getJson(`${BASE}/api/yoso?${q}`, TOKEN ? {"x-capture-token":TOKEN} : {});
      rows = Array.isArray(data.rows) ? data.rows.length : 0;
    }
  }
  let resultCompleted = false;
  let resultReason = "";
  if (j.final) {
    const fetchResult = async () => {
      const rq = new URLSearchParams({ action: "result", venue: j.venue, race: String(j.race), date: now.date, t: String(Date.now()) });
      return await getJson(`${BASE}/api/yoso?${rq}`, TOKEN ? { "x-capture-token": TOKEN } : {});
    };
    try {
      let resultData = await fetchResult();
      resultCompleted = !!resultData.completed;
      resultReason = resultData.reason || "";
      // 締切直後で未確定なら同じrun内でもう一度だけ確認する。
      if (!resultCompleted && j.left >= -20) {
        await new Promise((resolve) => setTimeout(resolve, 20000));
        resultData = await fetchResult();
        resultCompleted = !!resultData.completed;
        resultReason = resultData.reason || resultReason;
      }
    } catch (e) {
      resultReason = e.message || String(e);
    }
  }
  console.log(`OK ${j.venue}${j.race}R left=${j.left} final=${j.final} rows=${rows} odds=${data.oddsCount||0} result=${resultCompleted ? "confirmed" : (j.final ? "pending" : "-")}`);
  return {ok:true,...j,rows,odds:data.oddsCount||0,resultCompleted,resultReason, displayDisabled:!!data.displayDisabled, displayReasonCode:data.displayReasonCode||""};
});

// AI買い目は、利用者のブラウザではなくGitHub Actions上のヘッドレスChromiumで保存する。
// capture_ai=1 は src/App.jsx の本番評価ロジックをそのまま実行するため、サーバー用の複製ロジックとの乖離が起きない。
const aiCandidates = results.filter((x) =>
  x?.ok &&
  !x.final &&
  Number.isInteger(Number(x.race)) &&
  Number(x.race) >= 1 &&
  Number(x.race) <= 12 &&
  x.left <= AI_SAVE_BEFORE_MINUTES &&
  x.left >= 2 &&
  x.rows >= 6 &&
  x.odds >= 10
);

// 風は完全手動。レース別の風が保存済みの対象だけAI保存する。
const windsByVenue = new Map();
for (const venue of [...new Set(aiCandidates.map((x) => x.venue))]) {
  try {
    const q = new URLSearchParams({ action: "manual_winds", venue, date: now.date, t: String(Date.now()) });
    const data = await getJson(`${BASE}/api/yoso?${q}`);
    windsByVenue.set(venue, data.winds || {});
  } catch (e) {
    console.warn(`manual wind load failed: ${venue}: ${e.message || e}`);
    windsByVenue.set(venue, {});
  }
}
const aiTargets = aiCandidates.filter((x) => {
  const wind = String(windsByVenue.get(x.venue)?.[String(x.race)] || windsByVenue.get(x.venue)?.[x.race] || "").trim();
  if (!wind) console.log(`AI SKIP ${x.venue}${x.race}R: manual wind is not set`);
  return !!wind;
});
let aiResults = [];
if (aiTargets.length && AUTH_SESSION_JSON) {
  let session;
  try { session = JSON.parse(AUTH_SESSION_JSON); } catch { throw new Error("AUTOMATION_AUTH_SESSION_JSON is not valid JSON"); }
  if (!session?.access_token) throw new Error("AUTOMATION_AUTH_SESSION_JSON.access_token is required");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    aiResults = await mapLimit(aiTargets, AI_CONCURRENCY, async (j) => {
      const context = await browser.newContext();
      await context.addInitScript(({ session }) => {
        localStorage.setItem("hunaken_paid_auth_session_v1", JSON.stringify(session));
      }, { session });
      const page = await context.newPage();
      const targetUrl = `${BASE}/?capture_ai=1&date=${encodeURIComponent(now.date)}&venue=${encodeURIComponent(j.venue)}&race=${j.race}`;
      let saveResponse = null;
      page.on("response", async (response) => {
        if (!response.url().includes("/api/yoso?action=save_ai_prediction")) return;
        try { saveResponse = { status: response.status(), body: await response.json() }; }
        catch { saveResponse = { status: response.status(), body: {} }; }
      });
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForFunction(() => document.body && !document.body.innerText.includes("ログイン状態と購入者情報を確認中"), null, { timeout: 45000 });
        const deadline = Date.now() + 120000;
        let pageStatus = null;
        while (!saveResponse && Date.now() < deadline) {
          pageStatus = await page.evaluate(() => window.__HUNAKEN_AI_CAPTURE_STATUS__ || null).catch(() => null);
          if (pageStatus?.state === "error") throw new Error(pageStatus.error || "AI capture page error");
          await page.waitForTimeout(1000);
        }
        if (!saveResponse || saveResponse.status >= 300 || !saveResponse.body?.ok) {
          const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
          const statusText = pageStatus?.state ? ` page=${pageStatus.state}` : "";
          throw new Error(saveResponse?.body?.error || saveResponse?.body?.reason || `AI save timeout/status ${saveResponse?.status || "none"}${statusText}: ${bodyText}`);
        }
        console.log(`AI SAVED ${j.venue}${j.race}R left=${j.left}`);
        return { ok:true, venue:j.venue, race:j.race };
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
  }
} else if (aiTargets.length) {
  console.warn(`AI capture skipped: AUTOMATION_AUTH_SESSION_JSON is not set (${aiTargets.length} targets)`);
}

const ok=results.filter(x=>x?.ok).length;
const ng=results.length-ok;
const aiNg=aiResults.filter(x=>!x?.ok).length;
console.log(JSON.stringify({date:now.date,jobs:jobs.length,ok,ng,aiTargets:aiTargets.length,aiSaved:aiResults.filter(x=>x?.ok).length,aiNg,errors:results.filter(x=>!x?.ok).slice(0,10),aiErrors:aiResults.filter(x=>!x?.ok).slice(0,10)},null,2));
if (ng || aiNg) process.exitCode=1;
