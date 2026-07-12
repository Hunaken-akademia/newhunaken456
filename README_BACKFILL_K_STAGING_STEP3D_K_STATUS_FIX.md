# STEP3D K票 K0/K1 行対応パッチ

## 内容

2026-01-02 の K票で出た `K1` / `K0` 行を、欠け行ではなく `SCRATCHED` 行として拾う修正です。

例:

- 宮島11R: `K1  6 ... K . K . . .`
- 桐生7R: `K0  6 ... K . K . . .`

これにより、該当レースも6艇分として検証できるようになります。

## 安全性

- 保存先は `race_results_staging` のみ
- 本番 `race_results` は変更しない
- `paid_users` は一切触らない
- `dry=true` ではDBに一切書き込まない
- `K0/K1` 行は `result_status='SCRATCHED'`、`st=null`、`course=null`、`average_st_eligible=false` として扱う

## 実行手順

1. ZIPを解凍
2. 中身をGitHubへ上書きアップロード
3. Commit changes
4. Actions → `backfill-k-staging-range`
5. まず保存なしで実行

```
start_date: 2026-01-02
days: 1
dry: true
```

期待値:

```
candidate_rows=1146
races_not_6_rows=0
validation_errors=0
DB_WRITE=NONE
```

通ったら、同じ条件で `dry=false` にして 2026-01-02 だけ staging 保存します。
