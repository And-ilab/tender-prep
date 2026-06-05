#Requires -Version 5.1
<#
  Синхронизация C:\tender-prep с origin/main (ключ deploy, без интерактива).

  Exit codes:
    0  - already on origin/main, or fetch failed but HEAD matches cached origin/main
   10  - updated (run npm install)
    1  - error (offline and outdated, or reset failed)

  cd C:\tender-prep\scripts\lena-server
  .\git-sync-main.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$FetchOnly,
  [switch]$SkipStop,
  [switch]$AllowOfflineIfSynced
)

$ErrorActionPreference = "Continue"
$env:GIT_TERMINAL_PROMPT = "0"
$env:GIT_OPTIONAL_LOCKS = "0"

$deployKey = "C:\Users\deploy\.ssh\id_ed25519_github"
$knownHosts = "C:\Users\deploy\.ssh\known_hosts"
if (Test-Path $deployKey) {
  New-Item -ItemType Directory -Force -Path (Split-Path $knownHosts) | Out-Null
  $hasGithubHost = $false
  if (Test-Path $knownHosts) {
    $hasGithubHost = @(Get-Content -LiteralPath $knownHosts -ErrorAction SilentlyContinue |
      Where-Object { $_ -match "github\.com" }).Count -gt 0
  }
  if (-not $hasGithubHost) {
    $scan = ssh-keyscan -t ed25519 github.com 2>$null
    if ($scan) {
      Add-Content -Path $knownHosts -Value $scan -Encoding ASCII
      Write-Host "Added github.com to deploy known_hosts"
    }
  }
  $keyPosix = ($deployKey -replace "\\", "/")
  $khPosix = ($knownHosts -replace "\\", "/")
  $env:GIT_SSH_COMMAND = "ssh -i `"$keyPosix`" -o IdentitiesOnly=yes -o UserKnownHostsFile=`"$khPosix`" -o StrictHostKeyChecking=accept-new"
  Write-Host "GIT_SSH_COMMAND: deploy GitHub key"
} else {
  Write-Host "WARN: deploy key not found at $deployKey"
  Write-Host "Use git-sync-main.ps1 only after deploy key setup, or run lena-bot.bat"
}

Set-Location $RepoRoot
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
  Write-Host "FAIL: not a git repo: $RepoRoot"
  exit 1
}

if (-not $SkipStop) {
  $stopScript = Join-Path $PSScriptRoot "lena-bot-stop.ps1"
  Write-Host "=== lena-bot-stop (before git) ==="
  & powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript -RepoRoot $RepoRoot
  taskkill /F /IM git.exe 2>$null | Out-Null
  Start-Sleep -Seconds 2
}

$dnsScript = Join-Path $PSScriptRoot "test-server-network.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $dnsScript
$dnsEc = $LASTEXITCODE
if ($dnsEc -ne 0 -and -not $AllowOfflineIfSynced) {
  Write-Host "WARN: github.com not reachable - will try fetch anyway"
}

function Get-GitSha {
  param([string]$Ref)
  $s = (git rev-parse $Ref 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  return $s.Trim()
}

$localBefore = Get-GitSha "HEAD"
$remoteBefore = Get-GitSha "origin/main"

function Invoke-GitFetchOnce {
  git -c gc.auto=0 -c maintenance.auto=false fetch origin main 2>&1 | ForEach-Object { Write-Host $_ }
  return ($LASTEXITCODE -eq 0)
}

Write-Host "=== git fetch origin main ==="
$fetchOk = Invoke-GitFetchOnce
if (-not $fetchOk) {
  Start-Sleep -Seconds 3
  $fetchOk = Invoke-GitFetchOnce
}

$localSha = Get-GitSha "HEAD"
$remoteSha = Get-GitSha "origin/main"
Write-Host "local  = $localSha"
Write-Host "remote = $remoteSha"

if (-not $fetchOk) {
  Write-Host ""
  Write-Host "WARN: git fetch failed"
  if ($localSha -and $remoteSha -and $localSha -eq $remoteSha) {
    Write-Host "HEAD matches cached origin/main - continuing deploy without git update"
    Write-Host "Fix DNS/network, then rerun lena-bot.bat to pull newer commits"
    if ($FetchOnly) { exit 0 }
    exit 0
  }
  Write-Host "FAIL: cannot fetch and local code may be outdated (HEAD != origin/main or no origin/main)"
  Write-Host "Run: .\scripts\lena-server\test-github-dns.ps1"
  exit 1
}

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
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAIL: git reset"
  exit 1
}

git clean -fd -e logs/ 2>&1 | Out-Null

$headSha = Get-GitSha "HEAD"
Write-Host "HEAD = $headSha"
Write-Host "OK: updated to origin/main"
exit 10
