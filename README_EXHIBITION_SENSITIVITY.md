# 展示データ保存・展示感応度集計

## 追加内容

自動取得時に、以下を `public.exhibition` へ保存します。

- 展示タイム
- 1周
- 回り足
- 直線
- 展示順位
- 合算順位
- 展示平均との差
- 合算平均との差
- 選手登録番号
- 場 / レース / 艇番 / 進入コース

## Supabaseで先に実行

`sql/add_exhibition_table_and_rpc.sql`

## 保存確認SQL

```sql
select
  race_date,
  place_no,
  race_no,
  boat,
  regno,
  racer_name,
  ex_time,
  lap,
  turn,
  straight,
  ex_rank,
  total_rank,
  ex_diff,
  total_diff,
  captured_at
from public.exhibition
order by captured_at desc
limit 30;
```

## 集計確認SQL

```sql
select *
from public.racer_exhibition_sensitivity(
  4787,
  current_date - interval '180 days',
  current_date
);
```

最初は母数が少ないため参考程度です。3ヶ月ほど貯まると「展示で跳ねる選手」「展示が悪くても関係ない選手」の傾向が見え始めます。
