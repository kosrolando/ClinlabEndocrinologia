# Seguridad Operativa

## Credenciales administrativas

La contrasena administrativa no debe publicarse en texto plano. La interfaz valida contra un hash SHA-256 configurado en `app.js`.

Para generar un hash nuevo:

```powershell
node -e "const crypto=require('node:crypto'); console.log(crypto.createHash('sha256').update(process.argv[1]).digest('hex'))" "NUEVA-CONTRASENA"
```

Luego reemplace el valor `ADMIN_CREDENTIALS.passwordHash` en `app.js`.

## Datos sensibles

No suba al repositorio:

- Bases SQLite `.db`.
- Exportaciones `.xlsx`, `.xls`, `.zip`.
- Logs.
- Archivos locales de licencia y sincronizacion.
- Tokens OAuth o credenciales de Google Drive/OneDrive.

## Distribucion

Para clientes finales, use la version portable local con `INICIAR_CLINLAB.bat`. La publicacion en Vercel debe tratarse como distribucion de interfaz o demo si no existe un backend persistente propio.
