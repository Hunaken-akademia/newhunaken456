WAKE patch v12

1) Supabase SQL Editor で sql_racer_kimarite_stats.sql を先に実行
2) src/App.jsx を既存プロジェクトの src/App.jsx に上書き
3) デプロイ

変更点:
- 1Cの差され/まくられ/まくられ差しを、同一レースの1着艇の決まり手で正しく集計
- 2〜6Cの左列は「逃し」として集計（画面見出しは 逃げ／逃し）
- 決まり手率の各%下に該当回数、右端に出走回数を表示
- 6ヶ月/1年は専用プルダウンに連動
- 攻められ耐性の基準値取得を resistance_baseline_all_courses 1回に変更
- 決まり手率は表示専用で、予想ロジックには未反映
