# 自動取得キャッシュ機能

## 追加内容

- `/api/yoso` の取得結果を、Vercelサーバー内キャッシュに加えて Supabase の `yoso_cache` に保存します。
- 同じ日付・場・レース・データ種別なら、他ユーザーにも共有キャッシュを返します。
- 外部取得先へのアクセス回数を減らし、1000人規模で同じレースを開いた時の負荷を下げます。

## 必要なSupabase SQL

Supabase SQL Editorで `sql/add_yoso_cache_table.sql` を実行してください。

## 必要なVercel環境変数

既存:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_TABLE`

追加:

- `SUPABASE_SERVICE_KEY`

`SUPABASE_SERVICE_KEY` は Supabase の `service_role` キーです。  
これはサーバー側APIだけで使うため、名前に `VITE_` を付けないでください。  
`VITE_SUPABASE_SERVICE_KEY` には絶対にしないでください。

## 動作

- 直前情報・選手/モーター/展示/オッズ: 3分キャッシュ、古いキャッシュ30分保持
- オッズ単体: 1分キャッシュ、古いキャッシュ30分保持
- 締切時刻/開催一覧: 3分キャッシュ、古いキャッシュ30分保持

`SUPABASE_SERVICE_KEY` が未設定でも、従来のVercelメモリキャッシュだけで動きます。
