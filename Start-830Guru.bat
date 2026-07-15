@echo off
setlocal
cd /d "%~dp0"
echo Starting Komatsu 830E Guru...
start "830E Guru Server" cmd /k "node server.js"
timeout /t 2 >nul
start http://localhost:8300
