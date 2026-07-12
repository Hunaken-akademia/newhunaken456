# 過去1年バックフィル STEP1：K票の1日分事前確認

## このSTEPで行うこと

公式K票の1日分をダウンロードして、現在想定している書式で以下を正しく読めるか確認します。

- 場
- レース番号
- 着順
- 艇番
- 登録番号
- 実ST候補
- 決まり手候補

## 安全性

- DB書き込み処理はありません。
- `race_results`、`races`、`pre_race_status`、各stagingテーブルへも書き込みません。
- `paid_users`、Googleログイン、note承認、Stripe、クラウド保存へ触れません。
- GitHub Secretsも使いません。
- 手動実行のみで、自動スケジュールはありません。

## GitHubへの追加ファイル

- `pipeline/backfill/inspect_k_file.mjs`
- `.github/workflows/inspect-k-file-backfill.yml`

## 実行方法

1. ZIPを解凍し、中身をGitHubへアップロードしてCommitします。
2. GitHubの `Actions` を開きます。
3. `inspect-k-file-backfill` を選びます。
4. `Run workflow` を押します。
5. 初回は以下のまま実行します。
   - date: `2026-07-02`
   - show_raw: `false`
6. 完了後、ログの `=== K票バックフィル事前診断 ===` 以降を確認します。

## 合格目安

- `candidate_rows` が0ではない
- `candidate_races` が0ではない
- `invalid_boat_rows=0`
- `invalid_regno_rows=0`
- 候補行サンプルで、場・レース・艇番・登録番号・STが実際の結果と一致する

この確認に合格するまでは、1年分の本番投入を行いません。

## 次STEP

ログ確認後、次の順で進めます。

1. 1日分を `race_results_staging` だけへ保存
2. 既存の本番結果と件数・ST・進入を照合
3. nullで正常値を上書きしない昇格SQLを作成
4. 7日単位でバックフィル
5. 問題なければ1年分へ拡大

## 重要な制限

過去のK票だけでは「そのレース前にF持ちだったか」を完全には復元できません。
通常の平均ST・枠別成績・決まり手は過去結果で改善できますが、F持ち時平均STは現在以降のレース前保存データが中心になります。
