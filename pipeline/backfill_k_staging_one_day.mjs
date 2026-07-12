import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import iconv from "iconv-lite";

const VERSION = "k-backfill-staging-v5-rank00-other-fix";
const argDate = process.argv[2];
const dryArg = process.argv.find((a) => a.startsWith("--dry="));
const DRY = dryArg ? dryArg.split("=")[1] !== "false" : true;

if (!argDate || !/^\d{4}-\d{2}-\d{2}$/.test(argDate)) {
  console.error("日付を YYYY-MM-DD で渡してください。例: node backfill_k_staging_one_day.mjs 2026-07-02 --dry=true");
  process.exit(1);
}

if (process.env.CAPTURE_TARGET !== "staging") {
  console.error("安全停止: CAPTURE_TARGET=staging のときだけ実行できます");
  process.exit(1);
}

const VENUE_TO_PLACE_NO = {
  "桐生": 1,
  "戸田": 2,
  "江戸川": 3,
  "平和島": 4,
  "多摩川": 5,
  "浜名湖": 6,
  "蒲郡": 7,
  "常滑": 8,
  "津": 9,
  "三国": 10,
  "びわこ": 11,
  "住之江": 12,
  "尼崎": 13,
  "鳴門": 14,
  "丸亀": 15,
  "児島": 16,
  "宮島": 17,
  "徳山": 18,
  "下関": 19,
  "若松": 20,
  "芦屋": 21,
  "福岡": 22,
  "唐津": 23,
  "大村": 24,
};

const PLACE_NO_TO_VENUE = Object.fromEntries(Object.entries(VENUE_TO_PLACE_NO).map(([k, v]) => [v, k]));
const VENUES = Object.keys(VENUE_TO_PLACE_NO).sort((a, b) => b.length - a.length);

function compact(s) {
  return String(s || "").replace(/[\s　]+/g, "");
}

function normalizeKVenueName(rawLine) {
  const s = compact(rawLine);
  for (const name of VENUES) {
    if (s.includes(`ボートレース${name}`)) return name;
  }
  return null;
}

function normalizeNumberText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "." || /^\.\s*\.$/.test(s)) return null;
  if (/^\.\d+$/.test(s)) return `0${s}`;
  return s;
}

