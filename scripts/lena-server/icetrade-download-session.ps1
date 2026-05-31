#Requires -Version 5.1
<#
  Пакетное скачивание вложений IceTrade: одна WebSession, сначала карточка, затем getFile.
  Вызов из Node (bootstrap) или вручную для проверки:

    powershell -NoProfile -ExecutionPolicy Bypass -File icetrade-download-session.ps1 -ManifestPath C:\temp\manifest.json

  manifest.json:
  {
    "cardPageUrl": "https://icetrade.by/tenders/all/view/1341204",
    "outDir": "C:\\temp\\dl",
    "timeoutSec": 60,
    "userAgent": "...",
    "cookie": "optional",
    "items": [ { "id": "0", "url": "https://icetrade.by/auction/getFile/...", "fileName": "doc.pdf" } ]
  }
#>
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not (Test-Path $ManifestPath)) {
  Write-Error "Manifest not found: $ManifestPath"
}

$j = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$outDir = [string]$j.outDir
$card = [string]$j.cardPageUrl
$sec = [int]($j.timeoutSec)
if ($sec -lt 5) { $sec = 60 }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$warm = @{}
if ($j.userAgent) { $warm["User-Agent"] = [string]$j.userAgent }
$warm["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
if ($j.cookie) { $warm["Cookie"] = [string]$j.cookie }

try {
  Invoke-WebRequest -Uri $card -WebSession $session -UseBasicParsing -TimeoutSec $sec -Headers $warm | Out-Null
} catch {
  # прогрев необязателен
}

$results = @()
foreach ($item in $j.items) {
  $id = [string]$item.id
  $url = [string]$item.url
  $name = [string]$item.fileName
  $outPath = Join-Path $outDir $name
  $row = [ordered]@{ id = $id; ok = $false; path = $outPath; bytes = 0; error = $null }
  try {
    $fh = @{}
    if ($j.userAgent) { $fh["User-Agent"] = [string]$j.userAgent }
    $fh["Referer"] = $card
    $fh["Accept"] = "*/*"
    if ($j.cookie) { $fh["Cookie"] = [string]$j.cookie }
    Invoke-WebRequest -Uri $url -WebSession $session -OutFile $outPath -UseBasicParsing -TimeoutSec $sec -Headers $fh
    if (Test-Path $outPath) {
      $row.bytes = (Get-Item $outPath).Length
      $row.ok = $true
    } else {
      $row.error = "empty output"
    }
  } catch {
    $row.error = $_.Exception.Message
  }
  $results += [pscustomobject]$row
}

$results | ConvertTo-Json -Compress -Depth 4
