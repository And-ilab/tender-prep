#Requires -Version 5.1
<#
  Probe why tender-prep-lena service exits immediately.
  Run as Administrator:

    cd C:\tender-prep\scripts\lena-server
    .\probe-bot-start.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$WaitSec = 5
)

$ErrorActionPreference = "Continue"
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $node) {
  Write-Host "FAIL: node not in PATH"
  exit 1
}

$bot = Join-Path $RepoRoot "src\telegram\lena-bot.mjs"
$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$probeErr = Join-Path $logDir "probe-bot-start.err"
$probeOut = Join-Path $logDir "probe-bot-start.out"
Remove-Item $probeErr, $probeOut -ErrorAction SilentlyContinue

function Test-EnvFileKeys {
  param([string]$EnvPath)
  $found = @{}
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    Write-Host "WARN: .env not found at $EnvPath"
    return $found
  }
  $bytes = [System.IO.File]::ReadAllBytes($EnvPath)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Write-Host "WARN: .env has UTF-8 BOM (service may miss TELEGRAM_BOT_TOKEN on first line)"
  }
  foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -le 0) { continue }
    $key = $t.Substring(0, $eq).Trim().TrimStart([char]0xFEFF)
    $val = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($val) { $found[$key] = $true }
  }
  return $found
}

Write-Host "=== probe-bot-start ==="
Write-Host "Node: $node"
Write-Host "Bot:  $bot"
Write-Host "CWD:  $RepoRoot"

$envFile = Join-Path $RepoRoot ".env"
$fromFile = Test-EnvFileKeys -EnvPath $envFile
foreach ($k in @("TELEGRAM_BOT_TOKEN", "LENA_DRIVE_ROOT")) {
  $inFile = $fromFile.ContainsKey($k)
  $inProc = [bool]([Environment]::GetEnvironmentVariable($k, "Process"))
  $inUser = [bool]([Environment]::GetEnvironmentVariable($k, "User"))
  $inMachine = [bool]([Environment]::GetEnvironmentVariable($k, "Machine"))
  Write-Host ("  {0}: .env={1} process={2} user={3} machine={4}" -f $k, $inFile, $inProc, $inUser, $inMachine)
  if (-not $inFile -and ($inUser -or $inMachine)) {
    Write-Host "  WARN: $k only in Windows env — LocalSystem service reads .env only"
  }
}

$p = Start-Process -FilePath $node -ArgumentList @($bot) -WorkingDirectory $RepoRoot `
  -RedirectStandardError $probeErr -RedirectStandardOutput $probeOut -PassThru -WindowStyle Hidden

Start-Sleep -Seconds $WaitSec
if (-not $p.HasExited) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Host "OK: bot process still alive after ${WaitSec}s (startup looks fine for admin user)"
  exit 0
}

Write-Host "FAIL: bot exited within ${WaitSec}s (exit code $($p.ExitCode))"
if (Test-Path $probeErr) {
  Write-Host "--- probe stderr ---"
  Get-Content $probeErr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}
if (Test-Path $probeOut) {
  Write-Host "--- probe stdout ---"
  Get-Content $probeOut -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Host $_ }
}

$errLog = Join-Path $logDir "lena-bot.err.log"
if (Test-Path $errLog) {
  Write-Host "--- lena-bot.err.log (tail) ---"
  Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

Write-Host ""
Write-Host "NSSM config:"
$nssm = $null
foreach ($c in @(
  (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "C:\tools\nssm\nssm.exe"
)) {
  if ($c -and (Test-Path $c)) { $nssm = $c; break }
}
if ($nssm) {
  foreach ($k in @("Application", "AppParameters", "AppDirectory", "AppEnvironmentExtra")) {
    $v = & $nssm get tender-prep-lena $k 2>&1
    Write-Host "  $k = $v"
  }
}

exit 1
