# STEP3M RANK00 OTHER FIX PATCH

## 種別
パッチ版です。STEP3Lを前提に、K票の `00` 着順行だけを安全に補正します。

## 修正内容
- `official_rank_text = 00` の行を `NORMAL` にしない
- `result_status = OTHER` として保持
- `finish_order = null` のまま保持
- ST・進入がある場合は保持

## 理由
Supabase の `race_results_staging_normal_rank_consistency` 制約では、`NORMAL` 行は通常着順 `01〜06` と整合している必要があります。
`00` は通常着順ではないため、`NORMAL` にすると保存時に安全停止します。

## 安全性
- `race_results_staging` / `capture_runs_staging` の staging 保存処理のみ
- 本番 `race_results` は触りません
- `paid_users` は触りません
- Stripe、Googleログイン、販売・認証まわりは触りません
