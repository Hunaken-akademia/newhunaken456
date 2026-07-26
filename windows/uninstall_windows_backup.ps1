$TaskName = "HunakenAcademia-CaptureBackup"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "$TaskName を削除しました。設定・ログは $env:LOCALAPPDATA\HunakenAcademia に残しています。"
