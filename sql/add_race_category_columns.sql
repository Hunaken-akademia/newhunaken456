-- ============================================================
-- レース区分メタデータ（女子戦 / SG・G1・G2・G3 / レース種別）保存
-- 今日以降の自動取得時に public.races へ追記するための土台
-- ============================================================

alter table public.races
  add column if not exists grade text,
  add column if not exists is_ladies boolean,
  add column if not exists race_title text,
  add column if not exists race_type text,
  add column if not exists metadata_source text,
  add column if not exists metadata_captured_at timestamptz;

create index if not exists races_grade_idx
on public.races (grade, race_date);

create index if not exists races_ladies_idx
on public.races (is_ladies, race_date);

create index if not exists races_category_idx
on public.races (race_date, place_no, grade, is_ladies);

grant usage on schema public to anon, authenticated, service_role;
grant select on public.races to anon, authenticated;
grant select, insert, update, delete on public.races to service_role;

-- RLSが有効な環境でもアプリ側から読めるようにする
alter table public.races enable row level security;

drop policy if exists "races_select_all" on public.races;
create policy "races_select_all"
on public.races
for select
to anon, authenticated
using (true);

-- レース区分別の件数確認
create or replace function public.race_category_counts(p_days integer default 365)
returns table (
  grade text,
  is_ladies boolean,
  races bigint,
  rows_count bigint
)
language sql
stable
as $$
  select
    coalesce(r.grade, '未分類') as grade,
    coalesce(r.is_ladies, false) as is_ladies,
    count(distinct (r.race_date, r.place_no, r.race_no)) as races,
    count(rr.*) as rows_count
  from public.races r
  left join public.race_results rr
    on rr.race_date = r.race_date
   and rr.place_no = r.place_no
   and rr.race_no = r.race_no
  where r.race_date >= current_date - make_interval(days => p_days)
  group by coalesce(r.grade, '未分類'), coalesce(r.is_ladies, false)
  order by grade, is_ladies;
$$;

-- 選手別・コース別成績をレース区分で絞り込む
-- p_grade: 'SG' / 'PG1' / 'G1' / 'G2' / 'G3' / '一般' / null
-- p_is_ladies: true=女子戦のみ / false=女子戦除外 / null=絞り込みなし
create or replace function public.racer_course_rates_filtered(
  p_regno integer,
  p_from date,
  p_to date,
  p_grade text default null,
  p_is_ladies boolean default null
)
returns table (
  course smallint,
  n bigint,
  win1_rate numeric,
  ren2_rate numeric,
  ren3_rate numeric
)
language sql
stable
as $$
  select
    rr.course,
    count(*) as n,
    round(100.0 * avg((rr.rank = 1)::int), 1) as win1_rate,
    round(100.0 * avg((rr.rank <= 2)::int), 1) as ren2_rate,
    round(100.0 * avg((rr.rank <= 3)::int), 1) as ren3_rate
  from public.race_results rr
  left join public.races r
    on r.race_date = rr.race_date
   and r.place_no = rr.place_no
   and r.race_no = rr.race_no
  where rr.regno = p_regno
    and rr.race_date between p_from and p_to
    and rr.course is not null
    and rr.rank is not null
    and (p_grade is null or r.grade = p_grade)
    and (p_is_ladies is null or coalesce(r.is_ladies, false) = p_is_ladies)
  group by rr.course
  order by rr.course;
$$;

-- 場×コースの基準率もレース区分で絞り込めるようにする
create or replace function public.venue_course_base_filtered(
  p_days integer default 365,
  p_grade text default null,
  p_is_ladies boolean default null
)
returns table (
  place_no smallint,
  course smallint,
  n bigint,
  win1 numeric,
  ren2 numeric,
  ren3 numeric
)
language sql
stable
as $$
  select
    rr.place_no,
    rr.course,
    count(*) as n,
    round(100.0 * avg((rr.rank = 1)::int), 1) as win1,
    round(100.0 * avg((rr.rank <= 2)::int), 1) as ren2,
    round(100.0 * avg((rr.rank <= 3)::int), 1) as ren3
  from public.race_results rr
  left join public.races r
    on r.race_date = rr.race_date
   and r.place_no = rr.place_no
   and r.race_no = rr.race_no
  where rr.race_date >= current_date - make_interval(days => p_days)
    and rr.course is not null
    and rr.rank is not null
    and (p_grade is null or r.grade = p_grade)
    and (p_is_ladies is null or coalesce(r.is_ladies, false) = p_is_ladies)
  group by rr.place_no, rr.course
  order by rr.place_no, rr.course;
$$;

notify pgrst, 'reload schema';
