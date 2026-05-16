#Requires -Version 5.1
<#
  Сборка RAG-индекса на удалённой машине (после corpus_extract_text).

  .\run-rag-index.ps1
  .\run-rag-index.ps1 -EmbeddingUrl "http://127.0.0.1:8765/v1"
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$CorpusTxt = "C:\data\corpus-2025-drive-txt",
  [string]$IndexDir = "C:\data\rag-index-2025-drive",
  [string]$EmbeddingUrl = "http://127.0.0.1:8765/v1",
  [string]$EmbeddingApiKey = "sk-local",
  [string]$EmbeddingModel = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $CorpusTxt)) {
  throw "Нет корпуса: $CorpusTxt — сначала corpus-pull и corpus_extract_text"
}

$env:LENA_EMBEDDING_BASE_URL = $EmbeddingUrl
$env:LENA_EMBEDDING_API_KEY = $EmbeddingApiKey
$env:LENA_EMBEDDING_MODEL = $EmbeddingModel

$envFile = Join-Path $PSScriptRoot "env.remote-worker.local"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
      Set-Item -Path "Env:$($matches[1].Trim())" -Value $matches[2].Trim()
    }
  }
}

Write-Host "rag index: $CorpusTxt -> $IndexDir"
Set-Location $RepoRoot
node src/cli.js rag index $CorpusTxt $IndexDir
