# SG/G1分離・G2/G3追加 COMPLETE FIX

## 変更内容

- 期間/区分プルダウンの「SG/G1」を廃止し、以下に分離
  - SG
  - G1
  - G2
  - G3
- 平均STの期間、選手成績の区分、決まり手/逃げ系の期間に同じ区分を追加
- race_results と races を race_date/place_no/race_no で内部結合し、races.grade / races.is_ladies / races.race_type を反映
- G1は PG1 と G1 をまとめて扱う
- G2/G3はデータが貯まり次第、自動で反映

## 注意

- races テーブルに grade / is_ladies / race_type が保存されていない過去レースは、区分別では空または少数になります。
- 今後の自動取得やバックフィルで races メタデータが増えるほど、SG/G1/G2/G3/女子戦/初日/最終日などの精度が上がります。
- 直近6ヶ月 vs 直近3ヶ月の買い目比較デフォルトは維持しています。
- チルト・展示取得修正済み版をベースにしています。

## 確認

- npm run build 成功
- package.json version: 1.1.1
