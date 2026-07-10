-- ============================================================
-- 舟券アカデミア：既存レースのグレード＋女子戦を即時バックフィル
-- 対象: public.races / public.race_results
-- 目的:
--   1) SG・G1・G2・G3・一般を大会名から正規化
--   2) 女子戦を名称だけでなく「6艇全員が女子選手」でも判定
--   3) レディースオールスター→G2、ヤングダービー→PG1の誤分類を防止
-- ============================================================

alter table public.races
  add column if not exists grade text,
  add column if not exists is_ladies boolean,
  add column if not exists race_title text,
  add column if not exists race_type text,
  add column if not exists metadata_source text,
  add column if not exists metadata_captured_at timestamptz;

-- まず既存表記を正規化
update public.races
set grade = case
  when upper(coalesce(grade, '')) in ('SG', 'G1', 'G2', 'G3', 'PG1') then upper(grade)
  when upper(coalesce(grade, '')) in ('ＰＧ１', 'PGⅠ', 'P G1') then 'PG1'
  when upper(coalesce(grade, '')) in ('Ｇ１', 'GⅠ', 'G 1') then 'G1'
  when upper(coalesce(grade, '')) in ('Ｇ２', 'GⅡ', 'G 2') then 'G2'
  when upper(coalesce(grade, '')) in ('Ｇ３', 'GⅢ', 'G 3') then 'G3'
  when coalesce(grade, '') like '%一般%' then '一般'
  else grade
end
where coalesce(trim(grade), '') <> '';

-- 固有大会名は、既存gradeが誤っていても強制的に正しい区分へ直す。
-- レディースオールスターの「オールスター」、ヤングダービーの「ダービー」を
-- SGの一般語より先に処理するのが重要。
update public.races
set grade = 'G2', metadata_source = 'BACKFILL_GRADE_LADIES_20260710', metadata_captured_at = now()
where concat_ws(' ', race_title, race_type) ~* '(レディースオールスター|女子オールスター)';

update public.races
set grade = 'PG1', metadata_source = 'BACKFILL_GRADE_LADIES_20260710', metadata_captured_at = now()
where concat_ws(' ', race_title, race_type) ~* '(PG1|ＰＧ１|プレミアムG1|プレミアムＧ１|BBCトーナメント|バトルチャンピオントーナメント|ヤングダービー|クイーンズクライマックス|レディースチャンピオン|女子王座(決定戦)?|賞金女王(決定戦)?|スピードクイーンメモリアル|マスターズチャンピオン)';

update public.races
set grade = 'G3', metadata_source = 'BACKFILL_GRADE_LADIES_20260710', metadata_captured_at = now()
where concat_ws(' ', race_title, race_type) ~* '(\mG3\M|Ｇ３|GⅢ|オールレディース|企業杯|マスターズリーグ|イースタンヤング|ウエスタンヤング)';

update public.races
set grade = 'G2', metadata_source = 'BACKFILL_GRADE_LADIES_20260710', metadata_captured_at = now()
where concat_ws(' ', race_title, race_type) ~* '(\mG2\M|Ｇ２|GⅡ|モーターボート大賞|秩父宮妃記念杯|全国ボートレース甲子園)'
  and concat_ws(' ', race_title, race_type) !~* '(レディースオールスター|女子オールスター)';

update public.races
set grade = 'SG', metadata_source = 'BACKFILL_GRADE_LADIES_20260710', metadata_captured_at = now()
where concat_ws(' ', race_title, race_type) ~* '(\mSG\M|グランプリ|賞金王|ボートレースクラシック|総理大臣杯|ボートレースオールスター|笹川賞|グランドチャンピオン|グラチャン|オーシャンカップ|ボートレースメモリアル|モーターボート記念|ボートレースダービー|全日本選手権|チャレンジカップ)';

