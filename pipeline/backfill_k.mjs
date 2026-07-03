import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DAYS = 365;
const args = process.argv.slice(2);
const dry = args.includes('--dry');

function jstDateString(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function buildRecentDates(days) {
  // JST基準の「昨日」から過去days日分。古い日付から順番に返す。
  const todayJst = jstDateString(new Date());
  const todayUtcMidnight = new Date(`${todayJst}T00:00:00Z`);
  const yesterday = addDays(todayUtcMidnight, -1);

  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(jstDateString(addDays(yesterday, -i)));
  }
  return dates;
}

function runNode(script, scriptArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      cwd: __dirname,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });
}

async function main() {
  const ingestPath = path.join(__dirname, 'ingest_k.mjs');
  const dates = buildRecentDates(DAYS);

  console.log(`backfill recent ${DAYS} days start`);
  console.log(`dry=${dry}`);
  console.log(`from=${dates[0]} to=${dates[dates.length - 1]}`);

  let ok = 0;
  let ng = 0;
  const failed = [];

  for (const date of dates) {
    console.log(`\n===== ${date} start =====`);
    const childArgs = [date];
    if (dry) childArgs.push('--dry');

    const code = await runNode(ingestPath, childArgs);
    if (code === 0) {
      ok += 1;
      console.log(`===== ${date} done =====`);
    } else {
      ng += 1;
      failed.push(date);
      console.error(`===== ${date} failed code=${code} =====`);
    }
  }

  console.log('\nbackfill finished');
  console.log(`ok=${ok} ng=${ng}`);
  if (failed.length) console.log(`failed dates=${failed.join(', ')}`);

  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
