@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."
call "%~dp0..\..\lena-bot.bat"
exit /b %ERRORLEVEL%
