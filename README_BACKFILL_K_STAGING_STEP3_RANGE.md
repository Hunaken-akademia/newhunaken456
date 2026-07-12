# STEP3: K票 複数日 staging バックフィル

## 目的
STEP2Bで1日分のstaging保存が成功したあと、最大14日までの範囲で同じ処理を実行します。

## 安全設計
- 書き込み先は `race_results_staging` と `capture_runs_staging` のみ
- `race_results` には書き込みません
- `paid_users` には触りません
- `CAPTURE_TARGET=staging` が無い場合は安全停止します
- `days` は最大14日に制限しています
- 最初は必ず `dry=true` で実行してください

## 実行手順
Actions → `backfill-k-staging-range`

最初の確認:
- start_date: `2026-07-02`
- days: `7`
- dry: `true`

問題なければ同じ条件で:
- dry: `false`

## 見るログ
- `=== K票 複数日 staging保存 ===`
- 各日の `validation_errors=0`
- 各日の `races_not_6_rows=0`
- 最後の `DB_WRITE=NONE` または `DB_WRITE=STAGING_ONLY`
