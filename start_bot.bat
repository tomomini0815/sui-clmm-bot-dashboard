@echo off
TITLE Sui CLMM Bot System
echo Starting Sui CLMM Bot System...

:: Get the current directory of the batch file
set "ROOT_DIR=%~dp0"

echo [1/2] Starting Backend API Server...
start "Bot-Backend" /D "%ROOT_DIR%bot_v2" powershell -NoExit -Command "npm start"

echo [2/2] Starting Frontend Dashboard...
start "Bot-Frontend" /D "%ROOT_DIR%frontend" powershell -NoExit -Command "npm run dev"

echo.
echo ==================================================
echo System Launching!
echo.
echo 1. Backend: http://localhost:3001
echo 2. Frontend: http://localhost:5173 (Open this in your browser)
echo.
echo Keep this window and the other two windows open while running.
echo ==================================================
pause
