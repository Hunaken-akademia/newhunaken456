// 舟券アカデミア：過去1年バックフィル前のK票書式確認 v2
// このスクリプトはDBへ一切書き込みません。
// Usage: node pipeline/backfill/inspect_k_file.mjs 2026-07-02 [--raw]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";

const argDate = process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
const SHOW_RAW = process.argv.includes("--raw");

if (!argDate) {
  console.error("日付を YYYY-MM-DD で指定してください。例: node inspect_k_file.mjs 2026-07-02");
  process.exit(1);
}

const [year, month, day] = argDate.split("-");
const yy = year.slice(2);
const yyyymm = `${year}${month}`;
const filename = `k${yy}${month}${day}.lzh`;
const url = `https://www1.mbrace.or.jp/od2/K/${yyyymm}/${filename}`;
const workdir = mkdtempSync(join(tmpdir(), "hunaken-k-inspect-"));
const archivePath = join(workdir, filename);

const placeMap = {
  "桐生": 1, "戸田": 2, "江戸川": 3, "平和島": 4, "多摩川": 5, "浜名湖": 6,
  "蒲郡": 7, "常滑": 8, "津": 9, "三国": 10, "びわこ": 11, "住之江": 12,
  "尼崎": 13, "鳴門": 14, "丸亀": 15, "児島": 16, "宮島": 17, "徳山": 18,
  "下関": 19, "若松": 20, "芦屋": 21, "福岡": 22, "唐津": 23, "大村": 24,
};

function normalizeLine(line) {
  return String(line || "")
    .replace(/\u3000/g, " ")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/Ｆ/g, "F")
    .replace(/Ｌ/g, "L");
}

function normalizeStText(value) {
  const s = String(value || "").replace(/\s+/g, "").replace(/^([FL])?\./, "$10.");
  const m = s.match(/^([FL])?(0\.\d{2})$/);
  if (!m) return "";
  return `${m[1] || ""}${m[2]}`;
}

function parseResultRow(rawLine) {
  const line = normalizeLine(rawLine).trimEnd();

  // K票の着順行は概ね以下の形：
  // 01  3 4071 選手名 46   53  6.85   3    0.23     1.50.3
  // v1では .23 だけを探していたため、0.23 を全て取り逃がしていた。
  const head = line.match(/^\s*(\d{2}|F|L|欠|失|転|落|妨|不)\s+([1-6])\s+(\d{4})\s+(.+)$/);
  if (!head) return null;

  const rankText = head[1];
  const boat = Number(head[2]);
  const regno = Number(head[3]);
  const tail = head[4];

  // 末尾から 展示タイム / 進入 / ST / レースタイム を拾う。
  // レースタイムが無い失格・欠場系は次STEPで別扱いにするため、ここでは安全に候補から外す。
  const metrics = tail.match(/\s(\d\.\d{2})\s+([1-6])\s+([FL]?\s*(?:0?\.\d{2}))\s+(\d\.\d{2}\.\d)\s*$/);
  if (!metrics) return null;

  const exhibitTime = Number(metrics[1]);
  const course = Number(metrics[2]);
  const stText = normalizeStText(metrics[3]);
  const raceTime = metrics[4];
  if (!stText) return null;

  return {
    rankText,
    boat,
    regno,
    course,
    stText,
    st: Number(stText.replace(/^[FL]/, "")),
    exhibitTime,
    raceTime,
  };
}

function candidateRows(text) {
  const lines = text.split(/\r?\n/);
  const rawRows = [];
  const rows = [];
  const duplicateRows = [];
  let placeNo = null;
  let placeName = "";
  let raceNo = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = normalizeLine(raw);

    for (const [name, no] of Object.entries(placeMap)) {
      if (line.includes(name)) {
        placeNo = no;
        placeName = name;
        break;
      }
    }

    const raceMatch = line.match(/(?:^|\s)(\d{1,2})\s*R(?:\s|$)/i);
    if (raceMatch) {
      const n = Number(raceMatch[1]);
      if (n >= 1 && n <= 12) raceNo = n;
    }

    if (!placeNo || !raceNo) continue;
    const parsed = parseResultRow(raw);
    if (!parsed) continue;

    const row = {
      lineNo: index + 1,
      placeNo,
      placeName,
      raceNo,
      ...parsed,
      rawLine: raw,
    };
    rawRows.push(row);
  }

  const seen = new Set();
  for (const row of rawRows) {
    const key = `${row.placeNo}-${row.raceNo}-${row.boat}`;
    if (seen.has(key)) {
      duplicateRows.push(row);
      continue;
    }
    seen.add(key);
    rows.push(row);
  }

  return { rows, rawRows, duplicateRows };
}

