@echo off
rem ============================================================
rem  Synapse - one-click launcher for Windows.
rem  Double-click this file. It installs dependencies on first
rem  run, starts the Vite dev server, then opens the browser.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads .cmd scripts
rem  with the system code page, so non-ASCII bytes break parsing.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Synapse] Node.js not found.
  echo           Install Node 18+ first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [Synapse] First run: installing dependencies, this takes a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [Synapse] npm install failed. Check the output above.
    pause
    exit /b 1
  )
)

echo [Synapse] Starting dev server in a new window...
start "Synapse Web" cmd /k "npm run dev --workspace @synapse/web"

echo [Synapse] Waiting for http://localhost:5180 ...
timeout /t 8 /nobreak >nul
start "" http://localhost:5180

echo.
echo [Synapse] Browser opened. Keep the "Synapse Web" window open;
echo           closing it stops the server.
timeout /t 5 /nobreak >nul
exit /b 0
