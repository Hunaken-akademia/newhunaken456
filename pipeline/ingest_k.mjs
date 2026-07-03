// ============================================================
// K票（競走成績）取り込みスクリプト  —  GitHub Actions / ローカル両対応
// 使い方:
//   node ingest_k.mjs 2026-07-02            # 指定日を取り込み
//   node ingest_k.mjs 2026-07-02 --dry      # DB投入せず中身だけ表示（最初はこれで確認）
//   node ingest_k.mjs 2026-07-02 --raw      # 解凍した生テキストの先頭を表示（書式確認用）
//
// 必要な環境変数（GitHub Actions の Secrets / ローカルは .env や export）:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   ← service_role キー（RLSを越えて書き込むため）
//
// 依存: npm i iconv-lite node-stream-zip lzh-decompress のうち解凍系は環境で調整。
//   公式Kファイルは伝統的に LZH(.lzh)。Node に定番解凍が無いため、
//   このスクリプトは「lha コマンド」を使う（Actions では apt で入る）。
//   → ワークフロー側で: sudo apt-get install -y lhasa
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

// 公式Kファイルの伝統的なURL・ファイル名（要検証。変わっていたらここだけ直す）
//   例) https://www1.mbrace.or.jp/od2/K/YYYYMM/kYYMMDD.lzh
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
  // lha (lhasa) で解凍。展開先 TMP に .txt / .TXT が出る想定。
  execSync(`lha xfw=${TMP} ${lzhPath}`, { stdio: "inherit" });
  const txt = readdirSync(TMP).find((f) => /\.txt$/i.test(f));
  if (!txt) throw new Error("解凍後のテキストが見つかりません。lha の出力を確認してください。");
  return `${TMP}/${txt}`;
}

// ── K票パーサ ──
// K票は固定長・Shift-JIS。場ごとのヘッダ→各レースの着順行、という構造。
// 書式は年代で微妙に違うため、ここは「行を分類して緩く拾う」方式にする。
// 実データを --raw で見て、必要なら列位置を微調整する前提のスケルトン。
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
    // 場の判定: ヘッダ行に場名が出る
    for (const [name, no] of Object.entries(placeMap)) {
      if (line.includes(name)) { placeNo = no; break; }
    }
    // レース番号: 「 1R」「12R」など
    const rm = line.match(/(\d{1,2})\s*R/);
    if (rm) raceNo = Number(rm[1]);

    // 着順データ行: 先頭に着順(1-6)＋艇番＋登録番号…が並ぶ固定長を想定
    //   例: "  01  1 4697 ... .10  逃げ"
    //   ここは実データに合わせて調整するポイント。まずは緩い正規表現で拾う。
    const m = line.match(/^\s*(\d{2})\s+(\d)\s+(\d{4})\s+/);
    if (m && placeNo && raceNo) {
      const rank = Number(m[1]);
      const boat = Number(m[2]);
      const regno = Number(m[3]);
      // 決まり手を先に切り離す（STより後ろにある）
      const km = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)/);
      const head = km ? line.slice(0, line.indexOf(km[0])) : line;
      // ST欄は行の「後方」にある .xx / F.xx（展示タイム 6.xx を誤取得しないよう、
      // 小数点の直前が数字でない = 単独の .xx を、後ろから探す）
      let st = null, isF = false;
      const stMatches = [...head.matchAll(/(^|[^\d])([FLＦ]?)\.(\d{2})(?!\d)/g)];
      if (stMatches.length) {
        const last = stMatches[stMatches.length - 1]; // 後方のものがST
        st = Number(`0.${last[3]}`);
        if (/[FＦ]/.test(last[2])) { isF = true; st = -st; }
        // L（出遅れ）は st を null 扱い（値が信用できない）
        if (/L/i.test(last[2])) { st = null; }
      }
      rows.push({
        race_date: argDate, place_no: placeNo, race_no: raceNo,
        boat, regno, rank: rank >= 1 && rank <= 6 ? rank : null,
        st, is_f: isF, kimarite: km ? km[1] : null,
        course: null, motor_no: null, racer_name: null,
      });
    }
  }
  return rows;
}

async function upsert(rows) {
  const SUPA = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA || !KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です");
  // 500件ずつ upsert（重複は unique 制約で弾く＝再実行しても安全）
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

    const rows = parseK(text);
    console.log(`パース結果: ${rows.length} 行`);
    console.log("サンプル(先頭5件):", JSON.stringify(rows.slice(0, 5), null, 2));

    if (DRY) { console.log("--dry のためDB投入はスキップ"); return; }
    await upsert(rows);
    console.log("✓ 取り込み完了");
  } catch (e) {
    console.error("エラー:", e.message);
    process.exit(1);
  }
})();
