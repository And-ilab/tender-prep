#Requires -Version 5.1
param([string]$RepoRoot = (Get-Location).Path)

$ErrorActionPreference = "Continue"
$name = "tender-prep-lena"
$stopScript = Join-Path $PSScriptRoot "lena-bot-stop.ps1"
$logDir = Join-Path $RepoRoot "logs"
$errLog = Join-Path $logDir "lena-bot.err.log"
$outLog = Join-Path $logDir "lena-bot.log"
$debugLog = Join-Path $RepoRoot "debug-1b4c7e.log"

function Write-DebugLog {
  param([string]$Location, [string]$Message, [hashtable]$Data, [string]$HypothesisId)
  $payload = @{
    sessionId  = "1b4c7e"
    runId      = "service-restart"
    location   = $Location
    message    = $Message
    data       = $Data
    timestamp  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    hypothesisId = $HypothesisId
  }
  try {
    Add-Content -LiteralPath $debugLog -Value ($payload | ConvertTo-Json -Compress) -Encoding UTF8
  } catch { # ignore
  }
}

function Find-Nssm {
  foreach ($c in @(
    (Get-Command nssm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "C:\tools\nssm\nssm.exe"
  )) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Get-NssmStatusText {
  param([string]$NssmExe, [string]$ServiceName)
  if (-not $NssmExe) { return $null }
  return (& $NssmExe status $ServiceName 2>&1 | Out-String).Trim()
}

function Show-LogTail {
  param([string]$Path, [int]$Lines = 25)
  if (-not (Test-Path $Path)) {
    Write-Host "  (no file: $Path)"
    return
  }
  Write-Host "--- tail $Path ---"
  Get-Content $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

function Wait-LenaServiceStopped {
  param([string]$ServiceName, [string]$NssmExe, [int]$MaxSec = 25)
  for ($i = 0; $i -lt $MaxSec; $i++) {
    Start-Sleep -Seconds 1
    $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $nssmSt = Get-NssmStatusText -NssmExe $NssmExe -ServiceName $ServiceName
    if (-not $s -or $s.Status -eq "Stopped") {
      if (-not $nssmSt -or $nssmSt -match "SERVICE_STOPPED") { return $true }
    }
    if ($s -and $s.Status -eq "Paused") {
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      if ($NssmExe) { & $NssmExe stop $ServiceName 2>&1 | Out-Null }
    }
  }
  return $false
}

function Stop-LenaServiceHard {
  param([string]$ServiceName, [string]$NssmExe)
  $sBefore = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  $nssmBefore = Get-NssmStatusText -NssmExe $NssmExe -ServiceName $ServiceName
  # #region agent log
  Write-DebugLog -Location "lena-bot-service-restart.ps1:StopHard:before" -Message "stop service hard" -Data @{
    scmStatus = $(if ($sBefore) { $sBefore.Status.ToString() } else { "missing" })
    nssmStatus = $nssmBefore
  } -HypothesisId "H2"
  # #endregion

  if ($NssmExe) {
    Write-Host "nssm stop $ServiceName (pre-start cleanup) ..."
    & $NssmExe stop $ServiceName 2>&1 | ForEach-Object { Write-Host $_ }
  }
  if ($sBefore -and $sBefore.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  }
  $ok = Wait-LenaServiceStopped -ServiceName $ServiceName -NssmExe $NssmExe
  $nssmAfter = Get-NssmStatusText -NssmExe $NssmExe -ServiceName $ServiceName
  $sAfter = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  # #region agent log
  Write-DebugLog -Location "lena-bot-service-restart.ps1:StopHard:after" -Message "stop service hard done" -Data @{
    stoppedOk = $ok
    scmStatus = $(if ($sAfter) { $sAfter.Status.ToString() } else { "missing" })
    nssmStatus = $nssmAfter
  } -HypothesisId "H2"
  # #endregion
  return $ok
}

function Start-LenaServiceRobust {
  param([string]$ServiceName, [string]$NssmExe)
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }

  [void](Stop-LenaServiceHard -ServiceName $ServiceName -NssmExe $NssmExe)
  Start-Sleep -Seconds 2

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($NssmExe) {
      Write-Host "nssm start $ServiceName (attempt $attempt) ..."
      $startOut = & $NssmExe start $ServiceName 2>&1 | Out-String
      if ($startOut.Trim()) { Write-Host $startOut.Trim() }
    } else {
      try { Start-Service -Name $ServiceName -ErrorAction Stop } catch {
        Write-Host "Start-Service failed: $($_.Exception.Message)"
      }
    }

    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Seconds 1
      $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
      $nssmSt = Get-NssmStatusText -NssmExe $NssmExe -ServiceName $ServiceName
      if ($s -and $s.Status -eq "Running" -and ($nssmSt -match "SERVICE_RUNNING" -or -not $nssmSt)) {
        # #region agent log
        Write-DebugLog -Location "lena-bot-service-restart.ps1:StartRobust:ok" -Message "service running" -Data @{
          attempt = $attempt
          scmStatus = $s.Status.ToString()
          nssmStatus = $nssmSt
        } -HypothesisId "H2"
        # #endregion
        return $true
      }
      if ($nssmSt -match "SERVICE_PAUSED" -or ($s -and $s.Status -eq "Paused")) {
        Write-Host "WARN: service PAUSED after start - forcing stop before retry"
        [void](Stop-LenaServiceHard -ServiceName $ServiceName -NssmExe $NssmExe)
        break
      }
    }
  }

  $sFail = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  $nssmFail = Get-NssmStatusText -NssmExe $NssmExe -ServiceName $ServiceName
  # #region agent log
  Write-DebugLog -Location "lena-bot-service-restart.ps1:StartRobust:fail" -Message "service not running" -Data @{
    scmStatus = $(if ($sFail) { $sFail.Status.ToString() } else { "missing" })
    nssmStatus = $nssmFail
  } -HypothesisId "H2"
  # #endregion
  return $false
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
icacls $logDir /grant "SYSTEM:(OI)(CI)M" 2>$null | Out-Null

Write-Host "=== Network check (DNS) ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "test-server-network.ps1")
$netEc = $LASTEXITCODE
# #region agent log
Write-DebugLog -Location "lena-bot-service-restart.ps1:network" -Message "network test result" -Data @{ exitCode = $netEc } -HypothesisId "H1"
# #endregion
if ($netEc -ne 0) {
  Write-Host "WARN: DNS/network problem - bot may not reach Telegram/GitHub until fixed"
  Write-Host "Continuing service restart anyway (local code can still run)."
}

Write-Host "=== Stop lena-bot (service + stray node) ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript -RepoRoot $RepoRoot
if ($LASTEXITCODE -eq 2) {
  Write-Host "ERROR: could not stop all lena-bot node processes."
  exit 2
}
Start-Sleep -Seconds 3

$s = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $s) {
  Write-Host "Service $name not found."
  Write-Host "Run as Administrator:"
  Write-Host "  cd $RepoRoot\scripts\lena-server"
  Write-Host "  .\install-service-nssm.ps1"
  exit 1
}

