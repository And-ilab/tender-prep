@echo off
setlocal EnableExtensions
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo [Ошибка] Запустите от имени Администратора.
  pause
  exit /b 1
)

set "GIT_SSH_COMMAND=ssh -i C:/Users/deploy/.ssh/id_ed25519_github -o IdentitiesOnly=yes -o UserKnownHostsFile=C:/Users/deploy/.ssh/known_hosts"

echo === Проверка origin/main ===
git fetch origin main
if errorlevel 1 (
  echo [Ошибка] git fetch
  pause
  exit /b 1
)

for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "LOCAL=%%H"
for /f "delims=" %%H in ('git rev-parse origin/main 2^>nul') do set "REMOTE=%%H"

if "%LOCAL%"=="%REMOTE%" (
  echo Код актуален ^(%LOCAL:~0,7%^).
) else (
  echo Обновление: %LOCAL:~0,7% -^> %REMOTE:~0,7%
  git reset --hard origin/main
  if errorlevel 1 (
    echo [Ошибка] git reset
    pause
    exit /b 1
  )
  git clean -fd
  if errorlevel 1 (
    echo [Ошибка] git clean
    pause
    exit /b 1
  )
  echo Код обновлён.
  echo === npm install ===
  call npm install --omit=dev
  if errorlevel 1 (
    echo [Ошибка] npm install
    pause
    exit /b 1
  )
  )
)

echo === Playwright Chromium (служба SYSTEM) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\ensure-playwright-server.ps1" -RepoRoot "%CD%"
if errorlevel 1 (
  echo [Внимание] ensure-playwright-server.ps1 — см. вывод выше
)

echo === Перезапуск Лены ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\lena-bot-service-restart.ps1" -RepoRoot "%CD%"
set "EC=%ERRORLEVEL%"
echo.
if "%EC%"=="0" (
  echo Готово.
) else (
  echo [Ошибка] код %EC%
)
pause
exit /b %EC%
