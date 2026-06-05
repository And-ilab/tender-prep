@echo off
REM Deploy + restart tender-prep-lena. Admin required. See scripts\lena-server\README.md section 8.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo === tender-prep: deploy + service restart ===

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Run as Administrator.
  pause
  exit /b 1
)

set "GIT_SSH_COMMAND=ssh -i C:/Users/deploy/.ssh/id_ed25519_github -o IdentitiesOnly=yes -o UserKnownHostsFile=C:/Users/deploy/.ssh/known_hosts -o StrictHostKeyChecking=accept-new"
set "GIT_TERMINAL_PROMPT=0"
set "GIT_OPTIONAL_LOCKS=0"
set "GCM_INTERACTIVE=Never"

echo === Stop service before git (unlock .git/logs) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\lena-bot-stop.ps1" -RepoRoot "%CD%"

echo === git sync origin/main ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\git-sync-main.ps1" -RepoRoot "%CD%" -SkipStop -AllowOfflineIfSynced
set "GIT_SYNC_EC=!ERRORLEVEL!"
echo git-sync exit code: !GIT_SYNC_EC!
if "!GIT_SYNC_EC!"=="1" (
  echo [ERROR] git sync failed - see test-server-network.ps1 and DNS
  echo Offline restart only: scripts\lena-server\lena-bot-service-restart.ps1
  pause
  exit /b 1
)
if "!GIT_SYNC_EC!"=="10" (
  echo === npm install ===
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
)

echo === Playwright Chromium (SYSTEM service) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\ensure-playwright-server.ps1" -RepoRoot "%CD%"
if errorlevel 1 (
  echo [WARN] ensure-playwright-server.ps1 - see output above
)

echo === SYSTEM permissions on .env and secrets ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\repair-service-permissions.ps1" -RepoRoot "%CD%"

echo === Restart Lena service ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lena-server\lena-bot-service-restart.ps1" -RepoRoot "%CD%"
set "EC=!ERRORLEVEL!"
echo.
if "!EC!"=="0" (
  echo Done.
) else (
  echo [ERROR] exit code !EC!
)
pause
exit /b !EC!
