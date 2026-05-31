#Requires -Version 5.1
<#
  Установка Chromium Playwright в общий каталог (служба Windows / SYSTEM).
  Запуск от администратора из корня репозитория:

    cd C:\tender-prep\scripts\lena-server
    .\fix-playwright-server.ps1

  Добавляет/обновляет LENA_PLAYWRIGHT_BROWSERS_PATH в .env и ставит chromium в C:\ProgramData\ms-playwright
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$BrowsersPath = "C:\ProgramData\ms-playwright"
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not in PATH."
}

New-Item -ItemType Directory -Force -Path $BrowsersPath | Out-Null
Write-Host "PLAYWRIGHT_BROWSERS_PATH=$BrowsersPath"
$env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersPath

Write-Host "npm install (playwright)..."
npm install 2>$null
if ($LASTEXITCODE -ne 0) { npm install }

Write-Host "npx playwright install chromium..."
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { throw "playwright install failed" }

$envFile = Join-Path $RepoRoot ".env"
$key = "LENA_PLAYWRIGHT_BROWSERS_PATH"
$line = "$key=$BrowsersPath"
if (Test-Path $envFile) {
  $raw = Get-Content $envFile -Raw -Encoding UTF8
  if ($raw -match "(?m)^$key=") {
    $raw = [regex]::Replace($raw, "(?m)^$key=.*", $line)
  } else {
    $raw = $raw.TrimEnd() + "`r`n`r`n# Playwright (общий каталог для службы)`r`n$line`r`n"
  }
  Set-Content -Path $envFile -Value $raw -Encoding UTF8 -NoNewline
  Write-Host "Updated $envFile"
} else {
  Write-Host "No .env — add manually: $line"
}

Write-Host ""
Write-Host "Done. Restart bot/service:"
Write-Host "  Restart-Service tender-prep-lena"
Write-Host "  or: lena-bot.bat service-restart"
