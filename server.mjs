import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile, appendFile, readdir, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

let DatabaseSync;
try {
  const sqlite = await import("node:sqlite");
  DatabaseSync = sqlite.DatabaseSync;
} catch (e) {
  console.warn("node:sqlite no disponible. Usando fallback de base de datos JSON.");
}

import { tursoBootstrap, tursoSavePayload, tursoDelete, tursoSearch, isTursoConfigured } from "./lib/turso.js";



const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4244);
const appDataRoot = join(process.env.APPDATA || process.cwd(), "LaboratorioSistema");
const dirs = {
  root: appDataRoot,
  db: join(appDataRoot, "db"),
  config: join(appDataRoot, "config"),
  logs: join(appDataRoot, "logs"),
  exports: join(appDataRoot, "exportaciones"),
  cloudMirror: join(appDataRoot, "nube_simulada")
};

const SYSTEM_VERSION = "1.1.0-storage";
const SESSION = { warningShown: false, readOnly: false };

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

async function ensureStructure() {
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  await ensureJson(configPath("sistema.json"), {
    version_sistema: SYSTEM_VERSION,
    contacto_tecnico: { nombre: "Administrador", telefono: "+591XXXXXXXX", correo: "administrador@ejemplo.com" },
    proveedor_preferido: "googledrive"
  });
  await ensureJson(configPath("sync_config.json"), {
    proveedor: "googledrive",
    link_carpeta: "",
    carpeta_id: "",
    ultima_sync: null,
    token_api: "",
    pendientes: []
  });
  await ensureJson(configPath("licencia.json"), defaultLicense());
  const year = new Date().getFullYear();
  const db = openYearDb(year);
  db.close();
  const ext = DatabaseSync ? ".db" : ".json";
  await writeFile(join(dirs.db, "registros_activos.db"), `registros_${year}${ext}`, "utf8");
  await archiveOldRecords();
}

function configPath(name) {
  return join(dirs.config, name);
}

async function archiveOldRecords() {
  try {
    const year = new Date().getFullYear();
    const db = openYearDb(year);
    const date12Months = new Date();
    date12Months.setMonth(date12Months.getMonth() - 12);
    const str12M = date12Months.toISOString().slice(0, 10);
    
    // Contar registros vencidos (> 12 meses)
    const expiredCount = db.prepare("SELECT COUNT(*) as count FROM pacientes WHERE fecha < ?").get(str12M)?.count || 0;
    
    if (expiredCount > 0) {
      const noticePath = configPath("purge_notice.json");
      let notice = await readJson(noticePath, null);
      if (!notice || !notice.firstNotified) {
        notice = {
          firstNotified: new Date().toISOString(),
          count: expiredCount,
          cutoff: str12M
        };
        await writeJson(noticePath, notice);
        await logEvent("WARN", "RETENCION", `Preaviso de depuración iniciado: ${expiredCount} registros mayores a 12 meses.`);
      }

      const elapsedMs = Date.now() - new Date(notice.firstNotified).getTime();
      const elapsedDays = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));

      if (elapsedDays >= 7) {
        // Respaldar antes de depurar
        const expiredRecords = db.prepare("SELECT payload FROM reportes WHERE fecha < ?").all(str12M).map(r => JSON.parse(r.payload));
        const archiveDir = join(appDataRoot, "archivos_lectura");
        await mkdir(archiveDir, { recursive: true });
        const purgeBackupFile = join(archiveDir, `backup_depurados_${Date.now()}.json`);
        await writeFile(purgeBackupFile, JSON.stringify(expiredRecords, null, 2), "utf8");

        // Ejecutar eliminación tras cumplirse los 7 días
        db.prepare("DELETE FROM examenes WHERE paciente_codigo IN (SELECT codigo FROM pacientes WHERE fecha < ?)").run(str12M);
        db.prepare("DELETE FROM resultados WHERE paciente_codigo IN (SELECT codigo FROM pacientes WHERE fecha < ?)").run(str12M);
        db.prepare("DELETE FROM pacientes WHERE fecha < ?").run(str12M);
        db.prepare("DELETE FROM reportes WHERE fecha < ?").run(str12M);
        
        await unlink(noticePath).catch(() => {});
        await logEvent("INFO", "RETENCION", `Depuración automática completada: ${expiredCount} registros eliminados tras 7 días de preaviso.`);
      } else {
        await logEvent("INFO", "RETENCION", `Período de preaviso activo (${7 - elapsedDays} días restantes para depurar ${expiredCount} registros).`);
      }
    } else {
      const noticePath = configPath("purge_notice.json");
      if (existsSync(noticePath)) {
        await unlink(noticePath).catch(() => {});
      }
    }
    
    db.close();
  } catch (err) {
    console.error("Error en mantenimiento de base de datos:", err);
  }
}

