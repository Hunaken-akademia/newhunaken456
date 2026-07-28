# AI買い目自動保存を廃止

変更内容:
- PlaywrightによるAI買い目自動保存を削除
- `AI SAVED` / `AI SKIP` 処理を削除
- `AUTOMATION_AUTH_SESSION_JSON` を不要化
- `AI_CAPTURE_CONCURRENCY` / `AI_SAVE_BEFORE_MINUTES` を不要化
- AI保存失敗による GitHub Actions の exit code 1 を廃止
- 30分ごとの展示・オッズ・結果取得は維持
- 確定済みレースの再取得停止も維持
- GitHub Actionsは通常エラー5件以上のときだけ失敗扱い

上書き先:
`pipeline/capture_all_active_races.mjs`
