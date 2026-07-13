HUNAKEN V125 GRADE CONTEXT LITERAL PATCH

対象:
- api/yoso.js

内容:
- V124で孤立した「G3」や「ヴィーナスシリーズ」などカテゴリ/ナビ表示を拾ってしまう問題を抑制。
- グレードは表示文字を使うが、単独のSG/G1/G2/G3行は採用せず、近くに開催タイトルらしい行がある時だけ採用。
- レディース判定も「ヴィーナスシリーズ」単独などのカテゴリ表示は採用しない。
- appVersion/cache namespace を v125 に更新。
- デバッグ用に metaDebugLines をAPI返却へ追加。
