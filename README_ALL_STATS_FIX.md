# 成績・逃げシミュ・決まり手・平均ST 完全対応版

## 修正内容
- DB選手成績が0走になりにくいよう、race_resultsの読み取り権限SQLを追加
- 逃げシミュレーションをDBから読み込み
- 決まり手をDBから自動集計
- 平均STプルダウンをDB平均STにも対応
  - 直近6ヶ月
  - 直近1年
  - 直近3ヶ月
  - 直近1ヶ月
  - 当地
  - 一般戦 / SG-G1 / 女子戦 / 初日 / 最終日 / ナイター / F持 は、今後カテゴリ・F持ちデータが溜まり次第反映

## 手順
1. Supabase SQL Editorで sql/fix_all_read_policies_for_stats.sql を実行
2. GitHubへ全ファイル上書き
3. VercelでキャッシュなしRedeploy

