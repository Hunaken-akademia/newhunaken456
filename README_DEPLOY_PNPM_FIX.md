# Vercel npm Exit handler never called 対策

Vercel の `npm install --no-audit --no-fund` で `npm error Exit handler never called!` が出る環境向けに、npm install を使わず pnpm で依存関係を入れるよう変更しました。

変更内容:
- package.json version 1.3.3
- packageManager: pnpm@9.15.9
- vercel.json installCommand を pnpm install に変更
- buildCommand を pnpm run build に変更

購入ルール・Googleログイン・Stripe・復習当日表示・利用規約文言の変更は維持しています。
