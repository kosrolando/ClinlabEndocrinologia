const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function getRequestPeriod(dateStr) {
  if (!dateStr) return "sin_fecha";
  const parts = dateStr.split("-");
  if (parts.length >= 2) {
    return `${parts[0]}_${parts[1]}`;
  }
  return "sin_fecha";
}

function parseChronologicalKey(dateStr) {
  if (!dateStr || typeof dateStr !== "string") {
    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return { year: y, month: m, day: d, period: `${y}_${m}`, fullDate: `${y}-${m}-${d}` };
  }
  const parts = dateStr.split("-");
  const y = parts[0] || "sin_fecha";
  const m = parts[1] || "01";
  const d = parts[2] || "01";
  return {
    year: y,
    month: m,
    day: d,
    period: `${y}_${m}`,
    fullDate: `${y}-${m}-${d}`
  };
}

function groupRequestsChronologically(requests) {
  const tree = {};
  for (const req of requests || []) {
    if (!req) continue;
    const { year, month, day } = parseChronologicalKey(req.date);
    tree[year] ||= {};
    tree[year][month] ||= {};
    tree[year][month][day] ||= [];
    tree[year][month][day].push(req);
  }
  return tree;
}

const requestsIDB = {
  dbName: "ClinLabRequestsStorageDB",
  storeName: "requestsStore",
  chronoStoreName: "chronologicalStore",
  _cachedAll: null,
  
  getDB() {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !window.indexedDB) return resolve(null);
      const req = indexedDB.open(this.dbName, 2);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
          if (!db.objectStoreNames.contains(this.chronoStoreName)) {
            db.createObjectStore(this.chronoStoreName);
          }
        } catch (err) {
          console.warn("[Storage Shield] Upgrade store error:", err);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  },

  async saveAll(requests) {
    if (!Array.isArray(requests)) return;
    this._cachedAll = requests;
    try {
      const db = await this.getDB();
      if (!db) return;
      
      const chronological = groupRequestsChronologically(requests);
      
      return new Promise((resolve) => {
        const tx = db.transaction([this.storeName, this.chronoStoreName], "readwrite");
        const reqStore = tx.objectStore(this.storeName);
        const chronoStore = tx.objectStore(this.chronoStoreName);
        
        reqStore.put(requests, "all_requests");
        reqStore.put({
          updatedAt: new Date().toISOString(),
          total: requests.length
        }, "metadata");
        
        chronoStore.clear();
        for (const [year, months] of Object.entries(chronological)) {
          for (const [month, days] of Object.entries(months)) {
            for (const [day, dayReqs] of Object.entries(days)) {
              chronoStore.put(dayReqs, `${year}_${month}_${day}`);
            }
          }
        }
        
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) {
      console.warn("[Storage Shield] IndexedDB save error:", e);
    }
  },

  async loadAll() {
    if (this._cachedAll && this._cachedAll.length > 0) return this._cachedAll;
    try {
      const db = await this.getDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, "readonly");
        const req = tx.objectStore(this.storeName).get("all_requests");
        req.onsuccess = () => {
          const res = req.result || [];
          this._cachedAll = res;
          resolve(res);
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  },

  async loadByPeriod(yearFilter, monthFilter, dayFilter) {
    const all = await this.loadAll() || [];
    return all.filter((req) => {
      if (!req || !req.date) return false;
      const { year, month, day } = parseChronologicalKey(req.date);
      if (yearFilter && year !== yearFilter) return false;
      if (monthFilter && month !== monthFilter) return false;
      if (dayFilter && day !== dayFilter) return false;
      return true;
    });
  },

  async search(query) {
    if (!query) return [];
    const q = String(query).toLowerCase().trim();
    const all = await this.loadAll() || [];
    return all.filter((req) => {
      if (!req) return false;
      return (
        (req.name && req.name.toLowerCase().includes(q)) ||
        (req.code && req.code.toLowerCase().includes(q)) ||
        (req.insuranceCode && req.insuranceCode.toLowerCase().includes(q)) ||
        (req.date && req.date.includes(q))
      );
    });
  },

  async getChronologicalTree() {
    const all = await this.loadAll() || [];
    const tree = {};
    const now = Date.now();
    const MS_90 = 90 * 24 * 60 * 60 * 1000;
    const MS_365 = 365 * 24 * 60 * 60 * 1000;
    
    let activeCount = 0;
    let archiveCount = 0;
    let expiredCount = 0;

    for (const req of all) {
      if (!req) continue;
      const { year, month, day } = parseChronologicalKey(req.date);
      tree[year] ||= {};
      tree[year][month] ||= new Set();
      tree[year][month].add(day);

      let reqTime = 0;
      if (req.date) {
        const [y, m, d] = req.date.split("-").map(Number);
        reqTime = new Date(y, (m || 1) - 1, d || 1).getTime();
      }
      const age = now - reqTime;
      if (age <= MS_90) activeCount++;
      else if (age <= MS_365) archiveCount++;
      else expiredCount++;
    }

    const formattedTree = {};
    for (const y of Object.keys(tree).sort().reverse()) {
      formattedTree[y] = {};
      for (const m of Object.keys(tree[y]).sort().reverse()) {
        formattedTree[y][m] = Array.from(tree[y][m]).sort().reverse();
      }
    }

    return {
      tree: formattedTree,
      totalCount: all.length,
      activeCount,
      archiveCount,
      expiredCount
    };
  }
};

function loadAllLocalRequests() {
  let index = [];
  try {
    index = JSON.parse(localStorage.getItem("clinlab.requests.index")) || [];
  } catch (e) {
    index = [];
  }
  let allRequests = [];
  for (const period of index) {
    try {
      const reqs = JSON.parse(localStorage.getItem(`clinlab.requests.${period}`)) || [];
      allRequests = allRequests.concat(reqs);
    } catch (e) {}
  }
  
  // Migration fallback
  const oldReqs = localStorage.getItem("clinlab.requests");
  if (oldReqs) {
    try {
      const parsedOld = JSON.parse(oldReqs) || [];
      if (parsedOld.length > 0 && allRequests.length === 0) {
        const groups = {};
        for (const req of parsedOld) {
          const p = getRequestPeriod(req.date);
          groups[p] ||= [];
          groups[p].push(req);
        }
        const newIndex = Object.keys(groups);
        localStorage.setItem("clinlab.requests.index", JSON.stringify(newIndex));
        for (const p of newIndex) {
          localStorage.setItem(`clinlab.requests.${p}`, JSON.stringify(groups[p]));
        }
        allRequests = parsedOld;
        localStorage.removeItem("clinlab.requests");
        console.log("Migración a almacenamiento mensual completada.");
      }
    } catch (e) {
      console.error("Error al migrar datos antiguos:", e);
    }
  }
  
  return allRequests;
}

function saveLocalRequestsSegregated(requests) {
  try {
    // Guaranteed high-capacity backup to IndexedDB
    requestsIDB.saveAll(requests);

    const groups = {};
    for (const req of requests) {
      const p = getRequestPeriod(req.date);
      groups[p] ||= [];
      groups[p].push(req);
    }
    
    const newIndex = Object.keys(groups);
    let oldIndex = [];
    try {
      oldIndex = JSON.parse(localStorage.getItem("clinlab.requests.index")) || [];
    } catch (e) {
      oldIndex = [];
    }
    
    for (const p of oldIndex) {
      if (!newIndex.includes(p)) {
        try {
          localStorage.removeItem(`clinlab.requests.${p}`);
        } catch (e) {}
      }
    }
    
    try {
      localStorage.setItem("clinlab.requests.index", JSON.stringify(newIndex));
    } catch (e) {
      console.warn("[Storage Shield] No se pudo guardar el índice de peticiones:", e);
    }
    for (const p of newIndex) {
      try {
        localStorage.setItem(`clinlab.requests.${p}`, JSON.stringify(groups[p]));
      } catch (e) {
        if (e.name === "QuotaExceededError" || e.code === 22) {
          console.error(`[Storage Shield] CUOTA EXCEDIDA al guardar periodo ${p}. Los datos están respaldados en IndexedDB.`);
        } else {
          console.warn(`[Storage Shield] No se pudo guardar la petición para el periodo ${p} en LocalStorage (respaldado en IndexedDB):`, e);
        }
      }
    }
  } catch (err) {
    console.error("[Storage Shield] Error inesperado en saveLocalRequestsSegregated:", err);
  }
}

async function listCloudReportFiles(dirHandle) {
  const files = [];
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "file" && entry.name.startsWith("reportes_") && entry.name.endsWith(".json")) {
        files.push(entry.name);
      }
    }
  } catch (err) {
    console.error("Error listando archivos de reportes en la nube:", err);
  }
  return files;
}

const store = {
  get(key, fallback) {
    try {
      if (key === "clinlab.requests") {
        return loadAllLocalRequests();
      }
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (key === "clinlab.requests") {
        saveLocalRequestsSegregated(value);
        return;
      }
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      if (e.name === "QuotaExceededError" || e.code === 22) {
        console.warn(`[Storage Shield] Capacidad local maxima alcanzada para ${key}. Datos mantenidos en RAM y respaldados por SQLite.`);
      }
    }
  }
};

// Browser-based folder synchronization using File System Access API
let syncDirHandle = null;

const folderSyncDB = {
  dbName: "ClinLabFolderSync",
  storeName: "handles",
  
  getDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  
  async saveHandle(handle) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(handle, "syncDir");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  
  async loadHandle() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get("syncDir");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async clearHandle() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).delete("syncDir");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

async function verifyPermission(fileHandle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = "readwrite";
  }
  if ((await fileHandle.queryPermission(options)) === "granted") {
    return true;
  }
  if ((await fileHandle.requestPermission(options)) === "granted") {
    return true;
  }
  return false;
}

async function writeDirFile(dirHandle, filename, content) {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch (err) {
    console.error(`Error escribiendo archivo ${filename} en carpeta compartida:`, err);
    return false;
  }
}

async function readDirFile(dirHandle, filename) {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch (err) {
    console.warn(`Archivo ${filename} no encontrado o ilegible en carpeta compartida:`, err);
    return null;
  }
}

async function initBrowserFolderSync() {
  if (typeof window.showDirectoryPicker !== "function") {
    const section = $("#localFolderSyncSection");
    if (section) section.style.display = "none";
    return;
  }
  
  if (!backendReady) {
    const section = $("#localFolderSyncSection");
    if (section) section.style.display = "flex";
  } else {
    const section = $("#localFolderSyncSection");
    if (section) section.style.display = "none";
    return;
  }
  
  try {
    syncDirHandle = await folderSyncDB.loadHandle();
    if (syncDirHandle) {
      const options = { mode: "readwrite" };
      if ((await syncDirHandle.queryPermission(options)) === "granted") {
        $("#syncFolderStatusText").innerHTML = `<span style="color:#10b981; font-weight:bold;">🟢 Vinculada:</span> ${syncDirHandle.name}`;
        const restoreBtn = $("#restoreFolderAccessBtn");
        if (restoreBtn) restoreBtn.style.display = "none";
        performBrowserFolderSync();
      } else {
        $("#syncFolderStatusText").innerHTML = `<span style="color:#f97316; font-weight:bold;">🟡 Requiere permiso:</span> ${syncDirHandle.name}`;
        const restoreBtn = $("#restoreFolderAccessBtn");
        if (restoreBtn) restoreBtn.style.display = "block";
      }
    } else {
      $("#syncFolderStatusText").innerHTML = `<span style="color:#ef4444; font-weight:bold;">🔴 Sin vincular</span>`;
      const restoreBtn = $("#restoreFolderAccessBtn");
      if (restoreBtn) restoreBtn.style.display = "none";
    }
  } catch (err) {
    console.error("Error al cargar manejador de carpeta:", err);
  }
}

async function performBrowserFolderSync() {
  if (!syncDirHandle) return;
  
  const hasPerm = await verifyPermission(syncDirHandle, true);
  if (!hasPerm) {
    updateSyncIndicator({ estado: "offline", texto: "Sin acceso a la carpeta de la nube - Permiso denegado" });
    const restoreBtn = $("#restoreFolderAccessBtn");
    if (restoreBtn) restoreBtn.style.display = "block";
    return;
  }
  
  const restoreBtn = $("#restoreFolderAccessBtn");
  if (restoreBtn) restoreBtn.style.display = "none";
  
  updateSyncIndicator({ estado: "pendiente", texto: "Sincronizando carpeta en segundo plano..." });
  
  try {
    const isNode = state.settings.collabRole === "node";
    
    let cloudCatalog = [];
    let cloudSettings = {};
    let cloudLicense = null;
    
    if (isNode) {
      cloudCatalog = await readDirFile(syncDirHandle, "catalogo.json") || [];
      cloudSettings = await readDirFile(syncDirHandle, "ajustes.json") || {};
      cloudLicense = await readDirFile(syncDirHandle, "licencia.json");
      
      if (cloudCatalog.length > 0) {
        catalog = normalizeCatalogList(cloudCatalog);
        store.set("clinlab.catalog", catalog);
      }
      if (Object.keys(cloudSettings).length > 0) {
        const originalRole = state.settings.collabRole;
        const originalTerminalId = state.settings.collabTerminalId;
        const originalTerminalName = state.settings.collabTerminalName;
        const originalLocalAccepted = state.settings.localAccepted;
        const originalCloudUrl = state.settings.cloudUrl;
        
        Object.assign(state.settings, cloudSettings);
        state.settings.collabRole = originalRole;
        state.settings.collabTerminalId = originalTerminalId;
        state.settings.collabTerminalName = originalTerminalName;
        state.settings.localAccepted = originalLocalAccepted;
        state.settings.cloudUrl = originalCloudUrl;
        
        store.set("clinlab.settings", state.settings);
      }
      if (cloudLicense) {
        licenseState = cloudLicense;
        store.set("clinlab.license", licenseState);
        handleLicenseState(licenseState);
      }
    } else {
      let localLicense = store.get("clinlab.license", null);
      if (!localLicense) {
        const now = today();
        localLicense = { 
          fecha_activacion: now, 
          fecha_vencimiento: addDays(now, 60), 
          estado: "activo", 
          token_actual: "", 
          renovaciones: [] 
        };
        store.set("clinlab.license", localLicense);
      }
      licenseState = localLicense;
      handleLicenseState(licenseState);
      
      await writeDirFile(syncDirHandle, "catalogo.json", JSON.stringify(catalog, null, 2));
      await writeDirFile(syncDirHandle, "ajustes.json", JSON.stringify(state.settings, null, 2));
      await writeDirFile(syncDirHandle, "licencia.json", JSON.stringify(licenseState, null, 2));
    }
    
    const cloudReportFiles = await listCloudReportFiles(syncDirHandle);
    const localIndex = JSON.parse(localStorage.getItem("clinlab.requests.index")) || [];
    
    const allCloudReqs = {};
    for (const filename of cloudReportFiles) {
      const match = filename.match(/reportes_(\d{4}_\d{2})\.json/);
      if (match) {
        const period = match[1];
        const reqs = await readDirFile(syncDirHandle, filename) || [];
        allCloudReqs[period] = reqs;
      }
    }
    
    const localGroups = {};
    for (const period of localIndex) {
      localGroups[period] = JSON.parse(localStorage.getItem(`clinlab.requests.${period}`)) || [];
    }
    
    const allPeriods = new Set([...Object.keys(allCloudReqs), ...Object.keys(localGroups)]);
    let finalRequests = [];
    
    for (const period of allPeriods) {
      const localReqs = localGroups[period] || [];
      const cloudReqs = allCloudReqs[period] || [];
      const mergedReqs = mergeRequests(localReqs, cloudReqs);
      
      await writeDirFile(syncDirHandle, `reportes_${period}.json`, JSON.stringify(mergedReqs, null, 2));
      
      localStorage.setItem(`clinlab.requests.${period}`, JSON.stringify(mergedReqs));
      finalRequests = finalRequests.concat(mergedReqs);
    }
    
    localStorage.setItem("clinlab.requests.index", JSON.stringify(Array.from(allPeriods)));
    state.requests = finalRequests;
    
    await writeDirFile(syncDirHandle, "acceso.json", JSON.stringify({ initializedAt: new Date().toISOString(), mode: "browser-direct" }, null, 2));
    
    updateSyncIndicator({ 
      estado: "sincronizado", 
      texto: `Sincronizado con carpeta - Respaldo: ${new Date().toLocaleDateString("es-BO")}` 
    });
    
    renderAll();
  } catch (err) {
    console.error("Fallo al realizar la sincronización de carpeta en segundo plano:", err);
    updateSyncIndicator({ estado: "offline", texto: "Error al sincronizar con la carpeta local" });
  }
}

function mergeRequests(local, cloud) {
  const merged = new Map();
  const getUpdateTime = (req) => {
    if (!req || !req.reportUpdatedAt) return 0;
    return new Date(req.reportUpdatedAt).getTime() || 0;
  };
  
  for (const req of cloud) {
    if (req && req.code) {
      merged.set(req.code, req);
    }
  }
  
  for (const req of local) {
    if (req && req.code) {
      const cloudReq = merged.get(req.code);
      if (!cloudReq || getUpdateTime(req) >= getUpdateTime(cloudReq)) {
        merged.set(req.code, req);
      }
    }
  }
  return Array.from(merged.values());
}