$nssm = Find-Nssm
if ($nssm) {
  & $nssm set $name AppStdout $outLog 2>&1 | Out-Null
  & $nssm set $name AppStderr $errLog 2>&1 | Out-Null
  $st = Get-NssmStatusText -NssmExe $nssm -ServiceName $name
  Write-Host "nssm status before start: $st"
}

Write-Host "=== Start service $name ==="
$ok = Start-LenaServiceRobust -ServiceName $name -NssmExe $nssm
$s2 = Get-Service -Name $name -ErrorAction SilentlyContinue
Write-Host ("Service status: {0}" -f $(if ($s2) { $s2.Status } else { "unknown" }))

if (-not $ok) {
  Write-Host ""
  Write-Host "ERROR: service did not reach Running state."
  if ($nssm) {
    Write-Host ("nssm status: {0}" -f (Get-NssmStatusText -NssmExe $nssm -ServiceName $name))
  }
  if ($netEc -ne 0) {
    Write-Host "Also fix DNS: .\test-server-network.ps1"
  }
  Show-LogTail -Path $errLog
  Show-LogTail -Path $outLog
  Write-Host ""
  Write-Host "Running probe-bot-start.ps1 ..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "probe-bot-start.ps1") -RepoRoot $RepoRoot
  exit 1
}

Write-Host ("OK: {0} -> Running" -f $name)

$dup = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*lena-bot.mjs*" })
if ($dup.Count -gt 1) {
  Write-Host "WARN: multiple node lena-bot processes - Telegram Conflict possible"
  exit 3
}
if ($dup.Count -eq 1) {
  Write-Host ("node PID: {0}" -f $dup[0].ProcessId)
}
exit 0
