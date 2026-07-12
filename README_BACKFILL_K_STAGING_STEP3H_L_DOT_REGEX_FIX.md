# STEP3H L. 正規表現修正パッチ

## 修正内容
- `L0` / `L1` 行のST欄 `L .` を選手行として取得
- `F0` / `F1` 行のST欄 `F .` も同様に取得
- `st = null`
- `result_status = L` または `F`
- `average_st_eligible = false`

## 対象
- `pipeline/backfill_k_staging_one_day.mjs`
- staging専用バックフィルのみ

## 触らないもの
- 本番 `race_results`
- `paid_users`
- Stripe
- Googleログイン
- 認証・販売機能

## 再確認
`start_date=2026-01-08`, `days=1`, `dry=true`
