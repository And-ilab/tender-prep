#Requires -Version 5.1
param([string]$RepoRoot = (Get-Location).Path)

$ErrorActionPreference = "Stop"
$name = "tender-prep-lena"
$stopScript = Join-Path $PSScriptRoot "lena-bot-stop.ps1"

Write-Host "=== Stop lena-bot (service + stray node) ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript -ClearWebhook -RepoRoot $RepoRoot
if ($LASTEXITCODE -eq 2) {
  Write-Host "ERROR: could not stop all lena-bot node processes."
  exit 2
}
Start-Sleep -Seconds 4

$s = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $s) {
  Write-Host "Service $name not found. Run install-service-nssm.ps1"
  exit 1
}

Write-Host "=== Start service $name ==="
if ($s.Status -eq "Running") {
  Restart-Service -Name $name -Force
} else {
  Start-Service -Name $name
}
Start-Sleep -Seconds 3
$s2 = Get-Service -Name $name
Write-Host ("OK: {0} -> {1}" -f $name, $s2.Status)

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
