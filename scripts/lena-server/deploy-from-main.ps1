#Requires -Version 5.1
<#
  Синхронизация сервера с origin/main и перезапуск службы Лены.
  Вызывается вручную или из GitHub Actions по SSH после push в main.

  .\deploy-from-main.ps1
  .\deploy-from-main.ps1 -SkipPlaywright -NoRestart
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Branch = "main",
  [bool]$SkipPlaywright = $true,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "deploy.log"

function Write-DeployLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

Write-DeployLog "=== deploy-from-main start (branch=$Branch) ==="

if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
  throw "Not a git repo: $RepoRoot"
}

# GitHub по SSH: ключ deploy (не профиль Администратора с кириллицей в пути).
$deploySshDir = "C:\Users\deploy\.ssh"
$deployGithubKey = Join-Path $deploySshDir "id_ed25519_github"
$deployKnownHosts = Join-Path $deploySshDir "known_hosts"
if (Test-Path $deployGithubKey) {
  $keyPosix = ($deployGithubKey -replace "\\", "/")
  $khPosix = ($deployKnownHosts -replace "\\", "/")
  $env:GIT_SSH_COMMAND = "ssh -i `"$keyPosix`" -o IdentitiesOnly=yes -o UserKnownHostsFile=`"$khPosix`""
  Write-DeployLog "GIT_SSH_COMMAND: deploy GitHub key"
}

Write-DeployLog "git fetch origin $Branch"
git fetch origin $Branch
if ($LASTEXITCODE -ne 0) { throw "git fetch failed ($LASTEXITCODE)" }

$remoteRef = "origin/$Branch"
$remoteSha = (git rev-parse $remoteRef 2>$null).Trim()
if (-not $remoteSha) { throw "Remote ref not found: $remoteRef" }

$localSha = (git rev-parse HEAD 2>$null).Trim()
Write-DeployLog "local=$localSha remote=$remoteSha"

if ($localSha -ne $remoteSha) {
  Write-DeployLog "git checkout -B $Branch $remoteRef"
  git checkout -B $Branch $remoteRef
  if ($LASTEXITCODE -ne 0) { throw "git checkout failed ($LASTEXITCODE)" }
  git reset --hard $remoteRef
  if ($LASTEXITCODE -ne 0) { throw "git reset failed ($LASTEXITCODE)" }
} else {
  Write-DeployLog "Already on $remoteSha — continuing (npm/service refresh)"
}

Write-DeployLog "npm install"
npm install --omit=dev 2>$null
if ($LASTEXITCODE -ne 0) { npm install }

$install = Join-Path $RepoRoot "scripts\lena-server\install-windows.ps1"
Write-DeployLog "install-windows.ps1 (SkipPlaywright=$SkipPlaywright)"
& powershell -NoProfile -ExecutionPolicy Bypass -File $install -RepoRoot $RepoRoot @(if ($SkipPlaywright) { '-SkipPlaywright' })
if ($LASTEXITCODE -ne 0) { throw "install-windows.ps1 failed ($LASTEXITCODE)" }

if (-not $NoRestart) {
  $restart = Join-Path $RepoRoot "scripts\lena-server\lena-bot-service-restart.ps1"
  Write-DeployLog "lena-bot-service-restart.ps1"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $restart -RepoRoot $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw "service restart failed ($LASTEXITCODE)" }
} else {
  Write-DeployLog "Skip service restart (-NoRestart)"
}

Write-DeployLog "=== deploy-from-main OK ==="
