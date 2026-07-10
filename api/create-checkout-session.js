// Vercel Functions用：外部npm依存なしでStripe Checkout Sessionを作成
// npm install がVercelで落ちる問題を避けるため、Stripe SDKではなくStripe REST APIを直接使用します。

// 販売期間・利用期限はJST基準で固定
// 販売開始: 2026/7/10 00:00 JST = 2026-07-09T15:00:00.000Z
// 販売終了: 2026/8/13 23:59 JST = 2026-08-13T14:59:59.999Z
// 利用期限: 2026/12/31 23:59 JST = 2026-12-31T14:59:00.000Z
const SALE_START_MS = Date.parse("2026-07-09T15:00:00.000Z");
const SALE_END_MS = Date.parse("2026-08-13T14:59:59.999Z");
const FIXED_EXPIRES_AT = "2026-12-31T14:59:00.000Z";
const DISPLAY_SALE_START = "2026/7/10 00:00";
const DISPLAY_SALE_END = "2026/8/13 23:59";
const DISPLAY_EXPIRES = "2026/12/31 23:59";

function getOrigin(req) {
  const configured = String(process.env.APP_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const origin = req.headers.origin || "";
  if (origin) return origin.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
  }
  return {};
}

function assertSaleWindow() {
  const now = Date.now();
  if (now < SALE_START_MS) {
    const err = new Error(`販売開始前です。販売開始は ${DISPLAY_SALE_START} です。`);
    err.statusCode = 403;
    throw err;
  }
  if (now > SALE_END_MS) {
    const err = new Error(`販売期間は終了しました。販売期間は ${DISPLAY_SALE_START} 〜 ${DISPLAY_SALE_END} です。`);
    err.statusCode = 403;
    throw err;
  }
}

function supabaseHeaders(json = false) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const h = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function supabaseFetch(path, opts = {}) {
  const base = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("VITE_SUPABASE_URL または SUPABASE_URL が未設定です。");
  if (!process.env.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY が未設定です。");
  const res = await fetch(`${base}${path}`, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase error ${res.status}: ${txt.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return await res.json().catch(() => null);
}

async function getExistingEntitlement(email) {
  const qs = new URLSearchParams();
  qs.set("select", "email,expires_at,stripe_session_id,purchased_at");
  qs.set("email", `eq.${email}`);
  qs.set("limit", "1");
  const rows = await supabaseFetch(`/rest/v1/paid_users?${qs.toString()}`, {
    headers: supabaseHeaders(false),
  });
  return Array.isArray(rows) ? rows[0] : null;
}

function appendCheckoutParams(params, obj, prefix = "") {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, idx) => appendCheckoutParams(params, item, `${name}[${idx}]`));
    } else if (typeof value === "object") {
      appendCheckoutParams(params, value, name);
    } else {
      params.append(name, String(value));
    }
  }
}

async function createStripeCheckoutSession(payload) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY が未設定です。");

  const params = new URLSearchParams();
  appendCheckoutParams(params, payload);

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await stripeRes.json().catch(() => null);
  if (!stripeRes.ok) {
    const message = data?.error?.message || `Stripe error ${stripeRes.status}`;
    throw new Error(message);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  try {
    const priceId = process.env.STRIPE_PRICE_ID_HUNAKEN_2026 || process.env.STRIPE_PRICE_ID;
    if (!priceId) throw new Error("STRIPE_PRICE_ID_HUNAKEN_2026 が未設定です。");

    assertSaleWindow();

    const body = readJsonBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const sessionId = String(body.session_id || body.sessionId || "").trim();
    if (!email || !email.includes("@")) throw new Error("購入者メールを確認できませんでした。Googleログイン後に購入してください。");

    const existing = await getExistingEntitlement(email);
    if (existing) {
      return res.status(409).json({
        error: `このGoogleメールはすでに購入済みです。購入は1人1回までです。利用期限は ${DISPLAY_EXPIRES} までです。`,
      });
    }

    const origin = getOrigin(req);
    if (!origin) throw new Error("APP_URL またはリクエストURLを確認できませんでした。");

    const session = await createStripeCheckoutSession({
      mode: "payment",
      customer_email: email,
      client_reference_id: email,
      "line_items": [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`,
      metadata: {
        email,
        session_id: sessionId,
        plan: "2026",
        product: "hunaken_paid_auto",
        sale_start_jst: DISPLAY_SALE_START,
        sale_end_jst: DISPLAY_SALE_END,
        access_expires_at: FIXED_EXPIRES_AT,
        access_expires_jst: DISPLAY_EXPIRES,
        one_purchase_per_email: "true",
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error", e);
    return res.status(e?.statusCode || 500).json({ error: e?.message || "決済ページ作成に失敗しました。" });
  }
}
