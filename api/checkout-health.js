function masked(value, head = 8, tail = 4) {
  const s = String(value || "");
  if (!s) return null;
  if (s.length <= head + tail) return `${s.slice(0, Math.min(head, s.length))}…`;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

async function stripeGet(path, secret) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const secret = String(process.env.STRIPE_SECRET_KEY || "");
  const priceId = String(process.env.STRIPE_PRICE_ID_HUNAKEN_2026 || process.env.STRIPE_PRICE_ID || "");
  const appUrl = String(process.env.APP_URL || "");
  const supabaseUrl = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "");
  const serviceKey = String(process.env.SUPABASE_SERVICE_KEY || "");
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "");
  const now = Date.now();
  const saleStart = Date.parse("2026-07-09T15:00:00.000Z");
  const saleEnd = Date.parse("2026-08-13T14:59:59.999Z");

  const result = {
    ok: false,
    checked_at: new Date().toISOString(),
    sale_window_open: now >= saleStart && now <= saleEnd,
    env: {
      STRIPE_SECRET_KEY: !!secret,
      STRIPE_SECRET_KEY_MODE: secret.startsWith("sk_live_") ? "live" : secret.startsWith("sk_test_") ? "test" : secret ? "unknown" : "missing",
      STRIPE_PRICE_ID_HUNAKEN_2026: !!priceId,
      STRIPE_PRICE_ID_PREFIX_OK: priceId.startsWith("price_"),
      STRIPE_PRICE_ID_MASKED: masked(priceId),
      APP_URL: appUrl || null,
      VITE_SUPABASE_URL_OR_SUPABASE_URL: !!supabaseUrl,
      SUPABASE_SERVICE_KEY: !!serviceKey,
      STRIPE_WEBHOOK_SECRET: !!webhookSecret,
    },
    stripe: null,
    hints: [],
  };

  if (!secret) result.hints.push("STRIPE_SECRET_KEY が未設定です。");
  if (!priceId) result.hints.push("STRIPE_PRICE_ID_HUNAKEN_2026 が未設定です。");
  if (priceId && !priceId.startsWith("price_")) result.hints.push("価格IDには prod_ ではなく price_ から始まる値を設定してください。");
  if (!appUrl) result.hints.push("APP_URL が未設定です。");
  if (!supabaseUrl) result.hints.push("VITE_SUPABASE_URL または SUPABASE_URL が未設定です。");
  if (!serviceKey) result.hints.push("SUPABASE_SERVICE_KEY が未設定です。");

  if (secret && priceId && priceId.startsWith("price_")) {
    const [priceRes, accountRes] = await Promise.all([
      stripeGet(`/v1/prices/${encodeURIComponent(priceId)}`, secret),
      stripeGet("/v1/account", secret),
    ]);
    result.stripe = {
      price_lookup_ok: priceRes.ok,
      price_lookup_status: priceRes.status,
      price_error: priceRes.ok ? null : (priceRes.data?.error?.message || priceRes.text.slice(0, 200) || "価格取得失敗"),
      price: priceRes.ok ? {
        id: masked(priceRes.data?.id),
        active: priceRes.data?.active,
        livemode: priceRes.data?.livemode,
        currency: priceRes.data?.currency,
        unit_amount: priceRes.data?.unit_amount,
        type: priceRes.data?.type,
        product: masked(priceRes.data?.product),
      } : null,
      account_lookup_ok: accountRes.ok,
      account_lookup_status: accountRes.status,
      account_error: accountRes.ok ? null : (accountRes.data?.error?.message || accountRes.text.slice(0, 200) || "アカウント取得失敗"),
      account: accountRes.ok ? {
        id: masked(accountRes.data?.id),
        charges_enabled: accountRes.data?.charges_enabled,
        payouts_enabled: accountRes.data?.payouts_enabled,
        details_submitted: accountRes.data?.details_submitted,
      } : null,
    };

    const keyIsLive = secret.startsWith("sk_live_");
    if (priceRes.ok && typeof priceRes.data?.livemode === "boolean" && priceRes.data.livemode !== keyIsLive) {
      result.hints.push("シークレットキーと価格IDのモード（本番/テスト）が一致していません。");
    }
    if (!priceRes.ok) result.hints.push("価格IDをStripeから取得できません。同じStripeアカウント・同じ本番/テストモードの price_ IDか確認してください。");
    if (priceRes.ok && priceRes.data?.active === false) result.hints.push("Stripeの価格が非アクティブです。");
    if (accountRes.ok && accountRes.data?.charges_enabled !== true) result.hints.push("Stripeアカウントがまだ本番決済を受け付けられる状態ではありません（charges_enabled=false）。");
  }

  result.ok = result.hints.length === 0;
  return res.status(result.ok ? 200 : 503).json(result);
}
