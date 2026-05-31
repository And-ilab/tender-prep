#Requires -Version 5.1
<#
  Idempotent: Chromium Playwright в C:\ProgramData\ms-playwright для службы SYSTEM.
  Вызывается из lena-bot.bat после git pull / npm install.

  .\ensure-playwright-server.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$BrowsersPath = "C:\ProgramData\ms-playwright",
  [string]$DownloadsPath = "C:\data\playwright-downloads"
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

function Test-ChromiumInPath {
  param([string]$Base)
  if (-not (Test-Path $Base)) { return $false }
  $found = Get-ChildItem -Path $Base -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("chrome-headless-shell.exe", "chrome.exe") } |
    Select-Object -First 1
  return [bool]$found
}

New-Item -ItemType Directory -Force -Path $BrowsersPath, $DownloadsPath | Out-Null

$needInstall = -not (Test-ChromiumInPath -Base $BrowsersPath)
if ($needInstall) {
  Write-Host "Playwright Chromium not found in $BrowsersPath - installing..."
  $env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersPath
  npm install 2>$null
  if ($LASTEXITCODE -ne 0) { npm install }
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "npx playwright install chromium failed ($LASTEXITCODE)" }
} else {
  Write-Host "Playwright Chromium OK: $BrowsersPath"
}

# Служба tender-prep-lena (LocalSystem) должна читать браузер и писать загрузки.
foreach ($pair in @(
  @{ Path = $BrowsersPath; Rights = "(OI)(CI)RX" },
  @{ Path = $DownloadsPath; Rights = "(OI)(CI)M" }
)) {
  $p = $pair.Path
  if (Test-Path $p) {
    icacls $p /grant "SYSTEM:$($pair.Rights)" /T 2>$null | Out-Null
  }
}

function Set-EnvLine {
  param([string]$File, [string]$Key, [string]$Value)
  if (-not (Test-Path $File)) { return }
  $line = "$Key=$Value"
  $raw = Get-Content $File -Raw -Encoding UTF8
  if ($raw -match "(?m)^$([regex]::Escape($Key))=") {
    $raw = [regex]::Replace($raw, "(?m)^$([regex]::Escape($Key))=.*", $line)
  } else {
    $raw = $raw.TrimEnd() + "`r`n$line`r`n"
  }
  Set-Content -Path $File -Value $raw -Encoding UTF8 -NoNewline
}

$envFile = Join-Path $RepoRoot ".env"
if (Test-Path $envFile) {
  Set-EnvLine -File $envFile -Key "LENA_PLAYWRIGHT_BROWSERS_PATH" -Value $BrowsersPath
  $raw = Get-Content $envFile -Raw -Encoding UTF8
  if ($raw -notmatch "(?m)^LENA_ICETRADE_PLAYWRIGHT=") {
    Set-EnvLine -File $envFile -Key "LENA_ICETRADE_PLAYWRIGHT" -Value "1"
  }
  if ($raw -notmatch "(?m)^LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR=") {
    Set-EnvLine -File $envFile -Key "LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR" -Value $DownloadsPath
  }
  Write-Host "Updated .env (Playwright paths)"
}

exit 0
