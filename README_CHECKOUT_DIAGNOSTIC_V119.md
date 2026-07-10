# Stripe Checkout 診断・エラー表示修正 v119

## 修正内容

- 未購入理由が常に優先され、Stripeエラーが画面に出ないUI不具合を修正
- 購入ボタン押下後に「決済ページを作成中です…」を明示表示
- 決済APIのHTTPステータスと本文を画面に表示
- `window.location.assign()` でCheckout URLへ移動
- `prod_` を価格IDへ誤設定した場合に分かる診断を追加
- Stripe本番/テストモード不一致、価格の有効性、アカウントの charges_enabled を確認できる診断APIを追加

## 診断URL

デプロイ後、Safariで以下を開いてください。

`https://newhunaken456.vercel.app/api/checkout-health`

秘密鍵の全文は表示されません。

## 正常条件

- `ok: true`
- `sale_window_open: true`
- `STRIPE_PRICE_ID_PREFIX_OK: true`
- `price_lookup_ok: true`
- `price.active: true`
- `price.livemode: true`（本番キー利用時）
- `account.charges_enabled: true`
