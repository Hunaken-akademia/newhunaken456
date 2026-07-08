// ============================================================
// 今日の全場全レースについて、出走表のF/L持ち状態を保存するトリガー
// Vercelの /api/yoso?action=prerace を叩くことで、サーバー側がSupabaseへ保存する。
// ============================================================

const BASE_URL = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const argDate = process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
const DRY = process.argv.includes("--dry");

function jstDate() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date()).reduce((a, p) => {
    if (p.type !== "literal") a[p.type] = p.value;
    return a;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const date = argDate || jstDate();
const venues = [
  "桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"
];

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callOne(venue, race) {
  const url = `${BASE_URL}/api/yoso?action=prerace&venue=${encodeURIComponent(venue)}&race=${race}&date=${date}`;
  if (DRY) {
    console.log(`[dry] ${url}`);
    return { ok: true, dry: true };
  }
  const res = await fetch(url, { headers: { "user-agent": "HunakenPreRaceCapture/1.0" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || json?.ok === false) {
    throw new Error(`${res.status} ${json?.error || text.slice(0, 200)}`);
  }
  return json;
}

console.log(`pre_race_status capture start date=${date} base=${BASE_URL} dry=${DRY}`);
let ok = 0;
let fail = 0;

for (const venue of venues) {
  for (let race = 1; race <= 12; race++) {
    try {
      const r = await callOne(venue, race);
      const saved = r?.preRaceStatusSaved;
      console.log(`OK ${venue}${race}R racers=${r?.racersCount ?? "?"} saved=${saved?.count ?? 0}`);
      ok++;
    } catch (e) {
      console.log(`NG ${venue}${race}R ${e.message || e}`);
      fail++;
    }
    await sleep(250);
  }
}

console.log(`pre_race_status capture done ok=${ok} fail=${fail}`);
if (ok === 0 && !DRY) process.exit(1);