function mergeCatalogs(local, cloud) {
  const merged = new Map();
  for (const item of cloud) {
    if (item && item.id) merged.set(item.id, item);
  }
  for (const item of local) {
    if (item && item.id) merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

function mergeSettings(local, cloud) {
  const cloudOutsource = cloud.outsourceAreas || [];
  const localOutsource = local.outsourceAreas || [];
  const mergedOutsource = [...new Set([...cloudOutsource, ...localOutsource])];
  
  return { 
    ...cloud, 
    ...local, 
    outsourceAreas: mergedOutsource 
  };
}

let catalog = [];
let selectedArea = "";
let selectedTests = new Set();
let assignedBlocks = [];
let selectedRequestIndex = null;
let editingCatalog = new Set();
let deferredInstall = null;
let settingsUnlocked = true;
let backendReady = false;
let licenseState = { estado: "activo" };
let syncStatusState = { estado: "offline", texto: "Sin conexion - Trabajando en modo offline" };
let systemMetadata = {};
let appDialogResolve = null;
let deselectedOutsourceFilters = new Set();

const STATISTICS_ENABLED = true;

const ADMIN_CREDENTIALS = {
  user: "clinlab.admin.rooo",
  passwordHash: "ea34ce6ff67d000d1b68b9eda4794821338c51bb1452beb029602983ba146b62"
};

const AREA_PRIORITY = [
  "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
  "Hematología",
  "Química Sanguínea",
  "Inmunología",
  "Uroanálisis",
  "Parasitología",
  "Líquidos biológicos",
  "Hormonas",
  "Toxicología",
  "Bacteriología"
];

const INITIAL_CATALOG = [
  {
    "id": "EYM-0001",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "TSH NEONATAL",
    "clasificacion": "CRIBADO NEONATAL",
    "parametro": "HORMONA ESTIMULANTE DE LA TIROIDES NEONATAL",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE (TARJETA)",
    "unidad": "µUI/mL",
    "minimo": "0.00",
    "maximo": "10.00",
    "referencia": "NORMAL: 0 a 10 µUI/mL",
    "activo": true,
    "orden": 0,
    "nombre": "HORMONA ESTIMULANTE DE LA TIROIDES NEONATAL",
    "categoria": "CRIBADO NEONATAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0002",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "17 OH PROGESTERONA NEONATAL",
    "clasificacion": "CRIBADO NEONATAL",
    "parametro": "17-HIDROXIPROGESTERONA NEONATAL",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE (TARJETA)",
    "unidad": "nmol/L",
    "minimo": "0.00",
    "maximo": "30.00",
    "referencia": "NORMAL: 0 a 30 nmol/L",
    "activo": true,
    "orden": 1,
    "nombre": "17-HIDROXIPROGESTERONA NEONATAL",
    "categoria": "CRIBADO NEONATAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0003",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "IRT",
    "clasificacion": "CRIBADO NEONATAL",
    "parametro": "TRIPSINA INMUNORREACTIVA (FIBROSIS QUÍSTICA)",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE (TARJETA)",
    "unidad": "ng/mL",
    "minimo": "",
    "maximo": "90.00",
    "referencia": "NORMAL: < 90 ng/mL",
    "activo": true,
    "orden": 2,
    "nombre": "TRIPSINA INMUNORREACTIVA (FIBROSIS QUÍSTICA)",
    "categoria": "CRIBADO NEONATAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0004",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "PKU",
    "clasificacion": "CRIBADO NEONATAL",
    "parametro": "FENILALANINA / FENILCETONURIA",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE (TARJETA)",
    "unidad": "nmol/L",
    "minimo": "0.00",
    "maximo": "30.00",
    "referencia": "NORMAL: 0 a 30 nmol/L",
    "activo": true,
    "orden": 3,
    "nombre": "FENILALANINA / FENILCETONURIA",
    "categoria": "CRIBADO NEONATAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0005",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "17 OH PROGESTERONA",
    "clasificacion": "ESTEROIDES ADRENALES / EJE GONADAL",
    "parametro": "17-HIDROXIPROGESTERONA",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "pg/mL",
    "minimo": "",
    "maximo": "",
    "referencia": "Niñas: 1 mes (2,4-16,8), 2 meses (1,6-9,7), 3 meses (0,1-3,1). Niños: 1 mes (0,0-8,0), 2 meses (3,6-13,7), 3 meses (1,7-4,0), 3-14 años (0,1-1,7). Adultos: 2,4-16,8. Mujeres: Fase Folicular (0,1-0,8), Fase Lútea (0,6-2,3), Ovulación (0,3-1,4), Post ACTH (<3,2), Embarazo Tardío (2,0-12,0).",
    "activo": true,
    "orden": 4,
    "nombre": "17-HIDROXIPROGESTERONA",
    "categoria": "ESTEROIDES ADRENALES / EJE GONADAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0006",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "TESTOSTERONA LIBRE",
    "clasificacion": "ANDRÓGENOS / EJE GONADAL",
    "parametro": "TESTOSTERONA LIBRE",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "pg/mL",
    "minimo": "0.00",
    "maximo": "50.00",
    "referencia": "Hombres: 15,00 - 50,00; Mujeres: menor a 4,2 (Rango analítico general 0,00 - 50,00)",
    "activo": true,
    "orden": 5,
    "nombre": "TESTOSTERONA LIBRE",
    "categoria": "ANDRÓGENOS / EJE GONADAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0007",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "CALCITONINA",
    "clasificacion": "MARCADOR TUMORAL / METABOLISMO FOSFOCÁLCICO",
    "parametro": "CALCITONINA",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "pg/mL",
    "minimo": "0.00",
    "maximo": "18.00",
    "referencia": "0,00 a 18,00 pg/mL",
    "activo": true,
    "orden": 6,
    "nombre": "CALCITONINA",
    "categoria": "MARCADOR TUMORAL / METABOLISMO FOSFOCÁLCICO",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0008",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "VITAMINA B12",
    "clasificacion": "VITAMINAS / NUTRICIÓN",
    "parametro": "CIANOCOBALAMINA / VITAMINA B12",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "ng/mL",
    "minimo": "200.00",
    "maximo": "1100.00",
    "referencia": "Normal: 200 - 1100 ng/mL; Deficiente: Menor a 200 ng/mL",
    "activo": true,
    "orden": 7,
    "nombre": "CIANOCOBALAMINA / VITAMINA B12",
    "categoria": "VITAMINAS / NUTRICIÓN",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0009",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "ACIDO FOLICO",
    "clasificacion": "VITAMINAS / NUTRICIÓN",
    "parametro": "ÁCIDO FÓLICO / FOLATO SÉRICO",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "ng/mL",
    "minimo": "5.20",
    "maximo": "20.00",
    "referencia": "Normal: 5,2 - 20 ng/mL; Deficiente: 3,2 - 5,2 ng/Ml",
    "activo": true,
    "orden": 8,
    "nombre": "ÁCIDO FÓLICO / FOLATO SÉRICO",
    "categoria": "VITAMINAS / NUTRICIÓN",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0010",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "RECEPTOR ANTI TSH",
    "clasificacion": "AUTOINMUNIDAD TIROIDEA",
    "parametro": "ANTICUERPOS CONTRA EL RECEPTOR DE TSH (TRAB)",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "pg/mL",
    "minimo": "0.00",
    "maximo": "1.50",
    "referencia": "Negativo: Inferior a 1,00 pg/mLZona Gris: Entre 1,00 y 1,30 pg/mLPositivo: Superior a 1,50 pg/mL",
    "activo": true,
    "orden": 9,
    "nombre": "ANTICUERPOS CONTRA EL RECEPTOR DE TSH (TRAB)",
    "categoria": "AUTOINMUNIDAD TIROIDEA",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0011",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "TSH3ULTRA",
    "clasificacion": "EJE TIROIDEO",
    "parametro": "HORMONA ESTIMULANTE DE LA TIROIDES ULTRASENSIBLE",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "µIU/mL",
    "minimo": "0.34",
    "maximo": "5.60",
    "referencia": "0,34 a 5,60 µIU/mL",
    "activo": true,
    "orden": 10,
    "nombre": "HORMONA ESTIMULANTE DE LA TIROIDES ULTRASENSIBLE",
    "categoria": "EJE TIROIDEO",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0012",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "T3 TOTAL",
    "clasificacion": "EJE TIROIDEO",
    "parametro": "TRIYODOTIRONINA TOTAL",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "ng/mL",
    "minimo": "0.87",
    "maximo": "1.78",
    "referencia": "0,87 a 1,78 ng/mL",
    "activo": true,
    "orden": 11,
    "nombre": "TRIYODOTIRONINA TOTAL",
    "categoria": "EJE TIROIDEO",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0013",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "T4 TOTAL",
    "clasificacion": "EJE TIROIDEO",
    "parametro": "TIROXINA TOTAL",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "µg/dL",
    "minimo": "6.09",
    "maximo": "12.23",
    "referencia": "6,09 a 12,23 µg/dL",
    "activo": true,
    "orden": 12,
    "nombre": "TIROXINA TOTAL",
    "categoria": "EJE TIROIDEO",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0014",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "T4 LIBRE",
    "clasificacion": "EJE TIROIDEO",
    "parametro": "TIROXINA LIBRE",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "ng/dL",
    "minimo": "0.61",
    "maximo": "1.12",
    "referencia": "0,61 a 1,12 ng/dL",
    "activo": true,
    "orden": 13,
    "nombre": "TIROXINA LIBRE",
    "categoria": "EJE TIROIDEO",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0015",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "ATPO",
    "clasificacion": "AUTOINMUNIDAD TIROIDEA",
    "parametro": "ANTICUERPOS ANTI TIROPEROXIDASA",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "UI/mL",
    "minimo": "0.00",
    "maximo": "9.00",
    "referencia": "Hasta 9,00 UI/mL",
    "activo": true,
    "orden": 14,
    "nombre": "ANTICUERPOS ANTI TIROPEROXIDASA",
    "categoria": "AUTOINMUNIDAD TIROIDEA",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0016",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "ATG II",
    "clasificacion": "AUTOINMUNIDAD TIROIDEA / MARCADOR TUMORAL",
    "parametro": "ANTICUERPOS ANTI TIROGLOBULINA II",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "UI/mL",
    "minimo": "0.00",
    "maximo": "4.00",
    "referencia": "Hasta 4,00 UI/mL",
    "activo": true,
    "orden": 15,
    "nombre": "ANTICUERPOS ANTI TIROGLOBULINA II",
    "categoria": "AUTOINMUNIDAD TIROIDEA / MARCADOR TUMORAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0017",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "TIROGLOBULINA",
    "clasificacion": "MARCADOR TUMORAL / TIROIDES",
    "parametro": "TIROGLOBULINA (TG)",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "ng/mL",
    "minimo": "1.60",
    "maximo": "50.00",
    "referencia": "1,60 a 50,00 ng/mL",
    "activo": true,
    "orden": 16,
    "nombre": "TIROGLOBULINA (TG)",
    "categoria": "MARCADOR TUMORAL / TIROIDES",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0018",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "FSH",
    "clasificacion": "GONADOTROPINAS / EJE GONADAL",
    "parametro": "HORMONA FOLICULOESTIMULANTE",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "mUI/mL",
    "minimo": "",
    "maximo": "",
    "referencia": "Hombres: 1,4-18,1 mUI/mL. Mujeres: Fase folicular (2,5-10,2), Pico mitad ciclo (3,4-33,4), Fase lútea (1,5-9,1), Postmenopausia (23,0-116,3).",
    "activo": true,
    "orden": 17,
    "nombre": "HORMONA FOLICULOESTIMULANTE",
    "categoria": "GONADOTROPINAS / EJE GONADAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0019",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "LH",
    "clasificacion": "GONADOTROPINAS / EJE GONADAL",
    "parametro": "HORMONA LUTEINIZANTE",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "mUI/mL",
    "minimo": "",
    "maximo": "",
    "referencia": "Hombres: 1,5-9,3 mUI/mL. Mujeres: Fase folicular (1,9-12,5), Pico mitad ciclo (8,7-76,3), Fase lútea (0,5-16,9), Postmenopausia (15,9-54,0).",
    "activo": true,
    "orden": 18,
    "nombre": "HORMONA LUTEINIZANTE",
    "categoria": "GONADOTROPINAS / EJE GONADAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0020",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "ACTH",
    "clasificacion": "EJE ADRENAL",
    "parametro": "HORMONA ADRENOCORTICOTROPINA",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "pg/mL",
    "minimo": "7.20",
    "maximo": "63.30",
    "referencia": "7,20 a 63,30 pg/mL (Muestra matutina)",
    "activo": true,
    "orden": 19,
    "nombre": "HORMONA ADRENOCORTICOTROPINA",
    "categoria": "EJE ADRENAL",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0021",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "PROLACTINA",
    "clasificacion": "EJE HIPOFISARIO / REPRODUCCIÓN",
    "parametro": "PROLACTINA (PRL)",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "ng/mL",
    "minimo": "",
    "maximo": "",
    "referencia": "Hombres: 2,1 - 17,7 ng/mL. Mujeres no embarazadas: 2,8 - 29,2 ng/mL. Mujeres embarazadas: 9,7 - 208,5 ng/mL. Postmenopausia: 1,8 - 20,3 ng/mL.",
    "activo": true,
    "orden": 20,
    "nombre": "PROLACTINA (PRL)",
    "categoria": "EJE HIPOFISARIO / REPRODUCCIÓN",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  },
  {
    "id": "EYM-0022",
    "area": "ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    "determinacion": "SHBG",
    "clasificacion": "PROTEÍNAS TRANSPORTADORAS / ANDRÓGENOS",
    "parametro": "GLOBULINA FIJADORA DE HORMONAS SEXUALES",
    "tipo": "CUANTITATIVO",
    "muestra": "SANGRE",
    "unidad": "nmol/L",
    "minimo": "",
    "maximo": "",
    "referencia": "Hombres (20-49 años): 18,3 - 54,1 nmol/L; (>=50 años): 20,6 - 76,7. Mujeres (20-49 años): 32,4 - 128,0 nmol/L; (>=50 años): 27,1 - 128,0.",
    "activo": true,
    "orden": 21,
    "nombre": "GLOBULINA FIJADORA DE HORMONAS SEXUALES",
    "categoria": "PROTEÍNAS TRANSPORTADORAS / ANDRÓGENOS",
    "seleccionableIndividual": true,
    "seleccionableGrupo": true
  }
];

const QUICK_PROFILES = [
  {
    id: "perfil-tiroideo",
    label: "Perfil Tiroideo",
    icon: "🦋",
    desc: "TSH, T3 Total, T4 Total, T4 Libre",
    testIds: ["EYM-0011", "EYM-0012", "EYM-0013", "EYM-0014"]
  },
  {
    id: "autoinmunidad-tiroidea",
    label: "Autoinmunidad Tiroidea",
    icon: "🛡️",
    desc: "ATPO, ATG II, Receptor Anti-TSH (TRAB)",
    testIds: ["EYM-0015", "EYM-0016", "EYM-0010"]
  },
  {
    id: "cribado-neonatal",
    label: "Cribado Neonatal",
    icon: "👶",
    desc: "TSH Neonatal, 17-OHP Neo, IRT, PKU",
    testIds: ["EYM-0001", "EYM-0002", "EYM-0003", "EYM-0004"]
  },
  {
    id: "perfil-gonadal",
    label: "Perfil Gonadal / Fertilidad",
    icon: "⚥",
    desc: "FSH, LH, Prolactina, Testosterona Libre, SHBG",
    testIds: ["EYM-0018", "EYM-0019", "EYM-0021", "EYM-0006", "EYM-0022"]
  },
  {
    id: "marcadores-tumorales",
    label: "Marcadores Tumorales",
    icon: "🎯",
    desc: "Tiroglobulina, Calcitonina, Anti-Tiroglobulina",
    testIds: ["EYM-0017", "EYM-0007", "EYM-0016"]
  },
  {
    id: "eje-adrenal",
    label: "Eje Adrenal",
    icon: "⚡",
    desc: "ACTH, 17-OH Progesterona",
    testIds: ["EYM-0020", "EYM-0005"]
  },
  {
    id: "perfil-vitaminico",
    label: "Perfil Vitamínico",
    icon: "💊",
    desc: "Vitamina B12, Ácido Fólico",
    testIds: ["EYM-0008", "EYM-0009"]
  },
  {
    id: "todos",
    label: "Seleccionar Todos",
    icon: "📋",
    desc: "Todas las pruebas del catálogo",
    testIds: "ALL"
  }
];

const state = {
  settings: store.get("clinlab.settings", {
    institution: "CAJA NACIONAL DE SALUD",
    healthFacility: "HOSPITAL DE ESPECIALIDADES MATERNO INFANTIL",
    lab: "AREA DE ENDOCRINOLOGIA Y MARCADORES TUMORALES",
    labAreas: "",
    address: "",
    phone: "",
    logo: "assets/icon.svg",
    cloudUrl: "",
    collabToken: "",
    localAccepted: true,
    initialized: true,
    themeColor: "#1f7a4d",
    printPaperSize: "media_carta",
    backups: [],
    outsourceAreas: []
  }),
  requests: store.get("clinlab.requests", []),
  externalList: store.get("clinlab.externalList", []),
  draft: store.get("clinlab.draft", {})
};

// Migración y compatibilidad de identidad institucional fija
if (!state.settings.institution || state.settings.institution === "Institucion") {
  state.settings.institution = "CAJA NACIONAL DE SALUD";
}
if (!state.settings.healthFacility || state.settings.healthFacility === "Establecimiento de Salud") {
  state.settings.healthFacility = "HOSPITAL DE ESPECIALIDADES MATERNO INFANTIL";
}
if (!state.settings.lab || state.settings.lab === "Laboratorio clinico") {
  state.settings.lab = "AREA DE ENDOCRINOLOGIA Y MARCADORES TUMORALES";
}
if (!state.settings.logo) {
  state.settings.logo = "assets/icon.svg";
}
if (!state.settings.printPaperSize) {
  state.settings.printPaperSize = "media_carta";
}

const statsEngine = {
  cache: new Map(),
  invalidate() {
    this.cache.clear();
  },
  async getStats(from, to, areaFilter) {
    const key = `${from}|${to}|${areaFilter}`;
    if (this.cache.has(key)) return this.cache.get(key);
    return new Promise(resolve => {
      setTimeout(() => {
        const result = this.compute(from, to, areaFilter);
        this.cache.set(key, result);
        resolve(result);
      }, 0);
    });
  },
  compute(from, to, areaFilter) {
    const reqs = state.requests.filter(req => (!from || req.date >= from) && (!to || req.date <= to));
    let previousReqs = [];
    if (from && to) {
      const f = new Date(from + "T12:00:00");
      const t = new Date(to + "T12:00:00");
      const diff = Math.round(Math.abs(t - f) / (1000 * 60 * 60 * 24)) + 1;
      const pt = new Date(f);
      pt.setDate(pt.getDate() - 1);
      const pf = new Date(pt);
      pf.setDate(pf.getDate() - diff + 1);
      const pFromStr = `${pf.getFullYear()}-${String(pf.getMonth() + 1).padStart(2, "0")}-${String(pf.getDate()).padStart(2, "0")}`;
      const pToStr = `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, "0")}-${String(pt.getDate()).padStart(2, "0")}`;
      previousReqs = state.requests.filter(req => req.date >= pFromStr && req.date <= pToStr);
    }

    const data = {
      b1: { pacientes: new Set(), muestrasRecibidas: 0, pruebasRealizadas: 0, pruebasEmergencia: 0, diasTrabajados: new Set(), variacionMensual: 0, pruebasMasculino: 0, pruebasFemenino: 0 },
      b3: { muestrasRechazadas: 0 },
      pruebas: {}, // indexed by test id
      b7: { areas: {}, jerarquia: {} },
      ext: {
        pacientes: new Set(),
        muestras: new Set(),
        asignaciones: 0,
        parametros: 0,
        elementos: [] // [{area, det, cat, param}]
      }
    };

    // Pre-initialize qualitative epidemiological tests from catalog
    if (Array.isArray(catalog)) {
      catalog.forEach(item => {
        if (item.activo && String(item.tipo || "").toUpperCase() === "CUALITATIVO") {
          const refVal = String(catalogReference(item)).toUpperCase().trim();
          const negativeRefMarkers = ["NEGATIVO", "NEGATIVA", "NO REACTIVO", "NO REACTIVA", "NO DETECTADO", "AUSENCIA", "NO SE OBSERVA", "NORMAL"];
          if (negativeRefMarkers.some(marker => refVal.includes(marker))) {
            data.pruebas[item.id] = {
              id: item.id, total: 0, resultados: 0,
              positivos: 0, genero: { MASCULINO: 0, FEMENINO: 0 }, edad: { "0-4": 0, "5-14": 0, "15-49": 0, "50+": 0 },
              anormales: 0, Alto: 0, Normal: 0, Bajo: 0
            };
          }
        }
      });
    }

    let prevPruebas = 0;
    previousReqs.forEach(r => {
      const prevSeenDet = new Set();
      (r.tests || []).forEach(t => {
        if (t.result === undefined || t.result === null || String(t.result).trim() === "") return;
        const catalogItem = catalog.find(c => c.id === t.id) || {};
        const areaName = catalogItem.area || t.area || "";
        if (areaFilter && areaName !== areaFilter) return;
        const area = areaName || "Sin Área";
        const detKey = `D:${area}|${requestDetermination(t)}`;
        if (!prevSeenDet.has(detKey)) {
          prevPruebas++;
          prevSeenDet.add(detKey);
        }
      });
    });

    reqs.forEach(req => {
      data.b1.pacientes.add(req.code);
      data.b1.diasTrabajados.add(req.date);
      
      let mReq = 0;
      if (Array.isArray(req.requiredSamples)) {
        mReq = req.requiredSamples.length;
      } else if (typeof req.requiredSamples === "string" && req.requiredSamples.trim() !== "") {
        mReq = 1;
      }
      
      data.b1.muestrasRecibidas += mReq;
      if (req.sampleStatus === "RECHAZADO") data.b3.muestrasRechazadas += mReq;

      // Accumulate original KPIs (completed tests only)
      const seenKPI = new Set();
      (req.tests || []).forEach(test => {
        if (test.result === undefined || test.result === null || String(test.result).trim() === "") return;
        const catalogItem = catalog.find(c => c.id === test.id) || {};
        const areaName = catalogItem.area || test.area || "";
        if (areaFilter && areaName !== areaFilter) return;

        const area = areaName || "Sin Área";
        const det = requestDetermination(test);
        const areaKey = `A:${area}`;
        const detKey = `D:${area}|${det}`;

        if (!seenKPI.has(areaKey)) {
          data.b7.areas[area] = (data.b7.areas[area] || 0) + 1;
          seenKPI.add(areaKey);
        }
        if (!seenKPI.has(detKey)) {
          data.b1.pruebasRealizadas++;
          if (req.attentionType === "Emergencias") data.b1.pruebasEmergencia++;
          const genUpper = String(req.gender || "").toUpperCase();
          if (genUpper === "MASCULINO") data.b1.pruebasMasculino++;
          else if (genUpper === "FEMENINO") data.b1.pruebasFemenino++;
          seenKPI.add(detKey);
        }
      });

      // Accumulate hierarchical distribution (both assigned and stored tests)
      const seenJerarquiaAsig = new Set();
      const seenJerarquiaStored = new Set();
      (req.tests || []).forEach(test => {
        const catalogItem = catalog.find(c => c.id === test.id) || {};
        const areaName = catalogItem.area || test.area || "";
        if (areaFilter && areaName !== areaFilter) return;

        const area = areaName || "Sin Área";
        const det = requestDetermination(test);
        const cat = requestClassification(test);
        const param = requestParameter(test);

        const isOutsource = state.settings.outsourceAreas.includes(area);

        // Stored verification
        let isStored = false;
        if (isOutsource) {
          const extReq = (state.externalList || []).find(r => r.code === req.code);
          if (extReq && (extReq.tests || []).some(t => t.id === test.id)) {
            isStored = true;
          }
        } else {
          isStored = (test.result !== undefined && test.result !== null && String(test.result).trim() !== "") || 
                     (test.notes !== undefined && test.notes !== null && String(test.notes).trim() !== "");
        }

        if (!data.b7.jerarquia[area]) {
          data.b7.jerarquia[area] = { assigned: 0, stored: 0, total: 0, dets: {} };
        }
        if (!data.b7.jerarquia[area].dets[det]) {
          data.b7.jerarquia[area].dets[det] = { assigned: 0, stored: 0, total: 0, cats: {} };
        }
        if (!data.b7.jerarquia[area].dets[det].cats[cat]) {
          data.b7.jerarquia[area].dets[det].cats[cat] = { assigned: 0, stored: 0, total: 0, params: {} };
        }
        if (!data.b7.jerarquia[area].dets[det].cats[cat].params[param]) {
          data.b7.jerarquia[area].dets[det].cats[cat].params[param] = { assigned: 0, stored: 0 };
        }

        const areaKey = `A:${area}`;
        const detKey = `D:${area}|${det}`;
        const catKey = `C:${area}|${det}|${cat}`;

        // Assigned counts
        if (!seenJerarquiaAsig.has(areaKey)) {
          data.b7.jerarquia[area].assigned++;
          seenJerarquiaAsig.add(areaKey);
        }
        if (!seenJerarquiaAsig.has(detKey)) {
          data.b7.jerarquia[area].dets[det].assigned++;
          seenJerarquiaAsig.add(detKey);
        }
        if (!seenJerarquiaAsig.has(catKey)) {
          data.b7.jerarquia[area].dets[det].cats[cat].assigned++;
          seenJerarquiaAsig.add(catKey);
        }
        data.b7.jerarquia[area].dets[det].cats[cat].params[param].assigned++;

        // Stored counts
        if (isStored) {
          if (!seenJerarquiaStored.has(areaKey)) {
            data.b7.jerarquia[area].stored++;
            seenJerarquiaStored.add(areaKey);
          }
          if (!seenJerarquiaStored.has(detKey)) {
            data.b7.jerarquia[area].dets[det].stored++;
            seenJerarquiaStored.add(detKey);
          }
          if (!seenJerarquiaStored.has(catKey)) {
            data.b7.jerarquia[area].dets[det].cats[cat].stored++;
            seenJerarquiaStored.add(catKey);
          }
          data.b7.jerarquia[area].dets[det].cats[cat].params[param].stored++;
        }
      });

      (req.tests || []).forEach(test => {
        if (test.result === undefined || test.result === null || String(test.result).trim() === "") return;
        const catalogItem = catalog.find(c => c.id === test.id) || {};
        const areaName = catalogItem.area || test.area || "";
        if (areaFilter && areaName !== areaFilter) return;

        const id = test.id;
        if (!data.pruebas[id]) {
          data.pruebas[id] = {
            id, total: 0, resultados: 0,
            positivos: 0, genero: { MASCULINO: 0, FEMENINO: 0 }, edad: { "0-4": 0, "5-14": 0, "15-49": 0, "50+": 0 },
            anormales: 0, Alto: 0, Normal: 0, Bajo: 0
          };
        }
        const pStat = data.pruebas[id];
        pStat.total++;
        pStat.resultados++;

        const catItem = catalog.find(c => c.id === test.id);
        const isCual = (catItem ? catItem.tipo : test.type) === "CUALITATIVO";
        const isCuan = (catItem ? catItem.tipo : test.type) === "CUANTITATIVO";
        const resUpper = String(test.result || "").trim().toUpperCase();
        
        if (isCual) {
          const refVal = String(catItem ? catalogReference(catItem) : requestReference(test)).toUpperCase().trim();
          const negativeRefMarkers = ["NEGATIVO", "NEGATIVA", "NO REACTIVO", "NO REACTIVA", "NO DETECTADO", "AUSENCIA", "NO SE OBSERVA", "NORMAL"];
          const isQualEpidemiological = negativeRefMarkers.some(marker => refVal.includes(marker));
          
          if (isQualEpidemiological) {
            const negativeMarkers = ["NEGATIVO", "NEGATIVA", "NO REACTIVO", "NO REACTIVA", "NO DETECTADO", "NO DETECTADA", "AUSENCIA", "NO SE OBSERVA", "NO REACTIVAS", "NEGATIVAS", "NORMAL"];
            let isPositive = false;
            
            const hasNegativeMarker = negativeMarkers.some(marker => resUpper.includes(marker));
            if (!hasNegativeMarker) {
              const positiveMarkers = ["POSITIVO", "POSITIVA", "REACTIVO", "REACTIVA", "PRESENCIA", "DETECTADO", "ANORMAL", "ALTERADO"];
              isPositive = positiveMarkers.some(marker => resUpper.includes(marker));
            }
            
            if (isPositive) {
              pStat.positivos++;
              pStat.genero[req.gender || "MASCULINO"] = (pStat.genero[req.gender || "MASCULINO"] || 0) + 1;
              const age = parseInt(req.age) || 0;
              if (age <= 4) pStat.edad["0-4"]++;
              else if (age <= 14) pStat.edad["5-14"]++;
              else if (age <= 49) pStat.edad["15-49"]++;
              else pStat.edad["50+"]++;
            }
          }
        } else if (isCuan) {
          const getNumericValue = (str) => {
            const cleaned = String(str || "").replace(",", ".");
            const match = cleaned.match(/[-+]?(?:\d*\.\d+|\d+\.?)/);
            return match ? parseFloat(match[0]) : NaN;
          };
          const valNum = getNumericValue(resUpper);
          const minNum = getNumericValue(catItem && catItem.minimo ? catItem.minimo : test.minimum);
          const maxNum = getNumericValue(catItem && catItem.maximo ? catItem.maximo : test.maximum);
          if (!isNaN(valNum)) {
            if (!isNaN(minNum) && valNum < minNum) {
              pStat.anormales++;
              pStat.Bajo++;
            } else if (!isNaN(maxNum) && valNum > maxNum) {
              pStat.anormales++;
              pStat.Alto++;
            } else {
              pStat.Normal++;
            }
          }
        }
      });
    });

    const extReqs = (state.externalList || []).filter(req => (!from || req.date >= from) && (!to || req.date <= to));
    extReqs.forEach(req => {
      let reqHasMatchedTests = false;
      const seenDetsThisReq = new Set();
      (req.tests || []).forEach(test => {
        const areaName = test.area || "";
        if (areaFilter && areaName !== areaFilter) return;
        
        reqHasMatchedTests = true;
        data.ext.parametros++;
        
        const detName = test.determination || test.determinacion || "Desconocida";
        const detKey = `${areaName}|${detName}`;
        if (!seenDetsThisReq.has(detKey)) {
          data.ext.asignaciones++;
          seenDetsThisReq.add(detKey);
        }
        
        data.ext.elementos.push({
          area: areaName,
          det: detName,
          cat: "GENERAL",
          param: test.parameter || test.parametro || test.id
        });

        const s = test.sample || test.muestra;
        if (s) {
          data.ext.muestras.add(`${req.code}|${s.trim().toUpperCase()}`);
        }
      });
      if (reqHasMatchedTests) {
        data.ext.pacientes.add(req.code);
      }
    });

    // Set total back to stored count for backwards compatibility
    for (const area of Object.values(data.b7.jerarquia)) {
      area.total = area.stored;
      for (const det of Object.values(area.dets)) {
        det.total = det.stored;
        for (const cat of Object.values(det.cats)) {
          cat.total = cat.stored;
        }
      }
    }

    if (prevPruebas > 0) {
      data.b1.variacionMensual = ((data.b1.pruebasRealizadas - prevPruebas) / prevPruebas) * 100;
    } else if (data.b1.pruebasRealizadas > 0) {
      data.b1.variacionMensual = 100;
    }
    return data;
  }
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const firstOfCurrentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const uid = () => {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  
  const baseCode = `${yyyy}${mm}${dd}${hh}${min}${ss}`;
  // Búsqueda O(1) con Set para evitar degradación con grandes volúmenes de registros
  const existingCodes = new Set(
    (Array.isArray(state.requests) ? state.requests : [])
      .map(r => r && String(r.code))
      .filter(Boolean)
  );
  let candidate = baseCode;
  let seq = 1;
  while (existingCodes.has(candidate)) {
    candidate = `${baseCode}-${String(seq).padStart(2, "0")}`;
    seq++;
  }
  return candidate;
};
const areas = () => {
  const found = [...new Set(catalog.map((item) => item.area))].filter(Boolean);
  return found.sort((a, b) => {
    const idxA = AREA_PRIORITY.indexOf(a);
    const idxB = AREA_PRIORITY.indexOf(b);
    if (idxA === -1 && idxB === -1) return a.localeCompare(b);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });
};
const testsById = () => Object.fromEntries(catalog.map((test) => [test.id, test]));
const catalogText = (value) => String(value ?? "").trim();
const catalogUpper = (value) => catalogText(value).toUpperCase();
const catalogName = (test) => catalogText(test.parametro ?? test.nombre ?? test.determinacion ?? test.id);
const catalogParameter = (test) => catalogText(test.parametro ?? test.nombre ?? test.determinacion ?? test.id);
const catalogDetermination = (test) => catalogText(test.determinacion ?? test.nombre ?? test.parametro ?? test.id);
const catalogClassification = (test) => catalogText(test.clasificacion ?? test.categoria ?? "GENERAL");
const catalogReference = (test) => catalogText(test.referencia ?? test.reference);
const requestDetermination = (test) => catalogText(test.determination ?? test.determinacion ?? test.name ?? test.nombre);
const requestClassification = (test) => catalogText(test.classification ?? test.clasificacion ?? test.category ?? test.categoria ?? categoryFor(test.id));
const requestParameter = (test) => catalogText(test.parameter ?? test.parametro ?? test.name ?? test.nombre);
const requestReference = (test) => catalogText(test.reference ?? test.referencia);
const requestUnit = (test) => catalogText(test.unit ?? test.unidad);
const requestSample = (test) => catalogText(test.sample ?? test.muestra);
const catalogSearchText = (test) => [
  test.id,
  test.area,
  test.determinacion,
  test.clasificacion,
  test.parametro,
  test.tipo,
  test.muestra,
  test.unidad,
  test.minimo,
  test.maximo,
  test.referencia,
  test.nombre,
  test.categoria
].join(" ").toLowerCase();

function importedText(value) {
  const source = value && typeof value === "object" && !(value instanceof Date) ? (value.w ?? value.v ?? "") : value;
  const text = catalogText(source).replace(/[\u0000-\u001f\u007f\ufffd]/g, "").trim();
  if (!text || text === "[object Object]" || /^#(N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!)$/i.test(text)) return "";
  return text;
}

function numericLimit(value, bound = "min") {
  const text = importedText(value).replace(/\s+/g, " ");
  if (!text) return "";
  const matches = text.match(/-?\d+(?:[.,]\d+)?/g) || [];
  if (!matches.length) return "";
  const selected = bound === "max" ? matches.at(-1) : matches[0];
  return selected.replace(",", ".");
}

function normalizedCatalogType(value) {
  const type = catalogUpper(value);
  if (type.startsWith("CUAL")) return "CUALITATIVO";
  if (type.startsWith("CUANT") || type.startsWith("NUM")) return "CUANTITATIVO";
  return type;
}

function normalizeCatalogItem(item = {}, index = 0) {
  const area = catalogUpper(item.area);
  const determinacion = catalogUpper(item.determinacion ?? item.nombre ?? item.prueba ?? item.analisis ?? item.examen);
  const clasificacion = catalogUpper(item.clasificacion ?? item.categoria ?? item.subarea ?? item.perfil ?? "GENERAL");
  const parametro = catalogUpper(item.parametro ?? item.nombre ?? item.magnitud ?? determinacion);
  const tipo = normalizedCatalogType(item.tipo);
  const minimo = tipo === "CUALITATIVO" ? "" : numericLimit(item.minimo ?? item.min, "min");
  const maximo = tipo === "CUALITATIVO" ? "" : numericLimit(item.maximo ?? item.max, "max");
  const id = cleanCatalogCode(item.id ?? item.codigo ?? item.code, area, index);
  return {
    ...item,
    id,
    area,
    determinacion,
    clasificacion,
    parametro,
    tipo,
    muestra: catalogUpper(item.muestra ?? item.especimen),
    unidad: catalogText(item.unidad),
    minimo,
    maximo,
    referencia: catalogReference(item),
    nombre: parametro ?? determinacion,
    categoria: clasificacion,
    activo: item.activo !== false,
    orden: Number(item.orden ?? index) || 0,
    seleccionableIndividual: item.seleccionableIndividual !== false,
    seleccionableGrupo: item.seleccionableGrupo !== false
  };
}

function normalizeCatalogList(items) {
  return ensureUniqueCatalogCodes((items || []).map(normalizeCatalogItem).filter((item) => item.id && item.area && (item.parametro || item.determinacion)));
}

function cleanCatalogCode(value, area = "", index = 0) {
  const prefix = catalogPrefix(area);
  const generated = `${prefix}-${String(index + 1).padStart(4, "0")}`;
  const raw = catalogText(value);
  if (!raw) return generated;
  const cleaned = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned || cleaned.length > 18 || !/[A-Z0-9]/.test(cleaned)) return generated;
  return cleaned;
}

function catalogPrefix(area = "") {
  const letters = catalogText(area)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 3);
  return letters || "T";
}

function ensureUniqueCatalogCodes(items) {
  const seen = new Map();
  return items.map((item, index) => {
    const base = cleanCatalogCode(item.id, item.area, index);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return { ...item, id: count ? `${base}-${count + 1}` : base };
  });
}

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.hidden = false;
  setTimeout(() => (box.hidden = true), 2400);
}

function showAppDialog({ title = "ClinLab Suite", message = "", confirmLabel = "Aceptar", cancelLabel = "", variant = "info" }) {
  const modal = $("#appDialog");
  $("#appDialogTitle").textContent = title;
  $("#appDialogMessage").textContent = message;
  $("#appDialogConfirm").textContent = confirmLabel;
  $("#appDialogCancel").textContent = cancelLabel || "Cancelar";
  $("#appDialogCancel").hidden = !cancelLabel;
  $(".appDialogIcon").textContent = variant === "danger" ? "!" : (variant === "success" ? "OK" : "i");
  $(".appDialogIcon").dataset.variant = variant;
  modal.hidden = false;
  $("#appDialogConfirm").focus();
  return new Promise((resolve) => {
    appDialogResolve = resolve;
  });
}

function closeAppDialog(value) {
  $("#appDialog").hidden = true;
  if (appDialogResolve) appDialogResolve(value);
  appDialogResolve = null;
}

function appAlert(message, title = "Aviso", variant = "info") {
  return showAppDialog({ title, message, variant, confirmLabel: "Entendido" });
}

function appConfirm(message, title = "Confirmar accion", variant = "info") {
  return showAppDialog({ title, message, variant, confirmLabel: "Confirmar", cancelLabel: "Cancelar" });
}

function saveAll() {
  statsEngine.invalidate();
  store.set("clinlab.settings", state.settings);
  store.set("clinlab.requests", state.requests);
  store.set("clinlab.externalList", state.externalList);
  store.set("clinlab.catalog", catalog);
  persistBackend();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Error de comunicacion local");
  return data;
}

async function persistBackend() {
  if (!backendReady) {
    if (state.settings.collabEnabled && syncDirHandle) {
      try {
        await performBrowserFolderSync();
      } catch (err) {
        console.error("Error en persistencia en segundo plano (sincronización de carpeta):", err);
        updateSyncIndicator({ estado: "offline", texto: "Error en segundo plano al sincronizar" });
      }
    }
    return;
  }
  try {
    const result = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ settings: state.settings, requests: state.requests, catalog, externalList: state.externalList })
    });
    if (result.readOnly) {
      licenseState.estado = "restringido";
      applyReadOnlyMode(true);
      toast(result.message);
    }
    
    if (result.ok && state.settings.collabEnabled && state.settings.cloudUrl) {
      if (result.settings) {
        Object.assign(state.settings, result.settings);
      }
      if (result.requests) {
        state.requests = result.requests;
      }
      if (result.catalog) {
        catalog = normalizeCatalogList(result.catalog);
      }
      if (result.license) {
        licenseState = result.license;
        handleLicenseState(licenseState);
      }
      applyTheme(state.settings.themeColor);
      syncAllToExternalRegistry();
      renderAll();
    } else {
      if (result.syncStatus) updateSyncIndicator(result.syncStatus);
    }
  } catch (error) {
    updateSyncIndicator({ estado: "offline", texto: "Sin conexion - Trabajando en modo offline" });
    console.warn("Guardado backend pendiente:", error);
  }
}

function sortTestsByHierarchy(a, b) {
  const catalogItemA = catalog.find(c => c.id === a.id);
  const catalogItemB = catalog.find(c => c.id === b.id);
  const areaA = catalogItemA?.area || a.area || "";
  const areaB = catalogItemB?.area || b.area || "";
  const order = (Number(catalogItemA?.orden ?? a.orden) || 0) - (Number(catalogItemB?.orden ?? b.orden) || 0);
  if (order !== 0) return order;
  return [areaA, requestClassification(a), requestParameter(a)].join("|")
    .localeCompare([areaB, requestClassification(b), requestParameter(b)].join("|"));
}

function applyTheme(color) {
  if (!color) return;
  const root = document.documentElement;
  root.style.setProperty("--teal", color);
  root.style.setProperty("--teal-2", color + "26"); // 15% opacity (hex 26)
  const meta = document.querySelector("meta[name='theme-color']");
  if (meta) meta.content = color;
}

function applyPaperSize(size) {
  const paperSize = size || state.settings.printPaperSize || "media_carta";
  document.body.dataset.paperSize = paperSize;
  const settingSelect = $("#settingPrintPaperSize");
  if (settingSelect && settingSelect.value !== paperSize) settingSelect.value = paperSize;
  const reportSelect = $("#reportPaperFormatSelect");
  if (reportSelect && reportSelect.value !== paperSize) reportSelect.value = paperSize;
}

function cleanupEmptyTests() {
  const now = Date.now();
  let changed = false;
  state.requests.forEach(req => {
    if (!req.tests) return;
    let reqDateMs = NaN;
    if (req.date) {
      const [y, m, d] = req.date.split("-").map(Number);
      reqDateMs = new Date(y, m - 1, d).getTime();
    }
    if (!isNaN(reqDateMs) && (now - reqDateMs) > 5 * 24 * 60 * 60 * 1000) {
      req.tests.forEach(test => {
        const hasResult = (test.result && String(test.result).trim() !== "") || (test.notes && String(test.notes).trim() !== "");
        if (!hasResult && !test.depurado) {
          const catalogItem = catalog.find(c => c.id === test.id);
          const area = catalogItem?.area || test.area || "";
          const isOutsource = state.settings.outsourceAreas?.includes(area);
          if (!isOutsource) {
            test.depurado = true;
            changed = true;
          }
        }
      });
    }
  });
  if (changed) saveAll();
}

// ---------------------------------------------------------------------------
// POLÍTICA DE ALMACENAMIENTO Y RETENCIÓN (12 MESES)
// - Activos  : fecha ≤ 90 días (últimos 3 meses) → state.requests (Hot Memory)
// - Histórico: 91–365 días (meses 4 a 12)       → requestsIDB / Archivo interno
// - Vencidos : > 365 días                        → Preaviso de 7 días antes de depuración
// ---------------------------------------------------------------------------

async function enforceRetentionWithNotice() {
  const allReqs = await requestsIDB.loadAll() || state.requests || [];
  if (!Array.isArray(allReqs) || allReqs.length === 0) {
    renderPurgeNotice(null);
    return;
  }

  const nowDate = new Date();
  nowDate.setHours(0, 0, 0, 0);
  const nowMs = nowDate.getTime();
  const MS_90 = 90 * 24 * 60 * 60 * 1000;
  const MS_365 = 365 * 24 * 60 * 60 * 1000;

  const active = [];
  const archive = [];
  const expired = [];

  for (const req of allReqs) {
    if (!req) continue;
    if (!req.date) {
      active.push(req);
      continue;
    }
    const [y, m, d] = req.date.split("-").map(Number);
    const reqMs = new Date(y, (m || 1) - 1, d || 1).getTime();
    const age = nowMs - reqMs;

    if (age > MS_365) {
      expired.push(req);
    } else if (age > MS_90) {
      archive.push(req);
    } else {
      active.push(req);
    }
  }

  // Verificar estado de registros vencidos (> 12 meses)
  if (expired.length > 0) {
    let notice = state.settings.purgeNotice;
    if (!notice || !notice.firstNotified) {
      // Iniciar período de preaviso de 7 días
      notice = {
        firstNotified: new Date().toISOString(),
        count: expired.length,
        oldestDate: expired[0]?.date || "",
        newestExpiredDate: expired[expired.length - 1]?.date || ""
      };
      state.settings.purgeNotice = notice;
      store.set("clinlab.settings", state.settings);
      console.log(`[Almacenamiento] Iniciado preaviso de depuración de 7 días para ${expired.length} registros.`);
    }

    const elapsedMs = Date.now() - new Date(notice.firstNotified).getTime();
    const elapsedDays = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, 7 - elapsedDays);

    if (elapsedDays < 7) {
      // Aún dentro del período de preaviso de 1 semana
      renderPurgeNotice({
        count: expired.length,
        daysRemaining: daysRemaining || 1,
        expiredRecords: expired
      });
      // Mantener activos + archivo + vencidos en IDB mientras dure el preaviso
      await requestsIDB.saveAll([...active, ...archive, ...expired]);
    } else {
      // Han transcurrido los 7 días de preaviso: ejecutar depuración automática
      console.log(`[Almacenamiento] Ejecutando depuración automática de ${expired.length} registros tras 7 días de aviso.`);
      const remainingRecords = [...active, ...archive];
      await requestsIDB.saveAll(remainingRecords);
      state.settings.purgeNotice = null;
      store.set("clinlab.settings", state.settings);
      renderPurgeNotice(null);
      toast(`Depuración completada: se han liberado ${expired.length} registros mayores a 12 meses.`);
    }
  } else {
    // No hay registros vencidos
    if (state.settings.purgeNotice) {
      state.settings.purgeNotice = null;
      store.set("clinlab.settings", state.settings);
    }
    renderPurgeNotice(null);
  }

  // Mantener los últimos 3 meses (activos) en la memoria principal de la interfaz
  if (active.length > 0) {
    state.requests = active;
    saveLocalRequestsSegregated(active);
  }
}

function renderPurgeNotice(noticeData) {
  const banner = $("#purgeNoticeBanner");
  if (!banner) return;

  if (!noticeData || noticeData.count === 0) {
    banner.style.display = "none";
    return;
  }

  banner.style.display = "flex";
  const daysEl = $("#purgeNoticeDays");
  if (daysEl) daysEl.textContent = noticeData.daysRemaining;

  const textEl = $("#purgeNoticeText");
  if (textEl) {
    textEl.innerHTML = `Se han detectado <strong>${noticeData.count} registros</strong> con más de 12 meses de antigüedad. Serán depurados automáticamente en <strong>${noticeData.daysRemaining} día(s)</strong> para mantener ligero el almacenamiento. Descargue su respaldo antes de la depuración.`;
  }
}

