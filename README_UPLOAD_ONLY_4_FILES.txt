GitHubへアップロードするのは次の4ファイルだけです。

src/App.jsx
package.json
scripts/build-prebuilt.mjs
WAKE_PROBABILITY_MODEL_CHANGELOG.md

フォルダ構成を保ったまま上書きしてください。
その後、Vercelでnpm install → npm run buildが実行される設定で再デプロイしてください。
