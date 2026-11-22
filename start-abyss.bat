@echo off
title abyss server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org && pause && exit /b 1)
if not exist node_modules\ws call npm install
echo Starting abyss on http://localhost:3000  (close this window to stop it)
start "" http://localhost:3000
node server.js
pause
