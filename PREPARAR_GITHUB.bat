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

echo 1. Comprobando sintaxis de archivos...
call npm run check
if errorlevel 1 (
    echo.
    echo [ERROR] La comprobacion de sintaxis fallo. Corrija los errores antes de continuar.
    pause
    exit /b 1
)

echo.
echo 2. Verificando estado de Git...
git status --short

echo.
echo 3. Agregando archivos al staging...
git add .

echo.
echo 4. Realizando commit de actualizacion...
git commit -m "v1.3.0 - Catalogo ampliado a 50 determinaciones clinicas, perfiles rapidos actualizados, etiqueta Cod. Tarjeta y cache v40"

echo.
echo 5. Enviando cambios a GitHub (main)...
git push origin main

echo.
echo ==========================================
echo    SINCRONIZACION COMPLETADA CON EXITO
echo ==========================================
pause