update public.races
set grade = 'G1', metadata_source = 'BACKFILL_GRADE_LADIES_20260710', metadata_captured_at = now()
where concat_ws(' ', race_title, race_type) ~* '(\mG1\M|Ｇ１|GⅠ|周年|地区選手権|高松宮記念|ダイヤモンドカップ)'
  and coalesce(grade, '') <> 'PG1';

-- タイトルがあるのに上記に該当しないものは一般戦。
update public.races
set grade = '一般', metadata_source = coalesce(metadata_source, 'BACKFILL_GRADE_LADIES_20260710'), metadata_captured_at = coalesce(metadata_captured_at, now())
where coalesce(trim(grade), '') = ''
  and (coalesce(trim(race_title), '') <> '' or coalesce(trim(race_type), '') <> '');

-- 明確な女子大会名から女子戦を補完。
-- 男女混合企画はタイトルだけで全レースを女子戦にしない。
update public.races
set is_ladies = true,
    metadata_source = coalesce(metadata_source, 'BACKFILL_LADIES_TITLE_20260710'),
    metadata_captured_at = coalesce(metadata_captured_at, now())
where concat_ws(' ', race_title, race_type) ~* '(オールレディース|レディースチャンピオン|レディースオールスター|クイーンズクライマックス|ヴィーナス(シリーズ)?|女子リーグ|女子王座(決定戦)?|賞金女王(決定戦)?|スピードクイーンメモリアル|女子レーサー)'
  and concat_ws(' ', race_title, race_type) !~* '(レディース[[:space:]]*(VS|対)[[:space:]]*ルーキーズ|男女W優勝戦|男女ダブル優勝戦|男女混合)';

