#Requires -Version 5.1
<#
  Автозапуск Лены через Планировщик заданий (без NSSM).
  Запуск от администратора:

    .\install-scheduled-task.ps1 -RunAsUser DOMAIN\svc-lena

  Если -RunAsUser не задан — задача от текущего пользователя (нужен вход в систему).
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$TaskName = "tender-prep-lena-bot",
  [string]$RunAsUser = ""
)

$ErrorActionPreference = "Stop"

$startScript = Join-Path $PSScriptRoot "start-lena-bot.ps1"
if (-not (Test-Path $startScript)) {
  throw "Не найден $startScript"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" `
  -WorkingDirectory $RepoRoot

$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($RunAsUser) {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($triggerBoot, $triggerLogon) `
    -Settings $settings `
    -User $RunAsUser `
    -RunLevel Highest `
    -Description "Telegram bot Lena (tender-prep)"
} else {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($triggerBoot, $triggerLogon) `
    -Settings $settings `
    -Description "Telegram bot Lena (tender-prep)"
}

Write-Host "Задача $TaskName создана. Запуск сейчас…"
Start-ScheduledTask -TaskName $TaskName
Write-Host "Проверка: Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
