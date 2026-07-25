create table if not exists public.ai_prediction_snapshots (
  race_date date not null,
  place_no smallint not null,
  race_no smallint not null,
  venue text not null,
  bets jsonb not null default '[]'::jsonb,
  ranked jsonb not null default '[]'::jsonb,
  model_version text,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (race_date, place_no, race_no),
  constraint ai_prediction_snapshots_place_check check (place_no between 1 and 24),
  constraint ai_prediction_snapshots_race_check check (race_no between 1 and 12),
  constraint ai_prediction_snapshots_bets_array check (jsonb_typeof(bets) = 'array'),
  constraint ai_prediction_snapshots_ranked_array check (jsonb_typeof(ranked) = 'array')
);

create index if not exists ai_prediction_snapshots_venue_date_idx
  on public.ai_prediction_snapshots (race_date, place_no, race_no);

alter table public.ai_prediction_snapshots enable row level security;
revoke all on table public.ai_prediction_snapshots from anon, authenticated, service_role;
grant usage on schema public to service_role;
grant select, insert, update on table public.ai_prediction_snapshots to service_role;

notify pgrst, 'reload schema';
