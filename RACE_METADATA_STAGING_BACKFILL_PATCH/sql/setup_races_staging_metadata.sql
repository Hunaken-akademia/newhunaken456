-- 過去開催メタデータの安全な一時保存先。
-- 本番 public.races は変更しない。

create table if not exists public.races_staging (
  race_date date not null,
  place_no smallint not null,
  race_no smallint not null
);

alter table public.races_staging
  add column if not exists grade text,
  add column if not exists is_ladies boolean,
  add column if not exists race_title text,
  add column if not exists race_type text,
  add column if not exists grade_source_text text,
  add column if not exists ladies_source_text text,
  add column if not exists metadata_source text,
  add column if not exists metadata_captured_at timestamptz,
  add column if not exists source_url text,
  add column if not exists validation_status text default 'pending',
  add column if not exists validation_errors jsonb default '[]'::jsonb;

create unique index if not exists races_staging_race_key
  on public.races_staging (race_date, place_no, race_no);

create index if not exists races_staging_date_idx
  on public.races_staging (race_date);

create index if not exists races_staging_category_idx
  on public.races_staging (grade, is_ladies, race_date);

-- service_roleだけが書き込み、一般利用者には公開しない。
grant usage on schema public to service_role;
grant select, insert, update on public.races_staging to service_role;
revoke all on public.races_staging from anon, authenticated;

alter table public.races_staging enable row level security;

notify pgrst, 'reload schema';
