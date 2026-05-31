@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."
echo Repo: %CD%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lena-bot-stop.ps1" -ClearWebhook -RepoRoot "%CD%"
if errorlevel 2 goto FAIL_STOP
echo.
echo Wait 4 sec...
timeout /t 4 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "Restart-Service -Name 'tender-prep-lena' -Force -ErrorAction Stop; Write-Host 'OK: Restart-Service tender-prep-lena'"
if errorlevel 1 goto FAIL_SVC
echo.
echo Logs: %CD%\logs\lena-bot.log
pause
exit /b 0

:FAIL_STOP
echo.
echo ERROR: could not stop all lena-bot processes.
pause
exit /b 2

:FAIL_SVC
echo.
echo ERROR: service tender-prep-lena not found or could not restart.
echo Run: scripts\lena-server\install-service-nssm.ps1
pause
exit /b 1
