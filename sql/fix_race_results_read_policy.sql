-- アプリ（anon）からDB選手成績・逃げシミュレーション用に race_results を読めるようにする
-- データ削除はしません。

grant usage on schema public to anon, authenticated;
grant select on public.race_results to anon, authenticated;

alter table public.race_results enable row level security;

drop policy if exists "race_results_select_all_for_app" on public.race_results;

create policy "race_results_select_all_for_app"
on public.race_results
for select
to anon, authenticated
using (true);

notify pgrst, 'reload schema';
