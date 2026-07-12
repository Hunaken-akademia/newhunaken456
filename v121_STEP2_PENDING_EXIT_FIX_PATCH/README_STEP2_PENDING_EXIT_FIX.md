# STEP2 レース結果取得 PENDING終了コード修正

## 目的
レース結果がまだ確定していない正常な `PENDING` 状態を、GitHub Actionsの失敗として扱わないようにします。

## 変更ファイル
- `pipeline/capture_race_results.mjs`

## 変更内容
- `failedRaces > 0` の場合だけ終了コード2で失敗終了
- `savedRaces === 0 && pendingRaces > 0` の場合は、未確定件数をログへ出して終了コード0で正常終了
- 日付解決、cron、取得処理、DB保存処理、評価ロジックには変更なし

## 期待される動作
### 全レース未確定
- ログ: `PENDING ...`
- 最終ログ: `全○件が結果未確定（PENDING）のため正常終了します。`
- GitHub Actions: 成功（緑）

### 通信・解析・DB処理の失敗が1件以上
- 最終ログ: `失敗レースが○件あるため失敗終了します。`
- GitHub Actions: 失敗

## 変更していないもの
- `paid_users`
- Googleログイン / note承認 / Stripe
- クラウド保存
- レース結果の取得・解析・保存内容
- GitHub Actionsの実行時刻と対象日付
- 展示・評価ロジック

## ロールバック
`pipeline/capture_race_results.mjs` をSTEP1版へ戻してください。
