#Requires -Version 5.1
<#
  Сервер эмбеддингов (оставить окно открытым или повесить на Планировщик / NSSM).

  .\start-embeddings.ps1
  .\start-embeddings.ps1 -ListenAll -ApiKey "your-secret"
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$ListenAll,
  [string]$ApiKey = "",
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$py = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  throw "Нет $py — сначала .\install-windows.ps1"
}

$env:LOCAL_EMBEDDINGS_PORT = "$Port"
if ($ListenAll) {
  $env:LOCAL_EMBEDDINGS_HOST = "0.0.0.0"
} else {
  $env:LOCAL_EMBEDDINGS_HOST = "127.0.0.1"
}
if ($ApiKey) {
  $env:LOCAL_EMBEDDINGS_API_KEY = $ApiKey
}
if (-not $env:LOCAL_EMBEDDINGS_MODEL) {
  $env:LOCAL_EMBEDDINGS_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
}

$envFile = Join-Path $PSScriptRoot "env.remote-worker.local"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
      $k = $matches[1].Trim()
      $v = $matches[2].Trim()
      Set-Item -Path "Env:$k" -Value $v
    }
  }
}

Write-Host "Embeddings: http://$($env:LOCAL_EMBEDDINGS_HOST):$($env:LOCAL_EMBEDDINGS_PORT) model=$($env:LOCAL_EMBEDDINGS_MODEL)"
Set-Location $RepoRoot
& $py (Join-Path $RepoRoot "scripts\local_openai_embeddings\server.py")
