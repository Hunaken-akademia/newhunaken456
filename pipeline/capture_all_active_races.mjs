const VENUES = [
  "桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"
];

const BASE = String(process.env.APP_BASE_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const TOKEN = String(process.env.CAPTURE_TOKEN || "");
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CAPTURE_CONCURRENCY || 5)));

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
    // 展示公開前後は繰り返し取得。締切後も90分間は結果・確定オッズを再確認する。
    if (left <= 60 && left >= -90) jobs.push({ venue:s.venue, race:Number(r.race), left, final:left <= -1 });
  }
}

console.log(`capture jobs=${jobs.length}`);
const results = await mapLimit(jobs, CONCURRENCY, async j => {
  const q = new URLSearchParams({ action:"capture", venue:j.venue, race:String(j.race), date:now.date, final:j.final?"1":"0", t:String(Date.now()) });
  const captureUrl = `${BASE}/api/yoso?${q}`;
  let data = await getJson(captureUrl, TOKEN ? {"x-capture-token":TOKEN} : {});

  if (j.venue === "常滑") {
    console.log(`[TOKONAME CAPTURE DEBUG ${j.race}R]`, JSON.stringify({
      requestUrl: captureUrl,
      left: j.left,
      final: j.final,
      responseKeys: Object.keys(data || {}),
      rowsType: Array.isArray(data?.rows) ? "array" : typeof data?.rows,
      rowsLength: Array.isArray(data?.rows) ? data.rows.length : null,
      rows: data?.rows ?? null,
      oddsCount: data?.oddsCount ?? null,
      reviewSaved: data?.reviewSaved ?? null,
      error: data?.error ?? null,
      warning: data?.warning ?? null,
      reason: data?.reason ?? null,
      sourceUrl: data?.sourceUrl ?? null,
      fetchStatus: data?.fetchStatus ?? null,
      htmlLength: data?.htmlLength ?? null
    }, null, 2));
  }

  let rows = Array.isArray(data.rows) ? data.rows.length : 0;
  // 展示公開が遅れた場合は、締切30分前以降かつ締切前に同一run内でもう一度だけ確認する。
  // 60分前から取得対象にすることで通常runでも複数回の保存機会を確保しつつ、早すぎる再試行は避ける。
  if (rows < 6 && j.left <= 30 && j.left >= 0) {
    await new Promise((resolve) => setTimeout(resolve, 35000));
    q.set("t", String(Date.now()));
    const retryUrl = `${BASE}/api/yoso?${q}`;
    data = await getJson(retryUrl, TOKEN ? {"x-capture-token":TOKEN} : {});

    if (j.venue === "常滑") {
      console.log(`[TOKONAME RETRY DEBUG ${j.race}R]`, JSON.stringify({
        requestUrl: retryUrl,
        left: j.left,
        final: j.final,
        responseKeys: Object.keys(data || {}),
        rowsType: Array.isArray(data?.rows) ? "array" : typeof data?.rows,
        rowsLength: Array.isArray(data?.rows) ? data.rows.length : null,
        rows: data?.rows ?? null,
        oddsCount: data?.oddsCount ?? null,
        reviewSaved: data?.reviewSaved ?? null,
        error: data?.error ?? null,
        warning: data?.warning ?? null,
        reason: data?.reason ?? null,
        sourceUrl: data?.sourceUrl ?? null,
        fetchStatus: data?.fetchStatus ?? null,
        htmlLength: data?.htmlLength ?? null
      }, null, 2));
    }

    rows = Array.isArray(data.rows) ? data.rows.length : 0;
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

  const preRaceAvailable = !!data?.reviewSaved?.preRaceAvailable;
  const preRaceUpdated = !!data?.reviewSaved?.preRaceUpdated;
  const preRaceCapturedAt = String(data?.reviewSaved?.preRaceCapturedAt || "");
  console.log(`OK ${j.venue}${j.race}R left=${j.left} final=${j.final} rows=${rows} odds=${data.oddsCount||0} preRace=${preRaceAvailable ? (preRaceUpdated ? "updated" : "kept") : "missing"} result=${resultCompleted ? "confirmed" : (j.final ? "pending" : "-")}`);
  return {
    ok:true,
    ...j,
    rows,
    odds:data.oddsCount||0,
    preRaceAvailable,
    preRaceUpdated,
    preRaceCapturedAt,
    resultCompleted,
    resultReason,
  };
});

const ok=results.filter(x=>x?.ok).length;
const ng=results.length-ok;
const preRaceTargets = results.filter((x) => x?.ok && !x.final && x.left >= 0);
const preRaceSaved = preRaceTargets.filter((x) => x.preRaceAvailable).length;
const preRaceMissing = preRaceTargets.filter((x) => !x.preRaceAvailable).map((x) => `${x.venue}${x.race}R`);
console.log(JSON.stringify({
  date:now.date,
  jobs:jobs.length,
  ok,
  ng,
  preRaceTargets:preRaceTargets.length,
  preRaceSaved,
  preRaceMissing:preRaceMissing.slice(0,20),
  errors:results.filter(x=>!x?.ok).slice(0,10),
},null,2));
if (ng) process.exitCode=1;
