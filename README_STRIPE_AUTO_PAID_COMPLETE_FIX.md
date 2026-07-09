# Stripe購入者自動追加 完全版

## 追加内容

- `/api/create-checkout-session.js` を追加
  - Googleログイン済みメールでStripe Checkoutを作成
  - `allow_promotion_codes: true` により古参クーポン入力に対応
- `/api/stripe-webhook.js` を追加
  - `checkout.session.completed` かつ `payment_status=paid` の時だけ処理
  - `paid_users` に購入者メールを自動upsert
  - 既に有効期限が残っている場合は、残り期限の後ろに6ヶ月延長
- 未購入画面に「購入して利用開始」ボタンを追加
- `sql/setup_paid_users_and_rls.sql` をStripeカラム対応版に更新
- `package.json` に `stripe` を追加

## 必要なVercel環境変数

フロント:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

サーバーのみ:
- `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_HUNAKEN_2026`
- `APP_URL=https://newhunaken456.vercel.app`

## Stripe Webhook URL

`https://newhunaken456.vercel.app/api/stripe-webhook`

イベントは `checkout.session.completed` のみでOK。

## 流れ

1. ユーザーがGoogleログイン
2. `paid_users` に無ければ購入者専用画面
3. 「購入して利用開始」を押す
4. Stripe Checkoutで決済
5. Stripe Webhookが `paid_users` に自動追加
6. アプリへ戻って「再確認」を押すと利用可能

## 注意

Webhookが設定されていないと、決済は成功しても `paid_users` に自動追加されません。
必ずStripe側でWebhook URLと署名シークレットを設定してください。
