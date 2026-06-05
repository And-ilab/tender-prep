#Requires -Version 5.1
<#
  Диагностика «мёртвого» бота: служба, node, логи, .env.
  Запуск от администратора:

    cd C:\tender-prep\scripts\lena-server
    .\diagnose-bot-health.ps1
#>
param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path)

$ErrorActionPreference = "Continue"
$name = "tender-prep-lena"
$logDir = Join-Path $RepoRoot "logs"

function Show-Tail {
  param([string]$Path, [int]$Lines = 30)
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "  (нет файла: $Path)"
    return
  }
  Write-Host "--- tail $Path ---"
  Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

Write-Host "=== diagnose-bot-health ==="
Write-Host "Repo: $RepoRoot"

$svc = Get-Service -Name $name -ErrorAction SilentlyContinue
$svcStatus = if ($svc) { $svc.Status.ToString() } else { "not_installed" }
Write-Host ("Служба {0}: {1}" -f $name, $svcStatus)

$nssm = $null
foreach ($c in @(
  (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "C:\tools\nssm\nssm.exe"
)) {
  if ($c -and (Test-Path $c)) { $nssm = $c; break }
}
$nssmSt = $null
if ($nssm) {
  $nssmSt = (& $nssm status $name 2>&1 | Out-String).Trim()
  Write-Host "nssm status: $nssmSt"
}

$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'lena-bot\.mjs' })
$nodeCount = $procs.Count
if ($nodeCount -eq 0) {
  Write-Host "node lena-bot.mjs: не запущен"
} elseif ($nodeCount -eq 1) {
  Write-Host ("node lena-bot.mjs: PID {0}" -f $procs[0].ProcessId)
} else {
  Write-Host ("WARN: node lena-bot.mjs: {0} процессов — возможен Telegram Conflict" -f $nodeCount)
}

$envPath = Join-Path $RepoRoot ".env"
$envKeys = @{}
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -le 0) { continue }
    $key = $t.Substring(0, $eq).Trim().TrimStart([char]0xFEFF)
    $val = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($val) { $envKeys[$key] = $true }
  }
}
foreach ($k in @("TELEGRAM_BOT_TOKEN", "LENA_DRIVE_ROOT", "OPENAI_API_KEY", "LENA_OPENAI_API_KEY")) {
  Write-Host (".env {0}: {1}" -f $k, $(if ($envKeys.ContainsKey($k)) { "ok" } else { "MISSING" }))
}

Show-Tail -Path (Join-Path $logDir "lena-bot.err.log")
Show-Tail -Path (Join-Path $logDir "lena-bot.log")

$healthy = ($svcStatus -eq "Running" -and $nodeCount -eq 1)
if (-not $healthy) {
  Write-Host ""
  Write-Host "=== probe-bot-start (5s) ==="
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "probe-bot-start.ps1") -RepoRoot $RepoRoot
  Write-Host ""
  Write-Host "Попробуйте перезапуск:"
  Write-Host "  powershell -File scripts\lena-server\lena-bot-service-restart.ps1 -RepoRoot $RepoRoot"
  exit 1
}

Write-Host ""
Write-Host "OK: служба Running, один процесс node"
exit 0
