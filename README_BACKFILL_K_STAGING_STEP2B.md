# STEP2B K票1日分staging保存 parser parity修正

## 修正内容
- STEP1Eの診断パーサと同じ特殊着順行対応を、staging保存スクリプトへ反映。
- `S0/S1/転/落/失/妨/不` などの特殊行も1艇分として拾う。
- F/Lは通常平均STから除外候補として `raw_data.average_st_eligible=false` を保存。
- S/失格/転覆/落水等はSTがある場合、平均ST候補に残す。
- 保存先は `race_results_staging` と `capture_runs_staging` のみ。
- 本番 `race_results` / `paid_users` / 認証 / Stripe / note承認には触れない。

## 実行
Actions → `backfill-k-staging-one-day`

まずは必ず dry=true:

```
date: 2026-07-02
dry: true
```

正常条件:

```
validation_errors=0
races_not_6_rows=0
DB_WRITE=NONE
```

その後、同じ日付で dry=false を1回だけ実行して staging に保存。
