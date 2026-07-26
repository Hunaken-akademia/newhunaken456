# 全場全レース AI買い目 自動保存パッチ

## 概要
GitHub Actions が5分ごとに全24場の開催予定を確認し、展示（6艇分の展示・1周・回り足）と3連単オッズが揃ったレースを取得します。締切20分前から2分前までの対象レースは、GitHub Actions上のヘッドレスChromiumで `capture_ai=1` を開き、`src/App.jsx` の本番AI評価ロジックをそのまま実行して `ai_prediction_snapshots` へ保存します。

利用者のブラウザが閉じていても動作します。既存の認証ゲート、paid_users、Stripe、webhook、Googleログイン、購入権判定は変更していません。

## GitHub Secrets
既存:
- `APP_BASE_URL`
- `CAPTURE_TOKEN`

追加:
- `AUTOMATION_AUTH_SESSION_JSON`

値は、専用の購入権付きGoogle/Supabaseアカウントで取得した `hunaken_paid_auth_session_v1` のJSON文字列です。例:
`{"access_token":"...","refresh_token":"...","token_type":"bearer","expires_at":9999999999999}`

専用アカウントで一度ログインし、ブラウザの開発者ツールから localStorage の `hunaken_paid_auth_session_v1` を取得してSecretへ登録します。refresh_tokenを含めることで期限切れ時に通常の既存更新処理が使われます。

## 実行条件
- GitHub Actions: 5分間隔（JST 07:00〜翌00:55）
- 取得対象: 締切30分前〜締切90分後
- AI保存対象: 締切20分前〜2分前
- 展示条件: 6艇分の展示・1周・回り足が揃うこと（直線は不要）
- オッズ条件: 3連単オッズ10点以上
- 5艇レース: AI保存対象外。オッズ・結果取得は継続
- 同一run再試行: 締切15分前〜2分後で展示不足なら35秒後に1回、結果未確定なら20秒後に1回
- 次回再試行: 条件が揃わない、保存失敗、公式払戻未取得の場合は次の5分runで再確認

## 精算
`api/yoso.js` の開催場AI収支は、公式結果ページの3連単払戻金（100円あたり）だけを精算に使います。公式払戻金が未取得のレースは未精算のままにし、保存オッズによる代替精算は行いません。

## SQL
既存の `sql/setup_ai_prediction_snapshots.sql` を使用します。今回のパッチで新規SQLは追加していません。未適用環境のみ同SQLをSupabase SQL Editorで実行してください。

## 本番反映
1. 修正ファイルをGitHubへアップロード/commit/push
2. Vercelのデプロイ完了を確認
3. Actions > `capture-all-active-races` > Run workflow で手動実行
4. Supabase `ai_prediction_snapshots` に当日・場・Rの行が追加されることを確認
5. 本番画面の「開催場AI予想収支」で途中終了レース分まで反映されることを確認

※ GitHub Secrets（`APP_BASE_URL`、`CAPTURE_TOKEN`、`AUTOMATION_AUTH_SESSION_JSON`）は設定済み前提です。

## 動作確認URL
- 通常画面: `${APP_BASE_URL}/`
- 単一レース自動保存確認: `${APP_BASE_URL}/?capture_ai=1&date=YYYY-MM-DD&venue=丸亀&race=1`
- 開催場収支API: `${APP_BASE_URL}/api/yoso?action=venue_ai_ledger&date=YYYY-MM-DD&venue=丸亀&honmeiPoints=6&taikouPoints=12&anaPoints=12`
