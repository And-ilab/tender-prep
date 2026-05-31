#Requires -Version 5.1
<#
  Сервер: перезапуск через lena-bot.bat (служба), не второй node в окне.
#>
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot
$bat = Join-Path $RepoRoot "lena-bot.bat"
if (-not (Test-Path $bat)) {
  Write-Error "Not found: $bat"
}
Write-Host "Лена (сервер): $RepoRoot"
Write-Host "-> lena-bot.bat"
& cmd /c "`"$bat`""
exit $LASTEXITCODE
