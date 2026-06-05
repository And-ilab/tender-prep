@echo off
REM Deploy + restart tender-prep-lena. Admin required. See scripts\lena-server\README.md section 8.
setlocal EnableExtensions
cd /d "%~dp0"

echo === tender-prep: deploy + service restart ===

net session >nul 2>&1
if errorlevel 1 (
  echo [Ошибка] Запустите от имени Администратора.
  pause
  exit /b 1
)

set "GIT_SSH_COMMAND=ssh -i C:/Users/deploy/.ssh/id_ed25519_github -o IdentitiesOnly=yes -o UserKnownHostsFile=C:/Users/deploy/.ssh/known_hosts -o StrictHostKeyChecking=accept-new"
set "GIT_TERMINAL_PROMPT=0"
set "GIT_OPTIONAL_LOCKS=0"
set "GCM_INTERACTIVE=Never"

echo === Остановка службы перед git (снять блокировки .git/logs) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\lena-bot-stop.ps1" -RepoRoot "%CD%"

echo === Проверка origin/main ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\git-sync-main.ps1" -RepoRoot "%CD%" -SkipStop -AllowOfflineIfSynced
set "GIT_SYNC_EC=%ERRORLEVEL%"
if "%GIT_SYNC_EC%"=="1" (
  echo [Ошибка] git sync — см. test-github-dns.ps1 и интернет/DNS на сервере
  echo Без сети: перезапуск только — scripts\lena-server\lena-bot-service-restart.ps1
  pause
  exit /b 1
)
if "%GIT_SYNC_EC%"=="10" (
  echo === npm install ===
  call npm install --omit=dev
  if errorlevel 1 (
    echo [Ошибка] npm install
    pause
    exit /b 1
  )
)

echo === Playwright Chromium (служба SYSTEM) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\ensure-playwright-server.ps1" -RepoRoot "%CD%"
if errorlevel 1 (
  echo [Внимание] ensure-playwright-server.ps1 — см. вывод выше
)

echo === Права SYSTEM на .env и секреты ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\repair-service-permissions.ps1" -RepoRoot "%CD%"

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
