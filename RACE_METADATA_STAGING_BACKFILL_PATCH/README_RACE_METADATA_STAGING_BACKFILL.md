# 過去1年 グレード・女子戦 staging バックフィル

## 安全設計

- 保存先は `public.races_staging` のみ
- `public.races` は変更しない
- 1場1日につき公式 raceindex を1回取得
- staging書き込みは `CAPTURE_TOKEN` 必須
- 1回最大31日。過去1年は月単位で分割する

## 最初の実行

1. Supabase SQL Editorで `sql/setup_races_staging_metadata.sql` を実行
2. GitHub Actions `backfill-race-metadata-staging` を開く
3. まず以下で実行
   - start_date: `2026-07-08`
   - days: `3`
   - dry: `true`
4. ログの `NG` がなく、開催場で `races=12`、グレード・女子戦が妥当か確認
5. 同じ範囲を `dry=false` で実行
6. Supabaseで staging件数・重複・許可外グレードを確認

過去1年分を一度に実行しない。3日テスト後、7日、31日の順に広げる。
