-- 展示感応度RPCの型ズレ修正。
-- 以前のSQLが途中で失敗していても、このSQLだけ実行すれば作り直せます。

create table if not exists public.exhibition (
  race_date date not null,
  place_no integer not null,
  race_no integer not null,
  boat integer not null,
  course integer,
  regno integer,
  racer_name text,
  ex_time numeric,
  lap numeric,
  turn numeric,
  straight numeric,
  ex_rank integer,
  total_rank integer,
  ex_diff numeric,
  total_diff numeric,
  source text,
  captured_at timestamptz default now(),
  primary key (race_date, place_no, race_no, boat)
);

alter table public.exhibition enable row level security;

drop policy if exists "allow_read_exhibition" on public.exhibition;
create policy "allow_read_exhibition"
on public.exhibition
for select
to anon, authenticated
using (true);

grant usage on schema public to anon, authenticated;
grant select on public.exhibition to anon, authenticated;
grant select on public.race_results to anon, authenticated;

-- 依存順の都合でbulkから先に削除
DROP FUNCTION IF EXISTS public.racer_exhibition_sensitivity_bulk(integer[], integer);
DROP FUNCTION IF EXISTS public.racer_exhibition_sensitivity(integer, date, date);
DROP FUNCTION IF EXISTS public.racer_exhibition_sensitivity(integer, timestamp without time zone, date);
DROP FUNCTION IF EXISTS public.racer_exhibition_sensitivity(integer, timestamp with time zone, date);
DROP FUNCTION IF EXISTS public.racer_exhibition_sensitivity(integer, timestamp without time zone, timestamp without time zone);
DROP FUNCTION IF EXISTS public.racer_exhibition_sensitivity(integer, timestamp with time zone, timestamp with time zone);

create or replace function public.racer_exhibition_sensitivity(
  p_regno integer,
  p_start_date date,
  p_end_date date
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
      coalesce(e.racer_name, rr.racer_name) as racer_name,
      e.ex_diff,
      e.total_diff,
      rr.rank
    from public.exhibition e
    join public.race_results rr
      on rr.race_date = e.race_date
     and rr.place_no = e.place_no
     and rr.race_no = e.race_no
     and rr.boat = e.boat
    where e.regno = p_regno
      and e.race_date >= p_start_date
      and e.race_date <= p_end_date
      and rr.rank is not null
  ), agg as (
    select
      p_regno::integer as regno,
      max(racer_name) as racer_name,
      count(*)::integer as n,
      round(100.0 * avg((rank = 1)::int), 1) as overall_win_rate,
      round(100.0 * avg((rank <= 2)::int), 1) as overall_top2_rate,
      round(100.0 * avg((rank <= 3)::int), 1) as overall_top3_rate,
      count(*) filter (where ex_diff >= 0)::integer as good_n,
      round(100.0 * avg((rank = 1)::int) filter (where ex_diff >= 0), 1) as good_win_rate,
      round(100.0 * avg((rank <= 2)::int) filter (where ex_diff >= 0), 1) as good_top2_rate,
      round(100.0 * avg((rank <= 3)::int) filter (where ex_diff >= 0), 1) as good_top3_rate,
      count(*) filter (where ex_diff < 0)::integer as bad_n,
      round(100.0 * avg((rank = 1)::int) filter (where ex_diff < 0), 1) as bad_win_rate,
      round(100.0 * avg((rank <= 2)::int) filter (where ex_diff < 0), 1) as bad_top2_rate,
      round(100.0 * avg((rank <= 3)::int) filter (where ex_diff < 0), 1) as bad_top3_rate,
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
  from unnest(coalesce(p_regnos, array[]::integer[])) as r(regno)
  cross join lateral public.racer_exhibition_sensitivity(
    r.regno,
    (current_date - greatest(coalesce(p_days, 180), 1))::date,
    current_date::date
  ) as s;
$$;

grant execute on function public.racer_exhibition_sensitivity(integer, date, date) to anon, authenticated;
grant execute on function public.racer_exhibition_sensitivity_bulk(integer[], integer) to anon, authenticated;

notify pgrst, 'reload schema';
