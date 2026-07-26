# Windowsタスクスケジューラ副系

GitHub Actionsとは別に、自宅Windows PCで5分ごとに `pipeline/capture_all_active_races.mjs` を実行します。
ブラウザを開く必要はありません。GitHubと同時実行されても、既存の同一レース保存方式により重複行を増やさない前提です。

## 必要条件

- Windows 10 / 11
- Node.js 22
- PCが起動し、Windowsへログイン中
- スリープしていないこと

## セットアップ

1. GitHubへこの差分を反映する。
2. Windowsでリポジトリを開く。
3. `windows/setup_windows_backup.ps1` を右クリックし、「PowerShellで実行」を選ぶ。
4. 次を順番に入力する。
   - 本番URL
   - GitHub Secretsと同じ `CAPTURE_TOKEN`
   - `AUTOMATION_AUTH_SESSION_JSON`
5. 最後に自動テストが走る。

PowerShellの実行がブロックされる場合は、リポジトリのフォルダでPowerShellを開き、次を実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup_windows_backup.ps1
```

## 自動実行

- 5分間隔
- JST 07:00〜翌00:59のみ本処理を実行
- 前の処理が残っている場合は次を重ねない
- ログは `%LOCALAPPDATA%\HunakenAcademia\logs` に保存
- 14日より古いログは自動削除

## 確認

Windows検索で「タスク スケジューラ」を開きます。

`タスク スケジューラ ライブラリ` → `HunakenAcademia-CaptureBackup`

「最終実行結果」が `0x0` なら成功です。

手動テスト：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\run_windows_backup.ps1 -Force
```

## 重要

PCが電源OFF、スリープ、ネット切断中の場合はWindows副系も実行されません。GitHub Actionsはその間も主系として動きます。

削除する場合：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\uninstall_windows_backup.ps1
```
