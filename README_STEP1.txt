WAKE 改善① 手順1：共通ヘルパー追加

上書き対象:
  src/App.jsx

追加:
- probOf(t): probMap未取得・不正値を0として安全に参照
- sortByProb(list): 推定確率の降順
- sortByEv(list): オッズがある目はEV降順、オッズが無い場合は確率降順へフォールバック
- coverage(tickets): 重複を除いた買い目の推定確率合計

この段階では既存の買い目生成方法は変更していません。
認証、paid_users、Stripe、Webhook、Googleログイン、クラウド保存には触れていません。
