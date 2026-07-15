-- ============================================================
-- race_results_staging → race_results 安全復旧SQL（v127）
--
-- 方針:
--   ・DELETE / TRUNCATE は一切使いません
--   ・Phase1: 既存行の補修は UPDATE のみ（rank IS NULL の応急NULL行に限定）
--   ・Phase2: 不足行の追加は MERGE の WHEN NOT MATCHED（INSERTのみ）
--   ・既に値が入っている正常行には一切触れません
--   ・paid_users / Stripe / 認証関連テーブルには一切触れません
--
-- 実行前の必須事項:
--   1. sql/check_k_staging_quality.sql を実行し、全チェック0行を確認
--   2. 復旧作業中は daily-ingest / capture-race-results ワークフローを
--      一時停止するか、反映対象を「両クロンが触らない過去日」に限定する
--   3. 月単位など小さい範囲で実行 → アプリ表示確認 → 次の範囲、と漸進する
--
-- 使い方:
--   各STEPの race_date between の範囲を書き換えて、STEP順に1つずつ実行。
--   STEP 2/3 はトランザクション内で実行し、影響行数を確認してからCOMMIT。
-- ============================================================


-- ------------------------------------------------------------
-- STEP 0. バックアップ（読み取りのみで作成。既存テーブルは不変）
--   ※1回だけ実行。既に存在する場合はエラーになるので日付を変える。
-- ------------------------------------------------------------
create table if not exists public.race_results_backup_20260716 as
select * from public.race_results;

-- バックアップ件数確認
select
  (select count(*) from public.race_results) as prod_rows,
  (select count(*) from public.race_results_backup_20260716) as backup_rows;


-- ------------------------------------------------------------
-- STEP 1. 事前照合（反映予定の影響を数字で確定させる）
-- ------------------------------------------------------------

-- 1-a. Phase1(UPDATE)の対象行数: 本番の応急NULL行のうちstagingで補修できる数
select count(*) as phase1_update_targets
from public.race_results rr
join public.race_results_staging s
  on  s.race_date = rr.race_date
  and s.place_no  = rr.place_no
  and s.race_no   = rr.race_no
  and s.boat_no   = rr.boat
where rr.race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  and rr.rank is null;

-- 1-b. Phase2(MERGE INSERT)の対象行数: 本番に存在しないstaging行の数
select count(*) as phase2_insert_targets
from public.race_results_staging s
where s.race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  and not exists (
    select 1 from public.race_results rr
    where rr.race_date = s.race_date
      and rr.place_no  = s.place_no
      and rr.race_no   = s.race_no
      and rr.boat      = s.boat_no
  );

-- 1-c. 触らない行（既に値が入っている正常行）の数 ※参考
select count(*) as untouched_rows
from public.race_results rr
where rr.race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  and rr.rank is not null;


-- ------------------------------------------------------------
-- STEP 2. Phase1: 応急NULL行の補修（UPDATEのみ）
--   ガード:
--     ・rr.rank IS NULL の行だけを更新（正常行は不変）
--     ・キー4項目完全一致の行だけを更新
--   トランザクションで囲み、影響行数がSTEP 1-aと一致するのを確認してCOMMIT。
-- ------------------------------------------------------------
begin;

update public.race_results rr
set
  rank       = s.finish_order,
  course     = s.course,
  st         = case
                 when coalesce(s.is_f, false) and s.st is not null then -abs(s.st)
                 else s.st
               end,
  is_f       = coalesce(s.is_f, false),
  kimarite   = coalesce(rr.kimarite, s.kimarite),
  regno      = coalesce(rr.regno, s.regno),
  racer_name = coalesce(rr.racer_name, s.racer_name)
from public.race_results_staging s
where s.race_date = rr.race_date
  and s.place_no  = rr.place_no
  and s.race_no   = rr.race_no
  and s.boat_no   = rr.boat
  and rr.race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  and rr.rank is null;

-- ↑実行結果の「UPDATE n」が STEP 1-a の phase1_update_targets と一致することを確認。
-- 一致しない場合は COMMIT せずに ROLLBACK; して原因を調べる。

commit;
-- rollback;  -- ←一致しない場合はこちら


-- ------------------------------------------------------------
-- STEP 3. Phase2: 本番に存在しない行の追加（MERGE / INSERTのみ）
--   WHEN MATCHED句を書かないため、既存行は一切変更されません。
--   影響行数がSTEP 1-bと一致するのを確認してCOMMIT。
-- ------------------------------------------------------------
begin;

merge into public.race_results rr
using (
  select *
  from public.race_results_staging
  where race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
) s
on  rr.race_date = s.race_date
and rr.place_no  = s.place_no
and rr.race_no   = s.race_no
and rr.boat      = s.boat_no
when not matched then
  insert (race_date, place_no, race_no, boat, course, rank, regno, st, is_f, kimarite, racer_name)
  values (s.race_date, s.place_no, s.race_no, s.boat_no, s.course, s.finish_order,
          s.regno,
          case
            when coalesce(s.is_f, false) and s.st is not null then -abs(s.st)
            else s.st
          end,
          coalesce(s.is_f, false), s.kimarite, s.racer_name);

-- ↑「MERGE n」が STEP 1-b の phase2_insert_targets と一致することを確認。

commit;
-- rollback;


-- ------------------------------------------------------------
-- STEP 4. 事後照合
-- ------------------------------------------------------------

-- 4-a. 反映範囲でrank NULLが残っていないか（0行が理想。残る場合は
--      staging側にも無い行 = 別途原因調査対象）
select rr.race_date, rr.place_no, rr.race_no, rr.boat
from public.race_results rr
where rr.race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  and rr.rank is null
order by rr.race_date, rr.place_no, rr.race_no, rr.boat;

-- 4-b. 反映範囲の日別サマリ（stagingと本番が一致しているか）
with s as (
  select race_date, count(*) as staging_rows
  from public.race_results_staging
  where race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  group by race_date
),
p as (
  select race_date, count(*) as prod_rows,
         count(*) filter (where rank is null) as prod_rank_null
  from public.race_results
  where race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
  group by race_date
)
select coalesce(s.race_date, p.race_date) as race_date,
       s.staging_rows, p.prod_rows, p.prod_rank_null
from s full outer join p on p.race_date = s.race_date
order by 1;

-- 4-c. レース毎6艇の確認（0行が正常）
select race_date, place_no, race_no, count(*) as n
from public.race_results
where race_date between date '2026-01-01' and date '2026-01-31'  -- ★範囲を書き換え
group by race_date, place_no, race_no
having count(*) <> 6
order by race_date, place_no, race_no;

-- ============================================================
-- 補足:
-- ・特殊着（F/L/欠場/失格等）は finish_order = NULL のため、
--   本番でも rank = NULL のまま保持されます。アプリ側は
--   「r.rank != null」でフィルタしているため表示計算に影響しません。
-- ・staging に result_status / official_rank_text を本番へも持たせたい
--   場合は、以下の列追加（非破壊）を先に実行してから
--   Phase1/Phase2 のセット句に追加してください:
--     alter table public.race_results
--       add column if not exists result_status text,
--       add column if not exists official_rank_text text;
-- ============================================================
