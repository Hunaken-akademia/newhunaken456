// ============================================================
// K票（競走成績）取り込みスクリプト — GitHub Actions / ローカル両対応
// 使い方:
//   node ingest_k.mjs 2026-07-02            # 指定日を取り込み
//   node ingest_k.mjs 2026-07-02 --dry      # DB投入せず中身だけ表示（最初はこれで確認）
//   node ingest_k.mjs 2026-07-02 --raw      # 解凍した生テキストの先頭を表示（書式確認用）
//
// 必要な環境変数（GitHub Actions の Secrets / ローカルは .env や export）:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   ← service_role キー（RLSを越えて書き込むため）
//
// 依存: npm i iconv-lite
// 公式Kファイルは伝統的に LZH(.lzh)。このスクリプトは「lha コマンド」を使う。
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

function parseK(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let placeNo = null, raceNo = null;

  const placeMap = {
    "桐生":1,"戸田":2,"江戸川":3,"平和島":4,"多摩川":5,"浜名湖":6,"蒲郡":7,"常滑":8,
    "津":9,"三国":10,"びわこ":11,"住之江":12,"尼崎":13,"鳴門":14,"丸亀":15,"児島":16,
    "宮島":17,"徳山":18,"下関":19,"若松":20,"芦屋":21,"福岡":22,"唐津":23,"大村":24,
  };

  for (const raw of lines) {
    const line = raw.replace(/\u3000/g, " ");

    for (const [name, no] of Object.entries(placeMap)) {
      if (line.includes(name)) { placeNo = no; break; }
    }

    const rm = line.match(/(\d{1,2})\s*R/);
    if (rm) raceNo = Number(rm[1]);

    const m = line.match(/^\s*(\d{2})\s+(\d)\s+(\d{4})\s+/);
    if (m && placeNo && raceNo) {
      const rank = Number(m[1]);
      const boat = Number(m[2]);
      const regno = Number(m[3]);

      const km = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)/);
      const head = km ? line.slice(0, line.indexOf(km[0])) : line;

      let st = null, isF = false;
      const stMatches = [...head.matchAll(/(^|[^\d])([FLＦ]?)\.(\d{2})(?!\d)/g)];
      if (stMatches.length) {
        const last = stMatches[stMatches.length - 1];
        st = Number(`0.${last[3]}`);
        if (/[FＦ]/.test(last[2])) { isF = true; st = -st; }
        if (/L/i.test(last[2])) { st = null; }
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
        kimarite: km ? km[1] : null,
        course: null,
        motor_no: null,
        racer_name: null,
      });
    }
  }
  return rows;
}

function mergeRow(oldRow, newRow) {
  // 同一キーが同じバッチ内に重複すると Supabase の upsert が 21000 で落ちるため、投入前に1件へ統合する。
  // 後から拾えた値があれば補完。rank/regnoなど基本値は既存優先。
  return {
    ...oldRow,
    regno: oldRow.regno ?? newRow.regno,
    rank: oldRow.rank ?? newRow.rank,
    st: oldRow.st ?? newRow.st,
    is_f: oldRow.is_f || newRow.is_f,
    kimarite: oldRow.kimarite ?? newRow.kimarite,
    course: oldRow.course ?? newRow.course,
    motor_no: oldRow.motor_no ?? newRow.motor_no,
    racer_name: oldRow.racer_name ?? newRow.racer_name,
  };
}

function dedupeRows(rows) {
  const map = new Map();
  let duplicateCount = 0;
  for (const row of rows) {
    const key = `${row.race_date}|${row.place_no}|${row.race_no}|${row.boat}`;
    if (map.has(key)) {
      duplicateCount++;
      map.set(key, mergeRow(map.get(key), row));
    } else {
      map.set(key, row);
    }
  }
  const result = [...map.values()];
  if (duplicateCount) {
    console.log(`重複行を統合: ${duplicateCount}件 → 投入対象 ${result.length}件`);
  }
  return result;
}

async function upsert(rows) {
  const SUPA = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA || !KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です");

  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const res = await fetch(`${SUPA}/rest/v1/race_results?on_conflict=race_date,place_no,race_no,boat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`投入失敗 ${res.status}: ${await res.text()}`);
    console.log(`  upsert ${i + batch.length}/${rows.length}`);
  }
}

(async () => {
  try {
    const lzh = `${TMP}/${fname}`;
    await download(URL, lzh);
    const txtPath = unpack(lzh);
    const text = iconv.decode(readFileSync(txtPath), "Shift_JIS");

    if (RAW) {
      console.log("─── 解凍テキスト先頭60行（書式確認用）───");
      console.log(text.split(/\r?\n/).slice(0, 60).join("\n"));
      return;
    }

    const parsedRows = parseK(text);
    console.log(`パース結果: ${parsedRows.length} 行`);
    console.log("サンプル(先頭5件):", JSON.stringify(parsedRows.slice(0, 5), null, 2));

    const rows = dedupeRows(parsedRows);
    console.log(`投入対象: ${rows.length} 行`);

    if (DRY) { console.log("--dry のためDB投入はスキップ"); return; }
    await upsert(rows);
    console.log("✓ 取り込み完了");
  } catch (e) {
    console.error("エラー:", e.message);
    process.exit(1);
  }
})();
