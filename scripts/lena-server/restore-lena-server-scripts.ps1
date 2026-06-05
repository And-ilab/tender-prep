#Requires -Version 5.1
<#
  Restore scripts/lena-server from origin/main without git-sync-main.ps1.
  Use when local .ps1 files were corrupted by encoding patches.

  cd C:\tender-prep\scripts\lena-server
  .\restore-lena-server-scripts.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
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
}

Set-Location $RepoRoot
Write-Host "=== git fetch origin main ==="
git -c gc.auto=0 fetch origin main
if ($LASTEXITCODE -ne 0) { throw "git fetch failed ($LASTEXITCODE)" }

Write-Host "=== git checkout origin/main -- scripts/lena-server ==="
git checkout origin/main -- scripts/lena-server
if ($LASTEXITCODE -ne 0) { throw "git checkout failed ($LASTEXITCODE)" }

$head = (git rev-parse --short HEAD).Trim()
Write-Host "OK: restored scripts/lena-server (repo HEAD $head)"
Write-Host "Next: .\lena-bot-service-restart.ps1 -RepoRoot $RepoRoot"
