# STEP3G L0/F0 数値STなし対応パッチ

## 区分
パッチ版です。STEP3Fの上に上書きしてください。

## 修正内容
- `L0` / `L1` 行で、ST欄が `L .` の場合も選手行として保持
- `F0` / `F1` 行で、ST欄が `F .` の場合も選手行として保持
- 保存値は `st = null`
- `result_status = L` または `F`
- `average_st_eligible = false`
- 通常行でSTが欠ける場合は従来どおり除外

## 安全範囲
- 書き込み先は staging のみ
- 本番 `race_results` は変更しない
- `paid_users` は変更しない
- Stripe、Googleログイン、認証、販売関連は変更しない

## 次の確認
`backfill-k-staging-range` を以下で実行します。

- start_date: `2026-01-08`
- days: `1`
- dry: `true`

期待値:
- candidate_rows=936
- races_not_6_rows=0
- validation_errors=0
- DB_WRITE=NONE
