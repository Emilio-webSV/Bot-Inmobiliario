// lib/store.js
// ---------------------------------------------------------------------------
// Almacenamiento simple basado en archivo JSON.
// Para el DEMO esto es perfecto: cero dependencias, cero costo, corre solo.
// Para PRODUCCIÓN con cliente real -> migrar a PostgreSQL (te ayudo cuando llegue).
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// La carpeta de datos es configurable. En Railway apuntará a un "Volume"
// (disco persistente) vía la variable DATA_DIR, para que NADA se borre al
// redesplegar. En local, si no defines DATA_DIR, usa la carpeta ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

// Estructura inicial de la base de datos
const DEFAULT_DB = {
  leads: {},        // { telefono: { ...datosDelLead } }
  agents: [],       // [ { id, nombre, telefono, zonas: [], activo } ]
  properties: [],   // [ { id, titulo, zona, tipo, operacion, precio, ... } ]
  zones: [],        // [ { id, nombre, aliases: [], precioM2, nota, activa } ]
  blocks: [],       // [ { id, agenteId, fecha, horaInicio, horaFin, motivo } ] horarios NO disponibles
  config: {
    nombreAgencia: "Inmobiliaria Demo",
    tono: "profesional y cálido", // formal | relajado | lujoso
    idiomaDefault: "es",
    brandColor: "#d9a526", // color de acento del CRM (personalizable)
  },
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

export function loadDB() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const db = JSON.parse(raw);
    // Rellenar llaves faltantes por si el archivo es viejo
    return { ...DEFAULT_DB, ...db, config: { ...DEFAULT_DB.config, ...db.config } };
  } catch (err) {
    console.error("[store] Error leyendo DB, regenerando:", err.message);
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    return structuredClone(DEFAULT_DB);
  }
}

export function saveDB(db) {
  ensureFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---- Helpers de leads -----------------------------------------------------

export function getLead(telefono) {
  const db = loadDB();
  return db.leads[telefono] || null;
}

export function getAllLeads() {
  const db = loadDB();
  return Object.values(db.leads);
}

export function upsertLead(telefono, patch) {
  const db = loadDB();
  const ahora = new Date().toISOString();
  const existente = db.leads[telefono];

  if (!existente) {
    db.leads[telefono] = {
      telefono,
      nombre: null,
      creado: ahora,
      ultimoMensaje: ahora,
      ultimaRespuestaBot: ahora,
      historial: [],          // [{ rol: 'user'|'bot', texto, ts }]
      perfil: {               // lo que el bot va descubriendo del cliente
        presupuesto: null,
        zona: null,
        recamaras: null,
        proposito: null,      // vivir | invertir
        idioma: "es",
      },
      score: 0,               // 0-100
      temperatura: "frio",    // caliente | tibio | frio
      estado: "sin_atender",  // sin_atender | en_atencion | cerrado | perdido
      canal: "whatsapp",      // whatsapp | messenger | instagram
      agenteAsignado: null,
      humanoEnControl: false, // si un agente tomó el control
      escalado: false,        // si se escaló por frustración
      seguimientos: {         // banderas para no mandar follow-ups repetidos
        f24: false, f72: false, frio30: false, frio60: false, frio90: false,
      },
      citaProgramada: null,   // ISO string si hay cita
      propiedadesEnviadas: [], // ids de propiedades cuya foto ya se mandó
      notas: "",              // notas internas del asesor
      etiquetas: [],          // etiquetas/tags del lead
      ...patch,
    };
  } else {
    db.leads[telefono] = {
      ...existente,
      ...patch,
      perfil: { ...existente.perfil, ...(patch.perfil || {}) },
      seguimientos: { ...existente.seguimientos, ...(patch.seguimientos || {}) },
      ultimoMensaje: ahora,
    };
  }
  saveDB(db);
  return db.leads[telefono];
}

export function pushHistorial(telefono, rol, texto, extra = {}) {
  const db = loadDB();
  const lead = db.leads[telefono];
  if (!lead) return;
  // `extra` puede traer { estado, msgId } para las palomitas del CRM.
  lead.historial.push({ rol, texto, ts: new Date().toISOString(), ...extra });
  // Mantener historial manejable (últimos 40 mensajes)
  if (lead.historial.length > 40) lead.historial = lead.historial.slice(-40);
  if (rol === "bot") lead.ultimaRespuestaBot = new Date().toISOString();
  saveDB(db);
}

// Palomitas: WhatsApp avisa por webhook cuando un mensaje que enviamos fue
// entregado o leído. Aquí buscamos ese mensaje por su ID (wamid) en el historial
// y subimos su estado. Nunca lo bajamos (enviado < entregado < leido).
const ORDEN_ESTADO = { enviado: 1, entregado: 2, leido: 3 };
export function actualizarEstadoMensaje(msgId, estado) {
  if (!msgId || !ORDEN_ESTADO[estado]) return false;
  const db = loadDB();
  for (const tel in db.leads) {
    const h = db.leads[tel].historial || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].msgId === msgId) {
        const actual = ORDEN_ESTADO[h[i].estado] || 0;
        if (ORDEN_ESTADO[estado] > actual) {
          h[i].estado = estado;
          saveDB(db);
        }
        return true;
      }
    }
  }
  return false;
}

