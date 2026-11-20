@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup.bat first. & pause & exit /b 1)
echo Starting Crypto Movement Bot with a console, so any error stays visible here...
.venv\Scripts\python.exe -m btc_bot gui
echo.
echo The bot has closed (exit code %errorlevel%). If you see an error above, send it to Claude.
pause
