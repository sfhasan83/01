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
echo Checking that the bot can start...
.venv\Scripts\python.exe -c "import tkinter" 2>nul || (echo Python's window toolkit tkinter is missing. Re-run the Python installer, choose Modify and tick "tcl/tk and IDLE". & pause & exit /b 1)
.venv\Scripts\python.exe -m btc_bot --help >nul || (echo The bot failed its start-up check, see the error above. & pause & exit /b 1)
echo.
echo Creating a "Crypto Movement Bot" icon on your Desktop...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
echo.
echo Done. Your CoinMarketCap key goes in the .env file (open it with Notepad).
echo Start the bot any time by double-clicking "Crypto Movement Bot" on your Desktop.
pause
