#Requires -Version 5.1
<#
  Probe bot startup as LocalSystem (same account as NSSM service).
  Run as Administrator:

    cd C:\tender-prep\scripts\lena-server
    .\probe-bot-system.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$WaitSec = 8
)

$ErrorActionPreference = "Continue"
$taskName = "tender-prep-probe-system"
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $node) {
  Write-Host "FAIL: node not in PATH"
  exit 1
}

$bot = Join-Path $RepoRoot "src\telegram\lena-bot.mjs"
$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
icacls $logDir /grant "SYSTEM:(OI)(CI)M" 2>$null | Out-Null

$probeErr = Join-Path $logDir "probe-system.err"
$probeOut = Join-Path $logDir "probe-system.out"
$marker = Join-Path $logDir "probe-system.done"
Remove-Item $probeErr, $probeOut, $marker -ErrorAction SilentlyContinue

$runner = Join-Path $logDir "probe-system-run.ps1"
@(
  '$ErrorActionPreference = "Continue"'
  "Set-Location -LiteralPath '$RepoRoot'"
  "`$p = Start-Process -FilePath '$node' -ArgumentList @('$bot') -WorkingDirectory '$RepoRoot' -RedirectStandardError '$probeErr' -RedirectStandardOutput '$probeOut' -PassThru -WindowStyle Hidden"
  "Start-Sleep -Seconds $WaitSec"
  "if (-not `$p.HasExited) { Stop-Process -Id `$p.Id -Force -ErrorAction SilentlyContinue; 'alive' | Set-Content -LiteralPath '$marker' -Encoding ASCII }"
  "else { ('exit:' + `$p.ExitCode) | Set-Content -LiteralPath '$marker' -Encoding ASCII }"
) -join "`n" | Set-Content -LiteralPath $runner -Encoding UTF8

Write-Host "=== probe-bot-system (LocalSystem) ==="
Write-Host "Node: $node"
Write-Host "Bot:  $bot"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`"" `
  -WorkingDirectory $RepoRoot
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

for ($i = 0; $i -lt ($WaitSec + 15); $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $marker) { break }
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Remove-Item $runner -ErrorAction SilentlyContinue

if (-not (Test-Path $marker)) {
  Write-Host "FAIL: SYSTEM probe task did not finish (timeout)"
  exit 1
}

$result = (Get-Content $marker -Raw -ErrorAction SilentlyContinue).Trim()
if ($result -eq "alive") {
  Write-Host "OK: bot still alive after ${WaitSec}s under LocalSystem"
  exit 0
}

Write-Host "FAIL: bot exited under LocalSystem ($result)"
if (Test-Path $probeErr) {
  Write-Host "--- probe-system stderr ---"
  Get-Content $probeErr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}
if (Test-Path $probeOut) {
  Write-Host "--- probe-system stdout ---"
  Get-Content $probeOut -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Host $_ }
}
exit 1
