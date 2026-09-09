@echo off
setlocal
cd /d "%~dp0"
title ClinLab Suite - Endocrinologia

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo =======================================================
  echo  [ERROR] No se encontro Node.js en esta computadora.
  echo  Instale Node.js LTS desde https://nodejs.org y reintente.
  echo =======================================================
  echo.
  pause
  exit /b 1
)

set "PORT=4245"
set "CLINLAB_DATA_DIR_NAME=LaboratorioSistema_Endocrinologia"

echo ============================================================
echo   CLINLAB SUITE - ENDOCRINOLOGIA Y MARCADORES TUMORALES
echo   Iniciando servidor local en http://localhost:4245 ...
echo ============================================================
echo.

:: Apertura sincronizada del navegador tras levantar el socket
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:4245"

node server.mjs
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  [AVISO] El servidor se ha detenido o se produjo un error.
  echo ============================================================
  echo.
  pause
)
