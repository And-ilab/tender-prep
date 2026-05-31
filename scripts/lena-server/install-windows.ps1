#Requires -Version 5.1
<#
  Install Lena on Windows Server (always-on).
  .\install-windows.ps1 -RepoRoot C:\tender-prep
  -SkipPlaywright — skip Chromium download
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$SkipPlaywright
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot
Write-Host "Repo: $RepoRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not in PATH. Install LTS from https://nodejs.org/"
}

$py = $null
foreach ($c in @(
  "$RepoRoot\.venv\Scripts\python.exe",
  (Get-Command python -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
)) {
  if ($c -and (Test-Path $c)) { $py = $c; break }
}
if (-not $py) { throw "Python not found." }

if (-not (Test-Path "$RepoRoot\.venv\Scripts\python.exe")) {
  Write-Host "Creating .venv..."
  & $py -m venv "$RepoRoot\.venv"
  $py = "$RepoRoot\.venv\Scripts\python.exe"
}

Write-Host "Python: $py"
& $py -m pip install -U pip
& $py -m pip install -r "$RepoRoot\scripts\local_openai_embeddings\requirements.txt"
& $py -m pip install -r "$RepoRoot\scripts\corpus_extract_text\requirements.txt"
& $py -m pip install -r "$RepoRoot\requirements-ocr.txt"

Write-Host "npm install..."
npm install --omit=dev 2>$null
if ($LASTEXITCODE -ne 0) { npm install }

if (-not $SkipPlaywright) {
  Write-Host "Playwright Chromium..."
  npx playwright install chromium
}

New-Item -ItemType Directory -Force -Path "C:\data\playwright-downloads", "C:\data\rag-index" | Out-Null

$createTools = Join-Path $RepoRoot "scripts\lena-server\create-lena-bot-tools.ps1"
if (Test-Path $createTools) {
  Write-Host "Creating lena-bot-stop.ps1 and restart/stop .bat..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $createTools
}

Write-Host "Done. Copy .env from scripts\lena-server\env.lena-server.windows.example if needed, then start-lena-bot.ps1 or NSSM service."
