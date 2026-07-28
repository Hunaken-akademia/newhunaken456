# ビルド構文エラー修正

修正したエラー:
`Expected "}" but found "none"`

原因:
「この買い目をリストに追加」ボタンのJSX内に、条件式が文字列として二重挿入されていました。

修正内容:
- ボタン文言の条件式を1つに整理
- 未選択時は `addConfiguredAiBetsToCart()`
- 並び順・配分を選択済みの場合は `addPickedToCart()`
- AI収支的中判定修正とAI全体削除は維持

上書き先:
`src/App.jsx`
