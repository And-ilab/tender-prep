#Requires -Version 5.1
<#
  Fix permissions so Windows service (LocalSystem) can read .env and secrets.
  Run as Administrator from repo root:

    .\scripts\lena-server\repair-service-permissions.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$SecretsDir = "C:\secrets\tender-prep"
)

$ErrorActionPreference = "Stop"

function Grant-Read {
  param([string]$Path, [string]$Rights = "RX")
  if (-not $Path -or -not (Test-Path $Path)) { return }
  $item = Get-Item $Path
  if ($item.PSIsContainer) {
    icacls $Path /grant "SYSTEM:(OI)(CI)$Rights" /T 2>$null | Out-Null
  } else {
    icacls $Path /grant "SYSTEM:R" 2>$null | Out-Null
  }
  Write-Host "SYSTEM -> $Path"
}

Write-Host "=== repair-service-permissions ==="
Grant-Read -Path (Join-Path $RepoRoot ".env") -Rights "R"
Grant-Read -Path $SecretsDir
Grant-Read -Path (Join-Path $RepoRoot ".venv")
Grant-Read -Path "C:\ProgramData\ms-playwright"
Grant-Read -Path "C:\data\playwright-downloads" -Rights "M"

$nssm = $null
foreach ($c in @(
  (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "C:\tools\nssm\nssm.exe"
)) {
  if ($c -and (Test-Path $c)) { $nssm = $c; break }
}
if ($nssm) {
  Write-Host "Clear NSSM AppEnvironmentExtra (use .env via AppDirectory instead)..."
  & $nssm set tender-prep-lena AppEnvironmentExtra "" 2>$null | Out-Null
}

Write-Host "Done. Restart: lena-bot.bat or Restart-Service tender-prep-lena"
