# 展示RPC SQLエラー修正＋ライブ中の次R自動選択

## 修正内容

- `racer_exhibition_sensitivity` の日付型不一致エラーを修正
  - `timestamp without time zone` と `date` が混ざっていたため、すべて `date` に統一
  - 途中作成された古い関数シグネチャを削除してから作成
- モーニング等で開催中なのに1Rに残る問題を軽減
  - 開催中は公式締切＋場別概算時刻で、過去Rに戻らないよう補正
  - 画面表示中にも即時に次R判定を実行
- 開催中はレースプルダウンを基本ロック
  - 発売終了後の復習モードでは手動選択可能

## 実行するSQL

Supabase SQL Editorで以下を実行してください。

`sql/add_exhibition_table_and_rpc.sql`

