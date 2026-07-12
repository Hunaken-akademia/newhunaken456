# 過去1年バックフィル STEP1B：K票ST抽出修正

## 目的
STEP1の診断で、K票の結果行に `0.23` のようなSTが存在するにもかかわらず、旧パーサが `.23` 形式だけを探していたため、`rows_without_st=857` になりました。

このSTEP1BではDBへ一切書き込まず、ST抽出と候補行判定だけを修正します。

## 変更ファイル

- `pipeline/backfill/inspect_k_file.mjs`
- `.github/workflows/inspect-k-file-backfill.yml`

## 安全性

- 本番 `race_results` へ書き込みません
- stagingへも書き込みません
- `paid_users`、note申請、購入者情報には触れません
- K票ファイルを読み、ログへ診断結果を出すだけです

## 実行

Actions → `inspect-k-file-backfill` → Run workflow

初回は以下で実行：

- date: `2026-07-02`
- show_raw: `false`

ログの以下を確認してください。

- `candidate_rows`
- `candidate_races`
- `rows_without_st`
- `invalid_course_rows`
- `races_with_6_rows`
- `races_not_6_rows`

期待値は、`rows_without_st=0` です。
