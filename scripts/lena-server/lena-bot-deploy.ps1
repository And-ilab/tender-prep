#Requires -Version 5.1
<#
  PowerShell-эквивалент lena-bot.bat: deploy + restart службы.
  Запуск от администратора:

  cd C:\tender-prep
  .\scripts\lena-server\lena-bot-deploy.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
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

Set-Location $RepoRoot
Write-Host "=== tender-prep: deploy + service restart (PowerShell) ==="

$gitSync = Join-Path $PSScriptRoot "git-sync-main.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $gitSync -RepoRoot $RepoRoot
$gitEc = $LASTEXITCODE
if ($gitEc -ne 0 -and $gitEc -ne 10) {
  throw "git-sync-main failed ($gitEc)"
}
if ($gitEc -eq 10) {
  Write-Host "=== npm install ==="
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
}

$playwright = Join-Path $PSScriptRoot "ensure-playwright-server.ps1"
Write-Host "=== Playwright Chromium (SYSTEM) ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $playwright -RepoRoot $RepoRoot
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARN: ensure-playwright-server.ps1 — see output above"
}

$repair = Join-Path $PSScriptRoot "repair-service-permissions.ps1"
Write-Host "=== Права SYSTEM на .env и секреты ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $repair -RepoRoot $RepoRoot

$restart = Join-Path $PSScriptRoot "lena-bot-service-restart.ps1"
Write-Host "=== Перезапуск Лены ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $restart -RepoRoot $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "service restart failed ($LASTEXITCODE)" }

Write-Host ""
Write-Host "Готово. Проверка: .\scripts\lena-server\verify-lena-server.ps1"
