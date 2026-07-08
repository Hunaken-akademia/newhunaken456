-- ============================================================
-- レース前F/L持ち状態スナップショット保存テーブル
-- 今日以降の「F持ち時平均ST」を正確に集計するための土台
-- ============================================================

create table if not exists public.pre_race_status (
  race_date date not null,
  place_no smallint not null,
  race_no smallint not null,
  boat smallint not null,
  regno integer,
  racer_name text,
  f_count smallint not null default 0,
  l_count smallint not null default 0,
  f_hold boolean not null default false,
  l_hold boolean not null default false,
  pre_avg_st real,
  source text,
  captured_at timestamptz not null default now(),
  primary key (race_date, place_no, race_no, boat)
);

create index if not exists pre_race_status_regno_date_idx
on public.pre_race_status (regno, race_date);

create index if not exists pre_race_status_race_idx
on public.pre_race_status (race_date, place_no, race_no);

alter table public.pre_race_status enable row level security;

grant usage on schema public to anon, authenticated, service_role;
grant select on public.pre_race_status to anon, authenticated;
grant select, insert, update, delete on public.pre_race_status to service_role;

drop policy if exists "pre_race_status_select_all" on public.pre_race_status;
create policy "pre_race_status_select_all"
on public.pre_race_status
for select
to anon, authenticated
using (true);

-- 選手別：F持ち状態ごとの平均ST
-- ※ST平均はFを切った負値を除外。Fを切った回数は f_cut_count で別表示。
create or replace function public.racer_avg_st_by_f_hold(
  p_regno integer,
  p_from date,
  p_to date
)
returns table (
  f_count smallint,
  f_hold boolean,
  n bigint,
  avg_st numeric,
  f_cut_count bigint
)
language sql
stable
as $$
  select
    prs.f_count,
    prs.f_hold,
    count(*) filter (where rr.st is not null and rr.st >= 0) as n,
    round(avg(rr.st) filter (where rr.st is not null and rr.st >= 0)::numeric, 3) as avg_st,
    count(*) filter (where rr.is_f = true) as f_cut_count
  from public.pre_race_status prs
  join public.race_results rr
    on rr.race_date = prs.race_date
   and rr.place_no = prs.place_no
   and rr.race_no = prs.race_no
   and rr.boat = prs.boat
   and rr.regno = prs.regno
  where prs.regno = p_regno
    and prs.race_date between p_from and p_to
  group by prs.f_count, prs.f_hold
  order by prs.f_count;
$$;

-- 画面・検証用：直近日付の保存状況
create or replace function public.pre_race_status_daily_counts(p_days integer default 14)
returns table (
  race_date date,
  races bigint,
  rows_count bigint,
  f_hold_rows bigint
)
language sql
stable
as $$
  select
    race_date,
    count(distinct (place_no, race_no)) as races,
    count(*) as rows_count,
    count(*) filter (where f_hold = true) as f_hold_rows
  from public.pre_race_status
  where race_date >= current_date - make_interval(days => p_days)
  group by race_date
  order by race_date desc;
$$;

notify pgrst, 'reload schema';
