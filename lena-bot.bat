@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ACTION=%~1"
if not defined ACTION set "ACTION=restart"

if /i "%ACTION%"=="stop"   goto STOP
if /i "%ACTION%"=="start"  goto START
if /i "%ACTION%"=="restart" goto RESTART

echo.
echo %~nx0  stop     — завершить все node, где в командной строке есть lena-bot.mjs
echo %~nx0  start    — запустить бота в этом окне ^(сначала stop, если был Conflict^)
echo %~nx0  restart  — stop, пауза 1 с, затем start ^(по умолчанию^)
echo.
pause
exit /b 1

:STOP
call :DO_STOP
echo.
echo Готово. Окно можно закрыть.
pause
exit /b 0

:RESTART
call :DO_STOP
echo.
echo Пауза 1 с перед запуском...
timeout /t 1 /nobreak >nul
goto START_RUN

:START
:START_RUN
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Ошибка] Команда "node" не найдена в PATH.
  echo Установите Node.js ^(LTS^) с https://nodejs.org и перезапустите командную строку,
  echo либо запускайте бота из среды, где node уже доступен.
  echo.
  pause
  exit /b 1
)

echo Запуск: node src\telegram\lena-bot.mjs
echo Текущая папка: %CD%
echo Остановка бота: Ctrl+C
echo.

node src\telegram\lena-bot.mjs
set "EL=%ERRORLEVEL%"

if not "%EL%"=="0" (
  echo.
  echo [Ошибка] node завершился с кодом %EL%
  echo Проверьте TELEGRAM_BOT_TOKEN, LENA_DRIVE_ROOT, GOOGLE_DRIVE_CREDENTIALS и вывод выше.
  echo.
)

pause
exit /b %EL%

:DO_STOP
echo Останавливаю процессы lena-bot...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& { Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'lena-bot\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('Stopped PID ' + $_.ProcessId) } }"
exit /b 0
