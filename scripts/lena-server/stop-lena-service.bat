@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."
echo Repo: %CD%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lena-bot-stop.ps1" -RepoRoot "%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Service -Name 'tender-prep-lena' -Force -ErrorAction SilentlyContinue"
echo Готово.
pause
exit /b 0