async function downloadChronologicalBackup(format = "json") {
  const yearVal = $("#chronoYearSelect")?.value || "";
  const monthVal = $("#chronoMonthSelect")?.value || "";
  const dayVal = $("#chronoDaySelect")?.value || "";

  const allReqs = await requestsIDB.loadAll() || state.requests || [];
  const filtered = allReqs.filter((req) => {
    if (!req || !req.date) return false;
    const { year, month, day } = parseChronologicalKey(req.date);
    if (yearVal && year !== yearVal) return false;
    if (monthVal && month !== monthVal) return false;
    if (dayVal && day !== dayVal) return false;
    return true;
  });

  if (filtered.length === 0) {
    toast("No se encontraron registros para el período seleccionado.");
    return;
  }

  const periodLabel = `${yearVal || "Todos"}_${monthVal ? "Mes" + monthVal : "Todos"}_${dayVal ? "Dia" + dayVal : "Todos"}`;

  if (format === "json") {
    const payload = {
      sistema: "ClinLab Suite",
      version: "1.1.0-storage",
      fecha_generacion: new Date().toISOString(),
      filtro_cronologico: {
        anio: yearVal || "todos",
        mes: monthVal || "todos",
        dia: dayVal || "todos"
      },
      total_registros: filtered.length,
      registros_cronologicos: groupRequestsChronologically(filtered),
      solicitudes: filtered
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ClinLab_Respaldo_${periodLabel}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Respaldo JSON descargado (${filtered.length} registros).`);
  } else if (format === "excel") {
    if (typeof XLSX === "undefined") {
      toast("La librería de exportación Excel no está disponible.");
      return;
    }

    const solRows = filtered.map((req) => ({
      "Código": req.code || "",
      "Fecha": req.date || "",
      "Paciente": req.name || "",
      "Edad": req.age || "",
      "Género": req.gender || "",
      "Asegurado": req.insuranceCode || "",
      "Servicio": req.service || "",
      "Médico": req.doctor || "",
      "Cama": req.bed || "",
      "Muestra": req.sampleStatus || "ACEPTADA",
      "Total Pruebas": (req.tests || []).length
    }));

    const testRows = [];
    filtered.forEach((req) => {
      (req.tests || []).forEach((t) => {
        testRows.push({
          "Código Paciente": req.code || "",
          "Fecha": req.date || "",
          "Paciente": req.name || "",
          "Área": t.area || "",
          "Prueba / Parámetro": t.name || t.id || "",
          "Resultado": t.result || "",
          "Unidad": t.unit || "",
          "Valores de Referencia": t.reference || "",
          "Observaciones": t.notes || "",
          "Estado": t.depurado ? "DEPURADO" : "ACTIVO"
        });
      });
    });

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(solRows);
    const ws2 = XLSX.utils.json_to_sheet(testRows);
    XLSX.utils.book_append_sheet(wb, ws1, "Solicitudes");
    XLSX.utils.book_append_sheet(wb, ws2, "Resultados");

    XLSX.writeFile(wb, `ClinLab_Export_${periodLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast(`Exportación Excel completada (${filtered.length} registros).`);
  }
}

async function downloadExpiredBackup() {
  const allReqs = await requestsIDB.loadAll() || state.requests || [];
  const nowDate = new Date();
  nowDate.setHours(0, 0, 0, 0);
  const nowMs = nowDate.getTime();
  const MS_365 = 365 * 24 * 60 * 60 * 1000;

  const expired = allReqs.filter((req) => {
    if (!req || !req.date) return false;
    const [y, m, d] = req.date.split("-").map(Number);
    const reqMs = new Date(y, (m || 1) - 1, d || 1).getTime();
    return (nowMs - reqMs) > MS_365;
  });

  if (expired.length === 0) {
    toast("No hay registros vencidos para respaldar.");
    return;
  }

  const payload = {
    sistema: "ClinLab Suite",
    tipo: "RESPALDO_REGISTROS_VENCIDOS_12M",
    fecha_generacion: new Date().toISOString(),
    total_registros: expired.length,
    registros_cronologicos: groupRequestsChronologically(expired),
    solicitudes: expired
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ClinLab_Respaldo_Vencidos_12M_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Respaldo de registros vencidos descargado (${expired.length} registros).`);
}

async function downloadFullBackup() {
  const allReqs = await requestsIDB.loadAll() || state.requests || [];
  if (allReqs.length === 0) {
    toast("No hay registros almacenados.");
    return;
  }

  const payload = {
    sistema: "ClinLab Suite",
    version: "1.1.0-storage",
    tipo: "RESPALDO_COMPLETO_12_MESES",
    fecha_generacion: new Date().toISOString(),
    total_registros: allReqs.length,
    configuracion: state.settings,
    catalogo: catalog,
    registros_cronologicos: groupRequestsChronologically(allReqs),
    solicitudes: allReqs
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ClinLab_Respaldo_Completo_12M_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Respaldo completo descargado (${allReqs.length} registros).`);
}

async function renderChronologicalSelectors() {
  const stats = await requestsIDB.getChronologicalTree();
  if (!stats) return;

  const totalEl = $("#chronoBadgeTotal");
  const activeEl = $("#chronoBadgeActive");
  const archiveEl = $("#chronoBadgeArchive");

  if (totalEl) totalEl.textContent = `Total: ${stats.totalCount} registros`;
  if (activeEl) activeEl.textContent = `Activos (≤3m): ${stats.activeCount}`;
  if (archiveEl) archiveEl.textContent = `Históricos (4-12m): ${stats.archiveCount}`;

  const yearSelect = $("#chronoYearSelect");
  const monthSelect = $("#chronoMonthSelect");
  const daySelect = $("#chronoDaySelect");

  if (!yearSelect) return;

  const prevYear = yearSelect.value;
  const prevMonth = monthSelect?.value;
  const prevDay = daySelect?.value;

  const years = Object.keys(stats.tree || {});
  yearSelect.innerHTML = `<option value="">Todos los años (${years.length})</option>` +
    years.map((y) => `<option value="${y}" ${y === prevYear ? "selected" : ""}>Año ${y}</option>`).join("");

  const selectedYear = yearSelect.value;
  if (monthSelect) {
    if (selectedYear && stats.tree[selectedYear]) {
      const months = Object.keys(stats.tree[selectedYear]);
      monthSelect.innerHTML = `<option value="">Todos los meses (${months.length})</option>` +
        months.map((m) => `<option value="${m}" ${m === prevMonth ? "selected" : ""}>Mes ${m}</option>`).join("");
    } else {
      monthSelect.innerHTML = `<option value="">Todos los meses</option>`;
    }
  }

  const selectedMonth = monthSelect?.value;
  if (daySelect) {
    if (selectedYear && selectedMonth && stats.tree[selectedYear]?.[selectedMonth]) {
      const days = stats.tree[selectedYear][selectedMonth];
      daySelect.innerHTML = `<option value="">Todos los días (${days.length})</option>` +
        days.map((d) => `<option value="${d}" ${d === prevDay ? "selected" : ""}>Día ${d}</option>`).join("");
    } else {
      daySelect.innerHTML = `<option value="">Todos los días</option>`;
    }
  }
}

function updateExternalRegistry(req) {
  state.externalList = state.externalList || [];
  const outsourcedTests = (req.tests || []).filter(test => {
    const catalogItem = catalog.find(c => c.id === test.id) || {};
    const area = catalogItem.area || test.area || "";
    return state.settings.outsourceAreas.includes(area);
  });
  
  if (outsourcedTests.length > 0) {
    const extRecord = {
      code: req.code,
      name: req.name,
      age: req.age,
      gender: req.gender,
      insuranceCode: req.insuranceCode,
      service: req.service,
      doctor: req.doctor,
      bed: req.bed,
      auxCode: req.auxCode,
      date: req.date,
      sampleStatus: req.sampleStatus,
      attentionType: req.attentionType,
      diagnosis: req.diagnosis,
      tests: outsourcedTests.map(test => {
        const catalogItem = catalog.find(c => c.id === test.id) || {};
        return {
          id: test.id,
          area: catalogItem.area || test.area || "",
          determination: catalogDetermination(catalogItem) || test.determination || test.determinacion || "",
          parameter: catalogName(catalogItem) || test.parameter || test.parametro || test.name || "",
          sample: catalogItem.muestra || test.sample || test.muestra || ""
        };
      })
    };
    
    const idx = state.externalList.findIndex(item => item.code === req.code);
    if (idx > -1) {
      state.externalList[idx] = extRecord;
    } else {
      state.externalList.push(extRecord);
    }
  } else {
    state.externalList = state.externalList.filter(item => item.code !== req.code);
  }
}

function deleteFromExternalRegistry(code) {
  state.externalList = state.externalList || [];
  state.externalList = state.externalList.filter(item => item.code !== code);
}

function syncAllToExternalRegistry() {
  state.externalList = [];
  state.requests.forEach(req => {
    updateExternalRegistry(req);
  });
  if (state.externalList.length > 0) {
    store.set("clinlab.externalList", state.externalList);
  }
}

function showStartupSyncBanner(show) {
  const banner = $("#startupSyncBanner");
  if (banner) banner.style.display = show ? "flex" : "none";
}

function updateStartupSyncProgress(percent, text) {
  const bar = $("#startupSyncBannerProgress");
  const txt = $("#startupSyncBannerText");
  if (bar) bar.style.width = `${percent}%`;
  if (txt) txt.textContent = text;
}

async function init() {
  let bootstrap = await loadBackendState();
  systemMetadata = bootstrap?.metadata || {};
  
  if (bootstrap?.settings) Object.assign(state.settings, bootstrap.settings);
  if (!state.settings.institution || state.settings.institution === "Institucion") {
    state.settings.institution = "CAJA NACIONAL DE SALUD";
  }
  if (!state.settings.healthFacility || state.settings.healthFacility === "Establecimiento de Salud") {
    state.settings.healthFacility = "HOSPITAL DE ESPECIALIDADES MATERNO INFANTIL";
  }
  if (!state.settings.lab || state.settings.lab === "Laboratorio clinico") {
    state.settings.lab = "AREA DE ENDOCRINOLOGIA Y MARCADORES TUMORALES";
  }
  if (!state.settings.logo || state.settings.logo === "") {
    state.settings.logo = "assets/icon.svg";
  }
  state.settings.initialized = true;
  state.settings.collabTerminalId ||= uid();
  state.settings.outsourceAreas ||= [];
  
  if (state.settings.collabEnabled) {
    showStartupSyncBanner(true);
    updateStartupSyncProgress(10, "Comprobando actualizaciones colaborativas en la nube...");
    try {
      const syncResult = await api("/api/collab/bootstrap-sync", { method: "POST" });
      updateStartupSyncProgress(50, "Cargando datos actualizados...");
      if (syncResult.updated && syncResult.bootstrap) {
        bootstrap = syncResult.bootstrap;
        systemMetadata = bootstrap?.metadata || {};
        if (bootstrap.settings) Object.assign(state.settings, bootstrap.settings);
        state.settings.outsourceAreas ||= [];
        updateStartupSyncProgress(90, "Base de datos sincronizada correctamente.");
      } else {
        updateStartupSyncProgress(90, "La base de datos ya está al día.");
      }
    } catch (err) {
      console.error("Error en la sincronización inicial colaborativa:", err);
      updateStartupSyncProgress(90, "Error de red. Iniciando en modo offline...");
    }
    setTimeout(() => {
      showStartupSyncBanner(false);
    }, 1500);
  }

  const savedCatalog = store.get("clinlab.catalog", null);
  catalog = normalizeCatalogList(bootstrap?.catalog?.length ? bootstrap.catalog : (savedCatalog || await loadInitialCatalog()));
  if (bootstrap?.requests?.length) {
    state.requests = bootstrap.requests;
  } else {
    try {
      const idbReqs = await requestsIDB.loadAll();
      if (Array.isArray(idbReqs) && idbReqs.length > (state.requests?.length || 0)) {
        state.requests = idbReqs;
        console.log(`[Storage Shield] Restauradas ${idbReqs.length} solicitudes desde IndexedDB.`);
      }
    } catch (e) {}
  }
  if (bootstrap?.externalList) state.externalList = bootstrap.externalList;
  if (!state.externalList || state.externalList.length === 0) {
    syncAllToExternalRegistry();
  }
  cleanupEmptyTests();
  await enforceRetentionWithNotice(); // Aplicar política de retención de 12 meses con preaviso al iniciar
  if (bootstrap?.syncConfig?.link_carpeta && !state.settings.cloudUrl) state.settings.cloudUrl = bootstrap.syncConfig.link_carpeta;
  selectedArea = areas()[0] || "";
  // Statistics module enabled
  bindNavigation();
  bindForms();
  bindInstall();
  bindStorageControls();
  bindCollabControls();
  bindOutsourceControls();
  bindWorklistSubmenu();
  hydrateForms();
  renderDiagnosisSuggestions();
  renderAll();
  applyTheme(state.settings.themeColor);
  handleLicenseState(bootstrap?.license);
  updateSyncIndicator(bootstrap?.syncStatus);
  startScheduler();
  await initBrowserFolderSync();
  if (backendReady && (!bootstrap?.requests?.length || !bootstrap?.catalog?.length)) saveAll();
  if (!state.settings.initialized) showView("settings");
  if (location.protocol !== "file:" && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
}

async function loadBackendState() {
  try {
    const data = await api("/api/bootstrap");
    backendReady = true;
    return data;
  } catch (error) {
    backendReady = false;
    console.warn("Backend local no disponible, usando localStorage:", error);
    return null;
  }
}

async function loadInitialCatalog() {
  try {
    if (window.CLINLAB_CATALOG?.length) return normalizeCatalogList(window.CLINLAB_CATALOG);
    const res = await fetch("data/catalogo.json");
    if (!res.ok) throw new Error("Catalog file not found");
    return normalizeCatalogList(await res.json());
  } catch (err) {
    console.warn("Using INITIAL_CATALOG fallback:", err);
    return normalizeCatalogList(INITIAL_CATALOG);
  }
}

function showView(id) {
  if (id === "statistics" && !STATISTICS_ENABLED) id = "dashboard";
  $$("#nav button").forEach((item) => item.classList.toggle("active", item.dataset.view === id));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === id));
  const button = $(`#nav button[data-view="${id}"]`);
  $("#viewTitle").textContent = button ? button.textContent : "ClinLab Suite";
  $("#printBtn").hidden = id !== "worklist" && id !== "statistics";
  renderAll();
}

function bindNavigation() {
  $("#nav").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (button) showView(button.dataset.view);
  });
  $("#printBtn").addEventListener("click", () => {
    const activeView = $("#nav button.active")?.dataset?.view;
    if (activeView === "statistics") document.body.dataset.printMode = "stats";
    window.print();
  });
  
  const welcomeModal = $("#welcomeModal");
  if (welcomeModal) {
    $("#welcomeEnterBtn").addEventListener("click", () => welcomeModal.close());
  }
}

function bindForms() {
  bindAppDialog();
  $("#patientForm").addEventListener("input", autosaveDraft);
  $("#patientForm").addEventListener("submit", saveRequest);
  $("#editPatient").addEventListener("click", updateSelectedRequest);
  $("#deletePatient").addEventListener("click", deleteSelectedRequest);
  $("#clearPatient").addEventListener("click", clearPatient);
  $("#confirmSaveBtn")?.addEventListener("click", () => {
    const isStep2 = !$("#confirmSavePrintBtn").hidden;
    if (isStep2) {
      confirmSaveFinal(false, false);
    } else {
      confirmSaveFinal(false, true);
    }
  });
  $("#confirmSaveReportBtn")?.addEventListener("click", showResultsEntryModal);
  $("#confirmSavePrintBtn")?.addEventListener("click", () => confirmSaveFinal(true, false));
  $("#confirmSaveCancel")?.addEventListener("click", cancelSave);
  $$(".gender-btn-group .gender-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".gender-btn-group .gender-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $("#patientGender").value = btn.dataset.gender;
      autosaveDraft();
      updateFormProgress();
    });
  });
  $$(".sample-status-group .status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".sample-status-group .status-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $("#sampleStatus").value = btn.dataset.status;
      autosaveDraft();
      updateFormProgress();
    });
  });
  $$(".attention-btn-group .attention-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".attention-btn-group .attention-btn").forEach((b) => {
        b.style.backgroundColor = "white";
        b.style.color = "inherit";
      });
      btn.style.backgroundColor = "var(--teal)";
      btn.style.color = "white";
      $("#attentionType").value = btn.dataset.attention;
      autosaveDraft();
      updateFormProgress();
    });
  });
  $("#patientForm").addEventListener("input", (e) => {
    updateFormProgress();
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      e.target.value = e.target.value.toUpperCase();
    }
  });
  $("#testSearch").addEventListener("input", renderTestTree);
  $("#quickProfilesBar")?.addEventListener("click", (event) => {
    const chip = event.target.closest(".quick-profile-chip");
    if (chip) {
      event.preventDefault();
      const profileId = chip.dataset.profileId;
      toggleQuickProfile(profileId);
    }
  });
  $("#quickProfileClearBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    selectedTests.clear();
    assignedBlocks = [];
    autosaveDraft();
    renderQuickProfiles();
    renderTestTree();
    renderRequiredSamples();
  });
  
  if ($("#patientSearchInput")) {
    $("#patientSearchInput").addEventListener("input", () => {
      if (patientSearchTimer) clearTimeout(patientSearchTimer);
      patientSearchTimer = setTimeout(() => {
        renderPatientRows();
      }, 500); // 500ms debounce
    });
  }

  $("#catalogSearch").addEventListener("input", renderCatalog);
  $("#catalogArea").addEventListener("change", renderCatalog);

  $("#addTest").addEventListener("click", addCatalogRow);
  $("#importCatalogBtn").addEventListener("click", () => $("#importExcel").click());
  $("#importExcel").addEventListener("change", importCatalogFromExcel);
  $("#saveCatalog").addEventListener("click", saveCatalogChanges);
  ["workDateFrom", "workDateTo", "workArea", "workAreaExclude", "workTestFilter", "workPatientFilter", "workGroup"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderWorklist);
    $(`#${id}`).addEventListener("change", renderWorklist);
  });
  ["reportSearch", "reportDate"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderReports);
    $(`#${id}`).addEventListener("change", renderReports);
  });
  $("#reportPaperFormatSelect")?.addEventListener("change", (e) => {
    applyPaperSize(e.target.value);
    state.settings.printPaperSize = e.target.value;
    saveAll();
  });
  $("#settingPrintPaperSize")?.addEventListener("change", (e) => {
    applyPaperSize(e.target.value);
    state.settings.printPaperSize = e.target.value;
    saveAll();
  });
  $("#printSelectedReport").addEventListener("click", () => {
    document.body.dataset.printMode = "reports";
    window.print();
  });
  $("#printDateReports").addEventListener("click", () => {
    $("#reportSearch").value = "";
    if (!$("#reportDate").value) $("#reportDate").value = today();
    renderReports();
    document.body.dataset.printMode = "reports";
    window.print();
  });
  if ($("#institutionForm")) {
    $("#institutionForm").addEventListener("submit", saveInstitution);
    if ($("#institutionForm").logo) $("#institutionForm").logo.addEventListener("change", previewLogo);
  }
  if ($("#storageForm")) $("#storageForm").addEventListener("submit", saveStorage);
  if ($("#unlockSettings")) $("#unlockSettings").addEventListener("click", unlockSettings);
  if ($("#lockSettings")) $("#lockSettings").addEventListener("click", lockSettings);
  $("#refreshSystem").addEventListener("click", refreshSystem);
  $("#exportExcel").addEventListener("click", exportExcelWorkbook);
  $("#factoryReset").addEventListener("click", async () => {
    if (await appConfirm("Esto borrará permanentemente todos los pacientes, reportes, configuraciones e historial del equipo y del servidor local. ¿Está absolutamente seguro?", "Restablecer sistema", "danger")) {
      try {
        const result = await api("/api/technical/factory-reset", { method: "POST" });
        if (result.ok) {
          localStorage.clear();
          sessionStorage.clear();
          toast("Sistema restablecido con éxito.");
          setTimeout(() => {
            window.location.reload(true);
          }, 1500);
        } else {
          toast("Error al restablecer: " + result.message);
        }
      } catch (err) {
        toast("Error al conectar con el servidor: " + err.message);
      }
    }
  });
  if (STATISTICS_ENABLED) {
    ["statsFrom", "statsTo"].forEach((id) => {
      const el = $(`#${id}`);
      if (el) {
        el.addEventListener("change", renderStatistics);
        el.addEventListener("input", renderStatistics);
      }
    });
    const exportBtn = $("#exportStatsExcel");
    if (exportBtn) {
      exportBtn.addEventListener("click", exportStatsToExcel);
    }
  }
  window.addEventListener("afterprint", () => delete document.body.dataset.printMode);
}

function bindAppDialog() {
  $("#appDialogConfirm").addEventListener("click", () => closeAppDialog(true));
  $("#appDialogCancel").addEventListener("click", () => closeAppDialog(false));
  $("#appDialog").addEventListener("click", (event) => {
    if (event.target.id === "appDialog") closeAppDialog(null);
  });
  window.addEventListener("keydown", (event) => {
    if (!$("#appDialog").hidden && event.key === "Escape") closeAppDialog(null);
  });
}



function bindStorageControls() {
  $("#licenseOk")?.addEventListener("click", () => {
    $("#licenseModal").hidden = true;
  });
  $("#consultOnlyBtn")?.addEventListener("click", () => {
    $("#licenseModal").hidden = true;
    applyReadOnlyMode(true);
  });
  $("#renewTokenBtn")?.addEventListener("click", renewLicenseFromPopup);
  $("#renewLicense")?.addEventListener("click", technicalRenewLicense);
  $("#forceFullSync")?.addEventListener("click", forceFullSync);
  $("#restoreWizardBtn")?.addEventListener("click", openRestoreWizard);
  $("#closeRestore")?.addEventListener("click", () => { if ($("#restoreModal")) $("#restoreModal").hidden = true; });
  $("#scanRestore")?.addEventListener("click", scanRestoreFiles);
  
  // Acciones de respaldo cronológico y depuración con preaviso
  $("#downloadExpiredBackupBtn")?.addEventListener("click", downloadExpiredBackup);
  $("#downloadAllBackupBtn")?.addEventListener("click", downloadFullBackup);
  $("#downloadFullBackupBtn")?.addEventListener("click", downloadFullBackup);
  $("#downloadChronoJsonBtn")?.addEventListener("click", () => downloadChronologicalBackup("json"));
  $("#downloadChronoExcelBtn")?.addEventListener("click", () => downloadChronologicalBackup("excel"));
  $("#chronoYearSelect")?.addEventListener("change", renderChronologicalSelectors);
  $("#chronoMonthSelect")?.addEventListener("change", renderChronologicalSelectors);
  
  const selectSyncFolderBtn = $("#selectSyncFolderBtn");
  if (selectSyncFolderBtn) {
    selectSyncFolderBtn.addEventListener("click", async () => {
      try {
        const handle = await window.showDirectoryPicker({
          mode: "readwrite"
        });
        if (handle) {
          syncDirHandle = handle;
          await folderSyncDB.saveHandle(handle);
          $("#syncFolderStatusText").innerHTML = `<span style="color:#10b981; font-weight:bold;">🟢 Vinculada:</span> ${handle.name}`;
          const restoreBtn = $("#restoreFolderAccessBtn");
          if (restoreBtn) restoreBtn.style.display = "none";
          toast("Carpeta vinculada con éxito.");
          performBrowserFolderSync();
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error al seleccionar carpeta:", err);
          toast("Error al seleccionar la carpeta.");
        }
      }
    });
  }

  const restoreFolderAccessBtn = $("#restoreFolderAccessBtn");
  if (restoreFolderAccessBtn) {
    restoreFolderAccessBtn.addEventListener("click", async () => {
      if (!syncDirHandle) return;
      try {
        const hasPerm = await verifyPermission(syncDirHandle, true);
        if (hasPerm) {
          $("#syncFolderStatusText").innerHTML = `<span style="color:#10b981; font-weight:bold;">🟢 Vinculada:</span> ${syncDirHandle.name}`;
          restoreFolderAccessBtn.style.display = "none";
          toast("Acceso concedido a la carpeta.");
          performBrowserFolderSync();
        } else {
          toast("Permiso denegado.");
        }
      } catch (err) {
        console.error("Error al restaurar acceso a la carpeta:", err);
        toast("Error al restaurar acceso.");
      }
    });
  }
}

let updateCollabRoleView = null;
let toggleCollabSettings = null;

function generateCollabToken() {
  const payload = {
    url: state.settings.cloudUrl || "",
    labId: systemMetadata.laboratorio_id || "",
    sign: "CLB-SECURE-SYNC-KEY"
  };
  try {
    const jsonStr = JSON.stringify(payload);
    const token = btoa(unescape(encodeURIComponent(jsonStr)));
    state.settings.collabToken = token;
    saveAll();
    return token;
  } catch (err) {
    console.error("Error generating collab token:", err);
    return "";
  }
}

function decodeCollabToken(token) {
  try {
    const jsonStr = decodeURIComponent(escape(atob(token.trim())));
    const payload = JSON.parse(jsonStr);
    if (payload && payload.sign === "CLB-SECURE-SYNC-KEY") {
      return payload;
    }
  } catch (err) {
    console.error("Error decoding token:", err);
  }
  return null;
}

function bindCollabControls() {
  const form = $("#collabForm");
  if (!form) return;
  
  const roleSelect = $("#collabRole");
  const statusBox = $("#collabStatusBox");
  const statusTitle = $("#collabStatusTitle");
  const statusText = $("#collabStatusText");
  const progressContainer = $("#collabProgressBarContainer");
  const progressBar = $("#collabProgressBar");
  
  updateCollabRoleView = () => {
    const mainSection = $("#collabMainSection");
    const nodeSection = $("#collabNodeSection");
    if (!backendReady) {
      if (mainSection) mainSection.style.display = "none";
      if (nodeSection) nodeSection.style.display = "none";
      const roleLabel = roleSelect?.closest("label");
      if (roleLabel) roleLabel.style.display = "grid";
      return;
    }
    const role = roleSelect.value;
    if (role === "node") {
      if (mainSection) mainSection.style.display = "none";
      if (nodeSection) nodeSection.style.display = "flex";
      const clientCloudUrlInput = $("#collabNodeCloudUrl");
      if (clientCloudUrlInput) clientCloudUrlInput.value = state.settings.cloudUrl || "";
      const clientTokenInput = $("#collabTokenInput");
      if (clientTokenInput) clientTokenInput.value = state.settings.collabToken || "";
    } else {
      if (mainSection) mainSection.style.display = "flex";
      if (nodeSection) nodeSection.style.display = "none";
      
      const step1Text = $("#collabMainStep1Text");
      const step3Section = $("#collabMainStep3");
      const generatedInput = $("#generatedCollabToken");
      if (step1Text) {
        if (state.settings.cloudUrl) {
          step1Text.innerHTML = `<span style="color:#10b981; font-weight:bold;">🟢 Configurado:</span> ${escapeHtml(state.settings.cloudUrl)}`;
        } else {
          step1Text.innerHTML = `<span style="color:#f97316; font-weight:bold;">🔴 Pendiente:</span> Configure el enlace/ruta de almacenamiento local de la nube arriba en la sección 'Almacenamiento'.`;
        }
      }
      if (state.settings.collabEnabled && state.settings.collabToken) {
        if (step3Section) step3Section.style.display = "block";
        if (generatedInput) generatedInput.value = state.settings.collabToken;
      } else {
        if (step3Section) step3Section.style.display = "none";
        if (generatedInput) generatedInput.value = "";
      }
    }
  };
  roleSelect.addEventListener("change", () => {
    updateCollabRoleView();
    state.settings.collabRole = roleSelect.value;
    saveAll();
  });
  
  toggleCollabSettings = () => {
    const collabSettings = $("#collabSettings");
    if (collabSettings) {
      collabSettings.style.display = $("#collabEnabled").checked ? "grid" : "none";
    }
  };
  $("#collabEnabled").addEventListener("change", async () => {
    toggleCollabSettings();
    if (!backendReady) {
      state.settings.collabEnabled = $("#collabEnabled").checked;
      saveAll();
      if (state.settings.collabEnabled) {
        performBrowserFolderSync();
      }
      renderAll();
      return;
    }
    const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
    if (isNode && !$("#collabEnabled").checked) {
      if (await appConfirm("¿Desea desconectar esta terminal del modo colaborativo y volver al modo local?", "Desconectar Terminal")) {
        state.settings.collabEnabled = false;
        state.settings.collabRole = "main";
        state.settings.cloudUrl = "";
        state.settings.collabToken = "";
        
        saveAll();
        try {
          await api("/api/sync-config", {
            method: "POST",
            body: JSON.stringify({ link_carpeta: "", token_api: "" })
          });
        } catch (e) {}
        
        toast("Desconectado de la red colaborativa. Modo local activo.");
        renderAll();
      } else {
        $("#collabEnabled").checked = true;
        toggleCollabSettings();
      }
    } else {
      state.settings.collabEnabled = $("#collabEnabled").checked;
      saveAll();
      renderAll();
    }
  });
  
  const terminalInput = $("#collabTerminalName");
  if (terminalInput) {
    terminalInput.addEventListener("change", () => {
      state.settings.collabTerminalName = terminalInput.value.trim();
      saveAll();
      toast("Identificador de terminal actualizado y guardado.");
    });
  }
  
  // Botón de Inicialización de Servidor (Paso 2 de Unidad Principal)
  const initializeBtn = $("#initializeCollabBtn");
  if (initializeBtn) {
    initializeBtn.addEventListener("click", async () => {
      if (!isAdmin()) return toast("Acceso denegado. Desbloquee la configuracion como administrador.");
      if (!state.settings.cloudUrl) {
        toast("Por favor configure la ruta de la carpeta de almacenamiento arriba en la sección 'Almacenamiento' primero.");
        return;
      }
      
      statusBox.style.display = "grid";
      statusBox.className = "backupStatus warning";
      progressContainer.style.display = "block";
      progressBar.style.width = "0%";
      
      statusTitle.textContent = "Inicializando Red Colaborativa";
      statusText.innerHTML = `<strong>Paso 1:</strong> Generando token de seguridad y configurando permisos...`;
      progressBar.style.width = "25%";
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const token = generateCollabToken();
      state.settings.collabEnabled = true;
      state.settings.collabRole = "main";
      
      $("#collabEnabled").checked = true;
      $("#collabRole").value = "main";
      
      saveAll();
      
      statusText.innerHTML = `<strong>Paso 2:</strong> Inicializando directorios de seguridad y control de acceso...`;
      progressBar.style.width = "50%";
      
      try {
        await api("/api/sync-config", {
          method: "POST",
          body: JSON.stringify({ link_carpeta: state.settings.cloudUrl, token_api: state.settings.token_api || "" })
        });
        
        statusText.innerHTML = `<strong>Paso 3:</strong> Subiendo identidad institucional, catálogo y bases de datos iniciales a la nube...`;
        progressBar.style.width = "75%";
        
        const syncResult = await api("/api/collab/sync", {
          method: "POST",
          body: JSON.stringify({
            settings: state.settings,
            requests: state.requests,
            catalog: catalog
          })
        });
        
        if (syncResult.ok) {
          progressBar.style.width = "100%";
          statusBox.className = "backupStatus";
          statusTitle.textContent = "Inicialización Completada";
          statusText.textContent = "La carpeta de la nube ha sido inicializada y protegida. El token de acceso está listo para usarse.";
          progressContainer.style.display = "none";
          
          toast("Modo colaborativo inicializado con éxito.");
          
          const generatedInput = $("#generatedCollabToken");
          if (generatedInput) generatedInput.value = token;
          const step3Section = $("#collabMainStep3");
          if (step3Section) step3Section.style.display = "block";
          
          renderAll();
        } else {
          throw new Error(syncResult.message || "Fallo en la sincronización.");
        }
      } catch (err) {
        console.error("Error al inicializar red colaborativa:", err);
        statusBox.className = "backupStatus danger";
        statusTitle.textContent = "Inicialización Fallida";
        statusText.textContent = err.message || "No se pudo inicializar la carpeta en la nube. Verifique que la ruta de almacenamiento sea válida y que tenga permisos de escritura.";
        progressContainer.style.display = "none";
        toast("Fallo al inicializar la red colaborativa.");
        
        state.settings.collabEnabled = false;
        $("#collabEnabled").checked = false;
        saveAll();
        renderAll();
      }
    });
  }
  
  // Token Copy Control Binding
  const copyBtn = $("#copyCollabTokenBtn");
  const generatedInput = $("#generatedCollabToken");
  if (copyBtn && generatedInput) {
    copyBtn.addEventListener("click", () => {
      if (!generatedInput.value || generatedInput.value === "Haga clic en Inicializar...") {
        toast("Por favor genere un token primero.");
        return;
      }
      navigator.clipboard.writeText(generatedInput.value)
        .then(() => toast("Token copiado al portapapeles."))
        .catch(() => toast("Error al copiar el token. Selecciónelo manualmente."));
    });
  }
  
  // Conectar y Sincronizar Cliente (Paso 3 de Unidad Conectada)
  const connectBtn = $("#connectCollabTokenBtn");
  const tokenInput = $("#collabTokenInput");
  const clientCloudUrlInput = $("#collabNodeCloudUrl");
  if (connectBtn && tokenInput && clientCloudUrlInput) {
    connectBtn.addEventListener("click", async () => {
      const folderUrl = clientCloudUrlInput.value.trim();
      const tokenVal = tokenInput.value.trim();
      
      if (!folderUrl) {
        toast("Por favor ingrese la ruta local de la carpeta en la nube.");
        return;
      }
      if (!tokenVal) {
        toast("Por favor pegue el token de conexión.");
        return;
      }
      
      const payload = decodeCollabToken(tokenVal);
      if (!payload) {
        toast("Token inválido o firma incorrecta.");
        return;
      }
      
      statusBox.style.display = "grid";
      statusBox.className = "backupStatus warning";
      progressContainer.style.display = "block";
      progressBar.style.width = "0%";
      
      statusTitle.textContent = "Conectando a Red Colaborativa";
      statusText.innerHTML = `<strong>Paso 1:</strong> Validando token de acceso y estableciendo conexión...`;
      progressBar.style.width = "33%";
      
      const origCloudUrl = state.settings.cloudUrl;
      const origCollabToken = state.settings.collabToken;
      const origCollabEnabled = state.settings.collabEnabled;
      const origCollabRole = state.settings.collabRole;
      const origLabId = systemMetadata.laboratorio_id;
      
      state.settings.cloudUrl = folderUrl;
      state.settings.collabToken = tokenVal;
      state.settings.collabRole = "node";
      state.settings.collabEnabled = true;
      systemMetadata.laboratorio_id = payload.labId;
      
      saveAll();
      
      try {
        await api("/api/sync-config", {
          method: "POST",
          body: JSON.stringify({ link_carpeta: folderUrl, token_api: state.settings.token_api || "" })
        });
        
        statusText.innerHTML = `<strong>Paso 2:</strong> Descargando configuraciones y catálogo de la Unidad Principal...`;
        progressBar.style.width = "66%";
        
        const syncResult = await api("/api/collab/sync", {
          method: "POST",
          body: JSON.stringify({
            settings: state.settings,
            requests: state.requests,
            catalog: catalog
          })
        });
        
        if (syncResult.ok) {
          if (syncResult.settings) Object.assign(state.settings, syncResult.settings);
          if (syncResult.requests) state.requests = syncResult.requests;
          if (syncResult.catalog) catalog = normalizeCatalogList(syncResult.catalog);
          if (syncResult.license) {
            licenseState = syncResult.license;
            handleLicenseState(licenseState);
          }
          applyTheme(state.settings.themeColor);
          syncAllToExternalRegistry();
          
          progressBar.style.width = "100%";
          statusBox.className = "backupStatus";
          statusTitle.textContent = "Conexión Completada";
          statusText.textContent = "Se ha conectado exitosamente a la Unidad Principal. Las configuraciones y bases de datos han sido sincronizadas.";
          progressContainer.style.display = "none";
          
          $("#collabEnabled").checked = true;
          $("#collabRole").value = "node";
          const storageFormCloudUrl = $("#storageForm")?.cloudUrl;
          if (storageFormCloudUrl) {
            storageFormCloudUrl.value = folderUrl;
          }
          
          toast("Conectado y sincronizado con éxito.");
          
          toggleCollabSettings();
          updateCollabRoleView();
          renderAll();
        } else {
          throw new Error(syncResult.message || "Fallo en la verificación del token en el servidor.");
        }
      } catch (err) {
        console.error("Error al conectar terminal cliente:", err);
        statusBox.className = "backupStatus danger";
        statusTitle.textContent = "Conexión Fallida";
        statusText.textContent = err.message || "No se pudo sincronizar con la carpeta. Verifique el token y la ruta local.";
        progressContainer.style.display = "none";
        toast("Fallo al conectar con la unidad principal.");
        
        state.settings.cloudUrl = origCloudUrl;
        state.settings.collabToken = origCollabToken;
        state.settings.collabEnabled = origCollabEnabled;
        state.settings.collabRole = origCollabRole;
        systemMetadata.laboratorio_id = origLabId;
        
        $("#collabEnabled").checked = origCollabEnabled;
        $("#collabRole").value = origCollabRole;
        
        saveAll();
        
        try {
          await api("/api/sync-config", {
            method: "POST",
            body: JSON.stringify({ link_carpeta: origCloudUrl, token_api: state.settings.token_api || "" })
          });
        } catch (e) {}
        
        toggleCollabSettings();
        updateCollabRoleView();
        renderAll();
      }
    });
  }
  
  updateCollabRoleView();
  toggleCollabSettings();
}

