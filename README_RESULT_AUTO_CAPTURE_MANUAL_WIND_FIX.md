# レース結果の毎日自動回収＋風完全手動 FIX

## 追加したもの

### 1. レース確定結果の自動回収

- `api/yoso.js`
  - `action=result` を追加
  - BOAT RACE公式の確定結果から以下を取得
    - 着順
    - 実ST
    - 進入コース
    - 決まり手
    - F判定
    - 登録番号
  - `public.race_results` に同一レース・同一艇キーでupsert
  - 6艇分がそろわない未確定ページは保存せず、次回再取得で補修

- `pipeline/capture_race_results.mjs`
  - 全24場の開催レースを確認して確定結果を保存
  - エラー時は1回再試行
  - 過去日を指定して欠損補修可能

- `.github/workflows/capture-race-results.yml`
  - JST 23:35：当日分を保存
  - JST 08:40：前日分を再取得して欠損補修
  - Actions画面から日付を指定して手動実行可能

### 2. グレードの今後の自動保存

結果回収前に各場の `action=schedule` を呼ぶため、開催タイトル・グレード・女子戦メタデータも `races` に保存されます。

### 3. 風を完全手動化

- APIから風が返っても自動反映しません
- 事前取得済みデータからも反映しません
- レース変更、場変更、オールクリアでも風を無風へ戻しません
- 選択した風はブラウザに保存され、再読み込み後も維持します
- 画面表示を `風を選択（完全手動）` に変更

## 最初にSupabaseで実行

`sql/enable_daily_result_capture.sql`

## デプロイ後の動作確認

GitHub → Actions → `capture-race-results` → Run workflow

過去の欠損補修は、日付へ以下を順番に指定して `dry=false` で実行します。

- 2026-07-08
- 2026-07-09
- 2026-07-10

## 保存状況確認SQL

```sql
select * from public.race_result_capture_daily_counts(14);
```

F持ち時平均STの結合件数確認:

```sql
select
  count(*) as pre_race_rows,
  count(rr.race_date) as result_join_rows,
  count(*) filter (where prs.f_hold is true) as f_hold_pre_race_rows,
  count(*) filter (
    where prs.f_hold is true
      and rr.st is not null
      and rr.st >= 0
  ) as f_hold_valid_st_rows,
  count(*) filter (
    where prs.f_hold is true
      and rr.is_f is true
  ) as f_cut_rows
from public.pre_race_status prs
left join public.race_results rr
  on rr.race_date = prs.race_date
 and rr.place_no = prs.place_no
 and rr.race_no = prs.race_no
 and rr.boat = prs.boat
 and rr.regno = prs.regno;
```
