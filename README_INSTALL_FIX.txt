Vercel npm install 修正パッチ

原因:
- package-lock.json の resolved URL がOpenAI内部レジストリを指しており、Vercelから取得できませんでした。
- Node指定が >=20 <25 だったため、VercelがNode 24を選んでいました。

修正:
- resolved URLを https://registry.npmjs.org/ に統一
- Node.jsを22.xへ固定

アップロード先:
- package.json
- package-lock.json

アップロード後、VercelでRedeployしてください。
