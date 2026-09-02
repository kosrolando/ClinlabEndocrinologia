@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo No se encontro Node.js en esta terminal.
  echo Instale Node.js LTS desde https://nodejs.org y vuelva a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
start "ClinLab Suite" http://localhost:4244
node server.mjs