function canWrite(message = "El sistema esta en modo solo lectura hasta renovar el mantenimiento.") {
  if (licenseState?.estado === "restringido") {
    toast(message);
    return false;
  }
  return true;
}

function bindInstall() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event;
    $("#installBtn").hidden = false;
  });
  $("#installBtn").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $("#installBtn").hidden = true;
  });
}

function hydrateForms() {
  $("#patientForm").date.value = state.draft.date || today();
  $("#patientForm").code.value = state.draft.code || uid();
  selectedTests = new Set(state.draft.selectedTests || []);
  assignedBlocks = state.draft.assignedBlocks || [];
  Object.entries(state.draft).forEach(([key, value]) => {
    if ($("#patientForm")[key] && key !== "selectedTests" && key !== "assignedBlocks") $("#patientForm")[key].value = value;
  });
  updateGenderButtons();
  updateStatusButtons();
  updateAttentionButtons();
  updateFormProgress();
  const instDefaults = {
    institution: "CAJA NACIONAL DE SALUD",
    healthFacility: "HOSPITAL DE ESPECIALIDADES MATERNO INFANTIL",
    lab: "AREA DE ENDOCRINOLOGIA Y MARCADORES TUMORALES"
  };
  Object.entries(state.settings).forEach(([key, value]) => {
    if ($("#institutionForm") && $("#institutionForm")[key] && key !== "logo") {
      $("#institutionForm")[key].value = value || instDefaults[key] || "";
    }
    if ($("#storageForm") && $("#storageForm")[key]) {
      if ($("#storageForm")[key].type === "checkbox") $("#storageForm")[key].checked = Boolean(value);
      else $("#storageForm")[key].value = value || "";
    }
    if ($("#collabForm") && $("#collabForm")[key] !== undefined) {
      if ($("#collabForm")[key].type === "checkbox") $("#collabForm")[key].checked = Boolean(value);
      else $("#collabForm")[key].value = value || "";
    }
  });
  if (typeof updateCollabRoleView === "function") updateCollabRoleView();
  if (typeof toggleCollabSettings === "function") toggleCollabSettings();
  $("#workDateFrom").value = today();
  $("#workDateTo").value = today();
  if ($("#outsourceDateFrom")) $("#outsourceDateFrom").value = today();
  if ($("#outsourceDateTo")) $("#outsourceDateTo").value = today();
  if ($("#epidemiologyDateFrom")) $("#epidemiologyDateFrom").value = today();
  if ($("#epidemiologyDateTo")) $("#epidemiologyDateTo").value = today();
  $("#reportDate").value = today();
  if ($("#exportDateFrom")) $("#exportDateFrom").value = today();
  if ($("#exportDateTo")) $("#exportDateTo").value = today();
  if (STATISTICS_ENABLED) {
    $("#statsFrom").value = firstOfCurrentMonth();
    $("#statsTo").value = today();
  }
}

function renderAll() {
  state.settings.backups ||= [];
  const currentLab = (state.settings.lab && state.settings.lab !== "Laboratorio clinico") ? state.settings.lab : "AREA DE ENDOCRINOLOGIA Y MARCADORES TUMORALES";
  $("#labLabel").textContent = currentLab;
  if ($("#syncState")) $("#syncState").textContent = "Modo local";
  const currentLogo = state.settings.logo || "assets/icon.svg";
  if ($("#brandLogo")) $("#brandLogo").src = currentLogo;
  if ($("#logoPreview")) {
    $("#logoPreview").src = currentLogo;
    $("#logoPreview").hidden = false;
  }
  renderDashboard();
  renderTabs();
  renderQuickProfiles();
  renderTestTree();
  renderPatientRows();
  renderCatalogFilters();
  renderCatalog();
  renderOutsourceAreas();
  renderWorkFilters();
  renderWorklist();
  if ($("#epidemiologyWorklistPanel") && !$("#epidemiologyWorklistPanel").hidden) {
    fillEpidemiologyParameterSelect();
    renderEpidemiologyWorklist();
  }
  renderReports();
  if (STATISTICS_ENABLED) {
    renderStatsFilters();
    renderStatistics();
  }
  renderSettingsAccess();
  renderBackupStatus();
  renderChronologicalSelectors();
  renderConnectedTerminals();
  renderRequiredSamples();
  applyTheme(state.settings.themeColor);
  applyPaperSize(state.settings.printPaperSize || "media_carta");
  applyReadOnlyMode(licenseState?.estado === "restringido");
  
  const submitBtn = $("#patientForm button[type='submit']");
  if (submitBtn) {
    submitBtn.textContent = selectedRequestIndex !== null ? "Guardar cambios" : "Guardar solicitud";
  }
  if ($("#settings")?.classList.contains("active")) {
    autoLoadSyncLog();
  }
}

function renderConnectedTerminals() {
  const containerSection = $("#connectedTerminalsSection");
  const listEl = $("#connectedTerminalsList");
  if (!containerSection || !listEl) return;
  
  const isMain = state.settings.collabEnabled && state.settings.collabRole === "main";
  if (!isMain) {
    containerSection.style.display = "none";
    return;
  }
  
  containerSection.style.display = "block";
  const terminals = state.settings.connectedTerminals || [];
  
  if (terminals.length === 0) {
    listEl.innerHTML = `<li class="note" style="color: var(--muted); font-size: 0.9rem;">No hay terminales conectadas aún.</li>`;
    return;
  }
  
  listEl.innerHTML = terminals.map(terminal => {
    const lastSyncTime = new Date(terminal.lastSync).getTime();
    const isOnline = Date.now() - lastSyncTime < 5 * 60 * 1000;
    const dotColor = isOnline ? "#10b981" : "#f97316";
    const statusText = isOnline ? "En línea" : "Desconectado";
    return `
      <li style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: #f8fafc; border-radius: 6px; border: 1px solid var(--line);">
        <div style="display: flex; flex-direction: column;">
          <strong style="font-size: 0.9rem; color: var(--ink);">${escapeHtml(terminal.name)}</strong>
          <span style="font-size: 0.75rem; color: var(--muted);">Última sync: ${escapeHtml(formatDateTime(terminal.lastSync))}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; display: inline-block;"></span>
          <span style="font-size: 0.75rem; color: var(--muted); font-weight: 500;">${statusText}</span>
        </div>
      </li>
    `;
  }).join("");
}

function renderDashboard() {
  const todayRequests = state.requests.filter((req) => req.date === today());
  const pending = state.requests.flatMap((req) => req.tests || []).filter((test) => !test.result).length;
  $("#metricRequests").textContent = state.requests.length;
  $("#metricTests").textContent = catalog.filter((test) => test.activo).length;
  $("#metricToday").textContent = todayRequests.length;
  $("#metricPending").textContent = pending;
  renderBars("#dateStats", countBy(state.requests, "date"), "Sin solicitudes registradas");
  renderBars("#testStats", countValues(state.requests.flatMap((req) => (req.tests || []).map((test) => requestParameter(test)))), "Sin pruebas solicitadas");
}

function renderBars(selector, counts, empty) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  $(selector).innerHTML = entries.length
    ? entries.map(([label, count]) => `<div class="bar"><span>${escapeHtml(label)} - ${count}</span><div><i style="width:${(count / max) * 100}%"></i></div></div>`).join("")
    : `<p class="note">${empty}</p>`;
}

function countBy(items, key) {
  return items.reduce((acc, item) => ((acc[item[key]] = (acc[item[key]] || 0) + 1), acc), {});
}

function countValues(values) {
  return values.reduce((acc, item) => ((acc[item] = (acc[item] || 0) + 1), acc), {});
}

function renderTabs() {
  $("#areaTabs").innerHTML = areas().map((area) =>
    `<button class="${area === selectedArea ? "active" : ""}" data-area="${escapeAttr(area)}">${escapeHtml(area)}</button>`
  ).join("");
  $("#areaTabs").onclick = (event) => {
    const button = event.target.closest("button[data-area]");
    if (!button) return;
    selectedArea = button.dataset.area;
    renderTabs();
    renderQuickProfiles();
    renderTestTree();
  };
}

function renderQuickProfiles() {
  const bar = $("#quickProfilesBar");
  if (!bar) return;

  const currentAreaTests = catalog.filter(t => t.activo && (!selectedArea || t.area === selectedArea));
  const currentAreaIds = new Set(currentAreaTests.map(t => t.id));

  bar.innerHTML = QUICK_PROFILES.map(profile => {
    let targetIds = [];
    if (profile.testIds === "ALL") {
      targetIds = currentAreaTests.map(t => t.id);
    } else {
      targetIds = profile.testIds.filter(id => currentAreaIds.has(id));
    }

    if (targetIds.length === 0) return "";

    const selectedCount = targetIds.filter(id => selectedTests.has(id)).length;
    const isAllSelected = selectedCount === targetIds.length && targetIds.length > 0;
    const isPartiallySelected = selectedCount > 0 && !isAllSelected;

    let chipClass = "quick-profile-chip";
    if (isAllSelected) chipClass += " active";
    else if (isPartiallySelected) chipClass += " partial";

    return `
      <button type="button" class="${chipClass}" data-profile-id="${escapeAttr(profile.id)}" title="${escapeAttr(profile.desc || profile.label)}">
        <span class="chip-icon">${profile.icon || "🏷️"}</span>
        <span>${escapeHtml(profile.label)}</span>
        <span class="chip-badge">${selectedCount}/${targetIds.length}</span>
      </button>
    `;
  }).join("");

  const clearBtn = $("#quickProfileClearBtn");
  if (clearBtn) {
    clearBtn.style.display = selectedTests.size > 0 ? "inline-flex" : "none";
  }
}

function toggleQuickProfile(profileId) {
  const profile = QUICK_PROFILES.find(p => p.id === profileId);
  if (!profile) return;

  const currentAreaTests = catalog.filter(t => t.activo && (!selectedArea || t.area === selectedArea));
  const currentAreaIds = new Set(currentAreaTests.map(t => t.id));

  let targetIds = [];
  if (profile.testIds === "ALL") {
    targetIds = currentAreaTests.map(t => t.id);
  } else {
    targetIds = profile.testIds.filter(id => currentAreaIds.has(id));
  }

  if (targetIds.length === 0) {
    return toast("No hay pruebas disponibles para este perfil en el área actual.");
  }

  const allSelected = targetIds.every(id => selectedTests.has(id));

  if (allSelected) {
    targetIds.forEach(id => {
      selectedTests.delete(id);
      assignedBlocks = assignedBlocks.filter(b => !(b.ids && b.ids.length === 1 && b.ids[0] === id));
    });
    assignedBlocks = assignedBlocks.filter(b => b.ids && b.ids.some(id => selectedTests.has(id)));
  } else {
    targetIds.forEach(id => {
      if (!selectedTests.has(id)) {
        selectedTests.add(id);
        const testObj = catalog.find(t => t.id === id);
        const name = testObj ? (testObj.determinacion || testObj.parametro || testObj.nombre) : id;
        assignedBlocks.push({ type: "Parámetro", name, ids: [id] });
      }
    });
  }

  autosaveDraft();
  renderQuickProfiles();
  renderTestTree();
  renderRequiredSamples();
}

function renderTestTree() {
  const query = $("#testSearch") ? $("#testSearch").value.trim().toLowerCase() : "";
  const items = catalog.filter((test) =>
    test.activo && test.area === selectedArea &&
    (!query || catalogSearchText(test).includes(query))
  );

  const groupsMap = new Map();
  items.forEach(test => {
    const clasName = catalogClassification(test) || test.categoria || "GENERAL";
    if (!groupsMap.has(clasName)) {
      groupsMap.set(clasName, {
        name: clasName,
        orden: Number(test.orden) || 0,
        tests: []
      });
    }
    const group = groupsMap.get(clasName);
    group.tests.push(test);
    if ((Number(test.orden) || 0) < group.orden) {
      group.orden = Number(test.orden) || 0;
    }
  });

  const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => {
    return a.orden - b.orden || a.name.localeCompare(b.name);
  });

  const currentRequest = selectedRequestIndex !== null ? state.requests[selectedRequestIndex] : null;
  const purgedTestIds = new Set(
    currentRequest?.tests?.filter(t => t.depurado).map(t => t.id) || []
  );

  let treeHtml = "";
  if (sortedGroups.length === 0) {
    treeHtml = `<div class="opt-empty-state"><p class="note">No hay pruebas que coincidan con la búsqueda.</p></div>`;
  } else {
    treeHtml = `
      <div class="opt-test-tree">
        ${sortedGroups.map(group => {
          const groupTestIds = group.tests.map(t => t.id);
          const selectedInGroup = groupTestIds.filter(id => selectedTests.has(id)).length;
          const isGroupAllSelected = selectedInGroup === groupTestIds.length && groupTestIds.length > 0;

          return `
            <div class="opt-category-block">
              <div class="opt-category-header">
                <div class="opt-cat-title-wrap">
                  <span class="opt-cat-title">${escapeHtml(group.name)}</span>
                  <span class="opt-cat-count">${selectedInGroup}/${group.tests.length}</span>
                </div>
                <div class="opt-cat-actions">
                  <button type="button" class="opt-cat-btn ${isGroupAllSelected ? 'all-active' : ''}" data-action="toggle-group" data-cat-name="${escapeAttr(group.name)}">
                    ${isGroupAllSelected ? 'Deseleccionar Grupo' : 'Seleccionar Grupo'}
                  </button>
                </div>
              </div>
              <div class="opt-cards-grid">
                ${group.tests.map(test => {
                  const isSelected = selectedTests.has(test.id);
                  const isPurged = purgedTestIds.has(test.id);
                  const det = (test.determinacion || test.nombre || "").trim();
                  const param = (test.parametro || test.nombre || "").trim();
                  const sample = (test.muestra || "SANGRE").trim();
                  const unit = (test.unidad || "").trim();
                  
                  let cardClass = "opt-test-card";
                  if (isSelected) cardClass += " active";
                  if (isPurged) cardClass += " purged";

                  return `
                    <div class="${cardClass}" data-test-id="${escapeAttr(test.id)}" tabindex="0" role="button" aria-pressed="${isSelected}">
                      <div class="opt-card-body">
                        <div class="opt-card-header-row">
                          <span class="opt-card-det">${escapeHtml(det)}</span>
                          <span class="opt-card-check">✓</span>
                        </div>
                        ${param && param !== det ? `<div class="opt-card-param">${escapeHtml(param)}</div>` : ''}
                        <div class="opt-card-meta">
                          <span class="opt-badge sample">${escapeHtml(sample)}</span>
                          ${unit ? `<span class="opt-badge unit">${escapeHtml(unit)}</span>` : ''}
                          ${isPurged ? `<span class="opt-badge purged">DEPURADO</span>` : ''}
                        </div>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  const assignedTestsList = [...selectedTests].map(id => catalog.find(t => t.id === id)).filter(Boolean);
  assignedTestsList.sort(sortTestsByHierarchy);

  const assignedHtml = assignedTestsList.length > 0 ? `
    <div class="assigned-blocks-panel" style="margin-bottom: 12px; padding: 12px; background: #ffffff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid var(--teal-2); padding-bottom: 6px;">
        <h3 style="margin: 0; font-size: 0.88rem; color: var(--teal); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
          Pruebas Asignadas (${assignedTestsList.length})
        </h3>
        <button type="button" id="clearAllBlocks" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 600; background: #fee2e2; color: #b91c1c; border: none; border-radius: 4px; cursor: pointer; transition: all 0.2s;">
          Limpiar Todo
        </button>
      </div>
      <div style="display: grid; gap: 6px; max-height: 280px; overflow-y: auto; padding-right: 2px;">
        ${assignedTestsList.map((test, i) => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.82rem;">
            <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
              <span style="color: var(--teal); font-weight: 700; font-size: 0.75rem; min-width: 18px;">${i + 1}.</span>
              <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <strong>${escapeHtml(test.determinacion || test.nombre)}</strong>
                ${test.parametro && test.parametro !== test.determinacion ? `<span style="color: var(--muted); font-size: 0.75rem; margin-left: 4px;">(${escapeHtml(test.parametro)})</span>` : ''}
              </div>
            </div>
            <button type="button" data-remove-test="${escapeAttr(test.id)}" style="padding: 3px 8px; font-size: 0.75rem; background: #f1f5f9; color: var(--red); border: 1px solid #fecaca; border-radius: 4px; cursor: pointer; font-weight: 600; flex-shrink: 0; margin-left: 6px;">
              ✕
            </button>
          </div>
        `).join("")}
      </div>
    </div>
  ` : `
    <div class="assigned-blocks-panel" style="padding: 14px; background: #ffffff; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-size: 0.84rem; text-align: center;">
      Ninguna prueba asignada
    </div>
  `;

  $("#testTree").innerHTML = treeHtml;
  const container = $("#assignedBlocksContainer");
  if (container) container.innerHTML = assignedHtml;

  renderQuickProfiles();

  $("#testTree").onclick = (event) => {
    const groupBtn = event.target.closest("button[data-action='toggle-group']");
    if (groupBtn) {
      event.preventDefault();
      event.stopPropagation();
      const catName = groupBtn.dataset.catName;
      const groupTests = items.filter(t => (catalogClassification(t) || t.categoria || "GENERAL") === catName);
      const allSelected = groupTests.every(t => selectedTests.has(t.id));

      if (allSelected) {
        groupTests.forEach(t => {
          selectedTests.delete(t.id);
          assignedBlocks = assignedBlocks.filter(b => !(b.ids && b.ids.length === 1 && b.ids[0] === t.id));
        });
      } else {
        groupTests.forEach(t => {
          if (!selectedTests.has(t.id)) {
            selectedTests.add(t.id);
            assignedBlocks.push({ type: "Parámetro", name: t.determinacion || t.parametro || t.nombre, ids: [t.id] });
          }
        });
      }

      autosaveDraft();
      renderTestTree();
      renderRequiredSamples();
      return;
    }

    const card = event.target.closest(".opt-test-card");
    if (card) {
      event.preventDefault();
      event.stopPropagation();
      const testId = card.dataset.testId;
      if (!testId) return;

      if (selectedTests.has(testId)) {
        selectedTests.delete(testId);
        assignedBlocks = assignedBlocks.filter(b => !(b.ids && b.ids.length === 1 && b.ids[0] === testId));
      } else {
        selectedTests.add(testId);
        const testObj = catalog.find(t => t.id === testId);
        const name = testObj ? (testObj.determinacion || testObj.parametro || testObj.nombre) : testId;
        assignedBlocks.push({ type: "Parámetro", name, ids: [testId] });
      }

      autosaveDraft();
      renderTestTree();
      renderRequiredSamples();
      return;
    }
  };

  if (container) {
    container.onclick = (event) => {
      const removeBtn = event.target.closest("button[data-remove-test]");
      if (removeBtn) {
        event.preventDefault();
        event.stopPropagation();
        const testId = removeBtn.dataset.removeTest;
        selectedTests.delete(testId);
        assignedBlocks = assignedBlocks.filter(b => !(b.ids && b.ids.length === 1 && b.ids[0] === testId));
        autosaveDraft();
        renderTestTree();
        renderRequiredSamples();
        return;
      }

      if (event.target.id === "clearAllBlocks") {
        event.preventDefault();
        event.stopPropagation();
        selectedTests.clear();
        assignedBlocks = [];
        autosaveDraft();
        renderTestTree();
        renderRequiredSamples();
        return;
      }
    };
  }
}

function groupBy(items, keyFn) {
  const map = new Map();
  items.forEach(item => {
    const key = typeof keyFn === "function" ? keyFn(item) : (item[keyFn] || "Sin clasificar");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

function autosaveDraft() {
  const form = $("#patientForm");
  state.draft = Object.fromEntries(new FormData(form).entries());
  state.draft.selectedTests = [...selectedTests];
  state.draft.assignedBlocks = assignedBlocks;
  store.set("clinlab.draft", state.draft);
}

function requestFromForm() {
  const data = Object.fromEntries(new FormData($("#patientForm")).entries());
  const map = testsById();
  const existingRequest = selectedRequestIndex !== null ? state.requests[selectedRequestIndex] : null;
  const sampleTypes = new Set();
  [...selectedTests].forEach(testId => {
    const test = catalog.find(t => t.id === testId);
    if (test && test.muestra) sampleTypes.add(test.muestra.trim().toUpperCase());
  });
  return {
    ...data,
    requiredSamples: Array.from(sampleTypes).sort(),
    assignedBlocks: [...assignedBlocks],
    code: data.code || uid(),
    reportUpdatedAt: new Date().toISOString(),
    tests: [...selectedTests].map((id) => {
      const existing = existingRequest?.tests?.find((test) => test.id === id);
      const catalogItem = map[id] || {};
      
      const area = catalogItem.area || existing?.area || "";
      const isOutsource = state.settings.outsourceAreas.includes(area);
      
      if (isOutsource) {
        return {
          id,
          area: area,
          determination: catalogDetermination(catalogItem) || existing?.determination || existing?.determinacion || "",
          parameter: catalogName(catalogItem) || existing?.parameter || existing?.parametro || existing?.name || "",
          sample: catalogItem.muestra || existing?.sample || existing?.muestra || "",
          depurado: (existing?.depurado && !(existing?.result || existing?.notes)) || false
        };
      }
      
      return {
        id,
        name: catalogName(catalogItem) || existing?.name || id,
        area: catalogItem.area || existing?.area || "",
        determination: catalogDetermination(catalogItem) || existing?.determination || existing?.determinacion || "",
        classification: catalogClassification(catalogItem) || existing?.classification || existing?.clasificacion || existing?.category || "",
        parameter: catalogName(catalogItem) || existing?.parameter || existing?.parametro || existing?.name || "",
        type: catalogItem.tipo || existing?.type || existing?.tipo || "",
        sample: catalogItem.muestra || existing?.sample || existing?.muestra || "",
        unit: catalogItem.unidad || existing?.unit || existing?.unidad || "",
        minimum: catalogItem.minimo || existing?.minimum || existing?.minimo || "",
        maximum: catalogItem.maximo || existing?.maximum || existing?.maximo || "",
        reference: catalogReference(catalogItem) || existing?.reference || existing?.referencia || "",
        category: catalogClassification(catalogItem) || existing?.category || "",
        orden: catalogItem.orden ?? existing?.orden ?? 0,
        depurado: (existing?.depurado && !(existing?.result || existing?.notes)) || false,
        result: existing?.result || "",
        notes: existing?.notes || "",
        samples: id >= "PA-001" && id <= "PA-004" ? existing?.samples || ["", "", ""] : null,
        updatedAt: existing?.updatedAt || ""
      };
    })
  };
}

let pendingSaveAction = null;

function saveRequest(event) {
  event.preventDefault();
  if (!canWrite()) return;
  if (!selectedTests.size) return toast("Seleccione al menos una prueba.");
  saveDiagnosisToMemory();
  if (selectedRequestIndex !== null) {
    showConfirmSaveModal("update");
  } else {
    showConfirmSaveModal("save");
  }
}

function updateSelectedRequest() {
  if (!canWrite()) return;
  if (selectedRequestIndex === null) return toast("Seleccione una solicitud para editar.");
  if (!selectedTests.size) return toast("Seleccione al menos una prueba.");
  saveDiagnosisToMemory();
  showConfirmSaveModal("update");
}

function showConfirmSaveModal(action) {
  pendingSaveAction = action;
  
  const tempReq = requestFromForm();
  
  $("#confirmSaveTitle").textContent = "Verificación de Solicitud";
  $("#confirmSaveModal").querySelector(".modalBox").classList.remove("confirm-save-modal-box");
  
  $("#confirmSaveBtn").textContent = "Confirmar y Cerrar";
  $("#confirmSaveBtn").hidden = false;
  $("#confirmSaveReportBtn").hidden = false;
  $("#confirmSavePrintBtn").hidden = true;
  
  const patientCard = `
    <div class="summaryGrid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 12px; margin-bottom: 12px; padding: 10px; background: #f8fafc; border: 1px solid var(--line); border-radius: 8px; font-size: 0.9rem;">
      <div style="grid-column: span 2;"><strong>Paciente:</strong> ${escapeHtml(tempReq.name || "-")}</div>
      <div><strong>Edad:</strong> ${escapeHtml(tempReq.age || "-")}</div>
      <div><strong>Género:</strong> ${escapeHtml(tempReq.gender || "-")}</div>
      <div><strong>Servicio:</strong> ${escapeHtml(tempReq.service || "-")}</div>
      <div><strong>Médico:</strong> ${escapeHtml(tempReq.doctor || "-")}</div>
      <div><strong>Fecha:</strong> ${escapeHtml(tempReq.date || "-")}</div>
      <div><strong>Registro:</strong> ${escapeHtml(tempReq.code || "-")}</div>
      <div style="grid-column: span 4;"><strong>Diagnóstico:</strong> ${escapeHtml(tempReq.diagnosis || "-")}</div>
    </div>
  `;

  const internalTests = [];
  const outsourcedTests = [];
  
  tempReq.tests.forEach(test => {
    const catalogItem = catalog.find(c => c.id === test.id) || {};
    const area = catalogItem.area || test.area || "GENERAL";
    const isOutsource = state.settings.outsourceAreas.includes(area);
    if (isOutsource) {
      outsourcedTests.push(test);
    } else {
      internalTests.push(test);
    }
  });

  internalTests.sort(sortTestsForReport);
  outsourcedTests.sort(sortTestsForReport);

  const internalListHtml = internalTests.length > 0
    ? internalTests.map(test => `<li><span>${escapeHtml(requestParameter(test))}</span> <small style="color: var(--teal); font-size: 0.75rem;">${escapeHtml(requestDetermination(test))}</small></li>`).join("")
    : '<p style="color: var(--muted); font-size: 0.85rem; padding: 6px;">Ninguna asignada</p>';

  const outsourcedListHtml = outsourcedTests.length > 0
    ? outsourcedTests.map(test => `<li><span>${escapeHtml(requestParameter(test))}</span> <small style="color: #64748b; font-size: 0.75rem;">${escapeHtml(requestDetermination(test))}</small></li>`).join("")
    : '<p style="color: var(--muted); font-size: 0.85rem; padding: 6px;">Ninguna asignada</p>';

  const testsComparison = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; text-align: left;">
      <div>
        <h3 style="color: var(--teal); font-size: 0.95rem; border-bottom: 2px solid var(--teal); padding-bottom: 4px; margin-bottom: 8px; font-weight: 700;">Pruebas de Trabajo Interno</h3>
        <ul class="verification-test-list">
          ${internalListHtml}
        </ul>
      </div>
      <div>
        <h3 style="color: #475569; font-size: 0.95rem; border-bottom: 2px solid #94a3b8; padding-bottom: 4px; margin-bottom: 8px; font-weight: 700;">Pruebas para Envío Externo</h3>
        <ul class="verification-test-list outsourced">
          ${outsourcedListHtml}
        </ul>
      </div>
    </div>
  `;

  $("#confirmSaveContent").innerHTML = patientCard + testsComparison;
  
  $("#confirmSaveModal").hidden = false;
  $("#confirmSaveBtn").focus();
}

function showResultsEntryModal() {
  const tempReq = requestFromForm();
  
  $("#confirmSaveTitle").textContent = "Ingreso de Resultados";
  $("#confirmSaveModal").querySelector(".modalBox").classList.add("confirm-save-modal-box");
  
  $("#confirmSaveBtn").textContent = "Guardar y Cerrar";
  $("#confirmSaveBtn").hidden = false;
  $("#confirmSaveReportBtn").hidden = true;
  $("#confirmSavePrintBtn").hidden = false;
  
  const patientCard = `
    <div class="summaryGrid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 12px; margin-bottom: 12px; padding: 10px; background: #f8fafc; border: 1px solid var(--line); border-radius: 8px; font-size: 0.9rem;">
      <div style="grid-column: span 2;"><strong>Paciente:</strong> ${escapeHtml(tempReq.name || "-")}</div>
      <div><strong>Edad:</strong> ${escapeHtml(tempReq.age || "-")}</div>
      <div><strong>Género:</strong> ${escapeHtml(tempReq.gender || "-")}</div>
      <div><strong>Servicio:</strong> ${escapeHtml(tempReq.service || "-")}</div>
      <div><strong>Médico:</strong> ${escapeHtml(tempReq.doctor || "-")}</div>
      <div><strong>Fecha:</strong> ${escapeHtml(tempReq.date || "-")}</div>
      <div><strong>Registro:</strong> ${escapeHtml(tempReq.code || "-")}</div>
    </div>
  `;

  const internalTests = tempReq.tests.filter(test => {
    const catalogItem = catalog.find(c => c.id === test.id) || {};
    const area = catalogItem.area || test.area || "GENERAL";
    return !state.settings.outsourceAreas.includes(area);
  });

  const sortedTests = internalTests.sort(sortTestsForReport);
  
  let prevArea = null;
  const tableRows = sortedTests.map((test, index) => {
    const area = test.area || "GENERAL";
    const areaNorm = area.trim().toUpperCase();
    
    let html = "";
    if (index === 0 || areaNorm !== prevArea) {
      html += `
        <tr class="area-header-row">
          <td colspan="5" style="font-weight: 700; color: var(--teal); background-color: var(--teal-2); padding: 6px 10px; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 0.5px; border-bottom: 1.5px solid var(--teal) !important;">
            ${escapeHtml(areaNorm)}
          </td>
        </tr>
      `;
      prevArea = areaNorm;
    }
    
    const detName = requestDetermination(test);
    const paramName = requestParameter(test);
    const unit = requestUnit(test) || "---";
    const ref = requestReference(test) || "---";
    
    html += `
      <tr>
        <td style="font-weight: 600; color: var(--teal); vertical-align: middle;">${escapeHtml(detName)}</td>
        <td style="vertical-align: middle;">${escapeHtml(paramName)}</td>
        <td>
          <input type="text" class="modal-result-input" data-test-id="${test.id}" value="${escapeAttr(test.result || '')}" placeholder="Resultado" oninput="this.value = this.value.toUpperCase()" />
        </td>
        <td style="font-size: 0.85rem; color: var(--muted); vertical-align: middle; line-height: 1.2;">
          ${escapeHtml(unit)} <br> <small style="font-size: 0.75rem;">Ref: ${escapeHtml(ref)}</small>
        </td>
        <td>
          <input type="text" class="modal-notes-input" data-test-id="${test.id}" value="${escapeAttr(test.notes || '')}" placeholder="Observaciones" oninput="this.value = this.value.toUpperCase()" />
        </td>
      </tr>
    `;
    return html;
  }).join("");

  const testsTable = `
    <div class="modal-result-table-container">
      <table class="modal-result-table">
        <thead>
          <tr>
            <th style="width: 25%;">Determinación</th>
            <th style="width: 25%;">Parámetro</th>
            <th style="width: 20%;">Resultado</th>
            <th style="width: 15%;">Unidad / Ref</th>
            <th style="width: 15%;">Observaciones</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;

  $("#confirmSaveContent").innerHTML = patientCard + testsTable;
  
  const firstInput = $("#confirmSaveContent").querySelector(".modal-result-input");
  if (firstInput) firstInput.focus();
}

function confirmSaveFinal(shouldPrint = false, saveOnly = false) {
  try {
    const testResults = {};
    if (!saveOnly) {
      [...selectedTests].forEach(testId => {
        const resInput = $(`.modal-result-input[data-test-id="${testId}"]`);
        const notesInput = $(`.modal-notes-input[data-test-id="${testId}"]`);
        testResults[testId] = {
          result: resInput ? resInput.value.toUpperCase().trim() : "",
          notes: notesInput ? notesInput.value.toUpperCase().trim() : ""
        };
      });
    }

    const finalReq = requestFromForm();
    finalReq.tests.forEach(test => {
      if (!saveOnly && testResults[test.id]) {
        test.result = testResults[test.id].result;
        test.notes = testResults[test.id].notes;
        if (test.result || test.notes) {
          test.updatedAt = new Date().toISOString();
        }
      }
    });

    if (pendingSaveAction === "save") {
      if (!finalReq.code || state.requests.some(r => r && r.code === finalReq.code)) {
        finalReq.code = uid();
      }
      state.requests.push(finalReq);
      updateExternalRegistry(finalReq);
      toast("Solicitud guardada.");
      selectedTests = new Set();
      state.draft = {};
      store.set("clinlab.draft", {});
      statsEngine.invalidate();
      clearPatient();
    } else if (pendingSaveAction === "update") {
      state.requests[selectedRequestIndex] = finalReq;
      updateExternalRegistry(finalReq);
      toast("Solicitud actualizada.");
      statsEngine.invalidate();
      renderAll();
    }
    saveAll();

    if (shouldPrint) {
      $("#reportSearch").value = finalReq.code;
      $("#reportDate").value = "";
      showView("reports");
      setTimeout(() => {
        document.body.dataset.printMode = "reports";
        renderReports();
        window.print();
      }, 300);
    }
  } catch (err) {
    console.error("Error in confirmSaveFinal:", err);
    appAlert("Error: " + err.stack, "Error crítico al guardar");
  } finally {
    const modal = $("#confirmSaveModal");
    if (modal) modal.hidden = true;
    pendingSaveAction = null;
  }
}

function confirmSave() {
  const isStep2 = !$("#confirmSavePrintBtn").hidden;
  if (isStep2) {
    confirmSaveFinal(false, false);
  } else {
    confirmSaveFinal(false, true);
  }
}

function cancelSave() {
  $("#confirmSaveModal").hidden = true;
  pendingSaveAction = null;
}

async function deleteSelectedRequest() {
  if (!canWrite()) return;
  if (selectedRequestIndex === null) return toast("Seleccione una solicitud para borrar.");
  if (!await appConfirm("Se eliminara la solicitud seleccionada y sus pruebas asociadas.", "Borrar solicitud", "danger")) return;
  const reqToDelete = state.requests[selectedRequestIndex];
  if (reqToDelete) {
    deleteFromExternalRegistry(reqToDelete.code);
    try {
      await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: reqToDelete.code })
      });
    } catch (e) {
      console.error("Error al borrar en BD:", e);
    }
  }
  state.requests.splice(selectedRequestIndex, 1);
  selectedRequestIndex = null;
  selectedTests = new Set();
  saveAll();
  clearPatient();
  toast("Solicitud borrada.");
}

function saveDiagnosisToMemory() {
  const diagInput = $("#patientDiagnosis");
  if (diagInput && diagInput.value.trim()) {
    const newDiag = diagInput.value.trim().toUpperCase().replace(/\s+/g, " ");
    state.settings.diagnostics = state.settings.diagnostics || [];
    if (!state.settings.diagnostics.includes(newDiag)) {
      state.settings.diagnostics.push(newDiag);
      state.settings.diagnostics.sort();
      renderDiagnosisSuggestions();
    }
  }
}

function renderDiagnosisSuggestions() {
  const datalist = $("#diagnosisSuggestions");
  if (!datalist) return;
  state.settings.diagnostics ||= [];
  datalist.innerHTML = state.settings.diagnostics
    .map(diag => `<option value="${escapeHtml(diag)}"></option>`)
    .join("");
}

function updateGenderButtons() {
  const currentVal = $("#patientGender") ? $("#patientGender").value : "";
  $$(".gender-btn-group .gender-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.gender === currentVal);
  });
}

function updateStatusButtons() {
  const currentVal = $("#sampleStatus") ? $("#sampleStatus").value : "ACEPTADO";
  $$(".sample-status-group .status-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === currentVal);
  });
}

function updateAttentionButtons() {
  const currentVal = $("#attentionType") ? $("#attentionType").value : "";
  $$(".attention-btn-group .attention-btn").forEach((btn) => {
    if (btn.dataset.attention === currentVal) {
      btn.style.backgroundColor = "var(--teal)";
      btn.style.color = "white";
    } else {
      btn.style.backgroundColor = "white";
      btn.style.color = "inherit";
    }
  });
}

function updateFormProgress() {
  const form = $("#patientForm");
  if (!form) return;
  const requiredFields = Array.from(form.querySelectorAll("[required]"));
  if (requiredFields.length === 0) return;
  let filled = 0;
  requiredFields.forEach(field => {
    if (field.value && field.value.trim() !== "") filled++;
  });
  const percentage = Math.round((filled / requiredFields.length) * 100);
  const bar = $("#formProgressBar");
  const text = $("#formProgressText");
  if (bar) bar.style.width = `${percentage}%`;
  if (text) text.textContent = `${percentage}%`;
}

function renderRequiredSamples() {
  const container = $("#requiredSamplesList");
  if (!container) return;
  if (selectedTests.size === 0) {
    container.textContent = "Ninguna prueba seleccionada";
    return;
  }
  const sampleTypes = new Set();
  selectedTests.forEach(testId => {
    const test = catalog.find(t => t.id === testId);
    if (test && test.muestra) {
      const sample = test.muestra.trim().toUpperCase();
      if (sample) {
        sampleTypes.add(sample);
      }
    }
  });
  if (sampleTypes.size === 0) {
    container.textContent = "No requiere muestras específicas";
  } else {
    container.textContent = Array.from(sampleTypes).sort().join(", ");
  }
}

function clearPatient() {
  $("#patientForm").reset();
  if ($("#patientGender")) $("#patientGender").value = "";
  updateGenderButtons();
  if ($("#sampleStatus")) $("#sampleStatus").value = "ACEPTADO";
  updateStatusButtons();
  if ($("#attentionType")) $("#attentionType").value = "";
  updateAttentionButtons();
  $("#patientForm").date.value = today();
  updateFormProgress();
  $("#patientForm").code.value = uid();
  selectedRequestIndex = null;
  selectedTests = new Set();
  assignedBlocks = [];
  const banner = $("#purgedWarningBanner");
  if (banner) banner.style.display = "none";
  renderAll();
}

let patientSearchTimer = null;
let searchResultsCache = null;

async function renderPatientRows() {
  const searchInput = $("#patientSearchInput");
  const query = searchInput ? searchInput.value.toLowerCase().trim() : "";
  
  let source = state.requests;
  
  if (query) {
    if (patientSearchTimer) clearTimeout(patientSearchTimer);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        source = data;
      } else {
        throw new Error("Local backend search fallback");
      }
      searchResultsCache = source;
    } catch (e) {
      const activeMatches = (state.requests || []).filter(req => 
        (req.name && req.name.toLowerCase().includes(query)) ||
        (req.code && req.code.toLowerCase().includes(query)) ||
        (req.insuranceCode && req.insuranceCode.toLowerCase().includes(query)) ||
        (req.date && req.date.includes(query))
      );
      const idbMatches = await requestsIDB.search(query);
      const map = new Map();
      for (const r of [...activeMatches, ...idbMatches]) {
        if (r && r.code) map.set(r.code, r);
      }
      source = Array.from(map.values());
      searchResultsCache = source;
    }
  } else {
    searchResultsCache = null;
  }
  
  // Show all matches up to 50
  const displayList = query ? source.slice(0, 50) : source.slice().reverse();
  
  $("#patientRows").innerHTML = displayList.map((req, idx) => {
    // If not searching, use standard index. If searching, use the cache index.
    const index = query ? idx : state.requests.indexOf(req);
    const hasPurged = (req.tests || []).some(t => t.depurado);
    const badge = hasPurged ? ` <span style="font-size: 0.7em; background: #fee2e2; color: #b91c1c; padding: 2px 6px; border-radius: 4px; font-weight: bold; border: 1px solid #fca5a5;" title="Esta solicitud tiene pruebas depuradas por inactividad">Depurado</span>` : '';
    const isSelected = (!query && index === selectedRequestIndex) || (query && searchResultsCache[idx].code === (state.requests[selectedRequestIndex] || {}).code);
    return `<tr data-index="${index}" data-is-search="${query ? 'true' : 'false'}" class="${isSelected ? "selected" : ""}"><td>${escapeHtml(req.code)}</td><td>${escapeHtml(req.name)}${badge}</td><td>${escapeHtml(req.date)}</td></tr>`;
  }).join("") || `<tr><td colspan="3">Sin solicitudes</td></tr>`;
  
  $("#patientRows").onclick = async (event) => {
    const row = event.target.closest("tr[data-index]");
    if (!row) return;
    const index = Number(row.dataset.index);
    const isSearch = row.dataset.isSearch === 'true';
    
    let req;
    if (isSearch) {
      req = searchResultsCache[index];
      // Try to find it in active memory, if not add it temporarily
      let activeIndex = state.requests.findIndex(r => r.code === req.code);
      if (activeIndex === -1) {
        state.requests.push(req);
        activeIndex = state.requests.length - 1;
      }
      row.dataset.index = activeIndex; // Update for future clicks
      req = state.requests[activeIndex];
    } else {
      req = state.requests[index];
    }
    
    if (!req) return;
    
    const choice = await showAppDialog({
      title: "Cargar paciente",
      message: `Ha seleccionado a ${req.name}. ¿Desea EDITAR este registro anterior, o utilizar sus datos para crear una NUEVA VISITA limpia?`,
      confirmLabel: "Editar registro",
      cancelLabel: "Nueva visita",
      variant: "info"
    });
    
    if (choice === null) return;
    
    const loadIndex = isSearch ? state.requests.findIndex(r => r.code === req.code) : index;
    loadRequest(loadIndex, choice);
  };
}

