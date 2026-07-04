// ============================================================
// K票（競走成績）取り込みスクリプト — racesテーブル対応版
// 使い方:
//   node ingest_k.mjs 2026-07-02            # 指定日を取り込み
//   node ingest_k.mjs 2026-07-02 --dry      # DB投入せず中身だけ表示
//   node ingest_k.mjs 2026-07-02 --raw      # 解凍した生テキストの先頭を表示
//
// 必要な環境変数:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import iconv from "iconv-lite";

const argDate = process.argv[2];
const DRY = process.argv.includes("--dry");
const RAW = process.argv.includes("--raw");

if (!argDate || !/^\d{4}-\d{2}-\d{2}$/.test(argDate)) {
  console.error("日付を YYYY-MM-DD で渡してください。例: node ingest_k.mjs 2026-07-02");
  process.exit(1);
}
const [Y, M, D] = argDate.split("-");
const yy = Y.slice(2);

const yyyymm = `${Y}${M}`;
const fname = `k${yy}${M}${D}.lzh`;
const URL = `https://www1.mbrace.or.jp/od2/K/${yyyymm}/${fname}`;

const TMP = "./_tmp_k";
mkdirSync(TMP, { recursive: true });

async function download(url, dest) {
  console.log("↓ download:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ダウンロード失敗 ${res.status} ${url}\n（URL書式が変わっている可能性。--raw前にURLを確認してください）`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log("  saved", buf.length, "bytes");
}

function unpack(lzhPath) {
  execSync(`lha xfw=${TMP} ${lzhPath}`, { stdio: "inherit" });
  const txt = readdirSync(TMP).find((f) => /\.txt$/i.test(f));
  if (!txt) throw new Error("解凍後のテキストが見つかりません。lha の出力を確認してください。");
  return `${TMP}/${txt}`;
}

function normalizeName(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/　/g, "")
    .trim();
}

function parseWeatherWindWave(line) {
  // 例: 1R ... H1800m 曇り 風 西 1m 波 1cm
  // 例: 晴 風 無風 0m 波 0cm
  const normalized = line.replace(/　/g, " ").replace(/\s+/g, " ").trim();
  const m = normalized.match(/\b(晴|曇り|曇|雨|雪|霧|くもり)\b\s*風\s*([^\s]+)\s*(\d+(?:\.\d+)?)m\s*波\s*(\d+(?:\.\d+)?)cm/);
  if (!m) return null;
  return {
    weather: m[1] === "曇" || m[1] === "くもり" ? "曇り" : m[1],
    wind_dir: m[2],
    wind_speed: Number(m[3]),
    wave: Number(m[4]),
  };
}

function parsePostTime(line) {
  // K票に発走時刻が載っていない日もあるため、拾えた場合だけ保存する。
  // 例: 15:23 / 15時23分 のような表記に対応。
  const m1 = line.match(/(\d{1,2}):(\d{2})/);
  if (m1) return `${m1[1].padStart(2, "0")}:${m1[2]}:00`;
  const m2 = line.match(/(\d{1,2})時\s*(\d{2})分/);
  if (m2) return `${m2[1].padStart(2, "0")}:${m2[2]}:00`;
  return null;
}

