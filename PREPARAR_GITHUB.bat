@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo    PREPARANDO CLINLAB PARA GITHUB
echo ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git no esta instalado. Instalo desde https://git-scm.com/
    pause
    exit /b 1
)

echo 1. Inicializando repositorio local...
git init

echo 2. Agregando archivos...
git add .

echo 3. Realizando primer commit...
git commit -m "v1.1.0 - Codigos AAAAMMDDHHMMSS sin colision + impresion PDF vectorial optimizada"

echo.
echo ==========================================
echo    PASOS RESTANTES EN GITHUB.COM
echo ==========================================
echo 1. Crea un repositorio NUEVO y VACIO en github.com
echo 2. Copia el enlace del repositorio (HTTPS)
echo 3. Escribe en esta terminal: 
echo    git remote add origin TU_URL_DE_GITHUB
echo 4. Luego escribe:
echo    git branch -M main
echo    git push -u origin main
echo.
echo ==========================================
pause
