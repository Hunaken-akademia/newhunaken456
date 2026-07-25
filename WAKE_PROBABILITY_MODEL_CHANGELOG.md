# WAKE 確率モデル駆動改修

## 変更内容
- winProb / probMap を買い目生成前へ移動
- 本線は r1[0] を1着固定し、2・3着を推定確率順で選択
- 対抗は r1[1] と scenarioHeads を頭候補として推定確率順で選択
- 穴は120通り全体から EV>=1.0 かつ20倍以上をEV順で選択
- 超穴は120通り全体から EV>=1.0 かつ50倍以上を選び、合成10倍以上を維持
- EVリストは120通り全体の上位20点
- ピッカーEVモードは probMap を優先し、無い時だけ旧疑似確率へフォールバック
- 各カードにカバー率を表示
- 復習は翌日朝8時までの既存仕様と表記を維持

## 変更していないもの
paid_users / Stripe / Webhook / Googleログイン / 認証ゲート / クラウド保存データ / 評価数式 / 配点 / score / 縮小推定

## ビルド
package.json の build は `node scripts/build-prebuilt.mjs`。
Viteの生成物を一時ディレクトリへ出力し、既存の認証ブートストラップを維持したまま dist/assets と dist/cloud-bootstrap-v3.js の参照先を更新する。
