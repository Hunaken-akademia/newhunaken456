# 女子戦 / SG・G1・G2・G3 区分保存対応

## 追加内容

- public.races に以下の列を追加
  - grade: SG / PG1 / G1 / G2 / G3 / 一般
  - is_ladies: 女子戦判定
  - race_title: 大会名
  - race_type: 予選 / 準優勝戦 / 優勝戦 など
  - metadata_source / metadata_captured_at

## 保存タイミング

- 開催場一覧・締切時刻を取得したときに、raceindexページから大会名・グレード・女子戦判定を保存
- 各レースの自動取得時に、出走6人が全員女性なら is_ladies=true として保存補強

## SQL

Supabase SQL Editorで以下を実行してください。

sql/add_race_category_columns.sql

## 確認SQL

```sql
select
  race_date,
  place_no,
  race_no,
  grade,
  is_ladies,
  race_title,
  race_type,
  metadata_source,
  metadata_captured_at
from public.races
where metadata_captured_at is not null
order by metadata_captured_at desc
limit 30;
```

区分別件数:

```sql
select * from public.race_category_counts(30);
```

G1だけの場別コース基準率:

```sql
select * from public.venue_course_base_filtered(365, 'G1', null) limit 30;
```

女子戦だけの場別コース基準率:

```sql
select * from public.venue_course_base_filtered(365, null, true) limit 30;
```

## 注意

過去1年分のK票には大会名や女子戦判定が十分入っていないため、基本は今日以降の自動取得で正確に貯まります。
過去分も補完したい場合は、raceindexを過去日付で再取得する専用バックフィルが別途必要です。
