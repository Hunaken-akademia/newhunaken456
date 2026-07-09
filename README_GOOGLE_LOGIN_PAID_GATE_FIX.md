# Googleログイン＋購入者判定ゲート追加

## 追加内容

- Googleログインボタンを起動時に表示
- Supabase Auth の Google OAuth でログイン
- ログイン後、`paid_users` テーブルから自分のメールだけを確認
- `expires_at` が未来、または null の場合だけツール本体を表示
- 未購入メールの場合は「購入者専用」画面を表示
- ツール本体の上部に「✓ 購入者確認済み」とログアウトボタンを表示
- `sql/setup_paid_users_and_rls.sql` を同梱

## 必須SQL

Supabase SQL Editor で `sql/setup_paid_users_and_rls.sql` を実行してください。

購入者追加例:

```sql
insert into public.paid_users (email, expires_at)
values ('buyer@example.com', now() + interval '6 months');
```

## Supabase側で必要な設定

Authentication > Providers > Google を有効化。
Authentication > URL Configuration に以下を追加。

- Site URL: `https://newhunaken456.vercel.app`
- Redirect URLs: `https://newhunaken456.vercel.app/*`

## Vercel環境変数

既存の以下が必要。

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_TABLE=hunaken_user_data`

`SUPABASE_SERVICE_KEY` はサーバー側のみ。フロントには入れない。

## 注意

今回は購入者判定ゲートまで。クラウド保存復活は次工程。
