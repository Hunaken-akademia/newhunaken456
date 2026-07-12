# STEP3I FL no-course fix patch

## 種別
パッチ版ZIPです。STEP3Hの上に上書きしてください。

## 修正内容
- `L1` / `F1` などで、展示タイムはあるが進入欄が空欄、ST欄が `L .` / `F .` の行を選手行として保持します。
- `L .` / `F .` を誤って `0` として扱わず、必ず `st = null` にします。
- 保存値は `course = null`, `st = null`, `result_status = L/F`, `average_st_eligible = false` です。
- `K0` / `K1` 対応、`L0/L1 + 通常進入あり` 対応は維持しています。

## 安全性
- 対象は staging 用K票バックフィルスクリプトのみです。
- 本番 `race_results`、`paid_users`、Stripe、Googleログイン、認証・販売まわりは触っていません。
- まず `dry=true` で確認してください。
