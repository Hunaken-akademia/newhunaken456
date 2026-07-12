# v121 クラウド保存復活版 v1

## 変更内容
- 購入者確認済み表示の下に「Googleログイン・クラウド保存」を追加
- 「今すぐ保存」ボタンを追加
- 予想履歴 `hunaken_records` を `hunaken_user_data.records` へ保存
- 舟券収支 `hunaken_betRecords` を `hunaken_user_data.bet_records` へ保存
- 同じGoogleアカウントでログインした際、クラウド記録を端末内へ自動復元
- 端末とクラウドの記録はID単位で統合し、同じ記録を二重化しない
- 端末側にある同一IDの記録を優先し、クラウドにしかない記録を補う
- 未保存の変更がある場合は画面に表示
- クラウド非対応と書かれていたアプリ内説明を、実際の動作に合わせて修正

## 保存対象
- 予想履歴
- 舟券収支

買い目作成途中のカート、画面入力途中の数値は今回の保存対象にしていません。

## 安全仕様
- Supabaseのservice_roleキーは使用しない
- Googleログイン中のアクセストークンとRLSを使用
- `auth.uid() = user_id`の本人行だけ読み書き
- `paid_users`、Stripe、Webhook、購入者判定は変更しない
- 新規行では残りの列にDB既定値を使用
- 既存行では `records`、`bet_records`、`updated_at`だけ更新し、他列を上書きしない
- クラウド読込失敗時も端末データは削除しない
- クラウドに空データがあっても、端末側の記録を削除しない

## 変更ファイル
- `cloud-save.js`
- `dist/cloud-save.js`
- `index.html`
- `dist/index.html`
- `src/App.jsx`（保存説明の文言のみ）
- `dist/assets/index-v121-ui-status-fix-v2.js`（同じ文言のみ）
- `README_CLOUD_SAVE_V1.md`

## 変更していないもの
- Stripe決済
- Stripe Webhook
- Googleログイン本体
- paid_users
- 利用期限判定
- 予想ロジック
- 展示・結果取得API
- GitHub Actions
- Supabaseのテーブル構造
- 特商法・利用規約・プライバシーポリシーの各HTML

## 反映方法
このプロジェクトは `dist` をそのまま公開するため、完全版ZIPをGitHubへ上書きアップロードしてください。

## 反映後の確認
1. 購入者としてログイン
2. 「購入者確認済み」の下にクラウド保存欄が表示される
3. 収支を1件記録
4. 「未保存の変更があります」と表示される
5. 「今すぐ保存」を押す
6. 「クラウドへ保存しました」と表示される
7. Supabaseの `hunaken_user_data` で本人行の `bet_records` が増えている

## ロールバック
問題があれば、直前に正常稼働していた `v121_UI_STATUS_FIX_V2_FULL.zip` をGitHubへ再アップロードしてください。
