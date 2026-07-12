import { spawnSync } from "node:child_process";

const startDateArg = process.argv[2];
const daysArg = process.argv[3];
const dryArg = process.argv.find((a) => a.startsWith("--dry="));
const DRY = dryArg ? dryArg.split("=")[1] !== "false" : true;
const continueArg = process.argv.find((a) => a.startsWith("--continue-on-error="));
const CONTINUE_ON_ERROR = continueArg ? continueArg.split("=")[1] === "true" : false;

const MAX_DAYS = 180;

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

function pickLineValue(text, key) {
  const re = new RegExp(`${key}=([^\\n\\r]+)`);
  const m = String(text || "").match(re);
  return m ? m[1].trim() : null;
}

function pickJsonAfterLabel(text, label) {
  const re = new RegExp(`${label}\\s*=\\s*(\\[[^\\n\\r]*\\])`);
  const m = String(text || "").match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1];
  }
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

if (CONTINUE_ON_ERROR && !DRY) {
  console.error("安全停止: 洗い出しモード（continue-on-error）は dry=true 専用です。DB保存はしません。");
  process.exit(1);
}

console.log("=== K票 複数日 staging保存 ===");
console.log(`start_date=${startDateArg}`);
console.log(`days=${days}`);
console.log(`dry=${DRY}`);
console.log(`continue_on_error=${CONTINUE_ON_ERROR}`);
console.log("target=STAGING_ONLY");
console.log("本番race_results・paid_usersには一切書き込みません。");
console.log("半年実行対応: 最大180日まで。まずdry=trueで全日検証してください。");
if (CONTINUE_ON_ERROR) {
  console.log("洗い出しモード: エラー日があっても止めず、最後にOK日/NG日を一覧表示します。DB保存はありません。");
}

const summary = [];
for (let i = 0; i < days; i++) {
  const date = addDays(startDateArg, i);
  console.log(`\n--- ${i + 1}/${days} ${date} ---`);
  const result = spawnSync(process.execPath, ["backfill_k_staging_one_day.mjs", date, `--dry=${DRY ? "true" : "false"}`], {
    encoding: "utf8",
    env: process.env,
  });

  const out = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const item = {
    date,
    exitCode: result.status,
    candidate_rows: Number(pickLineValue(out, "candidate_rows")) || null,
    candidate_races: Number(pickLineValue(out, "candidate_races")) || null,
    candidate_venues: Number(pickLineValue(out, "candidate_venues")) || null,
    validation_errors: Number(pickLineValue(out, "validation_errors")) || 0,
    races_not_6_rows: Number(pickLineValue(out, "races_not_6_rows")) || 0,
    races_not_6_rows_sample: pickJsonAfterLabel(out, "races_not_6_rows_sample"),
  };
  summary.push(item);

  if (result.status !== 0 && !CONTINUE_ON_ERROR) {
    console.error(`安全停止: ${date} が exitCode=${result.status} で終了しました。以降の日付は実行しません。`);
    console.log("range_summary=", JSON.stringify(summary));
    process.exit(result.status || 1);
  }
}

const okDates = summary.filter((x) => x.exitCode === 0).map((x) => x.date);
const ngDates = summary.filter((x) => x.exitCode !== 0);

console.log("\n=== K票 複数日 staging保存 完了 ===");
console.log("range_summary=", JSON.stringify(summary));
console.log("ok_dates=", JSON.stringify(okDates));
console.log("ng_dates=", JSON.stringify(ngDates));
console.log(`DB_WRITE=${DRY ? "NONE" : "STAGING_ONLY"}`);
console.log("本番race_results・paid_usersには一切書き込んでいません。");
if (CONTINUE_ON_ERROR) {
  console.log("洗い出し完了: ng_dates に出た日だけ、あとで個別修正します。");
  process.exit(0);
}
