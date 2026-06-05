#Requires -Version 5.1
<#
  Проверка после деплоя: служба, probe, хвост лога.

  cd C:\tender-prep\scripts\lena-server
  .\verify-lena-server.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$ServiceName = "tender-prep-lena"
)

$ErrorActionPreference = "Continue"
$fail = 0

Write-Host "=== verify-lena-server ==="
Write-Host "Repo: $RepoRoot"

$head = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
if ($head) { Write-Host "git HEAD: $head" }

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "FAIL: service $ServiceName not found (run install-service-nssm.ps1)"
  exit 1
}
Write-Host "Service: $($svc.Status)"
if ($svc.Status -ne "Running") { $fail = 1 }

$logPath = Join-Path $RepoRoot "logs\lena-bot.log"
$errPath = Join-Path $RepoRoot "logs\lena-bot.err.log"
if (Test-Path $logPath) {
  Write-Host "--- lena-bot.log (tail 10) ---"
  Get-Content $logPath -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "WARN: no $logPath"
}
if (Test-Path $errPath) {
  $errTail = @(Get-Content $errPath -Tail 5 -ErrorAction SilentlyContinue)
  if ($errTail.Count -gt 0) {
    Write-Host "--- lena-bot.err.log (tail 5) ---"
    $errTail | ForEach-Object { Write-Host $_ }
  }
}

$probe = Join-Path $PSScriptRoot "probe-bot-start.ps1"
Write-Host ""
Write-Host "=== probe-bot-start ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $probe -RepoRoot $RepoRoot
if ($LASTEXITCODE -ne 0) { $fail = 1 }

$dup = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*lena-bot.mjs*" })
if ($dup.Count -gt 1) {
  Write-Host "WARN: multiple lena-bot node processes ($($dup.Count)) - Telegram Conflict risk"
  $fail = 1
} elseif ($dup.Count -eq 1) {
  Write-Host "node PID: $($dup[0].ProcessId)"
}

Write-Host ""
Write-Host "Telegram: send /help - expect reply with Drive root and commands."
Write-Host "IceTrade: after import, inputs/ on Drive should list all attachments (pdf, doc, docx), not PDF only."

if ($fail -ne 0) {
  Write-Host ""
  Write-Host "FAIL: verification incomplete"
  exit 1
}
Write-Host ""
Write-Host "OK: service and probe look good"
exit 0
