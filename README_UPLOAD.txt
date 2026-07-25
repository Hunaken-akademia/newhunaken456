# 全開催場・全レース展示保存＋復習スナップショット

## 変更内容
- 開催中の全24場を5分ごとに確認
- 締切20分前〜12分後の対象レースを自動取得
- 展示・1周・回り足・直線・選手・モーター等を保存
- 締切後はオッズを再取得して確定版として保存
- 復習時は公式サイトを再取得せず、保存済みスナップショットを返す
- 発売中レースだけは従来どおり最新オッズを取得

## 導入順
1. Supabase SQL Editorで `sql/setup_race_review_snapshots.sql` の中身を実行
2. ZIP内のファイルを同じパスへ上書き
3. GitHub Secretsに以下を確認
   - `CAPTURE_TOKEN`（API側Vercel環境変数と同じ値）
   - `APP_BASE_URL`（未設定ならスクリプトは https://newhunaken456.vercel.app を使用）
4. Actions → `capture-all-active-races` → Run workflow で手動試験
5. ログで `OK 場名○R rows=6 odds=120` を確認

## 安全範囲
- paid_users変更なし
- Stripe変更なし
- Googleログイン変更なし
- 認証ゲート変更なし
- DELETE/TRUNCATEなし
