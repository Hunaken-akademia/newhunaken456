# STEP3F K票 L0 通常形式対応パッチ

## 修正内容

2026-01-08 浜名湖7Rの `L0` 行は、`K0/K1` と形式が異なります。

- K0/K1: 展示・進入・STが `K .` 形式
- L0/L1: 展示・進入は通常値、STだけが `L .` 形式

STEP3EではL0/L1をK0/K1と同じ特殊分岐に入れていたため、L0行が取得できませんでした。
STEP3Fでは、特殊分岐をK0/K1だけに限定し、L0/L1は既存の通常解析で取得します。

## 期待される扱い

浜名湖7Rの例:

`L0  5 5276 ... 6.96   4   L .`

- boat_no = 5
- course = 4
- st = null
- result_status = L
- average_st_eligible = false

K0/K1の扱いは変更しません。

## 安全性

- `dry=true` ではDB書き込みなし
- `dry=false` の保存先は `race_results_staging` と `capture_runs_staging` のみ
- 本番 `race_results` は変更しない
- `paid_users` は一切触らない
- Stripe、Googleログイン、認証、販売まわりは変更しない

## 次の確認

GitHubへZIPの中身を上書き後、Actionsで以下を実行します。

```text
workflow: backfill-k-staging-range
start_date: 2026-01-08
days: 1
dry: true
```

期待値:

```text
candidate_rows=936
candidate_races=156
races_not_6_rows=0
validation_errors=0
DB_WRITE=NONE
```
