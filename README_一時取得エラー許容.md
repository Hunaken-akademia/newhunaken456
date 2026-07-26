# 一時取得エラー許容修正

- 通常取得エラー1〜4件: 次回再取得を前提に成功扱い
- 通常取得エラー5件以上: 失敗扱い
- AI保存エラー1件以上: 失敗扱い
- heartbeatも同じ判定に統一

上書き対象: `pipeline/capture_all_active_races.mjs`
