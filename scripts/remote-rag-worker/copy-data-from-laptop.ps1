#Requires -Version 5.1
<#
  Запуск на НОУТБУКЕ: копирование уже собранных данных на удалённый сервер.

  .\copy-data-from-laptop.ps1 -RemoteHost 192.168.1.50 -RemoteUser Administrator
#>
param(
  [Parameter(Mandatory = $true)][string]$RemoteHost,
  [string]$RemoteUser = $env:USERNAME,
  [string]$RemoteShare = "\\$RemoteHost\C$\data",
  [string]$LocalData = "C:\data"
)

$ErrorActionPreference = "Stop"
$dirs = @(
  "corpus-2025-drive-pull",
  "corpus-2025-drive-txt",
  "rag-index-2025-drive"
)
foreach ($d in $dirs) {
  $src = Join-Path $LocalData $d
  if (-not (Test-Path $src)) {
    Write-Warning "Пропуск (нет на ноутбуке): $src"
    continue
  }
  $dst = Join-Path $RemoteShare $d
  Write-Host "robocopy $src -> $dst"
  robocopy $src $dst /E /Z /R:2 /W:5 /MT:8 /NFL /NDL /NP
}
Write-Host "Готово. На сервере проверьте C:\data\ и запустите start-embeddings + run-rag-index при необходимости."
