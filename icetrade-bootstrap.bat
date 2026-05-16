@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ============================================================================
REM IceTrade bootstrap — повторное скачивание вложений в inputs на Google Drive.
REM Это НЕ перезапуск Telegram-бота: отдельная команда, её можно вызывать сколько угодно.
REM
REM Нужны те же переменные, что для Drive: LENA_DRIVE_ROOT (или 1-й аргумент), OAuth и т.д.
REM Если в корне есть .env — подхватывается через node --env-file (Node 20+).
REM ============================================================================

where node >nul 2>&1
if errorlevel 1 (
  echo [Ошибка] node не найден в PATH. Установите Node.js 20+.
  pause
  exit /b 1
)

set "ROOT=%LENA_DRIVE_ROOT%"
set "ICE="
set "OPT="

if "%~2"=="" (
  set "ICE=%~1"
) else (
  set "ROOT=%~1"
  set "ICE=%~2"
  set "OPT=%~3"
)

if "%ICE%"=="" (
  echo.
  echo Использование:
  echo   %~nx0 ^<viewId_или_URL_карточки^>              — корень из переменной LENA_DRIVE_ROOT
  echo   %~nx0 ^<root_Drive_URL_или_id^> ^<viewId^|URL^> [flat^|ГГГГ]
  echo.
  echo Примеры:
  echo   set LENA_DRIVE_ROOT=https://drive.google.com/drive/folders/...
  echo   %~nx0 1336336
  echo   %~nx0 https://drive.google.com/.../folders/XXX 1336336 2026
  echo.
  pause
  exit /b 1
)

if "%ROOT%"=="" (
  echo [Ошибка] Не задан корень Drive: LENA_DRIVE_ROOT или первый аргумент.
  pause
  exit /b 1
)

echo ROOT: %ROOT%
echo IceTrade: %ICE%
if not "%OPT%"=="" echo Доп.параметр: %OPT%
echo.

if exist .env (
  node --env-file=.env src\cli.js tenders icetrade-bootstrap "%ROOT%" "%ICE%" %OPT%
) else (
  node src\cli.js tenders icetrade-bootstrap "%ROOT%" "%ICE%" %OPT%
)
set "EL=%ERRORLEVEL%"

if not "%EL%"=="0" (
  echo.
  echo [Ошибка] код %EL%
  echo Проверьте OAuth/SA, LENA_DRIVE_ROOT и вывод выше.
  echo.
)

pause
exit /b %EL%
