param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$TaskRoot = Join-Path $env:LOCALAPPDATA "HunakenAcademia"
$ConfigPath = Join-Path $TaskRoot "automation.json"
$LogDir = Join-Path $TaskRoot "logs"
$LockPath = Join-Path $TaskRoot "capture.lock"
$RepoRoot = Split-Path -Parent $PSScriptRoot

New-Item -ItemType Directory -Force -Path $TaskRoot, $LogDir | Out-Null

# JST 07:00〜翌00:59だけ動かす。-Force指定時は時間外でも手動確認できる。
$jst = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, "Tokyo Standard Time")
$minutes = $jst.Hour * 60 + $jst.Minute
if (-not $Force -and -not ($minutes -ge 420 -or $minutes -le 59)) {
  exit 0
}

if (-not (Test-Path $ConfigPath)) {
  throw "設定ファイルがありません。先に windows/setup_windows_backup.ps1 を実行してください。"
}

# 前回処理が残っている時は二重起動しない。30分以上古いロックだけ自動解除。
if (Test-Path $LockPath) {
  $age = (Get-Date) - (Get-Item $LockPath).LastWriteTime
  if ($age.TotalMinutes -lt 30) { exit 0 }
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType File -Force -Path $LockPath | Out-Null

$stamp = $jst.ToString("yyyyMMdd-HHmmss")
$LogPath = Join-Path $LogDir "capture-$stamp.log"

try {
  $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $cfg.APP_BASE_URL -or -not $cfg.CAPTURE_TOKEN -or -not $cfg.AUTOMATION_AUTH_SESSION_JSON) {
    throw "automation.json の設定が不足しています。"
  }

  $env:APP_BASE_URL = [string]$cfg.APP_BASE_URL
  $env:CAPTURE_TOKEN = [string]$cfg.CAPTURE_TOKEN
  $env:AUTOMATION_AUTH_SESSION_JSON = [string]$cfg.AUTOMATION_AUTH_SESSION_JSON
  $env:CAPTURE_CONCURRENCY = "5"
  $env:AI_CAPTURE_CONCURRENCY = "2"
  $env:AI_SAVE_BEFORE_MINUTES = "20"
  $env:HUNAKEN_RUNNER_SOURCE = "windows-task-scheduler"

  Push-Location $RepoRoot
  try {
    "[$($jst.ToString('yyyy-MM-dd HH:mm:ss')) JST] Windows backup start" | Tee-Object -FilePath $LogPath
    & node "pipeline/capture_all_active_races.mjs" 2>&1 | Tee-Object -FilePath $LogPath -Append
    if ($LASTEXITCODE -ne 0) { throw "capture script exited with code $LASTEXITCODE" }
    "[$($jst.ToString('yyyy-MM-dd HH:mm:ss')) JST] Windows backup success" | Tee-Object -FilePath $LogPath -Append
  }
  finally {
    Pop-Location
  }
}
catch {
  "ERROR: $($_.Exception.Message)" | Tee-Object -FilePath $LogPath -Append
  exit 1
}
finally {
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
  # 14日より古いログは削除する。
  Get-ChildItem $LogDir -Filter "capture-*.log" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
