#Requires -Version 5.1
<#
  Скачивает готовый nssm.exe (win64) — официальный nssm.cc часто недоступен.
  .\download-nssm.ps1
  .\download-nssm.ps1 -DestDir C:\tools\nssm
#>
param(
  [string]$DestDir = "C:\tools\nssm"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$uri = "https://raw.githubusercontent.com/dkxce/NSSM/main/bin/v2.25/win64/nssm.exe"
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$dest = Join-Path $DestDir "nssm.exe"

Write-Host "Скачиваю $uri"
Write-Host "       -> $dest"

try {
  Invoke-WebRequest -Uri $uri -OutFile $dest -UseBasicParsing
} catch {
  Write-Warning "Invoke-WebRequest не удался: $($_.Exception.Message)"
  Write-Host "Пробую curl.exe…"
  curl.exe -fsSL -o $dest $uri
}

if (-not (Test-Path $dest)) {
  throw "Файл не создан. Скачайте вручную на ноуте и скопируйте на сервер:`n$uri"
}

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($machinePath -notlike "*$DestDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$machinePath;$DestDir", "Machine")
  Write-Host "PATH обновлён. Закройте PowerShell и откройте новое окно."
}

Write-Host "OK: $dest"
& $dest
