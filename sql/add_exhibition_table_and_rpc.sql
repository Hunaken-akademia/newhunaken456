-- 展示タイム・周回・回り足・直線の自動保存テーブル
create table if not exists public.exhibition (
  race_date date not null,
  place_no integer not null,
  race_no integer not null,
  boat integer not null check (boat between 1 and 6),
  course integer check (course between 1 and 6),
  regno integer,
  racer_name text,
  ex_time numeric,
  lap numeric,
  turn numeric,
  straight numeric,
  total_time numeric,
  ex_rank integer,
  total_rank integer,
  ex_diff numeric,
  total_diff numeric,
  source text default 'AUTO',
  captured_at timestamptz default now(),
  primary key (race_date, place_no, race_no, boat)
);

create index if not exists idx_exhibition_regno_date on public.exhibition (regno, race_date desc);
create index if not exists idx_exhibition_place_date on public.exhibition (place_no, race_date desc);
create index if not exists idx_exhibition_race_key on public.exhibition (race_date, place_no, race_no);

alter table public.exhibition enable row level security;

drop policy if exists "allow_read_exhibition" on public.exhibition;
create policy "allow_read_exhibition"
on public.exhibition
for select
to anon, authenticated
using (true);

grant usage on schema public to anon, authenticated;
grant select on public.exhibition to anon, authenticated;

-- service_role/APIからのupsert用。service_roleはRLSをバイパスするが、権限も明示しておく。
grant select, insert, update, delete on public.exhibition to service_role;

-- 既に途中まで作成された古いシグネチャがある場合に備えて削除
drop function if exists public.racer_exhibition_sensitivity(integer, timestamp without time zone, date);
drop function if exists public.racer_exhibition_sensitivity(integer, timestamp with time zone, date);
drop function if exists public.racer_exhibition_sensitivity_bulk(integer[], integer);

-- 1選手の展示感応度を集計するRPC
-- ex_diff/total_diff は「平均との差 = 平均 - 自艇値」。プラスほど展示・合算が良い。
create or replace function public.racer_exhibition_sensitivity(
  p_regno integer,
  p_from date default (current_date - 180),
  p_to date default current_date
)
returns table (
  regno integer,
  racer_name text,
  n integer,
  overall_win_rate numeric,
  overall_top2_rate numeric,
  overall_top3_rate numeric,
  good_n integer,
  good_win_rate numeric,
  good_top2_rate numeric,
  good_top3_rate numeric,
  bad_n integer,
  bad_win_rate numeric,
  bad_top2_rate numeric,
  bad_top3_rate numeric,
  ex_buff_top3 numeric,
  ex_bad_drop_top3 numeric,
  avg_ex_diff numeric,
  avg_total_diff numeric
)
language sql
stable
as $$
  with joined as (
    select
      e.regno,
      e.racer_name,
      e.ex_diff,
      e.total_diff,
      rr.rank,
      case when coalesce(e.ex_diff, e.total_diff, 0) >= 0 then true else false end as is_good
    from public.exhibition e
    join public.race_results rr
      on rr.race_date = e.race_date
     and rr.place_no = e.place_no
     and rr.race_no = e.race_no
     and rr.boat = e.boat
    where e.regno = p_regno
      and e.race_date >= p_from
      and e.race_date <= p_to
      and rr.rank is not null
  ), agg as (
    select
      p_regno::integer as regno,
      max(racer_name) as racer_name,
      count(*)::integer as n,
      round(avg(case when rank = 1 then 1 else 0 end) * 100, 1) as overall_win_rate,
      round(avg(case when rank <= 2 then 1 else 0 end) * 100, 1) as overall_top2_rate,
      round(avg(case when rank <= 3 then 1 else 0 end) * 100, 1) as overall_top3_rate,
      count(*) filter (where is_good)::integer as good_n,
      round(avg(case when is_good and rank = 1 then 1 when is_good then 0 end) * 100, 1) as good_win_rate,
      round(avg(case when is_good and rank <= 2 then 1 when is_good then 0 end) * 100, 1) as good_top2_rate,
      round(avg(case when is_good and rank <= 3 then 1 when is_good then 0 end) * 100, 1) as good_top3_rate,
      count(*) filter (where not is_good)::integer as bad_n,
      round(avg(case when not is_good and rank = 1 then 1 when not is_good then 0 end) * 100, 1) as bad_win_rate,
      round(avg(case when not is_good and rank <= 2 then 1 when not is_good then 0 end) * 100, 1) as bad_top2_rate,
      round(avg(case when not is_good and rank <= 3 then 1 when not is_good then 0 end) * 100, 1) as bad_top3_rate,
      round(avg(ex_diff), 3) as avg_ex_diff,
      round(avg(total_diff), 3) as avg_total_diff
    from joined
  )
  select
    regno, racer_name, n,
    overall_win_rate, overall_top2_rate, overall_top3_rate,
    good_n, good_win_rate, good_top2_rate, good_top3_rate,
    bad_n, bad_win_rate, bad_top2_rate, bad_top3_rate,
    round(coalesce(good_top3_rate, overall_top3_rate) - overall_top3_rate, 1) as ex_buff_top3,
    round(overall_top3_rate - coalesce(bad_top3_rate, overall_top3_rate), 1) as ex_bad_drop_top3,
    avg_ex_diff, avg_total_diff
  from agg;
$$;

-- 6艇まとめて取る用RPC。フロント反映用。
create or replace function public.racer_exhibition_sensitivity_bulk(
  p_regnos integer[],
  p_days integer default 180
)
returns table (
  regno integer,
  racer_name text,
  n integer,
  overall_win_rate numeric,
  overall_top2_rate numeric,
  overall_top3_rate numeric,
  good_n integer,
  good_win_rate numeric,
  good_top2_rate numeric,
  good_top3_rate numeric,
  bad_n integer,
  bad_win_rate numeric,
  bad_top2_rate numeric,
  bad_top3_rate numeric,
  ex_buff_top3 numeric,
  ex_bad_drop_top3 numeric,
  avg_ex_diff numeric,
  avg_total_diff numeric
)
language sql
stable
as $$
  select s.*
  from unnest(p_regnos) as r(regno)
  cross join lateral public.racer_exhibition_sensitivity(
    r.regno,
    (current_date - greatest(coalesce(p_days, 180), 1))::date,
    current_date
  ) as s;
$$;

grant execute on function public.racer_exhibition_sensitivity(integer, date, date) to anon, authenticated;
grant execute on function public.racer_exhibition_sensitivity_bulk(integer[], integer) to anon, authenticated;

notify pgrst, 'reload schema';
