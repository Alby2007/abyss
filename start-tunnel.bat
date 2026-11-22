@echo off
title abyss tunnel
cd /d "%~dp0"
rem Quick tunnel: free public URL, no account needed. The URL is random and
rem changes every time you restart this window - it's printed below as
rem https://<words>.trycloudflare.com
echo.
echo Starting tunnel to http://localhost:3000 - look for the trycloudflare.com URL below.
echo Keep this window open while your friends play. Start the game first with start-abyss.bat.
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
pause
