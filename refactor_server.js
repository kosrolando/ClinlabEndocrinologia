const fs = require('fs');
const path = require('path');

let content = fs.readFileSync('server.mjs', 'utf8');

// 1. Remove ensureCloudStructure call
content = content.replace('  await ensureCloudStructure();', '  await archiveOldRecords();');

// 2. Add archiveOldRecords function
const archiveFunction = `
async function archiveOldRecords() {
  try {
    const year = new Date().getFullYear();
    const db = openYearDb(year);
    const date3Months = new Date();
    date3Months.setMonth(date3Months.getMonth() - 3);
    const date12Months = new Date();
    date12Months.setMonth(date12Months.getMonth() - 12);
    
    const str3M = date3Months.toISOString().slice(0, 10);
    const str12M = date12Months.toISOString().slice(0, 10);
    
    // Delete > 12 months
    db.prepare("DELETE FROM examenes WHERE paciente_codigo IN (SELECT codigo FROM pacientes WHERE fecha < ?)").run(str12M);
    db.prepare("DELETE FROM resultados WHERE paciente_codigo IN (SELECT codigo FROM pacientes WHERE fecha < ?)").run(str12M);
    db.prepare("DELETE FROM pacientes WHERE fecha < ?").run(str12M);
    db.prepare("DELETE FROM reportes WHERE fecha < ?").run(str12M);
    
    // Archive 3 to 12 months
    const toArchive = db.prepare("SELECT * FROM reportes WHERE fecha >= ? AND fecha < ?").all(str12M, str3M);
    if (toArchive.length > 0) {
      const archiveDir = join(appDataRoot, "archivos_lectura");
      await mkdir(archiveDir, { recursive: true }).catch(() => {});
      const archiveFile = join(archiveDir, "archived_records.json");
      let archivedData = [];
      if (existsSync(archiveFile)) {
        archivedData = JSON.parse(await readFile(archiveFile, "utf8"));
      }
      
      const toArchiveCodes = toArchive.map(r => r.codigo);
      for (const row of toArchive) {
        if (!archivedData.some(a => a.codigo === row.codigo)) {
          archivedData.push(JSON.parse(row.payload));
        }
      }
      await writeFile(archiveFile, JSON.stringify(archivedData, null, 2), "utf8");
      
      // Delete from active DB
      db.prepare("DELETE FROM examenes WHERE paciente_codigo IN (SELECT codigo FROM pacientes WHERE fecha >= ? AND fecha < ?)").run(str12M, str3M);
      db.prepare("DELETE FROM resultados WHERE paciente_codigo IN (SELECT codigo FROM pacientes WHERE fecha >= ? AND fecha < ?)").run(str12M, str3M);
      db.prepare("DELETE FROM pacientes WHERE fecha >= ? AND fecha < ?").run(str12M, str3M);
      db.prepare("DELETE FROM reportes WHERE fecha >= ? AND fecha < ?").run(str12M, str3M);
      
      console.log(\`Archivados \${toArchive.length} registros (antiguedad 3-12 meses).\`);
    }
    db.close();
  } catch (err) {
    console.error("Error en archivado:", err);
  }
}
`;
content = content.replace('async function ensureJson(path, fallback)', archiveFunction + '\nasync function ensureJson(path, fallback)');

// 3. Fix defaultLicense
content = content.replace(
  /function defaultLicense\(\) \{[\s\S]*?\}/,
  `function defaultLicense() {
  return { fecha_activacion: isoDate(), fecha_vencimiento: "2099-12-31", estado: "activo", token_actual: "ILIMITADO", renovaciones: [] };
}`
);

// 4. Fix verifyLicense
content = content.replace(
  /async function verifyLicense\(inputToken = ""\) \{[\s\S]*?return \{[\s\S]*?\}\n\}/,
  `async function verifyLicense(inputToken = "") {
  return {
    ok: true,
    estado: "activo",
    dias_transcurridos: 1,
    dias_restantes: 9999,
    mostrar_aviso: false,
    license: defaultLicense(),
    contacto_tecnico: { nombre: "Administrador", telefono: "+5910000000", correo: "admin@ejemplo.com" }
  };
}`
);

