-- WAKE: 選手の「まくり / まくり差し / 差し」被害時の残し方を分離集計する。
-- 破壊的変更なし。関数追加・置換のみ。

create or replace function public.racer_resistance_split(
  p_regno integer,
  p_from date,
  p_to date
)
returns table (
  makuri_n bigint,
  makuri_avg_rank numeric,
  makuri_hold3 numeric,
  makurizashi_n bigint,
  makurizashi_avg_rank numeric,
  makurizashi_hold3 numeric,
  sashi_n bigint,
  sashi_avg_rank numeric,
  sashi_hold3 numeric,
  attack_n bigint,
  attack_win numeric
)
language sql
stable
security invoker
as $$
  with winners as (
    select
      race_date,
      place_no,
      race_no,
      course as win_course,
      trim(kimarite) as kimarite
    from public.race_results
    where rank = 1
      and kimarite is not null
      and course is not null
      and race_date between p_from and p_to
  ),
  base as (
    select
      r.rank as my_rank,
      r.course as my_course,
      w.win_course,
      w.kimarite,
      (r.rank > 1 and w.win_course > r.course) as is_victim
    from public.race_results r
    join winners w
      on r.race_date = w.race_date
     and r.place_no = w.place_no
     and r.race_no = w.race_no
    where r.regno = p_regno
      and r.course is not null
      and r.rank is not null
      and r.race_date between p_from and p_to
  )
  select
    count(*) filter (
      where is_victim and kimarite = 'まくり'
    ) as makuri_n,

    round(
      (avg(my_rank) filter (
        where is_victim and kimarite = 'まくり'
      ))::numeric,
      2
    ) as makuri_avg_rank,

    round(
      (
        100.0 * avg((my_rank <= 3)::int) filter (
          where is_victim and kimarite = 'まくり'
        )
      )::numeric,
      1
    ) as makuri_hold3,

    count(*) filter (
      where is_victim and kimarite = 'まくり差し'
    ) as makurizashi_n,

    round(
      (avg(my_rank) filter (
        where is_victim and kimarite = 'まくり差し'
      ))::numeric,
      2
    ) as makurizashi_avg_rank,

    round(
      (
        100.0 * avg((my_rank <= 3)::int) filter (
          where is_victim and kimarite = 'まくり差し'
        )
      )::numeric,
      1
    ) as makurizashi_hold3,

    count(*) filter (
      where is_victim and kimarite = '差し'
    ) as sashi_n,

    round(
      (avg(my_rank) filter (
        where is_victim and kimarite = '差し'
      ))::numeric,
      2
    ) as sashi_avg_rank,

    round(
      (
        100.0 * avg((my_rank <= 3)::int) filter (
          where is_victim and kimarite = '差し'
        )
      )::numeric,
      1
    ) as sashi_hold3,

    count(*) filter (
      where my_course >= 3
    ) as attack_n,

    round(
      (
        100.0 * avg(
          (my_rank = 1 and kimarite in ('まくり', 'まくり差し', '差し'))::int
        ) filter (
          where my_course >= 3
        )
      )::numeric,
      1
    ) as attack_win
  from base;
$$;

create or replace function public.resistance_baseline_split(
  p_from date,
  p_to date
)
returns table (
  makuri_avg_rank numeric,
  makuri_hold3 numeric,
  makurizashi_avg_rank numeric,
  makurizashi_hold3 numeric,
  sashi_avg_rank numeric,
  sashi_hold3 numeric
)
language sql
stable
security invoker
as $$
  with winners as (
    select
      race_date,
      place_no,
      race_no,
      course as win_course,
      trim(kimarite) as kimarite
    from public.race_results
    where rank = 1
      and kimarite is not null
      and course is not null
      and race_date between p_from and p_to
  ),
  base as (
    select
      r.rank as my_rank,
      w.kimarite
    from public.race_results r
    join winners w
      on r.race_date = w.race_date
     and r.place_no = w.place_no
     and r.race_no = w.race_no
    where r.course is not null
      and r.rank is not null
      and r.rank > 1
      and w.win_course > r.course
      and r.race_date between p_from and p_to
  )
  select
    round(
      (avg(my_rank) filter (
        where kimarite = 'まくり'
      ))::numeric,
      2
    ) as makuri_avg_rank,

    round(
      (
        100.0 * avg((my_rank <= 3)::int) filter (
          where kimarite = 'まくり'
        )
      )::numeric,
      1
    ) as makuri_hold3,

    round(
      (avg(my_rank) filter (
        where kimarite = 'まくり差し'
      ))::numeric,
      2
    ) as makurizashi_avg_rank,

    round(
      (
        100.0 * avg((my_rank <= 3)::int) filter (
          where kimarite = 'まくり差し'
        )
      )::numeric,
      1
    ) as makurizashi_hold3,

    round(
      (avg(my_rank) filter (
        where kimarite = '差し'
      ))::numeric,
      2
    ) as sashi_avg_rank,

    round(
      (
        100.0 * avg((my_rank <= 3)::int) filter (
          where kimarite = '差し'
        )
      )::numeric,
      1
    ) as sashi_hold3
  from base;
$$;

grant execute on function public.racer_resistance_split(integer, date, date) to anon, authenticated;
grant execute on function public.resistance_baseline_split(date, date) to anon, authenticated;
