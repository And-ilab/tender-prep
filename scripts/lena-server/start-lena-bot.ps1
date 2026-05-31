#Requires -Version 5.1
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot
Write-Host "Лена: $RepoRoot"
Write-Host "Остановка: Ctrl+C"
node src\telegram\lena-bot.mjs
