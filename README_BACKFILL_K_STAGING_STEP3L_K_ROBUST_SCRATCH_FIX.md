# STEP3L K票 staging バックフィル パッチ版（K0/K1欠場行の揺れを強化）

## 種別
パッチ版です。完全版ではありません。

## 目的
2026-03-24 児島12R で残った `K1 ... 0.00 K . . .` 形式を含め、K0/K1欠場行の表記ゆれを6艇の1行として保持します。

## 安全性
- `race_results_staging` 用スクリプトのみ変更
- `race_results` 本番には書き込みません
- `paid_users`、Stripe、Googleログイン、販売・認証まわりは変更しません
- dry=true では DB_WRITE=NONE です

## 変更内容
- K0/K1 の欠場行で、展示欄が `K .` または `0.00` または全角数字の `０.００` でも拾えるようにしました。
- 保存時は `result_status=SCRATCHED`, `course=null`, `st=null`, `average_st_eligible=false` です。
