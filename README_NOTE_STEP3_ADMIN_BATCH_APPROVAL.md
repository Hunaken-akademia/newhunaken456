# 舟券アカデミア note販売連携 STEP 3

## 追加内容
- スマホ対応の管理画面 `/note-admin/`
- NOTE_ADMIN_EMAILS に登録したGoogleアカウントだけ利用可能
- 非公開購入証明を5分間だけ閲覧できる署名URL
- 購入証明の「確認済み／解除」
- 確認済み申請だけ最大50件まとめて承認
- 1件承認、却下、再申請対応
- 承認処理はサーバーAPIからservice_roleでDB関数を実行

## 安全設計
- ブラウザへSUPABASE_SERVICE_KEYを渡さない
- 管理者判定はサーバー側で毎回実施
- 購入証明バケットはprivateのまま
- 署名URLの有効期限は5分
- pending申請は承認不可
- paid_users既存行は上書き・延長・削除しない
- 二重承認時も既存利用権を変更しない
- 一度に承認できる件数は50件まで

## 変更していないもの
- 既存のStripe購入者
- paid_users既存データ
- Googleログイン本体
- 予想機能
- クラウド保存
- Stripe Webhook

## デプロイ後
1. `https://newhunaken456.vercel.app/note-admin/` を開く
2. NOTE_ADMIN_EMAILSに登録したGoogleアカウントでログイン
3. 管理画面が表示されることを確認
4. テスト申請を1件作成
5. 購入証明を開く
6. 「確認済み」にする
7. チェックして承認
8. paid_usersへの追加を読み取りSQLで確認

本番の購入証明を使う前に、別の未購入Googleアカウントでテスト申請を行ってください。
