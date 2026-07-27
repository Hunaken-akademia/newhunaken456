# undefined.length 完全対策

## 原因
進入データが更新途中で6艇未満の配列になった際、`every()` が既存要素だけを検査して通過し、
不足した艇のコースが `undefined` のまま `courses` に保存されていました。

その後 `lookup(course, diff)` で `TABLES[undefined]` を参照し、
`rows.length` で画面全体が落ちていました。

## 修正
1. 進入データは6艇すべて揃い、1〜6が重複なく含まれる場合だけ反映
2. `lookup()` 側にも防御を追加し、不正コースでもゼロ補正で継続

上書き対象:
- src/App.jsx
