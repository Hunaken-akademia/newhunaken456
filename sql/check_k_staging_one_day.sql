-- K票 1日分 staging保存後の確認SQL
-- データの追加・更新・削除は一切行いません。

select
  race_date,
  place_no,
  race_no,
  count(*) as rows_per_race,
  count(*) filter (where st is not null) as rows_with_st,
  count(*) filter (where result_status <> 'NORMAL') as special_status_rows
from public.race_results_staging
where race_date = date '2026-07-02'
group by race_date, place_no, race_no
order by place_no, race_no;

select
  c.run_id,
  c.status,
  c.target_date,
  c.rows_saved,
  c.races_processed,
  c.summary,
  c.started_at,
  c.finished_at
from public.capture_runs_staging c
where c.target_date = date '2026-07-02'
  and c.capture_type = 'results'
order by c.started_at desc
limit 10;