function renderSettingsAccess() {
  const accessPanel = $(".settingsAccess");
  if (accessPanel) {
    accessPanel.style.display = "none";
  }
  $$(".adminOnly").forEach((section) => {
    section.classList.remove("lockedPanel");
    section.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = false;
    });
  });
}

function unlockSettings() {
  settingsUnlocked = true;
  renderSettingsAccess();
  toast("Configuración disponible.");
}

function lockSettings() {
  settingsUnlocked = true;
  renderSettingsAccess();
}

function loadRequest(index, isEdit = true) {
  const req = state.requests[index];
  if (!req) return;
  
  Object.entries(req).forEach(([key, value]) => {
    if ($("#patientForm")[key] && key !== "tests" && key !== "assignedBlocks" && key !== "code" && key !== "date") $("#patientForm")[key].value = value || "";
  });
  
  if (isEdit) {
    selectedRequestIndex = index;
    $("#patientForm").code.value = req.code || "";
    $("#patientForm").date.value = req.date || today();
    selectedTests = new Set(req.tests.map((test) => test.id));
    assignedBlocks = req.assignedBlocks || [];
    const hasPurged = (req.tests || []).some(t => t.depurado);
    const banner = $("#purgedWarningBanner");
    if (banner) banner.style.display = hasPurged ? "block" : "none";
  } else {
    selectedRequestIndex = null;
    $("#patientForm").code.value = uid();
    $("#patientForm").date.value = today();
    selectedTests = new Set();
    assignedBlocks = [];
    state.draft = {};
    const banner = $("#purgedWarningBanner");
    if (banner) banner.style.display = "none";
  }
  
  updateGenderButtons();
  updateStatusButtons();
  updateAttentionButtons();
  updateFormProgress();
  renderAll();
}

function renderCatalogFilters() {
  fillSelect("#catalogArea", ["", ...areas()], "Todas las areas");
}

function renderCatalogLegacy() {
  const query = $("#catalogSearch").value.trim().toLowerCase();
  const area = $("#catalogArea").value;
  const filtered = catalog.filter((test) =>
    (test.activo) &&
    (!area || test.area === area) &&
    (!query || catalogSearchText(test).includes(query))
  ).sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));

  const guide = catalog.find((test) => test.activo && (!area || test.area === area)) || catalog.find((test) => test.activo);
  $("#catalogGuide").innerHTML = guide
    ? `Guia de estructura: <strong>${escapeHtml(guide.id)}</strong> - ${escapeHtml(catalogDetermination(guide))} / ${escapeHtml(catalogClassification(guide))} / ${escapeHtml(guide.area)}`
    : "Guia de estructura: sin datos previos.";

  const groups = groupBy(filtered, (test) => catalogClassification(test));

  $("#catalogRows").innerHTML = Array.from(groups.entries()).map(([category, tests]) => `
    <tr class="catalogGroupRow" data-category="${escapeAttr(category)}" draggable="true">
      <td colspan="8">✥ SUBÁREA: ${escapeHtml(category)} <small>(Arrastre para mover grupo completo)</small></td>
    </tr>
    ${tests.map((test) => {
      const editable = editingCatalog.has(test.id);
      return `
        <tr data-id="${escapeAttr(test.id)}" draggable="true">
          <td><span class="dragHandle">✥</span></td>
          <td><input data-field="id" value="${escapeAttr(test.id)}" placeholder="HE-001" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="nombre" value="${escapeAttr(test.nombre)}" placeholder="Nombre de la prueba" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="referencia" value="${escapeAttr(test.referencia)}" placeholder="Valor de referencia" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="categoria" list="categorySuggestions" value="${escapeAttr(test.categoria)}" placeholder="Subárea / perfil" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="area" list="areaSuggestions" value="${escapeAttr(test.area)}" placeholder="Área" ${editable ? "" : "readonly"} /></td>
          <td><select data-field="activo" ${editable ? "" : "disabled"}><option value="true" ${test.activo ? "selected" : ""}>Activo</option><option value="false" ${!test.activo ? "selected" : ""}>Inactivo</option></select></td>
          <td class="rowMenu"><button data-action="edit">Editar</button><button data-action="delete">Borrar</button></td>
        </tr>
      `;
    }).join("")}
  `).join("");

  ensureCatalogDatalists();
  $("#catalogRows").oninput = updateCatalogCell;
  $("#catalogRows").onchange = updateCatalogCell;
  $("#catalogRows").onclick = catalogAction;
  bindCatalogDrag();
}

function renderCatalog() {
  const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
  
  const addBtn = $("#addTest");
  const importBtn = $("#importCatalogBtn");
  const saveBtn = $("#saveCatalog");
  if (addBtn) addBtn.hidden = isNode;
  if (importBtn) importBtn.hidden = isNode;
  if (saveBtn) saveBtn.hidden = isNode;

  const query = $("#catalogSearch").value.trim().toLowerCase();
  const area = $("#catalogArea").value;
  const filtered = catalog.filter((test) =>
    (test.activo) &&
    (!area || test.area === area) &&
    (!query || catalogSearchText(test).includes(query))
  ).sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));

  const guide = catalog.find((test) => test.activo && (!area || test.area === area)) || catalog.find((test) => test.activo);
  $("#catalogGuide").innerHTML = guide
    ? `Guia de estructura: <strong>${escapeHtml(guide.id)}</strong> - ${escapeHtml(catalogDetermination(guide))} / ${escapeHtml(catalogClassification(guide))} / ${escapeHtml(guide.area)}`
    : "Guia de estructura: sin datos previos.";

  const groups = groupBy(filtered, (test) => catalogClassification(test));
  $("#catalogRows").innerHTML = Array.from(groups.entries()).map(([category, tests]) => `
    <tr class="catalogGroupRow" data-category="${escapeAttr(category)}" draggable="${!isNode}">
      <td colspan="13">SUBAREA: ${escapeHtml(category)} ${isNode ? "" : "<small>(Arrastre para mover grupo completo)</small>"}</td>
    </tr>
    ${tests.map((test) => {
      const editable = !isNode && editingCatalog.has(test.id);
      return `
        <tr data-id="${escapeAttr(test.id)}" draggable="${!isNode}">
          <td><span class="dragHandle">${isNode ? "" : "::"}</span></td>
          <td><input data-field="area" list="areaSuggestions" value="${escapeAttr(test.area)}" placeholder="Área" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="determinacion" value="${escapeAttr(test.determinacion || "")}" placeholder="Determinación" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="clasificacion" list="categorySuggestions" value="${escapeAttr(catalogClassification(test))}" placeholder="Clasificación" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="parametro" value="${escapeAttr(catalogParameter(test))}" placeholder="Parámetro" ${editable ? "" : "readonly"} /></td>
          <td><select data-field="tipo" ${editable ? "" : "disabled"}><option value="CUANTITATIVO" ${test.tipo === "CUANTITATIVO" ? "selected" : ""}>Cuantitativo</option><option value="CUALITATIVO" ${test.tipo === "CUALITATIVO" ? "selected" : ""}>Cualitativo</option></select></td>
          <td><input data-field="muestra" list="sampleSuggestions" value="${escapeAttr(test.muestra || "")}" placeholder="Muestra" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="unidad" list="unitSuggestions" value="${escapeAttr(test.unidad || "")}" placeholder="Unidad" ${editable ? "" : "readonly"} /></td>
          <td><input data-field="minimo" value="${escapeAttr(test.minimo || "")}" placeholder="Mínimo" ${editable && test.tipo !== "CUALITATIVO" ? "" : "readonly"} /></td>
          <td><input data-field="maximo" value="${escapeAttr(test.maximo || "")}" placeholder="Máximo" ${editable && test.tipo !== "CUALITATIVO" ? "" : "readonly"} /></td>
          <td><input data-field="referencia" value="${escapeAttr(test.referencia || "")}" placeholder="Referencia" ${editable ? "" : "readonly"} /></td>
          <td><input type="checkbox" data-field="activo" ${test.activo ? "checked" : ""} disabled /></td>
          <td class="rowMenu">${isNode ? "" : `<button data-action="edit">Editar</button><button data-action="delete">Borrar</button>`}</td>
        </tr>
      `;
    }).join("")}
  `).join("");

  ensureCatalogDatalists();
  $("#catalogRows").oninput = updateCatalogCell;
  $("#catalogRows").onchange = updateCatalogCell;
  $("#catalogRows").onclick = catalogAction;
  bindCatalogDrag();
}

let draggedRowId = null;
let draggedCategory = null;

function bindCatalogDrag() {
  const rows = $("#catalogRows");
  rows.addEventListener("dragstart", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    if (tr.classList.contains("catalogGroupRow")) {
      draggedCategory = tr.dataset.category;
      draggedRowId = null;
    } else {
      draggedRowId = tr.dataset.id;
      draggedCategory = null;
    }
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  rows.addEventListener("dragover", (e) => {
    e.preventDefault();
    const tr = e.target.closest("tr");
    if (!tr) return;
    if (draggedCategory && tr.classList.contains("catalogGroupRow") && tr.dataset.category !== draggedCategory) {
      tr.style.borderTop = "4px solid var(--teal)";
    } else if (draggedRowId && !tr.classList.contains("catalogGroupRow") && tr.dataset.id !== draggedRowId) {
      tr.style.borderTop = "2px solid var(--teal)";
    }
  });

  rows.addEventListener("dragleave", (e) => {
    const tr = e.target.closest("tr");
    if (tr) tr.style.borderTop = "";
  });

  rows.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!canWrite()) return;
    const tr = e.target.closest("tr");
    if (tr) tr.style.borderTop = "";
    
    if (draggedCategory) {
      const targetCategory = tr?.closest(".catalogGroupRow")?.dataset.category || tr?.dataset.category;
      if (!targetCategory || targetCategory === draggedCategory) return;
      
      const categoryTests = catalog.filter(t => catalogClassification(t) === draggedCategory);
      const otherTests = catalog.filter(t => catalogClassification(t) !== draggedCategory);
      const targetIndex = otherTests.findIndex(t => catalogClassification(t) === targetCategory);
      
      if (targetIndex > -1) {
        otherTests.splice(targetIndex, 0, ...categoryTests);
        catalog = otherTests;
      }
    } else if (draggedRowId) {
      const targetId = tr?.dataset.id;
      if (!targetId || targetId === draggedRowId) return;

      const draggedIndex = catalog.findIndex(t => t.id === draggedRowId);
      const targetIndex = catalog.findIndex(t => t.id === targetId);
      
      if (draggedIndex > -1 && targetIndex > -1) {
        const [item] = catalog.splice(draggedIndex, 1);
        catalog.splice(targetIndex, 0, item);
      }
    }

    // Recalcular orden universal (0 = superior)
    catalog.forEach((test, index) => {
      test.orden = index;
    });
    
    saveAll();
    renderAll();
    toast("Orden actualizado.");
    draggedRowId = null;
    draggedCategory = null;
  });

  rows.addEventListener("dragend", (e) => {
    const tr = e.target.closest("tr");
    if (tr) tr.classList.remove("dragging");
    $$("#catalogRows tr").forEach(r => r.style.borderTop = "");
  });
}

function catalogAction(event) {
  const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
  if (isNode) return;
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest("tr[data-id]");
  if (!button || !row) return;
  const id = row.dataset.id;
  if (button.dataset.action === "edit") {
    editingCatalog.add(id);
    renderCatalog();
  }
  if (button.dataset.action === "delete") {
    if (!canWrite()) return;
    const test = catalog.find((item) => item.id === id);
    if (test) test.activo = false;
    editingCatalog.delete(id);
    saveAll();
    renderAll();
    toast("Prueba desactivada.");
  }
}

function updateCatalogCell(event) {
  if (!canWrite()) {
    renderCatalog();
    return;
  }
  const input = event.target.closest("[data-field]");
  const row = event.target.closest("tr[data-id]");
  if (!input || !row) return;
  const isActivoCheckbox = input.dataset.field === "activo" && input.type === "checkbox";
  if (!editingCatalog.has(row.dataset.id) && !isActivoCheckbox) return;
  const test = catalog.find((item) => item.id === row.dataset.id);
  if (!test) return;
  const field = input.dataset.field;
  const value = field === "activo" ? input.checked : input.value;
  if (field === "minimo" || field === "maximo") {
    test[field] = numericLimit(value, field === "maximo" ? "max" : "min");
  } else if (field === "tipo") {
    test.tipo = normalizedCatalogType(value);
    if (test.tipo === "CUALITATIVO") {
      test.minimo = "";
      test.maximo = "";
    }
  } else {
    test[field] = ["area", "determinacion", "clasificacion", "parametro", "muestra"].includes(field) ? catalogUpper(value) : catalogText(value);
  }
  if (field === "clasificacion") test.categoria = test.clasificacion;
  if (field === "parametro") test.nombre = test.parametro;
  if (input.dataset.field === "id") {
    test.id = cleanCatalogCode(value, test.area, Number(test.orden) || 0);
    editingCatalog.delete(row.dataset.id);
    row.dataset.id = test.id;
    editingCatalog.add(test.id);
  }
}

function addCatalogRow() {
  if (!canWrite()) return;
  const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
  if (isNode) return toast("La modificación del catálogo está reservada para la Unidad Principal.");
  const area = $("#catalogArea").value || areas()[0] || "General";
  const guide = catalog.find((test) => test.activo && test.area === area) || catalog.find((test) => test.activo);
  const prefix = area.slice(0, 2).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const next = `${prefix}-${String(catalog.length + 1).padStart(3, "0")}`;
  const maxOrder = catalog.reduce((max, t) => Math.max(max, Number(t.orden) || 0), 0);
  catalog.unshift({
    id: next,
    orden: maxOrder + 1,
    area,
    determinacion: "",
    clasificacion: catalogClassification(guide || {}) || "SIN CLASIFICAR",
    parametro: "",
    tipo: "CUANTITATIVO",
    muestra: "",
    unidad: "",
    minimo: "",
    maximo: "",
    referencia: "",
    nombre: "",
    categoria: catalogClassification(guide || {}) || "SIN CLASIFICAR",
    activo: true,
    seleccionableIndividual: true,
    seleccionableGrupo: true
  });
  editingCatalog.add(next);
  renderAll();
  toast("Prueba agregada. Edite y guarde cambios.");
}

function saveCatalogChanges() {
  if (!canWrite()) return;
  const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
  if (isNode) return toast("La modificación del catálogo está reservada para la Unidad Principal.");
  catalog = normalizeCatalogList(catalog);
  editingCatalog.clear();
  saveAll();
  renderAll();
  toast("Catalogo guardado.");
}