function parseNumeric(v) {
  const normalized = normalizeNumberText(v);
  if (normalized == null) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseSt(stText) {
  const raw = String(stText || "").trim();
  const numeric = raw.replace(/^[FL]/i, "");
  return parseNumeric(numeric);
}

function resultStatusFromRankAndSt(rankText, stText) {
  const r = String(rankText || "").trim().toUpperCase();
  const st = String(stText || "").trim().toUpperCase().replace(/\s+/g, "");
  if (r.startsWith("F") || st.startsWith("F")) return "F";
  if (r.startsWith("L") || st.startsWith("L")) return "L";
  if (r.startsWith("K")) return "SCRATCHED";
  if (r.startsWith("欠")) return "ABSENT";
  if (r.startsWith("失")) return "DISQUALIFIED";
  if (r.startsWith("転")) return "CAPSIZED";
  if (r.startsWith("落")) return "FELL";
  if (r.startsWith("妨")) return "OBSTRUCTION";
  if (r.startsWith("不")) return "DID_NOT_FINISH";
  if (r.startsWith("S")) return "OTHER";
  // K票では「00」着順で、STや進入はあるがレースタイムがない行が出ることがあります。
  // これは通常着順(01-06)ではないため、NORMALにせずOTHERとして保持します。
  if (r === "00") return "OTHER";
  if (/^\d{2}$/.test(r)) return "NORMAL";
  return "UNKNOWN";
}

function isAverageStEligible(rankText, stText) {
  const status = resultStatusFromRankAndSt(rankText, stText);
  // F/Lはフライング・出遅れのため通常平均STから除外。
  // S/失格/転覆/落水などは、STが記録されていればスタート済みとして候補に残す。
  return Boolean(stText) && status !== "F" && status !== "L";
}

function finishOrderFromRank(rankText, status) {
  if (status !== "NORMAL") return null;
  const n = Number(rankText);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

function parseResultLine(line) {
  // K票の結果行。rankは 01-06 のほか、F0/L0/S0/S1/転/落/失/妨/不 なども拾う。
  const head = String(line || "").match(/^\s*(\d{2}|F\d?|L\d?|S\d?|K\d?|欠|失|転|落|妨|不)\s+([1-6])\s+(\d{4})\s+(.+)$/i);
  if (!head) return null;

  const rankText = String(head[1]).trim().toUpperCase();
  const boatNo = Number(head[2]);
  const regno = Number(head[3]);
  const tail = head[4];

  // K0/K1 は6艇レースの1艇としてSCRATCHED扱いで保存します。
  // K票には主に2パターンあります。
  // 1) K .         K .        .  .
  // 2) 0.00       K .        .  .  （展示欄だけ0.00、進入欄なし）
  // どちらも展示・進入・STは分析値として使わず、boat/regno/name/motor/boatは保持します。
  if (/^K\d?$/.test(rankText)) {
    // K0/K1 は欠場系の行として6艇レースの1艇に数えます。
    // K票には複数の揺れがあります。
    // 例1: K0  ... K .         K .        .  .
    // 例2: K1  ... 0.00       K .        .  .
    // 例3: K1  ... ０.００      K .        .  .  （全角数字対策）
    // 解析値としては展示・進入・STを使わず、boat/regno/name/motor/boatだけ保持します。
    const halfTail = tail.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const beforeScratchSuffix = halfTail
      .replace(/\s+(?:K\s*\.|(?:0\.00|\d\.\d{2}))\s+K\s*\.\s+\.\s*\.\s*$/i, "")
      .trimEnd();
    const kMatch = beforeScratchSuffix.match(/^(.+?)\s+(\d{1,3})\s+(\d{1,3})$/);
    if (!kMatch) return null;
    const racerName = compact(kMatch[1]);
    const motorNo = Number(kMatch[2]);
    const boatMotorNo = Number(kMatch[3]);
    const resultStatus = resultStatusFromRankAndSt(rankText, "K.");
    return {
      rankText,
      boatNo,
      regno,
      racerName,
      motorNo,
      boatMotorNo,
      exhibitTime: null,
      course: null,
      officialStText: "K.",
      st: null,
      raceTime: null,
      resultStatus,
      averageStEligible: false,
      finishOrder: null,
    };
  }

  // K票は5・6着などでレースタイムが「.  .」になることがあります。
  // 平均ST・コース別STでは、レースタイムが無くてもSTと進入があれば必要です。
  let metrics = tail.match(/\s(\d\.\d{2})\s+([1-6])\s+((?:[FLfl]\s*\.)|(?:[FLfl]?\s*(?:(?:\d\.\d{2})|(?:0?\.\d{2}))))(?:\s+((?:\d\.\d{2}\.\d)|(?:\.\s*\.)))?\s*$/i);
  let metricsNoCourse = null;

  // L1/F1 の一部は、展示タイムはあるが進入欄が空欄で、ST欄だけ「L .」「F .」になる。
  // 例: L1  4 ... 6.69       L .        .  .
  // この場合も6艇の1行として保持し、course=null・st=null・平均ST対象外にする。
  if (!metrics && /^[FL]\d?$/i.test(rankText)) {
    metricsNoCourse = tail.match(/\s(\d\.\d{2})\s+((?:[FLfl]\s*\.))(?:\s+((?:\d\.\d{2}\.\d)|(?:\.\s*\.)))?\s*$/i);
  }

  if (!metrics && !metricsNoCourse) return null;

  const metricIndex = metrics ? metrics.index : metricsNoCourse.index;
  const beforeMetrics = tail.slice(0, metricIndex).trimEnd();
  const nameMotorBoat = beforeMetrics.match(/^(.+?)\s+(\d{1,3})\s+(\d{1,3})$/);
  const racerName = nameMotorBoat ? compact(nameMotorBoat[1]) : null;
  const motorNo = nameMotorBoat ? Number(nameMotorBoat[2]) : null;
  const boatMotorNo = nameMotorBoat ? Number(nameMotorBoat[3]) : null;

  const exhibitTime = Number(metrics ? metrics[1] : metricsNoCourse[1]);
  const course = metrics ? Number(metrics[2]) : null;
  const officialStText = normalizeNumberText(String((metrics ? metrics[3] : metricsNoCourse[2]) || "").replace(/\s+/g, ""));
  const st = parseSt(officialStText);
  const raceTimeRaw = metrics
    ? (metrics[4] ? String(metrics[4]).replace(/\s+/g, "") : "")
    : (metricsNoCourse[3] ? String(metricsNoCourse[3]).replace(/\s+/g, "") : "");
  const raceTime = /^\d\.\d{2}\.\d$/.test(raceTimeRaw) ? raceTimeRaw : null;
  if (!officialStText) return null;

  const resultStatus = resultStatusFromRankAndSt(rankText, officialStText);
  // L0/L1 や F0/F1 は、K票上で ST が「L .」「F .」となり数値を持たない場合があります。
  // その場合も6艇の1行として保持し、st=null・平均ST対象外で保存します。
  if (st == null && resultStatus !== "F" && resultStatus !== "L") return null;
  const averageStEligible = isAverageStEligible(rankText, officialStText);
  const finishOrder = finishOrderFromRank(rankText, resultStatus);

  return {
    rankText,
    boatNo,
    regno,
    racerName,
    motorNo,
    boatMotorNo,
    exhibitTime,
    course,
    officialStText,
    st,
    raceTime,
    resultStatus,
    averageStEligible,
    finishOrder,
  };
}

function parseRows(text, raceDate) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const warnings = [];
  let venueName = null;
  let placeNo = null;
  let raceNo = null;
  let currentKimarite = null;
  let lastPlaceLineNo = null;
  let lastRaceLineNo = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const detectedVenue = normalizeKVenueName(line);
    if (detectedVenue) {
      venueName = detectedVenue;
      placeNo = VENUE_TO_PLACE_NO[detectedVenue];
      raceNo = null;
      currentKimarite = null;
      lastPlaceLineNo = lineNo;
      continue;
    }

    const raceHeader = line.match(/^\s*(\d{1,2})R\s+(.+?)H\d+m\b/);
    if (raceHeader && placeNo) {
      raceNo = Number(raceHeader[1]);
      lastRaceLineNo = lineNo;
      const afterRaceTime = line.includes("レースタイム") ? "" : null;
      currentKimarite = null;
      continue;
    }

    const headerLine = line.includes("着") && line.includes("艇") && line.includes("登番") && line.includes("ﾚｰｽﾀｲﾑ");
    if (headerLine) {
      const parts = line.split("ﾚｰｽﾀｲﾑ");
      currentKimarite = compact(parts[1] || "") || null;
      continue;
    }

    const parsed = parseResultLine(line);
    if (!parsed) continue;

    if (!placeNo || !raceNo) {
      warnings.push({ lineNo, reason: "NO_CONTEXT", rawLine: line });
      continue;
    }

    const {
      rankText,
      boatNo,
      regno,
      racerName,
      motorNo,
      boatMotorNo,
      exhibitTime,
      course,
      officialStText,
      st,
      raceTime,
      resultStatus,
      averageStEligible,
      finishOrder,
    } = parsed;

    rows.push({
      race_date: raceDate,
      place_no: placeNo,
      race_no: raceNo,
      boat_no: boatNo,
      course,
      regno,
      racer_name: racerName || null,
      finish_order: finishOrder,
      official_rank_text: rankText,
      result_status: resultStatus,
      st,
      official_st_text: officialStText,
      is_f: resultStatus === "F",
      kimarite: finishOrder === 1 ? currentKimarite : null,
      is_confirmed: true,
      source: "official_k_lzh",
      source_url: null,
      parser_version: VERSION,
      raw_data: {
        venue_name: venueName,
        rank_text: rankText,
        motor_no: motorNo,
        boat_motor_no: boatMotorNo,
        exhibit_time: exhibitTime,
        race_time: raceTime,
        average_st_eligible: averageStEligible,
        line_no: lineNo,
        last_place_line_no: lastPlaceLineNo,
        last_race_line_no: lastRaceLineNo,
        raw_line: line,
      },
      validation_status: "pending",
      validation_errors: [],
    });
  }

  return { rows, warnings, linesCount: lines.length };
}

