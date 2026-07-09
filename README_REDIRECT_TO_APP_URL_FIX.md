# Googleログイン戻り先固定 修正

- Supabase全体のSite URLは無料版のままでOK
- 有料版ではVercel環境変数 `APP_URL` を読み込み、Googleログインの `redirect_to` を有料版URLに固定
- `/api/runtime-config.js` から `APP_URL` をブラウザ側へ安全に渡す
- `APP_URL` 未設定時のみ現在のURLへ戻るフォールバック

Vercel環境変数:

```
APP_URL=https://newhunaken456.vercel.app
```
