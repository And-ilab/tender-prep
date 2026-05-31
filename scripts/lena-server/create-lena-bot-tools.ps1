#Requires -Version 5.1
<#
  Creates lena-bot-stop.ps1, restart-lena-service.bat, stop-lena-service.bat on the server.

  Run once (PowerShell, from repo root or lena-server folder):
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\tender-prep\scripts\lena-server\create-lena-bot-tools.ps1

  Optional: -RestartService after files are written.
#>
param([switch]$RestartService)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$dir = (Resolve-Path $here).Path

$stopPath = Join-Path $dir "lena-bot-stop.ps1"
$restartBat = Join-Path $dir "restart-lena-service.bat"
$stopBat = Join-Path $dir "stop-lena-service.bat"

$lenaBotStop = @'
#Requires -Version 5.1
param(
  [switch]$ClearWebhook,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Continue"

function Stop-LenaBotNodeProcesses {
  $stopped = [System.Collections.Generic.HashSet[int]]::new()
  for ($round = 0; $round -lt 8; $round++) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'lena-bot\.mjs' })
    if (-not $procs -or $procs.Count -eq 0) { break }
    foreach ($p in $procs) {
      $procId = [int]$p.ProcessId
      if ($stopped.Contains($procId)) { continue }
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        [void]$stopped.Add($procId)
        Write-Host "Stopped PID $procId"
      } catch {
        Write-Host "WARN: could not stop PID $procId"
      }
    }
    Start-Sleep -Milliseconds 600
  }
  return $stopped.Count
}

function Stop-LenaWindowsService {
  $name = "tender-prep-lena"
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }
  if ($svc.Status -eq "Running") {
    Write-Host "Stopping service $name..."
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    return $true
  }
  return $false
}

function Read-TelegramBotTokenFromEnv {
  $envPath = Join-Path $RepoRoot ".env"
  if (-not (Test-Path $envPath)) { return $null }
  foreach ($line in Get-Content $envPath -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $n, $v = $line -split '=', 2
    if ($n.Trim() -eq "TELEGRAM_BOT_TOKEN") {
      $t = $v.Trim().Trim('"').Trim("'")
      if ($t) { return $t }
    }
  }
  return $null
}

function Clear-TelegramWebhook {
  $token = $env:TELEGRAM_BOT_TOKEN
  if (-not $token) { $token = Read-TelegramBotTokenFromEnv }
  if (-not $token) {
    Write-Host "WARN: TELEGRAM_BOT_TOKEN not found, skip deleteWebhook"
    return
  }
  try {
    $uri = "https://api.telegram.org/bot$token/deleteWebhook?drop_pending_updates=true"
    $r = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 15
    if ($r.ok) { Write-Host "Telegram deleteWebhook: ok" }
    else { Write-Host "Telegram deleteWebhook: failed" }
  } catch {
    Write-Host "WARN: deleteWebhook error: $($_.Exception.Message)"
  }
}

function Test-LenaBotStillRunning {
  $left = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'lena-bot\.mjs' }
  return ($null -ne $left -and @($left).Count -gt 0)
}

$svcStopped = Stop-LenaWindowsService
$n = Stop-LenaBotNodeProcesses
if ($n -eq 0 -and -not $svcStopped) {
  Write-Host "No lena-bot.mjs node processes found."
}

if (Test-LenaBotStillRunning) {
  Write-Host "WARN: lena-bot still running after stop."
  exit 2
}

if ($ClearWebhook) { Clear-TelegramWebhook }
exit 0
'@

$restartBatContent = @'
@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."
echo Repo: %CD%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lena-bot-stop.ps1" -ClearWebhook -RepoRoot "%CD%"
if errorlevel 2 goto FAIL_STOP
echo.
echo Wait 4 sec...
timeout /t 4 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "Restart-Service -Name 'tender-prep-lena' -Force -ErrorAction Stop; Write-Host 'OK: Restart-Service tender-prep-lena'"
if errorlevel 1 goto FAIL_SVC
echo.
echo Logs: %CD%\logs\lena-bot.log
pause
exit /b 0

:FAIL_STOP
echo.
echo ERROR: could not stop all lena-bot processes.
pause
exit /b 2

:FAIL_SVC
echo.
echo ERROR: service tender-prep-lena not found or could not restart.
echo Run: scripts\lena-server\install-service-nssm.ps1
pause
exit /b 1
'@

$stopBatContent = @'
@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."
echo Repo: %CD%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lena-bot-stop.ps1" -RepoRoot "%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Service -Name 'tender-prep-lena' -Force -ErrorAction SilentlyContinue"
echo Done.
pause
exit /b 0
'@

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($stopPath, $lenaBotStop.TrimEnd() + "`r`n", $utf8NoBom)
[System.IO.File]::WriteAllText($restartBat, $restartBatContent.TrimEnd() + "`r`n", [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText($stopBat, $stopBatContent.TrimEnd() + "`r`n", [System.Text.Encoding]::ASCII)

Write-Host "Created:"
Write-Host "  $stopPath"
Write-Host "  $restartBat"
Write-Host "  $stopBat"

if ($RestartService) {
  $repoRoot = (Resolve-Path (Join-Path $dir "..\..")).Path
  & $stopPath -ClearWebhook -RepoRoot $repoRoot
  if ($LASTEXITCODE -eq 2) { throw "lena-bot still running" }
  Start-Sleep -Seconds 4
  Restart-Service tender-prep-lena -Force
  Write-Host "OK: Restart-Service tender-prep-lena"
}
