#Requires -Version 5.1
param([string]$RepoRoot = (Get-Location).Path)

$ErrorActionPreference = "Continue"
$name = "tender-prep-lena"
$stopScript = Join-Path $PSScriptRoot "lena-bot-stop.ps1"
$logDir = Join-Path $RepoRoot "logs"
$errLog = Join-Path $logDir "lena-bot.err.log"
$outLog = Join-Path $logDir "lena-bot.log"

function Find-Nssm {
  foreach ($c in @(
    (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "C:\tools\nssm\nssm.exe"
  )) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Show-LogTail {
  param([string]$Path, [int]$Lines = 25)
  if (-not (Test-Path $Path)) {
    Write-Host "  (no file: $Path)"
    return
  }
  Write-Host "--- tail $Path ---"
  Get-Content $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

function Start-LenaServiceRobust {
  param([string]$ServiceName, [string]$NssmExe)
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }

  if ($svc.Status -eq "Running") {
    try {
      Restart-Service -Name $ServiceName -Force -ErrorAction Stop
    } catch {
      Write-Host "Restart-Service failed: $($_.Exception.Message)"
      if ($NssmExe) {
        & $NssmExe restart $ServiceName 2>&1 | ForEach-Object { Write-Host $_ }
      }
    }
  } else {
    if ($NssmExe) {
      Write-Host "nssm start $ServiceName ..."
      & $NssmExe start $ServiceName 2>&1 | ForEach-Object { Write-Host $_ }
    }
    if ((Get-Service -Name $ServiceName).Status -ne "Running") {
      try {
        Start-Service -Name $ServiceName -ErrorAction Stop
      } catch {
        Write-Host "Start-Service failed: $($_.Exception.Message)"
      }
    }
  }

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($s -and $s.Status -eq "Running") { return $true }
  }
  return $false
}

Write-Host "=== Stop lena-bot (service + stray node) ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript -ClearWebhook -RepoRoot $RepoRoot
if ($LASTEXITCODE -eq 2) {
  Write-Host "ERROR: could not stop all lena-bot node processes."
  exit 2
}
Start-Sleep -Seconds 4

$s = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $s) {
  Write-Host "Service $name not found."
  Write-Host "Run as Administrator:"
  Write-Host "  cd $RepoRoot\scripts\lena-server"
  Write-Host "  .\install-service-nssm.ps1"
  exit 1
}

$nssm = Find-Nssm
if ($nssm) {
  $st = & $nssm status $name 2>&1
  Write-Host "nssm status before start: $st"
}

Write-Host "=== Start service $name ==="
$ok = Start-LenaServiceRobust -ServiceName $name -NssmExe $nssm
$s2 = Get-Service -Name $name -ErrorAction SilentlyContinue
Write-Host ("Service status: {0}" -f $(if ($s2) { $s2.Status } else { "unknown" }))

if (-not $ok) {
  Write-Host ""
  Write-Host "ERROR: service did not reach Running state."
  if ($nssm) {
    $st2 = & $nssm status $name 2>&1
    Write-Host "nssm status: $st2"
  }
  Show-LogTail -Path $errLog
  Show-LogTail -Path $outLog
  Write-Host ""
  Write-Host "Try: cd $RepoRoot\scripts\lena-server; .\install-service-nssm.ps1"
  Write-Host "Or: .\diagnose-windows.ps1"
  exit 1
}

Write-Host ("OK: {0} -> Running" -f $name)

$dup = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*lena-bot.mjs*" })
if ($dup.Count -gt 1) {
  Write-Host "WARN: multiple node lena-bot processes - Telegram Conflict possible"
  exit 3
}
if ($dup.Count -eq 1) {
  Write-Host ("node PID: {0}" -f $dup[0].ProcessId)
}
exit 0
