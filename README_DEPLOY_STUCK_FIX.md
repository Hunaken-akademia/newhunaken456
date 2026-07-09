# DEPLOY_STUCK_FIX

Vercelデプロイが10分以上終わらない問題への対策。

原因候補:
- vercel.json が毎回 `curl https://bun.sh/install` でBunをインストールしていた
- package-lock.json に内部環境のregistry URLが混ざっていた

対策:
- Bun固定をやめて npm install / npm run build に戻す
- packageManager bun 指定を削除
- package-lock.json を削除し、Vercel側で通常registryから再解決させる

変更ファイル:
- package.json
- vercel.json
- package-lock.json 削除
