#Requires -Version 5.1
<#
  Синхронизация C:\tender-prep с origin/main (ключ deploy, без интерактива).
  Используйте при сбое git fetch в lena-bot.bat или при ручном обновлении.

  cd C:\tender-prep\scripts\lena-server
  .\git-sync-main.ps1

  Только fetch без reset:
  .\git-sync-main.ps1 -FetchOnly
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$FetchOnly,
  [switch]$SkipStop
)

$ErrorActionPreference = "Stop"
$env:GIT_TERMINAL_PROMPT = "0"
$env:GIT_OPTIONAL_LOCKS = "0"

$deployKey = "C:\Users\deploy\.ssh\id_ed25519_github"
$knownHosts = "C:\Users\deploy\.ssh\known_hosts"
if (Test-Path $deployKey) {
  $keyPosix = ($deployKey -replace "\\", "/")
  $khPosix = ($knownHosts -replace "\\", "/")
  $env:GIT_SSH_COMMAND = "ssh -i `"$keyPosix`" -o IdentitiesOnly=yes -o UserKnownHostsFile=`"$khPosix`" -o StrictHostKeyChecking=accept-new"
  Write-Host "GIT_SSH_COMMAND: deploy GitHub key"
} else {
  Write-Host "WARN: deploy key not found at $deployKey — git may ask for GitHub host key"
}

Set-Location $RepoRoot
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
  throw "Not a git repo: $RepoRoot — cd to repo root (e.g. C:/tender-prep) first"
}

if (-not $SkipStop) {
  $stopScript = Join-Path $PSScriptRoot "lena-bot-stop.ps1"
  Write-Host "=== lena-bot-stop (before git) ==="
  & powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript -RepoRoot $RepoRoot
  taskkill /F /IM git.exe 2>$null | Out-Null
  Start-Sleep -Seconds 2
}

function Invoke-GitFetch {
  git -c gc.auto=0 -c maintenance.auto=false fetch origin main
  if ($LASTEXITCODE -ne 0) {
    Start-Sleep -Seconds 3
    git -c gc.auto=0 -c maintenance.auto=false fetch origin main
  }
  if ($LASTEXITCODE -ne 0) {
    throw "git fetch failed ($LASTEXITCODE). Close IDE/git, rerun git-sync-main.ps1"
  }
}

Write-Host "=== git fetch origin main ==="
Invoke-GitFetch

$localSha = (git rev-parse HEAD 2>$null).Trim()
$remoteSha = (git rev-parse origin/main 2>$null).Trim()
Write-Host "local  = $localSha"
Write-Host "remote = $remoteSha"

if ($FetchOnly) {
  Write-Host "FetchOnly: skip reset"
  exit 0
}

if ($localSha -eq $remoteSha) {
  Write-Host "OK: already on origin/main ($($remoteSha.Substring(0, [Math]::Min(7, $remoteSha.Length))))"
  exit 0
}

Write-Host "=== git reset --hard origin/main ==="
git reset --hard origin/main
if ($LASTEXITCODE -ne 0) { throw "git reset failed ($LASTEXITCODE)" }

git clean -fd -e logs/
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARN: git clean — some locked files may remain (logs/ excluded)"
}

$headSha = (git rev-parse HEAD 2>$null).Trim()
Write-Host "HEAD = $headSha"
Write-Host "OK: updated to origin/main"
exit 10
