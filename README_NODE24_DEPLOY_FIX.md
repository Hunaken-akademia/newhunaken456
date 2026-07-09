# Node24 Deploy Fix

Vercel の Node.js 20.x deprecated 警告/失敗対策として、package.json の engines を Node 24.x に更新しました。

- engines.node: 24.x
- packageManager: npm@11.5.1
- install: npm install --legacy-peer-deps --no-audit --no-fund
- build: npm run build

既存修正（復習表示当日中のみ、規約文言変更、Googleログイン、Stripe自動購入者登録、1人1回購入、販売期間固定、使用期限固定、展示/チルト修正など）は維持しています。
