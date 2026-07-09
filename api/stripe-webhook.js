// Vercel Functions用：外部npm依存なしでStripe Webhookを検証
// npm install がVercelで落ちる問題を避けるため、Stripe SDKではなくHMACで署名検証します。
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

// 販売期間・利用期限はJST基準で固定
// 販売開始: 2026/7/13 00:00 JST = 2026-07-12T15:00:00.000Z
// 販売終了: 2026/8/13 23:59 JST = 2026-08-13T14:59:59.999Z
// 利用期限: 2026/12/31 23:59 JST = 2026-12-31T14:59:00.000Z
const SALE_START_MS = Date.parse("2026-07-12T15:00:00.000Z");
const SALE_END_MS = Date.parse("2026-08-13T14:59:59.999Z");
const FIXED_EXPIRES_AT = "2026-12-31T14:59:00.000Z";
const DISPLAY_SALE_START = "2026/7/13 00:00";
const DISPLAY_SALE_END = "2026/8/13 23:59";
const DISPLAY_EXPIRES = "2026/12/31 23:59";

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyStripeSignature(payloadBuffer, signatureHeader, secret) {
  if (!signatureHeader) throw new Error("stripe-signature header がありません。");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET が未設定です。");

  const parts = Object.fromEntries(
    String(signatureHeader).split(",").map((p) => {
      const i = p.indexOf("=");
      return i >= 0 ? [p.slice(0, i), p.slice(i + 1)] : [p, ""];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error("Stripe署名ヘッダーの形式が不正です。");

  const signedPayload = `${timestamp}.${payloadBuffer.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  if (!timingSafeEqual(expected, signature)) throw new Error("Stripe署名検証に失敗しました。");

  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isFinite(ageSec) && ageSec > 300) throw new Error("Stripe署名のタイムスタンプが古すぎます。");
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

function assertCompletedWithinSaleWindow(session) {
  const createdMs = Number(session?.created || 0) * 1000;
  const checkMs = createdMs || Date.now();
  if (checkMs < SALE_START_MS || checkMs > SALE_END_MS) {
    throw new Error(`販売期間外の決済です。販売期間は ${DISPLAY_SALE_START} 〜 ${DISPLAY_SALE_END} です。`);
  }
}

async function insertPaidUserFromCheckout(session) {
  const email = String(
    session?.metadata?.email ||
    session?.customer_details?.email ||
    session?.customer_email ||
    session?.client_reference_id ||
    ""
  ).trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Stripe session から購入者メールを取得できませんでした。");

  assertCompletedWithinSaleWindow(session);

  const existing = await getExistingEntitlement(email);
  if (existing) {
    // StripeのWebhookは同じイベントが複数回届くことがあるため、同じsessionなら正常な再送として無視。
    // 別sessionで既に購入済みの場合も、1人1回ルールのため期限延長や上書きはしない。
    console.log("paid_users already exists. skip insert", {
      email,
      existing_session: existing.stripe_session_id,
      incoming_session: session.id,
    });
    return;
  }

  const payload = {
    email,
    plan: "buyout_2026",
    purchased_at: new Date().toISOString(),
    expires_at: FIXED_EXPIRES_AT,
    note: `stripe:${session.id} / 販売期間:${DISPLAY_SALE_START}-${DISPLAY_SALE_END} / 利用期限:${DISPLAY_EXPIRES}`,
    stripe_session_id: session.id,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
    last_payment_at: new Date().toISOString(),
  };

  await supabaseFetch(`/rest/v1/paid_users`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(true),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const sig = req.headers["stripe-signature"];
    const body = await rawBody(req);
    verifyStripeSignature(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    const event = JSON.parse(body.toString("utf8"));

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        await insertPaidUserFromCheckout(session);
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("stripe-webhook error", e);
    return res.status(400).send(`Webhook Error: ${e?.message || "unknown"}`);
  }
}
