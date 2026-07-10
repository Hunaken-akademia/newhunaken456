const STATIC_CACHE_MS = 3 * 60 * 1000;
const SCHEDULE_CACHE_MS = 3 * 60 * 1000;
const ODDS_CACHE_MS = 60 * 1000;
const STALE_CACHE_MS = 30 * 60 * 1000;
// 復習用：発売終了後も翌朝の朝一レース前まで共有キャッシュを返す。
// 正確な翌朝1R時刻が取れない場合に備え、JST翌日09:00まで保持する。
const REVIEW_CACHE_STALE_MS = 18 * 60 * 60 * 1000;
const CACHE_MS = STATIC_CACHE_MS;

// Vercelの同一実行環境内で共有するキャッシュ。
// 同じ場・日付・RはTTL内ならBOATCASTへ再アクセスせず、取得中は他ユーザーへ古いキャッシュを返す。
const cacheStore = globalThis.__HUNAKEN_YOSO_CACHE_V115__ || new Map();
globalThis.__HUNAKEN_YOSO_CACHE_V115__ = cacheStore;
const inFlightStore = globalThis.__HUNAKEN_YOSO_INFLIGHT_V115__ || new Map();
globalThis.__HUNAKEN_YOSO_INFLIGHT_V115__ = inFlightStore;

const SUPABASE_REST_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ENABLE_PERSISTENT_CACHE = !!(SUPABASE_REST_URL && SUPABASE_SERVICE_KEY);

function parseCacheKey(key) {
  const rawParts = String(key || "").split(":");
  const cacheType = rawParts[0] || "unknown";
  const parts = /^v\d+$/i.test(rawParts[1] || "")
    ? [rawParts[0], ...rawParts.slice(2)]
    : rawParts;
  if (cacheType === "full" || cacheType === "odds") {
    return { cacheType, venue: parts[1] || "", raceNo: Number(parts[2]) || null, ymd: parts[3] || "" };
  }
  if (cacheType === "schedule") {
    return { cacheType, venue: parts[1] || "", raceNo: null, ymd: parts[2] || "" };
  }
  return { cacheType, venue: "", raceNo: null, ymd: "" };
}

function ymdToDate(ymd) {
  const s = String(ymd || "").replace(/\D/g, "");
  return /^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null;
}

function nextMorningReviewExpiryIso(ymd) {
  const raceDate = ymdToDate(ymd);
  if (!raceDate) return new Date(Date.now() + REVIEW_CACHE_STALE_MS).toISOString();
  // JST翌日09:00 = UTC同日24:00相当ではなく、Date.UTCでJSTを補正
  const [y, m, d] = raceDate.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + 1, 0, 0, 0); // JST翌日09:00
  const t = Math.max(utc, Date.now() + STALE_CACHE_MS);
  return new Date(t).toISOString();
}

function persistentStaleExpiryForKey(key, ttlMs, staleMs) {
  const meta = parseCacheKey(key);
  if ((meta.cacheType === 'full' || meta.cacheType === 'schedule') && meta.ymd) {
    return nextMorningReviewExpiryIso(meta.ymd);
  }
  return new Date(Date.now() + staleMs).toISOString();
}


const PLACE_NO_BY_VENUE = {
  "桐生": 1, "戸田": 2, "江戸川": 3, "平和島": 4, "多摩川": 5, "浜名湖": 6,
  "蒲郡": 7, "常滑": 8, "津": 9, "三国": 10, "びわこ": 11, "住之江": 12,
  "尼崎": 13, "鳴門": 14, "丸亀": 15, "児島": 16, "宮島": 17, "徳山": 18,
  "下関": 19, "若松": 20, "芦屋": 21, "福岡": 22, "唐津": 23, "大村": 24,
};

