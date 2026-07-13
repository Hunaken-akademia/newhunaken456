HUNAKEN V126 GRADE NO NAV DEBUG PATCH

対象: api/yoso.js のみ
目的:
- G3スケジュール / ヴィーナスシリーズ等のナビ表示をグレード・女子戦判定に使わない
- appVersion と schedule cache を v126 に変更
- metaProbeLines を返し、公式ページ内で拾えている候補行を確認できるようにする

触っていないもの:
- paid_users
- Stripe / Googleログイン / 認証ゲート / 販売まわり
- race_results / pre_race_status の既存データ
