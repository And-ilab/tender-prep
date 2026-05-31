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
