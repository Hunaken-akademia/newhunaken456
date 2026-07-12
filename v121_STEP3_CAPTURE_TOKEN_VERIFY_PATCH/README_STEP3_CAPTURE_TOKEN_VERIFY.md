# STEP3 CAPTURE_TOKEN 検証追加

## 目的

`pipeline/capture_race_results.mjs` が送信している `x-capture-token` を、
`api/yoso.js` の結果取り込みアクション（`action=result`）で照合します。

## 変更ファイル

- `api/yoso.js`
- `README_STEP3_CAPTURE_TOKEN_VERIFY.md`

## 動作

- Vercel の `CAPTURE_TOKEN` が設定済み
  - 正しい `x-capture-token` がある場合だけ結果取り込みを実行
  - 不一致・未送信は HTTP 401
- Vercel の `CAPTURE_TOKEN` が未設定
  - 従来動作を維持（段階導入用）

## 影響しない処理

- `action=schedule`
- `action=schedules`
- `action=prerace`
- `action=odds`
- 通常の予想画面
- Googleログイン / note承認 / Stripe
- `paid_users`
- クラウド保存
- 評価ロジック
- DBスキーマ

## 設定手順

同じランダム文字列を次の2か所へ登録します。

1. GitHub Repository Settings → Secrets and variables → Actions → `CAPTURE_TOKEN`
2. Vercel Project Settings → Environment Variables → `CAPTURE_TOKEN`

Vercel は Production を必須にし、必要に応じて Preview にも登録します。
環境変数を保存後、Vercel を再デプロイしてください。

## 確認

GitHub Actions の `capture-race-results.yml` を手動実行し、結果が保存されれば成功です。

不正アクセス確認例（トークンを付けずに結果APIへアクセス）:

`/api/yoso?action=result&venue=平和島&race=1&date=2026-07-12`

Vercel に `CAPTURE_TOKEN` が設定されていれば HTTP 401 になります。

## ロールバック

`api/yoso.js` を直前版へ戻してください。SQL変更はないためDB操作は不要です。
