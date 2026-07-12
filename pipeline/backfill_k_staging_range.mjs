import { spawnSync } from "node:child_process";

const startDateArg = process.argv[2];
const daysArg = process.argv[3];
const dryArg = process.argv.find((a) => a.startsWith("--dry="));
const DRY = dryArg ? dryArg.split("=")[1] !== "false" : true;

const MAX_DAYS = 14;

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function toUtcDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatUtcDate(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function addDays(iso, n) {
  const dt = toUtcDate(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return formatUtcDate(dt);
}

if (!isIsoDate(startDateArg)) {
  console.error("開始日を YYYY-MM-DD で渡してください。例: node backfill_k_staging_range.mjs 2026-07-02 7 --dry=true");
  process.exit(1);
}

const days = Number(daysArg);
if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
  console.error(`日数は1〜${MAX_DAYS}で指定してください。指定値=${daysArg}`);
  process.exit(1);
}

if (process.env.CAPTURE_TARGET !== "staging") {
  console.error("安全停止: CAPTURE_TARGET=staging のときだけ実行できます");
  process.exit(1);
}

console.log("=== K票 複数日 staging保存 ===");
console.log(`start_date=${startDateArg}`);
console.log(`days=${days}`);
console.log(`dry=${DRY}`);
console.log("target=STAGING_ONLY");
console.log("本番race_results・paid_usersには一切書き込みません。");

const summary = [];
for (let i = 0; i < days; i++) {
  const date = addDays(startDateArg, i);
  console.log(`\n--- ${i + 1}/${days} ${date} ---`);
  const result = spawnSync(process.execPath, ["backfill_k_staging_one_day.mjs", date, `--dry=${DRY ? "true" : "false"}`], {
    stdio: "inherit",
    env: process.env,
  });
  summary.push({ date, exitCode: result.status });
  if (result.status !== 0) {
    console.error(`安全停止: ${date} が exitCode=${result.status} で終了しました。以降の日付は実行しません。`);
    console.log("range_summary=", JSON.stringify(summary));
    process.exit(result.status || 1);
  }
}

console.log("\n=== K票 複数日 staging保存 完了 ===");
console.log("range_summary=", JSON.stringify(summary));
console.log(`DB_WRITE=${DRY ? "NONE" : "STAGING_ONLY"}`);
console.log("本番race_results・paid_usersには一切書き込んでいません。");
