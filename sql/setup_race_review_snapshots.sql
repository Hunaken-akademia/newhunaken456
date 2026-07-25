-- 復習用スナップショット。認証・paid_users・Stripeには触れません。
create table if not exists public.race_review_snapshots (
  race_date date not null,
  place_no smallint not null,
  race_no smallint not null,
  venue text not null,
  snapshot jsonb not null default '{}'::jsonb,
  odds jsonb,
  odds_count integer not null default 0,
  is_final boolean not null default false,
  captured_at timestamptz not null default now(),
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (race_date, place_no, race_no),
  constraint race_review_snapshots_place_check check (place_no between 1 and 24),
  constraint race_review_snapshots_race_check check (race_no between 1 and 12),
  constraint race_review_snapshots_snapshot_object check (jsonb_typeof(snapshot) = 'object'),
  constraint race_review_snapshots_odds_object check (odds is null or jsonb_typeof(odds) = 'object')
);

create index if not exists race_review_snapshots_updated_idx
  on public.race_review_snapshots (updated_at desc);

alter table public.race_review_snapshots enable row level security;
revoke all on public.race_review_snapshots from anon, authenticated, service_role;
grant usage on schema public to service_role;
grant select, insert, update on public.race_review_snapshots to service_role;

notify pgrst, 'reload schema';
