# README_ST_PERIOD_DEFAULT_FIX

## 変更内容

平均STの期間プルダウンの初期値を変更。

- 変更前: 直近6ヶ月
- 変更後: 直近3ヶ月

## 維持した内容

- 買い目の期間比較デフォルト: 直近6ヶ月 vs 直近3ヶ月
- SG / G1 / G2 / G3 の区分追加
- チルト誤変換修正
- 展示取得フォールバック修正
- DB・自動取得・キャッシュ系の既存修正

## 対象

src/App.jsx

```jsx
const [stPeriod, setStPeriod] = useState("直近3ヶ月");
```