function parseK(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const races = [];
  let placeNo = null;
  let raceNo = null;
  let currentKimarite = null;

  const placeMap = {
    "桐生":1,"戸田":2,"江戸川":3,"平和島":4,"多摩川":5,"浜名湖":6,"蒲郡":7,"常滑":8,
    "津":9,"三国":10,"びわこ":11,"住之江":12,"尼崎":13,"鳴門":14,"丸亀":15,"児島":16,
    "宮島":17,"徳山":18,"下関":19,"若松":20,"芦屋":21,"福岡":22,"唐津":23,"大村":24,"大　村":24,
  };

  for (const raw of lines) {
    const line = raw.replace(/\u3000/g, " ");

    // 場の判定: ヘッダ行に場名が出る。大　村のような空白入りも吸収。
    const compact = line.replace(/\s+/g, "");
    for (const [name, no] of Object.entries(placeMap)) {
      const n = name.replace(/\s+/g, "");
      if (compact.includes(n)) { placeNo = no; break; }
    }

    // レース番号: "1R" / "12R" の見出し行でレース番号を更新。
    const rm = line.match(/^\s*(\d{1,2})R\b/);
    if (rm) {
      raceNo = Number(rm[1]);
      currentKimarite = null;

      const kmSameLine = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)\s*$/);
      if (kmSameLine) currentKimarite = kmSameLine[1];

      // races用: レース見出し行から天候・風・波を拾う。
      const env = parseWeatherWindWave(line);
      if (placeNo && raceNo && env) {
        races.push({
          race_date: argDate,
          place_no: placeNo,
          race_no: raceNo,
          weather: env.weather,
          wind_dir: env.wind_dir,
          wind_speed: Number.isFinite(env.wind_speed) ? env.wind_speed : null,
          wave: Number.isFinite(env.wave) ? env.wave : null,
          post_time: parsePostTime(line),
          tide_state: null,
          tide_level: null,
        });
      }
      continue;
    }

    // 決まり手: K票では着順行の直前ヘッダー行末尾に出る。
    if (raceNo && /ﾚｰｽﾀｲﾑ|レースタイム/.test(line)) {
      const kmHeader = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)\s*$/);
      if (kmHeader) currentKimarite = kmHeader[1];
      continue;
    }

    // 着順行:
    // 01  2 4724 吉　田　祐　貴 62   52  6.91   2    0.13     1.51.6
    const m = line.match(/^\s*(\d{2})\s+(\d)\s+(\d{4})\s+(.+?)\s+(\d{1,3})\s+(\d{1,3})\s+(\d\.\d{2})\s+(\d)\s+([FLＦＬ]?\s*0?\.\d{2}|[FLＦＬ]?\.\d{2}|[FLＦＬ]?\d\.\d{2})\b/);
    if (m && placeNo && raceNo) {
      const rank = Number(m[1]);
      const boat = Number(m[2]);
      const regno = Number(m[3]);
      const racerName = normalizeName(m[4]);
      const motorNo = Number(m[5]);
      const course = Number(m[8]);
      const stRaw = String(m[9]).replace(/\s+/g, "").replace(/Ｆ/g, "F").replace(/Ｌ/g, "L");
      let st = null;
      let isF = false;
      if (/^F/i.test(stRaw)) {
        const num = stRaw.replace(/^F/i, "");
        st = Number(num.startsWith(".") ? `0${num}` : num);
        if (Number.isFinite(st)) st = -Math.abs(st);
        isF = true;
      } else if (/^L/i.test(stRaw)) {
        st = null;
      } else {
        st = Number(stRaw.startsWith(".") ? `0${stRaw}` : stRaw);
        if (!Number.isFinite(st)) st = null;
      }

      rows.push({
        race_date: argDate,
        place_no: placeNo,
        race_no: raceNo,
        boat,
        regno,
        rank: rank >= 1 && rank <= 6 ? rank : null,
        st,
        is_f: isF,
        kimarite: rank === 1 ? currentKimarite : null,
        course: course >= 1 && course <= 6 ? course : null,
        motor_no: Number.isFinite(motorNo) ? motorNo : null,
        racer_name: racerName || null,
      });
    }
  }
  return { rows, races };
}

function dedupeByKey(items, keyFn, label) {
  const map = new Map();
  let dupes = 0;
  for (const item of items) {
    const key = keyFn(item);
    if (map.has(key)) dupes++;
    map.set(key, { ...map.get(key), ...item });
  }
  if (dupes) console.log(`${label} 重複を除外/統合: ${dupes}件`);
  return [...map.values()];
}

async function upsertTable(table, rows, conflictCols) {
  const SUPA = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA || !KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です");
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const res = await fetch(`${SUPA}/rest/v1/${table}?on_conflict=${conflictCols}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`${table} 投入失敗 ${res.status}: ${await res.text()}`);
    console.log(`  ${table} upsert ${i + batch.length}/${rows.length}`);
  }
}

(async () => {
  try {
    const lzh = `${TMP}/${fname}`;
    await download(URL, lzh);
    const txtPath = unpack(lzh);
    const text = iconv.decode(readFileSync(txtPath), "Shift_JIS");

    if (RAW) {
      console.log("─── 解凍テキスト先頭80行（書式確認用）───");
      console.log(text.split(/\r?\n/).slice(0, 80).join("\n"));
      return;
    }

    let { rows, races } = parseK(text);
    console.log(`race_results パース結果: ${rows.length} 行`);
    console.log(`races パース結果: ${races.length} レース`);
    console.log("race_results サンプル(先頭5件):", JSON.stringify(rows.slice(0, 5), null, 2));
    console.log("races サンプル(先頭5件):", JSON.stringify(races.slice(0, 5), null, 2));

    rows = dedupeByKey(rows, (r) => `${r.race_date}|${r.place_no}|${r.race_no}|${r.boat}`, "race_results");
    races = dedupeByKey(races, (r) => `${r.race_date}|${r.place_no}|${r.race_no}`, "races");

    console.log(`race_results 投入対象: ${rows.length} 行`);
    console.log(`races 投入対象: ${races.length} レース`);

    if (DRY) { console.log("--dry のためDB投入はスキップ"); return; }

    if (races.length) {
      await upsertTable("races", races, "race_date,place_no,race_no");
    }
    if (rows.length) {
      await upsertTable("race_results", rows, "race_date,place_no,race_no,boat");
    }
    console.log("✓ 取り込み完了");
  } catch (e) {
    console.error("エラー:", e.message);
    process.exit(1);
  }
})();
