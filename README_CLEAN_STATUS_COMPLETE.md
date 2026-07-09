# 表示整理＋逃げシミュ説明追加 完全版

## 変更内容

- 「補正状態」「DB補正・直近365日」などの内部状態表示を非表示化
- 「DB選手成績：読込済...」「逃げシミュ：DB反映...」などの詳細表示を非表示化
- 問題なければ「✓ ○○R 取得済」だけ表示
- エラーがある場合だけエラー内容を表示
- 逃げシミュレーション内に以下の説明を追加
  - ST優位
  - 2C壁性能
  - 3C攻撃警戒
- 前回の鳴門取得修正、ホーム次R自動表示、展示SQL修正も含む

## Supabase SQL

SQLエラーが残っている場合は、以下を実行してください。

- sql/fix_exhibition_rpc_signature.sql

または、同じ修正を含む以下でもOKです。

- sql/add_exhibition_table_and_rpc.sql

## デプロイ

GitHubへ全上書き後、VercelでRedeployしてください。
Use existing Build Cache は外してください。
