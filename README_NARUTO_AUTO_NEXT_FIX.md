# 鳴門展示取得・次R自動表示・展示SQL型ズレ修正版

## 修正内容
- racer_exhibition_sensitivity の date / timestamp 型ズレを修正
- SQLが途中で失敗していても復旧できるよう、RPCを依存順で作り直し
- 開催場一覧カードの次Rが古い復習用キャッシュで1R固定になる問題を修正
- 締切時刻ちょうどになったら次Rへ進むよう修正
- 鳴門など、BOATCAST txtの列位置が違う場でも展示/一周/まわり足/直線を拾う保険を追加

## 実行SQL
Supabase SQL Editorで以下を実行してください。

```text
sql/fix_exhibition_rpc_signature.sql
```

または同じ内容の

```text
sql/add_exhibition_table_and_rpc.sql
```

でもOKです。