// ---- Helpers de agentes ---------------------------------------------------

export function getAgents() {
  return loadDB().agents;
}

export function deleteLead(telefono) {
  const db = loadDB();
  if (db.leads[telefono]) {
    delete db.leads[telefono];
    saveDB(db);
    return true;
  }
  return false;
}

export function getConfig() {
  const c = loadDB().config;
  // El nombre se fija en la instalación con la variable AGENCY_NAME (lo pones TÚ,
  // no el cliente). Así cada agencia ve SU nombre y se siente hecho a su medida.
  if (process.env.AGENCY_NAME) c.nombreAgencia = process.env.AGENCY_NAME;
  // El logo del cliente se pone con la variable LOGO_URL (un link a su logo).
  if (process.env.LOGO_URL) c.logoUrl = process.env.LOGO_URL;
  // Nombre con el que se presenta el bot (ej. "Sofía"). Lo hace sentir humano.
  if (process.env.BOT_NAME) c.botName = process.env.BOT_NAME;
  return c;
}

export function updateConfig(patch) {
  const db = loadDB();
  db.config = { ...db.config, ...patch };
  saveDB(db);
  return db.config;
}

export function createAgent(data) {
  const db = loadDB();
  const agent = {
    id: "a" + Date.now() + Math.floor(Math.random() * 1000),
    nombre: data.nombre || "Agente",
    telefono: String(data.telefono || "").replace(/\D/g, ""),
    zonas: Array.isArray(data.zonas) ? data.zonas : [],
    activo: data.activo !== false,
  };
  db.agents = db.agents || [];
  db.agents.push(agent);
  saveDB(db);
  return agent;
}

export function updateAgent(id, data) {
  const db = loadDB();
  const i = (db.agents || []).findIndex((a) => a.id === id);
  if (i === -1) return null;
  const a = db.agents[i];
  db.agents[i] = {
    ...a,
    ...data,
    telefono: data.telefono !== undefined ? String(data.telefono).replace(/\D/g, "") : a.telefono,
    zonas: data.zonas !== undefined ? (Array.isArray(data.zonas) ? data.zonas : a.zonas) : a.zonas,
    id: a.id,
  };
  saveDB(db);
  return db.agents[i];
}

export function deleteAgent(id) {
  const db = loadDB();
  const antes = (db.agents || []).length;
  db.agents = (db.agents || []).filter((a) => a.id !== id);
  saveDB(db);
  return db.agents.length < antes;
}

// ---- Bloqueos de horario (cuándo NO puede un asesor) -----------------------
// Sirven para que el bot no agende visitas en horas donde el asesor no está
// disponible (junta, día libre, otra cita fuera del sistema, etc.).

export function getBlocks() {
  // Limpia automáticamente los bloqueos que ya pasaron (más de 1 día atrás).
  const db = loadDB();
  const hoy = new Date();
  hoy.setDate(hoy.getDate() - 1);
  const corte = hoy.toISOString().slice(0, 10);
  const vigentes = (db.blocks || []).filter((b) => b.fecha >= corte);
  if (vigentes.length !== (db.blocks || []).length) {
    db.blocks = vigentes;
    saveDB(db);
  }
  return vigentes;
}

export function createBlock(data) {
  const db = loadDB();
  db.blocks = db.blocks || [];
  const bloque = {
    id: "blk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agenteId: data.agenteId || null,        // null = aplica a TODA la agencia
    fecha: data.fecha,                       // "YYYY-MM-DD"
    horaInicio: data.horaInicio || "09:00",  // "HH:MM"
    horaFin: data.horaFin || "19:00",
    motivo: (data.motivo || "").trim(),
    creado: new Date().toISOString(),
  };
  db.blocks.push(bloque);
  saveDB(db);
  return bloque;
}

