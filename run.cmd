@echo off
rem Double-click to start Roomside (and Interview Lab at /practice/) on Windows.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Roomside needs Node.js 20 or newer ^(npm is included^). Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 20) { console.error('Please install Node.js 20 or newer.'); process.exit(1) }"
if errorlevel 1 (
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run dev -- --open
pause
