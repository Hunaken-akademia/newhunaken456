# 逃げシミュレーション追加完全版

## 追加内容

- Supabase `race_results` から、開催場ごとの直近365日レースを読み込み
- 1コース逃げ率、1コース1着率をDBで自動計算
- 逃げ成功時の2着・3着・1-X出目傾向を表示
- 逃げ失敗時の決まり手内訳を表示
- イン逃げ信頼度を算出
  - 当地の逃げ率
  - 1コース選手本人の1着率
  - ST優位
  - 展示評価
  - 風補正
  - 2コース壁性能
  - 3コース攻撃警戒
- 進入変更対応
  - 5号艇が6コース進入なら5号艇に6コース成績を反映
  - 6号艇が5コース進入なら6号艇に5コース成績を反映

## 注意

新しいSQLは不要です。既存の `race_results` を使います。
ただし Supabase の public.race_results に anon/authenticated の select 権限が必要です。

```sql
grant usage on schema public to anon, authenticated;
grant select on public.race_results to anon, authenticated;
```

## 使い方

ZIPの中身をGitHubに全上書きして、VercelでRedeployしてください。
