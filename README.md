# safeFixed 未定義エラー修正

エラー:
`Can't find variable: safeFixed`

原因:
安全な数値表示へ置換した呼び出し側だけが入り、共通関数 `safeFixed` の定義が抜けていました。

修正:
- `safeFixed(value, digits, fallback)` をグローバル関数として追加
- 数値なら `toFixed`
- undefined / null / NaN なら `—` を表示
- AI予想収支廃止と買い目追加レースのみ表示の変更は維持

上書き先:
`src/App.jsx`
