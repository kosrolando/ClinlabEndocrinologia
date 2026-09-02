# ClinLab Suite

Sistema portable de gestion para laboratorio clinico, con registro de pacientes, catalogo maestro, listas de trabajo, reportes, estadisticas, exportaciones y capa local de almacenamiento anual.

## Ejecucion local

Requisitos:

- Node.js 24 o superior, porque la version portable usa `node:sqlite`.

Iniciar:

```powershell
npm start
```

Abrir:

```text
http://localhost:4244
```

En Windows tambien puede ejecutar `INICIAR_CLINLAB.bat`.

## Datos locales

La aplicacion crea automaticamente esta estructura fuera del repositorio:

```text
%APPDATA%/LaboratorioSistema/
├── db/
│   ├── registros_YYYY.db
│   └── registros_activos.db
├── config/
│   ├── sistema.json
│   ├── licencia.json
│   └── sync_config.json
├── logs/
│   └── sync_log.txt
└── exportaciones/
```

Estos archivos contienen datos operativos del laboratorio y no deben subirse a GitHub.

## Acceso administrativo

El modulo Configuracion se desbloquea con el usuario tecnico definido en `app.js` y una contrasena validada por hash SHA-256.

No publique contrasenas operativas en GitHub. Entregue las credenciales al tecnico por un canal privado y rote el hash antes de instalaciones finales si corresponde.

## Licencias

Desde Configuracion > Administracion tecnica:

- `Renovar licencia del mes` genera un token rotativo.
- El token se guarda en `config_sistema.json` dentro de la carpeta nube local simulada.
- Al ingresar el token en el popup de licencia, el sistema reinicia el periodo de mantenimiento.

## GitHub

Antes de subir:

```powershell
npm run check
git status --short
```

Verifique que no aparezcan archivos `.db`, `.xlsx`, `.zip`, logs o carpetas de `LaboratorioSistema`.

## Vercel

Vercel puede servir la interfaz/PWA como distribucion web estatica. La capa completa de SQLite, `AppData`, licencias locales y exportacion del servidor requiere ejecutar `server.mjs` en una computadora local o en un servidor Node con disco persistente.

Por eso:

- En local: funcionalidad completa con `npm start`.
- En Vercel: interfaz de demostracion/distribucion, con fallback al almacenamiento del navegador si no existe `/api/bootstrap`.

Para publicar la interfaz:

```powershell
vercel
vercel --prod
```

## Validacion

```powershell
npm run check
```

El servidor tambien expone:

```text
GET /api/bootstrap
GET /api/sync/status
POST /api/export/month
POST /api/export/year
```
