@echo off
setlocal
cd /d "%~dp0"
echo Setting up BTC Movement Bot...
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (echo Python was not found. Install Python 3.10+ from https://www.python.org/downloads/ and tick "Add python.exe to PATH". & pause & exit /b 1)
if not exist .venv %PY% -m venv .venv || (echo Could not create the virtual environment. & pause & exit /b 1)
call .venv\Scripts\python.exe -m pip install --upgrade pip
call .venv\Scripts\python.exe -m pip install -r requirements.txt || (echo Installing packages failed. & pause & exit /b 1)
if not exist .env copy .env.example .env >nul
echo.
echo Creating a "Crypto Movement Bot" icon on your Desktop...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
echo.
echo Done. Your CoinMarketCap key goes in the .env file (open it with Notepad).
echo Start the bot any time by double-clicking "Crypto Movement Bot" on your Desktop.
pause
