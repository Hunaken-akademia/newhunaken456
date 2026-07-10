// ============================================================
// 全開催場の確定結果（着順・実ST・進入・決まり手・F）をSupabaseへ保存する。
// Vercelの /api/yoso?action=result を叩き、同じレースはupsertで欠損補修する。
// ============================================================

const BASE_URL = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const argDate = process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
const DRY = process.argv.includes("--dry");
const YESTERDAY = process.argv.includes("--yesterday");
const CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || "";

function jstDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce((a, p) => {
    if (p.type !== "literal") a[p.type] = p.value;
    return a;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const date = argDate || jstDate(YESTERDAY ? -1 : 0);
const venues = [
  "桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"
];

const headers = {
  "user-agent": "HunakenRaceResultCapture/1.0",
  ...(CAPTURE_TOKEN ? { "x-capture-token": CAPTURE_TOKEN } : {}),
};

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getJson(url) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || json?.ok === false) {
    throw new Error(`${res.status} ${json?.error || text.slice(0, 240)}`);
  }
  return json || {};
}

async function getRaceNumbers(venue) {
  const url = `${BASE_URL}/api/yoso?action=schedule&venue=${encodeURIComponent(venue)}&date=${date}`;
  if (DRY) {
    console.log(`[dry schedule] ${url}`);
    return Array.from({ length: 12 }, (_, i) => i + 1);
  }
  const data = await getJson(url);
  const nums = (Array.isArray(data.schedule) ? data.schedule : [])
    .map((r) => Number(r?.race || r?.race_no || r))
    .filter((r) => r >= 1 && r <= 12);
  return [...new Set(nums)];
}

async function captureOne(venue, race) {
  const url = `${BASE_URL}/api/yoso?action=result&venue=${encodeURIComponent(venue)}&race=${race}&date=${date}`;
  if (DRY) {
    console.log(`[dry result] ${url}`);
    return { completed: false, dry: true };
  }
  return await getJson(url);
}

console.log(`race_results capture start date=${date} base=${BASE_URL} dry=${DRY} yesterday=${YESTERDAY}`);
let venuesHeld = 0;
let savedRaces = 0;
let pendingRaces = 0;
let failedRaces = 0;
let savedRows = 0;

for (const venue of venues) {
  let races = [];
  try {
    races = await getRaceNumbers(venue);
  } catch (e) {
    console.log(`SCHEDULE NG ${venue}: ${e.message || e} / 1〜12Rを直接確認します`);
    races = Array.from({ length: 12 }, (_, i) => i + 1);
  }

  if (!races.length) {
    console.log(`SKIP ${venue}: 未開催`);
    continue;
  }
  venuesHeld++;

  for (const race of races) {
    let succeeded = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await captureOne(venue, race);
        if (DRY) {
          succeeded = true;
          break;
        }
        if (data.completed) {
          const count = Number(data.resultSaved?.count || data.rowsCount || 0);
          console.log(`SAVED ${venue}${race}R rows=${count} ST=${data.stCount ?? "?"} F=${data.fCount ?? "?"} 決まり手=${data.kimarite || "-"}`);
          savedRaces++;
          savedRows += count;
        } else {
          console.log(`PENDING ${venue}${race}R ${data.reason || "結果未確定"}`);
          pendingRaces++;
        }
        succeeded = true;
        break;
      } catch (e) {
        if (attempt < 2) {
          await sleep(1200);
          continue;
        }
        console.log(`NG ${venue}${race}R ${e.message || e}`);
        failedRaces++;
      }
    }
    if (!succeeded && DRY) break;
    await sleep(220);
  }
}

console.log(`race_results capture done date=${date} venuesHeld=${venuesHeld} savedRaces=${savedRaces} savedRows=${savedRows} pending=${pendingRaces} failed=${failedRaces}`);
if (!DRY && savedRaces === 0 && failedRaces > 0) process.exit(1);
