// 舟券アカデミア：過去1年バックフィル前のK票書式確認
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
  return String(line || "").replace(/\u3000/g, " ");
}

function candidateRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
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

    // 現行スケルトンと同じ候補判定。まだ本番保存には使わない。
    const rowMatch = line.match(/^\s*(\d{2})\s+(\d)\s+(\d{4})\s+/);
    if (!rowMatch || !placeNo || !raceNo) continue;

    const rankText = rowMatch[1];
    const boat = Number(rowMatch[2]);
    const regno = Number(rowMatch[3]);
    const kimarite = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)/)?.[1] || "";
    const head = kimarite ? line.slice(0, line.indexOf(kimarite)) : line;
    const stMatches = [...head.matchAll(/(^|[^\d])([FLＦ]?)\.(\d{2})(?!\d)/g)];
    const lastSt = stMatches.at(-1);
    const stText = lastSt ? `${lastSt[2] || ""}.${lastSt[3]}` : "";

    rows.push({
      lineNo: index + 1,
      placeNo,
      placeName,
      raceNo,
      rankText,
      boat,
      regno,
      stText,
      kimarite,
      rawLine: raw,
    });
  }
  return rows;
}

function printDiagnostics(text, rows) {
  const lines = text.split(/\r?\n/);
  const raceKeys = new Set(rows.map((r) => `${r.placeNo}-${r.raceNo}`));
  const venueKeys = new Set(rows.map((r) => r.placeNo));
  const invalidBoat = rows.filter((r) => r.boat < 1 || r.boat > 6);
  const noSt = rows.filter((r) => !r.stText);
  const noRegno = rows.filter((r) => !Number.isFinite(r.regno) || r.regno <= 0);

  console.log("\n=== K票バックフィル事前診断 ===");
  console.log(`date=${argDate}`);
  console.log(`lines=${lines.length}`);
  console.log(`candidate_rows=${rows.length}`);
  console.log(`candidate_races=${raceKeys.size}`);
  console.log(`candidate_venues=${venueKeys.size}`);
  console.log(`rows_without_st=${noSt.length}`);
  console.log(`invalid_boat_rows=${invalidBoat.length}`);
  console.log(`invalid_regno_rows=${noRegno.length}`);

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
      stText: row.stText,
      kimarite: row.kimarite,
      rawLine: row.rawLine,
    }));
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
      headers: { "user-agent": "HunakenKFileInspector/1.0" },
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
    const rows = candidateRows(text);
    printDiagnostics(text, rows);

    if (!rows.length) {
      console.error("候補行が0件です。パーサ書式が合っていないため、バックフィルへ進めません。");
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
