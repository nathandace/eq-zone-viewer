@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js 22.18 or newer is required. Download it from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
echo Building viewer...
call npm run build || (pause & exit /b 1)
node src\server\main.ts --open
pause
