# Guía de Despliegue en GitHub y Vercel - ClinLab Suite

## 1. Despliegue en GitHub

El repositorio remoto configurado es:
`https://github.com/kosrolando/ClinlabEndocrinologia.git`

### Pasos para sincronizar cambios con GitHub:

1. Abrir una terminal en la carpeta del proyecto (o ejecutar `PREPARAR_GITHUB.bat`).
2. Ejecutar los comandos:
```powershell
git add .
git commit -m "v1.2.0 - Actualizacion y preparacion completa para despliegue en GitHub y Vercel"
git push origin main
```

> **Nota:** El archivo `.gitignore` ya excluye automáticamente cualquier dato operativo, bases de datos `.db`, exportaciones Excel/ZIP y registros locales.

---

## 2. Despliegue en Vercel (Frontend / PWA Web)

La aplicación está 100% optimizada para correr en **Vercel** como Progressive Web App (PWA) de alto rendimiento.

### Opción A: Despliegue automático desde GitHub (Recomendado)
1. Entra a [Vercel Dashboard](https://vercel.com/dashboard).
2. Haz clic en **Add New...** > **Project**.
3. Importa tu repositorio `ClinlabEndocrinologia`.
4. Deja la configuración por defecto:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./`
   - **Build Command:** *(vacío)*
   - **Output Directory:** *(vacío / `.`)*
5. Haz clic en **Deploy**. ¡Cada `git push` a `main` actualizará Vercel automáticamente!

### Opción B: Despliegue directo mediante Vercel CLI
```powershell
npx vercel
npx vercel --prod
```

### Características en Vercel:
- **Almacenamiento Seguro (IndexedDB + Storage Shield):** Almacenamiento local estructurado e ilimitado en el navegador, sin depender de backend externo.
- **Códigos Únicos:** Generación de códigos cronológicos `AAAAMMDDHHMMSS` sin colisiones.
- **Impresión Profesional:** Plantilla vectorial Media Carta / A5 con código de barras Code 128 (SVG nativo).
- **Service Worker (PWA):** Soporte offline completo y capacidad de instalación como app nativa.

---

## 3. Ejecución Local con Servidor Node.js

Para ejecución local en red o escritorio:
```powershell
npm start
# O ejecutar INICIAR_CLINLAB.bat
```
La aplicación abrirá en: `http://localhost:4244`
