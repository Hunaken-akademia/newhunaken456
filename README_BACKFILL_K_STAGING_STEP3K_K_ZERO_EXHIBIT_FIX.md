# STEP3K K1 0.00 fix patch

## 種別
パッチ版ZIPです。STEP3Jの上に上書きしてください。

## 修正内容
- `K0` / `K1` で、展示欄が `0.00`、進入欄なし、ST欄が `K .` の行を選手行として保持します。
- 例: `K1  5 5275 松田淳平 28 12  0.00       K .        .  .`
- 保存値は `course = null`, `st = null`, `result_status = SCRATCHED`, `average_st_eligible = false` です。
- `boat_no`, `regno`, `racer_name`, `motor_no`, `boat_motor_no` は保持します。
- STEP3Jの洗い出しworkflowは維持しています。

## 安全性
- 対象は staging 用K票バックフィルスクリプトのみです。
- 本番 `race_results`、`paid_users`、Stripe、Googleログイン、認証・販売まわりは触っていません。
- まず `dry=true` で確認してください。