function validateRows(rows) {
  const errors = [];
  const raceMap = new Map();
  for (const r of rows) {
    const key = `${r.place_no}-${r.race_no}`;
    if (!raceMap.has(key)) raceMap.set(key, []);
    raceMap.get(key).push(r);

    if (!r.place_no || r.place_no < 1 || r.place_no > 24) errors.push({ type: "bad_place", row: r });
    if (!r.race_no || r.race_no < 1 || r.race_no > 12) errors.push({ type: "bad_race", row: r });
    if (!r.boat_no || r.boat_no < 1 || r.boat_no > 6) errors.push({ type: "bad_boat", row: r });
    if (r.course != null && (r.course < 1 || r.course > 6)) errors.push({ type: "bad_course", row: r });
    if (!r.regno || r.regno <= 0) errors.push({ type: "bad_regno", row: r });
    if (r.result_status === "NORMAL" && (r.course == null || r.st == null)) errors.push({ type: "normal_missing_course_or_st", row: r });
    if (r.st != null && (r.st < -1 || r.st > 2)) errors.push({ type: "bad_st", row: r });
  }

  const racesNot6 = [];
  for (const [key, list] of raceMap.entries()) {
    if (list.length !== 6) racesNot6.push([key, list.length]);
    const boats = new Set(list.map((r) => r.boat_no));
    if (boats.size !== list.length) errors.push({ type: "duplicate_boat_in_race", key, rows: list });
  }

  return { errors, raceMap, racesNot6 };
}

