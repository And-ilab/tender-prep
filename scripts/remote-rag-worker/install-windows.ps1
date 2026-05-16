#Requires -Version 5.1
<#
  Установка зависимостей на Windows-сервере (всегда включён).
  Запуск от администратора не обязателен; Node.js должен быть в PATH.

  .\install-windows.ps1 -RepoRoot C:\tender-prep
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

Write-Host "Repo: $RepoRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js не найден в PATH. Установите LTS с https://nodejs.org/"
}

$py = $null
foreach ($c in @(
  "$RepoRoot\.venv\Scripts\python.exe",
  "$env:LOCALAPPDATA\Python\pythoncore-3.14-64\python.exe",
  "$env:LOCALAPPDATA\Python\bin\python.exe"
)) {
  if (Test-Path $c) { $py = $c; break }
}
if (-not $py) {
  $found = Get-Command python -ErrorAction SilentlyContinue
  if ($found) { $py = $found.Source }
}
if (-not $py) {
  throw "Python не найден. Создайте .venv: python -m venv .venv"
}

if (-not (Test-Path "$RepoRoot\.venv\Scripts\python.exe")) {
  Write-Host "Создаю .venv…"
  & $py -m venv "$RepoRoot\.venv"
  $py = "$RepoRoot\.venv\Scripts\python.exe"
}

Write-Host "Python: $py"
& $py -m pip install -U pip
& $py -m pip install -r "$RepoRoot\scripts\local_openai_embeddings\requirements.txt"
& $py -m pip install -r "$RepoRoot\scripts\corpus_extract_text\requirements.txt"

if (Test-Path "$RepoRoot\package.json") {
  Write-Host "npm install (tender-prep CLI)…"
  Push-Location $RepoRoot
  npm install --omit=dev 2>$null
  if ($LASTEXITCODE -ne 0) { npm install }
  Pop-Location
}

New-Item -ItemType Directory -Force -Path "C:\data" | Out-Null
Write-Host "Готово. Дальше: скопируйте данные в C:\data и запустите start-embeddings.ps1"
