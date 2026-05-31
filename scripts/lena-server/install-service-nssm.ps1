#Requires -Version 5.1
<#
  Windows service (NSSM) for Lena Telegram bot.

  Run as Administrator:
    cd C:\tender-prep\scripts\lena-server
    .\install-service-nssm.ps1

  Remove: nssm remove tender-prep-lena confirm
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$ServiceName = "tender-prep-lena",
  [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  throw "Run PowerShell as Administrator."
}

$node = (Get-Command node -ErrorAction Stop).Source
$botScript = Join-Path $RepoRoot "src\telegram\lena-bot.mjs"
$envFile = Join-Path $RepoRoot ".env"
$logDir = Join-Path $RepoRoot "logs"

if (-not (Test-Path $botScript)) {
  throw "Not found: $botScript (check -RepoRoot)."
}
if (-not (Test-Path $envFile)) {
  Write-Warning ".env not found: $envFile"
}

$nssm = $NssmPath
if (-not $nssm) {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $nssm = $cmd.Source }
}
if (-not $nssm -or -not (Test-Path $nssm)) {
  throw "NSSM not found. Put nssm.exe in PATH or use -NssmPath C:\tools\nssm\nssm.exe"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$envFile = Join-Path $RepoRoot ".env"
if (Test-Path $envFile) {
  icacls $envFile /grant "SYSTEM:R" 2>$null | Out-Null
}
if (Test-Path "C:\secrets\tender-prep") {
  icacls "C:\secrets\tender-prep" /grant "SYSTEM:(OI)(CI)RX" /T 2>$null | Out-Null
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping existing service $ServiceName..."
  & $nssm stop $ServiceName 2>$null
  Start-Sleep -Seconds 2
  & $nssm remove $ServiceName confirm
  Start-Sleep -Seconds 1
}

Write-Host "Installing service $ServiceName"
Write-Host "  Node:   $node"
Write-Host "  Script: $botScript"
Write-Host "  CWD:    $RepoRoot"

& $nssm install $ServiceName $node $botScript
& $nssm set $ServiceName AppDirectory $RepoRoot
& $nssm set $ServiceName DisplayName "tender-prep Lena Telegram bot"
& $nssm set $ServiceName Description "Telegram bot Lena (Google Drive, IceTrade, LLM)"
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppThrottle 5000
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 15000
& $nssm set $ServiceName AppStdout (Join-Path $logDir "lena-bot.log")
& $nssm set $ServiceName AppStderr (Join-Path $logDir "lena-bot.err.log")
& $nssm set $ServiceName AppStdoutCreationDisposition 4
& $nssm set $ServiceName AppStderrCreationDisposition 4
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760

& $nssm start $ServiceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "OK: service $ServiceName is Running."
} else {
  Write-Warning "Service installed but not Running. See $logDir\lena-bot.err.log"
}

Write-Host ""
Write-Host "Next:"
Write-Host "  Get-Service $ServiceName"
Write-Host "  Get-Content $logDir\lena-bot.err.log -Tail 30"
