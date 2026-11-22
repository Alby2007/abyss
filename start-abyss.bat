@echo off
title abyss server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org && pause && exit /b 1)
if not exist node_modules\@supabase\supabase-js call npm install
if not exist .env echo No .env file found, storing stats locally in data\db.json. See .env.example to connect Supabase.
echo Starting abyss on http://localhost:3000  (close this window to stop it)
start "" http://localhost:3000
node server.js
pause
