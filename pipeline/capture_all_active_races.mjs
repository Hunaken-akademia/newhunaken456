const VENUES = [
  "桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"
];

const BASE = String(process.env.APP_BASE_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const TOKEN = String(process.env.CAPTURE_TOKEN || "");
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CAPTURE_CONCURRENCY || 5)));
const RUNNER_NAME = String(process.env.RUNNER_NAME || "manual-runner")
  .trim()
  .replace(/[^a-zA-Z0-9._-]/g, "-")
  .slice(0, 64) || "manual-runner";
const RUN_ID = String(process.env.RUN_ID || `${RUNNER_NAME}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 160);
const RUN_STARTED_AT = new Date().toISOString();

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

async function postJson(url, body, headers={}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let data={}; try { data=JSON.parse(text); } catch {}
  if (!r.ok || !data.ok) throw new Error(`${r.status} ${data.error || text.slice(0,180)}`);
  return data;
}

async function sendRunnerHeartbeat(state, extra = {}) {
  try {
    await postJson(
      `${BASE}/api/yoso?action=capture_runner_heartbeat`,
      {
        runner: RUNNER_NAME,
        state,
        runId: RUN_ID,
        startedAt: RUN_STARTED_AT,
        finishedAt: state === "running" ? "" : new Date().toISOString(),
        summary: extra.summary || null,
        error: extra.error || "",
      },
      TOKEN ? { "x-capture-token": TOKEN } : {},
    );
  } catch (e) {
    // ハートビート障害だけで本体処理は止めない。副系は安全側で実行する。
    console.warn(`runner heartbeat ${state} failed: ${e.message || e}`);
  }
}

async function mapLimit(items, limit, fn) {
  let i=0; const out=[];
  async function worker(){ while(true){ const n=i++; if(n>=items.length) return; try{ out[n]=await fn(items[n]); }catch(e){ out[n]={ok:false,error:e.message||String(e)}; } } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

async function main() {
  const now=jstNow();
  console.log(`capture-all-active-races start runner=${RUNNER_NAME} runId=${RUN_ID} ${now.date} ${now.minutes}min JST`);
  await sendRunnerHeartbeat("running");

  const schedules = await mapLimit(VENUES, CONCURRENCY, async venue => {
    const u = `${BASE}/api/yoso?action=schedule&venue=${encodeURIComponent(venue)}&date=${now.date}`;
    const data = await getJson(u);
    return { ok: true, venue, schedule:data.schedule||[], noRace:!!data.noRace };
  });
  const scheduleErrors = schedules.filter((x) => !x?.ok);
  if (scheduleErrors.length) {
    console.warn(`schedule errors=${scheduleErrors.length}`);
  }

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

  // AI買い目の自動保存は廃止。各利用者が画面上で必要なレースだけ保存する。

  const ok=results.filter(x=>x?.ok).length;
  const resultNg=results.length-ok;
  const ng=resultNg+scheduleErrors.length;
  const summary={
    runner:RUNNER_NAME,
    runId:RUN_ID,
    date:now.date,
    jobs:jobs.length,
    ok,
    ng,
    errors:[...scheduleErrors, ...results.filter(x=>!x?.ok)].slice(0,10),
  };
  console.log(JSON.stringify(summary,null,2));
  const heartbeatSummary = {
    date: summary.date,
    jobs: summary.jobs,
    ok: summary.ok,
    ng: summary.ng,
  };
  const hardFailure = ng >= 5;
  await sendRunnerHeartbeat(hardFailure ? "failed" : "success", { summary: heartbeatSummary });
  if (hardFailure) process.exitCode = 1;
  return summary;
}

try {
  await main();
} catch (e) {
  const message = e?.stack || e?.message || String(e);
  console.error(message);
  await sendRunnerHeartbeat("failed", { error: e?.message || String(e) });
  process.exitCode = 1;
}