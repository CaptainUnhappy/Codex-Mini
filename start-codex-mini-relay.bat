@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows-relay.ps1"

echo.
echo Codex Mini stopped.
pause