-- 大会名が変わっていても、race_resultsの6艇が全員女子選手なら女子戦にする。
-- 男女W優勝戦・レディースVSルーキーズ等も、レース単位で正しく分離できる。
with female_regnos(regno) as (
  values
    (3175),
    (3207),
    (3232),
    (3289),
    (3302),
    (3334),
    (3355),
    (3357),
    (3435),
    (3470),
    (3474),
    (3509),
    (3518),
    (3528),
    (3551),
    (3579),
    (3580),
    (3604),
    (3611),
    (3618),
    (3645),
    (3704),
    (3778),
    (3801),
    (3845),
    (3871),
    (3900),
    (3932),
    (3943),
    (3993),
    (3994),
    (3999),
    (4011),
    (4014),
    (4017),
    (4045),
    (4050),
    (4065),
    (4071),
    (4098),
    (4117),
    (4123),
    (4183),
    (4190),
    (4208),
    (4224),
    (4225),
    (4240),
    (4243),
    (4244),
    (4246),
    (4275),
    (4283),
    (4286),
    (4289),
    (4300),
    (4304),
    (4313),
    (4317),
    (4347),
    (4349),
    (4372),
    (4373),
    (4385),
    (4387),
    (4399),
    (4400),
    (4408),
    (4414),
    (4419),
    (4433),
    (4443),
    (4447),
    (4450),
    (4456),
    (4464),
    (4473),
    (4478),
    (4479),
    (4482),
    (4484),
    (4499),
    (4501),
    (4502),
    (4510),
    (4519),
    (4525),
    (4530),
    (4534),
    (4536),
    (4546),
    (4548),
    (4556),
    (4569),
    (4589),
    (4590),
    (4611),
    (4627),
    (4642),
    (4678),
    (4680),
    (4689),
    (4690),
    (4694),
    (4714),
    (4720),
    (4726),
    (4730),
    (4733),
    (4738),
    (4744),
    (4746),
    (4758),
    (4764),
    (4765),
    (4773),
    (4775),
    (4781),
    (4784),
    (4791),
    (4804),
    (4819),
    (4823),
    (4825),
    (4843),
    (4844),
    (4845),
    (4853),
    (4854),
    (4874),
    (4878),
    (4882),
    (4884),
    (4885),
    (4891),
    (4893),
    (4897),
    (4900),
    (4901),
    (4909),
    (4924),
    (4927),
    (4936),
    (4938),
    (4940),
    (4941),
    (4947),
    (4961),
    (4963),
    (4964),
    (4965),
    (4974),
    (4984),
    (4987),
    (4990),
    (4994),
    (4997),
    (4998),
    (5003),
    (5013),
    (5019),
    (5030),
    (5045),
    (5052),
    (5056),
    (5057),
    (5069),
    (5072),
    (5078),
    (5079),
    (5088),
    (5108),
    (5113),
    (5117),
    (5118),
    (5123),
    (5129),
    (5140),
    (5144),
    (5146),
    (5148),
    (5151),
    (5153),
    (5155),
    (5156),
    (5162),
    (5163),
    (5164),
    (5165),
    (5171),
    (5173),
    (5174),
    (5180),
    (5182),
    (5184),
    (5188),
    (5189),
    (5192),
    (5193),
    (5194),
    (5195),
    (5198),
    (5200),
    (5202),
    (5203),
    (5204),
    (5205),
    (5213),
    (5215),
    (5218),
    (5227),
    (5230),
    (5231),
    (5241),
    (5248),
    (5250),
    (5251),
    (5254),
    (5264),
    (5265),
    (5272),
    (5277),
    (5281),
    (5283),
    (5287),
    (5291),
    (5295),
    (5296),
    (5297),
    (5305),
    (5306),
    (5310),
    (5314),
    (5317),
    (5320),
    (5322),
    (5324),
    (5326),
    (5327),
    (5334),
    (5335),
    (5340),
    (5342),
    (5346),
    (5347),
    (5357),
    (5358),
    (5360),
    (5361),
    (5362),
    (5365),
    (5367),
    (5370),
    (5373),
    (5380),
    (5387),
    (5389),
    (5390),
    (5391),
    (5397),
    (5399),
    (5406),
    (5410),
    (5412),
    (5413),
    (5414),
    (5415),
    (5416),
    (5418),
    (5428),
    (5435),
    (5436),
    (5437),
    (5438),
    (5439),
    (5440),
    (5442),
    (5444),
    (5446),
    (5447),
    (5451),
    (5454),
    (5459),
    (5461),
    (5462),
    (5464),
    (5471),
    (5472)
), all_female_races as (
  select rr.race_date, rr.place_no, rr.race_no
  from public.race_results rr
  left join female_regnos f on f.regno = rr.regno
  where rr.regno is not null
  group by rr.race_date, rr.place_no, rr.race_no
  having count(distinct rr.regno) = 6
     and count(distinct case when f.regno is not null then rr.regno end) = 6
)
update public.races r
set is_ladies = true,
    metadata_source = coalesce(r.metadata_source, 'BACKFILL_LADIES_6RACERS_20260710'),
    metadata_captured_at = coalesce(r.metadata_captured_at, now())
from all_female_races a
where r.race_date = a.race_date
  and r.place_no = a.place_no
  and r.race_no = a.race_no;

create index if not exists races_grade_idx on public.races (grade, race_date);
create index if not exists races_category_idx on public.races (race_date, place_no, grade, is_ladies);
create index if not exists races_ladies_idx on public.races (is_ladies, race_date);

alter table public.races enable row level security;
grant usage on schema public to anon, authenticated, service_role;
grant select on public.races to anon, authenticated;
grant select, insert, update, delete on public.races to service_role;

drop policy if exists "races_select_all" on public.races;
create policy "races_select_all"
on public.races
for select
to anon, authenticated
using (true);

notify pgrst, 'reload schema';

-- 実行後確認1: グレード別件数
select coalesce(nullif(trim(grade), ''), '未分類') as grade,
       count(*) as races,
       min(race_date) as oldest,
       max(race_date) as newest
from public.races
group by 1
order by 1;

-- 実行後確認2: 女子戦件数・グレード内訳
select coalesce(nullif(trim(grade), ''), '未分類') as grade,
       count(*) as ladies_races,
       min(race_date) as oldest,
       max(race_date) as newest
from public.races
where is_ladies is true
group by 1
order by 1;
