# AI自動保存タイムアウト修正

変更ファイル:
- src/App.jsx
- pipeline/capture_all_active_races.mjs

修正内容:
- capture_ai URLのraceを1〜12の整数として固定
- captureモード中に別レース状態で誤保存しないガードを追加
- 手動風が保存済みのレースだけGitHub ActionsのAI対象にする
- 風未設定レースは90秒タイムアウトせずログでSKIP
- AI保存状態をブラウザ側からActionsへ通知
- 保存待ちを最大120秒に延長
