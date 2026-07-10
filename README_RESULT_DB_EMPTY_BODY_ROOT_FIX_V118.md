# v118 結果保存500エラー根本修正

## 原因
Supabase/PostgRESTへ `Prefer: return=minimal` で保存すると、成功レスポンスが201/200でも本文が空になる場合があります。
旧版は成功後に無条件で `res.json()` を実行していたため、実データが保存された直後に
`Unexpected end of JSON input` が発生し、Vercel APIが500を返していました。

## 修正
- Supabaseレスポンスを先にtextで取得し、空本文なら正常終了
- 本文がある場合だけJSON.parse
- 着順6艇・実ST5艇の公式結果は、欠損1艇をnullとして保存
- ログに `PARTIAL_ST missing=艇番` を表示し、後日の再取得で補修可能
- parser/app versionをv118へ更新

## SQL
追加SQLはありません。既存の `enable_daily_result_capture.sql` の再実行は不要です。
