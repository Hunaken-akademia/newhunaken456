-- DB選手成績・逃げシミュ・決まり手・平均STをフロントから読めるようにする安全SQL
-- データは削除しません。SELECT権限とRLSの読み取りポリシーだけ追加します。

grant usage on schema public to anon, authenticated;
grant select on public.race_results to anon, authenticated;
grant select on public.races to anon, authenticated;
grant select on public.pre_race_status to anon, authenticated;

alter table public.race_results enable row level security;
alter table public.races enable row level security;
alter table public.pre_race_status enable row level security;

do $$ begin
  create policy "allow_read_race_results_for_app"
  on public.race_results
  for select
  to anon, authenticated
  using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "allow_read_races_for_app"
  on public.races
  for select
  to anon, authenticated
  using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "allow_read_pre_race_status_for_app"
  on public.pre_race_status
  for select
  to anon, authenticated
  using (true);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
