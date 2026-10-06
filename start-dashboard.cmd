@echo off
setlocal
rem ISL - Improvement Software Loop: avvio dashboard (build + serve + apri browser).
rem Doppio click per avviare. Chiudi la finestra o premi Ctrl+C per fermare.
rem Argomenti opzionali passati allo script PowerShell, es:
rem   start-dashboard.cmd -Port 8080 -Rebuild
rem   start-dashboard.cmd -Dev

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dashboard.ps1" %*

if errorlevel 1 (
  echo.
  echo Avvio fallito ^(exit code %errorlevel%^). Controlla i messaggi sopra.
  pause
)
endlocal
