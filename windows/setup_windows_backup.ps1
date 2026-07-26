$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskRoot = Join-Path $env:LOCALAPPDATA "HunakenAcademia"
$ConfigPath = Join-Path $TaskRoot "automation.json"
$RunnerPath = Join-Path $PSScriptRoot "run_windows_backup.ps1"
$TaskName = "HunakenAcademia-CaptureBackup"

Write-Host "舟券アカデミア Windows副系セットアップ" -ForegroundColor Cyan
Write-Host "このPCが起動・ログイン中の間、5分ごとに自動処理します。" -ForegroundColor Gray

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.jsが見つかりません。Node.js 22をインストールしてから再実行してください。"
}

New-Item -ItemType Directory -Force -Path $TaskRoot | Out-Null

$defaultUrl = "https://newhunaken456.vercel.app"
$appUrl = Read-Host "本番URL（Enterで $defaultUrl）"
if ([string]::IsNullOrWhiteSpace($appUrl)) { $appUrl = $defaultUrl }
$appUrl = $appUrl.TrimEnd('/')

$captureToken = Read-Host "GitHub Secretsと同じCAPTURE_TOKENを貼り付け"
if ([string]::IsNullOrWhiteSpace($captureToken)) { throw "CAPTURE_TOKENが空です。" }

$authJson = Read-Host "AUTOMATION_AUTH_SESSION_JSONを { から } まで貼り付け"
if ([string]::IsNullOrWhiteSpace($authJson)) { throw "AUTOMATION_AUTH_SESSION_JSONが空です。" }
try { $null = $authJson | ConvertFrom-Json } catch { throw "AUTOMATION_AUTH_SESSION_JSONがJSON形式ではありません。" }

$config = [ordered]@{
  APP_BASE_URL = $appUrl
  CAPTURE_TOKEN = $captureToken
  AUTOMATION_AUTH_SESSION_JSON = $authJson
}
$config | ConvertTo-Json -Compress | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Host "必要パッケージを準備しています..." -ForegroundColor Yellow
Push-Location $RepoRoot
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm installに失敗しました。" }
  & npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "Playwright Chromiumのインストールに失敗しました。" }
}
finally { Pop-Location }

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`"" `
  -WorkingDirectory $RepoRoot

$start = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "舟券アカデミア全場取得・AI予想保存のWindows副系（5分間隔）" `
  -Force | Out-Null

Write-Host "テスト実行します..." -ForegroundColor Yellow
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunnerPath -Force
if ($LASTEXITCODE -ne 0) {
  Write-Warning "タスク登録は完了しましたが、テスト実行でエラーが出ました。ログを確認してください。"
}

Write-Host "" 
Write-Host "セットアップ完了" -ForegroundColor Green
Write-Host "タスク名: $TaskName"
Write-Host "設定保存先: $ConfigPath"
Write-Host "ログ保存先: $(Join-Path $TaskRoot 'logs')"
Write-Host "確認: Windowsの『タスク スケジューラ』→『タスク スケジューラ ライブラリ』→ $TaskName"
Write-Host "注意: PCが電源OFFまたはスリープ中は実行されません。"
