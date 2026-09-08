import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function loadEnv() {
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
      } catch (e) {
        console.warn(`[Migrate] Aviso al leer ${file}:`, e.message);
      }
    }
  }
}

loadEnv();

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("❌ Error: TURSO_DATABASE_URL no está definido en .env.local ni en las variables de entorno.");
  process.exit(1);
}

console.log("📡 Conectando a Turso:", url.replace(/:[^:@]+@/, ":***@"));

const client = createClient({
  url,
  authToken: authToken || undefined,
});

async function migrate() {
  try {
    console.log("🛠️ Creando tablas del esquema en Turso...");

    const schemaQueries = [
      `CREATE TABLE IF NOT EXISTS pacientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        fecha TEXT,
        nombre TEXT,
        payload TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS examenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paciente_codigo TEXT,
        test_id TEXT,
        fecha TEXT,
        nombre TEXT,
        area TEXT,
        payload TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS resultados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paciente_codigo TEXT,
        test_id TEXT,
        fecha TEXT,
        resultado TEXT,
        observaciones TEXT,
        payload TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS reportes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        fecha TEXT,
        payload TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS catalogo (
        id TEXT PRIMARY KEY,
        payload TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS ajustes (
        clave TEXT PRIMARY KEY,
        valor TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS sync_control (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mes INTEGER NOT NULL,
        anio INTEGER NOT NULL,
        fecha_sync TIMESTAMP,
        hash_integridad TEXT,
        archivo_nube TEXT,
        estado TEXT DEFAULT 'pendiente'
      );`,
      `CREATE TABLE IF NOT EXISTS metadata_sistema (
        clave TEXT PRIMARY KEY,
        valor TEXT
      );`
    ];

    for (const sql of schemaQueries) {
      await client.execute(sql);
    }
    console.log("✅ Esquema de tablas creado exitosamente.");

    // Verificar e insertar Catálogo de pruebas si está vacío
    const catCheck = await client.execute("SELECT COUNT(*) as count FROM catalogo;");
    const catCount = Number(catCheck.rows[0]?.count || 0);

    if (catCount === 0) {
      const catalogoPath = join(root, "data", "catalogo.json");
      if (existsSync(catalogoPath)) {
        console.log("📦 Población inicial del catálogo de pruebas desde catalogo.json...");
        const catalogoRaw = JSON.parse(readFileSync(catalogoPath, "utf8"));
        const batchStatements = [];

        for (const item of catalogoRaw) {
          if (item && item.id) {
            batchStatements.push({
              sql: "INSERT OR REPLACE INTO catalogo (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
              args: [item.id, JSON.stringify(item)]
            });
          }
        }

        if (batchStatements.length > 0) {
          // Ejecutar en lotes de 50
          for (let i = 0; i < batchStatements.length; i += 50) {
            const slice = batchStatements.slice(i, i + 50);
            await client.batch(slice, "write");
          }
          console.log(`✅ ${batchStatements.length} pruebas de laboratorio insertadas en la tabla 'catalogo'.`);
        }
      }
    } else {
      console.log(`ℹ️ La tabla 'catalogo' ya contiene ${catCount} pruebas registradas.`);
    }

    // Inicializar metadatos del sistema
    await client.execute({
      sql: "INSERT OR IGNORE INTO metadata_sistema (clave, valor) VALUES (?, ?)",
      args: ["version_sistema", "1.2.0-turso"]
    });
    await client.execute({
      sql: "INSERT OR IGNORE INTO metadata_sistema (clave, valor) VALUES (?, ?)",
      args: ["fecha_creacion", new Date().toISOString()]
    });

    console.log("🎉 ¡Migración e inicialización en Turso completada exitosamente!");
  } catch (err) {
    console.error("❌ Error durante la migración en Turso:", err);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();
