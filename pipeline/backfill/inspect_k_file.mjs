// 舟券アカデミア：過去1年バックフィル前のK票書式確認 v5
// このスクリプトはDBへ一切書き込みません。
// v5: S0/S1/L0/F0などの特殊着順行も1艇分として採用し、
//     6艇揃い判定を欠場・失格・L等でも崩さないようにします。
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

const placeEntries = Object.entries(placeMap).sort((a, b) => b[0].length - a[0].length);

function normalizeLine(line) {
  return String(line || "")
    .replace(/\u3000/g, " ")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/Ｆ/g, "F")
    .replace(/Ｌ/g, "L");
}

function normalizeStText(value) {
  const compact = String(value || "").replace(/\s+/g, "").toUpperCase();
  if (!compact) return "";

  // 例: .13 -> 0.13 / F.01 -> F0.01 / L1.99 -> L1.99
  const fixed = compact.replace(/^([FL])?\./, "$10.");
  const m = fixed.match(/^([FL])?(\d\.\d{2})$/);
  if (!m) return "";
  return `${m[1] || ""}${m[2]}`;
}

function classifyResultStatus(rankText, stText) {
  const r = String(rankText || "").toUpperCase();
  const st = String(stText || "").toUpperCase();

  if (r.startsWith("F") || st.startsWith("F")) return "F";
  if (r.startsWith("L") || st.startsWith("L")) return "L";
  if (r.startsWith("S") || r === "失") return "DISQUALIFIED";
  if (r === "転") return "CAPSIZED";
  if (r === "落") return "FELL";
  if (r === "欠") return "ABSENT";
  if (r === "妨") return "OBSTRUCTION";
  if (r === "不") return "DID_NOT_FINISH";
  return "NORMAL";
}

function isAverageStEligible(rankText, stText) {
  const status = classifyResultStatus(rankText, stText);
  const st = String(stText || "");
  // F/Lは平均STからは除外候補。S/失格はスタートしていれば平均ST候補に残します。
  return Boolean(st) && status !== "F" && status !== "L";
}

function parseResultRow(rawLine) {
  const line = normalizeLine(rawLine).trimEnd();
  const head = line.match(/^\s*(\d{2}|F\d?|L\d?|S\d?|欠|失|転|落|妨|不)\s+([1-6])\s+(\d{4})\s+(.+)$/i);
  if (!head) return null;

  const rankText = head[1];
  const boat = Number(head[2]);
  const regno = Number(head[3]);
  const tail = head[4];

  // K票は5・6着などでレースタイムが「.  .」になることがあります。
  // 平均ST・コース別STのバックフィルでは、レースタイムが無くてもSTと進入があれば必要です。
  const metrics = tail.match(/\s(\d\.\d{2})\s+([1-6])\s+([FL]?\s*(?:(?:\d\.\d{2})|(?:0?\.\d{2})))(?:\s+((?:\d\.\d{2}\.\d)|(?:\.\s*\.)))?\s*$/i);
  if (!metrics) return null;

  const exhibitTime = Number(metrics[1]);
  const course = Number(metrics[2]);
  const stText = normalizeStText(metrics[3]);
  const rawRaceTime = metrics[4] ? String(metrics[4]).replace(/\s+/g, "") : "";
  const raceTime = /^\d\.\d{2}\.\d$/.test(rawRaceTime) ? rawRaceTime : null;
  if (!stText) return null;

  const resultStatus = classifyResultStatus(rankText, stText);

  return {
    rankText,
    boat,
    regno,
    course,
    stText,
    st: Number(stText.replace(/^[FL]/, "")),
    averageStEligible: isAverageStEligible(rankText, stText),
    resultStatus,
    exhibitTime,
    raceTime,
  };
}

function maybePlaceHeader(line) {
  const t = normalizeLine(line).trim();
  if (!t) return null;
  // 場名は「ボートレース○○」の開催場ヘッダーだけで判定します。
  // 例: 「ボートレース唐　津」は空白を詰めて「ボートレース唐津」として読む。
  // これにより、レース名の「福岡選抜」や「津」を含む語で場名が切り替わる誤検出を防ぎます。
  const compact = t.replace(/\s+/g, "");
  if (!compact.includes("ボートレース")) return null;

  for (const [name, no] of placeEntries) {
    if (compact.includes(`ボートレース${name}`)) {
      return { name, no, line: t };
    }
  }

  return null;
}