function parseFLCount(flText, letter) {
  const s = String(flText || "").replace(/[Ｆ]/g, "F").replace(/[Ｌ]/g, "L").replace(/\s+/g, "");
  const re = new RegExp(`${letter}(\\d*)`, "i");
  const m = s.match(re);
  if (!m) return 0;
  const n = Number(m[1] || 1);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

function preRaceRowsFromRacers({ venue, raceNo, ymd, racers, source = "BOATCAST" }) {
  const raceDate = ymdToDate(ymd);
  const placeNo = PLACE_NO_BY_VENUE[venue];
  if (!raceDate || !placeNo || !Array.isArray(racers) || racers.length === 0) return [];

  return racers
    .filter((r) => r && Number(r.boat) >= 1 && Number(r.boat) <= 6)
    .map((r) => {
      const fCount = parseFLCount(r.fl, "F");
      const lCount = parseFLCount(r.fl, "L");
      const preAvgST = numberOrNull(r.avgST);
      return {
        race_date: raceDate,
        place_no: placeNo,
        race_no: Number(raceNo),
        boat: Number(r.boat),
        regno: r.regNo ? Number(r.regNo) : null,
        racer_name: r.name || null,
        f_count: fCount,
        l_count: lCount,
        f_hold: fCount > 0,
        l_hold: lCount > 0,
        pre_avg_st: Number.isFinite(preAvgST) ? preAvgST : null,
        source,
        captured_at: new Date().toISOString(),
      };
    })
    .filter((r) => r.regno && Number.isFinite(r.regno));
}


function exhibitionRowsFromDisplay({ venue, raceNo, ymd, rows, source = "BOATCAST" }) {
  const raceDate = ymdToDate(ymd);
  const placeNo = PLACE_NO_BY_VENUE[venue];
  if (!raceDate || !placeNo || !Array.isArray(rows) || rows.length === 0) return [];

  const numericRows = rows
    .filter((r) => r && Number(r.boat) >= 1 && Number(r.boat) <= 6)
    .map((r) => {
      const exTime = numberOrNull(r.tenji);
      const lap = numberOrNull(r.isshu);
      const turn = numberOrNull(r.mawari);
      const straight = numberOrNull(r.chokusen);
      const total = [exTime, lap, turn, straight].every((v) => Number.isFinite(v))
        ? exTime + lap + turn + straight
        : ([exTime, lap, turn].every((v) => Number.isFinite(v)) ? exTime + lap + turn : null);
      return { raw: r, exTime, lap, turn, straight, total };
    });

  const exVals = numericRows.map((r) => r.exTime).filter((v) => Number.isFinite(v));
  const totalVals = numericRows.map((r) => r.total).filter((v) => Number.isFinite(v));
  const exAvg = exVals.length ? exVals.reduce((a, b) => a + b, 0) / exVals.length : null;
  const totalAvg = totalVals.length ? totalVals.reduce((a, b) => a + b, 0) / totalVals.length : null;

  const rankBy = (key) => {
    const sorted = numericRows
      .filter((r) => Number.isFinite(r[key]))
      .sort((a, b) => a[key] - b[key]);
    const out = new Map();
    sorted.forEach((r, i) => out.set(Number(r.raw.boat), i + 1));
    return out;
  };
  const exRank = rankBy('exTime');
  const totalRank = rankBy('total');

  return numericRows.map(({ raw, exTime, lap, turn, straight, total }) => {
    const racer = raw.racer || {};
    const boat = Number(raw.boat);
    const course = Number(raw.course || boat);
    return {
      race_date: raceDate,
      place_no: placeNo,
      race_no: Number(raceNo),
      boat,
      course: Number.isFinite(course) && course >= 1 && course <= 6 ? course : boat,
      regno: racer.regNo ? Number(racer.regNo) : null,
      racer_name: racer.name || null,
      ex_time: Number.isFinite(exTime) ? exTime : null,
      lap: Number.isFinite(lap) ? lap : null,
      turn: Number.isFinite(turn) ? turn : null,
      straight: Number.isFinite(straight) ? straight : null,
      total_time: Number.isFinite(total) ? total : null,
      ex_rank: exRank.get(boat) || null,
      total_rank: totalRank.get(boat) || null,
      ex_diff: Number.isFinite(exTime) && Number.isFinite(exAvg) ? Number((exAvg - exTime).toFixed(3)) : null,
      total_diff: Number.isFinite(total) && Number.isFinite(totalAvg) ? Number((totalAvg - total).toFixed(3)) : null,
      source,
      captured_at: new Date().toISOString(),
    };
  }).filter((r) => r.regno && (r.ex_time != null || r.lap != null || r.turn != null || r.straight != null));
}

async function saveExhibitionRows({ venue, raceNo, ymd, rows, source = "BOATCAST" }) {
  if (!ENABLE_PERSISTENT_CACHE) return { ok: false, skipped: true, reason: "SUPABASE_SERVICE_KEYなし" };
  const payload = exhibitionRowsFromDisplay({ venue, raceNo, ymd, rows, source });
  if (!payload.length) return { ok: false, skipped: true, reason: "保存対象なし" };
  try {
    await supabaseCacheRequest("exhibition?on_conflict=race_date,place_no,race_no,boat", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload),
    });
    return { ok: true, count: payload.length };
  } catch (e) {
    console.warn("exhibition write skipped:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function savePreRaceStatus({ venue, raceNo, ymd, racers, source = "BOATCAST" }) {
  if (!ENABLE_PERSISTENT_CACHE) return { ok: false, skipped: true, reason: "SUPABASE_SERVICE_KEYなし" };
  const rows = preRaceRowsFromRacers({ venue, raceNo, ymd, racers, source });
  if (!rows.length) return { ok: false, skipped: true, reason: "保存対象なし" };
  try {
    await supabaseCacheRequest("pre_race_status?on_conflict=race_date,place_no,race_no,boat", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return { ok: true, count: rows.length };
  } catch (e) {
    console.warn("pre_race_status write skipped:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function fetchBoatcastPreRaceStatusPayload(venue, raceNo, ymd) {
  const urls = boatcastRaceUrls(venue, raceNo, ymd);
  if (!urls) throw new Error(`${venue}の場コードが見つかりません`);
  const str3 = await fetchHtml(urls.str3);
  const racers = parseBoatcastRacerInfo(str3);
  const saved = await savePreRaceStatus({ venue, raceNo, ymd, racers, source: "BOATCAST_STR3" });
  return {
    ok: true,
    action: "prerace",
    appVersion: "v115",
    venue,
    race: Number(raceNo),
    date: ymd,
    source: "BOATCAST_STR3",
    racersCount: racers.length,
    preRaceStatusSaved: saved,
    fetchedAt: new Date().toISOString(),
  };
}

async function supabaseCacheRequest(path, options = {}) {
  if (!ENABLE_PERSISTENT_CACHE) return null;
  const res = await fetch(`${SUPABASE_REST_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase cache ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

async function readPersistentCache(key) {
  if (!ENABLE_PERSISTENT_CACHE) return null;
  try {
    const rows = await supabaseCacheRequest(`yoso_cache?cache_key=eq.${encodeURIComponent(key)}&select=payload,created_at,updated_at,expires_at,stale_expires_at&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.payload) return null;
    const now = Date.now();
    const expiresAt = Date.parse(row.expires_at || "");
    const staleExpiresAt = Date.parse(row.stale_expires_at || "");
    const updatedAt = Date.parse(row.updated_at || row.created_at || "") || now;
    return {
      data: row.payload,
      savedAt: updatedAt,
      fresh: Number.isFinite(expiresAt) && now < expiresAt,
      stale: Number.isFinite(staleExpiresAt) && now < staleExpiresAt,
    };
  } catch (e) {
    console.warn("persistent cache read skipped:", e?.message || e);
    return null;
  }
}

async function writePersistentCache(key, data, ttlMs, staleMs) {
  if (!ENABLE_PERSISTENT_CACHE) return;
  try {
    const meta = parseCacheKey(key);
    const now = Date.now();
    const body = [{
      cache_key: key,
      cache_type: meta.cacheType,
      race_date: ymdToDate(meta.ymd),
      venue: meta.venue || null,
      race_no: meta.raceNo,
      payload: data,
      expires_at: new Date(now + ttlMs).toISOString(),
      stale_expires_at: persistentStaleExpiryForKey(key, ttlMs, staleMs),
      updated_at: new Date(now).toISOString(),
    }];
    await supabaseCacheRequest("yoso_cache?on_conflict=cache_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("persistent cache write skipped:", e?.message || e);
  }
}

function dataCacheNotice(source) {
  return "";
}

function cacheDecorate(entry, ttlMs, flags = {}) {
  const now = Date.now();
  const ageMs = Math.max(0, now - Number(entry?.savedAt || 0));
  const data = entry?.data || {};
  return {
    ...data,
    cached: true,
    stale: !!flags.stale,
    refreshing: !!flags.refreshing,
    waitedForInflight: !!flags.waitedForInflight,
    cacheStatus: flags.stale ? "stale" : "fresh",
    cacheAgeSec: Math.floor(ageMs / 1000),
    cacheTtlSec: Math.max(0, Math.ceil((ttlMs - ageMs) / 1000)),
    fetchedAt: data.fetchedAt || new Date(entry?.savedAt || now).toISOString(),
    servedAt: new Date(now).toISOString(),
    cacheWarning: flags.cacheWarning || data.cacheWarning || "",
  };
}

async function withSharedCache(key, ttlMs, fetcher, options = {}) {
  const staleMs = options.staleMs || STALE_CACHE_MS;
  const now = Date.now();
  const cached = cacheStore.get(key);
  const ageMs = cached ? now - Number(cached.savedAt || 0) : Infinity;

  if (cached && ageMs < ttlMs) {
    return cacheDecorate(cached, ttlMs, { cacheWarning: dataCacheNotice("memory") });
  }

  const persistent = await readPersistentCache(key);
  if (persistent?.fresh) {
    cacheStore.set(key, { savedAt: persistent.savedAt, data: persistent.data });
    return cacheDecorate({ savedAt: persistent.savedAt, data: persistent.data }, ttlMs, { cacheWarning: dataCacheNotice("supabase") });
  }

  const inFlight = inFlightStore.get(key);
  if (inFlight) {
    if (cached && ageMs < staleMs) {
      return cacheDecorate(cached, ttlMs, { stale: true, refreshing: true });
    }
    try {
      const data = await inFlight;
      return { ...data, waitedForInflight: true };
    } catch (e) {
      if (cached && ageMs < staleMs) {
        return cacheDecorate(cached, ttlMs, {
          stale: true,
          cacheWarning: `取得中データの更新失敗のため前回キャッシュを返却: ${e?.message || e}`,
        });
      }
      throw e;
    }
  }

  if (persistent?.stale && options.allowStale !== false) {
    const staleEntry = { savedAt: persistent.savedAt, data: persistent.data };
    cacheStore.set(key, staleEntry);
    // 古いキャッシュを即返しつつ、バックグラウンド更新は次回アクセス時に任せる。
    return cacheDecorate(staleEntry, ttlMs, { stale: true, cacheWarning: "復習用キャッシュ" });
  }

  const promise = (async () => {
    const data = await fetcher();
    const entry = { savedAt: Date.now(), data };
    cacheStore.set(key, entry);
    await writePersistentCache(key, data, ttlMs, staleMs);
    return {
      ...data,
      cached: false,
      stale: false,
      refreshing: false,
      cacheStatus: "refreshed",
      cacheTtlSec: Math.floor(ttlMs / 1000),
      fetchedAt: data.fetchedAt || new Date(entry.savedAt).toISOString(),
      servedAt: new Date().toISOString(),
    };
  })();

  inFlightStore.set(key, promise);
  try {
    return await promise;
  } catch (e) {
    if (cached && ageMs < staleMs) {
      return cacheDecorate(cached, ttlMs, {
        stale: true,
        cacheWarning: `取得失敗のため前回データを表示しています: ${e?.message || e}`,
      });
    }
    throw e;
  } finally {
    if (inFlightStore.get(key) === promise) inFlightStore.delete(key);
  }
}

function decodeEntities(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&minus;|&#8722;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function pickText(s) {
  return decodeEntities(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textLinesFromHtml(s) {
  return decodeEntities(s)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(td|th|tr|p|li|dt|dd|div|span|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\t\r]+/g, "\n")
    .split(/\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normNum(v) {
  const t = pickText(v).replace(/[−ー─]/g, "-");
  if (!t || t === "-" || t === "―") return "";
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : "";
}

function yyyymmdd(dateStr) {
  const s = String(dateStr || "").replace(/\D/g, "");
  if (/^\d{8}$/.test(s)) return s;
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

const JCD = {
  "桐生": "01", "戸田": "02", "江戸川": "03", "平和島": "04", "多摩川": "05", "浜名湖": "06",
  "蒲郡": "07", "常滑": "08", "津": "09", "三国": "10", "びわこ": "11", "住之江": "12",
  "尼崎": "13", "鳴門": "14", "丸亀": "15", "児島": "16", "宮島": "17", "徳山": "18",
  "下関": "19", "若松": "20", "芦屋": "21", "福岡": "22", "唐津": "23", "大村": "24",
};

// 江戸川はBOATCAST側にオリジナル展示（一周・まわり足・直線）が無いため、
// 展示補正は画面上も内部計算上も使わない。
const NO_ORIGINAL_DISPLAY_VENUES = new Set(["江戸川"]);

// BOATCASTのstr3には性別が明示されないため、登録番号・ユーザー提供の女子選手名一覧で判定する。
const FEMALE_RACER_REGNOS = new Set([
  "3175", "3207", "3232", "3289", "3302", "3334", "3355", "3357", "3435", "3470", "3474", "3509",
  "3518", "3528", "3551", "3579", "3580", "3604", "3611", "3618", "3645", "3704", "3778", "3801",
  "3845", "3871", "3900", "3932", "3943", "3993", "3994", "3999", "4011", "4014", "4017", "4045",
  "4050", "4065", "4071", "4098", "4117", "4123", "4183", "4190", "4208", "4224", "4225", "4240",
  "4243", "4244", "4246", "4275", "4283", "4286", "4289", "4300", "4304", "4313", "4317", "4347",
  "4349", "4372", "4373", "4385", "4387", "4399", "4400", "4408", "4414", "4419", "4433", "4443",
  "4447", "4450", "4456", "4464", "4473", "4478", "4479", "4482", "4484", "4499", "4501", "4502",
  "4510", "4519", "4525", "4530", "4534", "4536", "4546", "4548", "4556", "4569", "4589", "4590",
  "4611", "4627", "4642", "4678", "4680", "4689", "4690", "4694", "4714", "4720", "4726", "4730",
  "4733", "4738", "4744", "4746", "4758", "4764", "4765", "4773", "4775", "4781", "4784", "4791",
  "4804", "4819", "4823", "4825", "4843", "4844", "4845", "4853", "4854", "4874", "4878", "4882",
  "4884", "4885", "4891", "4893", "4897", "4900", "4901", "4909", "4924", "4927", "4936", "4938",
  "4940", "4941", "4947", "4961", "4963", "4964", "4965", "4974", "4984", "4987", "4990", "4994",
  "4997", "4998", "5003", "5013", "5019", "5030", "5045", "5052", "5056", "5057", "5069", "5072",
  "5078", "5079", "5088", "5108", "5113", "5117", "5118", "5123", "5129", "5140", "5144", "5146",
  "5148", "5151", "5153", "5155", "5156", "5162", "5163", "5164", "5165", "5171", "5173", "5174",
  "5180", "5182", "5184", "5188", "5189", "5192", "5193", "5194", "5195", "5198", "5200", "5202",
  "5203", "5204", "5205", "5213", "5215", "5218", "5227", "5230", "5231", "5241", "5248", "5250",
  "5251", "5254", "5264", "5265", "5272", "5277", "5281", "5283", "5287", "5291", "5295", "5296",
  "5297", "5305", "5306", "5310", "5314", "5317", "5320", "5322", "5324", "5326", "5327", "5334",
  "5335", "5340", "5342", "5346", "5347", "5357", "5358", "5360", "5361", "5362", "5365", "5367",
  "5370", "5373", "5380", "5387", "5389", "5390", "5391", "5397", "5399", "5406", "5410", "5412",
  "5413", "5414", "5415", "5416", "5418", "5428", "5435", "5436", "5437", "5438", "5439", "5440",
  "5442", "5444", "5446", "5447", "5451", "5454", "5459", "5461", "5462", "5464", "5471", "5472"
]);

function normalizeRacerNameForFemaleCheck(name) {
  return String(name || "")
    .replace(/[\s　]+/g, "")
    .replace(/[・･]/g, "")
    .trim();
}

const FEMALE_RACER_NAMES = new Set([
  "大山 千広", "守屋 美穂", "平高 奈菜", "西橋 奈未",
  "高田 ひかる", "中村 桃佳", "平山 智加", "小野 生奈",
  "遠藤 エミ", "高憧 四季", "實森 美祐", "土屋 南",
  "清水 愛海", "倉持 莉々", "長嶋 万記", "川井 萌",
  "富樫 麗加", "鎌倉 涼", "浜田 亜理沙", "竹井 奈美",
  "松本 晶恵", "魚谷 香織", "清水 沙樹", "渡邉 優美",
  "野田 彩加", "今井 美亜", "深尾 巴恵", "西岡 育未",
  "神里 琴音", "塩崎 桐加", "勝浦 真帆", "田口 節子",
  "米丸 乃絵", "薮内 瑞希", "小芦 るり華", "宇野 弥生",
  "井上 遥妃", "平川 香織", "野田 なづき", "深川 麻奈美",
  "北村 寧々", "佐々木 裕美", "西岡 成美", "戸敷 晃美",
  "喜多須 杏奈", "堀之内 紀代子", "大豆生田 蒼", "中村 かなえ",
  "寺田 千恵", "刑部 亜里紗", "出口 舞有子", "山下 夏鈴",
  "関野 文", "香川 素子", "内山 七海", "藤原 菜希",
  "福岡 泉水", "武井 莉里佳", "大瀧 明日香", "野田部 宏子",
  "西村 美智子", "柴田 百恵", "安井 瑞紀", "前田 紗希",
  "海野 ゆかり", "小池 礼乃", "落合 直子", "廣中 智紗衣",
  "中田 夕貴", "川野 芽唯", "山崎 小葉音", "土屋 実沙希",
  "松尾 夏海", "山田 理央", "松田 真実", "土屋 蘭",
  "櫻本 あゆみ", "山下 友貴", "細川 裕子", "宮崎 つぐみ",
  "藤崎 小百合", "中川 りな", "山口 真喜子", "田上 凜",
  "登 みひ果", "水野 望美", "上田 紗奈", "西村 歩",
  "大久保 佑香", "来田 衣織", "山川 波乙", "清埜 翔子",
  "津田 裕絵", "赤井 睦", "土屋 千明", "三浦 永理",
  "門田 栞", "蜂須 瑞生", "中谷 朋子", "樋口 由加里",
  "瀧川 千依", "山川 美由紀", "宮崎 安奈", "山本 梨菜",
  "谷口 佳蓮", "谷川 里江", "池田 奈津美", "藤堂 里香",
  "原田 佑実", "加藤 綾", "森下 愛梨", "湯淺 紀香",
  "宇恵 有香", "岩崎 芳美", "豊田 結", "滝川 真由子",
  "永田 楽", "井上 未都", "大石 真央", "池田 浩美",
  "長尾 萌加", "鈴木 成美", "金田 幸子", "孫崎 百世",
  "寺田 空詩", "島田 なぎさ", "西田 和加", "伊藤 玲奈",
  "若狭 奈美子", "森 陽多", "五反田 忍", "喜井 つかさ",
  "龍田 真白", "松尾 怜実", "中澤 宏奈", "後藤 美翼",
  "永井 聖美", "石原 凪紗", "淺田 千亜希", "平田 さやか",
  "橋谷田 佳織", "冨名腰 桃奈", "前原 哉", "向井 美鈴",
  "樋江井 舞", "中尾 彩香", "大橋 由珠", "高石 梨菜",
  "中尾 優香", "真子 奈津実", "角 ひとみ", "大橋 栄里佳",
  "渡辺 千草", "奥村 明日香", "犬童 千秋", "藤原 早菜",
  "小野 桜", "今井 裕梨", "島倉 都", "千葉 真弥",
  "黒澤 めぐみ", "古賀 千晶", "坂野 さくら", "向井田 真紀",
  "藤本 紗弥香", "西舘 果里", "坂 咲友理", "高橋 淳美",
  "小林 愛実", "清水 未唯", "黒明 花夢", "村上 奈穂",
  "福山 恵里奈", "深見 亜由美", "三松 直美", "木村 紗友希",
  "増本 杏珠", "石丸 小槙", "高田 綾", "西澤 日花里",
  "中里 優子", "松瀬 弘美", "植木 美帆", "大廣 咲季",
  "本田 愛", "倉田 郁美", "片岡 恵里", "吉田 彩乃",
  "寺島 美里", "矢野 真梨菜", "原 加央理", "池田 紫乃",
  "白石 有美", "三嶌 さらら", "加藤 奈月", "新田 芳美",
  "飯塚 響", "佐藤 ほのか", "中曽 瑠華", "羽田 妃希",
  "篠木 亜衣花", "中北 涼", "中村 紋夕梨", "嶋田 有里",
  "赤井 星璃菜", "赤澤 文香", "田中 博子", "渡邉 真奈美",
  "田村 美和", "松本 怜", "池 千夏", "仁科 さやか",
  "間庭 菜摘", "稲生 夏季", "水口 由紀", "滝沢 織寧",
  "大澤 真菜", "根岸 真優", "三嶌 こころ", "諏訪 玲奈",
  "石村 日奈那", "高橋 涼夏", "井澤 聖奈", "河内 悠利杏",
  "金子 千穂", "樫葉 新心", "高木 茉白", "本部 めぐみ",
  "川原 愛未", "喜多 那由夏", "安達 美帆", "菅野 はやか",
  "鈴木 祐美子", "武藤 綾子", "藤田 美代", "福島 陽子",
  "南 彩寧", "吉田 杏美", "寺田 夢生", "赤松 咲香",
  "中嶋 世奈", "筒井 美琴", "山下 奈緒", "笠野 友紀恵",
  "濱崎 寿里矢", "柴田 愛梨", "沼田 七華", "石井 裕美",
  "恵良 琴美", "岩崎 麗子", "出穂 和鼓", "日隈 茜",
  "長野 未来", "植竹 玲奈", "森田 梨湖", "今泉 澪",
  "田中 結", "志賀 美優", "中西 月輝", "伊藤 栞",
  "小畑 楓夏", "池田 美優", "宮城 那菜", "田中 瀬里奈",
  "坂本 奈央", "林 風音", "戸田 海咲音", "中澤 英里",
  "久保田 凪紗", "畑田 希咲", "薗頭 心", "原村 百那",
  "星田 夢結", "岡本 亜子", "古園井 綾南", "堀内 亜海",
  "野田 亜湖", "中川 海虹", "山浦 槙", "中澤 里桜",
  "田中 きら", "知念 伶奈", "市川 瑚幸", "宮田 栞",
  "谷島 咲希", "板頭 里緒", "長嶺 真李愛", "阿部 未侑",
  "蜂須 瑞希", "刑部 亜里沙", "土屋 美沙希", "真子 奈津美",
  "来田 依織", "石原 凪沙", "原 加央里"
].map(normalizeRacerNameForFemaleCheck));

const MALE_RACER_NAME_EXCLUSIONS = new Set([
  normalizeRacerNameForFemaleCheck("木村 仁紀"),
]);

function isLikelyFemaleRacer(regNo, name) {
  const reg = String(regNo || "").replace(/\D/g, "");
  const n = normalizeRacerNameForFemaleCheck(name);

  // 誤判定防止。男子でも「紀」「希」などで終わる名前があるため、
  // 名前の雰囲気による補助判定は使わず、登録番号またはユーザー提供リストだけで判定する。
  if (n && MALE_RACER_NAME_EXCLUSIONS.has(n)) return false;
  if (FEMALE_RACER_REGNOS.has(reg)) return true;
  if (!n) return false;
  return FEMALE_RACER_NAMES.has(n);
}

function windKeyFromDirectionAndSpeed(direction, speedValue) {
  const speed = Number(speedValue || 0);
  const dir = String(direction || "").replace("向い風", "向かい風");
  if (!speed || speed <= 0) return "無風";
  if (!dir) return "";
  if (dir.includes("左横風")) return `左横風${speed >= 3 ? "3m以上" : `${Math.round(speed)}m`}`;
  if (dir.includes("右横風")) return `右横風${speed >= 3 ? "3m以上" : `${Math.round(speed)}m`}`;
  if (dir.includes("向かい風")) return `向かい風${speed >= 5 ? "5m以上" : `${Math.round(speed)}m`}`;
  if (dir.includes("追い風")) return `追い風${speed >= 5 ? "5m以上" : `${Math.round(speed)}m`}`;
  return "";
}

function directionFromText(raw) {
  const t = pickText(raw);
  if (/左\s*横\s*風/.test(t)) return "左横風";
  if (/右\s*横\s*風/.test(t)) return "右横風";
  if (/向\s*(?:かい)?\s*風|向い風/.test(t)) return "向かい風";
  if (/追\s*い?\s*風/.test(t)) return "追い風";
  return "";
}

// 見えている本文に複数の風向き語が混在する場合は、説明文・凡例・隠し要素の可能性がある。
// その場合は「文字判定」として採用せず、実際の風アイコンへフォールバックする。
function uniqueDirectionFromVisibleText(raw) {
  const t = pickText(raw);
  const found = new Set();
  if (/左\s*横\s*風/.test(t)) found.add("左横風");
  if (/右\s*横\s*風/.test(t)) found.add("右横風");
  if (/向\s*(?:かい)?\s*風|向い風/.test(t)) found.add("向かい風");
  if (/追\s*い?\s*風/.test(t)) found.add("追い風");
  return found.size === 1 ? [...found][0] : "";
}

// BOAT RACE公式 beforeinfo の is-windN は、現在の水面気象欄に表示される実アイコン。
// 以前の実装は generic な "weather1" まで方向番号1として拾ってしまい、
// 実際の is-windN と無関係に追い風/向かい風が固定・反転することがあった。
// 根本対策として、方向番号は明示的な風アイコン属性・ファイル名からだけ取得する。
const DEFAULT_WIND_IMAGE_DIRECTION_MAP = {
  1: "追い風", 2: "右横風", 3: "右横風", 4: "向かい風",
  5: "向かい風", 6: "左横風", 7: "左横風", 8: "追い風",
};

function windImageDirectionFromNumber(n) {
  return DEFAULT_WIND_IMAGE_DIRECTION_MAP[Number(n)] || "";
}

function stripNonWeatherMarkup(raw) {
  return String(raw || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
}

function exactWindIconNumber(raw) {
  const html = stripNonWeatherMarkup(raw);
  const patterns = [
    // 公式の代表例: class="... is-wind3 ..."
    /\bis[-_]?wind(?:--|-|_)?0?([1-8])\b/i,
    // data-wind="3" / data-wind-direction="3"
    /\bdata-(?:wind|wind-direction|wind-dir|wind-icon|wind-arrow)=["']0?([1-8])["']/i,
    // wind-direction-3 / wind_icon_3 など、方向用途が明示されたトークン
    /\bwind(?:-direction|-dir|-icon|-arrow|_direction|_dir|_icon|_arrow)[-_]?0?([1-8])\b/i,
    // 画像ファイル名: /wind3.png, /kaze_3.svg
    /\/(?:wind|kaze)[-_]?0?([1-8])\.(?:png|svg|gif|webp)(?:[?"']|$)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function directionFromImgToken(html, venue = "") {
  const raw = stripNonWeatherMarkup(html);
  const low = raw.toLowerCase();

  // 文字は、現在の水面気象ブロック内で1種類だけ確認できた時のみ信頼する。
  const direct = uniqueDirectionFromVisibleText(raw);
  if (direct) return { direction: direct, raw: direct, confidence: "text" };

  // 明示的な属性名は番号より優先。
  if (/left[-_\s]?cross|cross[-_\s]?left|hidari|leftside|wind[_-]?l/.test(low)) return { direction: "左横風", raw: "left-cross", confidence: "attr" };
  if (/right[-_\s]?cross|cross[-_\s]?right|migi|rightside|wind[_-]?r/.test(low)) return { direction: "右横風", raw: "right-cross", confidence: "attr" };
  if (/head[-_\s]?wind|mukai|against|wind[_-]?u/.test(low)) return { direction: "向かい風", raw: "headwind", confidence: "attr" };
  if (/tail[-_\s]?wind|oi[-_\s]?kaze|oikaze|following|wind[_-]?d/.test(low)) return { direction: "追い風", raw: "tailwind", confidence: "attr" };

  const n = exactWindIconNumber(raw);
  if (n != null) {
    return { direction: windImageDirectionFromNumber(n), raw: `is-wind-${n}@${venue || "default"}`, confidence: "number" };
  }
  return { direction: "", raw: "", confidence: "none" };
}

function parseWeather(html, venue = "") {
  const text = pickText(html);
  const windSpeed = text.match(/風速\s*([0-9]+(?:\.[0-9]+)?)\s*m/i)?.[1] || "";
  const temp = text.match(/気温\s*([0-9]+(?:\.[0-9]+)?)\s*℃/)?.[1] || "";
  const waterTemp = text.match(/水温\s*([0-9]+(?:\.[0-9]+)?)\s*℃/)?.[1] || "";
  const wave = text.match(/波高\s*([0-9]+(?:\.[0-9]+)?)\s*cm/)?.[1] || "";

  const idx = html.search(/水面気象|風速|weather1|気象/i);
  const section = idx >= 0 ? html.slice(Math.max(0, idx - 3500), idx + 6500) : html;
  const dir = directionFromImgToken(section, venue);
  const windKey = windKeyFromDirectionAndSpeed(dir.direction, windSpeed);
  return {
    windSpeed,
    windDirection: dir.direction,
    windKey,
    windRaw: dir.raw,
    windConfidence: dir.confidence,
    temp,
    waterTemp,
    wave,
  };
}



function normalizeBoatcastWindDirection(raw) {
  const t = String(raw || "").replace(/\s+/g, "");
  if (!t) return "";
  if (t.includes("無風")) return "無風";
  if (/向い風|向かい風|向風/.test(t)) return "向かい風";
  if (/追い風|追風/.test(t)) return "追い風";
  if (/左横風/.test(t)) return "左横風";
  if (/右横風/.test(t)) return "右横風";
  return "";
}

function parseBoatcastResultWeather(raw) {
  const text = decodeEntities(String(raw || ""));
  if (!text || /エラーが発生しました|<html/i.test(text)) return {};
  const lines = text.replace(/\r/g, "\n").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const cells = line.includes("\t") ? line.split("\t").map((c) => c.trim()) : line.split(/[ 　]+/).map((c) => c.trim()).filter(Boolean);
    const windIdx = cells.findIndex((c) => /(無風|向い風|向かい風|追い風|左横風|右横風)/.test(c));
    if (windIdx < 0) continue;
    const directionRaw = cells[windIdx];
    const windDirection = normalizeBoatcastWindDirection(directionRaw);
    const windSpeed = normNum(cells[windIdx + 1] || "");
    const wave = normNum(cells[windIdx - 1] || "");
    const temp = normNum(String(cells[windIdx + 2] || "").replace(/^\+/, ""));
    const waterTemp = normNum(String(cells[windIdx + 3] || "").replace(/^\+/, ""));
    const windKey = windKeyFromDirectionAndSpeed(windDirection, windSpeed);
    return {
      windSpeed,
      windDirection,
      windKey,
      windRaw: directionRaw,
      windConfidence: "text",
      temp,
      waterTemp,
      wave,
    };
  }
  return {};
}

function weatherConfidenceRank(conf) {
  const c = String(conf || "");
  if (c === "text") return 4;
  if (c === "attr") return 3;
  if (c === "number") return 1;
  return 0;
}

function mergeWeatherPreferReliable(baseWeather, officialWeather) {
  const base = baseWeather || {};
  const official = officialWeather || {};
  const merged = { ...base };

  // 気温・水温・波高など、風向き判定に関係ない項目は欠けている時だけ補完。
  for (const k of ["temp", "waterTemp", "wave"]) {
    if ((merged[k] === "" || merged[k] == null) && official[k] !== "" && official[k] != null) merged[k] = official[k];
  }

  // 風速は数値なので、公式側に値があってローカル側が空なら補完。
  if ((merged.windSpeed === "" || merged.windSpeed == null) && official.windSpeed !== "" && official.windSpeed != null) {
    merged.windSpeed = official.windSpeed;
  }

  const baseRank = weatherConfidenceRank(base.windConfidence);
  const officialRank = weatherConfidenceRank(official.windConfidence);

  // 重要: 公式beforeinfoの風向き画像番号は場によって4分類への丸めがズレることがある。
  // 各場公式ページ側に「左横風/右横風/向かい風/追い風」の文字がある場合はそちらを最優先。
  // 文字判定(text)や属性判定(attr)を、画像番号(number)で上書きしない。
  const shouldUseOfficialDirection = !!official.windDirection && (
    !base.windDirection || officialRank > baseRank ||
    (officialRank === baseRank && officialRank >= 3)
  );

  if (shouldUseOfficialDirection) {
    merged.windDirection = official.windDirection;
    merged.windRaw = official.windRaw;
    merged.windConfidence = official.windConfidence;
  }

  // 選ばれた風向＋風速でwindKeyを必ず再計算する。方向不明のまま無風扱いにしない。
  merged.windKey = windKeyFromDirectionAndSpeed(merged.windDirection, merged.windSpeed);
  if (!merged.windKey && official.windKey && !merged.windDirection && Number(merged.windSpeed || 0) <= 0) {
    merged.windKey = official.windKey;
  }

  return merged;
}

function isNumText(x) {
  return /^-?\d+(?:\.\d+)?$/.test(String(x || "").replace(/kg$/i, ""));
}
function n(x) { return Number(String(x || "").replace(/kg$/i, "")); }
function inRange(x, a, b) { const v = n(x); return Number.isFinite(v) && v >= a && v <= b; }

function pickDisplayValues(nums) {
  const cleaned = nums.map((x) => String(x).replace(/kg$/i, "")).filter(isNumText);
  for (let i = 0; i < cleaned.length; i++) {
    // 基本: 体重, チルト, 展示, 一周, まわり足 [, 直線]
    // BOATCASTの一部場では「まわり足」が11秒台になるため、15秒まで許容する。
    if (inRange(cleaned[i], 40, 70) && inRange(cleaned[i + 1], -1, 3.5) && inRange(cleaned[i + 2], 5.5, 7.8) && inRange(cleaned[i + 3], 30, 45) && inRange(cleaned[i + 4], 4, 15)) {
      const t = Number(cleaned[i + 1]);
      return { weight: cleaned[i], tilt: (t <= 0.5 ? Number(t).toFixed(1) : ""), tenji: cleaned[i + 2], isshu: cleaned[i + 3], mawari: cleaned[i + 4], chokusen: inRange(cleaned[i + 5], 4, 15) ? cleaned[i + 5] : "" };
    }
    // 調整が体重とチルトの間にある場合: 体重, 調整, チルト, 展示, 一周, まわり足 [, 直線]
    if (inRange(cleaned[i], 40, 70) && inRange(cleaned[i + 1], 0, 5) && inRange(cleaned[i + 2], -1, 3.5) && inRange(cleaned[i + 3], 5.5, 7.8) && inRange(cleaned[i + 4], 30, 45) && inRange(cleaned[i + 5], 4, 15)) {
      const t = Number(cleaned[i + 2]);
      return { weight: cleaned[i], adjust_weight: cleaned[i + 1], tilt: (t <= 0.5 ? Number(t).toFixed(1) : ""), tenji: cleaned[i + 3], isshu: cleaned[i + 4], mawari: cleaned[i + 5], chokusen: inRange(cleaned[i + 6], 4, 15) ? cleaned[i + 6] : "" };
    }
    // 調整が展示と一周の間にある場合: 体重, チルト, 展示, 調整, 一周, まわり足 [, 直線]
    if (inRange(cleaned[i], 40, 70) && inRange(cleaned[i + 1], -1, 3.5) && inRange(cleaned[i + 2], 5.5, 7.8) && inRange(cleaned[i + 3], 0, 5) && inRange(cleaned[i + 4], 30, 45) && inRange(cleaned[i + 5], 4, 15)) {
      const t = Number(cleaned[i + 1]);
      return { weight: cleaned[i], tilt: (t <= 0.5 ? Number(t).toFixed(1) : ""), tenji: cleaned[i + 2], adjust_weight: cleaned[i + 3], isshu: cleaned[i + 4], mawari: cleaned[i + 5], chokusen: inRange(cleaned[i + 6], 4, 15) ? cleaned[i + 6] : "" };
    }
  }
  return null;
}

function parseDisplayRowsByLines(html, venue) {
  const lines = textLinesFromHtml(html);
  const headerIdx = lines.findIndex((line) => /展示タイム|オリジナル展示|まわり足|直線|一周/.test(line));
  const searchFrom = headerIdx >= 0 ? headerIdx : 0;
  const rows = [];
  const boatStarts = [];

  for (let i = searchFrom; i < lines.length; i++) {
    const b = Number(lines[i]);
    if (b >= 1 && b <= 6) {
      const ahead = lines.slice(i + 1, i + 10).join(" ");
      // 級別/登録番号や選手名行が続く場所を優先。単なる前走成績のR/進入は除外。
      if (/[AB][12]?|\d{4}|\/|支部|年齢/.test(ahead) && lines[i - 1] !== "R") {
        if (!boatStarts.some((x) => x.boat === b)) boatStarts.push({ boat: b, idx: i });
      }
    }
  }

  for (let boat = 1; boat <= 6; boat++) {
    const cur = boatStarts.find((x) => x.boat === boat);
    if (!cur) continue;
    const next = boatStarts.find((x) => x.boat === boat + 1);
    const block = lines.slice(cur.idx + 1, next ? next.idx : lines.length);
    const nums = block.map((line) => line.replace(/kg$/i, "")).filter(isNumText).filter((line) => n(line) >= -1 && n(line) <= 60);
    const picked = pickDisplayValues(nums);
    if (!picked) continue;
    rows.push({ boat, course: boat, ...picked });
  }

  rows.sort((a, b) => a.boat - b.boat);
  if (rows.length < 6) throw new Error(`${venue}の展示データが6艇分ありません（${rows.length}艇分）`);
  return rows.slice(0, 6);
}

function parseHeiwajimaYoso05(html) {
  try {
    return parseMarugameYoso05(html);
  } catch (e) {
    return parseDisplayRowsByLines(html, "平和島");
  }
}

function parseKojimaYoso05(html) {
  try {
    return parseMarugameYoso05(html);
  } catch (e) {
    return parseDisplayRowsByLines(html, "児島");
  }
}


function parseSuminoeSt02(html) {
  const lines = textLinesFromHtml(html);
  const raw = lines.join("\n");

  const courseMap = {};
  const courseMatch = raw.match(/進入コース[\s\S]{0,80}?\[1回目\]\s*([1-6])([1-6])([1-6])[\.・\s]*([1-6])([1-6])([1-6])/);
  if (courseMatch) {
    courseMatch.slice(1).forEach((boat, idx) => { courseMap[Number(boat)] = idx + 1; });
  }

  const headerIdx = lines.findIndex((line) => /体重/.test(line) && /チルト/.test(line) && /展示/.test(line));
  const searchFrom = headerIdx >= 0 ? headerIdx : 0;
  const boatStarts = [];

  for (let i = searchFrom; i < lines.length; i++) {
    const b = Number(lines[i]);
    if (Number.isInteger(b) && b >= 1 && b <= 6) {
      const ahead = lines.slice(i + 1, i + 8).join(" ");
      if (/^[AB][12]?\/\d{4}/.test(String(lines[i + 1] || "")) && /支部|年齢|期\/|\/.*\/\d+/.test(ahead) && !boatStarts.some((x) => x.boat === b)) {
        boatStarts.push({ boat: b, idx: i });
      }
    }
  }

  const rows = [];
  for (let boat = 1; boat <= 6; boat++) {
    const cur = boatStarts.find((x) => x.boat === boat);
    if (!cur) continue;
    const next = boatStarts.find((x) => x.boat === boat + 1);
    const block = lines.slice(cur.idx + 1, next ? next.idx : lines.length);
    const nums = [];
    for (const line of block) {
      const t = String(line || "").replace(/kg$/i, "").trim();
      if (isNumText(t)) nums.push(t);
    }

    let picked = null;
    for (let i = 0; i < nums.length; i++) {
      // 住之江 st02: 体重, チルト, 展示, 一周, まわり足 [, 調整]
      if (inRange(nums[i], 40, 70) && inRange(nums[i + 1], -1, 3.5) && inRange(nums[i + 2], 5.5, 7.8) && inRange(nums[i + 3], 30, 45) && inRange(nums[i + 4], 4, 15)) {
        picked = {
          weight: nums[i],
          tilt: nums[i + 1],
          tenji: nums[i + 2],
          isshu: nums[i + 3],
          mawari: nums[i + 4],
          chokusen: "",
        };
        break;
      }
    }
    if (!picked) continue;
    rows.push({ boat, course: courseMap[boat] || boat, ...picked });
  }

  rows.sort((a, b) => a.boat - b.boat);
  if (rows.length < 6) throw new Error(`住之江の展示データが6艇分ありません（${rows.length}艇分）`);
  return rows.slice(0, 6);
}

function parseMarugameYoso05(html) {
  try {
    const start = html.indexOf('id="yoso03_03"');
    if (start < 0) throw new Error("section not found");
    let end = html.indexOf('id="yoso03_04"', start);
    if (end < 0) end = html.length;
    const section = html.slice(start, end);

    const bodies = [...section.matchAll(/<tbody>[\s\S]*?<\/tbody>/gi)].map((m) => m[0]);
    const rows = [];
    for (const body of bodies) {
      const boat = body.match(/<td[^>]*rowspan=["']2["'][^>]*>\s*([1-6])\s*<\/td>/i)?.[1];
      if (!boat) continue;

      const marker = body.lastIndexOf('</div>\n        </div>\n    </td>');
      const tail = marker >= 0 ? body.slice(marker) : body;
      const cells = [...tail.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => normNum(m[1])).filter(Boolean);
      const picked = pickDisplayValues(cells);
      if (!picked) continue;
      rows.push({ boat: Number(boat), course: Number(boat), ...picked });
    }

    rows.sort((a, b) => a.boat - b.boat);
    if (rows.length >= 6) return rows.slice(0, 6);
  } catch (e) {
    // 下のテキスト解析にフォールバック
  }
  return parseDisplayRowsByLines(html, "丸亀");
}

function parseGamagoriRecomend(html) {
  const preRows = {};
  const preRe = /<td[^>]*rowspan=["']2["'][^>]*class=["'][^"']*cho_waku[^"']*r([1-6])[^"']*["'][^>]*>[\s\S]*?<\/td>\s*<td[^>]*class=["'][^"']*cho_time[^"']*["'][^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class=["'][^"']*cho_weight[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*class=["'][^"']*cho_tilt[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = preRe.exec(html)) !== null) {
    const boat = Number(m[1]);
    if (!preRows[boat]) {
      preRows[boat] = { boat, weight: normNum(m[3]), tilt: normNum(m[4]) };
    }
  }

  const key = "オリジナル展示タイム";
  let start = html.indexOf(key);
  if (start < 0) start = html.indexOf("<!--展示情報/オリジナル展示タイム-->");
  if (start < 0) throw new Error("蒲郡のオリジナル展示タイム欄が見つかりません");
  let end = html.indexOf('<div id="come2"', start);
  if (end < 0) end = html.indexOf('<!--高橋', start);
  if (end < 0) end = html.length;
  const section = html.slice(start, end);

  const rows = [];
  const rowRe = /<tr>[\s\S]*?<td[^>]*class=["'][^"']*cho_course[^"']*["'][^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class=["'][^"']*cho_waku[^"']*r([1-6])[^"']*["'][^>]*>([\s\S]*?)<\/td>([\s\S]*?)<\/tr>/gi;
  while ((m = rowRe.exec(section)) !== null) {
    const course = Number(normNum(m[1]) || "");
    const boat = Number(m[2] || normNum(m[3]) || "");
    if (!boat) continue;
    const vals = [...m[4].matchAll(/<td[^>]*class=["'][^"']*ori_time[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)].map((x) => normNum(x[1]));
    if (vals.length < 4) continue;
    rows.push({
      boat,
      course: course || boat,
      weight: preRows[boat]?.weight || "",
      tilt: preRows[boat]?.tilt || "",
      tenji: vals[0] || "",
      isshu: vals[1] || "",
      mawari: vals[2] || "",
      chokusen: vals[3] || "",
    });
  }

  rows.sort((a, b) => a.boat - b.boat);
  if (rows.length < 6) throw new Error(`蒲郡の展示データが6艇分ありません（${rows.length}艇分）`);
  return rows.slice(0, 6);
}

function parseShimonosekiCyokuzen(html) {
  const lines = textLinesFromHtml(html);
  const headerIdx = lines.findIndex((line) => /展示タイム|オリジナル展示|級別\/登録番号|まわり足|直線|一周/.test(line));
  const searchFrom = headerIdx >= 0 ? headerIdx : 0;
  const rows = [];

  for (let boat = 1; boat <= 6; boat++) {
    const start = lines.findIndex((line, i) => i >= searchFrom && line === String(boat) && (i === 0 || lines[i - 1] !== "R"));
    if (start < 0) continue;
    const next = lines.findIndex((line, i) => i > start && line === String(boat + 1));
    const block = lines.slice(start + 1, next > start ? next : lines.length);
    const nums = block
      .map((line) => line.replace(/kg$/i, ""))
      .filter((line) => /^-?\d+(?:\.\d+)?$/.test(line))
      .filter((line) => {
        const v = Number(line);
        return v >= -1 && v <= 60;
      });

    let picked = null;
    for (let i = 0; i < nums.length; i++) {
      const a = nums.slice(i, i + 8);
      // 体重, チルト, 展示, 一周, まわり足, 直線
      if (inRange(a[0], 40, 60) && inRange(a[1], -1, 3.5) && inRange(a[2], 6, 7.8) && inRange(a[3], 30, 45) && inRange(a[4], 4, 13) && inRange(a[5], 5, 9)) {
        picked = { weight: a[0], tilt: a[1], tenji: a[2], isshu: a[3], mawari: a[4], chokusen: a[5] };
        break;
      }
      // 体重, 調整, チルト, 展示, 一周, まわり足, 直線
      if (inRange(a[0], 40, 60) && inRange(a[1], 0, 5) && inRange(a[2], -1, 3.5) && inRange(a[3], 6, 7.8) && inRange(a[4], 30, 45) && inRange(a[5], 4, 13) && inRange(a[6], 5, 9)) {
        picked = { weight: a[0], tilt: a[2], tenji: a[3], isshu: a[4], mawari: a[5], chokusen: a[6] };
        break;
      }
    }
    if (!picked) continue;
    rows.push({ boat, course: boat, ...picked });
  }

  rows.sort((a, b) => a.boat - b.boat);
  if (rows.length < 6) throw new Error(`下関の展示データが6艇分ありません（${rows.length}艇分）`);
  return rows.slice(0, 6);
}

function parseMikuniCyokuzen(html) {
  return parseDisplayRowsByLines(html, "三国");
}

function parseHamanakoCyokuzen(html) {
  return parseDisplayRowsByLines(html, "浜名湖");
}

function parseTokonameCyokuzen(html) {
  return parseDisplayRowsByLines(html, "常滑");
}

function parseNarutoCyokuzen(html) {
  return parseDisplayRowsByLines(html, "鳴門");
}

function parseBiwakoCyokuzen(html) {
  try {
    return parseKaratsuCyokuzen(html);
  } catch (e) {
    return parseDisplayRowsByLines(html, "びわこ");
  }
}

function parseFukuokaCyokuzen(html) {
  try {
    return parseKaratsuCyokuzen(html);
  } catch (e) {
    return parseDisplayRowsByLines(html, "福岡");
  }
}

function parseKaratsuCyokuzen(html) {
  const rawLines = textLinesFromHtml(html);
  const raw = rawLines.join("\n");
  const tableStart = raw.search(/展示情報[\s\S]{0,250}枠[\s\S]{0,80}体重[\s\S]{0,80}チルト[\s\S]{0,80}展示/);
  const work = tableStart >= 0 ? raw.slice(tableStart) : raw;
  const tableEnd = work.search(/一周・まわり足・直線タイム|※展示評価|選手コメント|からつ専属/);
  const section = tableEnd >= 0 ? work.slice(0, tableEnd) : work;

  const rows = [];
  const rowRe = /(?:^|\n)\s*([1-6])\s*\n+\s*(4\d\.\d|5\d\.\d|6[0-2]\.\d)\s*\n+\s*(-?\d\.\d)\s*\n+\s*([67]\.\d{2})\s*\n+\s*([3-4]\d\.\d{2})\s*\n+\s*([4-7]\.\d{2})\s*\n+\s*([5-9]\.\d{2})/g;
  let m;
  while ((m = rowRe.exec(section)) !== null) {
    const boat = Number(m[1]);
    if (rows.some((r) => r.boat === boat)) continue;
    rows.push({
      boat,
      course: boat,
      weight: m[2],
      tilt: m[3],
      tenji: m[4],
      isshu: m[5],
      mawari: m[6],
      chokusen: m[7],
    });
  }

  // HTMLのセル区切りが詰まっている場合のフォールバック
  if (rows.length < 6) {
    const nums = section.match(/-?\d+(?:\.\d+)?/g) || [];
    const found = [];
    for (let i = 0; i < nums.length; i++) {
      const boat = Number(nums[i]);
      if (!(boat >= 1 && boat <= 6) || found.some((r) => r.boat === boat)) continue;
      const picked = pickDisplayValues(nums.slice(i + 1, i + 10));
      if (picked) found.push({ boat, course: boat, ...picked });
    }
    if (found.length >= 6) {
      found.sort((a, b) => a.boat - b.boat);
      return found.slice(0, 6);
    }
  }

  rows.sort((a, b) => a.boat - b.boat);
  if (rows.length < 6) throw new Error(`唐津の展示データが6艇分ありません（${rows.length}艇分）`);
  return rows.slice(0, 6);
}


function boatcastRaceUrls(venue, raceNo, dateStr) {
  const jcd = JCD[venue];
  if (!jcd) return null;
  const ymd = yyyymmdd(dateStr);
  const rr = String(Number(raceNo)).padStart(2, "0");
  return {
    jcd,
    ymd,
    rr,
    str3: `https://race.boatcast.jp/hp_txt/${jcd}/bc_j_str3_${ymd}_${jcd}_${rr}.txt`,
    tkz: `https://race.boatcast.jp/hp_txt/${jcd}/bc_j_tkz_${ymd}_${jcd}_${rr}.txt`,
    stt: `https://race.boatcast.jp/hp_txt/${jcd}/bc_j_stt_${ymd}_${jcd}_${rr}.txt`,
    oriten: `https://race.boatcast.jp/txt/${jcd}/bc_oriten_${ymd}_${jcd}_${rr}.txt`,
    oddsLive: `https://race.boatcast.jp/txt/${jcd}/bc_smt_od3_${ymd}_${jcd}_${rr}.txt`,
    oddsFixed: `https://race.boatcast.jp/txt/${jcd}/bc_kakutei_od3_${ymd}_${jcd}_${rr}.txt`,
    weatherPrev: Number(raceNo) > 1 ? `https://race.boatcast.jp/m_txt/${jcd}/bc_rs1_2_${ymd}_${jcd}_${String(Number(raceNo) - 1).padStart(2, "0")}.txt` : "",
    weatherCurrent: `https://race.boatcast.jp/m_txt/${jcd}/bc_rs1_2_${ymd}_${jcd}_${rr}.txt`,
  };
}

function buildOfficialResultUrl(venue, raceNo, dateStr) {
  const jcd = JCD[venue];
  if (!jcd) return "";
  const ymd = yyyymmdd(dateStr);
  return `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${Number(raceNo)}&jcd=${jcd}&hd=${ymd}`;
}

function htmlTableRows(tableHtml) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(String(tableHtml || "")))) {
    const rowHtml = rm[0];
    const cells = [];
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cm;
    while ((cm = cellRe.exec(rowHtml))) cells.push(pickText(cm[2]));
    if (cells.length) rows.push({ rowHtml, cells, text: cells.join(" ").replace(/\s+/g, " ").trim() });
  }
  return rows;
}

function htmlTables(html) {
  return String(html || "").match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
}

function boatNoFromResultRowHtml(rowHtml) {
  const raw = String(rowHtml || "");
  const patterns = [
    /is-boat(?:Color|No|Image)[-_]?([1-6])\b/i,
    /boat(?:Color|No|Image)[-_]?([1-6])\b/i,
    /class=["'][^"']*\bboat[-_]?([1-6])\b/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseActualStToken(raw) {
  const compact = String(raw || "").replace(/[　]/g, " ").replace(/[−ー─]/g, "-").toUpperCase().trim();
  const m = compact.match(/(?:^|[^0-9])([FL])?\s*(-?(?:\d+)?\.\d{2})(?!\d)/);
  if (!m) return null;
  let value = Number(m[2].startsWith(".") ? `0${m[2]}` : m[2]);
  if (!Number.isFinite(value)) return null;
  const marker = m[1] || "";
  if (marker === "F") value = -Math.abs(value);
  return { st: Number(value.toFixed(3)), marker, isF: marker === "F" || value < 0 };
}

function resultStatusFromText(text) {
  const t = String(text || "").replace(/\s+/g, "");
  if (/フライング|\bF\b|(^|[^A-Z])F\d*/i.test(t)) return "F";
  if (/出遅れ|\bL\b|(^|[^A-Z])L\d*/i.test(t)) return "L";
  if (/欠場|欠/.test(t)) return "欠";
  if (/失格|失/.test(t)) return "失";
  if (/転覆|転/.test(t)) return "転";
  if (/落水|落/.test(t)) return "落";
  if (/妨害|妨/.test(t)) return "妨";
  if (/不完走|不/.test(t)) return "不";
  return "";
}

function findRegnoInCells(cells, racersByRegno) {
  const candidates = [];
  for (const cell of cells || []) {
    for (const m of String(cell || "").matchAll(/\b(\d{4})\b/g)) candidates.push(m[1]);
  }
  const matched = candidates.find((x) => racersByRegno.has(Number(x)));
  return matched ? Number(matched) : (candidates.length ? Number(candidates[0]) : null);
}

function parseOfficialFinishRows(html, racers = []) {
  const racersByRegno = new Map((racers || []).map((r) => [Number(r.regNo), r]).filter(([n]) => Number.isFinite(n)));
  const candidates = [];
  for (const table of htmlTables(html)) {
    const rows = htmlTableRows(table);
    const head = rows.slice(0, 3).map((r) => r.text).join(" ");
    if (!/着/.test(head) || !/(ボートレーサー|選手名|レーサー)/.test(head) || !/枠/.test(head)) continue;
    const out = [];
    for (const row of rows) {
      if (/(着順|ボートレーサー|選手名|レースタイム)/.test(row.text)) continue;
      const status = resultStatusFromText(row.cells.slice(0, 3).join(" "));
      const firstCell = String(row.cells[0] || "").trim();
      const rankMatch = firstCell.match(/^([1-6])(?:着)?$/);
      const exactSmall = row.cells.map((c) => String(c || "").trim()).filter((c) => /^[1-6]$/.test(c)).map(Number);
      const regno = findRegnoInCells(row.cells, racersByRegno);
      const racer = regno ? racersByRegno.get(regno) : null;
      let boat = boatNoFromResultRowHtml(row.rowHtml);
      if (!(boat >= 1 && boat <= 6)) {
        if (exactSmall.length >= 2) boat = exactSmall[1];
        else if (racer?.boat) boat = Number(racer.boat);
        else if (exactSmall.length === 1 && !rankMatch) boat = exactSmall[0];
      }
      if (!(boat >= 1 && boat <= 6) || out.some((x) => x.boat === boat)) continue;
      const rank = rankMatch ? Number(rankMatch[1]) : (status ? 7 : null);
      if (rank == null) continue;
      out.push({ boat, rank, status, regno: regno || (racer?.regNo ? Number(racer.regNo) : null) });
    }
    if (out.length) candidates.push(out);
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

function parseStartRowsFromTables(html) {
  const candidates = [];
  for (const table of htmlTables(html)) {
    const rows = htmlTableRows(table);
    const joined = rows.map((r) => r.text).join(" ");
    const stMatches = joined.match(/(?:F|L)?\s*(?:\d+)?\.\d{2}/gi) || [];
    if (!/ST|スタート/i.test(joined) && stMatches.length < 4) continue;
    const out = [];
    for (const row of rows) {
      const stInfo = parseActualStToken(row.text);
      if (!stInfo) continue;
      const exactSmall = row.cells.map((c) => String(c || "").trim()).filter((c) => /^[1-6]$/.test(c)).map(Number);
      const classBoat = boatNoFromResultRowHtml(row.rowHtml);
      let course = exactSmall.length >= 2 ? exactSmall[0] : out.length + 1;
      let boat = classBoat || (exactSmall.length >= 2 ? exactSmall[1] : exactSmall[0]);
      if (!(boat >= 1 && boat <= 6)) continue;
      if (!(course >= 1 && course <= 6) || out.some((x) => x.course === course)) course = out.length + 1;
      if (out.some((x) => x.boat === boat)) continue;
      out.push({ boat, course, ...stInfo });
    }
    if (out.length) candidates.push(out);
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

function parseStartRowsFromText(raw) {
  const lines = textLinesFromHtml(raw);
  let start = lines.findIndex((line) => /スタート情報|スタート展示/.test(line));
  let scoped = start >= 0 ? lines.slice(start + 1, start + 100) : lines;
  const end = scoped.findIndex((line) => /水面気象|払戻|勝式|レース結果/.test(line));
  if (end > 0) scoped = scoped.slice(0, end);
  const out = [];
  const usedBoats = new Set();
  for (let i = 0; i < scoped.length; i++) {
    const stInfo = parseActualStToken(scoped[i]);
    if (!stInfo) continue;
    const near = scoped.slice(Math.max(0, i - 5), i + 1).reverse();
    let boat = null;
    for (const line of near) {
      const m = String(line || "").trim().match(/^([1-6])$/);
      if (m && !usedBoats.has(Number(m[1]))) { boat = Number(m[1]); break; }
    }
    if (!(boat >= 1 && boat <= 6)) {
      boat = [1,2,3,4,5,6].find((b) => !usedBoats.has(b)) || null;
    }
    if (!boat) continue;
    usedBoats.add(boat);
    out.push({ boat, course: out.length + 1, ...stInfo });
    if (out.length >= 6) break;
  }
  return out;
}

function parseKimariteFromResultHtml(html) {
  const text = pickText(html);
  const m = text.match(/決まり手\s*[:：]?\s*(まくり差し|逃げ|差し|まくり|抜き|恵まれ)/);
  return m ? m[1] : "";
}

function buildRaceResultRows({ venue, raceNo, ymd, resultHtml, racers, sttRaw = "", resultRaw = "" }) {
  const raceDate = ymdToDate(ymd);
  const placeNo = PLACE_NO_BY_VENUE[venue];
  if (!raceDate || !placeNo) return { rows: [], complete: false, reason: "日付または場コード不正" };

  const finishRows = parseOfficialFinishRows(resultHtml, racers);
  let startRows = parseStartRowsFromTables(resultHtml);
  if (startRows.length < 5) startRows = parseStartRowsFromText(resultHtml);
  if (startRows.length < 5 && resultRaw) startRows = parseStartRowsFromText(resultRaw);
  const sttRows = parseBoatcastSttRows(sttRaw);
  const startByBoat = new Map(startRows.map((r) => [Number(r.boat), r]));
  const courseByBoat = new Map(sttRows.map((r) => [Number(r.boat), Number(r.course)]));
  const racersByBoat = new Map((racers || []).map((r) => [Number(r.boat), r]));
  const racersByRegno = new Map((racers || []).map((r) => [Number(r.regNo), r]).filter(([n]) => Number.isFinite(n)));
  const kimarite = parseKimariteFromResultHtml(resultHtml);

  const rows = [];
  for (const fr of finishRows) {
    const sr = startByBoat.get(Number(fr.boat));
    const racer = (fr.regno && racersByRegno.get(Number(fr.regno))) || racersByBoat.get(Number(fr.boat));
    const course = Number(sr?.course || courseByBoat.get(Number(fr.boat)) || fr.boat);
    const st = sr?.st;
    const status = fr.status || sr?.marker || "";
    rows.push({
      race_date: raceDate,
      place_no: placeNo,
      race_no: Number(raceNo),
      boat: Number(fr.boat),
      course: course >= 1 && course <= 6 ? course : Number(fr.boat),
      rank: Number(fr.rank) >= 1 && Number(fr.rank) <= 6 ? Number(fr.rank) : 7,
      kimarite: kimarite || null,
      regno: fr.regno || (racer?.regNo ? Number(racer.regNo) : null),
      st: Number.isFinite(Number(st)) ? Number(st) : null,
      is_f: status === "F" || sr?.isF === true || Number(st) < 0,
    });
  }

  const racerCount = (racers || []).filter((r) => Number(r?.boat) >= 1 && Number(r?.boat) <= 6).length;
  const expected = racerCount >= 4 && racerCount <= 6 ? racerCount : 6;
  const uniqueBoats = new Set(rows.map((r) => r.boat));
  const startCount = rows.filter((r) => Number.isFinite(r.st)).length;
  const validCore = rows.every((r) => r.regno && r.course >= 1 && r.course <= 6 && r.rank >= 1);
  const complete = rows.length >= expected && uniqueBoats.size >= expected && startCount >= expected && validCore;
  const reason = complete ? "" : `結果未確定または解析不足（着順${finishRows.length}艇・ST${startRows.length}艇・保存候補${rows.length}艇）`;
  return { rows, complete, reason, finishCount: finishRows.length, startCount: startRows.length, kimarite };
}

async function saveRaceResultRows(rows) {
  if (!ENABLE_PERSISTENT_CACHE) return { ok: false, skipped: true, reason: "SUPABASE_SERVICE_KEYなし" };
  if (!Array.isArray(rows) || !rows.length) return { ok: false, skipped: true, reason: "保存対象なし" };
  try {
    await supabaseCacheRequest("race_results?on_conflict=race_date,place_no,race_no,boat", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return { ok: true, count: rows.length, mode: "upsert" };
  } catch (e) {
    const msg = String(e?.message || e);
    // 既存DBに複合UNIQUEが無い場合の保険。完成した1レース分だけを入れ替えて欠損を修復する。
    if (!/42P10|unique|conflict target|matching the ON CONFLICT/i.test(msg)) throw e;
    const first = rows[0];
    const filter = `race_results?race_date=eq.${encodeURIComponent(first.race_date)}&place_no=eq.${Number(first.place_no)}&race_no=eq.${Number(first.race_no)}`;
    await supabaseCacheRequest(filter, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await supabaseCacheRequest("race_results", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows),
    });
    return { ok: true, count: rows.length, mode: "replace", warning: "複合UNIQUEなしのためレース単位で入替" };
  }
}

async function fetchBoatcastRaceResultPayload(venue, raceNo, ymd) {
  const urls = boatcastRaceUrls(venue, raceNo, ymd);
  const resultUrl = buildOfficialResultUrl(venue, raceNo, ymd);
  if (!urls || !resultUrl) throw new Error(`${venue}の結果取得URLを作成できません`);

  const [resultRes, str3Res, sttRes, resultRawRes] = await Promise.allSettled([
    fetchHtml(resultUrl),
    fetchHtml(urls.str3),
    fetchHtml(urls.stt),
    fetchHtml(urls.weatherCurrent),
  ]);
  if (resultRes.status !== "fulfilled") {
    return { ok: true, action: "result", completed: false, venue, race: Number(raceNo), date: ymd, reason: `公式結果未取得: ${resultRes.reason?.message || resultRes.reason}` };
  }

  const resultHtml = resultRes.value || "";
  const racers = str3Res.status === "fulfilled" ? parseBoatcastRacerInfo(str3Res.value) : [];
  const sttRaw = sttRes.status === "fulfilled" ? sttRes.value : "";
  const resultRaw = resultRawRes.status === "fulfilled" ? resultRawRes.value : "";
  const parsed = buildRaceResultRows({ venue, raceNo, ymd, resultHtml, racers, sttRaw, resultRaw });
  if (!parsed.complete) {
    return {
      ok: true,
      action: "result",
      completed: false,
      venue,
      race: Number(raceNo),
      date: ymd,
      resultUrl,
      reason: parsed.reason,
      finishCount: parsed.finishCount,
      startCount: parsed.startCount,
      candidateCount: parsed.rows.length,
      fetchedAt: new Date().toISOString(),
    };
  }

  const saved = await saveRaceResultRows(parsed.rows);
  return {
    ok: true,
    action: "result",
    completed: true,
    appVersion: "v116",
    venue,
    race: Number(raceNo),
    date: ymd,
    resultUrl,
    rowsCount: parsed.rows.length,
    stCount: parsed.rows.filter((r) => r.st != null).length,
    fCount: parsed.rows.filter((r) => r.is_f).length,
    kimarite: parsed.kimarite,
    resultSaved: saved,
    fetchedAt: new Date().toISOString(),
  };
}


function parseNumericTokens(line) {
  return (String(line || "").match(/-?\d+(?:\.\d+)?/g) || []).map((x) => String(x));
}

function nextMissingBoat(rows) {
  const used = new Set((rows || []).map((r) => Number(r.boat)).filter((b) => b >= 1 && b <= 6));
  for (let b = 1; b <= 6; b++) {
    if (!used.has(b)) return b;
  }
  return 7;
}

function startsWithStandaloneBoatNo(line, cells = null) {
  const s = String(line || "").trim();
  const c = cells || (s.includes("\t") ? s.split("\t").map((x) => String(x || "").trim()) : s.split(/[ 　]+/).map((x) => String(x || "").trim()).filter(Boolean));
  return /^[1-6]$/.test(String(c[0] || "").trim()) || /^[1-6](?:\t|[ 　])/.test(s);
}

function findSignedTiltToken(tokens) {
  for (const x of tokens || []) {
    const raw = String(x ?? "").trim();
    if (/^[+＋\-－−ー]\s*\d+(?:\.\d+)?$/.test(raw)) {
      const v = normalizeBoatcastTiltToken(raw);
      if (v) return v;
    }
  }
  return "";
}

function findSafeUnsignedTiltToken(tokens) {
  for (const x of tokens || []) {
    const v = normalizeBoatcastTiltToken(x);
    if (["-0.5", "0.0", "0.5"].includes(v)) return v;
  }
  return "";
}

function findFirstInRange(tokens, a, b) {
  for (const x of tokens || []) {
    if (inRange(x, a, b)) return normNum(x);
  }
  return "";
}

function pickSequentialBoatcastTimes(nums, opts = {}) {
  const cleaned = (nums || []).map((x) => String(x).replace(/kg$/i, "")).filter(isNumText);
  const hasHalfLap = !!opts.hasHalfLap;
  for (let i = 0; i < cleaned.length; i++) {
    const lapOk = inRange(cleaned[i], 30, 45) || (hasHalfLap && inRange(cleaned[i], 15, 25));
    if (!lapOk) continue;
    if (inRange(cleaned[i + 1], 4, 15)) {
      return {
        isshu: normNum(cleaned[i]),
        mawari: normNum(cleaned[i + 1]),
        chokusen: inRange(cleaned[i + 2], 4, 15) ? normNum(cleaned[i + 2]) : "",
      };
    }
  }
  return null;
}

function numberOrNull(x) {
  const v = Number(String(x ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function normalizeBoatcastTiltToken(x) {
  const cleaned = String(x ?? "")
    .replace(/[＋]/g, "+")
    .replace(/[－−ー]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^\+/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return "";
  if (!inRange(cleaned, -1, 3.5)) return "";
  return Number(cleaned).toFixed(1);
}

function normalizeBoatcastWeightToken(x) {
  const v = normNum(String(x ?? "").replace(/[＋]/g, "+").replace(/[－−ー]/g, "-").replace(/\s+/g, ""));
  return inRange(v, 40, 70) ? v : "";
}

function normalizeBoatcastAdjustWeightToken(x) {
  const v = normNum(String(x ?? "").replace(/[＋]/g, "+").replace(/[－−ー]/g, "-").replace(/\s+/g, ""));
  // 調整体重は 0.5 / 1.0 / 1.5 / 2.0 付近。チルト評価には絶対に使わない。
  return inRange(v, 0, 3) ? Number(v).toFixed(1) : "";
}

function pickBoatcastAdjustWeightToken(cols) {
  const arr = (cols || []).map((x) => String(x ?? "").trim());
  const weightIdx = arr.findIndex((x) => normalizeBoatcastWeightToken(x));
  if (weightIdx < 0) return "";
  const afterWeight = arr.slice(weightIdx + 1);
  const firstLowNum = afterWeight.find((x) => normalizeBoatcastAdjustWeightToken(x));
  return firstLowNum ? normalizeBoatcastAdjustWeightToken(firstLowNum) : "";
}

function pickBoatcastTiltToken(cols) {
  const arr = (cols || []).map((x) => String(x ?? "").trim());
  // 根本対策：調整体重 1.0 / 1.5 をチルトと誤認しない。
  // BOATCASTの列テキストでは「+0.0」「-0.5」のような符号付きトークンだけをチルトとして採用する。
  // 符号なしの 0.0 / 0.5 / 1.0 は調整重量と区別できないため、自動取得ではチルト補正に使わない。
  const signed = arr.find((x) => /^[+＋\-－−ー]\s*\d+(?:\.\d+)?$/.test(x) && normalizeBoatcastTiltToken(x));
  return signed ? normalizeBoatcastTiltToken(signed) : "";
}

function sanitizeParsedTilt(row) {
  const r = { ...(row || {}) };
  const raw = String(r.tilt ?? "").trim().replace(/[＋]/g, "+").replace(/[－−ー]/g, "-");
  if (raw === "") { r.tilt = ""; return r; }
  const v = Number(raw.replace(/^\+/, ""));
  if (!Number.isFinite(v)) { r.tilt = ""; return r; }
  // 調整体重の誤反映が最も多い 1.0 / 1.5 / 2.0 などは、符号付き取得でない限り消す。
  // API内部では符号は正規化で落ちるため、+1.0を厳密に拾えない場面より、誤警戒を出さない方を優先する。
  if (v > 0.5) { r.tilt = ""; return r; }
  if (v < -1 || v > 3) { r.tilt = ""; return r; }
  r.tilt = v.toFixed(1);
  return r;
}

function sanitizeDisplayRows(rows) {
  return (rows || []).map((row) => sanitizeParsedTilt(row));
}


function boatcastPlainLines(raw) {
  return decodeEntities(String(raw || ""))
    .replace(/\r/g, "\n")
    .replace(/\\n/g, "\n")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^data=$/i.test(x));
}

function parseBoatcastRacerInfoTsv(raw) {
  const lines = boatcastPlainLines(raw);
  const racers = [];
  for (const line of lines) {
    if (!/^\d{4}\t/.test(line)) continue;
    const c = line.split("\t").map((x) => String(x || "").trim());
    if (c.length < 20) continue;
    const boat = racers.length + 1;
    if (boat > 6) break;
    const branchBirth = c[3] || "";
    const [branch = "", birthplace = ""] = branchBirth.split(":");
    const flCandidates = c.slice(6, 10).join(" ");
    const flText = (flCandidates.match(/\bF\d*\b/) || flCandidates.match(/\bL\d*\b/) || [""])[0];
    const avgST = normNum(c[9]);
    racers.push({
      boat,
      grade: c[5] || "",
      regNo: c[0] || "",
      name: c[1] || "",
      branch: (branch || "").trim(),
      birthplace: (birthplace || "").trim(),
      age: normNum(c[4]),
      fl: flText,
      fHold: /^F/.test(flText),
      lHold: /^L/.test(flText),
      avgST: avgST ? Number(avgST).toFixed(2) : "",
      motorNo: c[17] && /^\d+$/.test(c[17]) ? String(Number(c[17])) : "",
      boatNo: c[21] && /^\d+$/.test(c[21]) ? String(Number(c[21])) : "",
      motorRen2: numberOrNull(c[18]),
      motorRen3: numberOrNull(c[19]),
      isFemale: isLikelyFemaleRacer(c[0], c[1]),
    });
  }
  return racers;
}

function parseBoatcastRacerInfo(raw) {
  const tsv = parseBoatcastRacerInfoTsv(raw);
  if (tsv.length >= 6) return tsv.slice(0, 6);

  const lines = textLinesFromHtml(raw);
  const racers = [];

  for (let boat = 1; boat <= 6; boat++) {
    const start = lines.findIndex((line, i) => line === String(boat) && (i === 0 || lines[i - 1] !== "R") && lines.slice(i + 1, i + 8).join(" ").match(/[AB][12]?\s*\/\s*\d{4}/));
    if (start < 0) continue;
    const next = lines.findIndex((line, i) => i > start && line === String(boat + 1) && lines.slice(i + 1, i + 8).join(" ").match(/[AB][12]?\s*\/\s*\d{4}/));
    const block = lines.slice(start + 1, next > start ? next : lines.length).map((x) => String(x || "").trim()).filter(Boolean);
    const grIdx = block.findIndex((x) => /[AB][12]?\s*\/\s*\d{4}/.test(x));
    if (grIdx < 0) continue;
    const gm = block[grIdx].match(/([AB][12]?)\s*\/\s*(\d{4})/);
    const profileLine = block.slice(grIdx + 1, grIdx + 6).find((x) => /\/.+\/\s*\d{1,2}/.test(x)) || "";
    const pm = profileLine.match(/([^/]+)\/([^/]+)\/(\d{1,2})/);
    const name = (block[grIdx + 1] || "").replace(/\s+/g, " ").trim();
    const flText = block.slice(grIdx + 1, Math.min(block.length, grIdx + 8)).find((x) => /^(F\d*|L\d*)$/.test(x)) || "";
    const avgIdx = block.findIndex((x, i) => i > grIdx && /\b0\.\d{2}\b/.test(x) && parseNumericTokens(x).length >= 5);
    const avgNums = avgIdx >= 0 ? parseNumericTokens(block[avgIdx]).map(numberOrNull).filter((v) => v != null) : [];
    const ren2Nums = avgIdx >= 0 ? parseNumericTokens(block[avgIdx + 1] || "").map(numberOrNull).filter((v) => v != null) : [];
    const ren3Nums = avgIdx >= 0 ? parseNumericTokens(block[avgIdx + 2] || "").map(numberOrNull).filter((v) => v != null) : [];
    racers.push({
      boat,
      grade: gm?.[1] || "",
      regNo: gm?.[2] || "",
      name,
      branch: pm?.[1]?.trim() || "",
      birthplace: pm?.[2]?.trim() || "",
      age: pm?.[3] || "",
      fl: flText,
      fHold: /^F/.test(flText),
      lHold: /^L/.test(flText),
      avgST: avgNums[0] != null ? Number(avgNums[0]).toFixed(2) : "",
      motorNo: avgNums[3] != null ? String(Math.trunc(avgNums[3])) : "",
      boatNo: avgNums[4] != null ? String(Math.trunc(avgNums[4])) : "",
      motorRen2: ren2Nums[2] != null ? ren2Nums[2] : null,
      motorRen3: ren3Nums[2] != null ? ren3Nums[2] : null,
      isFemale: isLikelyFemaleRacer(gm?.[2] || "", name),
    });
  }
  return racers;
}


function parseBoatcastTkzRows(raw) {
  const rows = [];
  const lines = boatcastPlainLines(raw);
  for (const line of lines) {
    const hasTab = line.includes("\t");
    const c = hasTab ? line.split("\t").map((x) => String(x || "").trim()) : line.split(/[ 　]+/).map((x) => String(x || "").trim()).filter(Boolean);
    if (c.length < 3) continue;

    let boat = Number(c[0]);
    if (!(boat >= 1 && boat <= 6)) {
      // BOATCASTの一部txtは艇番を列で持たないため、行順で1〜6号艇として扱う。
      boat = nextMissingBoat(rows);
    }
    if (!(boat >= 1 && boat <= 6) || rows.some((r) => r.boat === boat)) continue;

    let tenji = "";
    // 従来形式: 選手名, 展示タイム, ...
    if (inRange(c[1], 5.5, 7.8)) tenji = normNum(c[1]);
    // 鳴門など: 艇番/登録番号/年齢/チルト/展示... のように列位置が違う形式。
    if (!tenji) tenji = findFirstInRange(c.slice(1), 5.5, 7.8);
    if (!tenji) continue;

    const weight = c.map(normalizeBoatcastWeightToken).find(Boolean) || "";
    const adjust_weight = pickBoatcastAdjustWeightToken(c);
    // チルトは調整体重と誤認しやすいので、符号付き表示や体重列の並びを見て拾う。
    const tilt = pickBoatcastTiltToken(c);
    const name = c.find((x) => /[一-龠ぁ-んァ-ヶ]/.test(x) && !/展示|チルト|体重|級別|登録/.test(x)) || "";

    rows.push({ boat, course: boat, name, tenji, weight, adjust_weight, tilt });
    if (rows.length >= 6) break;
  }
  rows.sort((a, b) => a.boat - b.boat);
  return sanitizeDisplayRows(rows.slice(0, 6));
}

function parseBoatcastOritenRows(raw) {
  const rows = [];
  const plain = decodeEntities(String(raw || ""));
  const lines = boatcastPlainLines(raw);
  const hasHalfLap = /半周|半周ラップ/.test(plain);

  const normalizeLapValue = (v) => {
    const n = normNum(v);
    if (inRange(n, 30, 45)) return n;
    if (hasHalfLap && inRange(n, 15, 25)) return n;
    return "";
  };

  for (const line of lines) {
    let boat = null;
    let name = "";
    let isshu = "";
    let mawari = "";
    let chokusen = "";

    const nums = parseNumericTokens(line);
    const hasTab = line.includes("\t");
    const c = hasTab ? line.split("\t").map((x) => String(x || "").trim()) : line.split(/[ 　]+/).map((x) => String(x || "").trim()).filter(Boolean);

    // BOATCASTのoritenは場・レースにより、
    // 1) 艇番,選手名,一周,まわり足,直線
    // 2) 登録番号,選手名,一周,まわり足,直線（艇番なし）
    // 3) 選手名,一周,まわり足,直線（艇番なし）
    // のように列が揺れる。艇番が無い時は行順を1〜6号艇として扱う。
    const firstNum = Number(nums[0]);
    const firstCol = Number(c[0]);
    if (firstCol >= 1 && firstCol <= 6) {
      boat = firstCol;
      name = c[1] || "";
      isshu = normalizeLapValue(c[2]);
      mawari = normNum(c[3]);
      chokusen = normNum(c[4]);
      if (!isshu || !inRange(mawari, 4, 15)) {
        const picked = pickSequentialBoatcastTimes(nums.slice(1), { hasHalfLap });
        if (picked) ({ isshu, mawari, chokusen } = picked);
      }
    } else {
      // 先頭が登録番号(例:4096)や選手名の場合。数値列全体からタイム連番を探す。
      // 登録番号・年齢・級別の数字は pickSequentialBoatcastTimes 側の範囲判定で無視される。
      const picked = pickSequentialBoatcastTimes(nums, { hasHalfLap });
      if (picked) ({ isshu, mawari, chokusen } = picked);
      // A1/A2の「1」「2」を艇番と誤認しない。艇番列が無い形式は行順で割り当てる。
      boat = nextMissingBoat(rows);
      name = c.find((x) => /[一-龠ぁ-んァ-ヶ]/.test(x) && !/一周|まわり|直線|展示|半周/.test(x)) || "";
    }

    if (!(boat >= 1 && boat <= 6) || !isshu || !inRange(mawari, 4, 15)) continue;
    if (rows.some((r) => r.boat === boat)) continue;
    rows.push({
      boat,
      course: boat,
      name,
      isshu,
      mawari,
      chokusen: inRange(chokusen, 4, 15) ? chokusen : "",
      lapKind: hasHalfLap ? "half" : "one",
    });
    if (rows.length >= 6) break;
  }
  rows.sort((a, b) => a.boat - b.boat);
  return rows.slice(0, 6);
}

function parseBoatcastSttRows(raw) {
  const rows = [];
  const lines = boatcastPlainLines(raw);
  for (const line of lines) {
    if (!/^\d\t\d\t/.test(line)) continue;
    const c = line.split("\t").map((x) => String(x || "").trim());
    const course = Number(c[0]);
    const boat = Number(c[1]);
    if (!(boat >= 1 && boat <= 6)) continue;
    rows.push({ boat, course: course >= 1 && course <= 6 ? course : boat, name: c[2] || "" });
  }
  rows.sort((a, b) => a.boat - b.boat);
  return rows.slice(0, 6);
}

function combineBoatcastDisplayRows(tkzRaw, oritenRaw, sttRaw) {
  const tkzRows = parseBoatcastTkzRows(tkzRaw);
  const oritenRows = parseBoatcastOritenRows(oritenRaw);
  const sttRows = parseBoatcastSttRows(sttRaw);
  const byBoat = new Map();
  for (let boat = 1; boat <= 6; boat++) byBoat.set(boat, { boat, course: boat, tenji: "", isshu: "", mawari: "", chokusen: "", weight: "", tilt: "" });
  for (const list of [tkzRows, oritenRows, sttRows]) {
    for (const row of list || []) {
      const b = Number(row.boat);
      if (!byBoat.has(b)) continue;
      byBoat.set(b, { ...byBoat.get(b), ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== "" && v != null)) });
    }
  }
  let rows = [...byBoat.values()].sort((a, b) => a.boat - b.boat);

  // 艇番列が無いtxtではA1/A2などの級別数字で艇番がズレることがある。
  // その場合は、tkz/oriten/sttの行順を1〜6号艇として再結合する。
  if (!validRows(rows) && tkzRows.length >= 6 && oritenRows.length >= 6) {
    rows = Array.from({ length: 6 }, (_, i) => {
      const boat = i + 1;
      const tk = tkzRows[i] || {};
      const ori = oritenRows[i] || {};
      const st = sttRows.find((r) => Number(r.boat) === boat) || sttRows[i] || {};
      return {
        boat,
        course: Number(st.course) >= 1 && Number(st.course) <= 6 ? Number(st.course) : boat,
        ...Object.fromEntries(Object.entries({ ...tk, ...ori }).filter(([k, v]) => k !== "boat" && k !== "course" && v !== "" && v != null)),
      };
    });
  }
  return sanitizeDisplayRows(rows);
}

function classifyBoatcastDisplayIssue({ venue, racers = [], tkz = "", oriten = "", stt = "", combined = [], rowErrors = [] }) {
  if (NO_ORIGINAL_DISPLAY_VENUES.has(venue)) {
    return { code: "display_disabled", message: "オリジナル展示なし" };
  }

  const tkzRows = parseBoatcastTkzRows(tkz);
  const oritenRows = parseBoatcastOritenRows(oriten);
  const sttRows = parseBoatcastSttRows(stt);
  const completeRows = (combined || []).filter((r) => r && r.tenji && r.isshu && r.mawari);
  const anyDisplayCount = Math.max(tkzRows.length, oritenRows.length, sttRows.length, completeRows.length);

  // 取得URLは存在していても、展示公開前は各txtが空に近い/0艇になる。
  if (anyDisplayCount === 0) {
    return {
      code: "public_wait",
      message: "公開展示待ちです。",
      detail: rowErrors.join(" / "),
    };
  }

  // 5艇立て・欠場等で、展示/オリジナル展示が5艇分しか出ないケース。
  if (anyDisplayCount === 5 || completeRows.length === 5 || (Array.isArray(racers) && racers.length === 5)) {
    return {
      code: "five_boat",
      message: "5艇レースのため。",
      detail: rowErrors.join(" / "),
    };
  }

  return {
    code: "display_shortage",
    message: "展示情報不足のため。",
    detail: rowErrors.join(" / "),
  };
}

function parseBoatcastDisplay(raw) {
  // BOATCASTの展示系txtは、画面表示に近い改行形式と、CSV/TSV寄りの形式が混在する可能性がある。
  // まず画面表示テキストとして解析し、だめなら数値列から「艇番＋体重/調整/チルト/展示/一周/まわり足」を探す。
  try {
    return parseDisplayRowsByLines(raw, "BOATCAST");
  } catch (e) {
    // 下の汎用解析にフォールバック
  }

  const decoded = decodeEntities(String(raw || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/[|;,]/g, "\n");

  const lines = decoded
    .split(/\r?\n/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const rowsByBoat = new Map();

  const setRow = (boat, picked) => {
    boat = Number(boat);
    if (!boat || boat < 1 || boat > 6 || !picked || rowsByBoat.has(boat)) return;
    if (!picked.tenji || !picked.isshu || !picked.mawari) return;
    rowsByBoat.set(boat, { boat, course: boat, ...picked });
  };

  const pickFromNumbers = (nums) => {
    const cleaned = nums.map((x) => String(x).replace(/kg$/i, "")).filter(isNumText);
    // 既存の標準パターン
    const standard = pickDisplayValues(cleaned);
    if (standard) return standard;

    // 体重などが無い or BOATCAST独自: 展示, 一周/半周ラップ, まわり足 [,直線]
    const hasHalfLapText = /半周|半周ラップ/.test(decoded);
    for (let i = 0; i < cleaned.length; i++) {
      const lapOk = inRange(cleaned[i + 1], 30, 45) || (hasHalfLapText && inRange(cleaned[i + 1], 15, 25));
      if (inRange(cleaned[i], 5.5, 7.8) && lapOk && inRange(cleaned[i + 2], 4, 15)) {
        return {
          weight: "",
          tilt: "",
          tenji: cleaned[i],
          isshu: cleaned[i + 1],
          mawari: cleaned[i + 2],
          chokusen: inRange(cleaned[i + 3], 4, 15) ? cleaned[i + 3] : "",
        };
      }
    }
    return null;
  };

  // 1行に1艇分が入っている形式。
  // A1/A2の級別数字を艇番と誤認しないよう、先頭セルが単独の1〜6の時だけ艇番扱い。
  for (const line of lines) {
    const nums = parseNumericTokens(line);
    if (nums.length < 4) continue;
    const cells = line.includes("\t") ? line.split("\t").map((x) => String(x || "").trim()) : line.split(/[ 　]+/).map((x) => String(x || "").trim()).filter(Boolean);
    if (startsWithStandaloneBoatNo(line, cells)) {
      const first = Number(cells[0]);
      setRow(first, pickFromNumbers(nums.slice(1)));
    }
  }

  // 行をまたいでいる形式。艇番の後ろ一定範囲から拾う。
  const allNums = parseNumericTokens(decoded);
  for (let i = 0; i < allNums.length; i++) {
    const boat = Number(allNums[i]);
    if (!(boat >= 1 && boat <= 6) || rowsByBoat.has(boat)) continue;
    const picked = pickFromNumbers(allNums.slice(i + 1, i + 16));
    if (picked) setRow(boat, picked);
  }

  // 艇番が入っていない6行形式への保険。行順を1〜6号艇として扱う。
  if (rowsByBoat.size < 6) {
    let nextBoat = 1;
    for (const line of lines) {
      if (nextBoat > 6) break;
      const nums = parseNumericTokens(line);
      if (nums.length < 3) continue;
      const picked = pickFromNumbers(nums);
      if (picked) {
        const b = nextMissingBoat([...rowsByBoat.values()]);
        if (b <= 6) setRow(b, picked);
      }
    }
  }

  const rows = [...rowsByBoat.values()].sort((a, b) => a.boat - b.boat);
  if (rows.length < 6) throw new Error(`展示データが6艇分ありません（${rows.length}艇分）`);
  return sanitizeDisplayRows(rows.slice(0, 6));
}

function parseBoatcastOddsTxt(raw) {
  const normalized = decodeEntities(String(raw || ""))
    .replace(/[\[\]{}"']/g, " ")
    .replace(/\\n/g, "\n");
  const lines = normalized.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  let candidateLines = lines.filter((line) => parseNumericTokens(line).length >= 20);

  // 改行が少ないファイルでも拾えるよう、セミコロン/パイプでも分割して再試行。
  if (candidateLines.length < 6) {
    candidateLines = normalized.split(/[;|]/).map((x) => x.trim()).filter((line) => parseNumericTokens(line).length >= 20);
  }
  if (candidateLines.length < 6) return {};

  const out = {};
  candidateLines.slice(0, 6).forEach((line, idx) => {
    let nums = parseNumericTokens(line).map(numberOrNull).filter((v) => v != null);
    // 先頭に管理番号・艇番・キー番号が付いている場合を落とす。
    while (nums.length > 20 && Number.isInteger(nums[0]) && nums[0] >= 1 && nums[0] <= 7) nums = nums.slice(1);
    const vals = nums.slice(0, 20);
    if (vals.length < 20) return;
    const first = idx + 1;
    let k = 0;
    for (let second = 1; second <= 6; second++) {
      for (let third = 1; third <= 6; third++) {
        if (second === first || third === first || third === second) continue;
        const odds = Number(vals[k++]);
        if (Number.isFinite(odds) && odds > 0) out[`${first}-${second}-${third}`] = odds;
      }
    }
  });
  return out;
}

function racersToMotorMap(racers) {
  const motors = {};
  for (const r of racers || []) {
    if (!r?.boat) continue;
    if (r.motorNo || r.motorRen2 != null || r.motorRen3 != null) {
      motors[r.boat] = { no: r.motorNo || null, ren2: r.motorRen2, ren3: r.motorRen3 };
    }
  }
  return motors;
}

async function fetchBoatcastOddsForVenue(venue, raceNo, dateStr) {
  const urls = boatcastRaceUrls(venue, raceNo, dateStr);
  if (!urls) return { ok: false, error: `${venue}の場コードが見つかりません` };
  const errors = [];
  // 締切後は確定オッズ、締切前は発売中オッズ。どちらでも取れた方を使う。
  for (const url of [urls.oddsLive, urls.oddsFixed]) {
    try {
      const raw = await fetchHtml(url);
      const odds = parseOddsFromHtml(raw);
      const count = Object.keys(odds).length;
      if (count >= 10) return { ok: true, url, count, odds };
      errors.push(`${url} => ${count}点`);
    } catch (e) {
      errors.push(`${url} => ${e.message || e}`);
    }
  }
  return { ok: false, error: errors.join(" / ") };
}

async function fetchBoatcastPayload(venue, raceNo, dateStr) {
  const urls = boatcastRaceUrls(venue, raceNo, dateStr);
  if (!urls) throw new Error(`${venue}の場コードが見つかりません`);

  const fetches = [
    fetchHtml(urls.str3),
    fetchHtml(urls.stt),
    fetchHtml(urls.oriten),
    fetchHtml(urls.tkz),
    urls.weatherPrev ? fetchHtml(urls.weatherPrev) : Promise.resolve(""),
    fetchHtml(urls.weatherCurrent),
  ];
  const [str3Res, sttRes, oritenRes, tkzRes, weatherPrevRes, weatherCurrentRes] = await Promise.allSettled(fetches);

  const str3 = str3Res.status === "fulfilled" ? str3Res.value : "";
  const stt = sttRes.status === "fulfilled" ? sttRes.value : "";
  const oriten = oritenRes.status === "fulfilled" ? oritenRes.value : "";
  const tkz = tkzRes.status === "fulfilled" ? tkzRes.value : "";
  const weatherPrev = weatherPrevRes.status === "fulfilled" ? weatherPrevRes.value : "";
  const weatherCurrent = weatherCurrentRes.status === "fulfilled" ? weatherCurrentRes.value : "";

  // 公式beforeinfoは展示公開前から最新の水面気象を持っていることが多い。
  // 風は点数に直結するため、BOATCASTの前レース結果txtよりこちらを優先する。
  const officialBeforeInfoUrl = buildOfficialBeforeInfoUrl(venue, raceNo, dateStr);
  let officialBeforeInfoHtml = "";
  if (officialBeforeInfoUrl) {
    try { officialBeforeInfoHtml = await fetchHtml(officialBeforeInfoUrl); }
    catch (e) { officialBeforeInfoHtml = ""; }
  }

  const racers = parseBoatcastRacerInfo(str3);
  const racersByBoat = {};
  for (const r of racers) racersByBoat[r.boat] = r;

  let rows = null;
  let combinedRows = [];
  const rowErrors = [];
  const noOriginalDisplay = NO_ORIGINAL_DISPLAY_VENUES.has(venue);

  // 江戸川はオリジナル展示が無いため、展示補正は使わない。
  // ただし体重・チルト・進入など取れる付随情報は反映する。
  if (noOriginalDisplay) {
    const tkzRows = parseBoatcastTkzRows(tkz);
    const sttRows = parseBoatcastSttRows(stt);
    const byBoat = new Map();
    for (let boat = 1; boat <= 6; boat++) byBoat.set(boat, { boat, course: boat, tenji: "", isshu: "", mawari: "", chokusen: "", weight: "", tilt: "", displayDisabled: true });
    for (const list of [tkzRows, sttRows]) {
      for (const row of list || []) {
        const b = Number(row.boat);
        if (!byBoat.has(b)) continue;
        const cleaned = { ...row };
        delete cleaned.tenji;
        delete cleaned.isshu;
        delete cleaned.mawari;
        delete cleaned.chokusen;
        byBoat.set(b, { ...byBoat.get(b), ...Object.fromEntries(Object.entries(cleaned).filter(([, v]) => v !== "" && v != null)), displayDisabled: true });
      }
    }
    rows = [...byBoat.values()].sort((a, b) => a.boat - b.boat);
  }

  // パターンA: BOATCASTのタブ区切り形式（芦屋・鳴門など）
  // tkz=展示タイム/体重/チルト、oriten=一周/まわり足/直線、stt=進入を合体する。
  if (!rows) {
    try {
      const combined = combineBoatcastDisplayRows(tkz, oriten, stt);
      combinedRows = combined;
      if (validRows(combined)) rows = combined;
      else rowErrors.push(`combined: ${combined.filter((r) => r.tenji || r.isshu || r.mawari).length}艇`);
    } catch (e) {
      rowErrors.push(`combined: ${e.message || e}`);
    }
  }

  // パターンB: 画面本文形式/既存形式。単独テキストから6艇分を読む。
  if (!rows) {
    for (const [label, raw] of [["oriten", oriten], ["tkz", tkz], ["stt", stt], ["str3", str3]]) {
      if (!raw) continue;
      try {
        const parsed = parseBoatcastDisplay(raw);
        if (validRows(parsed)) { rows = parsed; break; }
        rowErrors.push(`${label}: ${parsed?.length || 0}艇`);
      } catch (e) {
        rowErrors.push(`${label}: ${e.message || e}`);
      }
    }
  }

  // パターンC: BOATCASTのtxt分割が崩れる/一部txtだけ欠けるレース用。
  // 公式beforeinfoにも展示・一周・まわり足・直線が出る場面があるため、全場共通の最終フォールバックにする。
  // 大村10RのようにBOATCAST画面では出ているのにtxt結合だけ失敗するケースを救済する。
  if (!rows) {
    const officialUrl = officialBeforeInfoUrl;
    if (officialUrl && officialBeforeInfoHtml) {
      try {
        const officialHtml = officialBeforeInfoHtml;
        const officialRows = parseDisplayRowsByLines(officialHtml, venue);
        if (validRows(officialRows)) {
          const sttRows = parseBoatcastSttRows(stt);
          rows = sanitizeDisplayRows(officialRows.map((r) => {
            const st = sttRows.find((x) => Number(x.boat) === Number(r.boat));
            return st ? { ...r, course: st.course || r.course || r.boat } : r;
          }));
        } else {
          rowErrors.push(`official-beforeinfo: ${officialRows?.length || 0}艇`);
        }
      } catch (e) {
        rowErrors.push(`official-beforeinfo: ${e.message || e}`);
      }
    }
  }

  let exhibitionSaved = { ok: false, skipped: true, reason: "展示未取得" };
  if (rows) {
    rows = sanitizeDisplayRows(rows).map((r) => ({ ...r, racer: racersByBoat[r.boat] || null }));
    exhibitionSaved = await saveExhibitionRows({ venue, raceNo, ymd: dateStr, rows, source: "BOATCAST" });
  }

  // 風は「現在選択しているレースの公式beforeinfo」を最優先。
  // 以前は前レースのBOATCAST結果txtを先に見ていたため、展示公開前の次Rで古い風/無風が残ることがあった。
  // 優先順: 公式beforeinfo(現在R) → BOATCAST現在R → 直前情報txt → 前R結果txt(最終フォールバック)。
  const officialWeather = officialBeforeInfoHtml ? { ...parseWeather(officialBeforeInfoHtml, venue), windSource: "official-beforeinfo" } : {};
  const currentResultWeather = weatherCurrent ? { ...parseBoatcastResultWeather(weatherCurrent), windSource: "boatcast-current-result" } : {};
  const currentTextWeather = (tkz || stt || str3) ? { ...parseWeather(tkz || stt || str3, venue), windSource: "boatcast-current-info" } : {};

  // 現在Rの候補を信頼度順で統合する。
  // 明示文字(text) > 明示属性(attr) > 正確な is-windN(number)。
  // 公式beforeinfoを先に採っただけで、より信頼できるBOATCAST文字情報を無視しない。
  let weather = {};
  for (const candidate of [officialWeather, currentResultWeather, currentTextWeather]) {
    if (!candidate || (!candidate.windDirection && candidate.windSpeed === "" && !candidate.windKey)) continue;
    if (!weather.windDirection && weather.windSpeed === undefined) {
      weather = { ...candidate };
    } else {
      const before = { ...weather };
      weather = mergeWeatherPreferReliable(weather, candidate);
      const beforeRank = weatherConfidenceRank(before.windConfidence);
      const candidateRank = weatherConfidenceRank(candidate.windConfidence);
      if (candidate.windSource && (candidateRank > beforeRank || (!before.windDirection && candidate.windDirection))) {
        weather.windSource = candidate.windSource;
      }
      if (!weather.windSource) weather.windSource = before.windSource || candidate.windSource || "";
    }
  }

  // 前R結果は現在Rの風がまったく取れない場合だけ使用。現在Rの方向を上書きしない。
  if (!weather.windDirection && (weather.windSpeed === "" || weather.windSpeed == null)) {
    const prev = parseBoatcastResultWeather(weatherPrev);
    if (prev.windDirection || prev.windKey) weather = { ...prev, windSource: "boatcast-previous-result-fallback" };
  }
  weather.windKey = windKeyFromDirectionAndSpeed(weather.windDirection, weather.windSpeed);

  let oddsInfo = null;
  try { oddsInfo = await fetchBoatcastOddsForVenue(venue, raceNo, dateStr); }
  catch (e) { oddsInfo = { ok: false, error: e.message || String(e) }; }

  const displayIssue = rows
    ? { code: "", message: "" }
    : classifyBoatcastDisplayIssue({ venue, racers, tkz, oriten, stt, combined: combinedRows, rowErrors });
  const displayError = displayIssue.message || rowErrors.join(" / ") || "公開展示待ちです。";

  return {
    ok: true,
    source: "BOATCAST",
    url: urls.oriten,
    boatcastUrls: urls,
    rows: rows || [],
    displayPending: !rows,
    displayError: rows ? "" : displayError,
    displayReasonCode: rows ? "" : displayIssue.code,
    displayErrorDetail: rows ? "" : (displayIssue.detail || ""),
    displayDisabled: noOriginalDisplay,
    racers,
    motors: racersToMotorMap(racers),
    weather,
    weatherUrl: weather.windKey ? (officialBeforeInfoUrl || urls.weatherCurrent || urls.weatherPrev) : null,
    odds: oddsInfo?.ok ? oddsInfo.odds : null,
    oddsCount: oddsInfo?.ok ? oddsInfo.count : 0,
    oddsUrl: oddsInfo?.ok ? oddsInfo.url : null,
    oddsError: oddsInfo && !oddsInfo.ok ? oddsInfo.error : "",
    exhibitionSaved,
  };
}

function splitOddsCells(line) {
  const s = String(line || "").trim();
  if (!s) return [];
  return s.includes("\t")
    ? s.split("\t").map((c) => c.trim()).filter(Boolean)
    : s.split(/[ 　]+/).map((c) => c.trim()).filter(Boolean);
}

function isBoatNoText(x) {
  return /^[1-6]$/.test(String(x || "").trim());
}

function isOddsNoText(x) {
  return /^\d+(?:\.\d+)?$/.test(String(x || "").replace(/,/g, "").trim());
}

function toOddsNo(x) {
  return Number(String(x || "").replace(/,/g, "").trim());
}

function parseOddsTextLines(rawLines) {
  const usable = rawLines.map((l) => String(l || "").trim()).filter(Boolean);
  const out = {};
  let first = null;
  let second = null;

  for (let li = 0; li < usable.length; li++) {
    const line = usable[li];
    if (/更新ボタン|レース情報|Copyright|All Rights Reserved|TOP\b/.test(line)) {
      if (Object.keys(out).length >= 10) break;
    }
    const cells = splitOddsCells(line);
    if (!cells.length) continue;

    const isHeader = (
      cells.length >= 2
        && isBoatNoText(cells[0])
        && !isOddsNoText(cells[1])
        && !/合成|単勝|複勝|3連単|2連単|3連複|拡連複|人気|高配当|更新|締切|MENU/.test(line)
    ) || (
      // 住之江など: 1着艇番号だけが単独行、その次の行に選手名が来る形式
      cells.length === 1
        && isBoatNoText(cells[0])
        && usable[li + 1]
        && !isBoatNoText(usable[li + 1])
        && !isOddsNoText(usable[li + 1])
        && !/合成|単勝|複勝|3連単|2連単|3連複|拡連複|人気|高配当|更新|締切|MENU|予選/.test(usable[li + 1])
    );

    if (isHeader) {
      first = Number(cells[0]);
      second = null;
      continue;
    }
    if (!first) continue;

    if (cells.length >= 3 && isBoatNoText(cells[0]) && isBoatNoText(cells[1]) && isOddsNoText(cells[2])) {
      second = Number(cells[0]);
      const third = Number(cells[1]);
      const o = toOddsNo(cells[2]);
      if (second !== first && third !== first && third !== second && o > 0) out[`${first}-${second}-${third}`] = o;
      for (let i = 3; i + 1 < cells.length; i += 2) {
        const t = Number(cells[i]);
        const oo = toOddsNo(cells[i + 1]);
        if (second && t >= 1 && t <= 6 && t !== first && t !== second && oo > 0) out[`${first}-${second}-${t}`] = oo;
      }
      continue;
    }

    if (second && cells.length >= 2 && isBoatNoText(cells[0]) && isOddsNoText(cells[1])) {
      const third = Number(cells[0]);
      const o = toOddsNo(cells[1]);
      if (third !== first && third !== second && o > 0) out[`${first}-${second}-${third}`] = o;
      for (let i = 2; i + 1 < cells.length; i += 2) {
        const t = Number(cells[i]);
        const oo = toOddsNo(cells[i + 1]);
        if (t >= 1 && t <= 6 && t !== first && t !== second && oo > 0) out[`${first}-${second}-${t}`] = oo;
      }
    }
  }
  return out;
}

function parseGridOddsTextLines(rawLines) {
  const blocks = [];
  let cur = null;
  for (const line of rawLines) {
    const cells = splitOddsCells(line);
    if (!cells.length) continue;
    const isHeader = (cells.length >= 2
      && isBoatNoText(cells[0])
      && !/^[\d.]/.test(cells[1])
      && !/合成|単勝|複勝|3連単|2連単|3連複|拡連複|人気|高配当|更新/.test(line))
      || (cells.length === 1 && isBoatNoText(cells[0]));
    if (isHeader) {
      if (cur) blocks.push(cur);
      cur = { first: Number(cells[0]), rows: [] };
    } else if (cur && !/合成|単勝|複勝/.test(line)) {
      cur.rows.push(cells);
    }
  }
  if (cur) blocks.push(cur);

  const out = {};
  for (const blk of blocks) {
    const first = blk.first;
    const rows = blk.rows;
    if (!rows.length) continue;
    const colSeconds = [];
    const r0 = rows[0];
    for (let i = 0; i + 2 < r0.length; i += 3) {
      const sec = Number(r0[i]);
      const third = Number(r0[i + 1]);
      const o = toOddsNo(r0[i + 2]);
      if ([sec, third].every((x) => x >= 1 && x <= 6) && o > 0) {
        colSeconds.push(sec);
        if (third !== first && third !== sec) out[`${first}-${sec}-${third}`] = o;
      }
    }
    for (let ri = 1; ri < rows.length; ri++) {
      const toks = rows[ri];
      for (let ci = 0; ci < colSeconds.length; ci++) {
        const third = Number(toks[ci * 2]);
        const o = toOddsNo(toks[ci * 2 + 1]);
        const sec = colSeconds[ci];
        if (third >= 1 && third <= 6 && o > 0 && third !== first && third !== sec) out[`${first}-${sec}-${third}`] = o;
      }
    }
  }
  return out;
}

function parseGroupedOddsTextLines(rawLines) {
  const lines = rawLines.map((l) => String(l || "").trim()).filter(Boolean);
  const blocks = [];

  const isNameLike = (line) => {
    const cells = splitOddsCells(line);
    return line && !isOddsNoText(line) && !(cells.length === 1 && isBoatNoText(cells[0])) && !/3連単|2連単|3連複|人気|締切|予選|オッズ|結果/.test(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const cells = splitOddsCells(lines[i]);
    let first = null;
    let start = -1;

    if (cells.length === 1 && isBoatNoText(cells[0]) && isNameLike(lines[i + 1] || "")) {
      first = Number(cells[0]);
      start = i + 1;
    } else if (cells.length >= 2 && isBoatNoText(cells[0]) && !isOddsNoText(cells[1]) && !/3連単|2連単|3連複|人気|締切/.test(lines[i])) {
      first = Number(cells[0]);
      start = i;
    }

    if (!first) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const cc = splitOddsCells(lines[j]);
      if (cc.length === 1 && isBoatNoText(cc[0]) && isNameLike(lines[j + 1] || "")) { end = j; break; }
      if (cc.length >= 2 && isBoatNoText(cc[0]) && !isOddsNoText(cc[1]) && !/3連単|2連単|3連複|人気|締切/.test(lines[j])) { end = j; break; }
    }
    blocks.push({ first, lines: lines.slice(start, end) });
    i = end - 1;
  }

  const out = {};
  for (const blk of blocks) {
    const nums = [];
    for (const line of blk.lines) {
      for (const c of splitOddsCells(line)) {
        if (isOddsNoText(c)) nums.push(toOddsNo(c));
      }
    }

    let i = 0;
    while (i < nums.length) {
      const sec = nums[i++];
      if (!(Number.isInteger(sec) && sec >= 1 && sec <= 6) || sec === blk.first) continue;
      for (let k = 0; k < 4 && i + 1 < nums.length; k++) {
        const third = nums[i++];
        const odds = nums[i++];
        if (Number.isInteger(third) && third >= 1 && third <= 6 && third !== blk.first && third !== sec && odds > 0) {
          out[`${blk.first}-${sec}-${third}`] = odds;
        }
      }
    }
  }
  return out;
}


function parseOddsFromHtml(html) {
  const lines = textLinesFromHtml(html);
  const boatcast = parseBoatcastOddsTxt(html);
  const seq = parseOddsTextLines(lines);
  const grid = parseGridOddsTextLines(lines);
  const grouped = parseGroupedOddsTextLines(lines);
  const candidates = [boatcast, seq, grid, grouped];
  return candidates.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] || {};
}

function buildOddsUrls(venue, raceNo, dateStr) {
  const ymd = yyyymmdd(dateStr);
  const r = Number(raceNo);
  const jcd = JCD[venue];
  const urls = [];

  const bc = boatcastRaceUrls(venue, raceNo, ymd);
  if (bc) {
    urls.push(bc.oddsLive);
    urls.push(bc.oddsFixed);
  }

  if (venue === "丸亀") {
    const rr = String(r).padStart(2, "0");
    urls.push(`https://www.marugameboat.jp/asp/kyogi/15/pc/odds01${rr}.htm`);
  }

  if (venue === "蒲郡") {
    const rr = String(r).padStart(2, "0");
    urls.push(`https://www.gamagori-kyotei.com/asp/gamagori/kyogi/kyogihtml/ozz3rentanpuku/ozz3rentanpuku${ymd}07${rr}.htm`);
  }

  if (venue === "下関") {
    urls.push(`https://www.boatrace-shimonoseki.jp/modules/yosou/group-odds-result.php?day=${ymd}&race=${r}&if=1`);
  }

  if (venue === "住之江") {
    const rr = String(r).padStart(2, "0");
    urls.push(`https://www.boatrace-suminoe.jp/asp/kyogi/12/pc/odds01${rr}.htm`);
  }

  if (venue === "三国") {
    urls.push(`https://www.boatrace-mikuni.jp/modules/yosou/group-odds-result.php?day=${ymd}&race=${r}&if=1`);
  }

  if (venue === "唐津") {
    urls.push(`https://www.boatrace-karatsu.jp/sp/index.php?page=yosou-odds&race=${r}`);
    urls.push(`https://www.boatrace-karatsu.jp/sp/index.php?page=odds&race=${r}`);
    urls.push(`https://www.boatrace-karatsu.jp/sp/index.php?page=yosou-odds3t&race=${r}`);
    urls.push(`https://www.boatrace-karatsu.jp/sp/index.php?page=yosou-cyokuzen&race=${r}`);
  }

  if (venue === "鳴門") {
    urls.push(`https://www.n14.jp/modules/yosou/group-odds-result.php?day=${ymd}&race=${r}&if=1`);
  }

  if (venue === "児島") {
    const rr = String(r).padStart(2, "0");
    urls.push(`https://www.kojimaboat.jp/asp/kyogi/16/pc/odds01${rr}.htm`);
    urls.push(`https://www.kojimaboat.jp/asp/kyogi/16/sp/odds01${rr}.htm`);
  }

  if (venue === "福岡") {
    urls.push(`https://www.boatrace-fukuoka.com/sp/index.php?page=yosou-odds&race=${r}`);
    urls.push(`https://www.boatrace-fukuoka.com/sp/index.php?page=yosou-odds#start_position`);
  }

  if (venue === "平和島") {
    const rr = String(r).padStart(2, "0");
    urls.push(`https://www.heiwajima.gr.jp/asp/kyogi/04/pc/odds01${rr}.htm`);
    urls.push(`https://www.heiwajima.gr.jp/asp/kyogi/04/sp/odds01${rr}.htm`);
  }

  if (venue === "びわこ") {
    urls.push(`https://www.boatrace-biwako.jp/sp/index.php?page=yosou-odds&race=${r}`);
    urls.push(`https://www.boatrace-biwako.jp/sp/index.php?page=yosou-odds#start_position`);
  }

  if (venue === "常滑") {
    urls.push(`https://www.boatrace-tokoname.jp/modules/yosou/group-odds-result.php?day=${ymd}&race=${r}&if=1`);
  }

  if (venue === "浜名湖") {
    urls.push(`https://www.boatrace-hamanako.jp/modules/yosou/group-odds-result.php?day=${ymd}&race=${r}&if=1`);
  }

  if (jcd) {
    urls.push(`https://www.boatrace.jp/owpc/pc/race/odds3t?rno=${r}&jcd=${jcd}&hd=${ymd}`);
  }

  return urls;
}

async function fetchOddsForVenue(venue, raceNo, dateStr) {
  if (!JCD[venue]) return null;
  const errors = [];
  for (const url of buildOddsUrls(venue, raceNo, dateStr)) {
    try {
      const html = await fetchHtml(url);
      const odds = parseOddsFromHtml(html);
      const count = Object.keys(odds).length;
      if (count >= 10) return { ok: true, url, count, odds };
      errors.push(`${url} => ${count}点`);
    } catch (e) {
      errors.push(`${url} => ${e.message || e}`);
    }
  }
  return { ok: false, error: errors.join(" / ") };
}


function buildRaceIndexUrl(venue, dateStr) {
  const jcd = JCD[venue];
  if (!jcd) throw new Error(`${venue || "未選択"}の場コードが見つかりません`);
  const ymd = yyyymmdd(dateStr);
  return `https://www.boatrace.jp/owpc/pc/race/raceindex?jcd=${jcd}&hd=${ymd}`;
}

function findDeadlineTimeInText(raw) {
  const text = pickText(raw).replace(/時/g, ":").replace(/分/g, "");
  const preferred = text.match(/(?:締切予定|発売締切|締切時刻|投票締切|締切)\s*[:：]?\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/);
  const m = preferred || text.match(/\b([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\b/);
  if (!m) return null;
  const h = String(Number(m[1])).padStart(2, "0");
  const min = String(Number(m[2])).padStart(2, "0");
  return { time: `${h}:${min}`, minutes: Number(h) * 60 + Number(min) };
}

function uniqueRaceAnchors(html) {
  const anchors = [];
  const re = /(?:[?&](?:rno|race_no)=0?([1-9]|1[0-2])\b|(?:raceindex|racelist|beforeinfo|odds3t|program|result)[^"'<>]*?[?&]rno=0?([1-9]|1[0-2])\b)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const race = Number(m[1] || m[2]);
    if (!race) continue;
    anchors.push({ race, idx: m.index });
  }
  anchors.sort((a, b) => a.idx - b.idx);
  const picked = [];
  const seen = new Set();
  for (const a of anchors) {
    if (!seen.has(a.race)) {
      picked.push(a);
      seen.add(a.race);
    }
  }
  return picked.sort((a, b) => a.idx - b.idx);
}

function parseRaceIndexSchedule(html) {
  const decoded = decodeEntities(String(html || ""));
  const byRace = new Map();

  // 1) boatrace.jp の raceindex 内リンク（rno=1〜12）の近辺から締切時刻を拾う
  const anchors = uniqueRaceAnchors(decoded);
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    const next = anchors.find((a, j) => j > i && a.race !== cur.race);
    const section = decoded.slice(cur.idx, next ? next.idx : Math.min(decoded.length, cur.idx + 5000));
    const hit = findDeadlineTimeInText(section);
    if (hit && !byRace.has(cur.race)) byRace.set(cur.race, { race: cur.race, deadline: hit.time, deadlineMinutes: hit.minutes });
  }

  // 2) テキスト化した行から「1R ... 締切 10:xx」型を拾う
  const lines = textLinesFromHtml(decoded);
  for (let i = 0; i < lines.length; i++) {
    const m = String(lines[i]).match(/^(?:第\s*)?([1-9]|1[0-2])\s*R\b|^([1-9]|1[0-2])R\b/);
    const race = m ? Number(m[1] || m[2]) : 0;
    if (!race || byRace.has(race)) continue;
    const block = lines.slice(i, Math.min(lines.length, i + 30)).join(" ");
    const hit = findDeadlineTimeInText(block);
    if (hit) byRace.set(race, { race, deadline: hit.time, deadlineMinutes: hit.minutes });
  }

  // 3) 最後の保険。全文をざっくり走査する
  const text = lines.join(" ");
  const re = /(?:第\s*)?([1-9]|1[0-2])\s*R[\s\S]{0,160}?(?:締切予定|発売締切|締切時刻|投票締切|締切)?\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const race = Number(m[1]);
    if (!race || byRace.has(race)) continue;
    const h = String(Number(m[2])).padStart(2, "0");
    const min = String(Number(m[3])).padStart(2, "0");
    byRace.set(race, { race, deadline: `${h}:${min}`, deadlineMinutes: Number(h) * 60 + Number(min) });
  }

  const schedule = [...byRace.values()]
    .filter((x) => x.race >= 1 && x.race <= 12 && x.deadline)
    .sort((a, b) => a.race - b.race);
  return schedule;
}

function normalizeRaceMetaText(s) {
  return decodeEntities(String(s || ""))
    .replace(/[Ｓ]/g, "S")
    .replace(/[Ｇ]/g, "G")
    .replace(/[ⅠＩⅡⅢ]/g, (ch) => ({ "Ⅰ": "1", "Ｉ": "1", "Ⅱ": "2", "Ⅲ": "3" }[ch] || ch))
    .replace(/Ｇ/g, "G")
    .replace(/\s+/g, " ")
    .trim();
}

function inferGradeFromText(text) {
  const t = normalizeRaceMetaText(text);

  // 固有大会名を一般的な語（オールスター/ダービー等）より先に判定する。
  // 例: レディースオールスターをSG、ヤングダービーをSGと誤判定しない。
  if (/(レディースオールスター|女子オールスター)/i.test(t)) return "G2";
  if (/(PG1|P G1|プレミアムG1|BBCトーナメント|バトルチャンピオントーナメント|ヤングダービー|クイーンズクライマックス|レディースチャンピオン|女子王座(?:決定戦)?|賞金女王(?:決定戦)?|スピードクイーンメモリアル|マスターズチャンピオン)/i.test(t)) return "PG1";
  if (/(G3|G 3|オールレディース|企業杯|マスターズリーグ|イースタンヤング|ウエスタンヤング)/i.test(t)) return "G3";
  if (/(G2|G 2|モーターボート大賞|秩父宮妃記念杯|全国ボートレース甲子園)/i.test(t)) return "G2";
  if (/(SG|S G|グランプリ|賞金王|ボートレースクラシック|総理大臣杯|ボートレースオールスター|笹川賞|グランドチャンピオン|グラチャン|オーシャンカップ|ボートレースメモリアル|モーターボート記念|ボートレースダービー|全日本選手権|チャレンジカップ)/i.test(t)) return "SG";
  if (/(G1|G 1|周年|地区選手権|高松宮記念|ダイヤモンドカップ)/i.test(t)) return "G1";
  return "一般";
}

function inferLadiesFromText(text) {
  const t = normalizeRaceMetaText(text);

  // 男女混合企画は大会名だけで全レースを女子戦扱いしない。
  // そのレースの6艇が全員女子選手の時だけ、後段の allFemale 判定で女子戦にする。
  if (/(レディース\s*(?:VS|対)\s*ルーキーズ|男女W優勝戦|男女ダブル優勝戦|男女混合)/i.test(t)) return null;

  if (/(オールレディース|レディースチャンピオン|レディースオールスター|クイーンズクライマックス|ヴィーナス(?:シリーズ)?|女子リーグ|女子王座(?:決定戦)?|賞金女王(?:決定戦)?|スピードクイーンメモリアル|女子レーサー)/i.test(t)) return true;
  if (/(女子|レディース|クイーンズ)/i.test(t)) return true;
  return false;
}

function inferRaceTypeFromText(text) {
  const t = normalizeRaceMetaText(text);
  if (/優勝戦/.test(t)) return "優勝戦";
  if (/準優勝戦|準優/.test(t)) return "準優勝戦";
  if (/ドリーム/.test(t)) return "ドリーム";
  if (/選抜/.test(t)) return "選抜";
  if (/特選/.test(t)) return "特選";
  if (/予選/.test(t)) return "予選";
  if (/一般/.test(t)) return "一般戦";
  return "";
}

function parseRaceIndexMeta(html) {
  const lines = textLinesFromHtml(html);
  const text = lines.join(" ");

  let eventName = "";
  const titleCandidates = lines.filter((l) =>
    /(杯|選手権|競走|レース|ヴィーナス|ルーキー|周年|タイトル|オールレディース|クイーンズ|グランプリ|ダービー)/.test(l)
    && !/(一覧|発売|締切|オッズ|結果|出走表|投票|ログイン|更新|トップ|メニュー)/.test(l)
  );
  if (titleCandidates.length) eventName = normalizeRaceMetaText(titleCandidates[0]).slice(0, 120);

  const metaText = `${eventName} ${text.slice(0, 5000)}`;
  const grade = inferGradeFromText(metaText);
  const isLadies = inferLadiesFromText(metaText);
  const raceType = inferRaceTypeFromText(metaText);

  const dayMatch = metaText.match(/(初日|2日目|３日目|3日目|４日目|4日目|５日目|5日目|最終日)/);
  const eventDay = dayMatch ? dayMatch[1].replace(/[３４５]/g, (ch) => ({ "３":"3", "４":"4", "５":"5" }[ch] || ch)) : "";

  return { grade, eventDay, eventName, isLadies, raceType };
}

function raceMetaRowsFromSchedule({ venue, ymd, schedule, meta = {}, raceNo = null, racers = null, source = "BOATCAST_RACEINDEX" }) {
  const raceDate = ymdToDate(ymd);
  const placeNo = PLACE_NO_BY_VENUE[venue];
  if (!raceDate || !placeNo) return [];

  const allFemale = Array.isArray(racers) && racers.length >= 6 && racers.slice(0, 6).every((r) => r?.isFemale === true);
  const races = raceNo ? [{ race: Number(raceNo) }] : (Array.isArray(schedule) ? schedule : []);
  const rows = [];

  for (const item of races) {
    const rn = Number(item?.race || item?.race_no || item);
    if (!rn || rn < 1 || rn > 12) continue;

    const row = {
      race_date: raceDate,
      place_no: placeNo,
      race_no: rn,
      metadata_source: source,
      metadata_captured_at: new Date().toISOString(),
    };

    if (meta.grade) row.grade = meta.grade;
    if (meta.eventName) row.race_title = meta.eventName;
    if (meta.raceType) row.race_type = meta.raceType;

    if (typeof meta.isLadies === "boolean") row.is_ladies = meta.isLadies;
    if (allFemale) row.is_ladies = true;

    rows.push(row);
  }
  return rows;
}

async function saveRaceMetaRows(args) {
  if (!ENABLE_PERSISTENT_CACHE) return { ok: false, skipped: true, reason: "SUPABASE_SERVICE_KEYなし" };
  const rows = raceMetaRowsFromSchedule(args);
  if (!rows.length) return { ok: false, skipped: true, reason: "保存対象なし" };
  try {
    await supabaseCacheRequest("races?on_conflict=race_date,place_no,race_no", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return { ok: true, count: rows.length };
  } catch (e) {
    console.warn("race meta write skipped:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

function jstNowParts() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute || 0);
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    dateValue: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function scheduleState(schedule, ymd) {
  const now = jstNowParts();
  const list = Array.isArray(schedule) ? schedule : [];
  if (!list.length) {
    return {
      now,
      nextRace: "",
      nextDeadline: "",
      allClosed: false,
      noRace: true,
      status: "未開催",
    };
  }

  let next = null;
  if (ymd > now.ymd) {
    next = list[0] || null;
  } else if (ymd === now.ymd) {
    next = list.find((r) => Number(r.deadlineMinutes) > now.minutes) || null;
  }
  const allClosed = !next;
  return {
    now,
    nextRace: next ? String(next.race) : "",
    nextDeadline: next ? next.deadline : "",
    nextDeadlineMinutes: next ? Number(next.deadlineMinutes) : null,
    allClosed,
    noRace: false,
    status: next ? "発売中" : "発売終了",
  };
}

function scheduleSummary(payload) {
  if (!payload) return { ok: false, status: "未確認", error: "no payload" };
  return {
    ok: payload.ok !== false,
    venue: payload.venue,
    status: payload.status || (payload.noRace ? "未開催" : payload.allClosed ? "発売終了" : "発売中"),
    noRace: !!payload.noRace,
    allClosed: !!payload.allClosed,
    nextRace: payload.nextRace || "",
    nextDeadline: payload.nextDeadline || "",
    nextDeadlineMinutes: payload.nextDeadlineMinutes ?? null,
    scheduleCount: Array.isArray(payload.schedule) ? payload.schedule.length : (payload.scheduleCount || 0),
    grade: payload.grade || "",
    eventDay: payload.eventDay || "",
    eventName: payload.eventName || "",
    error: payload.error || "",
    cached: !!payload.cached,
    fetchedAt: payload.fetchedAt || "",
  };
}

async function fetchSchedulePayload(venue, ymd) {
  if (!venue) throw new Error("venue を指定してください");
  const key = `schedule:${venue}:${ymd}`;
  pruneCache();
  return await withSharedCache(key, SCHEDULE_CACHE_MS, async () => {
    const url = buildRaceIndexUrl(venue, ymd);
    const html = await fetchHtml(url).catch((e) => {
      throw new Error(`${venue}の締切時刻取得失敗: ${e.message || e}`);
    });
    const schedule = parseRaceIndexSchedule(html);
    const meta = parseRaceIndexMeta(html);
    const raceMetaSaved = await saveRaceMetaRows({ venue, ymd, schedule, meta, source: "BOATCAST_RACEINDEX" });
    const state = scheduleState(schedule, ymd);
    return {
      ok: true,
      action: "schedule",
      appVersion: "v115",
      venue,
      date: ymd,
      url,
      schedule,
      scheduleCount: schedule.length,
      ...meta,
      raceMetaSaved,
      ...state,
      fetchedAt: new Date().toISOString(),
    };
  }, { staleMs: SCHEDULE_CACHE_MS, allowStale: false });
}


function buildUrl(venue, raceNo, dateStr) {
  const rr = String(raceNo).padStart(2, "0");
  const ymd = yyyymmdd(dateStr);
  if (venue === "丸亀") return `https://www.marugameboat.jp/asp/kyogi/15/pc/yoso05${rr}.htm`;
  if (venue === "平和島") return `https://www.heiwajima.gr.jp/asp/kyogi/04/pc/yoso05${rr}.htm`;
  if (venue === "児島") return `https://www.kojimaboat.jp/asp/kyogi/16/pc/yoso05${rr}.htm`;
  if (venue === "蒲郡") return `https://www.gamagori-kyotei.com/asp/gamagori/sp/kyogi/kyogihtml/recomend/recomend${ymd}07${rr}.htm`;
  if (venue === "住之江") return `https://www.boatrace-suminoe.jp/asp/kyogi/12/pc/st02${rr}.htm`;
  if (venue === "下関") return `https://www.boatrace-shimonoseki.jp/modules/yosou/group-cyokuzen.php?day=${ymd}&race=${Number(raceNo)}&if=1`;
  if (venue === "三国") return `https://www.boatrace-mikuni.jp/modules/yosou/group-cyokuzen.php?day=${ymd}&race=${Number(raceNo)}&if=1`;
  if (venue === "鳴門") return `https://www.n14.jp/modules/yosou/group-cyokuzen.php?day=${ymd}&race=${Number(raceNo)}&if=1`;
  if (venue === "常滑") return `https://www.boatrace-tokoname.jp/modules/yosou/group-cyokuzen.php?day=${ymd}&race=${Number(raceNo)}&if=1`;
  if (venue === "浜名湖") return `https://www.boatrace-hamanako.jp/modules/yosou/group-cyokuzen.php?day=${ymd}&race=${Number(raceNo)}&if=1`;
  if (venue === "唐津") return `https://www.boatrace-karatsu.jp/sp/index.php?page=yosou-cyokuzen&race=${Number(raceNo)}`;
  if (venue === "福岡") return `https://www.boatrace-fukuoka.com/sp/index.php?page=yosou-cyokuzen&race=${Number(raceNo)}`;
  if (venue === "びわこ") return `https://www.boatrace-biwako.jp/sp/index.php?page=yosou-cyokuzen&race=${Number(raceNo)}`;
  throw new Error(`${venue || "未選択"}はまだ展示等自動取得未対応です`);
}

function buildOfficialBeforeInfoUrl(venue, raceNo, dateStr) {
  const jcd = JCD[venue];
  if (!jcd) return "";
  const ymd = yyyymmdd(dateStr);
  return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?jcd=${jcd}&rno=${Number(raceNo)}&hd=${ymd}`;
}

function buildDisplayUrls(venue, raceNo, dateStr) {
  const rr = String(raceNo).padStart(2, "0");
  const ymd = yyyymmdd(dateStr);
  const primary = buildUrl(venue, raceNo, dateStr);
  const urls = [primary];

  // 下関は直前情報の中身が通常版とkind=2版に分かれることがあるため、両方試す。
  // 通常版で0艇になった場合でもkind=2版で展示等が取れるケースを救済する。
  if (venue === "下関") {
    urls.push(`https://www.boatrace-shimonoseki.jp/modules/yosou/group-cyokuzen.php?day=${ymd}&race=${Number(raceNo)}&kind=2&if=1`);
  }

  return [...new Set(urls)];
}

function parseByVenue(venue, html) {
  if (venue === "丸亀") return parseMarugameYoso05(html);
  if (venue === "平和島") return parseHeiwajimaYoso05(html);
  if (venue === "児島") return parseKojimaYoso05(html);
  if (venue === "蒲郡") return parseGamagoriRecomend(html);
  if (venue === "住之江") return parseSuminoeSt02(html);
  if (venue === "下関") return parseShimonosekiCyokuzen(html);
  if (venue === "三国") return parseMikuniCyokuzen(html);
  if (venue === "鳴門") return parseNarutoCyokuzen(html);
  if (venue === "常滑") return parseTokonameCyokuzen(html);
  if (venue === "浜名湖") return parseHamanakoCyokuzen(html);
  if (venue === "唐津") return parseKaratsuCyokuzen(html);
  if (venue === "福岡") return parseFukuokaCyokuzen(html);
  if (venue === "びわこ") return parseBiwakoCyokuzen(html);
  throw new Error(`${venue || "未選択"}はまだ展示等自動取得未対応です`);
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; HunakenAcademiaTool/1.0; +https://hunaken-academia.vercel.app)",
      "accept": "text/html,text/plain,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "referer": "https://race.boatcast.jp/",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

function validRows(rows) {
  return Array.isArray(rows) && rows.length >= 6 && rows.every((r) => r.boat && r.tenji && r.isshu && r.mawari);
}

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of cacheStore.entries()) {
    if (!v || now - Number(v.savedAt || 0) > STALE_CACHE_MS * 2) cacheStore.delete(k);
  }
  for (const [k, v] of inFlightStore.entries()) {
    if (!v) inFlightStore.delete(k);
  }
}

async function buildFullYosoPayload(venue, raceNo, ymd) {
  // BOATCAST許可済みデータを最優先。全24場共通形式で取得する。
  if (JCD[venue]) {
    try {
      const bc = await fetchBoatcastPayload(venue, raceNo, ymd);
      const preRaceStatusSaved = await savePreRaceStatus({ venue, raceNo, ymd, racers: bc.racers, source: "BOATCAST" });
      const raceMetaSaved = await saveRaceMetaRows({
        venue,
        ymd,
        raceNo,
        racers: bc.racers,
        meta: {},
        source: "BOATCAST_RACERS",
      });
      return {
        ok: true,
        appVersion: "v115",
        venue,
        race: raceNo,
        date: ymd,
        source: "BOATCAST",
        url: bc.url,
        boatcastUrls: bc.boatcastUrls,
        weatherUrl: bc.weatherUrl || bc.boatcastUrls?.weatherPrev || bc.boatcastUrls?.weatherCurrent || null,
        rows: bc.rows,
        displayPending: !!bc.displayPending,
        displayError: bc.displayError || "",
        displayReasonCode: bc.displayReasonCode || "",
        displayErrorDetail: bc.displayErrorDetail || "",
        displayDisabled: !!bc.displayDisabled,
        racers: bc.racers,
        preRaceStatusSaved,
        raceMetaSaved,
        motors: bc.motors,
        weather: bc.weather,
        odds: bc.odds,
        oddsCount: bc.oddsCount,
        oddsUrl: bc.oddsUrl,
        oddsError: bc.oddsError,
        fetchedAt: new Date().toISOString(),
      };
    } catch (e) {
      // 旧取得先で取れる場はフォールバック。未対応場はわかりやすいエラーにする。
      if (!["丸亀", "蒲郡", "下関", "住之江", "三国", "唐津", "鳴門", "児島", "福岡", "平和島", "びわこ", "常滑", "浜名湖"].includes(venue)) {
        throw new Error(`${venue}のデータ取得失敗: ${e.message || e}`);
      }
    }
  }

  let url = "";
  let html = "";
  let rows = null;
  let lastFetchError = null;
  const displayUrls = buildDisplayUrls(venue, raceNo, ymd);

  for (const candidateUrl of displayUrls) {
    try {
      const candidateHtml = await fetchHtml(candidateUrl);
      const candidateRows = parseByVenue(venue, candidateHtml);
      if (validRows(candidateRows)) {
        url = candidateUrl;
        html = candidateHtml;
        rows = candidateRows;
        break;
      }
      lastFetchError = new Error(`${venue}の展示・一周・まわり足・直線が6艇分そろいませんでした`);
    } catch (e) {
      lastFetchError = e;
    }
  }

  if (!rows) {
    throw new Error(`${venue}の展示データ取得失敗: ${lastFetchError?.message || lastFetchError || "取得できませんでした"}`);
  }

  let weather = parseWeather(html, venue);
  const weatherUrl = buildOfficialBeforeInfoUrl(venue, raceNo, ymd);
  if (weatherUrl) {
    try {
      const officialHtml = await fetchHtml(weatherUrl);
      const officialWeather = parseWeather(officialHtml, venue);
      weather = mergeWeatherPreferReliable(weather, officialWeather);
    } catch (e) {
      weather = { ...weather, weatherError: e.message || String(e) };
    }
  }

  let oddsInfo = null;
  try {
    oddsInfo = await fetchOddsForVenue(venue, raceNo, ymd);
  } catch (e) {
    oddsInfo = { ok: false, error: e.message || String(e) };
  }

  return {
    ok: true,
    venue,
    race: raceNo,
    date: ymd,
    url,
    weatherUrl: weatherUrl || null,
    rows,
    weather,
    odds: oddsInfo?.ok ? oddsInfo.odds : null,
    oddsCount: oddsInfo?.ok ? oddsInfo.count : 0,
    oddsUrl: oddsInfo?.ok ? oddsInfo.url : null,
    oddsError: oddsInfo && !oddsInfo.ok ? oddsInfo.error : "",
    fetchedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const action = String(req.query.action || "");
    const venue = String(req.query.venue || "");
    const date = String(req.query.date || "");
    const ymd = yyyymmdd(date);

    if (action === "schedule") {
      res.setHeader("Cache-Control", "public, s-maxage=180, stale-while-revalidate=600");
      if (!venue) {
        res.status(400).json({ ok: false, error: "venue を指定してください" });
        return;
      }
      const payload = await fetchSchedulePayload(venue, ymd);
      res.status(200).json(payload);
      return;
    }

    if (action === "schedules") {
      res.setHeader("Cache-Control", "public, s-maxage=180, stale-while-revalidate=600");
      const requested = String(req.query.venues || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const venues = requested.length ? requested.filter((v) => JCD[v]) : Object.keys(JCD);
      const results = await Promise.allSettled(venues.map((v) => fetchSchedulePayload(v, ymd)));
      const statusesByVenue = {};
      results.forEach((r, i) => {
        const v = venues[i];
        if (r.status === "fulfilled") {
          statusesByVenue[v] = scheduleSummary(r.value);
        } else {
          statusesByVenue[v] = { ok: false, venue: v, status: "未確認", error: r.reason?.message || String(r.reason || "取得失敗") };
        }
      });
      res.status(200).json({
        ok: true,
        action: "schedules",
        appVersion: "v115",
        date: ymd,
        statusesByVenue,
        fetchedAt: new Date().toISOString(),
      });
      return;
    }

    const race = String(req.query.race || "").replace(/\D/g, "");
    const raceNo = Number(race);
    if (!raceNo || raceNo < 1 || raceNo > 12) {
      res.status(400).json({ ok: false, error: "race は 1〜12 を指定してください" });
      return;
    }

    if (action === "prerace") {
      res.setHeader("Cache-Control", "no-store");
      if (!venue) {
        res.status(400).json({ ok: false, error: "venue を指定してください" });
        return;
      }
      if (!JCD[venue]) {
        res.status(400).json({ ok: false, error: `${venue}はBOATCAST取得対象外です` });
        return;
      }
      const payload = await fetchBoatcastPreRaceStatusPayload(venue, raceNo, ymd);
      res.status(200).json(payload);
      return;
    }

    if (action === "result") {
      res.setHeader("Cache-Control", "no-store");
      if (!venue) {
        res.status(400).json({ ok: false, error: "venue を指定してください" });
        return;
      }
      if (!JCD[venue]) {
        res.status(400).json({ ok: false, error: `${venue}は結果取得対象外です` });
        return;
      }
      const payload = await fetchBoatcastRaceResultPayload(venue, raceNo, ymd);
      res.status(200).json(payload);
      return;
    }

    if (action === "odds") {
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=180");
      if (!venue) {
        res.status(400).json({ ok: false, error: "venue を指定してください" });
        return;
      }
      const oddsKey = `odds:v115:${venue}:${raceNo}:${ymd}`;
      pruneCache();
      const payload = await withSharedCache(oddsKey, ODDS_CACHE_MS, async () => {
        const oddsInfo = await fetchOddsForVenue(venue, raceNo, ymd);
        if (!oddsInfo?.ok) throw new Error(oddsInfo?.error || `${venue}${raceNo}Rのオッズを取得できませんでした`);
        return {
          ok: true,
          action: "odds",
          appVersion: "v115",
          venue,
          race: raceNo,
          date: ymd,
          odds: oddsInfo.odds,
          oddsCount: oddsInfo.count,
          oddsUrl: oddsInfo.url,
          fetchedAt: new Date().toISOString(),
        };
      });
      res.status(200).json(payload);
      return;
    }

    res.setHeader("Cache-Control", "public, s-maxage=180, stale-while-revalidate=600");
    const key = `full:v115:${venue}:${raceNo}:${ymd}`;
    pruneCache();
    const payload = await withSharedCache(key, STATIC_CACHE_MS, async () => buildFullYosoPayload(venue, raceNo, ymd), { allowStale: false });
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
