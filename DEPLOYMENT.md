# Guía de Despliegue en GitHub y Vercel - ClinLab Suite

## 1. Preparación para GitHub

Para subir el proyecto a un repositorio remoto de GitHub:

### Opción A (Script automático):
Ejecutar el archivo `PREPARAR_GITHUB.bat` en la raíz del proyecto.

### Opción B (Comandos manuales en PowerShell/CMD):
```powershell
git init
git add .
git commit -m "v1.1.0 - Codigos AAAAMMDDHHMMSS sin colision + impresion PDF vectorial optimizada"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
git push -u origin main
```

> **Nota:** El archivo `.gitignore` ya incluye las exclusiones de datos personales, bases de datos locales (`*.db`), exportaciones Excel y registros temporales.

---

## 2. Publicación en Vercel (Frontend Web App)

Para desplegar la interfaz web en **Vercel**:

### Vía CLI de Vercel:
```powershell
npx vercel
npx vercel --prod
```

### Vía interfaz web de Vercel (Conectando a GitHub):
1. Inicia sesión en [Vercel Dashboard](https://vercel.com/dashboard).
2. Haz clic en **Add New...** -> **Project**.
3. Selecciona tu repositorio de GitHub `TU_REPOSITORIO`.
4. En la configuración del proyecto:
   - **Framework Preset:** `Other` (o Vite/HTML).
   - **Build Command:** *(dejar vacío)*.
   - **Output Directory:** `.` (raíz).
5. Haz clic en **Deploy**.

> **Manejo de Almacenamiento en Vercel (Modo Web sin Servidor Local):**
> - La versión desplegada en Vercel opera de forma 100% cliente en el navegador.
> - Cuenta con **Storage Shield (IndexedDB)**: superada la cuota estándar de 5MB de `LocalStorage` (alrededor de 900-1,000 registros de pacientes), la aplicación almacena de forma segura e ilimitada las solicitudes en la base de datos interna IndexedDB del navegador.
> - La generación de códigos correlativos es calculada dinámicamente combinando la fecha y hora de registro (`AAAAMMDDHHMMSS`) con verificación de unicidad en IndexedDB y memoria local, garantizando orden cronológico ilimitado sin colisiones.

---

## 3. Servidor Local (Back-End con SQLite)

Para el funcionamiento completo con base de datos local SQLite en el disco duro, multi-terminal en red local y licencias ilimitadas:

1. Ejecutar `INICIAR_CLINLAB.bat` o en consola:
```powershell
node server.mjs
```
2. Abrir en el navegador:
`http://localhost:3000`

