@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MSEC ERP
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install LTS from https://nodejs.org and run again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages... first run takes 1-3 minutes.
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)
echo Starting ERP at http://localhost:5173  ^(close this window to stop^)
start "" http://localhost:5173
call npm run dev -- --port 5173 --strictPort
pause
