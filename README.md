# AI予想収支廃止版 ビルド修正

Vercelビルドエラー:
`Expected ")" but found "style"`

原因:
AI予想収支カードを囲む条件分岐の閉じ順が逆になっていました。

上書き先:
`src/App.jsx`
