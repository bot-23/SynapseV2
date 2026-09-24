@echo off
rem ============================================================
rem  Synapse launcher for Windows. Double-click this file.
rem
rem  1) If a prebuilt apps\web\dist exists (demo package), it just
rem     serves it with Node - no npm install needed.
rem  2) Otherwise it installs dependencies and starts the Vite dev
rem     server.
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

rem ---- 1) demo package: prebuilt bundle, zero dependencies ----
if exist "apps\web\dist\index.html" (
  echo [Synapse] Starting demo server ^(prebuilt, no install needed^)...
  start "Synapse Demo" cmd /k "node serve.cjs"
  timeout /t 3 /nobreak >nul
  start "" http://localhost:5180
  echo.
  echo [Synapse] Browser opened at http://localhost:5180
  echo           Keep the "Synapse Demo" window open; closing it stops the server.
  timeout /t 4 /nobreak >nul
  exit /b 0
)

rem ---- 2) source checkout: install deps, then dev server ----
if not exist "node_modules" (
  echo [Synapse] First run: installing dependencies, this takes a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [Synapse] npm install failed. Retrying with the npmmirror registry...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 (
      echo.
      echo [Synapse] npm install failed again. Check your network / proxy.
      pause
      exit /b 1
    )
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
