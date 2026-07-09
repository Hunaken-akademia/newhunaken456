# DEPLOY NODE20 NPM FIX

Vercel上で pnpm が `ERR_INVALID_THIS`、npm が `Exit handler never called` になる環境向けのデプロイ修正版です。

## 修正内容
- package.json の Node.js 指定を `22.x` から `20.x` に変更
- `packageManager: pnpm...` を削除
- vercel.json を npm 標準ビルドに戻し
- installCommand: `npm install --legacy-peer-deps --no-audit --no-fund`
- buildCommand: `npm run build`

## 維持している内容
- 復習表示は当日中のみ
- 利用規約文言変更
- Googleログイン＋購入者判定
- Stripe購入後の自動登録
- 1人1回購入
- 販売期間 2026/7/13〜2026/8/13
- 使用期限 2026/12/31 23:59
- チルト/展示/大村取得修正
- SG/G1/G2/G3分離
- 平均STデフォルト直近3ヶ月
- 買い目比較デフォルト直近6ヶ月 vs 直近3ヶ月
