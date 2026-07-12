# STEP3J DISCOVERY SCAN PATCH

目的: K票バックフィルで、エラー日が出てもそこで止めず、最後まで dry=true で洗い出すためのパッチです。

## 追加内容

- 新workflow: `.github/workflows/backfill-k-staging-discovery-scan.yml`
- `pipeline/backfill_k_staging_range.mjs` に `--continue-on-error=true` を追加
- continue-on-error は `dry=true` 専用です。`dry=false` では安全停止します。

## 安全性

- DB_WRITE=NONE
- race_results_staging へも保存しません
- 本番 race_results / paid_users / Stripe / Googleログイン / 認証ゲート / 販売まわりは触りません

## 使い方

GitHub Actions で以下を実行します。

workflow: backfill-k-staging-discovery-scan
start_date: 2026-01-01
days: 30

最後に以下が出ます。

- ok_dates: 問題なく読めた日
- ng_dates: 不足や検証エラーがある日
- range_summary: 全日詳細

ng_dates に出た日だけ個別に直します。