async function importCatalogFromExcel(event) {
  if (!canWrite()) {
    event.target.value = "";
    return;
  }
  const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
  if (isNode) {
    toast("La importación del catálogo está reservada para la Unidad Principal.");
    event.target.value = "";
    return;
  }
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const sheetRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false, blankrows: false });
      
      if (!sheetRows.length) throw new Error("El archivo esta vacio.");
      
      const normalize = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const aliases = {
        area: ["Area", "Seccion", "Departamento"],
        determinacion: ["Determinacion", "Prueba", "Analisis", "Examen"],
        clasificacion: ["Clasificacion", "Perfil", "Subarea", "Categoria"],
        parametro: ["Parametro", "Magnitud", "Componente"],
        tipo: ["Tipo", "Tipo de resultado", "Metodo de resultado"],
        muestra: ["Muestra", "Especimen", "Specimen"],
        unidad: ["Unidad", "Unidades", "Unidad de medida"],
        minimo: ["Minimo", "Min", "Valor minimo", "Limite inferior"],
        maximo: ["Maximo", "Max", "Valor maximo", "Limite superior"],
        referencia: ["Referencia", "Valores de referencia", "Valor de referencia", "Rango", "Valores normales", "Ref", "VR"]
      };
      const aliasSet = new Set(Object.values(aliases).flat().map(normalize));
      const headerIndex = sheetRows.findIndex((row) => row.map(normalize).filter((cell) => aliasSet.has(cell)).length >= 4);
      if (headerIndex < 0) throw new Error("No se encontro una fila de encabezados valida en el Excel.");
      const headers = sheetRows[headerIndex].map(normalize);
      const keyFor = (searchArray) => {
        for (const alias of searchArray) {
          const index = headers.indexOf(normalize(alias));
          if (index >= 0) return index;
        }
        return -1;
      };
      const columns = {
        area: keyFor(aliases.area),
        determinacion: keyFor(aliases.determinacion),
        clasificacion: keyFor(aliases.clasificacion),
        parametro: keyFor(aliases.parametro),
        tipo: keyFor(aliases.tipo),
        muestra: keyFor(aliases.muestra),
        unidad: keyFor(aliases.unidad),
        minimo: keyFor(aliases.minimo),
        maximo: keyFor(aliases.maximo),
        referencia: keyFor(aliases.referencia)
      };
      
      const dataRows = sheetRows.slice(headerIndex + 1);
      const newCatalog = ensureUniqueCatalogCodes(dataRows.map((row, index) => {
        const getVal = (field) => columns[field] >= 0 ? importedText(row[columns[field]]) : "";
        const tipo = normalizedCatalogType(getVal("tipo"));

        return normalizeCatalogItem({
          id: "",
          area: getVal("area"),
          determinacion: getVal("determinacion"),
          clasificacion: getVal("clasificacion"),
          parametro: getVal("parametro"),
          tipo,
          muestra: getVal("muestra"),
          unidad: getVal("unidad"),
          minimo: tipo === "CUALITATIVO" ? "" : numericLimit(getVal("minimo"), "min"),
          maximo: tipo === "CUALITATIVO" ? "" : numericLimit(getVal("maximo"), "max"),
          referencia: getVal("referencia"),
          activo: true,
          orden: index
        }, index);
      }).filter(item => item.nombre && item.area));

      if (!newCatalog.length) {
        throw new Error("No se encontraron datos validos. El sistema busco las columnas: AREA, DETERMINACION, CLASIFICACION, PARAMETRO, TIPO, MUESTRA, UNIDAD, MINIMO, MAXIMO y REFERENCIA. Verifique que los encabezados esten en la primera fila.");
      }

      if (await appConfirm(`Se detectaron ${newCatalog.length} pruebas validas. El catalogo actual sera reemplazado por los datos del Excel.`, "Importar catalogo", "info")) {
        catalog = newCatalog;
        saveAll();
        renderAll();
        ensureCatalogDatalists();
        toast("Catalogo maestro actualizado desde Excel.");
      }
    } catch (err) {
      console.error(err);
      await appAlert(err.message || "No se pudo procesar el Excel.", "Error al procesar el Excel", "danger");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderWorkFilters() {
  const normalAreas = areas().filter(a => !state.settings.outsourceAreas.includes(a));
  fillSelect("#workArea", ["", ...normalAreas], "Todas las areas");
  fillSelect("#workAreaExclude", ["", ...normalAreas], "Ninguna area excluida");
}

function workRows() {
  const dateFrom = $("#workDateFrom").value;
  const dateTo = $("#workDateTo").value;
  const area = $("#workArea").value;
  const excludeArea = $("#workAreaExclude").value;
  const testFilter = $("#workTestFilter").value.trim().toLowerCase();
  const patientFilter = $("#workPatientFilter").value.trim().toLowerCase();
  const rows = [];
  state.requests.forEach((req, reqIndex) => {
    (req.tests || []).forEach((test, testIndex) => {
      if (test.depurado) return;
      const catalogItem = catalog.find(c => c.id === test.id) || {};
      const testArea = catalogItem.area || test.area || "";
      if (state.settings.outsourceAreas.includes(testArea)) return;
      
      const hasData = (test.result && test.result.trim() !== "") || (test.notes && test.notes.trim() !== "");
      let daysOld = 0;
      if (req.date) {
        const [y, m, d] = req.date.split("-").map(Number);
        const reqDate = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        daysOld = (today - reqDate) / (1000 * 60 * 60 * 24);
      }
      if (!hasData && daysOld > 5) return;

      const dateOk = (!dateFrom || req.date >= dateFrom) && (!dateTo || req.date <= dateTo);
      const ok =
        dateOk &&
        (!area || testArea === area) &&
        (!excludeArea || testArea !== excludeArea) &&
        (!testFilter || [test.id, requestDetermination(test), requestClassification(test), requestParameter(test), requestSample(test), requestUnit(test)].join(" ").toLowerCase().includes(testFilter)) &&
        (!patientFilter || [req.name, req.code].join(" ").toLowerCase().includes(patientFilter));
      if (ok) rows.push({ req, reqIndex, test, testIndex });
    });
  });
  return rows.sort((a, b) => {
    const groupSort = String(a.req[$("#workGroup").value] || a.req.date).localeCompare(String(b.req[$("#workGroup").value] || b.req.date));
    if (groupSort !== 0) return groupSort;
    return sortTestsByHierarchy(a.test, b.test);
  });
}



function renderWorklist() {
  const rows = workRows();
  const dateGroups = groupBy(rows, (item) => item.req.date);

  $("#workRows").innerHTML = (dateGroups.size ? renderLabHeader("Lista de Trabajo", true) : "") + Array.from(dateGroups.entries()).map(([date, items]) => {
    const patientGroups = groupBy(items, (item) => `${item.req.name}|${item.req.code}|${item.req.auxCode || ""}`);
    return `
      <div class="workDateGroup">
        <h3>FECHA: ${escapeHtml(date)}</h3>
        ${Array.from(patientGroups.entries()).map(([key, pItems]) => {
          const req = pItems[0].req;
          const reqIndex = pItems[0].reqIndex;
          const [name, code, aux] = key.split("|");
          
          const printItems = pItems.filter(({ test }) => {
            const hasRes = test.result && String(test.result).trim() !== "";
            const hasNotes = test.notes && String(test.notes).trim() !== "";
            return hasRes || hasNotes;
          });
          
          const noPrintClass = printItems.length === 0 ? " noPrint" : "";

          return `
            <div class="workPatientBlock${noPrintClass}">
              <div class="workPatientHeader" style="display:flex; flex-direction:column; gap:4px; padding-bottom:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:4px; border-bottom:1px solid rgba(0,0,0,0.1); padding-bottom:6px;">
                  <div style="font-weight:bold; font-size:0.92rem; color: #0f172a;">
                    ${escapeHtml(name)} - ${escapeHtml(code)} - ${escapeHtml(aux || "Sin código aux.")}
                  </div>
                  <div class="patient-quick-actions noPrint">
                    <button type="button" class="btn-quick-action btn-quick-edit" data-action="edit-patient" data-req="${reqIndex}" title="Editar datos y determinaciones del paciente">
                      ✏️ Editar Paciente
                    </button>
                    <button type="button" class="btn-quick-action btn-quick-print" data-action="print-patient-report" data-req="${reqIndex}" title="Imprimir informe de resultados individual">
                      🖨️ Imprimir Reporte
                    </button>
                  </div>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; font-weight:normal;">
                  <div>
                    <strong style="color:var(--teal)">Datos del paciente</strong><br>
                    Edad: ${escapeHtml(req.age || "---")} | Género: ${escapeHtml(req.gender || "---")} | Seguro: ${escapeHtml(req.insuranceCode || "---")}
                  </div>
                  <div>
                    <strong style="color:var(--teal)">Datos del servicio</strong><br>
                    Servicio: ${escapeHtml(req.service || "---")} | Médico: ${escapeHtml(req.doctor || "---")} | Cama: ${escapeHtml(req.bed || "---")}
                  </div>
                </div>
              </div>
              <div class="workTablesGrid noPrint">
                ${splitTests(pItems, 2).map((tests) => `
                  <table class="workTableCompact">
                    <thead><tr><th>Determinacion</th><th>Parametro</th><th>Unidad</th><th>Resultado</th><th>Observaciones</th></tr></thead>
                    <tbody>${tests.map(({ reqIndex: rIdx, test, testIndex }, index) => `
                      <tr>
                        <td style="font-weight: 600; color: var(--teal);">${index === 0 || requestDetermination(test) !== requestDetermination(tests[index - 1].test) ? escapeHtml(requestDetermination(test)) : ""}</td>
                        <td>${escapeHtml(requestParameter(test))}</td>
                        <td>${escapeHtml(requestUnit(test) || "---")}</td>
                        <td><input data-req="${rIdx}" data-test="${testIndex}" data-field="result" value="${escapeAttr(test.result)}" placeholder="..." /></td>
                        <td><input data-req="${rIdx}" data-test="${testIndex}" data-field="notes" value="${escapeAttr(test.notes)}" placeholder="..." /></td>
                      </tr>
                    `).join("")}</tbody>
                  </table>
                `).join("")}
              </div>
              <div class="workTablesGrid printOnly">
                ${splitTests(printItems, 2).map((tests) => `
                  <table class="workTableCompact">
                    <thead><tr><th>Determinacion</th><th>Parametro</th><th>Unidad</th><th>Resultado</th></tr></thead>
                    <tbody>${tests.map(({ reqIndex: rIdx, test, testIndex }, index) => `
                      <tr>
                        <td style="font-weight: 600; color: var(--teal);">${index === 0 || requestDetermination(test) !== requestDetermination(tests[index - 1].test) ? escapeHtml(requestDetermination(test)) : ""}</td>
                        <td>${escapeHtml(requestParameter(test))}</td>
                        <td>${escapeHtml(requestUnit(test) || "---")}</td>
                        <td>${escapeHtml(test.result || "---")}</td>
                      </tr>
                    `).join("")}</tbody>
                  </table>
                `).join("")}
              </div>
              ${(() => {
                const notesHtml = groupedNotes(printItems.map(p => p.test));
                return notesHtml !== "Sin observaciones." ? `<div class="reportObservations printOnly" style="margin-top: 8px;"><strong>Observaciones:</strong> ${escapeHtml(notesHtml)}</div>` : "";
              })()}
            </div>
          `;
        }).join("")}
      </div>
    `;
  }).sort().reverse().join("") || `<p class="note">No hay datos para la lista seleccionada.</p>`;

  $("#workRows").onclick = (event) => {
    const editBtn = event.target.closest("button[data-action='edit-patient']");
    if (editBtn) {
      event.preventDefault();
      event.stopPropagation();
      editPatientFromAnywhere(editBtn.dataset.req);
      return;
    }
    const printBtn = event.target.closest("button[data-action='print-patient-report']");
    if (printBtn) {
      event.preventDefault();
      event.stopPropagation();
      printSinglePatientReport(printBtn.dataset.req);
      return;
    }
  };

  $("#workRows").onchange = (event) => {
    const input = event.target.closest("[data-field]");
    if (!input) return;
    if (!canWrite()) {
      renderWorklist();
      return;
    }
    const val = input.value.toUpperCase();
    input.value = val;
    $$(`#workRows input[data-req="${input.dataset.req}"][data-test="${input.dataset.test}"][data-field="${input.dataset.field}"]`).forEach(el => {
      if (el !== input) el.value = val;
      el.setAttribute("value", val);
    });
    state.requests[input.dataset.req].tests[input.dataset.test][input.dataset.field] = val;
    state.requests[input.dataset.req].tests[input.dataset.test].updatedAt = new Date().toISOString();
    state.requests[input.dataset.req].reportUpdatedAt = new Date().toISOString();
    saveAll();
    renderDashboard();
    if (STATISTICS_ENABLED) renderStatistics();
  };
}

function reportItems() {
  const query = $("#reportSearch").value.trim().toLowerCase();
  const date = $("#reportDate").value;
  return state.requests.filter((req) => {
    const hasVisibleNormalTests = (req.tests || []).some(t => {
      if (t.depurado) return false;
      const catalogItem = catalog.find(c => c.id === t.id) || {};
      const area = catalogItem.area || t.area || "";
      if (state.settings.outsourceAreas.includes(area)) return false;
      
      const hasData = (t.result && t.result.trim() !== "") || (t.notes && t.notes.trim() !== "");
      let daysOld = 0;
      if (req.date) {
        const [y, m, d] = req.date.split("-").map(Number);
        const reqDate = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        daysOld = (today - reqDate) / (1000 * 60 * 60 * 24);
      }
      if (!hasData && daysOld > 5) return false;
      
      return true;
    });
    if (!hasVisibleNormalTests) return false;

    const matchQuery = !query || [
      req.code,
      req.name,
      req.doctor,
      req.date,
      req.service,
      ...(req.tests || []).filter(t => {
        if (t.depurado) return false;
        const catalogItem = catalog.find(c => c.id === t.id) || {};
        const area = catalogItem.area || t.area || "";
        return !state.settings.outsourceAreas.includes(area);
      }).flatMap((test) => {
        const catalogItem = catalog.find(c => c.id === test.id) || {};
        const area = catalogItem.area || test.area || "";
        return [area, requestDetermination(test), requestClassification(test), requestParameter(test)];
      })
    ].join(" ").toLowerCase().includes(query);
    const matchDate = query ? true : (!date || req.date === date);
    return matchQuery && matchDate;
  });
}

function reportDateTime(req) {
  const latestTestDate = (req.tests || [])
    .map((test) => test.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const value = req.reportUpdatedAt || latestTestDate || new Date().toISOString();
  return new Date(value).toLocaleString("es-BO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function splitTests(tests, cols = 2) {
  const size = Math.ceil(tests.length / cols);
  const result = [];
  for (let i = 0; i < cols; i++) {
    const group = tests.slice(i * size, (i + 1) * size);
    if (group.length) result.push(group);
  }
  return result;
}

function groupedNotes(tests) {
  const notes = tests
    .filter((test) => test.notes && test.notes.trim())
    .map((test) => `${requestParameter(test)}: ${test.notes.trim()}`);
  return notes.length ? notes.join(" | ") : "Sin observaciones.";
}

const CODE128_PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112"
];

function generateBarcode128Svg(text, height = 22) {
  if (!text) return "";
  const cleanText = String(text).trim();
  if (!cleanText) return "";

  const textCodes = [];
  let checksum = 104;
  for (let i = 0; i < cleanText.length; i++) {
    const code = cleanText.charCodeAt(i);
    const val = (code >= 32 && code <= 126) ? code - 32 : 0;
    textCodes.push(val);
    checksum += val * (i + 1);
  }
  checksum = checksum % 103;

  const allCodes = [104, ...textCodes, checksum, 106];
  let patternStr = "";
  for (const c of allCodes) {
    patternStr += (CODE128_PATTERNS[c] || "");
  }

  let totalWidth = 0;
  const rects = [];
  let isBar = true;
  for (let i = 0; i < patternStr.length; i++) {
    const width = parseInt(patternStr[i], 10);
    if (isBar) {
      rects.push(`<rect x="${totalWidth}" y="0" width="${width}" height="${height}" fill="#0f172a" />`);
    }
    totalWidth += width;
    isBar = !isBar;
  }

  const quietZone = 4;
  const viewBoxWidth = totalWidth + (quietZone * 2);
  return `<svg class="barcodeSvg" viewBox="0 0 ${viewBoxWidth} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${quietZone}, 0)">${rects.join("")}</g></svg>`;
}

function renderLabHeader(title = "", printOnly = false, req = null) {
  const logoSrc = state.settings.logo || "assets/icon.svg";
  const inst = (state.settings.institution && state.settings.institution !== "Institucion") ? state.settings.institution : "CAJA NACIONAL DE SALUD";
  const fac = (state.settings.healthFacility && state.settings.healthFacility !== "Establecimiento de Salud") ? state.settings.healthFacility : "HOSPITAL DE ESPECIALIDADES MATERNO INFANTIL";
  const lab = (state.settings.lab && state.settings.lab !== "Laboratorio clinico") ? state.settings.lab : "AREA DE ENDOCRINOLOGIA Y MARCADORES TUMORALES";
  const sub = [state.settings.labAreas, state.settings.address, state.settings.phone].filter(Boolean).join(" - ");
  
  let barcodeHtml = "";
  if (req && req.code) {
    const barcodeSvg = generateBarcode128Svg(req.code, 20);
    barcodeHtml = `
      <div class="reportBarcodeBox">
        <div class="barcodeAuxLabel">AUX: <strong>${escapeHtml(req.auxCode || "---")}</strong></div>
        ${barcodeSvg}
        <div class="barcodeCodeLabel">${escapeHtml(req.code)}</div>
      </div>
    `;
  }

  return `
    <header class="reportHeader${printOnly ? ' printOnly' : ''}">
      <img src="${logoSrc}" alt="Logo Institucional" />
      <div style="flex: 1;">
        <h3>${escapeHtml(inst)}</h3>
        <p>${escapeHtml(fac)}</p>
        <p>${escapeHtml(lab)}</p>
        ${sub ? `<p>${escapeHtml(sub)}</p>` : ""}
      </div>
      ${barcodeHtml}
      ${title ? `<div class="reportTitle">${escapeHtml(title)}</div>` : ""}
    </header>
  `;
}

function sortTestsForReport(a, b) {
  const catalogItemA = catalog.find(c => c.id === a.id);
  const catalogItemB = catalog.find(c => c.id === b.id);
  
  const areaA = catalogItemA?.area || a.area || "GENERAL";
  const areaB = catalogItemB?.area || b.area || "GENERAL";
  
  const areaANorm = areaA.trim().toLowerCase();
  const areaBNorm = areaB.trim().toLowerCase();
  
  if (areaANorm !== areaBNorm) {
    const idxA = AREA_PRIORITY.findIndex(p => p.toLowerCase() === areaANorm);
    const idxB = AREA_PRIORITY.findIndex(p => p.toLowerCase() === areaBNorm);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return areaANorm.localeCompare(areaBNorm);
  }
  
  const order = (Number(catalogItemA?.orden ?? a.orden) || 0) - (Number(catalogItemB?.orden ?? b.orden) || 0);
  if (order !== 0) return order;
  
  return [requestClassification(a), requestParameter(a)].join("|")
    .localeCompare([requestClassification(b), requestParameter(b)].join("|"));
}

function editPatientFromAnywhere(reqIndex) {
  const index = Number(reqIndex);
  if (isNaN(index) || index < 0 || !state.requests[index]) {
    return toast("No se encontró el paciente para editar.");
  }
  loadRequest(index, true);
  showView("dashboard");
  toast("Paciente cargado en el formulario.");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderSingleReportHtml(req) {
  if (!req) return "";
  const visibleTests = (req.tests || []).filter(test => {
    if (test.depurado) return false;
    const catalogItem = catalog.find(c => c.id === test.id) || {};
    const area = catalogItem.area || test.area || "";
    if (state.settings.outsourceAreas.includes(area)) return false;
    return true;
  });

  return `
    <article class="report" style="border:none; box-shadow:none; padding:0; margin:0;">
      ${renderLabHeader("", false, req)}
      <div class="patientHeader compactHeader">
        <div class="formSubtitle">Datos del paciente</div>
        <span><strong>Paciente:</strong> ${escapeHtml(req.name)}</span>
        <span><strong>Edad:</strong> ${escapeHtml(req.age)}</span>
        <span><strong>Género:</strong> ${escapeHtml(req.gender)}</span>
        <span><strong>Seguro:</strong> ${escapeHtml(req.insuranceCode || "---")}</span>
        
        <div class="formSubtitle">Datos del servicio</div>
        <span><strong>Servicio:</strong> ${escapeHtml(req.service || "---")}</span>
        <span><strong>Médico:</strong> ${escapeHtml(req.doctor || "---")}</span>
        <span><strong>Cama:</strong> ${escapeHtml(req.bed || "---")}</span>
        
        <div class="formSubtitle">Identificación</div>
        <span><strong>Auxiliar:</strong> ${escapeHtml(req.auxCode || "---")}</span>
        <span><strong>Fecha:</strong> ${escapeHtml(req.date)}</span>
        <span><strong>Código Registro:</strong> ${escapeHtml(req.code)}</span>
        <span><strong>Reportado:</strong> ${escapeHtml(reportDateTime(req))}</span>
      </div>
      <div class="reportResultsGrid">${splitTests(visibleTests.sort(sortTestsForReport)).map((tests) => {
        let prevArea = null;
        let prevDet = null;
        return `
        <table class="compactReportTable">
          <thead><tr><th>Determinacion</th><th>Parametro</th><th>Resultado</th><th>Unidad</th><th>Referencia</th></tr></thead>
          <tbody>${tests.map((test, index) => {
            const catalogItem = catalog.find(c => c.id === test.id) || {};
            const area = catalogItem.area || test.area || "GENERAL";
            const areaNorm = area.trim().toUpperCase();
            
            const showAreaHeader = (index === 0 || areaNorm !== prevArea);
            if (showAreaHeader) {
              prevDet = null;
            }
            
            const showDet = (index === 0 || showAreaHeader || requestDetermination(test) !== prevDet);
            
            prevArea = areaNorm;
            prevDet = requestDetermination(test);
            
            const testsInArea = tests.filter(t => {
              const cItem = catalog.find(c => c.id === t.id) || {};
              const tArea = cItem.area || t.area || "GENERAL";
              return tArea.trim().toUpperCase() === areaNorm;
            });
            const allEmpty = testsInArea.every(t => !t.result && !t.notes);
            
            let html = "";
            if (showAreaHeader) {
              html += `
                <tr class="area-header-row ${allEmpty ? 'empty-test' : ''}">
                  <td colspan="5" class="report-area-title" style="font-weight: 700; color: var(--teal); background-color: var(--teal-2); padding: 4px 6px !important; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; border-bottom: 1.5px solid var(--teal) !important;">
                    ${escapeHtml(areaNorm)}
                  </td>
                </tr>
              `;
            }
            
            html += `
              <tr class="${!test.result && !test.notes ? 'empty-test' : ''}">
                <td style="font-weight: 600; color: var(--teal);">${showDet ? escapeHtml(requestDetermination(test)) : ""}</td>
                <td>${escapeHtml(requestParameter(test))}</td>
                <td>${escapeHtml(test.result || "---")}</td>
                <td>${escapeHtml(requestUnit(test) || "---")}</td>
                <td>${escapeHtml(requestReference(test) || "---")}</td>
              </tr>
            `;
            return html;
          }).join("")}</tbody>
        </table>
        `;
      }).join("")}</div>
      ${(() => {
        const notesHtml = groupedNotes(visibleTests);
        return notesHtml !== "Sin observaciones." ? `<div class="reportObservations" style="margin-top: 6px;"><strong>Observaciones Clínicas:</strong> ${escapeHtml(notesHtml)}</div>` : "";
      })()}
      <div class="reportSignatures">
        <div>Firma y Sello del Bioquímico</div>
        <div>Firma y Sello del Responsable de Área</div>
      </div>
      <div class="reportPrintFooter">
        <span>Emitido: ${escapeHtml(reportDateTime(req))}</span>
        <span style="font-weight: 700;">Página 1 de 1</span>
      </div>
    </article>
  `;
}

function printSinglePatientReport(reqIndex) {
  const index = Number(reqIndex);
  if (isNaN(index) || index < 0 || !state.requests[index]) {
    return toast("No se encontró el reporte para imprimir.");
  }
  const req = state.requests[index];

  let printContainer = $("#singleReportPrintContainer");
  if (!printContainer) {
    printContainer = document.createElement("div");
    printContainer.id = "singleReportPrintContainer";
    document.body.appendChild(printContainer);
  }

  printContainer.innerHTML = renderSingleReportHtml(req);
  document.body.dataset.printMode = "singleReport";

  setTimeout(() => {
    window.print();
    setTimeout(() => {
      delete document.body.dataset.printMode;
      if (printContainer) printContainer.innerHTML = "";
    }, 500);
  }, 100);
}

function renderReports() {
  const items = reportItems();
  $("#reportList").innerHTML = items.map((req) => {
    const actualIndex = state.requests.findIndex(r => r.code === req.code && r.date === req.date);
    const targetIndex = actualIndex !== -1 ? actualIndex : 0;
    const visibleTests = (req.tests || []).filter(test => {
      if (test.depurado) return false;
      const catalogItem = catalog.find(c => c.id === test.id) || {};
      const area = catalogItem.area || test.area || "";
      if (state.settings.outsourceAreas.includes(area)) return false;
      
      const hasData = (test.result && test.result.trim() !== "") || (test.notes && test.notes.trim() !== "");
      let daysOld = 0;
      if (req.date) {
        const [y, m, d] = req.date.split("-").map(Number);
        const reqDate = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        daysOld = (today - reqDate) / (1000 * 60 * 60 * 24);
      }
      if (!hasData && daysOld > 5) return false;
      
      return true;
    });
    return `
    <article class="report">
      <div class="report-card-actions noPrint">
        <button type="button" class="btn-quick-action btn-quick-edit" data-action="edit-patient" data-req="${targetIndex}" title="Editar paciente y pruebas">
          ✏️ Editar Paciente
        </button>
        <button type="button" class="btn-quick-action btn-quick-print" data-action="print-patient-report" data-req="${targetIndex}" title="Imprimir este reporte individual">
          🖨️ Imprimir Reporte
        </button>
      </div>
      ${renderLabHeader("", false, req)}
      <div class="patientHeader compactHeader">
        <div class="formSubtitle">Datos del paciente</div>
        <span><strong>Paciente:</strong> ${escapeHtml(req.name)}</span>
        <span><strong>Edad:</strong> ${escapeHtml(req.age)}</span>
        <span><strong>Género:</strong> ${escapeHtml(req.gender)}</span>
        <span><strong>Seguro:</strong> ${escapeHtml(req.insuranceCode || "---")}</span>
        
        <div class="formSubtitle">Datos del servicio</div>
        <span><strong>Servicio:</strong> ${escapeHtml(req.service || "---")}</span>
        <span><strong>Médico:</strong> ${escapeHtml(req.doctor || "---")}</span>
        <span><strong>Cama:</strong> ${escapeHtml(req.bed || "---")}</span>
        
        <div class="formSubtitle">Identificación</div>
        <span><strong>Auxiliar:</strong> ${escapeHtml(req.auxCode || "---")}</span>
        <span><strong>Fecha:</strong> ${escapeHtml(req.date)}</span>
        <span><strong>Código Registro:</strong> ${escapeHtml(req.code)}</span>
        <span><strong>Reportado:</strong> ${escapeHtml(reportDateTime(req))}</span>
      </div>
      <div class="reportResultsGrid">${splitTests(visibleTests.sort(sortTestsForReport)).map((tests) => {
        let prevArea = null;
        let prevDet = null;
        return `
        <table class="compactReportTable">
          <thead><tr><th>Determinacion</th><th>Parametro</th><th>Resultado</th><th>Unidad</th><th>Referencia</th></tr></thead>
          <tbody>${tests.map((test, index) => {
            const catalogItem = catalog.find(c => c.id === test.id) || {};
            const area = catalogItem.area || test.area || "GENERAL";
            const areaNorm = area.trim().toUpperCase();
            
            const showAreaHeader = (index === 0 || areaNorm !== prevArea);
            if (showAreaHeader) {
              prevDet = null;
            }
            
            const showDet = (index === 0 || showAreaHeader || requestDetermination(test) !== prevDet);
            
            prevArea = areaNorm;
            prevDet = requestDetermination(test);
            
            const testsInArea = tests.filter(t => {
              const cItem = catalog.find(c => c.id === t.id) || {};
              const tArea = cItem.area || t.area || "GENERAL";
              return tArea.trim().toUpperCase() === areaNorm;
            });
            const allEmpty = testsInArea.every(t => !t.result && !t.notes);
            
            let html = "";
            if (showAreaHeader) {
              html += `
                <tr class="area-header-row ${allEmpty ? 'empty-test' : ''}">
                  <td colspan="5" class="report-area-title" style="font-weight: 700; color: var(--teal); background-color: var(--teal-2); padding: 4px 6px !important; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; border-bottom: 1.5px solid var(--teal) !important;">
                    ${escapeHtml(areaNorm)}
                  </td>
                </tr>
              `;
            }
            
            html += `
              <tr class="${!test.result && !test.notes ? 'empty-test' : ''}">
                <td style="font-weight: 600; color: var(--teal);">${showDet ? escapeHtml(requestDetermination(test)) : ""}</td>
                <td>${escapeHtml(requestParameter(test))}</td>
                <td>${escapeHtml(test.result || "---")}</td>
                <td>${escapeHtml(requestUnit(test) || "---")}</td>
                <td>${escapeHtml(requestReference(test) || "---")}</td>
              </tr>
            `;
            return html;
          }).join("")}</tbody>
        </table>
        `;
      }).join("")}</div>
      ${(() => {
        const notesHtml = groupedNotes(visibleTests);
        return notesHtml !== "Sin observaciones." ? `<div class="reportObservations" style="margin-top: 6px;"><strong>Observaciones Clínicas:</strong> ${escapeHtml(notesHtml)}</div>` : "";
      })()}
      <div class="reportSignatures">
        <div>Firma y Sello del Bioquímico</div>
        <div>Firma y Sello del Responsable de Área</div>
      </div>
      <div class="reportPrintFooter">
        <span>Emitido: ${escapeHtml(reportDateTime(req))}</span>
        <span style="font-weight: 700;">Página 1 de 1</span>
      </div>
    </article>
  `; }).join("") || `<p class="note">No hay reportes para mostrar.</p>`;

  $("#reportList").onclick = (event) => {
    const editBtn = event.target.closest("button[data-action='edit-patient']");
    if (editBtn) {
      event.preventDefault();
      event.stopPropagation();
      editPatientFromAnywhere(editBtn.dataset.req);
      return;
    }
    const printBtn = event.target.closest("button[data-action='print-patient-report']");
    if (printBtn) {
      event.preventDefault();
      event.stopPropagation();
      printSinglePatientReport(printBtn.dataset.req);
      return;
    }
  };
}

function previewLogo(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("#logoPreview").src = reader.result;
    $("#logoPreview").hidden = false;
  };
  reader.readAsDataURL(file);
}

function saveInstitution(event) {
  event.preventDefault();
  if (!canWrite("La licencia esta restringida; solo puede consultar datos.")) return;
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  delete data.logo;
  Object.assign(state.settings, data, { initialized: true });
  if (form.printPaperSize) {
    state.settings.printPaperSize = form.printPaperSize.value || "media_carta";
  }
  applyTheme(state.settings.themeColor || "#1f7a4d");
  applyPaperSize(state.settings.printPaperSize);
  const logo = form.logo ? form.logo.files[0] : null;
  if (!logo) {
    if (!state.settings.logo) state.settings.logo = "assets/icon.svg";
    saveAll();
    renderAll();
    return toast("Identidad institucional guardada.");
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.settings.logo = reader.result;
    saveAll();
    renderAll();
    toast("Identidad y logo institucional guardados.");
  };
  reader.readAsDataURL(logo);
}

function saveStorage(event) {
  if (event) event.preventDefault();
  saveAll();
  renderAll();
  toast("Configuración guardada.");
}

function isValidCloudUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function backupDue() {
  const last = (state.settings.backups || []).at(-1);
  if (!last) return true;
  const elapsed = Date.now() - new Date(last.date).getTime();
  return elapsed >= 60 * 24 * 60 * 60 * 1000;
}

function renderBackupStatus() {
  const backups = state.settings.backups || [];
  const historyEl = $("#backupHistory");
  if (historyEl) {
    historyEl.innerHTML = backups.length
      ? backups.slice().reverse().map((item) => `<div><strong>${escapeHtml(formatDateTime(item.date))}</strong><span>${escapeHtml(item.link || "Respaldo local")}</span></div>`).join("")
      : `<p class="note">Aún no hay respaldos registrados.</p>`;
  }
}

function isAdmin() {
  return true;
}

function refreshSystem() {
  state.settings = store.get("clinlab.settings", state.settings);
  state.requests = store.get("clinlab.requests", state.requests);
  catalog = normalizeCatalogList(store.get("clinlab.catalog", catalog));
  renderAll();
  toast("Sistema actualizado antes de exportar.");
}

function registerOnlineBackup() {
  if (!canWrite()) return;
  if (!isValidCloudUrl(state.settings.cloudUrl)) {
    toast("Configure primero el enlace online obligatorio.");
    return;
  }
  refreshSystem();
  exportExcelWorkbook();
  state.settings.backups ||= [];
  state.settings.backups.push({ date: new Date().toISOString(), link: state.settings.cloudUrl });
  saveAll();
  renderBackupStatus();
  toast("Respaldo registrado. Suba o sincronice el Excel en el enlace online.");
}

function exportExcelWorkbook() {
  refreshSystem();
  
  const dateFrom = $("#exportDateFrom") ? $("#exportDateFrom").value : "";
  const dateTo = $("#exportDateTo") ? $("#exportDateTo").value : "";
  const requests = state.requests.filter((req) => {
    if (dateFrom && req.date < dateFrom) return false;
    if (dateTo && req.date > dateTo) return false;
    return true;
  });

  if (requests.length === 0) {
    appAlert("No hay registros para exportar en el rango de fechas seleccionado.", "Exportar", "warning");
    return;
  }

  const patientHeaders = ["Fecha", "Codigo", "Codigo auxiliar", "Nombres y apellidos", "Edad", "Genero", "Servicio medico", "Medico solicitante", "Cama", "Tipo de atencion"];
  const patientData = requests.map((req) => ({
    Fecha: req.date, Codigo: req.code, "Codigo auxiliar": req.auxCode,
    "Nombres y apellidos": req.name, Edad: req.age, Genero: req.gender,
    "Servicio medico": req.service, "Medico solicitante": req.doctor, Cama: req.bed,
    "Tipo de atencion": req.attentionType || "Rutina"
  }));

  const testHeaders = ["Fecha", "Codigo paciente", "Paciente", "Area", "Determinacion", "Clasificacion", "Parametro", "Tipo", "Muestra", "Unidad", "Minimo", "Maximo", "Referencia", "Resultado", "Observaciones"];
  const testData = requests.flatMap((req) => (req.tests || [])
    .filter((test) => test.result || test.notes)
    .map((test) => ({
      Fecha: req.date, "Codigo paciente": req.code, Paciente: req.name,
      Area: test.area, Determinacion: requestDetermination(test),
      Clasificacion: requestClassification(test), Parametro: requestParameter(test),
      Tipo: test.type || test.tipo || "", Muestra: requestSample(test),
      Unidad: requestUnit(test), Minimo: test.minimum || test.minimo || "",
      Maximo: test.maximum || test.maximo || "", Referencia: requestReference(test),
      Resultado: test.result, Observaciones: test.notes
    })));

  try {
    const wb = XLSX.utils.book_new();
    
    // Chunking function to process arrays into sheet
    const processInChunks = (data, sheetName) => {
      const chunkSize = 500;
      let ws = null;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        if (i === 0) {
          ws = XLSX.utils.json_to_sheet(chunk);
        } else {
          XLSX.utils.sheet_add_json(ws, chunk, { skipHeader: true, origin: -1 });
        }
      }
      if (ws) XLSX.utils.book_append_sheet(wb, ws, sheetName);
    };

    processInChunks(patientData, "Pacientes");
    processInChunks(testData, "Pruebas_Resultados");

    const dateStr = (dateFrom || "todo") + (dateTo ? `-al-${dateTo}` : "");
    XLSX.writeFile(wb, `clinlab-exportacion-${dateStr}.xlsx`);
    console.log(`Exported ${requests.length} requests in batch chunks.`);
  } catch (err) {
    console.error("Error generating Excel:", err);
    appAlert("Ocurrio un error al generar el archivo Excel.", "Error de exportacion", "danger");
  }

  const [anio, mes] = (dateTo || dateFrom || today()).split("-").map(Number);
  if (backendReady) {
    updateSyncIndicator({ estado: "sincronizando", texto: "Sincronizando..." });
    api("/api/export/month", { method: "POST", body: JSON.stringify({ anio, mes }) })
      .then((result) => {
        updateSyncIndicator(result.syncStatus);
        toast(`Exportacion local creada: ${result.fileName}`);
      })
      .catch((error) => {
        updateSyncIndicator({ estado: "pendiente", texto: "Sincronizacion pendiente - Datos locales seguros" });
        toast(error.message || "No se pudo exportar en segundo plano.");
      });
  }
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("es-BO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function excelXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheets.map((sheet) => `<Worksheet ss:Name="${escapeXml(sheet.name)}"><Table>${sheet.rows.map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell ?? "")}</Data></Cell>`).join("")}</Row>`).join("")}</Table></Worksheet>`).join("")}
</Workbook>`;
}

function renderStatsFilters() {
}

function renderBadges(assigned, stored) {
  const badgeAsigStyle = `
    display: inline-flex; 
    align-items: center; 
    justify-content: center; 
    min-width: 18px; 
    height: 18px; 
    border-radius: 50%; 
    background-color: #94a3b8; 
    color: white; 
    font-size: 9px; 
    font-weight: bold; 
    padding: 2px;
    box-sizing: border-box;
  `;
  const badgeAlmacStyle = `
    display: inline-flex; 
    align-items: center; 
    justify-content: center; 
    min-width: 18px; 
    height: 18px; 
    border-radius: 50%; 
    background-color: var(--teal); 
    color: white; 
    font-size: 9px; 
    font-weight: bold; 
    padding: 2px;
    box-sizing: border-box;
  `;
  return `
    <div style="display: flex; gap: 4px; align-items: center;" class="noPrint">
      <span style="${badgeAsigStyle}" title="Asignados">${assigned}</span>
      <span style="${badgeAlmacStyle}" title="Almacenados">${stored}</span>
    </div>
    <span class="print-inline-only" style="font-size: 9px; color: #475569; font-weight: bold;">(${stored}/${assigned})</span>
  `;
}

async function renderStatistics() {
  if (!STATISTICS_ENABLED) return;
  const from = $("#statsFrom").value;
  const to = $("#statsTo").value;
  const areaFilter = "";
  
  if ($("#statsPrintHeader")) {
    const areaName = areaFilter ? ` - ${areaFilter}` : "";
    const dateText = from && to ? ` (Del ${from} al ${to})` : "";
    $("#statsPrintHeader").innerHTML = renderLabHeader(`Reporte Estadístico Institucional${areaName}${dateText}`, true);
  }
  
  const stats = await statsEngine.getStats(from, to, areaFilter);
  const b1 = stats.b1;
window.statsExtElements = stats.ext.elementos || [];
  
  if ($("#kpiPacientes")) $("#kpiPacientes").innerHTML = `${b1.pacientes.size} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Rutina + Emergencias)</small>`;
  
  // Render outsourced element details with area tabs
  const extElems = stats.ext.elementos || [];
  const extContainer = $('#extElementsContainer');
  if (extContainer) {
    if (extElems.length) {
      const areas = [...new Set(extElems.map(e => e.area))];
      const tabsHtml = `
        <div class="tabs noPrint" id="extAreaTabs" style="display: flex; gap: 8px; margin-bottom: 12px; overflow-x: auto; padding-bottom: 4px;">
          ${areas.map((area, idx) => `
            <button type="button" class="${idx === 0 ? 'active' : ''}" data-area="${escapeAttr(area)}" onclick="window.selectExtAreaTab('${escapeAttr(area)}')">
              ${escapeHtml(area)}
            </button>`).join('')}
        </div>
        <div id="extElementsTableContainer"></div>`;
      extContainer.innerHTML = tabsHtml;
      window.selectExtAreaTab(areas[0]);
    } else {
      extContainer.innerHTML = '';
    }
  }

  if ($("#kpiMuestras")) $("#kpiMuestras").innerHTML = `${b1.muestrasRecibidas} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Total ingresadas)</small>`;
  if ($("#kpiPruebas")) $("#kpiPruebas").innerHTML = `${b1.pruebasRealizadas} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Total procesadas)</small>`;
  
  const promMuestra = b1.muestrasRecibidas ? (b1.pruebasRealizadas / b1.muestrasRecibidas).toFixed(2) : "0.0";
  if ($("#kpiPruebasMuestra")) $("#kpiPruebasMuestra").innerHTML = `${promMuestra} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(${b1.pruebasRealizadas} Pruebas &divide; ${b1.muestrasRecibidas} Muestras)</small>`;
  
  const promPaciente = b1.pacientes.size ? (b1.pruebasRealizadas / b1.pacientes.size).toFixed(2) : "0.0";
  if ($("#kpiPruebasPaciente")) $("#kpiPruebasPaciente").innerHTML = `${promPaciente} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(${b1.pruebasRealizadas} Pruebas &divide; ${b1.pacientes.size} Pacientes)</small>`;
  
  const pctEmergencia = b1.pruebasRealizadas ? Math.round((b1.pruebasEmergencia / b1.pruebasRealizadas) * 100) : 0;
  if ($("#kpiEmergencia")) $("#kpiEmergencia").innerHTML = `${pctEmergencia}% <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(${b1.pruebasEmergencia} Emg &divide; ${b1.pruebasRealizadas} Totales)</small>`;
  
  const pctMasc = b1.pruebasRealizadas ? Math.round((b1.pruebasMasculino / b1.pruebasRealizadas) * 100) : 0;
  const pctFem = b1.pruebasRealizadas ? Math.round((b1.pruebasFemenino / b1.pruebasRealizadas) * 100) : 0;
  if ($("#kpiGenero")) $("#kpiGenero").innerHTML = `M: ${pctMasc}% | F: ${pctFem}% <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(M: ${b1.pruebasMasculino} | F: ${b1.pruebasFemenino} de ${b1.pruebasRealizadas})</small>`;

  if ($("#kpiDias")) $("#kpiDias").innerHTML = `${b1.diasTrabajados.size} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Con actividad)</small>`;
  
  const prodDiaria = b1.diasTrabajados.size ? Math.round(b1.pruebasRealizadas / b1.diasTrabajados.size) : 0;
  if ($("#kpiProdDiaria")) $("#kpiProdDiaria").innerHTML = `${prodDiaria} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(${b1.pruebasRealizadas} Pruebas &divide; ${b1.diasTrabajados.size} Días)</small>`;
  
  const varColor = b1.variacionMensual >= 0 ? "var(--teal)" : "var(--danger)";
  if ($("#kpiVariacion")) $("#kpiVariacion").innerHTML = `<span style="color: ${varColor}">${b1.variacionMensual > 0 ? "+" : ""}${b1.variacionMensual.toFixed(1)}%</span> <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(vs. Periodo anterior)</small>`;

  const tasaRechazo = b1.muestrasRecibidas ? (stats.b3.muestrasRechazadas / b1.muestrasRecibidas) * 100 : 0;
  if ($("#kpiRechazos")) $("#kpiRechazos").innerHTML = `${tasaRechazo.toFixed(1)}% <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(${stats.b3.muestrasRechazadas} Rechazos &divide; ${b1.muestrasRecibidas} Muestras)</small>`;
  if ($("#kpiRechazosCard")) {
    $("#kpiRechazosCard").style.background = tasaRechazo > 2 ? "rgba(239, 68, 68, 0.1)" : "transparent";
    $("#kpiRechazosCard").style.borderBottom = tasaRechazo > 2 ? "3px solid var(--danger)" : "none";
  }

  const ext = stats.ext || { pacientes: new Set(), muestras: new Set(), asignaciones: 0, parametros: 0 };
  if ($("#kpiExtPacientes")) $("#kpiExtPacientes").innerHTML = `${ext.pacientes.size} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Pacientes derivados)</small>`;
  if ($("#kpiExtMuestras")) $("#kpiExtMuestras").innerHTML = `${ext.muestras.size} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Muestras enviadas)</small>`;
  if ($("#kpiExtAsignaciones")) $("#kpiExtAsignaciones").innerHTML = `${ext.asignaciones} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Asignaciones orig.)</small>`;
  if ($("#kpiExtParametros")) $("#kpiExtParametros").innerHTML = `${ext.parametros} <br><small style="color:var(--muted);font-size:0.75rem;font-weight:normal;">(Parámetros guardados)</small>`;

  // Generar Tablas Dinamicas Independientes del Catalogo
  let htmlCual = "";
  let htmlCuan = "";

  const ids = Object.keys(stats.pruebas).sort((idA, idB) => {
    const catalogItemA = catalog.find(c => c.id === idA);
    const catalogItemB = catalog.find(c => c.id === idB);
    const ordA = catalogItemA ? catalogItemA.orden : 999999;
    const ordB = catalogItemB ? catalogItemB.orden : 999999;
    if (ordA !== ordB) return ordA - ordB;
    return idA.localeCompare(idB);
  });
  ids.forEach(id => {
    let t = catalog.find(c => c.id === id);
    if (!t) {
      // Recreate test metadata from history if missing in catalog
      const hist = state.requests.flatMap(r => r.tests || []).find(test => test.id === id);
      t = { id, area: hist?.area || "Desconocida", parametro: hist?.parameter || id, tipo: hist?.type || "CUALITATIVO", activo: true };
    }
    
    if (areaFilter && t.area !== areaFilter) return;
    const pStat = stats.pruebas[id];
    if (!pStat || pStat.total === 0) return;

    const area = escapeHtml(t.area || "Sin Área");
    const param = escapeHtml(catalogParameter(t));
    const totalP = pStat.total;
    const pctArea = b1.pruebasRealizadas ? ((totalP / b1.pruebasRealizadas) * 100).toFixed(1) + "%" : "0%";
    const tipoVal = (t.tipo || "").toUpperCase();

    if (tipoVal === "CUALITATIVO") {
      const refVal = String(t ? catalogReference(t) : "").toUpperCase().trim();
      const negativeRefMarkers = ["NEGATIVO", "NEGATIVA", "NO REACTIVO", "NO REACTIVA", "NO DETECTADO", "AUSENCIA", "NO SE OBSERVA", "NORMAL"];
      const isQualEpidemiological = negativeRefMarkers.some(marker => refVal.includes(marker));
      if (!isQualEpidemiological) return;

      const pos = pStat.positivos;
      const tasaPos = pStat.resultados ? ((pos / pStat.resultados) * 100).toFixed(1) + "%" : "0%";
      const pM = pos ? ((pStat.genero.MASCULINO / pos) * 100).toFixed(0) + "%" : "0%";
      const pF = pos ? ((pStat.genero.FEMENINO / pos) * 100).toFixed(0) + "%" : "0%";
      htmlCual += `<tr>
        <td>${area}</td><td>${param}</td><td style="text-align:center">${totalP}</td><td style="text-align:center">${pctArea}</td>
        <td style="text-align:center">${pos}</td><td style="text-align:center;font-weight:bold;color:var(--danger)">${tasaPos}</td>
        <td style="text-align:center">${pM} / ${pF}</td>
        <td style="text-align:center">${pStat.edad["0-4"]}</td><td style="text-align:center">${pStat.edad["5-14"]}</td>
        <td style="text-align:center">${pStat.edad["15-49"]}</td><td style="text-align:center">${pStat.edad["50+"]}</td>
      </tr>`;
    } 
    if (tipoVal === "CUANTITATIVO") {
      const anor = pStat.anormales;
      const tasaAnor = pStat.resultados ? ((anor / pStat.resultados) * 100).toFixed(1) + "%" : "0%";
      htmlCuan += `<tr>
        <td>${area}</td><td>${param}</td><td style="text-align:center">${totalP}</td><td style="text-align:center">${pctArea}</td>
        <td style="text-align:center">${anor}</td><td style="text-align:center;font-weight:bold;color:var(--danger)">${tasaAnor}</td>
        <td style="text-align:center;color:#ca8a04">${pStat.Bajo}</td><td style="text-align:center;color:var(--forest)">${pStat.Normal}</td><td style="text-align:center;color:var(--danger)">${pStat.Alto}</td>
      </tr>`;
    }
  });

  let html = "";
  if (htmlCual) {
    html += `
    <div style="background: white; border: 1px solid var(--line); border-radius: 8px; padding: 15px; overflow-x: auto;">
      <h4 style="margin-bottom:10px;">Epidemiología: Parámetros Cualitativos</h4>
      <table class="data-table" style="width: 100%; min-width: 900px; border-collapse: collapse; font-size: 0.85rem;">
        <thead>
          <tr><th style="text-align:left;background:var(--bg);padding:8px">Área</th><th style="text-align:left;background:var(--bg)">Parámetro</th><th style="text-align:center;background:var(--bg)">Pruebas</th><th style="text-align:center;background:var(--bg)">% del Área</th><th style="text-align:center;background:var(--bg)">Positivos</th><th style="text-align:center;background:var(--bg)">% Positividad</th><th style="text-align:center;background:var(--bg)">Sexo (M/F)</th><th style="text-align:center;background:var(--bg)">0-4a</th><th style="text-align:center;background:var(--bg)">5-14a</th><th style="text-align:center;background:var(--bg)">15-49a</th><th style="text-align:center;background:var(--bg)">>50a</th></tr>
        </thead>
        <tbody>${htmlCual}</tbody>
      </table>
    </div>`;
  }
  
  if (htmlCuan) {
    html += `
    <div style="background: white; border: 1px solid var(--line); border-radius: 8px; padding: 15px; overflow-x: auto;">
      <h4 style="margin-bottom:10px;">Epidemiología: Parámetros Cuantitativos</h4>
      <table class="data-table" style="width: 100%; min-width: 800px; border-collapse: collapse; font-size: 0.85rem;">
        <thead>
          <tr><th style="text-align:left;background:var(--bg);padding:8px">Área</th><th style="text-align:left;background:var(--bg)">Parámetro</th><th style="text-align:center;background:var(--bg)">Pruebas</th><th style="text-align:center;background:var(--bg)">% del Área</th><th style="text-align:center;background:var(--bg)">Anormales</th><th style="text-align:center;background:var(--bg)">% Anormalidad</th><th style="text-align:center;background:var(--bg)">Bajos</th><th style="text-align:center;background:var(--bg)">Normales</th><th style="text-align:center;background:var(--bg)">Altos</th></tr>
        </thead>
        <tbody>${htmlCuan}</tbody>
      </table>
    </div>`;
  }

  // Restore Hierarchical Distribution (Block 7)
  if (Object.keys(stats.b7.jerarquia).length > 0) {
    window.statsJerarquiaData = stats.b7.jerarquia;
    const allAreas = areas();
    const areasList = Object.keys(stats.b7.jerarquia).sort((a, b) => {
      const idxA = allAreas.indexOf(a);
      const idxB = allAreas.indexOf(b);
      if (idxA === -1 && idxB === -1) return a.localeCompare(b);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
    
    // Generate tabs HTML (for screen)
    const tabsHtml = `
      <div class="tabs noPrint" id="statsAreaTabs" style="display: flex; gap: 8px; margin-bottom: 12px; overflow-x: auto; padding-bottom: 4px;">
        ${areasList.map((area, idx) => {
          const isOutsourced = state.settings.outsourceAreas.includes(area);
          const badgeText = isOutsourced ? "Externo" : "Interno";
          const badgeColor = isOutsourced ? "color: #1f4e78; background: #deebf7;" : "color: #385723; background: #e2f0d9;";
          return `
            <button type="button" class="${idx === 0 ? 'active' : ''}" data-area="${escapeAttr(area)}" onclick="window.selectStatsAreaTab('${escapeAttr(area)}')">
              ${escapeHtml(area)} <span style="font-size: 0.7rem; padding: 1px 4px; border-radius: 3px; margin-left: 4px; ${badgeColor}">${badgeText}</span>
            </button>
          `;
        }).join("")}
      </div>
      <div id="statsJerarquiaTableContainer" class="noPrint"></div>
    `;

    // Generate print-only HTML (all tables printed one after another)
    let printHtml = `
      <div class="printOnly" style="display: flex; flex-direction: column; gap: 20px; width: 100%;">
        <h4 style="margin: 0; font-size: 1.2rem; font-weight: bold; border-bottom: 2px solid var(--teal); padding-bottom: 6px;">Distribución Jerárquica por Área</h4>
    `;

    for (const areaName of areasList) {
      const areaData = stats.b7.jerarquia[areaName];
      const rows = [];
      const sortedDets = Object.entries(areaData.dets).sort(([detA], [detB]) => {
        const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detA);
        const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detB);
        const ordA = matchA ? matchA.orden : 999999;
        const ordB = matchB ? matchB.orden : 999999;
        if (ordA !== ordB) return ordA - ordB;
        return detA.localeCompare(detB);
      });

      for (const [detName, detData] of sortedDets) {
        let isNewDet = true;
        const sortedCats = Object.entries(detData.cats).sort(([catA], [catB]) => {
          const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catA);
          const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catB);
          const ordA = matchA ? matchA.orden : 999999;
          const ordB = matchB ? matchB.orden : 999999;
          if (ordA !== ordB) return ordA - ordB;
          return catA.localeCompare(catB);
        });

        for (const [catName, catData] of sortedCats) {
          let isNewCat = true;
          const sortedParams = Object.entries(catData.params).sort(([paramA], [paramB]) => {
            const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catName && catalogParameter(c) === paramA);
            const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catName && catalogParameter(c) === paramB);
            const ordA = matchA ? matchA.orden : 999999;
            const ordB = matchB ? matchB.orden : 999999;
            if (ordA !== ordB) return ordA - ordB;
            return paramA.localeCompare(paramB);
          });

          for (const [paramName, count] of sortedParams) {
            rows.push({
              detName: isNewDet ? detName : "",
              detAssigned: isNewDet ? detData.assigned : null,
              detStored: isNewDet ? detData.stored : null,
              catName: isNewCat ? catName : "",
              catAssigned: isNewCat ? catData.assigned : null,
              catStored: isNewCat ? catData.stored : null,
              paramName: paramName,
              paramAssigned: count.assigned,
              paramStored: count.stored
            });
            isNewDet = false;
            isNewCat = false;
          }
        }
      }

      const cellStyle = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      `;

      const tbodyHtml = rows.map(r => `
        <tr>
          <td style="padding: 6px 8px; border: 1px solid #cbd5e1; vertical-align: middle;">
            ${r.detName ? `
              <div style="${cellStyle}">
                <strong style="color: var(--teal);">${escapeHtml(r.detName)}</strong>
                ${renderBadges(r.detAssigned, r.detStored)}
              </div>
            ` : ""}
          </td>
          <td style="padding: 6px 8px; border: 1px solid #cbd5e1; vertical-align: middle;">
            ${r.catName ? `
              <div style="${cellStyle}">
                <span style="font-weight: 600; color: var(--forest);">${escapeHtml(r.catName)}</span>
                ${renderBadges(r.catAssigned, r.catStored)}
              </div>
            ` : ""}
          </td>
          <td style="padding: 6px 8px; border: 1px solid #cbd5e1; vertical-align: middle;">
            <div style="${cellStyle}">
              <span style="color: var(--ink);">${escapeHtml(r.paramName)}</span>
              ${renderBadges(r.paramAssigned, r.paramStored)}
            </div>
          </td>
        </tr>
      `).join("");

      const isOutsourced = state.settings.outsourceAreas.includes(areaName);
      const badgeText = isOutsourced ? "Envío Externo" : "Procesamiento Interno";
      const badgeColor = isOutsourced ? "color: #1f4e78; background: #deebf7;" : "color: #385723; background: #e2f0d9;";

      printHtml += `
        <div style="page-break-inside: avoid; break-inside: avoid; margin-bottom: 20px;">
          <h5 style="margin: 0 0 8px 0; font-size: 1.05rem; font-weight: bold; color: var(--teal); display: flex; align-items: center; gap: 8px;">
            ${escapeHtml(areaName)} (${areaData.stored} de ${areaData.assigned} almacenadas)
            <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: bold; ${badgeColor}">${badgeText}</span>
          </h5>
          <table class="data-table" style="width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: fixed; border: 1px solid #cbd5e1;">
            <thead>
              <tr style="background: #f8fafc; border-bottom: 2px solid #cbd5e1;">
                <th style="padding: 8px; text-align: left; font-weight: bold; width: 33%; border-right: 1px solid #cbd5e1;">Determinación</th>
                <th style="padding: 8px; text-align: left; font-weight: bold; width: 33%; border-right: 1px solid #cbd5e1;">Categoría</th>
                <th style="padding: 8px; text-align: left; font-weight: bold; width: 34%;">Parámetro</th>
              </tr>
            </thead>
            <tbody>
              ${tbodyHtml}
            </tbody>
          </table>
        </div>
      `;
    }
    printHtml += `</div>`;

    let htmlJer = `
    <style>
      .print-inline-only { display: none !important; }
      @media print {
        .print-inline-only { display: inline !important; }
      }
    </style>
    <div style="background: white; border: 1px solid var(--line); border-radius: 8px; padding: 15px;">
      <h4 style="margin-top:0; display: flex; align-items: center; gap: 10px; justify-content: space-between;">
        <span>Distribución Jerárquica por Área</span>
        <span class="noPrint" style="font-size: 0.8rem; font-weight: normal; color: var(--muted); display: flex; gap: 12px; align-items: center;">
          <span style="display: flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #94a3b8;"></span>Asignados</span>
          <span style="display: flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--teal);"></span>Almacenados</span>
        </span>
      </h4>
      <p style="font-size: 0.9rem; color: var(--muted); margin: 5px 0 15px 0;">(Determinación &gt; Categoría &gt; Parámetro)</p>
      ${tabsHtml}
      ${printHtml}
    </div>`;
    
    html += htmlJer;
  }

  if ($("#statsComplexTables")) {
    $("#statsComplexTables").innerHTML = html || `<p style="padding:20px; text-align:center; color:var(--muted)">No hay suficientes resultados analíticos para este rango de fechas.</p>`;
    if (stats.b7 && Object.keys(stats.b7.jerarquia).length > 0) {
      const firstArea = Object.keys(stats.b7.jerarquia)[0];
      window.selectStatsAreaTab(firstArea);
    }
  }
}

