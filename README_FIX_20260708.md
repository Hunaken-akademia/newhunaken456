# 2026-07-08 修正版

## 修正内容

- 表示から「BOATCAST」「Supabase共有キャッシュ」の文言を削除
- 取得メッセージを「データ取得済・◯秒前」に簡略化
- 「今期」表記を「直近1年」に変更
- 選手成績・平均STのデフォルトを「直近6ヶ月」に変更
- DB選手成績・逃げシミュレーション用に `race_results` をanonから読めるRLSポリシーSQLを追加

## Supabaseで実行

`sql/fix_race_results_read_policy.sql`

## Vercel

ZIPをGitHubに上書き後、VercelでキャッシュなしRedeploy。