function printDiagnostics(text, result) {
  const { rows, rawRows, duplicateRows } = result;
  const lines = text.split(/\r?\n/);
  const raceKeys = new Set(rows.map((r) => `${r.placeNo}-${r.raceNo}`));
  const venueKeys = new Set(rows.map((r) => r.placeNo));
  const invalidBoat = rows.filter((r) => r.boat < 1 || r.boat > 6);
  const noSt = rows.filter((r) => !r.stText);
  const noRegno = rows.filter((r) => !Number.isFinite(r.regno) || r.regno <= 0);
  const noCourse = rows.filter((r) => !Number.isFinite(r.course) || r.course < 1 || r.course > 6);

  console.log("\n=== K票バックフィル事前診断 v2 ===");
  console.log(`date=${argDate}`);
  console.log(`lines=${lines.length}`);
  console.log(`candidate_rows_raw=${rawRows.length}`);
  console.log(`duplicate_rows_dropped=${duplicateRows.length}`);
  console.log(`candidate_rows=${rows.length}`);
  console.log(`candidate_races=${raceKeys.size}`);
  console.log(`candidate_venues=${venueKeys.size}`);
  console.log(`rows_without_st=${noSt.length}`);
  console.log(`invalid_boat_rows=${invalidBoat.length}`);
  console.log(`invalid_regno_rows=${noRegno.length}`);
  console.log(`invalid_course_rows=${noCourse.length}`);

  const perRace = new Map();
  for (const row of rows) {
    const key = `${row.placeName}${row.raceNo}R`;
    perRace.set(key, (perRace.get(key) || 0) + 1);
  }
  const counts = [...perRace.entries()];
  const nonSix = counts.filter(([, count]) => count !== 6);
  console.log(`races_with_6_rows=${counts.filter(([, count]) => count === 6).length}`);
  console.log(`races_not_6_rows=${nonSix.length}`);
  if (nonSix.length) {
    console.log("races_not_6_rows_sample=", JSON.stringify(nonSix.slice(0, 30)));
  }

  console.log("\n--- 候補行サンプル（最大30行）---");
  for (const row of rows.slice(0, 30)) {
    console.log(JSON.stringify({
      lineNo: row.lineNo,
      venue: row.placeName,
      race: row.raceNo,
      rankText: row.rankText,
      boat: row.boat,
      regno: row.regno,
      course: row.course,
      stText: row.stText,
      exhibitTime: row.exhibitTime,
      raceTime: row.raceTime,
      rawLine: row.rawLine,
    }));
  }

  if (duplicateRows.length) {
    console.log("\n--- 重複候補サンプル（最大10行）---");
    for (const row of duplicateRows.slice(0, 10)) {
      console.log(JSON.stringify({
        lineNo: row.lineNo,
        venue: row.placeName,
        race: row.raceNo,
        boat: row.boat,
        regno: row.regno,
        stText: row.stText,
        rawLine: row.rawLine,
      }));
    }
  }

  if (SHOW_RAW) {
    console.log("\n--- 生テキスト先頭120行 ---");
    console.log(lines.slice(0, 120).join("\n"));
  }

  console.log("\nDB_WRITE=NONE");
  console.log("本番race_results・staging・paid_usersには一切書き込んでいません。");
}

async function main() {
  try {
    console.log(`download=${url}`);
    const response = await fetch(url, {
      headers: { "user-agent": "HunakenKFileInspector/1.1" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`K票ダウンロード失敗 status=${response.status} url=${url}`);
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length < 100) throw new Error(`K票ファイルが小さすぎます bytes=${archive.length}`);
    writeFileSync(archivePath, archive);
    console.log(`downloaded_bytes=${archive.length}`);

    execFileSync("lha", ["xfw=" + workdir, archivePath], { stdio: "inherit" });
    const extracted = readdirSync(workdir).find((name) => /\.(txt|dat)$/i.test(name));
    if (!extracted) throw new Error("解凍後のTXT/DATファイルが見つかりません");

    const text = iconv.decode(readFileSync(join(workdir, extracted)), "Shift_JIS");
    const result = candidateRows(text);
    printDiagnostics(text, result);

    if (!result.rows.length) {
      console.error("候補行が0件です。パーサ書式が合っていないため、バックフィルへ進めません。");
      process.exitCode = 2;
    }
    if (result.rows.some((r) => !r.stText)) {
      console.error("ST未取得行があります。バックフィルへ進む前にパーサ修正が必要です。");
      process.exitCode = 2;
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("INSPECT_FAILED", error?.stack || error?.message || String(error));
  process.exit(1);
});