async function ensureJson(path, fallback) {
  try {
    await readJson(path);
  } catch {
    await writeJson(path, fallback);
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    if (fallback !== null) return fallback;
    throw new Error(`No se pudo leer ${path}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultLicense() {
  return { fecha_activacion: isoDate(), fecha_vencimiento: "2099-12-31", estado: "activo", token_actual: "ILIMITADO", renovaciones: [] };
}

class MockDatabaseSync {
  constructor(path, options = {}) {
    this.dbPath = path;
    this.jsonPath = path.replace(/\.db$/, ".json");
    this.readonly = options.readOnly || false;
    this.data = {
      pacientes: {},
      examenes: [],
      resultados: [],
      reportes: {},
      catalogo: {},
      ajustes: {},
      sync_control: [],
      metadata_sistema: {}
    };
    if (existsSync(this.jsonPath)) {
      try {
        this.data = JSON.parse(readFileSync(this.jsonPath, "utf8"));
      } catch (e) {
        console.error("Error leyendo DB JSON fallback:", e);
      }
    }
  }

  save() {
    if (this.readonly) return;
    try {
      writeFileSync(this.jsonPath, JSON.stringify(this.data, null, 2), "utf8");
    } catch (e) {
      console.error("Error escribiendo DB JSON fallback:", e);
    }
  }

  exec(sql) {
    // No-op
  }

  close() {
    this.save();
  }

  prepare(sql) {
    const self = this;
    const cleanSql = sql.replace(/\s+/g, " ").trim();

    return {
      run(...args) {
        if (self.readonly) throw new Error("La base de datos está en modo lectura.");

        if (cleanSql.startsWith("DELETE FROM")) {
          const table = cleanSql.split(" ").at(-1);
          if (table === "reportes") self.data.reportes = {};
          else if (table === "pacientes") self.data.pacientes = {};
          else if (table === "examenes") self.data.examenes = [];
          else if (table === "resultados") self.data.resultados = [];
          else if (table === "catalogo") self.data.catalogo = {};
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT OR REPLACE INTO ajustes")) {
          const [clave, valor] = args;
          self.data.ajustes[clave] = valor;
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT OR REPLACE INTO reportes")) {
          const [codigo, fecha, payload] = args;
          self.data.reportes[codigo] = { codigo, fecha, payload, updated_at: new Date().toISOString() };
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT OR REPLACE INTO pacientes")) {
          const [codigo, fecha, nombre, payload] = args;
          self.data.pacientes[codigo] = { codigo, fecha, nombre, payload, updated_at: new Date().toISOString() };
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT INTO examenes")) {
          const [paciente_codigo, test_id, fecha, nombre, area, payload] = args;
          self.data.examenes.push({ paciente_codigo, test_id, fecha, nombre, area, payload, updated_at: new Date().toISOString() });
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT INTO resultados")) {
          const [paciente_codigo, test_id, fecha, resultado, observaciones, payload] = args;
          self.data.resultados.push({ paciente_codigo, test_id, fecha, resultado, observaciones, payload, updated_at: new Date().toISOString() });
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT OR REPLACE INTO catalogo")) {
          const [id, payload] = args;
          self.data.catalogo[id] = { id, payload, updated_at: new Date().toISOString() };
          self.save();
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT OR IGNORE INTO metadata_sistema")) {
          const [clave, valor] = args;
          if (self.data.metadata_sistema[clave] === undefined) {
            self.data.metadata_sistema[clave] = valor;
            self.save();
          }
          return { changes: 1 };
        }

        if (cleanSql.includes("INSERT INTO sync_control")) {
          if (cleanSql.includes("fecha_sync")) {
            const [mes, anio, hash_integridad, archivo_nube] = args;
            self.data.sync_control.push({
              id: self.data.sync_control.length + 1,
              mes,
              anio,
              fecha_sync: new Date().toISOString(),
              hash_integridad,
              archivo_nube,
              estado: 'sincronizado'
            });
          } else {
            const [mes, anio] = args;
            const exists = self.data.sync_control.some(s => s.mes === mes && s.anio === anio && s.estado === 'pendiente');
            if (!exists) {
              self.data.sync_control.push({
                id: self.data.sync_control.length + 1,
                mes,
                anio,
                fecha_sync: null,
                hash_integridad: null,
                archivo_nube: null,
                estado: 'pendiente'
              });
            }
          }
          self.save();
          return { changes: 1 };
        }

        return { changes: 0 };
      },

      get(...args) {
        if (cleanSql.includes("SELECT valor FROM ajustes WHERE clave = 'settings'")) {
          return self.data.ajustes["settings"] ? { valor: self.data.ajustes["settings"] } : undefined;
        }

        if (cleanSql.includes("SELECT valor FROM ajustes WHERE clave = 'externalList'")) {
          return self.data.ajustes["externalList"] ? { valor: self.data.ajustes["externalList"] } : undefined;
        }

        if (cleanSql.includes("SELECT valor FROM metadata_sistema WHERE clave = ?")) {
          const [clave] = args;
          return self.data.metadata_sistema[clave] !== undefined ? { valor: self.data.metadata_sistema[clave] } : undefined;
        }

        return undefined;
      },

      all(...args) {
        if (cleanSql.includes("SELECT payload FROM reportes ORDER BY")) {
          return Object.values(self.data.reportes)
            .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.codigo.localeCompare(b.codigo))
            .map(r => ({ payload: r.payload }));
        }

        if (cleanSql.includes("SELECT payload FROM catalogo")) {
          return Object.values(self.data.catalogo).map(c => ({ payload: c.payload }));
        }

        if (cleanSql.includes("SELECT clave, valor FROM metadata_sistema")) {
          return Object.entries(self.data.metadata_sistema).map(([clave, valor]) => ({ clave, valor }));
        }

        if (cleanSql.includes("SELECT DISTINCT mes FROM sync_control WHERE anio = ? AND estado = 'pendiente'")) {
          const [anio] = args;
          const months = self.data.sync_control
            .filter(s => s.anio === anio && s.estado === 'pendiente')
            .map(s => s.mes);
          return [...new Set(months)].map(mes => ({ mes }));
        }

        if (cleanSql.includes("SELECT payload FROM reportes WHERE substr(fecha, 1, 7) = ?")) {
          const [yearMonth] = args;
          return Object.values(self.data.reportes)
            .filter(r => r.fecha.slice(0, 7) === yearMonth)
            .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.codigo.localeCompare(b.codigo))
            .map(r => ({ payload: r.payload }));
        }

        if (cleanSql.includes("SELECT DISTINCT CAST(substr(fecha, 6, 2) AS INTEGER)")) {
          const [year] = args;
          const months = Object.values(self.data.reportes)
            .filter(r => r.fecha.slice(0, 4) === year)
            .map(r => parseInt(r.fecha.slice(5, 7)));
          return [...new Set(months)].sort((a, b) => a - b).map(mes => ({ mes }));
        }

        return [];
      }
    };
  }
}

const DatabaseClass = DatabaseSync || MockDatabaseSync;

function openYearDb(year, readonly = false) {
  const path = join(dirs.db, `registros_${year}.db`);
  const db = new DatabaseClass(path, readonly ? { readOnly: true } : {});
  if (!readonly) ensureSchema(db);
  return db;
}


function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pacientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      fecha TEXT,
      nombre TEXT,
      payload TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS examenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paciente_codigo TEXT,
      test_id TEXT,
      fecha TEXT,
      nombre TEXT,
      area TEXT,
      payload TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS resultados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paciente_codigo TEXT,
      test_id TEXT,
      fecha TEXT,
      resultado TEXT,
      observaciones TEXT,
      payload TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reportes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      fecha TEXT,
      payload TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS catalogo (
      id TEXT PRIMARY KEY,
      payload TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ajustes (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_control (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mes INTEGER NOT NULL,
      anio INTEGER NOT NULL,
      fecha_sync TIMESTAMP,
      hash_integridad TEXT,
      archivo_nube TEXT,
      estado TEXT DEFAULT 'pendiente'
    );
    CREATE TABLE IF NOT EXISTS metadata_sistema (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
  `);
  const labId = getMetadata(db, "laboratorio_id") || randomUUID();
  setMetadata(db, "laboratorio_id", labId);
  setMetadata(db, "version_sistema", SYSTEM_VERSION);
  if (!getMetadata(db, "fecha_creacion")) setMetadata(db, "fecha_creacion", new Date().toISOString());
}

function getMetadata(db, key) {
  return db.prepare("SELECT valor FROM metadata_sistema WHERE clave = ?").get(key)?.valor || "";
}

function setMetadata(db, key, value) {
  db.prepare("INSERT OR IGNORE INTO metadata_sistema (clave, valor) VALUES (?, ?)").run(key, value);
}

async function logEvent(level, module, description) {
  const line = `[${new Date().toISOString().slice(0, 19).replace("T", " ")}] [${level}] [${module}] ${description}\n`;
  await appendFile(join(dirs.logs, "sync_log.txt"), line, "utf8");
}

function getCloudRootDir() {
  try {
    const configPath = join(dirs.config, "sync_config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const path = config.link_carpeta || "";
      if (path && (path.startsWith("/") || path.includes(":") || path.startsWith("\\\\"))) {
        if (existsSync(path)) {
          return path;
        }
      }
    }
  } catch (e) {
    console.error("Error al obtener la ruta de la nube:", e);
  }
  return dirs.cloudMirror;
}

function getCollabDir() {
  return join(getCloudRootDir(), "Colaboracion");
}

async function ensureCloudStructure() {
  const rootDir = getCloudRootDir();
  await mkdir(join(rootDir, "Respaldos_Mensuales"), { recursive: true });
  await mkdir(join(rootDir, "Respaldos_Anuales"), { recursive: true });
  await mkdir(join(rootDir, "Restauraciones"), { recursive: true });
  const currentDb = openYearDb(new Date().getFullYear());
  const labId = getMetadata(currentDb, "laboratorio_id");
  currentDb.close();
  await ensureJson(join(rootDir, "config_sistema.json"), {
    token_renovacion: "",
    laboratorio_id: labId,
    nombre_laboratorio: "Nombre del cliente",
    contacto_tecnico: { nombre: "Administrador", telefono: "+591XXXXXXXX", correo: "administrador@ejemplo.com" },
    fecha_ultima_renovacion: isoDate(),
    estado_cuenta: "activo"
  });
}

async function bootstrap() {
  await ensureStructure();
  if (isTursoConfigured()) {
    try {
      const cloudData = await tursoBootstrap();
      if (cloudData && cloudData.ok) {
        return {
          ...cloudData,
          appDataRoot,
          syncStatus: {
            estado: "sincronizado",
            texto: `Conectado a Turso Cloud (${cloudData.requests.length} registros)`,
            ultima_sync: new Date().toISOString(),
            licencia: "activo"
          }
        };
      }
    } catch (err) {
      console.warn("[Turso] No se pudo cargar bootstrap desde Turso, usando base local:", err.message);
    }
  }

  const license = await verifyLicense();
  const year = new Date().getFullYear();
  const db = openYearDb(year);
  const settings = JSON.parse(db.prepare("SELECT valor FROM ajustes WHERE clave = 'settings'").get()?.valor || "null");
  const externalList = JSON.parse(db.prepare("SELECT valor FROM ajustes WHERE clave = 'externalList'").get()?.valor || "[]");
  const requests = db.prepare("SELECT payload FROM reportes ORDER BY fecha, codigo").all().map((row) => JSON.parse(row.payload));
  const catalog = db.prepare("SELECT payload FROM catalogo").all().map((row) => JSON.parse(row.payload));
  const metadata = Object.fromEntries(db.prepare("SELECT clave, valor FROM metadata_sistema").all().map((row) => [row.clave, row.valor]));
  db.close();
  const syncConfig = await readJson(configPath("sync_config.json"), {});
  return { ok: true, year, appDataRoot, settings, requests, catalog, metadata, license, syncConfig, syncStatus: await syncStatus(), externalList };
}

async function savePayload(payload) {
  await ensureStructure();
  const db = openYearDb(new Date().getFullYear());
  await backupActiveDb();
  
  db.prepare("DELETE FROM catalogo").run();
  const upsertSettings = db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('settings', ?)");
  upsertSettings.run(JSON.stringify(payload.settings || {}));
  const upsertExternal = db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('externalList', ?)");
  upsertExternal.run(JSON.stringify(payload.externalList || []));
  const insertReport = db.prepare("INSERT OR REPLACE INTO reportes (codigo, fecha, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
  const insertPatient = db.prepare("INSERT OR REPLACE INTO pacientes (codigo, fecha, nombre, payload, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
  const insertExam = db.prepare("INSERT INTO examenes (paciente_codigo, test_id, fecha, nombre, area, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
  const insertResult = db.prepare("INSERT INTO resultados (paciente_codigo, test_id, fecha, resultado, observaciones, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
  
  const deleteExams = db.prepare("DELETE FROM examenes WHERE paciente_codigo = ?");
  const deleteResults = db.prepare("DELETE FROM resultados WHERE paciente_codigo = ?");
  
  for (const req of payload.requests || []) {
    insertReport.run(req.code, req.date, JSON.stringify(req));
    insertPatient.run(req.code, req.date, req.name, JSON.stringify(req));
    deleteExams.run(req.code);
    deleteResults.run(req.code);
    for (const test of req.tests || []) {
      insertExam.run(req.code, test.id, req.date, testParameter(test), test.area || "", JSON.stringify(test));
      insertResult.run(req.code, test.id, req.date, test.result || "", test.notes || "", JSON.stringify({ request: req.code, test }));
    }
  }
  
  const insertCatalog = db.prepare("INSERT OR REPLACE INTO catalogo (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
  for (const item of payload.catalog || []) {
    insertCatalog.run(item.id, JSON.stringify(item));
  }
  
  markMonthsPending(db, payload.requests || []);
  db.close();

  // Sincronizar en Turso si está configurado
  if (isTursoConfigured()) {
    try {
      await tursoSavePayload(payload);
    } catch (err) {
      console.warn("[Turso] Error al sincronizar en Turso:", err.message);
    }
  }

  const syncConfig = await readJson(configPath("sync_config.json"), {});
  return {
    ok: true,
    syncStatus: {
      estado: "sincronizado",
      texto: isTursoConfigured() ? "Sincronizado con Turso Cloud" : "Guardado localmente",
      ultima_sync: new Date().toISOString(),
      licencia: "activo"
    },
    syncConfig
  };
}

function markMonthsPending(db, requests) {
  const months = new Set(requests.map((req) => `${Number(req.date?.slice(0, 4))}-${Number(req.date?.slice(5, 7))}`).filter((v) => !v.includes("NaN")));
  const stmt = db.prepare("INSERT INTO sync_control (mes, anio, estado) SELECT ?, ?, 'pendiente' WHERE NOT EXISTS (SELECT 1 FROM sync_control WHERE mes = ? AND anio = ? AND estado = 'pendiente')");
  for (const value of months) {
    const [year, month] = value.split("-").map(Number);
    stmt.run(month, year, month, year);
  }
}

async function backupActiveDb() {
  const year = new Date().getFullYear();
  const ext = DatabaseSync ? ".db" : ".json";
  const source = join(dirs.db, `registros_${year}${ext}`);
  try {
    await stat(source);
    const target = join(dirs.db, `backup_registros_${year}_${Date.now()}${ext}`);
    await copyFile(source, target);
  } catch {}
}

async function verifyLicense(inputToken = "") {
  return {
    ok: true,
    estado: "activo",
    dias_transcurridos: 1,
    dias_restantes: 9999,
    mostrar_aviso: false,
    license: defaultLicense(),
    contacto_tecnico: { nombre: "Administrador", telefono: "+5910000000", correo: "admin@ejemplo.com" }
  };
}

async function saveSyncConfig(payload) {
  const current = await readJson(configPath("sync_config.json"), {});
  const link = payload.link_carpeta || payload.cloudUrl || "";
  const next = { ...current, proveedor: providerFor(link), link_carpeta: link, carpeta_id: folderIdFromLink(link), token_api: payload.token_api || current.token_api || "" };
  await writeJson(configPath("sync_config.json"), next);
  await logEvent("INFO", "NUBE", `Configuracion de nube actualizada (${next.proveedor || "sin proveedor"}).`);
  return { ok: true, syncConfig: next, syncStatus: await syncStatus() };
}

function providerFor(link) {
  if (link.includes("drive.google.com")) return "googledrive";
  if (link.includes("onedrive") || link.includes("sharepoint")) return "onedrive";
  return "";
}

function folderIdFromLink(link) {
  const drive = link.match(/folders\/([^/?#]+)/);
  if (drive) return drive[1];
  try {
    return new URL(link).pathname.split("/").filter(Boolean).at(-1) || "";
  } catch {
    return "";
  }
}

async function exportMonth(year, month) {
  await ensureStructure();
  const readonly = year < new Date().getFullYear();
  const db = openYearDb(year, readonly);
  const requests = db.prepare("SELECT payload FROM reportes WHERE substr(fecha, 1, 7) = ? ORDER BY fecha, codigo").all(`${year}-${String(month).padStart(2, "0")}`).map((row) => JSON.parse(row.payload));
  const metadata = Object.fromEntries(db.prepare("SELECT clave, valor FROM metadata_sistema").all().map((row) => [row.clave, row.valor]));
  db.close();
  const totalRecords = requests.length + requests.flatMap((req) => req.tests || []).length;
  const monthName = monthNames[month - 1];
  const fileName = `${year}_Mes${String(month).padStart(2, "0")}_${monthName}.xlsx`;
  const filePath = join(dirs.exports, fileName);
  await mkdir(dirs.exports, { recursive: true });
  const sheets = monthlySheets(requests, monthName, metadata, totalRecords);
  await writeFile(filePath, excelXml(sheets), "utf8");
  const hash = await fileHash(filePath);
  let zipPath = "";
  if (totalRecords >= 5000) {
    zipPath = await compressDb(year, month);
  }
  await subirANube(filePath, "Respaldos_Mensuales");
  if (zipPath && totalRecords > 20000) await subirANube(zipPath, "Restauraciones");
  const dbWrite = openYearDb(new Date().getFullYear());
  dbWrite.prepare("INSERT INTO sync_control (mes, anio, fecha_sync, hash_integridad, archivo_nube, estado) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, 'sincronizado')").run(month, year, hash, fileName);
  dbWrite.close();
  await logEvent("INFO", "EXPORTACION", `Exportacion mensual generada: ${fileName}`);
  return { ok: true, fileName, filePath, hash, totalRecords, zipPath, syncStatus: await syncStatus() };
}

function testText(value) {
  return String(value ?? "").trim();
}

function testDetermination(test) {
  return testText(test.determination || test.determinacion || test.name || test.nombre);
}

function testClassification(test) {
  return testText(test.classification || test.clasificacion || test.category || test.categoria);
}

function testParameter(test) {
  return testText(test.parameter || test.parametro || test.name || test.nombre);
}

function testReference(test) {
  return testText(test.reference || test.referencia);
}

function monthlySheets(requests, monthName, metadata, totalRecords) {
  const patientRows = requests.map((req) => [req.date, req.code, req.auxCode, req.name, req.age, req.gender, req.service, req.doctor, req.bed]);
  const examRows = requests.flatMap((req) => (req.tests || []).map((test) => [
    req.date,
    req.code,
    req.name,
    test.area,
    testDetermination(test),
    testClassification(test),
    testParameter(test),
    test.type || test.tipo || "",
    test.sample || test.muestra || "",
    test.unit || test.unidad || "",
    test.minimum || test.minimo || "",
    test.maximum || test.maximo || "",
    testReference(test)
  ]));
  const resultRows = requests.flatMap((req) => (req.tests || []).map((test) => [req.date, req.code, req.name, test.id, testParameter(test), test.result || "", test.notes || ""]));
  const dataHash = sha256(JSON.stringify({ patientRows, examRows, resultRows }));
  return [
    { name: `Pacientes_${monthName}`, rows: [["Fecha", "Codigo", "Codigo auxiliar", "Paciente", "Edad", "Genero", "Servicio", "Medico", "Cama"], ...patientRows] },
    { name: `Examenes_${monthName}`, rows: [["Fecha", "Codigo paciente", "Paciente", "Area", "Determinacion", "Clasificacion", "Parametro", "Tipo", "Muestra", "Unidad", "Minimo", "Maximo", "Referencia"], ...examRows] },
    { name: `Resultados_${monthName}`, rows: [["Fecha", "Codigo paciente", "Paciente", "ID prueba", "Parametro", "Resultado", "Observaciones"], ...resultRows] },
    { name: "Metadata", rows: [["Clave", "Valor"], ["fecha_exportacion", new Date().toISOString()], ["version_sistema", SYSTEM_VERSION], ["laboratorio_id", metadata.laboratorio_id || ""], ["hash_sha256_datos", dataHash], ["total_pacientes", patientRows.length], ["total_examenes", examRows.length], ["total_resultados", resultRows.length], ["total_registros", totalRecords]] }
  ];
}

async function exportYear(year) {
  const monthly = [];
  const db = openYearDb(year, year < new Date().getFullYear());
  const months = db.prepare("SELECT DISTINCT CAST(substr(fecha, 6, 2) AS INTEGER) AS mes FROM reportes WHERE substr(fecha, 1, 4) = ? ORDER BY mes").all(String(year)).map((row) => row.mes);
  db.close();
  for (const month of months) {
    const result = await exportMonth(year, month);
    if (result.totalRecords) monthly.push(result);
  }
  const rows = [["Mes", "Archivo", "Hash", "Registros"], ...monthly.map((item) => [item.fileName.slice(8, 10), item.fileName, item.hash, item.totalRecords])];
  const fileName = `${year}_Completo.xlsx`;
  const filePath = join(dirs.exports, fileName);
  await writeFile(filePath, excelXml([{ name: "Resumen_Anual", rows }]), "utf8");
  await subirANube(filePath, "Respaldos_Anuales");
  await logEvent("INFO", "EXPORTACION", `Exportacion anual generada: ${fileName}`);
  return { ok: true, fileName, filePath, months: monthly.length, syncStatus: await syncStatus() };
}

async function compressDb(year, month = "") {
  const ext = DatabaseSync ? ".db" : ".json";
  const source = join(dirs.db, `registros_${year}${ext}`);
  const target = join(dirs.exports, `registros_${year}${month ? `_Mes${String(month).padStart(2, "0")}` : ""}${ext}.zip`);
  await new Promise((resolve, reject) => {
    createReadStream(source).pipe(zlib.createGzip()).pipe(createWriteStream(target)).on("finish", resolve).on("error", reject);
  });
  return target;
}

async function subirANube(localPath, destination) {
  const syncConfig = await readJson(configPath("sync_config.json"), {});
  try {
    const targetDir = join(getCloudRootDir(), destination);
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, basename(localPath));
    await copyFile(localPath, target);
    syncConfig.ultima_sync = new Date().toISOString();
    await writeJson(configPath("sync_config.json"), syncConfig);
    await logEvent("INFO", "NUBE", `Archivo copiado a nube local (${destination}): ${basename(localPath)}`);
    return { ok: true, target };
  } catch (error) {
    syncConfig.pendientes ||= [];
    syncConfig.pendientes.push({ ruta_archivo_local: localPath, carpeta_destino_nube: destination, error: error.message, fecha: new Date().toISOString() });
    await writeJson(configPath("sync_config.json"), syncConfig);
    await logEvent("ERROR", "NUBE", `Fallo subida ${basename(localPath)}: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function syncStatus() {
  const syncConfig = await readJson(configPath("sync_config.json"), {});
  const logExists = await readJson(configPath("licencia.json"), defaultLicense());
  const pending = syncConfig.pendientes?.length || 0;
  if (SESSION.readOnly) return { estado: "restringido", texto: "Solo lectura por mantenimiento", ultima_sync: syncConfig.ultima_sync };
  if (pending) return { estado: "pendiente", texto: "Sincronizacion pendiente - Datos locales seguros", ultima_sync: syncConfig.ultima_sync };
  if (!syncConfig.link_carpeta) return { estado: "offline", texto: "Sin conexion - Trabajando en modo offline", ultima_sync: syncConfig.ultima_sync };
  return { estado: "sincronizado", texto: `Sincronizado - Ultimo respaldo: ${syncConfig.ultima_sync ? formatLocalDate(syncConfig.ultima_sync) : "pendiente"}`, ultima_sync: syncConfig.ultima_sync, licencia: logExists.estado };
}

async function technicalAction(action, payload = {}) {
  if (action === "renew") {
    const cloudPath = join(getCloudRootDir(), "config_sistema.json");
    const cloud = await readJson(cloudPath, {});
    const token = `CLB-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
    cloud.token_renovacion = token;
    cloud.fecha_ultima_renovacion = isoDate();
    await writeJson(cloudPath, cloud);
    await logEvent("INFO", "TECNICO", "Token de renovacion generado.");
    return { ok: true, token };
  }
  if (action === "forceSync") {
    const year = Number(payload.year || new Date().getFullYear());
    const db = openYearDb(year, year < new Date().getFullYear());
    const months = db.prepare("SELECT DISTINCT mes FROM sync_control WHERE anio = ? AND estado = 'pendiente'").all(year).map((row) => row.mes);
    db.close();
    const results = [];
    for (const month of months) results.push(await exportMonth(year, month));
    return { ok: true, processed: results.length, syncStatus: await syncStatus() };
  }
  if (action === "emergencyBackup") {
    try {
      await createAutomaticBackup();
      return { ok: true, message: "Respaldo de emergencia generado con éxito en Restauraciones de la nube." };
    } catch (err) {
      return { ok: false, message: "Fallo al generar respaldo: " + err.message };
    }
  }
  return { ok: false, message: "Accion no reconocida." };
}

async function createAutomaticBackup() {
  try {
    const syncConfig = await readJson(configPath("sync_config.json"), {});
    const cloudUrl = syncConfig.link_carpeta || "";
    if (!cloudUrl) return;
    
    const year = new Date().getFullYear();
    const ext = DatabaseSync ? ".db" : ".json";
    const source = join(dirs.db, `registros_${year}${ext}`);
    if (!existsSync(source)) return;
    
    const fileName = `respaldo_auto_${year}_${Date.now()}${ext}.gz`;
    const target = join(dirs.exports, fileName);
    
    await mkdir(dirs.exports, { recursive: true });
    await new Promise((resolve, reject) => {
      createReadStream(source)
        .pipe(zlib.createGzip())
        .pipe(createWriteStream(target))
        .on("finish", resolve)
        .on("error", reject);
    });
    
    await subirANube(target, "Restauraciones");
    await logEvent("INFO", "RESPALDO", `Respaldo automático de emergencia generado: ${fileName}`);
    
    // Clean up local target file in exports directory to save space
    await unlink(target).catch(() => {});
  } catch (error) {
    await logEvent("ERROR", "RESPALDO", `Fallo al generar respaldo automático: ${error.message}`);
  }
}

async function restoreScan(cloudUrl, token) {
  if (!cloudUrl) {
    return { ok: false, message: "El enlace de la carpeta en la nube es obligatorio." };
  }
  if (!token) {
    return { ok: false, message: "El token de enlazamiento es obligatorio para escanear y restaurar." };
  }
  
  const collabDir = join(cloudUrl, "Colaboracion");
  const cloudAccesoPath = join(collabDir, "acceso.json");
  if (!existsSync(cloudAccesoPath)) {
    return { ok: false, message: "No se encontraron datos de conexión colaborativos en la carpeta especificada (falta acceso.json)." };
  }
  
  try {
    const acceso = JSON.parse(readFileSync(cloudAccesoPath, "utf8")) || {};
    if (!acceso.token || acceso.token !== token) {
      return { ok: false, message: "Token de enlazamiento incorrecto o no coincide para esta carpeta." };
    }
  } catch (err) {
    return { ok: false, message: "No se pudo verificar el token de acceso: " + err.message };
  }

  const monthlyDir = join(cloudUrl, "Respaldos_Mensuales");
  const annualDir = join(cloudUrl, "Respaldos_Anuales");
  const restoreDir = join(cloudUrl, "Restauraciones");
  const files = [];
  for (const dir of [monthlyDir, annualDir, restoreDir]) {
    for (const file of await readdir(dir).catch(() => [])) {
      if (/\.(xlsx|xls|zip|gz)$/i.test(file)) files.push({ name: file, path: join(dir, file), type: basename(dir) });
    }
  }
  const years = files.map((file) => Number(file.name.match(/20\d{2}/)?.[0])).filter(Boolean);
  return { ok: true, files, summary: { count: files.length, from: years.length ? Math.min(...years) : null, to: years.length ? Math.max(...years) : null } };
}

async function readLog() {
  try {
    return { ok: true, text: await readFile(join(dirs.logs, "sync_log.txt"), "utf8") };
  } catch {
    return { ok: true, text: "" };
  }
}

async function acquireLock(lockName = "sync.lock") {
  const collabDir = getCollabDir();
  const lockPath = join(collabDir, lockName);
  const maxRetries = 15;
  const retryDelay = 200;
  const lockTimeout = 10000; // 10 seconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (existsSync(lockPath)) {
        const stats = await stat(lockPath);
        const age = Date.now() - stats.mtimeMs;
        if (age > lockTimeout) {
          try {
            await unlink(lockPath);
          } catch (e) {}
        } else {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
      }
      await mkdir(collabDir, { recursive: true });
      await writeFile(lockPath, JSON.stringify({ acquiredAt: Date.now(), terminal: "server" }), "utf8");
      return true;
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  return false;
}

async function releaseLock(lockName = "sync.lock") {
  const lockPath = join(getCollabDir(), lockName);
  try {
    if (existsSync(lockPath)) {
      await unlink(lockPath);
    }
  } catch (e) {}
}

async function executeCollabSync(clientPayload = null) {
  const year = new Date().getFullYear();
  const db = openYearDb(year);

  let localSettings = clientPayload?.settings || JSON.parse(db.prepare("SELECT valor FROM ajustes WHERE clave = 'settings'").get()?.valor || "null");
  let localRequests = clientPayload?.requests || db.prepare("SELECT payload FROM reportes ORDER BY fecha, codigo").all().map((row) => JSON.parse(row.payload));
  let localCatalog = clientPayload?.catalog || db.prepare("SELECT payload FROM catalogo").all().map((row) => JSON.parse(row.payload));
  let localLicense = await readJson(configPath("licencia.json"), defaultLicense());
  
  const collabEnabled = localSettings?.collabEnabled || false;
  const collabRole = localSettings?.collabRole || "main";
  const cloudUrl = localSettings?.cloudUrl || "";

  if (!collabEnabled || !cloudUrl) {
    db.close();
    return { ok: false, message: "Modo colaborativo no configurado o desactivado." };
  }

  const collabDir = getCollabDir();
  await mkdir(collabDir, { recursive: true });

  const cloudRequestsPath = join(collabDir, "reportes.json");
  const cloudCatalogPath = join(collabDir, "catalogo.json");
  const cloudAjustesPath = join(collabDir, "ajustes.json");
  const cloudLicenciaPath = join(collabDir, "licencia.json");
  const cloudTerminalesPath = join(collabDir, "terminales.json");
  const cloudAccesoPath = join(collabDir, "acceso.json");

  const locked = await acquireLock();
  if (!locked) {
    db.close();
    await logEvent("WARNING", "COLABORACION", "No se pudo adquirir el bloqueo de sincronización.");
    return { ok: false, message: "El canal de sincronización en la nube está ocupado. Intente de nuevo." };
  }

  // Verificar Token de Conexión para Seguridad
  const clientToken = clientPayload?.settings?.collabToken || localSettings?.collabToken || "";
  if (collabRole === "node") {
    if (!existsSync(cloudAccesoPath)) {
      await releaseLock();
      db.close();
      await logEvent("WARNING", "COLABORACION", "Intento de conexión a carpeta no inicializada.");
      return { ok: false, message: "La carpeta compartida no ha sido inicializada por la Unidad Principal. Inicie el modo colaborativo en el Servidor primero." };
    }
    try {
      const acceso = JSON.parse(await readFile(cloudAccesoPath, "utf8")) || {};
      if (!acceso.token || acceso.token !== clientToken) {
        await releaseLock();
        db.close();
        await logEvent("WARNING", "COLABORACION", "Intento de conexión con token inválido.");
        return { ok: false, message: "Acceso denegado: El token de conexión no coincide o no es válido para acceder a esta carpeta colaborativa." };
      }
    } catch (err) {
      await releaseLock();
      db.close();
      await logEvent("ERROR", "COLABORACION", `Error al verificar token: ${err.message}`);
      return { ok: false, message: "Error de seguridad: No se pudo verificar el token de acceso." };
    }
  } else if (collabRole === "main") {
    try {
      const labId = getMetadata(db, "laboratorio_id");
      await writeFile(cloudAccesoPath, JSON.stringify({ token: clientToken, labId }, null, 2), "utf8");
    } catch (err) {
      await logEvent("ERROR", "COLABORACION", `No se pudo escribir archivo de acceso: ${err.message}`);
    }
  }

  let cloudRequests = [];
  let cloudCatalog = [];
  let cloudSettings = {};
  let cloudLicense = {};
  let cloudTerminals = [];
  let cloudReadSuccess = false;

  try {
    if (existsSync(cloudRequestsPath)) {
      cloudRequests = JSON.parse(await readFile(cloudRequestsPath, "utf8")) || [];
    }
    if (existsSync(cloudCatalogPath)) {
      cloudCatalog = JSON.parse(await readFile(cloudCatalogPath, "utf8")) || [];
    }
    if (existsSync(cloudAjustesPath)) {
      cloudSettings = JSON.parse(await readFile(cloudAjustesPath, "utf8")) || {};
    }
    if (existsSync(cloudLicenciaPath)) {
      cloudLicense = JSON.parse(await readFile(cloudLicenciaPath, "utf8")) || {};
    }
    if (existsSync(cloudTerminalesPath)) {
      cloudTerminals = JSON.parse(await readFile(cloudTerminalesPath, "utf8")) || [];
    }
    cloudReadSuccess = true;
  } catch (err) {
    await logEvent("WARNING", "COLABORACION", `No se pudo leer el almacenamiento en la nube: ${err.message}. Guardando localmente.`);
  }

  const currentSyncConfig = await readJson(configPath("sync_config.json"), {});

  if (!cloudReadSuccess) {
    db.prepare("DELETE FROM reportes").run();
    db.prepare("DELETE FROM pacientes").run();
    db.prepare("DELETE FROM examenes").run();
    db.prepare("DELETE FROM resultados").run();
    
    const insertReport = db.prepare("INSERT OR REPLACE INTO reportes (codigo, fecha, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
    const insertPatient = db.prepare("INSERT OR REPLACE INTO pacientes (codigo, fecha, nombre, payload, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
    const insertExam = db.prepare("INSERT INTO examenes (paciente_codigo, test_id, fecha, nombre, area, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
    const insertResult = db.prepare("INSERT INTO resultados (paciente_codigo, test_id, fecha, resultado, observaciones, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");

    for (const req of localRequests) {
      insertReport.run(req.code, req.date, JSON.stringify(req));
      insertPatient.run(req.code, req.date, req.name, JSON.stringify(req));
      for (const test of req.tests || []) {
        insertExam.run(req.code, test.id, req.date, testParameter(test), test.area || "", JSON.stringify(test));
        insertResult.run(req.code, test.id, req.date, test.result || "", test.notes || "", JSON.stringify({ request: req.code, test }));
      }
    }
    
    if (clientPayload?.catalog) {
      db.prepare("DELETE FROM catalogo").run();
      const insertCatalog = db.prepare("INSERT OR REPLACE INTO catalogo (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
      for (const item of localCatalog) {
        insertCatalog.run(item.id, JSON.stringify(item));
      }
    }

    if (clientPayload?.settings) {
      const upsertSettings = db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('settings', ?)");
      upsertSettings.run(JSON.stringify(localSettings));
    }

    markMonthsPending(db, localRequests);
    db.close();
    await releaseLock();

    return {
      ok: true,
      settings: localSettings,
      requests: localRequests,
      catalog: localCatalog,
      license: localLicense,
      syncConfig: currentSyncConfig,
      syncStatus: {
        estado: "offline",
        texto: "Sin conexion - Trabajando en modo offline",
        ultima_sync: currentSyncConfig.ultima_sync,
        licencia: localLicense.estado
      },
      connectedTerminals: []
    };
  }

  try {
    const mergedRequestsMap = new Map();
    const getUpdatedAtTime = (req) => {
      if (!req || !req.reportUpdatedAt) return 0;
      return new Date(req.reportUpdatedAt).getTime() || 0;
    };

    for (const req of cloudRequests) {
      if (req && req.code) {
        mergedRequestsMap.set(req.code, req);
      }
    }

    for (const req of localRequests) {
      if (req && req.code) {
        const cloudReq = mergedRequestsMap.get(req.code);
        if (!cloudReq) {
          mergedRequestsMap.set(req.code, req);
        } else {
          const localTime = getUpdatedAtTime(req);
          const cloudTime = getUpdatedAtTime(cloudReq);
          if (localTime >= cloudTime) {
            mergedRequestsMap.set(req.code, req);
          }
        }
      }
    }
    const finalRequests = Array.from(mergedRequestsMap.values());

    let finalSettings = { ...localSettings };
    let finalCatalog = [...localCatalog];
    let finalLicense = { ...localLicense };

    if (collabRole === "main") {
      finalSettings = localSettings;
      finalCatalog = localCatalog;
      finalLicense = localLicense;

      try {
        await writeFile(cloudAjustesPath, JSON.stringify(finalSettings, null, 2), "utf8");
        await writeFile(cloudCatalogPath, JSON.stringify(finalCatalog, null, 2), "utf8");
        await writeFile(cloudLicenciaPath, JSON.stringify(finalLicense, null, 2), "utf8");
      } catch (err) {
        await logEvent("ERROR", "COLABORACION", `Error al escribir configuraciones en la nube: ${err.message}`);
      }
    } else {
      if (Object.keys(cloudSettings).length > 0) {
        finalSettings = {
          ...cloudSettings,
          collabTerminalName: localSettings.collabTerminalName,
          collabTerminalId: localSettings.collabTerminalId,
          collabRole: "node",
          collabEnabled: true,
          cloudUrl: cloudUrl
        };
      }
      if (cloudCatalog.length > 0) {
        finalCatalog = cloudCatalog;
      }
      if (Object.keys(cloudLicense).length > 0) {
        finalLicense = cloudLicense;
      }
    }

    if (collabRole === "node" && localSettings?.collabTerminalName) {
      const terminalId = localSettings.collabTerminalId || "unknown";
      const existingIdx = cloudTerminals.findIndex(t => t.id === terminalId);
      const updatedTerminal = {
        id: terminalId,
        name: localSettings.collabTerminalName,
        lastSync: new Date().toISOString()
      };
      if (existingIdx > -1) {
        cloudTerminals[existingIdx] = updatedTerminal;
      } else {
        cloudTerminals.push(updatedTerminal);
      }
      cloudTerminals = cloudTerminals.filter(t => Date.now() - new Date(t.lastSync).getTime() < 30 * 24 * 60 * 60 * 1000);
      try {
        await writeFile(cloudTerminalesPath, JSON.stringify(cloudTerminals, null, 2), "utf8");
      } catch (err) {
        await logEvent("ERROR", "COLABORACION", `Fallo al registrar terminal en la nube: ${err.message}`);
      }
    }

    try {
      await writeFile(cloudRequestsPath, JSON.stringify(finalRequests, null, 2), "utf8");
    } catch (err) {
      await logEvent("ERROR", "COLABORACION", `Error al escribir reportes en la nube: ${err.message}`);
    }

    db.prepare("DELETE FROM reportes").run();
    db.prepare("DELETE FROM pacientes").run();
    db.prepare("DELETE FROM examenes").run();
    db.prepare("DELETE FROM resultados").run();
    db.prepare("DELETE FROM catalogo").run();

    const insertReport = db.prepare("INSERT OR REPLACE INTO reportes (codigo, fecha, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
    const insertPatient = db.prepare("INSERT OR REPLACE INTO pacientes (codigo, fecha, nombre, payload, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
    const insertExam = db.prepare("INSERT INTO examenes (paciente_codigo, test_id, fecha, nombre, area, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
    const insertResult = db.prepare("INSERT INTO resultados (paciente_codigo, test_id, fecha, resultado, observaciones, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");

    for (const req of finalRequests) {
      insertReport.run(req.code, req.date, JSON.stringify(req));
      insertPatient.run(req.code, req.date, req.name, JSON.stringify(req));
      for (const test of req.tests || []) {
        insertExam.run(req.code, test.id, req.date, testParameter(test), test.area || "", JSON.stringify(test));
        insertResult.run(req.code, test.id, req.date, test.result || "", test.notes || "", JSON.stringify({ request: req.code, test }));
      }
    }

    const insertCatalog = db.prepare("INSERT OR REPLACE INTO catalogo (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
    for (const item of finalCatalog) {
      insertCatalog.run(item.id, JSON.stringify(item));
    }

    const upsertSettings = db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('settings', ?)");
    upsertSettings.run(JSON.stringify(finalSettings));

    markMonthsPending(db, finalRequests);
    db.close();

    await writeJson(configPath("licencia.json"), finalLicense);

    const nextSyncConfig = {
      ...currentSyncConfig,
      ultima_sync: new Date().toISOString()
    };
    await writeJson(configPath("sync_config.json"), nextSyncConfig);

    await logEvent("INFO", "COLABORACION", `Sincronizacion completada para: ${collabRole}.`);
    createAutomaticBackup().catch(err => console.error("Fallo al generar respaldo automático:", err));
    await releaseLock();

    return {
      ok: true,
      settings: finalSettings,
      requests: finalRequests,
      catalog: finalCatalog,
      license: finalLicense,
      syncConfig: nextSyncConfig,
      syncStatus: {
        estado: "sincronizado",
        texto: `Sincronizado - Ultimo respaldo: ${formatLocalDate(nextSyncConfig.ultima_sync)}`,
        ultima_sync: nextSyncConfig.ultima_sync,
        licencia: finalLicense.estado
      },
      connectedTerminals: cloudTerminals
    };
  } catch (error) {
    await logEvent("ERROR", "COLABORACION", `Error en executeCollabSync: ${error.message}`);
    db.close();
    await releaseLock();
    throw error;
  }
}

function excelXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${sheets.map((sheet) => `<Worksheet ss:Name="${escapeXml(sheet.name).slice(0, 31)}"><Table>${sheet.rows.map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell ?? "")}</Data></Cell>`).join("")}</Row>`).join("")}</Table></Worksheet>`).join("")}</Workbook>`;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function formatLocalDate(value) {
  return new Date(value).toLocaleDateString("es-BO", { day: "2-digit", month: "2-digit", year: "numeric" });
}

async function jsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/bootstrap") return sendJson(res, 200, await bootstrap());
    if (url.pathname === "/api/delete" && req.method === "POST") {
      const { code } = await jsonBody(req);
      const db = openYearDb(new Date().getFullYear());
      db.prepare("DELETE FROM examenes WHERE paciente_codigo = ?").run(code);
      db.prepare("DELETE FROM resultados WHERE paciente_codigo = ?").run(code);
      db.prepare("DELETE FROM pacientes WHERE codigo = ?").run(code);
      db.prepare("DELETE FROM reportes WHERE codigo = ?").run(code);
      db.close();
      if (isTursoConfigured()) {
        try {
          await tursoDelete(code);
        } catch (e) {
          console.warn("[Turso] Error al eliminar en Turso:", e.message);
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/search") {
      const code = url.searchParams.get("code") || "";
      const searchTxt = url.searchParams.get("q") || "";
      let found = [];

      if (isTursoConfigured()) {
        try {
          const cloudResults = await tursoSearch(searchTxt, code);
          if (cloudResults && cloudResults.length > 0) {
            return sendJson(res, 200, cloudResults);
          }
        } catch (e) {
          console.warn("[Turso] Error al buscar en Turso, buscando en local:", e.message);
        }
      }

      const db = openYearDb(new Date().getFullYear());
      let sql = "SELECT payload FROM reportes WHERE 1=1";
      const params = [];
      if (code) { sql += " AND codigo = ?"; params.push(code); }
      if (searchTxt) { sql += " AND payload LIKE ?"; params.push('%' + searchTxt + '%'); }
      const local = db.prepare(sql).all(...params).map(r => JSON.parse(r.payload));
      db.close();
      
      found.push(...local);
      
      const archiveFile = join(appDataRoot, "archivos_lectura", "archived_records.json");
      if (existsSync(archiveFile)) {
        const archived = JSON.parse(await readFile(archiveFile, "utf8"));
        const archFound = archived.filter(r => {
          if (code && r.code !== code) return false;
          if (searchTxt && !JSON.stringify(r).toLowerCase().includes(searchTxt.toLowerCase())) return false;
          return true;
        });
        found.push(...archFound);
      }
      return sendJson(res, 200, found);
    }
    if (url.pathname === "/api/save" && req.method === "POST") {
      const payload = await jsonBody(req);
      return sendJson(res, 200, await savePayload(payload));
    }
    if (url.pathname === "/api/sync-config" && req.method === "POST") return sendJson(res, 200, await saveSyncConfig(await jsonBody(req)));
    if (url.pathname === "/api/export/month" && req.method === "POST") {
      const body = await jsonBody(req);
      return sendJson(res, 200, await exportMonth(Number(body.anio), Number(body.mes)));
    }
    if (url.pathname === "/api/export/year" && req.method === "POST") return sendJson(res, 200, await exportYear(Number((await jsonBody(req)).anio)));
    if (url.pathname === "/api/sync/status") return sendJson(res, 200, await syncStatus());
    if (url.pathname === "/api/logs") return sendJson(res, 200, await readLog());
    if (url.pathname === "/api/technical" && req.method === "POST") {
      const body = await jsonBody(req);
      return sendJson(res, 200, await technicalAction(body.action, body));
    }
    if (url.pathname === "/api/technical/factory-reset" && req.method === "POST") {
      try {
        const ext = DatabaseSync ? ".db" : ".json";
        const files = await readdir(dirs.db).catch(() => []);
        for (const file of files) {
          await unlink(join(dirs.db, file)).catch(() => {});
        }
        
        await writeJson(configPath("sistema.json"), {
          version_sistema: SYSTEM_VERSION,
          contacto_tecnico: { nombre: "Administrador", telefono: "+591XXXXXXXX", correo: "administrador@ejemplo.com" },
          proveedor_preferido: "googledrive"
        });
        
        await writeJson(configPath("sync_config.json"), {
          proveedor: "googledrive",
          link_carpeta: "",
          carpeta_id: "",
          ultima_sync: null,
          token_api: "",
          pendientes: []
        });
        
        await writeJson(configPath("licencia.json"), defaultLicense());
        
        await writeFile(join(dirs.logs, "sync_log.txt"), "", "utf8").catch(() => {});
        
        const year = new Date().getFullYear();
        await writeFile(join(dirs.db, "registros_activos.db"), `registros_${year}${ext}`, "utf8");
        
        // Re-open DB to initialize schema
        const db = openYearDb(year);
        db.close();
        
        await logEvent("INFO", "TECNICO", "Restablecimiento de fabrica realizado.");
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: "Fallo al realizar restablecimiento de fábrica: " + err.message });
      }
    }
    return sendJson(res, 404, { ok: false, message: "API no encontrada" });
  } catch (error) {
    await logEvent("ERROR", "API", `${url.pathname}: ${error.message}`).catch(() => {});
    return sendJson(res, 500, { ok: false, message: error.message });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  try {
    const clean = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^[/\\]+/, "");
    const file = join(root, clean);
    if (!file.startsWith(root)) throw new Error("Ruta no permitida");
    const body = await readFile(file);
    const contentType = types[extname(file)] || "application/octet-stream";
    const cacheControl = [".html", ".js", ".css"].includes(extname(file)) ? "no-store" : "public, max-age=300";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
  }
}).listen(port, () => {
  console.log(`ClinLab Suite listo en http://localhost:${port}`);
});
