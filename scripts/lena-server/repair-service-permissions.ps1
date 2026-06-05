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

$ErrorActionPreference = "Continue"

function Grant-Read {
  param([string]$Path, [string]$Rights = "RX")
  if (-not $Path) { return }
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "SKIP (not found): $Path"
    return
  }
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer) {
    icacls $Path /grant "SYSTEM:(OI)(CI)$Rights" /T 2>$null | Out-Null
  } else {
    icacls $Path /grant "SYSTEM:R" 2>$null | Out-Null
    $parent = Split-Path -Parent $Path
    if ($parent -and (Test-Path -LiteralPath $parent)) {
      icacls $parent /grant "SYSTEM:(OI)(CI)RX" 2>$null | Out-Null
    }
  }
  Write-Host "SYSTEM -> $Path"
}

function Read-EnvFilePaths {
  param([string]$EnvPath)
  $paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  if (-not (Test-Path -LiteralPath $EnvPath)) { return @() }
  foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -le 0) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $val = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if (-not $val) { continue }
    if ($key -match '^(GOOGLE_DRIVE_|LENA_ICETRADE_PLAYWRIGHT_STORAGE|LENA_PYTHON|LENA_RAG_INDEX_DIR|LENA_OCR_TESSERACT)') {
      if ($val -match '^[A-Za-z]:\\') { [void]$paths.Add($val) }
    }
  }
  return @($paths)
}

function Remove-EnvUtf8Bom {
  param([string]$EnvPath)
  if (-not (Test-Path -LiteralPath $EnvPath)) { return }
  $bytes = [System.IO.File]::ReadAllBytes($EnvPath)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Write-Host "Remove UTF-8 BOM from .env"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $text = $utf8NoBom.GetString($bytes, 3, $bytes.Length - 3)
    [System.IO.File]::WriteAllText($EnvPath, $text, $utf8NoBom)
  }
}

Write-Host "=== repair-service-permissions ==="
$envFile = Join-Path $RepoRoot ".env"
Remove-EnvUtf8Bom -EnvPath $envFile
Grant-Read -Path $envFile -Rights "R"
Grant-Read -Path $RepoRoot
$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Grant-Read -Path $logDir -Rights "M"
Grant-Read -Path $SecretsDir
Grant-Read -Path (Join-Path $RepoRoot ".venv")
Grant-Read -Path "C:\ProgramData\ms-playwright"
Grant-Read -Path "C:\data\playwright-downloads" -Rights "M"

foreach ($p in (Read-EnvFilePaths -EnvPath $envFile)) {
  Grant-Read -Path $p -Rights "R"
}

$nssm = $null
foreach ($c in @(
  (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "C:\tools\nssm\nssm.exe"
)) {
  if ($c -and (Test-Path $c)) { $nssm = $c; break }
}
if ($nssm -and (Get-Service -Name "tender-prep-lena" -ErrorAction SilentlyContinue)) {
  Write-Host "Clear NSSM AppEnvironmentExtra (optional)..."
  try {
    & $nssm set tender-prep-lena AppEnvironmentExtra "" 2>&1 | Out-Null
  } catch {
    Write-Host "WARN: nssm AppEnvironmentExtra clear skipped"
  }
}

Write-Host "Done. Restart: lena-bot.bat or Restart-Service tender-prep-lena"
