@echo off
setlocal
cd /d "%~dp0"
set "BUNDLED_PY=C:\Users\ohpkx\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" (
  "%BUNDLED_PY%" scripts\index_manuals.py
) else (
  python scripts\index_manuals.py
)
pause
