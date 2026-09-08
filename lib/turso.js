import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function loadLocalEnv() {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) return;
  const envFiles = [".env.local", ".env.development.local", ".env.production.local", ".env"];
  for (const file of envFiles) {
    const fullPath = join(root, file);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch (e) {}
    }
  }
}

loadLocalEnv();

let _tursoClient = null;

export function getTursoClient() {
  if (_tursoClient) return _tursoClient;
  loadLocalEnv();

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    return null;
  }

  _tursoClient = createClient({
    url,
    authToken: authToken || undefined
  });

  return _tursoClient;
}

export function isTursoConfigured() {
  loadLocalEnv();
  return Boolean(process.env.TURSO_DATABASE_URL);
}

export async function tursoBootstrap() {
  const client = getTursoClient();
  if (!client) throw new Error("Turso client no configurado");

  const [settingsRes, externalListRes, catalogRes, reportesRes, metaRes] = await Promise.all([
    client.execute("SELECT valor FROM ajustes WHERE clave = 'settings'"),
    client.execute("SELECT valor FROM ajustes WHERE clave = 'externalList'"),
    client.execute("SELECT payload FROM catalogo ORDER BY id"),
    client.execute("SELECT payload FROM reportes ORDER BY fecha DESC, codigo DESC"),
    client.execute("SELECT clave, valor FROM metadata_sistema")
  ]);

  const settings = settingsRes.rows[0]?.valor ? JSON.parse(String(settingsRes.rows[0].valor)) : {};
  const externalList = externalListRes.rows[0]?.valor ? JSON.parse(String(externalListRes.rows[0].valor)) : [];
  const catalog = catalogRes.rows.map(r => JSON.parse(String(r.payload)));
  const requests = reportesRes.rows.map(r => JSON.parse(String(r.payload)));
  const metadata = Object.fromEntries(metaRes.rows.map(r => [String(r.clave), String(r.valor)]));

  const year = new Date().getFullYear();
  const license = {
    fecha_activacion: new Date().toISOString().slice(0, 10),
    fecha_vencimiento: "2099-12-31",
    estado: "activo",
    token_actual: "ILIMITADO",
    renovaciones: []
  };

  const syncConfig = {
    proveedor: "turso",
    ultima_sync: new Date().toISOString(),
    cloudUrl: process.env.TURSO_DATABASE_URL,
    pendientes: []
  };

  const syncStatus = {
    estado: "sincronizado",
    texto: `Conectado a Turso Cloud (${requests.length} registros)`,
    ultima_sync: syncConfig.ultima_sync,
    licencia: "activo"
  };

  return {
    ok: true,
    year,
    settings,
    requests,
    catalog,
    metadata,
    license,
    syncConfig,
    syncStatus,
    externalList
  };
}

export async function tursoSavePayload(payload) {
  const client = getTursoClient();
  if (!client) throw new Error("Turso client no configurado");

  const statements = [];

  // 1. Ajustes & configuración
  if (payload.settings) {
    statements.push({
      sql: "INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('settings', ?)",
      args: [JSON.stringify(payload.settings)]
    });
  }
  if (payload.externalList) {
    statements.push({
      sql: "INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('externalList', ?)",
      args: [JSON.stringify(payload.externalList)]
    });
  }

  // 2. Catálogo si se incluye
  if (Array.isArray(payload.catalog) && payload.catalog.length > 0) {
    for (const item of payload.catalog) {
      if (item && item.id) {
        statements.push({
          sql: "INSERT OR REPLACE INTO catalogo (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
          args: [item.id, JSON.stringify(item)]
        });
      }
    }
  }

  // 3. Pacientes y Reportes
  if (Array.isArray(payload.requests)) {
    for (const req of payload.requests) {
      if (!req || !req.code) continue;
      const jsonReq = JSON.stringify(req);
      const reqDate = req.date || new Date().toISOString().slice(0, 10);
      const reqName = req.name || "";

      statements.push({
        sql: "INSERT OR REPLACE INTO reportes (codigo, fecha, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        args: [req.code, reqDate, jsonReq]
      });
      statements.push({
        sql: "INSERT OR REPLACE INTO pacientes (codigo, fecha, nombre, payload, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
        args: [req.code, reqDate, reqName, jsonReq]
      });

      // Limpiar y reinsertar exámenes y resultados asociados
      statements.push({
        sql: "DELETE FROM examenes WHERE paciente_codigo = ?",
        args: [req.code]
      });
      statements.push({
        sql: "DELETE FROM resultados WHERE paciente_codigo = ?",
        args: [req.code]
      });

      for (const test of req.tests || []) {
        statements.push({
          sql: "INSERT INTO examenes (paciente_codigo, test_id, fecha, nombre, area, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
          args: [req.code, String(test.id || ""), reqDate, String(test.name || test.parametro || ""), String(test.area || ""), JSON.stringify(test)]
        });
        statements.push({
          sql: "INSERT INTO resultados (paciente_codigo, test_id, fecha, resultado, observaciones, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
          args: [req.code, String(test.id || ""), reqDate, String(test.result || ""), String(test.notes || ""), JSON.stringify({ request: req.code, test })]
        });
      }
    }
  }

  // Ejecutar en lotes de 100
  for (let i = 0; i < statements.length; i += 100) {
    const chunk = statements.slice(i, i + 100);
    await client.batch(chunk, "write");
  }

  return {
    ok: true,
    message: "Datos guardados exitosamente en Turso Cloud",
    syncStatus: {
      estado: "sincronizado",
      texto: `Sincronizado con Turso - ${new Date().toLocaleTimeString("es-BO")}`,
      ultima_sync: new Date().toISOString(),
      licencia: "activo"
    }
  };
}

export async function tursoDelete(code) {
  const client = getTursoClient();
  if (!client) throw new Error("Turso client no configurado");

  await client.batch([
    { sql: "DELETE FROM examenes WHERE paciente_codigo = ?", args: [code] },
    { sql: "DELETE FROM resultados WHERE paciente_codigo = ?", args: [code] },
    { sql: "DELETE FROM pacientes WHERE codigo = ?", args: [code] },
    { sql: "DELETE FROM reportes WHERE codigo = ?", args: [code] }
  ], "write");

  return { ok: true, deleted: code };
}

export async function tursoSearch(query = "", code = "") {
  const client = getTursoClient();
  if (!client) throw new Error("Turso client no configurado");

  let sql = "SELECT payload FROM reportes WHERE 1=1";
  const args = [];

  if (code) {
    sql += " AND codigo = ?";
    args.push(code);
  }
  if (query) {
    sql += " AND payload LIKE ?";
    args.push(`%${query}%`);
  }

  sql += " ORDER BY fecha DESC, codigo DESC LIMIT 100";

  const res = await client.execute({ sql, args });
  return res.rows.map(r => JSON.parse(String(r.payload)));
}
