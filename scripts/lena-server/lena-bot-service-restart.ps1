#Requires -Version 5.1
param([string]$RepoRoot = (Get-Location).Path)

$ErrorActionPreference = "Stop"
$name = "tender-prep-lena"
$s = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $s) {
  Write-Host "Служба $name не найдена. install-service-nssm.ps1"
  exit 1
}
if ($s.Status -eq "Running") {
  Restart-Service -Name $name -Force
} else {
  Start-Service -Name $name
}
Start-Sleep -Seconds 3
$s2 = Get-Service -Name $name
Write-Host ("OK: {0} -> {1}" -f $name, $s2.Status)
$dup = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'lena-bot\.mjs' })
if ($dup.Count -gt 1) {
  Write-Host "WARN: несколько node lena-bot — Conflict возможен"
  exit 3
}
if ($dup.Count -eq 1) {
  Write-Host ("node PID: {0}" -f $dup[0].ProcessId)
}
exit 0
