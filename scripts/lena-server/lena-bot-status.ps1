#Requires -Version 5.1
param([string]$RepoRoot = (Get-Location).Path)

$ErrorActionPreference = "Continue"
$name = "tender-prep-lena"
$svc = Get-Service -Name $name -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host ("Служба {0}: {1}" -f $name, $svc.Status)
} else {
  Write-Host "Служба ${name}: не установлена"
}
$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'lena-bot\.mjs' })
if ($procs.Count -eq 0) {
  Write-Host "node lena-bot.mjs: не запущен"
} elseif ($procs.Count -eq 1) {
  Write-Host ("node lena-bot.mjs: PID {0}" -f $procs[0].ProcessId)
} else {
  Write-Host ("WARN: node lena-bot.mjs: {0} процессов — будет Conflict в Telegram" -f $procs.Count)
  foreach ($p in $procs) { Write-Host ("  PID {0}" -f $p.ProcessId) }
}