async function download(url, dest) {
  console.log("↓ download:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ダウンロード失敗 ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log("  saved", buf.length, "bytes");
}

function unpack(lzhPath, tmpDir) {
  execSync(`lha xfw=${tmpDir} ${lzhPath}`, { stdio: "inherit" });
  const txt = readdirSync(tmpDir).find((f) => /\.txt$/i.test(f));
  if (!txt) throw new Error("解凍後のテキストが見つかりません");
  return `${tmpDir}/${txt}`;
}

async function supabaseRequest(path, options = {}) {
  const SUPA = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA || !KEY) throw new Error("SUPABASE_URL/VITE_SUPABASE_URL または SUPABASE_SERVICE_KEY が未設定です");
  const res = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function insertCaptureRun(runId, date, summary = {}) {
  await supabaseRequest("capture_runs_staging", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      run_id: runId,
      capture_type: "results",
      target_date: date,
      target_environment: "staging",
      status: "running",
      parser_version: VERSION,
      workflow_name: process.env.GITHUB_WORKFLOW || "backfill-k-staging-one-day",
      workflow_run_id: process.env.GITHUB_RUN_ID || null,
      workflow_attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null,
      summary,
    }),
  });
}

async function finishCaptureRun(runId, status, counts, errorMessage = null) {
  await supabaseRequest(`capture_runs_staging?run_id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      races_processed: counts.races_processed || 0,
      rows_saved: counts.rows_saved || 0,
      warning_count: counts.warning_count || 0,
      failed_count: counts.failed_count || 0,
      summary: counts.summary || {},
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function upsertRows(rows, captureRunId) {
  const chunk = 500;
  let saved = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk).map((r) => ({ ...r, capture_run_id: captureRunId }));
    await supabaseRequest("race_results_staging?on_conflict=race_date,place_no,race_no,boat_no", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    });
    saved += batch.length;
    console.log(`  upsert staging ${saved}/${rows.length}`);
  }
  return saved;
}

(async () => {
  const [Y, M, D] = argDate.split("-");
  const yy = Y.slice(2);
  const yyyymm = `${Y}${M}`;
  const fname = `k${yy}${M}${D}.lzh`;
  const url = `https://www1.mbrace.or.jp/od2/K/${yyyymm}/${fname}`;
  const tmp = `./_tmp_k_backfill_${argDate.replaceAll("-", "")}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const runId = `k-backfill-${argDate}-${Date.now()}`;
  let rows = [];
  let warnings = [];
  let validation;

  try {
    const lzh = `${tmp}/${fname}`;
    await download(url, lzh);
    const txtPath = unpack(lzh, tmp);
    const text = iconv.decode(await import("node:fs").then((fs) => fs.readFileSync(txtPath)), "Shift_JIS");
    const parsed = parseRows(text, argDate);
    rows = parsed.rows;
    warnings = parsed.warnings;
    validation = validateRows(rows);

    const venueCount = new Set(rows.map((r) => r.place_no)).size;
    const raceCount = validation.raceMap.size;
    const specialStatusRows = rows.filter((r) => r.result_status !== "NORMAL").length;
    const avgExcludedRows = rows.filter((r) => r.raw_data && r.raw_data.average_st_eligible === false).length;
    const rowsWithoutRaceTime = rows.filter((r) => !r.raw_data?.race_time).length;

    console.log("=== K票 1日分 staging保存 事前確認 ===");
    console.log(`date=${argDate}`);
    console.log(`dry=${DRY}`);
    console.log(`lines=${parsed.linesCount}`);
    console.log(`candidate_rows=${rows.length}`);
    console.log(`candidate_races=${raceCount}`);
    console.log(`candidate_venues=${venueCount}`);
    console.log(`special_status_rows=${specialStatusRows}`);
    console.log(`average_st_excluded_rows=${avgExcludedRows}`);
    console.log(`rows_without_race_time=${rowsWithoutRaceTime}`);
    console.log(`validation_errors=${validation.errors.length}`);
    console.log(`races_not_6_rows=${validation.racesNot6.length}`);
    if (validation.racesNot6.length) console.log("races_not_6_rows_sample=", JSON.stringify(validation.racesNot6.slice(0, 20)));
    console.log("venue_summary=", JSON.stringify([...new Set(rows.map((r) => r.place_no))].sort((a,b)=>a-b).map((no) => [PLACE_NO_TO_VENUE[no], rows.filter((r)=>r.place_no===no).length])));

    if (validation.errors.length > 0 || validation.racesNot6.length > 0) {
      console.error("安全停止: 検証エラーまたは6艇未満レースがあります。DB保存しません。");
      console.error(JSON.stringify(validation.errors.slice(0, 5), null, 2));
      process.exit(2);
    }

    if (DRY) {
      console.log("DB_WRITE=NONE");
      console.log("dry=true のため、stagingにも本番にも書き込んでいません。");
      return;
    }

    await insertCaptureRun(runId, argDate, {
      source_url: url,
      candidate_rows: rows.length,
      candidate_races: raceCount,
      candidate_venues: venueCount,
      special_status_rows: specialStatusRows,
      average_st_excluded_rows: avgExcludedRows,
      rows_without_race_time: rowsWithoutRaceTime,
    });

    const saved = await upsertRows(rows, runId);
    await finishCaptureRun(runId, "succeeded", {
      races_processed: raceCount,
      rows_saved: saved,
      warning_count: warnings.length,
      failed_count: 0,
      summary: {
        source_url: url,
        candidate_rows: rows.length,
        candidate_races: raceCount,
        candidate_venues: venueCount,
        special_status_rows: specialStatusRows,
        average_st_excluded_rows: avgExcludedRows,
        rows_without_race_time: rowsWithoutRaceTime,
      },
    });

    console.log(`DB_WRITE=STAGING_ONLY rows_saved=${saved} run_id=${runId}`);
    console.log("本番race_results・paid_usersには一切書き込んでいません。");
  } catch (e) {
    console.error("エラー:", e.message);
    if (!DRY) {
      try {
        await finishCaptureRun(runId, "failed", {
          races_processed: validation?.raceMap?.size || 0,
          rows_saved: 0,
          warning_count: warnings.length,
          failed_count: 1,
          summary: { candidate_rows: rows.length },
        }, e.message);
      } catch (inner) {
        console.error("capture_runs_staging failed update also failed:", inner.message);
      }
    }
    process.exit(1);
  }
})();
