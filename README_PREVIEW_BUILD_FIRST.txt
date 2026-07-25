WAKE ビルド経路安全化パッチ

アップロード先:
- package.json
- package-lock.json
- scripts/build-prebuilt.mjs

今回の目的:
1. Viteビルドが成功するまで既存distを変更しない
2. 生成された新バンドルを検証してからdist/assetsへ反映
3. cloud-bootstrap-v3.jsを新バンドルへ安全に差し替える
4. 古いViteハッシュ生成物だけを整理する
5. 手動命名の旧バンドル(index-v121-...)は削除しない

重要:
- まずPreview Deploymentで確認する
- Productionへ直接マージしない
- Build Logsで以下を確認する
  [build-prebuilt] verified entry: /assets/index-XXXXXXXX.js
  [build-prebuilt] prebuilt entry updated: /assets/index-XXXXXXXX.js
- echo prebuilt-dist が出た場合は旧設定のまま
- cloud-bootstrap-v3.jsがindex-v121-bet-save-fix-v1.jsを参照している場合は未反映

このパッチはWAKEロジック、認証、paid_users、Stripe、Webhook、Googleログイン、クラウド保存データを変更しません。
