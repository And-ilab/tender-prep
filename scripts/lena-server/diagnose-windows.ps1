#Requires -Version 5.1
<#
  Diagnostika Leny na Windows Server (zapusk po RDP).

  cd C:\tender-prep\scripts\lena-server
  .\diagnose-windows.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$ServiceName = "tender-prep-lena"
)

$ErrorActionPreference = "Continue"
$fail = 0

function Ok($msg) { Write-Host "[OK]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Bad($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; $script:fail++ }

Write-Host ""
Write-Host "=== Lena server diagnostics ===" -ForegroundColor Cyan
Write-Host "Host:   $env:COMPUTERNAME"
Write-Host "User:   $env:USERNAME"
Write-Host "Repo:   $RepoRoot"
Write-Host "Time:   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

# --- Service ---
Write-Host "--- Windows service ---" -ForegroundColor Cyan
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -eq "Running") { Ok "Service $ServiceName is Running" }
  elseif ($svc.Status -eq "Paused") { Bad "Service $ServiceName is Paused (bot crashed, see err log)" }
  else { Bad "Service $ServiceName status: $($svc.Status)" }
} else {
  Bad "Service $ServiceName not found (NSSM not installed?)"
}

$nssm = $null
foreach ($c in @(
  (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "C:\tools\nssm\nssm.exe"
)) {
  if ($c -and (Test-Path $c)) { $nssm = $c; break }
}
if ($nssm) {
  $st = & $nssm status $ServiceName 2>&1
  Write-Host "       nssm status: $st"
} else {
  Warn "nssm.exe not in PATH and not at C:\tools\nssm\nssm.exe"
}

# --- Processes ---
Write-Host ""
Write-Host "--- node processes ---" -ForegroundColor Cyan
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "lena-bot\.mjs" }
if ($procs) {
  foreach ($p in $procs) {
    Write-Host "       PID $($p.ProcessId): $($p.CommandLine)"
  }
  if (@($procs).Count -gt 1) {
    Bad "Multiple lena-bot processes (Telegram Conflict likely)"
  } else {
    Ok "One lena-bot process"
  }
} else {
  if ($svc -and $svc.Status -eq "Running") {
    Warn "Service Running but no lena-bot node process visible"
  } else {
    Warn "No lena-bot node process"
  }
}

# --- Files ---
Write-Host ""
Write-Host "--- key files ---" -ForegroundColor Cyan
$checks = @(
  (Join-Path $RepoRoot ".env"),
  (Join-Path $RepoRoot "src\telegram\lena-bot.mjs"),
  (Join-Path $RepoRoot ".venv\Scripts\python.exe"),
  (Join-Path $RepoRoot "logs\lena-bot.err.log"),
  (Join-Path $RepoRoot "logs\lena-bot.log")
)
foreach ($p in $checks) {
  if (Test-Path $p) { Ok $p } else { Bad "Missing: $p" }
}

# Parse .env for OAuth paths (no secrets printed)
$envPath = Join-Path $RepoRoot ".env"
if (Test-Path $envPath) {
  Write-Host ""
  Write-Host "--- .env paths ---" -ForegroundColor Cyan
  $lines = Get-Content $envPath -ErrorAction SilentlyContinue
  foreach ($key in @(
    "GOOGLE_DRIVE_OAUTH_CLIENT",
    "GOOGLE_DRIVE_OAUTH_TOKEN",
    "GOOGLE_DRIVE_CREDENTIALS",
    "LENA_ICETRADE_PLAYWRIGHT_STORAGE",
    "LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR",
    "LENA_RAG_INDEX_DIR",
    "LENA_PYTHON",
    "LENA_OCR_TESSERACT"
  )) {
    $line = $lines | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if (-not $line) {
      Warn "$key not set in .env"
      continue
    }
    $val = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
    if ($val -and (Test-Path $val)) { Ok "$key -> exists" }
    elseif ($val) { Bad "$key -> NOT FOUND: $val" }
    else { Warn "$key is empty" }
  }
}

# --- Tools ---
Write-Host ""
Write-Host "--- tools ---" -ForegroundColor Cyan
foreach ($tool in @("node", "python", "git", "tesseract")) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue
  if ($cmd) { Ok "$tool : $($cmd.Source)" } else { Warn "$tool not in PATH" }
}

# --- Logs ---
Write-Host ""
Write-Host "--- last log lines ---" -ForegroundColor Cyan
$errLog = Join-Path $RepoRoot "logs\lena-bot.err.log"
$outLog = Join-Path $RepoRoot "logs\lena-bot.log"
if (Test-Path $errLog) {
  Write-Host "lena-bot.err.log (tail 12):" -ForegroundColor DarkGray
  Get-Content $errLog -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
  if (Select-String -Path $errLog -Pattern "Conflict" -Quiet) {
    Bad "Log contains Conflict (two bots with same token)"
  }
  if (Select-String -Path $errLog -Pattern "OAuth" -Quiet) {
    Bad "Log mentions OAuth (check secret files in C:\secrets\)"
  }
} else {
  Warn "No err log yet"
}
if (Test-Path $outLog) {
  Write-Host "lena-bot.log (tail 6):" -ForegroundColor DarkGray
  Get-Content $outLog -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
}

# --- Telegram (optional) ---
Write-Host ""
Write-Host "--- Telegram API ---" -ForegroundColor Cyan
if (Test-Path $envPath) {
  $tokLine = $lines | Where-Object { $_ -match "^\s*TELEGRAM_BOT_TOKEN\s*=" } | Select-Object -First 1
  if ($tokLine) {
    $tok = ($tokLine -split "=", 2)[1].Trim().Trim('"').Trim("'")
    if ($tok) {
      try {
        $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$tok/getMe" -TimeoutSec 15
        if ($me.ok) { Ok "Telegram getMe: @$($me.result.username)" }
        else { Bad "Telegram getMe failed: $($me.description)" }
        $wh = Invoke-RestMethod -Uri "https://api.telegram.org/bot$tok/getWebhookInfo" -TimeoutSec 15
        $url = if ($wh.result.url) { $wh.result.url } else { "(empty, long polling ok)" }
        Write-Host "       webhook: $url"
      } catch {
        Bad "Telegram API unreachable: $($_.Exception.Message)"
      }
    } else {
      Bad "TELEGRAM_BOT_TOKEN empty in .env"
    }
  } else {
    Bad "TELEGRAM_BOT_TOKEN missing in .env"
  }
}

Write-Host ""
if ($fail -eq 0) {
  Write-Host "Summary: no critical failures. Test /help in Telegram." -ForegroundColor Green
} else {
  Write-Host "Summary: $fail critical issue(s). Fix [FAIL] items above." -ForegroundColor Red
}
Write-Host ""
exit $fail
