# 過去1年バックフィル STEP1E：特殊着順行の確認

## 目的

STEP1Dで残った `races_not_6_rows=5` の原因は、通常の `01〜06` 着順ではなく、`S1`、`S0`、`L0` などの特殊着順行が1艇分として読めていなかったことでした。

このSTEPでは、以下をDB書き込みなしで確認します。

- `S0/S1` などの失格系行を1艇分として採用できるか
- `L0` や `L1.99` などのL行を1艇分として採用できるか
- 6艇揃いレース数が156/156に近づくか
- F/Lは平均STから除外候補として判定できるか

## 安全設計

- DB_WRITE=NONE
- 本番 `race_results` へ書き込みません
- stagingへも書き込みません
- `paid_users` / 認証 / 決済 / 利用者データへ触れません

## 実行

GitHub Actions → `inspect-k-file-backfill` → `Run workflow`

- date: `2026-07-02`
- show_raw: `false`

## 見るログ

```text
=== K票バックフィル事前診断 v5 ===
candidate_rows_raw=
duplicate_rows_dropped=
candidate_rows=
candidate_races=
candidate_venues=
rows_without_st=
rows_without_race_time=
special_status_rows=
average_st_excluded_rows=
invalid_course_rows=
races_with_6_rows=
races_not_6_rows=
DB_WRITE=NONE
```

理想値は、`races_with_6_rows=156`、`races_not_6_rows=0` です。

## 注意

F/L行はレース結果としては保存候補ですが、平均STの計算からは除外候補です。S/失格系はスタートタイミングが正常にある場合、平均ST候補に残します。
