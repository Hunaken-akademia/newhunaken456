# F持ち時平均STの正確化：今日以降の保存

## 追加したもの

- `sql/add_pre_race_status_table.sql`
  - `pre_race_status` テーブルを作成
  - `racer_avg_st_by_f_hold(regno, from, to)` RPCを追加
- `api/yoso.js`
  - 自動取得時に、そのレース前のF/L持ち状態を `pre_race_status` に保存
  - `action=prerace` を追加。展示待ちでもF/L持ち状態だけ保存可能
- `.github/workflows/capture-prerace-status.yml`
  - 毎朝JST 8:05に全場全レースのF/L持ち状態保存を実行
  - 手動実行も可能
- `pipeline/capture_prerace_status.mjs`
  - Vercelの `/api/yoso?action=prerace` を叩くスクリプト

## 重要

過去1年分について「当時F持ちだったか」はK票だけでは分からないため復元できません。
この機能は、今日以降の出走前データを保存して、将来の集計に使うためのものです。

## Supabase確認SQL

```sql
select * from public.pre_race_status_daily_counts(14);
```

選手別F持ち時平均ST：

```sql
select *
from public.racer_avg_st_by_f_hold(
  4787,
  current_date - interval '180 days',
  current_date
);
```

## GitHub Actions確認

Actions → `capture-prerace-status` → Run workflow

最初は `dry=false` でOKです。
`pre_race_status` に行が入れば成功です。