window.selectStatsAreaTab = function(areaName) {
  const buttons = document.querySelectorAll("#statsAreaTabs button");
  buttons.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.area === areaName);
  });
  
  const areaData = window.statsJerarquiaData[areaName];
  if (!areaData) return;
  
  const rows = [];
  const sortedDets = Object.entries(areaData.dets).sort(([detA], [detB]) => {
    const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detA);
    const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detB);
    const ordA = matchA ? matchA.orden : 999999;
    const ordB = matchB ? matchB.orden : 999999;
    if (ordA !== ordB) return ordA - ordB;
    return detA.localeCompare(detB);
  });

  for (const [detName, detData] of sortedDets) {
    let isNewDet = true;
    const sortedCats = Object.entries(detData.cats).sort(([catA], [catB]) => {
      const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catA);
      const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catB);
      const ordA = matchA ? matchA.orden : 999999;
      const ordB = matchB ? matchB.orden : 999999;
      if (ordA !== ordB) return ordA - ordB;
      return catA.localeCompare(catB);
    });

    for (const [catName, catData] of sortedCats) {
      let isNewCat = true;
      const sortedParams = Object.entries(catData.params).sort(([paramA], [paramB]) => {
        const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catName && catalogParameter(c) === paramA);
        const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catName && catalogParameter(c) === paramB);
        const ordA = matchA ? matchA.orden : 999999;
        const ordB = matchB ? matchB.orden : 999999;
        if (ordA !== ordB) return ordA - ordB;
        return paramA.localeCompare(paramB);
      });

      for (const [paramName, count] of sortedParams) {
        rows.push({
          detName: isNewDet ? detName : "",
          detAssigned: isNewDet ? detData.assigned : null,
          detStored: isNewDet ? detData.stored : null,
          catName: isNewCat ? catName : "",
          catAssigned: isNewCat ? catData.assigned : null,
          catStored: isNewCat ? catData.stored : null,
          paramName: paramName,
          paramAssigned: count.assigned,
          paramStored: count.stored
        });
        isNewDet = false;
        isNewCat = false;
      }
    }
  }
  
  const cellStyle = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  `;

  const tbodyHtml = rows.map(r => `
    <tr>
      <td style="padding: 8px; border: 1px solid var(--line); vertical-align: middle;">
        ${r.detName ? `
          <div style="${cellStyle}">
            <strong style="color: var(--teal);">${escapeHtml(r.detName)}</strong>
            ${renderBadges(r.detAssigned, r.detStored)}
          </div>
        ` : ""}
      </td>
      <td style="padding: 8px; border: 1px solid var(--line); vertical-align: middle;">
        ${r.catName ? `
          <div style="${cellStyle}">
            <span style="font-weight: 600; color: var(--forest);">${escapeHtml(r.catName)}</span>
            ${renderBadges(r.catAssigned, r.catStored)}
          </div>
        ` : ""}
      </td>
      <td style="padding: 8px; border: 1px solid var(--line); vertical-align: middle;">
        <div style="${cellStyle}">
          <span style="color: var(--ink);">${escapeHtml(r.paramName)}</span>
          ${renderBadges(r.paramAssigned, r.paramStored)}
        </div>
      </td>
    </tr>
  `).join("");
  
  const isOutsourced = state.settings.outsourceAreas.includes(areaName);
  const areaBadgeText = isOutsourced ? "Envío Externo" : "Procesamiento Interno";
  const areaBadgeColor = isOutsourced ? "color: #1f4e78; background: #deebf7;" : "color: #385723; background: #e2f0d9;";

  const tableHtml = `
    <h4 style="margin: 15px 0 10px 0; font-size: 1.1rem; color: var(--ink); display: flex; align-items: center; gap: 8px;">
      ${escapeHtml(areaName)} 
      <span style="font-weight: normal; font-size: 0.9rem; color: var(--muted);">(${areaData.stored} de ${areaData.assigned} almacenadas)</span>
      <span style="font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; font-weight: bold; ${areaBadgeColor}">${areaBadgeText}</span>
    </h4>
    <div style="overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: white;">
      <table class="data-table" style="width: 100%; border-collapse: collapse; font-size: 0.9rem; table-layout: fixed;">
        <thead>
          <tr style="background: #f8fafc; border-bottom: 2px solid var(--line);">
            <th style="padding: 10px; text-align: left; font-weight: bold; width: 33%; border-right: 1px solid var(--line);">Determinación</th>
            <th style="padding: 10px; text-align: left; font-weight: bold; width: 33%; border-right: 1px solid var(--line);">Categoría</th>
            <th style="padding: 10px; text-align: left; font-weight: bold; width: 34%;">Parámetro</th>
          </tr>
        </thead>
        <tbody>
          ${tbodyHtml}
        </tbody>
      </table>
    </div>
  `;
  
  $("#statsJerarquiaTableContainer").innerHTML = tableHtml;
};

window.setExtElements = function(elements) {
  window.extElements = elements;
};

window.selectExtAreaTab = function(areaName) {
  const buttons = document.querySelectorAll("#extAreaTabs button");
  buttons.forEach(btn => btn.classList.toggle("active", btn.dataset.area === areaName));
  const elements = window.statsExtElements || [];
  const filtered = elements.filter(e => e.area === areaName);
  const rows = filtered.map(e => `
    <tr>
      <td style="padding: 6px; border: 1px solid var(--line);">${escapeHtml(e.det)}</td>
      <td style="padding: 6px; border: 1px solid var(--line);">${escapeHtml(e.cat)}</td>
      <td style="padding: 6px; border: 1px solid var(--line);">${escapeHtml(e.param)}</td>
    </tr>`).join('');
  const html = `
    <table class="data-table" style="width:100%;border-collapse:collapse;font-size:0.85rem;">
      <thead>
        <tr>
          <th style="background:var(--bg);padding:8px">Determinación</th>
          <th style="background:var(--bg);padding:8px">Categoría</th>
          <th style="background:var(--bg);padding:8px">Parámetro</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  const tblContainer = $("#extElementsTableContainer");
  if (tblContainer) tblContainer.innerHTML = html;
};

function fillSelect(selector, values, emptyLabel) {
  const select = $(selector);
  const current = select.value;
  const html = values.map((value, index) => `<option value="${escapeAttr(value)}">${index === 0 && value === "" ? emptyLabel : escapeHtml(value)}</option>`).join("");
  if (select.innerHTML !== html) select.innerHTML = html;
  if (values.includes(current)) select.value = current;
}

function categoryFor(id) {
  const test = catalog.find((item) => item.id === id);
  return test ? catalogClassification(test) : "";
}

function ensureCatalogDatalists() {
  const categories = [...new Set(catalog.filter((test) => test.activo).map((test) => catalogClassification(test)).filter(Boolean))].sort();
  const areaValues = areas().sort();
  upsertDatalist("categorySuggestions", categories);
  upsertDatalist("areaSuggestions", areaValues);
  fillEpidemiologyParameterSelect();
}

function upsertDatalist(id, values) {
  let list = $(`#${id}`);
  if (!list) {
    list = document.createElement("datalist");
    list.id = id;
    document.body.appendChild(list);
  }
  list.innerHTML = values.map((value) => `<option value="${escapeAttr(value)}"></option>`).join("");
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function handleLicenseState(license) {
  if (!license) return;
  licenseState = license;
  license.estado = "activo";
  applyReadOnlyMode(false);
}

function applyReadOnlyMode(enabled) {
  document.body.classList.toggle("readOnlyMode", enabled);
  const writeSelectors = [
    "#patientForm button", "#patientForm input:not([readonly])", "#patientForm select", "#patientForm textarea",
    "#catalog button", "#catalog input", "#catalog select",
    "#workRows input", 
    "#storageForm button:not(#viewSyncLog):not(#restoreWizardBtn)", "#storageForm input", "#storageForm select",
    "#collabForm button", "#collabForm input", "#collabForm select"
  ];
  writeSelectors.forEach((selector) => $$(selector).forEach((el) => {
    if (el.id === "unlockSettings" || el.id === "lockSettings") return;
    el.disabled = enabled;
  }));
}

async function renewLicenseFromPopup() {
  const token = $("#renewTokenInput").value.trim();
  if (!token) return toast("Ingrese el codigo de renovacion.");
  
  if (!backendReady) {
    const expected = state.settings.renewalToken || "";
    if (token === expected && expected !== "") {
      const now = today();
      licenseState = {
        fecha_activacion: now,
        fecha_vencimiento: addDays(now, 60),
        estado: "activo",
        token_actual: token,
        renovaciones: [...(licenseState?.renovaciones || []), { fecha: now, token }]
      };
      store.set("clinlab.license", licenseState);
      state.settings.renewalToken = "";
      saveAll();
      applyReadOnlyMode(false);
      $("#licenseModal").hidden = true;
      toast("Licencia renovada. Acceso completo restaurado.");
    } else {
      toast("Código incorrecto o no generado en la Unidad Principal.");
    }
    return;
  }
  
  try {
    const result = await api("/api/license/renew", { method: "POST", body: JSON.stringify({ token }) });
    if (!result.ok) return toast(result.message || "Codigo incorrecto. Verifique con su tecnico.");
    licenseState = result;
    applyReadOnlyMode(false);
    $("#licenseModal").hidden = true;
    toast("Licencia renovada. Acceso completo restaurado.");
  } catch (error) {
    toast(error.message || "No se pudo validar el codigo.");
  }
}

function updateSyncIndicator(status = syncStatusState) {
  syncStatusState = status || syncStatusState;
  const box = $("#syncIndicator");
  if (box) {
    const estado = syncStatusState.estado || "offline";
    const labels = {
      sincronizado: `Sincronizado - Ultimo respaldo: ${syncStatusState.ultima_sync ? formatDateOnly(syncStatusState.ultima_sync) : "pendiente"}`,
      pendiente: "Sincronizacion pendiente - Datos locales seguros",
      offline: "Sin conexion - Trabajando en modo offline",
      sincronizando: "Sincronizando...",
      restringido: "Solo lectura por mantenimiento"
    };
    box.textContent = syncStatusState.texto || labels[estado] || labels.offline;
    box.className = `syncIndicator ${estado}`;
  }
  const syncState = $("#syncState");
  if (syncState && box) {
    syncState.textContent = box.textContent;
  }
  
  const notify = $("#floatingSyncNotify");
  if (notify) {
    notify.hidden = true;
  }
}

function startScheduler() {
  const runDaily = () => {
    // Política de retención: se ejecuta diariamente para liberar espacio y archivar registros
    enforceRetentionPolicy();

    if (!backendReady) return;
    api("/api/license/verify").then(handleLicenseState).catch(() => updateSyncIndicator({ estado: "offline", texto: "Sin conexion - Trabajando en modo offline" }));
    const now = new Date();
    if (now.getDate() === 1) {
      const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      api("/api/export/month", { method: "POST", body: JSON.stringify({ anio: previous.getFullYear(), mes: previous.getMonth() + 1 }) })
        .then((result) => updateSyncIndicator(result.syncStatus))
        .catch(() => updateSyncIndicator({ estado: "pendiente", texto: "Sincronizacion pendiente - Datos locales seguros" }));
      if (now.getMonth() === 0) {
        api("/api/export/year", { method: "POST", body: JSON.stringify({ anio: now.getFullYear() - 1 }) }).catch(() => {});
      }
    }
  };
  setTimeout(runDaily, 2000);
  setInterval(runDaily, 24 * 60 * 60 * 1000);
}


async function technicalRenewLicense() {
  if (!settingsUnlocked) return toast("Desbloquee configuracion primero.");
  
  if (!backendReady) {
    const token = `CLB-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    state.settings.renewalToken = token;
    saveAll();
    
    if (syncDirHandle) {
      await writeDirFile(syncDirHandle, "licencia.json", JSON.stringify(licenseState, null, 2));
    }
    
    appAlert(`Token de renovación generado: ${token}\n\nCopie este código e ingréselo en el popup de renovación de la licencia.`, "Licencia Renovada");
    return;
  }
  
  try {
    const result = await api("/api/technical", { method: "POST", body: JSON.stringify({ action: "renew" }) });
    toast(`Token generado: ${result.token}`);
  } catch (error) {
    toast(error.message || "No se pudo generar token.");
  }
}

async function forceFullSync() {
  if (!settingsUnlocked) return toast("Desbloquee configuracion primero.");
  updateSyncIndicator({ estado: "sincronizando", texto: "Sincronizando..." });
  try {
    const result = await api("/api/technical", { method: "POST", body: JSON.stringify({ action: "forceSync" }) });
    updateSyncIndicator(result.syncStatus);
    toast(`Sincronizacion completa: ${result.processed} mes(es) procesados.`);
  } catch (error) {
    updateSyncIndicator({ estado: "pendiente", texto: "Sincronizacion pendiente - Datos locales seguros" });
    toast(error.message || "No se pudo sincronizar.");
  }
}

async function autoLoadSyncLog() {
  const viewer = $("#syncLogViewer");
  if (!viewer) return;
  try {
    const result = await api("/api/logs");
    viewer.textContent = result.text || "Sin registros aún.";
  } catch (error) {
    console.error("No se pudo cargar el log de sincronizaciones:", error);
  }
}

function openRestoreWizard() {
  $("#restoreSteps").innerHTML = `
    <p class="note">Ingrese el enlace de la carpeta nube y el token de enlazamiento registrado anteriormente para escanear y restaurar los datos y configuraciones.</p>
    <label>Link de carpeta nube<input id="restoreCloudLink" value="${escapeAttr(state.settings.cloudUrl || "")}" placeholder="https://..." /></label>
    <label style="margin-top: 8px;">Token de enlazamiento anterior<input id="restoreCollabToken" value="${escapeAttr(state.settings.collabToken || "")}" placeholder="Pegue el token de enlazamiento..." /></label>
    <div id="restoreResults" class="restoreResults" style="margin-top: 12px;"></div>
  `;
  $("#restoreModal").hidden = false;
}

async function scanRestoreFiles() {
  const link = $("#restoreCloudLink")?.value || "";
  const token = $("#restoreCollabToken")?.value || "";
  if (!link) {
    toast("Ingrese el enlace de la carpeta en la nube.");
    return;
  }
  if (!token) {
    toast("Ingrese el token de enlazamiento registrado anteriormente.");
    return;
  }
  
  const resultsDiv = $("#restoreResults");
  if (resultsDiv) resultsDiv.innerHTML = "<p>Conectando y validando token...</p>";
  
  try {
    const result = await api("/api/restore/scan", {
      method: "POST",
      body: JSON.stringify({ link_carpeta: link, token: token })
    });
    
    if (!result.ok) {
      if (resultsDiv) resultsDiv.innerHTML = `<p style="color:var(--red); font-weight:bold;">⚠️ Error: ${escapeHtml(result.message)}</p>`;
      return;
    }
    
    const summary = result.summary;
    if (resultsDiv) {
      resultsDiv.innerHTML = `
        <strong>Se encontraron datos de ${summary.count} archivo(s)${summary.from ? ` entre ${summary.from} y ${summary.to}` : ""}.</strong>
        <div class="miniTable" style="margin-bottom: 12px;"><table><thead><tr><th></th><th>Archivo</th><th>Carpeta</th></tr></thead><tbody>
        ${result.files.map((file) => `<tr><td><input type="checkbox" checked /></td><td>${escapeHtml(file.name)}</td><td>${escapeHtml(file.type)}</td></tr>`).join("") || `<tr><td colspan="3">Sin respaldos disponibles en la nube local.</td></tr>`}
        </tbody></table></div>
        <button type="button" id="executeRestoreBtn" style="background: var(--teal); color: white; width: 100%; padding: 10px; font-weight: bold; border-radius: 6px;">Ejecutar Restauración Completa</button>
        <p class="note" style="margin-top: 8px;">La restauración descargará y sincronizará todas las solicitudes de pacientes, catálogo de pruebas y configuraciones de este laboratorio asociadas a este token.</p>
      `;
      
      const execBtn = $("#executeRestoreBtn");
      if (execBtn) {
        execBtn.addEventListener("click", () => executeCloudRestore(link, token));
      }
    }
  } catch (error) {
    if (resultsDiv) resultsDiv.innerHTML = `<p style="color:var(--red); font-weight:bold;">⚠️ Error de conexión: ${escapeHtml(error.message)}</p>`;
  }
}

async function executeCloudRestore(cloudUrl, token) {
  if (!await appConfirm("Esto sobrescribirá por completo los datos y configuraciones actuales de este equipo con la información de la nube. ¿Desea continuar?", "Ejecutar Restauración")) {
    return;
  }
  
  const resultsDiv = $("#restoreResults");
  if (resultsDiv) resultsDiv.innerHTML = "<p>Restaurando y reescribiendo base de datos local...</p>";
  
  try {
    const result = await api("/api/restore/execute", {
      method: "POST",
      body: JSON.stringify({ cloudUrl, token })
    });
    
    if (result.ok) {
      state.settings = result.settings;
      state.requests = result.requests;
      catalog = normalizeCatalogList(result.catalog);
      licenseState = result.license;
      
      // Save to local storage
      store.set("clinlab.settings", state.settings);
      store.set("clinlab.requests", state.requests);
      store.set("clinlab.catalog", catalog);
      
      applyTheme(state.settings.themeColor);
      handleLicenseState(licenseState);
      updateSyncIndicator(result.syncStatus);
      
      $("#restoreModal").hidden = true;
      toast("Datos y configuraciones restaurados con éxito.");
      renderAll();
    } else {
      if (resultsDiv) resultsDiv.innerHTML = `<p style="color:var(--red); font-weight:bold;">⚠️ Error al restaurar: ${escapeHtml(result.message)}</p>`;
    }
  } catch (err) {
    if (resultsDiv) resultsDiv.innerHTML = `<p style="color:var(--red); font-weight:bold;">⚠️ Error de comunicación: ${escapeHtml(err.message)}</p>`;
  }
}

async function sha256Text(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatDateOnly(value) {
  return new Date(value).toLocaleDateString("es-BO", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function escapeAttr(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function escapeHtml(value = "") {
  return escapeAttr(value).replaceAll(">", "&gt;");
}

function escapeXml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function renderOutsourceAreas() {
  const container = $("#outsourceAreasContainer");
  if (!container) return;
  state.settings.outsourceAreas ||= [];
  const allAreas = areas();
  
  const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
  container.innerHTML = allAreas.map(area => {
    const isOutsource = state.settings.outsourceAreas.includes(area);
    return `<button type="button" class="catalog-btn ${isOutsource ? 'active' : ''}" style="margin: 0;" data-area="${escapeAttr(area)}" ${isNode ? 'disabled' : ''}>${escapeHtml(area)}</button>`;
  }).join("") || `<p class="note">No hay áreas definidas en el catálogo.</p>`;
}

function bindOutsourceControls() {
  const container = $("#outsourceAreasContainer");
  if (container) {
    container.onclick = (e) => {
      const btn = e.target.closest("button[data-area]");
      if (!btn) return;
      const isNode = state.settings.collabEnabled && state.settings.collabRole === "node";
      if (isNode) {
        toast("Las áreas tercerizadas se sincronizan desde la Unidad Principal.");
        return;
      }
      if (!isAdmin()) {
        toast("Acceso denegado. Desbloquee la configuración como administrador.");
        return;
      }
      if (!canWrite("La licencia está restringida; no se puede cambiar la configuración.")) return;
      
      const area = btn.dataset.area;
      state.settings.outsourceAreas ||= [];
      const idx = state.settings.outsourceAreas.indexOf(area);
      if (idx > -1) {
        state.settings.outsourceAreas.splice(idx, 1);
        toast(`Área ${area} configurada como Interna.`);
      } else {
        state.settings.outsourceAreas.push(area);
        toast(`Área ${area} configurada para Envío Externo.`);
      }
      syncAllToExternalRegistry();
      saveAll();
      renderAll();
    };
  }
}

function bindWorklistSubmenu() {
  const workBtn = $("#subviewWorklistBtn");
  const epidemiologyBtn = $("#subviewEpidemiologyBtn");
  
  const workPanel = $("#internalWorklistPanel");
  const epidemiologyPanel = $("#epidemiologyWorklistPanel");
  
  if (!workBtn) return;
  
  workBtn.onclick = () => {
    workBtn.classList.add("active");
    if (epidemiologyBtn) epidemiologyBtn.classList.remove("active");
    if (workPanel) workPanel.hidden = false;
    if (epidemiologyPanel) epidemiologyPanel.hidden = true;
    renderWorklist();
  };
  
  if (epidemiologyBtn) {
    epidemiologyBtn.onclick = () => {
      epidemiologyBtn.classList.add("active");
      workBtn.classList.remove("active");
      if (workPanel) workPanel.hidden = true;
      if (epidemiologyPanel) epidemiologyPanel.hidden = false;
      fillEpidemiologyParameterSelect();
      renderEpidemiologyWorklist();
    };
  }
  
  ["epidemiologyDateFrom", "epidemiologyDateTo", "epidemiologyParameterSelect"].forEach(id => {
    const el = $(`#${id}`);
    if (el) {
      el.addEventListener("change", renderEpidemiologyWorklist);
      el.addEventListener("input", renderEpidemiologyWorklist);
    }
  });
}