function maybeRaceHeader(line) {
  const t = normalizeLine(line).trim();
  if (!t) return null;
  if (/^(\d{2}|F\d?|L\d?|S\d?|欠|失|転|落|妨|不)\s+[1-6]\s+\d{4}\s+/i.test(t)) return null;
  const m = t.match(/(?:^|\s)(?:第\s*)?(\d{1,2})\s*(?:R|レース|競走)(?:\s|$)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 1 && n <= 12) return { raceNo: n, line: t };
  return null;
}

function candidateRows(text) {
  const lines = text.split(/\r?\n/);
  const rawRows = [];
  const rows = [];
  const duplicateRows = [];
  const transitions = [];
  let placeNo = null;
  let placeName = "";
  let raceNo = null;
  let lastPlaceLineNo = null;
  let lastRaceLineNo = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = normalizeLine(raw);

    const ph = maybePlaceHeader(line);
    if (ph && ph.no !== placeNo) {
      placeNo = ph.no;
      placeName = ph.name;
      raceNo = null;
      lastPlaceLineNo = index + 1;
      transitions.push({ lineNo: index + 1, type: "PLACE", value: placeName, rawLine: raw });
    }

    const rh = maybeRaceHeader(line);
    if (rh) {
      raceNo = rh.raceNo;
      lastRaceLineNo = index + 1;
      transitions.push({ lineNo: index + 1, type: "RACE", value: `${raceNo}R`, placeName, rawLine: raw });
    }

    if (!placeNo || !raceNo) continue;
    const parsed = parseResultRow(raw);
    if (!parsed) continue;

    const row = {
      lineNo: index + 1,
      placeNo,
      placeName,
      raceNo,
      lastPlaceLineNo,
      lastRaceLineNo,
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

  return { rows, rawRows, duplicateRows, transitions, lines };
}

function rowKey(row) {
  return `${row.placeName}${row.raceNo}R`;
}

function printContext(lines, centerLineNo, before = 8, after = 4) {
  const start = Math.max(1, centerLineNo - before);
  const end = Math.min(lines.length, centerLineNo + after);
  for (let lineNo = start; lineNo <= end; lineNo += 1) {
    const mark = lineNo === centerLineNo ? ">>" : "  ";
    console.log(`${mark}${String(lineNo).padStart(5, " ")}: ${lines[lineNo - 1]}`);
  }
}

function printDiagnostics(text, result) {
  const { rows, rawRows, duplicateRows, transitions, lines } = result;
  const raceKeys = new Set(rows.map((r) => `${r.placeNo}-${r.raceNo}`));
  const venueKeys = new Set(rows.map((r) => r.placeNo));
  const invalidBoat = rows.filter((r) => r.boat < 1 || r.boat > 6);
  const noSt = rows.filter((r) => !r.stText);
  const noRegno = rows.filter((r) => !Number.isFinite(r.regno) || r.regno <= 0);
  const noCourse = rows.filter((r) => !Number.isFinite(r.course) || r.course < 1 || r.course > 6);
  const noRaceTime = rows.filter((r) => !r.raceTime);
  const specialStatusRows = rows.filter((r) => r.resultStatus && r.resultStatus !== "NORMAL");
  const averageStExcludedRows = rows.filter((r) => !r.averageStEligible);

  console.log("\n=== K票バックフィル事前診断 v5 ===");
  console.log(`date=${argDate}`);
  console.log(`lines=${lines.length}`);
  console.log(`candidate_rows_raw=${rawRows.length}`);
  console.log(`duplicate_rows_dropped=${duplicateRows.length}`);
  console.log(`candidate_rows=${rows.length}`);
  console.log(`candidate_races=${raceKeys.size}`);
  console.log(`candidate_venues=${venueKeys.size}`);
  console.log(`rows_without_st=${noSt.length}`);
  console.log(`rows_without_race_time=${noRaceTime.length}`);
  console.log(`special_status_rows=${specialStatusRows.length}`);
  console.log(`average_st_excluded_rows=${averageStExcludedRows.length}`);
  console.log(`invalid_boat_rows=${invalidBoat.length}`);
  console.log(`invalid_regno_rows=${noRegno.length}`);
  console.log(`invalid_course_rows=${noCourse.length}`);

  const perRace = new Map();
  for (const row of rows) perRace.set(rowKey(row), (perRace.get(rowKey(row)) || 0) + 1);
  const counts = [...perRace.entries()];
  const nonSix = counts.filter(([, count]) => count !== 6);
  console.log(`races_with_6_rows=${counts.filter(([, count]) => count === 6).length}`);
  console.log(`races_not_6_rows=${nonSix.length}`);
  if (nonSix.length) console.log("races_not_6_rows_sample=", JSON.stringify(nonSix.slice(0, 30)));

  console.log("\n--- 候補行サンプル（最大24行）---");
  for (const row of rows.slice(0, 24)) {
    console.log(JSON.stringify({
      lineNo: row.lineNo,
      venue: row.placeName,
      race: row.raceNo,
      lastPlaceLineNo: row.lastPlaceLineNo,
      lastRaceLineNo: row.lastRaceLineNo,
      rankText: row.rankText,
      boat: row.boat,
      regno: row.regno,
      course: row.course,
      stText: row.stText,
      resultStatus: row.resultStatus,
      averageStEligible: row.averageStEligible,
      exhibitTime: row.exhibitTime,
      raceTime: row.raceTime,
      rawLine: row.rawLine,
    }));
  }

  if (duplicateRows.length) {
    console.log("\n--- 重複候補サンプル（最大8行）---");
    for (const row of duplicateRows.slice(0, 8)) {
      console.log(JSON.stringify({
        lineNo: row.lineNo,
        venue: row.placeName,
        race: row.raceNo,
        lastPlaceLineNo: row.lastPlaceLineNo,
        lastRaceLineNo: row.lastRaceLineNo,
        boat: row.boat,
        regno: row.regno,
        stText: row.stText,
        resultStatus: row.resultStatus,
        averageStEligible: row.averageStEligible,
        rawLine: row.rawLine,
      }));
    }
  }

  console.log("\n--- 場・レースヘッダー検出履歴（最大80件）---");
  for (const t of transitions.slice(0, 80)) {
    console.log(JSON.stringify(t));
  }

  const contextTargets = [];
  for (const row of duplicateRows.slice(0, 3)) contextTargets.push({ label: `duplicate ${row.placeName}${row.raceNo}R boat${row.boat}`, lineNo: row.lineNo });
  for (const [label] of nonSix.slice(0, 4)) {
    const row = rows.find((r) => rowKey(r) === label);
    if (row) contextTargets.push({ label: `non6 ${label}`, lineNo: row.lineNo });
  }

  if (contextTargets.length) {
    console.log("\n--- 問題候補の周辺コンテキスト ---");
    const printed = new Set();
    for (const target of contextTargets) {
      const bucket = Math.floor(target.lineNo / 20);
      if (printed.has(bucket)) continue;
      printed.add(bucket);
      console.log(`\n[${target.label}] around line ${target.lineNo}`);
      printContext(lines, target.lineNo, 10, 5);
    }
  }

  if (SHOW_RAW) {
    console.log("\n--- 生テキスト先頭160行 ---");
    console.log(lines.slice(0, 160).join("\n"));
  }

  console.log("\nDB_WRITE=NONE");
  console.log("本番race_results・staging・paid_usersには一切書き込んでいません。");
}

async function main() {
  try {
    console.log(`download=${url}`);
    const response = await fetch(url, {
      headers: { "user-agent": "HunakenKFileInspector/1.2" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`K票ダウンロード失敗 status=${response.status} url=${url}`);
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
  } catch (error) {
    console.error("ERROR", error?.stack || error?.message || error);
    process.exit(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
