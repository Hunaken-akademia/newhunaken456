// ============================================================
// 直近180日分 K票バックフィルスクリプト
// GitHub Actions / ローカル両対応
//
// 使い方:
//   node backfill_k.mjs            # JST基準で昨日から180日分を順番に取り込み
//   node backfill_k.mjs --dry      # DB投入せず確認だけ
//
// 前提:
//   同じ pipeline フォルダ内に ingest_k.mjs があること
//   SUPABASE_URL / SUPABASE_SERVICE_KEY は GitHub Secrets に登録済み
// ============================================================
import { spawnSync } from "node:child_process";

const DRY = process.argv.includes("--dry");
const DAYS = 180;

function formatDateJST(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDays(date, diff) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + diff);
  return next;
}

// JSTの「今日」を基準に、昨日から過去180日分を作る
// 古い日付 → 新しい日付の順で取り込む
const now = new Date();
const dates = [];
for (let i = DAYS; i >= 1; i -= 1) {
  dates.push(formatDateJST(addDays(now, -i)));
}

console.log("============================================");
console.log(`K票バックフィル開始: 直近${DAYS}日分`);
console.log(`対象開始日: ${dates[0]}`);
console.log(`対象終了日: ${dates[dates.length - 1]}`);
console.log(DRY ? "モード: dry-run（DB投入なし）" : "モード: 本投入");
console.log("============================================");

let success = 0;
let failed = 0;
const failedDates = [];

for (const date of dates) {
  console.log(`\n--- ${date} 取り込み開始 ---`);

  const args = ["ingest_k.mjs", date];
  if (DRY) args.push("--dry");

  const result = spawnSync("node", args, {
    cwd: new URL(".", import.meta.url).pathname,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status === 0) {
    success += 1;
    console.log(`--- ${date} 取り込み成功 ---`);
  } else {
    failed += 1;
    failedDates.push(date);
    console.error(`--- ${date} 取り込み失敗 status=${result.status} ---`);
    // 1日失敗しても残りの日付は続行する
  }
}

console.log("\n============================================");
console.log(`K票バックフィル完了: 成功 ${success}日 / 失敗 ${failed}日`);
if (failedDates.length > 0) {
  console.log(`失敗日: ${failedDates.join(", ")}`);
}
console.log("============================================");

if (success === 0) {
  console.error("全日失敗したため終了コード1で終了します");
  process.exit(1);
}