function outsourceRows() {
  const dateFrom = $("#outsourceDateFrom") ? $("#outsourceDateFrom").value : "";
  const dateTo = $("#outsourceDateTo") ? $("#outsourceDateTo").value : "";
  
  const outsourceAreasSet = new Set(state.settings.outsourceAreas || []);
  const rows = [];
  
  (state.requests || []).forEach(req => {
    const dateOk = (!dateFrom || req.date >= dateFrom) && (!dateTo || req.date <= dateTo);
    if (!dateOk) return;
    
    const outsourcedTests = (req.tests || []).filter(test => {
      if (test.depurado) return false;
      const catalogItem = catalog.find(c => c.id === test.id) || {};
      const area = catalogItem.area || test.area || "";
      return outsourceAreasSet.has(area);
    }).map(test => {
      const catalogItem = catalog.find(c => c.id === test.id) || {};
      return {
        id: test.id,
        area: catalogItem.area || test.area || "Desconocida",
        determination: catalogDetermination(catalogItem) || test.determination || test.determinacion || "Desconocida",
        parameter: catalogName(catalogItem) || test.parameter || test.parametro || test.name || test.id,
        sample: catalogItem.muestra || test.sample || test.muestra || "---",
        notes: test.notes || test.observaciones || ""
      };
    });
    
    if (outsourcedTests.length > 0) {
      rows.push({
        req,
        tests: outsourcedTests
      });
    }
  });
  
  return rows.sort((a, b) => b.req.date.localeCompare(a.req.date));
}

const outsourceTestKey = (test) => {
  const catalogItem = catalog.find(c => c.id === test.id) || {};
  const area = test.area || catalogItem.area || "Desconocida";
  const det = test.determination || test.determinacion || catalogDetermination(catalogItem) || "Desconocida";
  const param = test.parameter || test.parametro || test.name || catalogName(catalogItem) || "Desconocido";
  return `${area} - ${det} - ${param}`;
};

function renderOutsourceWorklist() {
  const container = $("#outsourceRowsContainer");
  if (!container) return;
  
  const dateFrom = $("#outsourceDateFrom") ? $("#outsourceDateFrom").value : "";
  const dateTo = $("#outsourceDateTo") ? $("#outsourceDateTo").value : "";
  
  const formatInputDate = (val) => {
    if (!val) return "";
    const parts = val.split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : val;
  };
  
  let dateText = "";
  if (dateFrom && dateTo) {
    dateText = ` (Del ${formatInputDate(dateFrom)} al ${formatInputDate(dateTo)})`;
  } else if (dateFrom) {
    dateText = ` (Desde ${formatInputDate(dateFrom)})`;
  } else if (dateTo) {
    dateText = ` (Hasta ${formatInputDate(dateTo)})`;
  }
  
  const printDateTime = formatDateTime(new Date());
  
  $("#outsourcePrintHeader").innerHTML = renderLabHeader(`Lista de Envío de Muestras${dateText}`, true) + `
    <div class="printOnly" style="text-align: right; font-size: 0.85rem; color: var(--muted); margin-top: 4px; margin-bottom: 15px; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
      <strong>Fecha de impresión:</strong> ${escapeHtml(printDateTime)}
    </div>
  `;
  
  const rows = outsourceRows();
  if (rows.length === 0) {
    const filterContainer = $("#outsourceFilterContainer");
    if (filterContainer) filterContainer.innerHTML = "";
    container.innerHTML = `<p class="note" style="text-align: center; padding: 20px;">No hay registros de envío de muestras para el rango de fechas seleccionado.</p>`;
    return;
  }
  
  // Calculate unique keys & counts from the rows (before toggle filtering)
  const uniqueElements = new Map();
  rows.forEach(({ tests }) => {
    tests.forEach(test => {
      const key = outsourceTestKey(test);
      uniqueElements.set(key, (uniqueElements.get(key) || 0) + 1);
    });
  });
  
  const sortedKeys = Array.from(uniqueElements.keys()).sort();
  
  // Render filter buttons inside #outsourceFilterContainer
  const filterContainer = $("#outsourceFilterContainer");
  if (filterContainer) {
    filterContainer.innerHTML = `
      <div class="outsourceFilterSection">
        <h3>Filtro de Elementos Asignados (Seleccione para incluir en la vista y PDF)</h3>
        <div class="outsourceFilterGrid">
          ${sortedKeys.map(key => {
            const count = uniqueElements.get(key);
            const isActive = !deselectedOutsourceFilters.has(key);
            const parts = key.split(" - ");
            const area = parts[0] || "Desconocida";
            const det = parts[1] || "Desconocida";
            const param = parts[2] || "Desconocido";
            return `
              <button type="button" class="outsourceFilterBtn ${isActive ? 'active' : ''}" data-key="${escapeAttr(key)}">
                <span><strong>${escapeHtml(param)}</strong> <span style="opacity: 0.85; font-size: 0.85em; font-weight: normal; margin-left: 4px;">(${escapeHtml(area)} - ${escapeHtml(det)})</span></span>
                <span class="badge">${count}</span>
              </button>
            `;
          }).join("")}
        </div>
        <div class="outsourceFilterControls">
          <button type="button" id="outsourceSelectAllBtn">Seleccionar Todos</button>
          <button type="button" id="outsourceSelectNoneBtn">Deseleccionar Todos</button>
        </div>
      </div>
    `;
    
    // Bind button toggle events
    $$("#outsourceFilterContainer .outsourceFilterBtn").forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.key;
        if (deselectedOutsourceFilters.has(key)) {
          deselectedOutsourceFilters.delete(key);
        } else {
          deselectedOutsourceFilters.add(key);
        }
        renderOutsourceWorklist();
      };
    });
    
    const selectAllBtn = $("#outsourceSelectAllBtn");
    if (selectAllBtn) {
      selectAllBtn.onclick = () => {
        deselectedOutsourceFilters.clear();
        renderOutsourceWorklist();
      };
    }
    
    const selectNoneBtn = $("#outsourceSelectNoneBtn");
    if (selectNoneBtn) {
      selectNoneBtn.onclick = () => {
        sortedKeys.forEach(k => deselectedOutsourceFilters.add(k));
        renderOutsourceWorklist();
      };
    }
  }
  
  // Filter request tests according to selection
  const filteredRows = rows.map(({ req, tests }) => {
    const activeTests = tests.filter(test => {
      const key = outsourceTestKey(test);
      return !deselectedOutsourceFilters.has(key);
    });
    return { req, tests: activeTests };
  }).filter(item => item.tests.length > 0);
  
  if (filteredRows.length === 0) {
    container.innerHTML = `<p class="note" style="text-align: center; padding: 20px;">No hay registros de envío de muestras que coincidan con los filtros seleccionados.</p>`;
    return;
  }
  
  const dateGroups = groupBy(filteredRows, (item) => item.req.date);
  const sortedDates = Array.from(dateGroups.keys()).sort().reverse();
  
  const html = sortedDates.map(date => {
    const items = dateGroups.get(date);
    return `
      <div class="workDateGroup">
        <h3>FECHA: ${escapeHtml(date)}</h3>
        ${items.map(({ req, tests }) => {
          const name = req.name;
          const code = req.code;
          const aux = req.auxCode;
          const sortedTests = [...tests].sort((a, b) => {
            const areaComp = (a.area || "").localeCompare(b.area || "");
            if (areaComp !== 0) return areaComp;
            const detComp = (a.determination || "").localeCompare(b.determination || "");
            if (detComp !== 0) return detComp;
            return (a.parameter || "").localeCompare(b.parameter || "");
          });
          
          return `
            <div class="workPatientBlock">
              <div class="outsourcePatientBlock">
                <div class="outsourceInfoGrid">
                  <div class="outsourceInfoCol">
                    <div class="outsourceColHeader">Datos del Paciente</div>
                    <div class="outsourceColContent">
                      <div><strong>Paciente:</strong> ${escapeHtml(name)}</div>
                      <div><strong>Código:</strong> ${escapeHtml(code)}</div>
                      <div><strong>Edad:</strong> ${escapeHtml(req.age || "---")} | <strong>Género:</strong> ${escapeHtml(req.gender || "---")}</div>
                      <div><strong>Seguro:</strong> ${escapeHtml(req.insuranceCode || "---")}</div>
                    </div>
                  </div>
                  <div class="outsourceInfoCol">
                    <div class="outsourceColHeader">Datos del Servicio</div>
                    <div class="outsourceColContent">
                      <div><strong>Servicio:</strong> ${escapeHtml(req.service || "---")}</div>
                      <div><strong>Médico:</strong> ${escapeHtml(req.doctor || "---")}</div>
                      <div><strong>Cama:</strong> ${escapeHtml(req.bed || "---")}</div>
                      <div><strong>Tipo Atención:</strong> ${escapeHtml(req.attentionType || "---")}</div>
                    </div>
                  </div>
                  <div class="outsourceInfoCol">
                    <div class="outsourceColHeader">Datos de la Muestra</div>
                    <div class="outsourceColContent">
                      <div><strong>Código Auxiliar:</strong> ${escapeHtml(aux || "Sin código aux.")}</div>
                      <div><strong>Estado Muestra:</strong> ${escapeHtml(req.sampleStatus || "---")}</div>
                      <div><strong>Diagnóstico:</strong> ${escapeHtml(req.diagnosis || "---")}</div>
                      <div><strong>Fecha Toma:</strong> ${escapeHtml(formatInputDate(req.date))}</div>
                    </div>
                  </div>
                </div>
                
                <div class="outsourceTestsContainer">
                  <table class="workTableCompact">
                    <thead>
                      <tr>
                        <th>Área</th>
                        <th>Determinación</th>
                        <th>Parámetro</th>
                        <th>Muestra</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${sortedTests.map((test, index) => `
                        <tr>
                          <td style="font-weight: bold; color: var(--teal); text-align: left;">${index === 0 || test.area !== sortedTests[index - 1].area ? escapeHtml(test.area) : ""}</td>
                          <td style="font-weight: 600; text-align: left;">${index === 0 || test.determination !== sortedTests[index - 1].determination || test.area !== sortedTests[index - 1].area ? escapeHtml(test.determination) : ""}</td>
                          <td style="text-align: left;">${escapeHtml(test.parameter || test.parametro || test.name || "---")}</td>
                          <td style="text-align: center;">${escapeHtml(test.sample || test.muestra || "---")}</td>
                        </tr>
                      `).join("")}
                    </tbody>
                  </table>
                </div>
              </div>
              ${(() => {
                const notesHtml = groupedNotes(sortedTests.map(t => ({
                  parameter: t.parameter,
                  parametro: t.parametro,
                  name: t.name,
                  notes: t.notes || t.observaciones || ""
                })));
                return notesHtml !== "Sin observaciones." ? `<div class="reportObservations printOnly" style="margin-top: 4px; margin-bottom: 12px;"><strong>Observaciones:</strong> ${escapeHtml(notesHtml)}</div>` : "";
              })()}
            </div>
          `;
        }).join("")}
      </div>
    `;
  }).join("");
  
  container.innerHTML = html;
}

function fillEpidemiologyParameterSelect() {
  const select = $("#epidemiologyParameterSelect");
  if (!select) return;
  const current = select.value;
  
  const uniqueParamsMap = new Map();
  state.requests.forEach(req => {
    (req.tests || []).forEach(test => {
      if (test.depurado) return;
      const hasResult = test.result && test.result.trim();
      const hasNotes = test.notes && test.notes.trim();
      if (hasResult || hasNotes) {
        const paramName = requestParameter(test);
        if (paramName && !uniqueParamsMap.has(paramName)) {
          const catItem = catalog.find(c => c.id === test.id);
          const area = test.area || catItem?.area || "Desconocida";
          const det = requestDetermination(test) || catItem?.determinacion || "Desconocida";
          const cat = requestClassification(test) || catItem?.clasificacion || "General";
          
          uniqueParamsMap.set(paramName, {
            param: paramName,
            area: area,
            det: det,
            cat: cat
          });
        }
      }
    });
  });
  
  const sortedParams = Array.from(uniqueParamsMap.values()).sort((a, b) => {
    const areaComp = a.area.localeCompare(b.area);
    if (areaComp !== 0) return areaComp;
    const detComp = a.det.localeCompare(b.det);
    if (detComp !== 0) return detComp;
    const catComp = a.cat.localeCompare(b.cat);
    if (catComp !== 0) return catComp;
    return a.param.localeCompare(b.param);
  });
  
  select.innerHTML = `<option value="">Seleccione un parámetro...</option>` +
    sortedParams.map(a => {
      const label = `[${a.area}] ${a.det} → ${a.cat} → ${a.param}`;
      return `<option value="${escapeAttr(a.param)}">${escapeHtml(label)}</option>`;
    }).join("");
    
  if (uniqueParamsMap.has(current)) {
    select.value = current;
  } else {
    select.value = "";
  }
}

function renderEpidemiologyWorklist() {
  const container = $("#epidemiologyRowsContainer");
  if (!container) return;
  
  const dateFrom = $("#epidemiologyDateFrom") ? $("#epidemiologyDateFrom").value : "";
  const dateTo = $("#epidemiologyDateTo") ? $("#epidemiologyDateTo").value : "";
  const selectedParameter = $("#epidemiologyParameterSelect") ? $("#epidemiologyParameterSelect").value : "";
  
  const formatInputDate = (val) => {
    if (!val) return "";
    const parts = val.split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : val;
  };
  
  let dateText = "";
  if (dateFrom && dateTo) {
    dateText = ` (Del ${formatInputDate(dateFrom)} al ${formatInputDate(dateTo)})`;
  } else if (dateFrom) {
    dateText = ` (Desde ${formatInputDate(dateFrom)})`;
  } else if (dateTo) {
    dateText = ` (Hasta ${formatInputDate(dateTo)})`;
  }
  
  const printDateTime = formatDateTime(new Date());
  
  const titleText = selectedParameter 
    ? `Lista Epidemiológica - ${selectedParameter}${dateText}` 
    : `Lista Epidemiológica por Prueba${dateText}`;
    
  $("#epidemiologyPrintHeader").innerHTML = renderLabHeader(titleText, true) + `
    <div class="printOnly" style="text-align: right; font-size: 0.85rem; color: var(--muted); margin-top: 4px; margin-bottom: 15px; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
      <strong>Fecha de impresión:</strong> ${escapeHtml(printDateTime)}
    </div>
  `;
  
  if (!selectedParameter) {
    container.innerHTML = `<p class="note" style="text-align: center; padding: 20px;">Por favor, seleccione un parámetro del catálogo para generar la lista.</p>`;
    return;
  }
  
  const rows = [];
  state.requests.forEach(req => {
    const dateOk = (!dateFrom || req.date >= dateFrom) && (!dateTo || req.date <= dateTo);
    if (!dateOk) return;
    
    (req.tests || []).forEach(test => {
      if (test.depurado) return;
      if (requestParameter(test) === selectedParameter) {
        const hasResult = test.result && test.result.trim();
        const hasNotes = test.notes && test.notes.trim();
        if (hasResult || hasNotes) {
          rows.push({ req, test });
        }
      }
    });
  });
  
  rows.sort((a, b) => {
    const dateCompare = b.req.date.localeCompare(a.req.date);
    if (dateCompare !== 0) return dateCompare;
    return a.req.name.localeCompare(b.req.name);
  });
  
  if (rows.length === 0) {
    container.innerHTML = `<p class="note" style="text-align: center; padding: 20px;">No hay registros con resultados u observaciones para el parámetro seleccionado en el rango de fechas.</p>`;
    return;
  }
  
  const tableHtml = `
    <table class="data-table" style="width: 100%; border-collapse: collapse; margin-top: 10px; table-layout: fixed;">
      <thead>
        <tr style="background: #f8fafc; border-bottom: 2px solid var(--line);">
          <th style="padding: 10px; text-align: center; font-weight: bold; width: 6%; border-right: 1px solid var(--line);">N°</th>
          <th style="padding: 10px; text-align: left; font-weight: bold; width: 12%; border-right: 1px solid var(--line);">Fecha</th>
          <th style="padding: 10px; text-align: left; font-weight: bold; width: 22%; border-right: 1px solid var(--line);">Nombres y apellidos</th>
          <th style="padding: 10px; text-align: left; font-weight: bold; width: 15%; border-right: 1px solid var(--line);">Código de asegurado</th>
          <th style="padding: 10px; text-align: center; font-weight: bold; width: 8%; border-right: 1px solid var(--line);">Edad</th>
          <th style="padding: 10px; text-align: center; font-weight: bold; width: 10%; border-right: 1px solid var(--line);">Género</th>
          <th style="padding: 10px; text-align: left; font-weight: bold; width: 15%; border-right: 1px solid var(--line);">Diagnóstico</th>
          <th style="padding: 10px; color: var(--teal); font-weight: bold; overflow-wrap: break-word; white-space: normal;">Resultado</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ req, test }, index) => {
          const resultStr = `${test.result || ""}${test.notes && test.notes.trim() ? ` [Obs: ${test.notes.trim()}]` : ""}` || "---";
          return `
            <tr style="border-bottom: 1px solid var(--line);">
              <td style="padding: 10px; text-align: center; border-right: 1px solid var(--line);">${index + 1}</td>
              <td style="padding: 10px; border-right: 1px solid var(--line);">${escapeHtml(formatInputDate(req.date))}</td>
              <td style="padding: 10px; border-right: 1px solid var(--line); font-weight: 600; overflow-wrap: break-word; white-space: normal;">${escapeHtml(req.name)}</td>
              <td style="padding: 10px; border-right: 1px solid var(--line); overflow-wrap: break-word; white-space: normal;">${escapeHtml(req.insuranceCode || "---")}</td>
              <td style="padding: 10px; text-align: center; border-right: 1px solid var(--line);">${escapeHtml(req.age || "---")}</td>
              <td style="padding: 10px; text-align: center; border-right: 1px solid var(--line); text-transform: capitalize;">${escapeHtml((req.gender || "---").toLowerCase())}</td>
              <td style="padding: 10px; border-right: 1px solid var(--line); overflow-wrap: break-word; white-space: normal;">${escapeHtml(req.diagnosis || "---")}</td>
              <td style="padding: 10px; color: var(--teal); font-weight: bold; overflow-wrap: break-word; white-space: normal;">
                ${escapeHtml(resultStr)}
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
  
  container.innerHTML = tableHtml;
}

async function exportStatsToExcel() {
  const from = $("#statsFrom").value;
  const to = $("#statsTo").value;
  const stats = await statsEngine.getStats(from, to, "");
  const b1 = stats.b1;
  const b3 = stats.b3;
  const ext = stats.ext;
  
  const wb = XLSX.utils.book_new();

  // 1. Resumen KPIs
  const promMuestra = b1.muestrasRecibidas ? (b1.pruebasRealizadas / b1.muestrasRecibidas).toFixed(2) : "0.0";
  const promPaciente = b1.pacientes.size ? (b1.pruebasRealizadas / b1.pacientes.size).toFixed(2) : "0.0";
  const pctEmergencia = b1.pruebasRealizadas ? Math.round((b1.pruebasEmergencia / b1.pruebasRealizadas) * 100) : 0;
  const pctMasc = b1.pruebasRealizadas ? Math.round((b1.pruebasMasculino / b1.pruebasRealizadas) * 100) : 0;
  const pctFem = b1.pruebasRealizadas ? Math.round((b1.pruebasFemenino / b1.pruebasRealizadas) * 100) : 0;
  const prodDiaria = b1.diasTrabajados.size ? Math.round(b1.pruebasRealizadas / b1.diasTrabajados.size) : 0;
  const tasaRechazo = b1.muestrasRecibidas ? (b3.muestrasRechazadas / b1.muestrasRecibidas) * 100 : 0;

  const kpisData = [
    { Indicador: "Pacientes Atendidos", Valor: b1.pacientes.size, Descripcion: "Rutina + Emergencias" },
    { Indicador: "Muestras Recibidas", Valor: b1.muestrasRecibidas, Descripcion: "Total ingresadas" },
    { Indicador: "Pruebas Realizadas", Valor: b1.pruebasRealizadas, Descripcion: "Total procesadas" },
    { Indicador: "Promedio Pruebas por Muestra", Valor: parseFloat(promMuestra), Descripcion: "" },
    { Indicador: "Promedio Pruebas por Paciente", Valor: parseFloat(promPaciente), Descripcion: "" },
    { Indicador: "Porcentaje Emergencias", Valor: `${pctEmergencia}%`, Descripcion: `${b1.pruebasEmergencia} emergencias` },
    { Indicador: "Género Masculino", Valor: `${pctMasc}%`, Descripcion: `${b1.pruebasMasculino} pruebas` },
    { Indicador: "Género Femenino", Valor: `${pctFem}%`, Descripcion: `${b1.pruebasFemenino} pruebas` },
    { Indicador: "Días con Actividad", Valor: b1.diasTrabajados.size, Descripcion: "" },
    { Indicador: "Producción Diaria Promedio", Valor: prodDiaria, Descripcion: "" },
    { Indicador: "Variación vs Periodo Anterior", Valor: `${b1.variacionMensual.toFixed(1)}%`, Descripcion: "" },
    { Indicador: "Tasa de Rechazo de Muestras", Valor: `${tasaRechazo.toFixed(1)}%`, Descripcion: `${b3.muestrasRechazadas} rechazos` },
    { Indicador: "Pacientes Derivados (Externo)", Valor: ext.pacientes.size, Descripcion: "" },
    { Indicador: "Muestras Enviadas (Externo)", Valor: ext.muestras.size, Descripcion: "" },
    { Indicador: "Asignaciones Orig. (Externo)", Valor: ext.asignaciones, Descripcion: "" },
    { Indicador: "Parámetros Guardados (Externo)", Valor: ext.parametros, Descripcion: "" }
  ];
  const wsKpis = XLSX.utils.json_to_sheet(kpisData);
  XLSX.utils.book_append_sheet(wb, wsKpis, "Resumen_KPIs");

  // 2. Epidemiologia Cualitativa
  const cualData = [];
  // 3. Epidemiologia Cuantitativa
  const cuanData = [];

  const ids = Object.keys(stats.pruebas).sort((idA, idB) => {
    const catalogItemA = catalog.find(c => c.id === idA);
    const catalogItemB = catalog.find(c => c.id === idB);
    const ordA = catalogItemA ? catalogItemA.orden : 999999;
    const ordB = catalogItemB ? catalogItemB.orden : 999999;
    if (ordA !== ordB) return ordA - ordB;
    return idA.localeCompare(idB);
  });

  ids.forEach(id => {
    let t = catalog.find(c => c.id === id);
    if (!t) {
      const hist = state.requests.flatMap(r => r.tests || []).find(test => test.id === id);
      t = { id, area: hist?.area || "Desconocida", parametro: hist?.parameter || id, tipo: hist?.type || "CUALITATIVO", activo: true };
    }
    const pStat = stats.pruebas[id];
    if (!pStat || pStat.total === 0) return;

    const area = t.area || "Sin Área";
    const param = catalogParameter(t);
    const totalP = pStat.total;
    const pctArea = b1.pruebasRealizadas ? ((totalP / b1.pruebasRealizadas) * 100).toFixed(1) + "%" : "0%";
    const tipoVal = (t.tipo || "").toUpperCase();

    if (tipoVal === "CUALITATIVO") {
      const refVal = String(t ? catalogReference(t) : "").toUpperCase().trim();
      const negativeRefMarkers = ["NEGATIVO", "NEGATIVA", "NO REACTIVO", "NO REACTIVA", "NO DETECTADO", "AUSENCIA", "NO SE OBSERVA", "NORMAL"];
      const isQualEpidemiological = negativeRefMarkers.some(marker => refVal.includes(marker));
      if (!isQualEpidemiological) return;

      const pos = pStat.positivos;
      const tasaPos = pStat.resultados ? ((pos / pStat.resultados) * 100).toFixed(1) + "%" : "0%";
      const pM = pos ? ((pStat.genero.MASCULINO / pos) * 100).toFixed(0) + "%" : "0%";
      const pF = pos ? ((pStat.genero.FEMENINO / pos) * 100).toFixed(0) + "%" : "0%";

      cualData.push({
        "Área": area,
        "Parámetro": param,
        "Total Pruebas": totalP,
        "% del Área": pctArea,
        "Positivos": pos,
        "% Positividad": tasaPos,
        "Sexo (M/F)": `${pM} / ${pF}`,
        "Edad 0-4a": pStat.edad["0-4"],
        "Edad 5-14a": pStat.edad["5-14"],
        "Edad 15-49a": pStat.edad["15-49"],
        "Edad >50a": pStat.edad["50+"]
      });
    }
    if (tipoVal === "CUANTITATIVO") {
      const anor = pStat.anormales;
      const tasaAnor = pStat.resultados ? ((anor / pStat.resultados) * 100).toFixed(1) + "%" : "0%";

      cuanData.push({
        "Área": area,
        "Parámetro": param,
        "Total Pruebas": totalP,
        "% del Área": pctArea,
        "Anormales": anor,
        "% Anormalidad": tasaAnor,
        "Bajos": pStat.Bajo,
        "Normales": pStat.Normal,
        "Altos": pStat.Alto
      });
    }
  });

  if (cualData.length > 0) {
    const wsCual = XLSX.utils.json_to_sheet(cualData);
    XLSX.utils.book_append_sheet(wb, wsCual, "Epidemiologia_Cualitativa");
  }
  if (cuanData.length > 0) {
    const wsCuan = XLSX.utils.json_to_sheet(cuanData);
    XLSX.utils.book_append_sheet(wb, wsCuan, "Epidemiologia_Cuantitativa");
  }

  // 4. Distribucion Jerarquica
  const jerData = [];
  const allAreas = areas();
  const sortedAreasList = Object.keys(stats.b7.jerarquia).sort((a, b) => {
    const idxA = allAreas.indexOf(a);
    const idxB = allAreas.indexOf(b);
    if (idxA === -1 && idxB === -1) return a.localeCompare(b);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });

  for (const areaName of sortedAreasList) {
    const areaData = stats.b7.jerarquia[areaName];
    const sortedDets = Object.entries(areaData.dets).sort(([detA], [detB]) => {
      const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detA);
      const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detB);
      const ordA = matchA ? matchA.orden : 999999;
      const ordB = matchB ? matchB.orden : 999999;
      if (ordA !== ordB) return ordA - ordB;
      return detA.localeCompare(detB);
    });

    for (const [detName, detData] of sortedDets) {
      const sortedCats = Object.entries(detData.cats).sort(([catA], [catB]) => {
        const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catA);
        const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catB);
        const ordA = matchA ? matchA.orden : 999999;
        const ordB = matchB ? matchB.orden : 999999;
        if (ordA !== ordB) return ordA - ordB;
        return catA.localeCompare(catB);
      });

      for (const [catName, catData] of sortedCats) {
        const sortedParams = Object.entries(catData.params).sort(([paramA], [paramB]) => {
          const matchA = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catName && catalogParameter(c) === paramA);
          const matchB = catalog.find(c => c.area === areaName && catalogDetermination(c) === detName && catalogClassification(c) === catName && catalogParameter(c) === paramB);
          const ordA = matchA ? matchA.orden : 999999;
          const ordB = matchB ? matchB.orden : 999999;
          if (ordA !== ordB) return ordA - ordB;
          return paramA.localeCompare(paramB);
        });

        for (const [paramName, count] of sortedParams) {
          jerData.push({
            "Área": areaName,
            "Determinación": detName,
            "Asignados (Det)": detData.assigned,
            "Almacenados (Det)": detData.stored,
            "Categoría": catName,
            "Asignados (Cat)": catData.assigned,
            "Almacenados (Cat)": catData.stored,
            "Parámetro": paramName,
            "Asignados (Param)": count.assigned,
            "Almacenados (Param)": count.stored
          });
        }
      }
    }
  }

  if (jerData.length > 0) {
    const wsJer = XLSX.utils.json_to_sheet(jerData);
    XLSX.utils.book_append_sheet(wb, wsJer, "Distribucion_Jerarquica");
  }

  const dateStr = (from || "todo") + (to ? `-al-${to}` : "");
  XLSX.writeFile(wb, `clinlab-reporte-estadistico-${dateStr}.xlsx`);
  toast("Reporte estadístico Excel descargado.");
}

init().catch((error) => {
  console.error(error);
  toast("No se pudo iniciar la aplicacion.");
});
