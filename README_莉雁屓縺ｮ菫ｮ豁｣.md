# AI保存「race は 1〜12」修正

変更ファイルは `src/App.jsx` のみです。

AI保存APIのURLへ `venue`・`race`・`date` を付けるように修正しました。
API側はPOST本文を読む前にURLのraceを検査するため、これまで本文に正しいraceが入っていても400エラーになっていました。

反映後、GitHub Actionsを手動実行し、`AI SAVED ○○○R` と `aiSaved: 1以上` を確認してください。
