@echo off
setlocal
set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%"

echo ==========================================
echo    SUI CLMM Bot "Friend Edition"
echo ==========================================
echo.

:: 1. Node.js check
node -v >avg 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please download and install it from: https://nodejs.org/
    echo.
    pause
    exit /b
)

:: 2. Dependencies check
if not exist "bot_v2\node_modules\" (
    echo [INFO] First time setup: Installing libraries...
    cd bot_v2
    call npm install
    cd ..
)

:: 3. Start Backend & Open Browser
echo [INFO] Starting bot engine...
echo [INFO] Dashboard will open in your browser shortly.
echo.

:: Start the browser with a slight delay
start http://localhost:3002

:: Launch backend
cd bot_v2
call npm start

pause