export function deleteBlock(id) {
  const db = loadDB();
  const antes = (db.blocks || []).length;
  db.blocks = (db.blocks || []).filter((b) => b.id !== id);
  saveDB(db);
  return db.blocks.length < antes;
}

// ---- Helpers de propiedades -----------------------------------------------

export function getProperties() {
  return loadDB().properties || [];
}

export function getProperty(id) {
  return (loadDB().properties || []).find((p) => p.id === id) || null;
}

export function createProperty(data) {
  const db = loadDB();
  const prop = {
    id: "p" + Date.now() + Math.floor(Math.random() * 1000),
    titulo: data.titulo || "Propiedad sin título",
    zona: data.zona || null,            // llave de zona (polanco, reforma, etc.)
    tipo: data.tipo || "departamento",  // departamento | casa | terreno | oficina
    operacion: data.operacion || "venta", // venta | renta
    precio: Number(data.precio) || 0,
    recamaras: Number(data.recamaras) || 0,
    banos: Number(data.banos) || 0,
    m2: Number(data.m2) || 0,
    descripcion: data.descripcion || "",
    direccion: data.direccion || "",   // dirección exacta (se comparte si el cliente la pide)
    lat: (data.lat !== undefined && data.lat !== "" && data.lat !== null) ? Number(data.lat) : null, // coordenadas para el PIN
    lng: (data.lng !== undefined && data.lng !== "" && data.lng !== null) ? Number(data.lng) : null,
    imagenes: Array.isArray(data.imagenes) ? data.imagenes.filter(Boolean) : [],
    video: data.video || "",            // link a un video (opcional)
    estado: data.estado || (data.disponible === false ? "vendido" : "disponible"), // disponible | apartado | vendido
    disponible: (data.estado || (data.disponible === false ? "vendido" : "disponible")) === "disponible",
    creado: new Date().toISOString(),
  };
  db.properties = db.properties || [];
  db.properties.push(prop);
  saveDB(db);
  return prop;
}

export function updateProperty(id, data) {
  const db = loadDB();
  const i = (db.properties || []).findIndex((p) => p.id === id);
  if (i === -1) return null;
  const actual = db.properties[i];
  db.properties[i] = {
    ...actual,
    ...data,
    precio: data.precio !== undefined ? Number(data.precio) : actual.precio,
    recamaras: data.recamaras !== undefined ? Number(data.recamaras) : actual.recamaras,
    banos: data.banos !== undefined ? Number(data.banos) : actual.banos,
    m2: data.m2 !== undefined ? Number(data.m2) : actual.m2,
    imagenes: data.imagenes !== undefined
      ? (Array.isArray(data.imagenes) ? data.imagenes.filter(Boolean) : actual.imagenes)
      : actual.imagenes,
    lat: data.lat !== undefined ? (data.lat === "" || data.lat === null ? null : Number(data.lat)) : (actual.lat ?? null),
    lng: data.lng !== undefined ? (data.lng === "" || data.lng === null ? null : Number(data.lng)) : (actual.lng ?? null),
    estado: data.estado !== undefined ? data.estado : (actual.estado || "disponible"),
    disponible: data.estado !== undefined ? data.estado === "disponible"
      : (data.disponible !== undefined ? data.disponible !== false : actual.disponible),
    id: actual.id,
    creado: actual.creado,
  };
  saveDB(db);
  return db.properties[i];
}

export function deleteProperty(id) {
  const db = loadDB();
  const antes = (db.properties || []).length;
  db.properties = (db.properties || []).filter((p) => p.id !== id);
  saveDB(db);
  return db.properties.length < antes;
}

// ---- Helpers de ZONAS -----------------------------------------------------
// Las zonas viven en la base de datos para que el dueño las administre desde el
// panel. El `id` (slug) es la llave que usan las propiedades (prop.zona) y los
// agentes (agent.zonas), así que NO cambia aunque se edite el nombre.

function slugZona(s) {
  return (
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 24) || "z" + Date.now()
  );
}

function normalizaAliases(aliases, nombre) {
  let arr = [];
  if (Array.isArray(aliases)) arr = aliases;
  else if (typeof aliases === "string") arr = aliases.split(",");
  arr = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (nombre) {
    const n = String(nombre).toLowerCase().trim();
    if (n && !arr.includes(n)) arr.push(n);
  }
  return [...new Set(arr)];
}

export function getZones() {
  return loadDB().zones || [];
}

