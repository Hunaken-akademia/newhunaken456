-- ============================================================
-- レース結果の毎日自動保存を有効化するための確認・索引SQL
-- GitHub Actions → /api/yoso?action=result → public.race_results にupsert
-- ============================================================

-- 既存テーブルに不足列がある環境だけ補完します。
alter table public.race_results
  add column if not exists race_date date,
  add column if not exists place_no smallint,
  add column if not exists race_no smallint,
  add column if not exists boat smallint,
  add column if not exists course smallint,
  add column if not exists rank smallint,
  add column if not exists kimarite text,
  add column if not exists regno integer,
  add column if not exists st real,
  add column if not exists is_f boolean not null default false;

-- 同一レース・同一艇を何度取り直しても重複せず、欠損だけ補修できるようにします。
create unique index if not exists race_results_race_boat_unique
on public.race_results (race_date, place_no, race_no, boat);

create index if not exists race_results_regno_date_idx
on public.race_results (regno, race_date);

create index if not exists race_results_race_idx
on public.race_results (race_date, place_no, race_no);

grant usage on schema public to service_role;
grant select, insert, update on public.race_results to service_role;

-- 保存状況確認用。1レース6艇（欠場等は例外）を基準に確認できます。
create or replace function public.race_result_capture_daily_counts(p_days integer default 14)
returns table (
  race_date date,
  races bigint,
  boat_rows bigint,
  st_rows bigint,
  rank_rows bigint,
  f_rows bigint,
  incomplete_races bigint
)
language sql
stable
as $$
  with per_race as (
    select
      rr.race_date,
      rr.place_no,
      rr.race_no,
      count(*) as n,
      count(*) filter (where rr.st is not null) as st_n,
      count(*) filter (where rr.rank is not null) as rank_n,
      count(*) filter (where rr.is_f is true) as f_n
    from public.race_results rr
    where rr.race_date >= current_date - make_interval(days => p_days)
    group by rr.race_date, rr.place_no, rr.race_no
  )
  select
    p.race_date,
    count(*) as races,
    sum(p.n)::bigint as boat_rows,
    sum(p.st_n)::bigint as st_rows,
    sum(p.rank_n)::bigint as rank_rows,
    sum(p.f_n)::bigint as f_rows,
    count(*) filter (where p.n < 5 or p.st_n < least(p.n, 5)) as incomplete_races
  from per_race p
  group by p.race_date
  order by p.race_date desc;
$$;

notify pgrst, 'reload schema';

-- 実行後の確認:
-- select * from public.race_result_capture_daily_counts(14);
