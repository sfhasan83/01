@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\pythonw.exe (echo Run setup.bat first. & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
echo.
echo Done. Double-click "Crypto Movement Bot" on your Desktop to start the bot.
pause