export function createZone(data) {
  const db = loadDB();
  db.zones = db.zones || [];
  let id = slugZona(data.nombre);
  let base = id, n = 2;
  while (db.zones.some((z) => z.id === id)) id = base + n++;
  const zone = {
    id,
    nombre: data.nombre || "Zona",
    aliases: normalizaAliases(data.aliases, data.nombre),
    precioM2: data.precioM2 ? Number(data.precioM2) : null,
    nota: data.nota || "",
    activa: data.activa !== false,
  };
  db.zones.push(zone);
  saveDB(db);
  return zone;
}

export function updateZone(id, data) {
  const db = loadDB();
  const i = (db.zones || []).findIndex((z) => z.id === id);
  if (i === -1) return null;
  const z = db.zones[i];
  db.zones[i] = {
    ...z,
    nombre: data.nombre !== undefined ? data.nombre : z.nombre,
    aliases:
      data.aliases !== undefined
        ? normalizaAliases(data.aliases, data.nombre || z.nombre)
        : z.aliases,
    precioM2:
      data.precioM2 !== undefined ? (data.precioM2 ? Number(data.precioM2) : null) : z.precioM2,
    nota: data.nota !== undefined ? data.nota : z.nota,
    activa: data.activa !== undefined ? data.activa !== false : z.activa,
    id: z.id, // el slug NO cambia (mantiene sincronía con propiedades y agentes)
  };
  saveDB(db);
  return db.zones[i];
}

export function deleteZone(id) {
  const db = loadDB();
  const antes = (db.zones || []).length;
  db.zones = (db.zones || []).filter((z) => z.id !== id);
  saveDB(db);
  return db.zones.length < antes;
}

// Cuenta cuántas propiedades y agentes usan una zona (para avisar antes de borrar)
export function zonaEnUso(id) {
  const db = loadDB();
  const props = (db.properties || []).filter((p) => p.zona === id).length;
  const agentes = (db.agents || []).filter((a) => (a.zonas || []).includes(id)).length;
  return { props, agentes };
}

// Crea las zonas de ejemplo de CDMX si no hay ninguna (para que el demo arranque solo).
// Los slugs coinciden con las llaves que ya usan las propiedades demo.
export function seedZonasDemo() {
  const db = loadDB();
  if ((db.zones || []).length > 0) return;
  db.zones = [
    { id: "polanco", nombre: "Polanco", aliases: ["polanco"], precioM2: 95000, nota: "Tendencia estable-alta. Renta promedio ~$45,000/mes (depto 2 rec). Compradores: ejecutivos, inversionistas y extranjeros; buscan lujo y ubicación. Típico: departamentos de lujo de 2-3 recámaras con amenidades premium.", activa: true },
    { id: "chapultepec", nombre: "Lomas / Chapultepec", aliases: ["chapultepec", "lomas"], precioM2: 78000, nota: "Tendencia subiendo. Compradores: familias de alto poder adquisitivo que buscan espacio y seguridad. Típico: casas y departamentos amplios, con jardín y seguridad privada.", activa: true },
    { id: "reforma", nombre: "Reforma / Cuauhtémoc", aliases: ["reforma", "cuauhtemoc", "cuauhtémoc"], precioM2: 72000, nota: "Tendencia subiendo. Compradores: jóvenes profesionistas, inversionistas en renta y corporativos. Típico: departamentos modernos en torre, 1-2 recámaras, con vista a la ciudad.", activa: true },
    { id: "condesa", nombre: "Condesa / Roma", aliases: ["condesa", "roma"], precioM2: 68000, nota: "Tendencia estable-alta. Compradores: creativos, expats e inversionistas en renta corta (Airbnb). Típico: departamentos con estilo, edificios art déco y lofts.", activa: true },
    { id: "delvalle", nombre: "Del Valle / Nápoles", aliases: ["valle", "del valle", "napoles", "nápoles"], precioM2: 58000, nota: "Tendencia estable. Compradores: familias clase media-alta y primer comprador con buen ingreso. Típico: departamentos familiares, buena conectividad y escuelas cerca.", activa: true },
    { id: "santafe", nombre: "Santa Fe", aliases: ["santa fe", "santafe", "santa fé"], precioM2: 52000, nota: "Tendencia estable. Compradores: ejecutivos que trabajan en los corporativos de la zona. Típico: departamentos en torre, con plusvalía corporativa y amenidades.", activa: true },
  ];
  saveDB(db);
  console.log("[zones] Zonas demo creadas.");
}
