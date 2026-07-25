1. Supabase SQL Editorで sql/setup_ai_prediction_snapshots.sql の中身だけを実行。
2. GitHubへ次の3ファイルを同じ場所に上書き。
   - src/App.jsx
   - api/yoso.js
   - dist/index.html
3. Commit後、VercelのBuild Logsで新しいVite bundle生成とDeployment completedを確認。

変更内容:
- 左側に重複していた「項目順を一律にする」を削除し、正式版1個だけ残す。
- 日付と開催場の間に「開催場AI予想収支」を追加。
- 終了済みレースまでを自動集計。各項目の点数を1〜12点で選択可能。
- 不足しているAI予想スナップショットは非表示iframeで順番に自動生成・保存。
- 舟券収支の結果出目・配当入力欄を削除。
- 「買い目購入を記録する」で結果未確定でも保存し、公式結果と確定オッズ取得後に自動精算。

注意:
- 導入前の過去レースはAI予想スナップショットが無いため、対象日を開いた時に順次自動作成される。
- 結果・確定オッズがDBに入っていないレースは、取得できるまで1分ごとに再確認する。
- paid_users / Stripe / Webhook / Googleログイン / 認証ゲート / 既存クラウド保存データは変更していない。
