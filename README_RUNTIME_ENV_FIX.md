# Runtime Env Fix

noinstall/prebuilt版ではViteのVITE_*環境変数がビルド時に埋め込まれないため、
Vercel Runtime Function `/api/runtime-config.js` からSupabase URL/anon keyを読み込む方式に変更。

必要なVercel環境変数:
- VITE_SUPABASE_URL
- VITE_SUPABASE_ANON_KEY

互換用に以下でも読める:
- SUPABASE_URL
- SUPABASE_ANON_KEY

index.htmlで `/api/runtime-config.js` を先に読み込み、`window.__HUNAKEN_ENV__` を設定してからアプリ本体を起動する。
