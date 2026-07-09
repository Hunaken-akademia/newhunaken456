-- ============================================================
-- 舟券アカデミア 有料販売の土台SQL
-- Googleログイン + paid_users 購入者判定 + Stripe Webhook自動追加（1人1回・販売期間固定）
-- Supabase SQL Editor で実行
-- ============================================================

-- 1) 購入者リスト（買い切りの利用権管理）
--    Stripe決済完了後、api/stripe-webhook.js が SUPABASE_SERVICE_KEY でここへ自動追加する。
--    購入は1人1回まで。expires_at は全員共通で 2026/12/31 23:59 JST に固定する。
create table if not exists public.paid_users (
  email          text primary key,
  plan           text default 'buyout_2026',
  purchased_at   timestamptz default now(),
  expires_at     timestamptz,          -- 有料版は 2026-12-31 23:59 JST 固定
  note           text
);

-- 既存テーブルにも安全に追加できるStripe管理用カラム
alter table public.paid_users add column if not exists stripe_session_id text;
alter table public.paid_users add column if not exists stripe_customer_id text;
alter table public.paid_users add column if not exists last_payment_at timestamptz;



-- 販売ルールメモ
-- 販売期間: 2026/7/13 00:00 JST 〜 2026/8/13 23:59 JST
-- 利用期限: 2026/12/31 23:59 JST
-- 1人1回購入まで。api/create-checkout-session.js で既存emailを確認し、既存ならStripe決済画面を作らない。
-- Webhook側も既存emailがある場合は期限延長・上書きしない。

-- メールは小文字で扱う前提。手動追加時も lower(email) 推奨。
create index if not exists paid_users_expires_at_idx on public.paid_users (expires_at);
create index if not exists paid_users_stripe_session_id_idx on public.paid_users (stripe_session_id);

alter table public.paid_users enable row level security;

-- 何度実行してもエラーにならないように作り直し
drop policy if exists "read own entitlement" on public.paid_users;

-- ログイン済みユーザーは「自分のGoogleメールの行だけ」読める（有効期限の確認用）
create policy "read own entitlement"
on public.paid_users for select
using (lower(auth.jwt() ->> 'email') = lower(email));

-- insert/update/delete はクライアントから許可しない。
-- Stripe Webhook だけが SUPABASE_SERVICE_KEY で自動追加する。

-- 手動テスト用：自分のGoogleメールを2026/12/31 23:59 JSTまで有効で追加
-- 本番はStripe Webhookで自動追加。購入は1人1回までなので、通常はon conflict更新しない。
-- insert into public.paid_users (email, plan, purchased_at, expires_at, note)
-- values (lower('your-google-mail@gmail.com'), 'manual_test_2026', now(), '2026-12-31 14:59:00+00', 'manual test / expires 2026-12-31 23:59 JST');

-- 2) ユーザーデータ（クラウド保存を復活させる場合に必須のRLS）
--    hunaken_user_data を使う構成に戻すなら、これを必ず実行すること。
--    ログイン中はクラウドが唯一の正。端末保存とのマージ禁止。
-- alter table public.hunaken_user_data enable row level security;
-- drop policy if exists "select own rows" on public.hunaken_user_data;
-- drop policy if exists "insert own rows" on public.hunaken_user_data;
-- drop policy if exists "update own rows" on public.hunaken_user_data;
-- drop policy if exists "delete own rows" on public.hunaken_user_data;
-- create policy "select own rows" on public.hunaken_user_data
--   for select using (auth.uid() = user_id);
-- create policy "insert own rows" on public.hunaken_user_data
--   for insert with check (auth.uid() = user_id);
-- create policy "update own rows" on public.hunaken_user_data
--   for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- create policy "delete own rows" on public.hunaken_user_data
--   for delete using (auth.uid() = user_id);

-- 3) 動作確認
select relname, relrowsecurity
from pg_class
where relname in ('paid_users','hunaken_user_data');
