// 過去の開催メタデータ（グレード・女子戦）を races_staging だけへ保存する。
// 本番 races は変更しない。1場1日につき公式 raceindex を1回取得する。

const BASE_URL = (
  process.env.PUBLIC_APP_URL ||
  process.env.APP_URL ||
  "https://newhunaken456.vercel.app"
).replace(/\/$/, "");

const CAPTURE_TOKEN = String(process.env.CAPTURE_TOKEN || "");

const args = process.argv.slice(2);

const startDate = args.find((x) =>
  /^\d{4}-\d{2}-\d{2}$/.test(x)
);

const daysArg = args.find((x) =>
  /^\d+$/.test(x)
);

const DRY = args.some(
  (x) => x === "--dry" || x === "--dry=true"
);

const CONTINUE_ON_ERROR = args.some(
  (x) =>
    x === "--continue-on-error" ||
    x === "--continue-on-error=true"
);

const CONCURRENCY = Math.max(
  1,
  Math.min(
    4,
    Number(process.env.METADATA_CONCURRENCY || 3)
  )
);

if (!startDate) {
  throw new Error("開始日 YYYY-MM-DD を指定してください");
}

const days = Number(daysArg || 1);

if (!Number.isInteger(days) || days < 1 || days > 31) {
  throw new Error("日数は1〜31で指定してください");
}

if (!DRY && !CAPTURE_TOKEN) {
  throw new Error(
    "CAPTURE_TOKEN が未設定です。staging保存には必須です"
  );
}

const venues = [
  "桐生",
  "戸田",
  "江戸川",
  "平和島",
  "多摩川",
  "浜名湖",
  "蒲郡",
  "常滑",
  "津",
  "三国",
  "びわこ",
  "住之江",
  "尼崎",
  "鳴門",
  "丸亀",
  "児島",
  "宮島",
  "徳山",
  "下関",
  "若松",
  "芦屋",
  "福岡",
  "唐津",
  "大村"
];

function addDays(dateText, n) {
  const [y, m, d] = dateText
    .split("-")
    .map(Number);

  const dt = new Date(
    Date.UTC(y, m - 1, d + n)
  );

  return dt.toISOString().slice(0, 10);
}

async function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function fetchOne(date, venue) {
  const qs = new URLSearchParams({
    action: "schedule",
    venue,
    date,
    target: "staging",
    dry: DRY ? "true" : "false"
  });

  const url = `${BASE_URL}/api/yoso?${qs}`;

  const res = await fetch(url, {
    headers: {
      "user-agent":
        "HunakenRaceMetadataBackfill/1.0",
      ...(CAPTURE_TOKEN
        ? {
            "x-capture-token": CAPTURE_TOKEN
          }
        : {})
    }
  });

  const text = await res.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || !json?.ok) {
    throw new Error(
      `${res.status} ${
        json?.error || text.slice(0, 240)
      }`
    );
  }

  return json;
}

const jobs = [];

for (let i = 0; i < days; i++) {
  const date = addDays(startDate, i);

  for (const venue of venues) {
    jobs.push({
      date,
      venue
    });
  }
}

let cursor = 0;
let ok = 0;
let noRace = 0;
let savedRows = 0;
let gradeKnown = 0;
let ladiesTrue = 0;

const errors = [];

console.log(
  `race metadata staging backfill start=${startDate} days=${days} jobs=${jobs.length} dry=${DRY} concurrency=${CONCURRENCY}`
);

async function worker(workerNo) {
  while (true) {
    const idx = cursor++;

    if (idx >= jobs.length) {
      return;
    }

    const {
      date,
      venue
    } = jobs[idx];

    try {
      const r = await fetchOne(
        date,
        venue
      );

      const count = Number(
        r?.raceMetaSaved?.count || 0
      );

      const scheduleCount = Number(
        r?.scheduleCount ||
        r?.schedule?.length ||
        0
      );

      if (scheduleCount === 0) {
        noRace++;
      } else {
        ok++;
      }

      savedRows += count;

      if (r?.grade) {
        gradeKnown += count;
      }

      if (r?.isLadies === true) {
        ladiesTrue += count;
      }

      console.log(
        `OK worker=${workerNo} ${date} ${venue} races=${scheduleCount} saved=${count} grade=${r?.grade || "未分類"} ladies=${r?.isLadies === true}`
      );
    } catch (e) {
      const message =
        `${date} ${venue}: ${
          e?.message || e
        }`;

      errors.push(message);

      console.log(
        `NG worker=${workerNo} ${message}`
      );

      if (!CONTINUE_ON_ERROR) {
        throw e;
      }
    }

    await sleep(250);
  }
}

await Promise.all(
  Array.from(
    {
      length: CONCURRENCY
    },
    (_, i) => worker(i + 1)
  )
);

console.log(
  JSON.stringify(
    {
      startDate,
      days,
      dry: DRY,
      jobs: jobs.length,
      venueDaysWithRaces: ok,
      noRaceVenueDays: noRace,
      savedRows,
      gradeKnownRows: gradeKnown,
      ladiesTrueRows: ladiesTrue,
      errors: errors.length,
      errorSamples: errors.slice(0, 20)
    },
    null,
    2
  )
);

if (errors.length > 0) {
  process.exitCode = 1;
}