// 5. Fix bootstrap requests (only last 3 months)
content = content.replace(
  'const requests = db.prepare("SELECT payload FROM reportes ORDER BY fecha, codigo").all().map((row) => JSON.parse(row.payload));',
  `const date3Months = new Date();
  date3Months.setMonth(date3Months.getMonth() - 3);
  const str3M = date3Months.toISOString().slice(0, 10);
  const requests = db.prepare("SELECT payload FROM reportes WHERE fecha >= ? ORDER BY fecha, codigo").all(str3M).map((row) => JSON.parse(row.payload));`
);

// 6. Fix savePayload
const oldSavePayload = `  const tx = db.prepare("DELETE FROM reportes");
  tx.run();
  db.prepare("DELETE FROM pacientes").run();
  db.prepare("DELETE FROM examenes").run();
  db.prepare("DELETE FROM resultados").run();
  db.prepare("DELETE FROM catalogo").run();`;

const newSavePayload = `  // Removed massive DELETE to allow unlimited storage scale and prevent wiping out active records incorrectly
  db.prepare("DELETE FROM catalogo").run();`;

content = content.replace(oldSavePayload, newSavePayload);

const oldSaveLoop = `  for (const req of payload.requests || []) {
    insertReport.run(req.code, req.date, JSON.stringify(req));
    insertPatient.run(req.code, req.date, req.name, JSON.stringify(req));
    for (const test of req.tests || []) {`;

const newSaveLoop = `  const deleteExams = db.prepare("DELETE FROM examenes WHERE paciente_codigo = ?");
  const deleteResults = db.prepare("DELETE FROM resultados WHERE paciente_codigo = ?");
  for (const req of payload.requests || []) {
    insertReport.run(req.code, req.date, JSON.stringify(req));
    insertPatient.run(req.code, req.date, req.name, JSON.stringify(req));
    deleteExams.run(req.code);
    deleteResults.run(req.code);
    for (const test of req.tests || []) {`;

content = content.replace(oldSaveLoop, newSaveLoop);

content = content.replace(
  '  if (SESSION.readOnly) return { ok: false, readOnly: true, message: "Sistema en modo solo lectura por licencia vencida." };',
  ''
);

// 7. Fix handleApi
const searchAndDeleteEndpoints = `
    if (url.pathname === "/api/delete" && req.method === "POST") {
      const { code } = await jsonBody(req);
      const db = openYearDb(new Date().getFullYear());
      db.prepare("DELETE FROM examenes WHERE paciente_codigo = ?").run(code);
      db.prepare("DELETE FROM resultados WHERE paciente_codigo = ?").run(code);
      db.prepare("DELETE FROM pacientes WHERE codigo = ?").run(code);
      db.prepare("DELETE FROM reportes WHERE codigo = ?").run(code);
      db.close();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/search") {
      const code = url.searchParams.get("code") || "";
      const searchTxt = url.searchParams.get("q") || "";
      let found = [];
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
`;

// We will replace all collab endpoints in handleApi
content = content.replace(/    if \(url\.pathname === "\/api\/collab\/bootstrap-sync"[\s\S]*?    if \(url\.pathname === "\/api\/save" && req\.method === "POST"\) \{/, searchAndDeleteEndpoints + '    if (url.pathname === "/api/save" && req.method === "POST") {');

// Remove collab logic from save
content = content.replace(/      try \{[\s\S]*?const settings = settingsStr \? JSON\.parse\(settingsStr\) : \{\};\n        if \(settings\.collabEnabled && settings\.cloudUrl\) \{\n          const syncResult = await executeCollabSync\(payload\);\n          if \(syncResult\.ok\) \{\n            return sendJson\(res, 200, syncResult\);\n          \}\n        \}\n      \} catch \(err\) \{\n        console\.error\("Collab sync during save failed, falling back to local save:", err\);\n      \}/, '');

// Remove restore endpoints
content = content.replace(/    if \(url\.pathname === "\/api\/restore\/scan"[\s\S]*?    if \(url\.pathname === "\/api\/technical\/factory-reset"/, '    if (url.pathname === "/api/technical/factory-reset"');

fs.writeFileSync('server.mjs', content);
console.log('Done refactoring server.mjs');
