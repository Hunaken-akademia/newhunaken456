# capture-race-results 自動実行停止パッチ

## 変更内容
- `.github/workflows/capture-race-results.yml` の `schedule` を削除
- 旧HTML解析方式を手動実行専用に変更
- 手動実行の既定値を `yesterday` / `dry=true` に変更
- 毎日の確定結果保存は既存の `.github/workflows/daily-ingest.yml` に一本化

## 理由
`capture-race-results` は当日の未確定・未開催ページも確認するため、`PENDING` が大量発生し、保存0件時にActionが失敗します。
一方、`daily-ingest.yml` は翌朝に前日分のK票を取得し、`race_results` へupsertするため、日次運用はこちらが安定しています。

## 触っていないもの
- `pipeline/capture_race_results.mjs`
- `pipeline/ingest_k.mjs`
- Supabase
- Stripe
- Googleログイン
- paid_users
