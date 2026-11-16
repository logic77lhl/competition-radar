@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found in PATH.
  pause
  exit /b 1
)
echo competition-radar dashboard  http://127.0.0.1:7865/
echo Close this window to stop it. Collected data is not affected.
echo.
node panel\server.mjs
if errorlevel 1 pause
