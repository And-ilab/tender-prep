#Requires -Version 5.1
<#
  Restore scripts/lena-server from origin/main via git show (no checkout/index).
  Use when .ps1 files were corrupted or git reset --hard is blocked.

  cd C:\tender-prep\scripts\lena-server
  .\restore-lena-server-scripts.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$env:GIT_TERMINAL_PROMPT = "0"
$env:GIT_OPTIONAL_LOCKS = "0"
$utf8 = New-Object System.Text.UTF8Encoding $false

$deployKey = "C:\Users\deploy\.ssh\id_ed25519_github"
$knownHosts = "C:\Users\deploy\.ssh\known_hosts"
if (Test-Path $deployKey) {
  $keyPosix = ($deployKey -replace "\\", "/")
  $khPosix = ($knownHosts -replace "\\", "/")
  $env:GIT_SSH_COMMAND = "ssh -i `"$keyPosix`" -o IdentitiesOnly=yes -o UserKnownHostsFile=`"$khPosix`" -o StrictHostKeyChecking=accept-new"
}

Set-Location $RepoRoot
Write-Host "=== git fetch origin main (gc disabled) ==="
git -c gc.auto=0 -c maintenance.auto=false fetch origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARN: fetch exit code $LASTEXITCODE - trying git show with existing origin/main"
}

$remoteHead = (git rev-parse --short origin/main).Trim()
Write-Host "origin/main = $remoteHead"

$relPaths = @(git ls-tree -r --name-only origin/main scripts/lena-server)
if (-not $relPaths -or $relPaths.Count -eq 0) {
  throw "no files under scripts/lena-server on origin/main"
}

Write-Host "=== restore $($relPaths.Count) files via git show ==="
foreach ($rel in $relPaths) {
  $dest = Join-Path $RepoRoot ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
  $destDir = Split-Path $dest -Parent
  if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  }
  $lines = git show "origin/main:$rel" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git show failed for $rel : $lines"
  }
  if ($lines -is [string]) {
    $text = $lines
  } else {
    $text = ($lines -join "`r`n") + "`r`n"
  }
  [System.IO.File]::WriteAllText($dest, $text, $utf8)
  Write-Host "  $rel"
}

Write-Host "=== parse check .ps1 ==="
Get-ChildItem -Path (Join-Path $RepoRoot "scripts\lena-server") -Filter "*.ps1" -File | ForEach-Object {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    Write-Host "PARSE FAIL: $($_.Name)"
    foreach ($e in $errors) { Write-Host $e.ToString() }
    exit 1
  }
}

Write-Host "OK: scripts/lena-server restored from origin/main ($remoteHead)"
Write-Host "Next: .\lena-bot-service-restart.ps1 -RepoRoot $RepoRoot"
