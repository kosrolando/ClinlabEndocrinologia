@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo    PREPARANDO CLINLAB PARA GITHUB
echo ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git no esta instalado. Instale Git desde https://git-scm.com/
    pause
    exit /b 1
)

echo 1. Verificando estado de Git...
git status --short

echo.
echo 2. Agregando archivos al staging...
git add .

echo.
echo 3. Realizando commit de actualizacion...
git commit -m "v1.2.0 - Preparacion y actualizacion de archivos para GitHub y Vercel"

echo.
echo 4. Enviando cambios a GitHub (main)...
git push origin main

echo.
echo ==========================================
echo    SINCRONIZACION COMPLETADA CON EXITO
echo ==========================================
pause
