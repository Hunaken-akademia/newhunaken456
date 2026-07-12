# クラウド保存の画面反映修正 v2

## 原因
画面本体の `App.jsx` は収支・予想履歴を次の順番で読みます。

1. `window.storage`
2. `localStorage`

一方、クラウド保存v1は復元データを `localStorage` にしか書いていませんでした。
`window.storage` に空配列が残っていると、画面はそちらを優先するため、クラウド保存・復元が成功しても下の収支集計が0件のままになることがありました。

## 修正内容
- クラウド復元時に以下の両方へ同じデータを保存
  - `window.storage`
  - `localStorage`
- クラウドへ保存するときも、画面本体と同じく `window.storage` を優先して読み込む
- 復元後に画面を再読み込みし、収支・予想履歴へ反映

## 変更ファイル
- `cloud-save.js`
- `dist/cloud-save.js`
- `README_CLOUD_SAVE_V2_REFLECTION_FIX.md`

## 変更していないもの
- `src/App.jsx`
- 収支計算ロジック
- 予想機能
- Stripe
- Stripe Webhook
- Googleログイン
- `paid_users`
- Supabaseのテーブル・データ・RLS
- GitHub Actions

## 反映後の確認
1. 同じGoogleアカウントで有料版を開く
2. 「クラウド保存から復元済み」と表示されるまで待つ
3. 必要に応じてページが1回自動更新される
4. 下の「舟券の収支記録」と「舟券の履歴」に件数・金額が反映されることを確認
5. 反映後に「今すぐ保存」を1回押す

## ロールバック
問題がある場合は、直前のv1に含まれる次の2ファイルへ戻してください。
- `cloud-save.js`
- `dist/cloud-save.js`
