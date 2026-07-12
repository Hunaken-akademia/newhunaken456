# 舟券アカデミア note販売連携 STEP 2

## 今回追加するもの

- `/note-activation/` 購入者用申請ページ
- Googleログイン
- note購入者名・購入日時・記事種別の入力
- 非公開Storageへの購入証明アップロード
- サーバーAPI経由の申請登録
- 購入者本人による自分の申請状態確認

## 変更しないもの

- `paid_users` の既存行
- Stripe購入者
- Stripe Webhook
- 既存のGoogleログインゲート
- クラウド保存
- 予想機能
- `src/App.jsx`

## 安全設計

- 購入証明はprivate bucketに保存
- ファイルはログイン中user_idのフォルダだけに保存
- 申請APIはSupabaseのアクセストークンを再検証
- クライアントから`paid_users`へ書き込み不可
- 既に利用権があるGoogleメールは申請不可
- 同じGoogleアカウントの重複申請は1件に集約
- 許可形式はJPEG/PNG/WebP/PDF、5MB以内

## 配置

完全版ZIPをGitHubへ上書きしてください。
このプロジェクトはprebuilt `dist`を配信するため、`dist/note-activation/`も同梱しています。

## 動作確認

1. デプロイ完了後、`https://newhunaken456.vercel.app/note-activation/` を開く
2. 未購入のテストGoogleアカウントでログイン
3. 購入情報を入力
4. 5MB以内のスクリーンショットを添付
5. 「申請を送信する」を押す
6. Supabase Table Editorの`note_purchase_applications`に`pending`が1件作成されることを確認
7. Storageの`note-purchase-proofs/<user_id>/`に証明ファイルがあることを確認

## 注意

このSTEPでは申請を作るだけです。`paid_users`には一切追加しません。
管理者画面・確認済み・一括承認はSTEP 3で追加します。
