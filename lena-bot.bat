@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ACTION=%~1"
if not defined ACTION set "ACTION=restart"

if /i "%ACTION%"=="stop"   goto STOP
if /i "%ACTION%"=="start"  goto START
if /i "%ACTION%"=="restart" goto RESTART
if /i "%ACTION%"=="service-restart" goto SERVICE_RESTART
if /i "%ACTION%"=="service-stop" goto SERVICE_STOP

echo.
echo %~nx0  stop              — остановить node + службу tender-prep-lena
echo %~nx0  start             — бот в этом окне ^(отладка^)
echo %~nx0  restart            — stop, webhook, start в окне ^(только если НЕТ службы^)
echo %~nx0  service-restart   — для сервера 24/7: stop, webhook, Restart-Service
echo %~nx0  service-stop       — остановить службу и все node
echo.
pause
exit /b 1

:STOP
call :DO_STOP 0
if errorlevel 2 (
  echo.
  echo [Внимание] Не все процессы остановлены. Закройте другие окна с ботом или остановите службу вручную.
  echo   Stop-Service tender-prep-lena
  echo.
)
echo.
echo Готово. Окно можно закрыть.
pause
exit /b 0

:SERVICE_STOP
call :DO_STOP 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Service -Name 'tender-prep-lena' -Force -ErrorAction SilentlyContinue"
echo Служба tender-prep-lena остановлена ^(если была установлена^).
pause
exit /b 0

:SERVICE_RESTART
call :DO_STOP 1
if errorlevel 2 goto RESTART_BLOCKED
call :WAIT_TELEGRAM
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = Get-Service -Name 'tender-prep-lena' -ErrorAction SilentlyContinue; if (-not $s) { Write-Host 'Служба tender-prep-lena не найдена. Установите: scripts\lena-server\install-service-nssm.ps1'; exit 1 }; Restart-Service -Name 'tender-prep-lena' -Force; Write-Host 'Restart-Service tender-prep-lena: ok'"
if errorlevel 1 (
  echo.
  echo [Ошибка] Не удалось перезапустить службу. См. install-service-nssm.ps1
  pause
  exit /b 1
)
echo.
echo Бот работает как служба. Логи: logs\lena-bot.log и logs\lena-bot.err.log
pause
exit /b 0

:RESTART_BLOCKED
echo.
echo [Ошибка] Перезапуск отменён: lena-bot всё ещё запущен.
pause
exit /b 2

:RESTART
call :DO_STOP 1
if errorlevel 2 goto RESTART_BLOCKED
call :WAIT_TELEGRAM
goto START_RUN

:START
call :CHECK_ALREADY_RUNNING
if errorlevel 1 (
  echo.
  echo [Ошибка] lena-bot уже работает. Используйте: %~nx0 restart
  echo.
  pause
  exit /b 1
)
goto START_RUN

:START_RUN
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Ошибка] Команда "node" не найдена в PATH.
  echo Установите Node.js ^(LTS^) с https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo Запуск: node src\telegram\lena-bot.mjs
echo Папка: %CD%
echo Остановка: Ctrl+C  или  %~nx0 stop
echo.

node src\telegram\lena-bot.mjs
set "EL=%ERRORLEVEL%"

if not "%EL%"=="0" (
  echo.
  echo [Ошибка] node завершился с кодом %EL%
  echo Проверьте .env: TELEGRAM_BOT_TOKEN, LENA_DRIVE_ROOT, GOOGLE_DRIVE_OAUTH_* 
  echo При Conflict в логе: %~nx0 restart
  echo.
)

pause
exit /b %EL%

:DO_STOP
set "DO_CLEAR_WEBHOOK=%~1"
echo.
echo === Остановка Лены ===
if "%DO_CLEAR_WEBHOOK%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\lena-bot-stop.ps1" -ClearWebhook -RepoRoot "%CD%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\lena-bot-stop.ps1" -RepoRoot "%CD%"
)
exit /b %ERRORLEVEL%

:WAIT_TELEGRAM
echo.
echo Пауза 4 с — Telegram освобождает long polling...
timeout /t 4 /nobreak >nul
exit /b 0

:CHECK_ALREADY_RUNNING
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'lena-bot\.mjs' }; if ($p) { exit 1 } else { exit 0 }"
exit /b %ERRORLEVEL%
