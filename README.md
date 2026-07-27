# 確定済みレース再取得停止

## 変更内容
- 実行開始時に `/api/yoso?action=confirmed_results` を1回だけ呼び出す
- Supabaseで1〜3着が揃っているレースを `confirmedKeys` として保持
- 確定済みレースは展示・オッズ・結果取得のjobsへ入れない
- API取得失敗時は安全側で従来どおり全件確認
- ログとsummaryに次を追加
  - skippedConfirmed
  - confirmedLookupFailed

## 上書き先
`pipeline/capture_all_active_races.mjs`

## 正常ログ例
`confirmed results loaded=86`
`capture/result jobs=18 skipped_confirmed=86`
