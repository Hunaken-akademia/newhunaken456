# K票バックフィル STEP2：1日分だけ staging 保存

## 目的
2026-07-02 のK票を、まず `race_results_staging` と `capture_runs_staging` にだけ保存して検証します。
本番 `race_results`、`paid_users`、Stripe、認証関連には触れません。

## 追加ファイル
- `.github/workflows/backfill-k-staging-one-day.yml`
- `pipeline/backfill_k_staging_one_day.mjs`
- `sql/check_k_staging_one_day.sql`

## 安全設計
- GitHub Actionsの手動実行のみ
- `dry=true` が初期値。この場合DBへ一切書き込みません
- `dry=false` の場合も保存先は staging のみ
- `CAPTURE_TARGET=staging` がないと強制停止
- 6艇揃わないレースや不正値があれば保存前に停止
- `race_results_staging` は複合主キーでupsertし、同じ日付を再実行しても重複しません

## 実行手順
1. ZIPの中身をGitHubにアップロードしてCommit
2. Actions → `backfill-k-staging-one-day`
3. まず以下で実行
   - date: `2026-07-02`
   - dry: `true`
4. ログが正常なら、同じ日付で `dry=false` を1回だけ実行
5. Supabase SQL Editorで `sql/check_k_staging_one_day.sql` を実行して確認

## 期待値
2026-07-02 の診断結果では、156レース・936艇が候補です。
`dry=false` で `rows_saved=936` になれば成功です。
