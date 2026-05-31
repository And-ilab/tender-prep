#Requires -Version 5.1
<#
  Probe why tender-prep-lena service exits immediately.
  Run as Administrator:

    cd C:\tender-prep\scripts\lena-server
    .\probe-bot-start.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$WaitSec = 5
)

$ErrorActionPreference = "Continue"
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $node) {
  Write-Host "FAIL: node not in PATH"
  exit 1
}

$bot = Join-Path $RepoRoot "src\telegram\lena-bot.mjs"
$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$probeErr = Join-Path $logDir "probe-bot-start.err"
$probeOut = Join-Path $logDir "probe-bot-start.out"
Remove-Item $probeErr, $probeOut -ErrorAction SilentlyContinue

Write-Host "=== probe-bot-start ==="
Write-Host "Node: $node"
Write-Host "Bot:  $bot"
Write-Host "CWD:  $RepoRoot"

$p = Start-Process -FilePath $node -ArgumentList @($bot) -WorkingDirectory $RepoRoot `
  -RedirectStandardError $probeErr -RedirectStandardOutput $probeOut -PassThru -WindowStyle Hidden

Start-Sleep -Seconds $WaitSec
if (-not $p.HasExited) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Host "OK: bot process still alive after ${WaitSec}s (startup looks fine for admin user)"
  exit 0
}

Write-Host "FAIL: bot exited within ${WaitSec}s (exit code $($p.ExitCode))"
if (Test-Path $probeErr) {
  Write-Host "--- probe stderr ---"
  Get-Content $probeErr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}
if (Test-Path $probeOut) {
  Write-Host "--- probe stdout ---"
  Get-Content $probeOut -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Host $_ }
}

$errLog = Join-Path $logDir "lena-bot.err.log"
if (Test-Path $errLog) {
  Write-Host "--- lena-bot.err.log (tail) ---"
  Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

Write-Host ""
Write-Host "NSSM config:"
$nssm = $null
foreach ($c in @(
  (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "C:\tools\nssm\nssm.exe"
)) {
  if ($c -and (Test-Path $c)) { $nssm = $c; break }
}
if ($nssm) {
  foreach ($k in @("Application", "AppParameters", "AppDirectory", "AppEnvironmentExtra")) {
    $v = & $nssm get tender-prep-lena $k 2>&1
    Write-Host "  $k = $v"
  }
}

exit 1
