@echo off
cd /d "%~dp0"
set TELEGRAM_BOT_POLLING_ENABLED=false
"C:\Program Files\nodejs\node.exe" src\server.js
