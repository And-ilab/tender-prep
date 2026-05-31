#Requires -Version 5.1
param(
  [switch]$ClearWebhook,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Continue"
$script:LenaBotCmdNeedle = "lena-bot.mjs"

function Test-IsLenaBotNodeProcess {
  param([string]$CommandLine)
  return ($CommandLine -and $CommandLine -like "*$script:LenaBotCmdNeedle*")
}

function Stop-LenaBotNodeProcesses {
  $stopped = [System.Collections.Generic.HashSet[int]]::new()
  for ($round = 0; $round -lt 12; $round++) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-IsLenaBotNodeProcess $_.CommandLine })
    if (-not $procs -or $procs.Count -eq 0) { break }
    foreach ($p in $procs) {
      $procId = [int]$p.ProcessId
      if ($stopped.Contains($procId)) { continue }
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        [void]$stopped.Add($procId)
        Write-Host "Stopped node PID $procId"
      } catch {
        Write-Host "WARN: could not stop PID $procId (run PowerShell as Administrator)"
      }
    }
    Start-Sleep -Milliseconds 800
  }
  return $stopped.Count
}

function Stop-LenaWindowsService {
  $name = "tender-prep-lena"
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }
  if ($svc.Status -eq "Running" -or $svc.Status -eq "StartPending") {
    Write-Host "Stopping service $name..."
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Milliseconds 400
      $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
      if ($svc.Status -eq "Stopped") { break }
    }
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
    Where-Object { Test-IsLenaBotNodeProcess $_.CommandLine }
  return ($null -ne $left -and @($left).Count -gt 0)
}

if ($ClearWebhook) { Clear-TelegramWebhook }

$svcStopped = Stop-LenaWindowsService
Start-Sleep -Seconds 1
$n = Stop-LenaBotNodeProcesses
Start-Sleep -Milliseconds 500

if ($ClearWebhook) { Clear-TelegramWebhook }
if ($n -eq 0 -and -not $svcStopped) {
  Write-Host "No lena-bot.mjs node processes found."
}

if (Test-LenaBotStillRunning) {
  Write-Host "WARN: lena-bot still running after stop."
  exit 2
}

exit 0
