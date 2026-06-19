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

export function pushHistorial(telefono, rol, texto) {
  const db = loadDB();
  const lead = db.leads[telefono];
  if (!lead) return;
  lead.historial.push({ rol, texto, ts: new Date().toISOString() });
  // Mantener historial manejable (últimos 40 mensajes)
  if (lead.historial.length > 40) lead.historial = lead.historial.slice(-40);
  if (rol === "bot") lead.ultimaRespuestaBot = new Date().toISOString();
  saveDB(db);
}

// ---- Helpers de agentes ---------------------------------------------------

export function getAgents() {
  return loadDB().agents;
}

export function getConfig() {
  const c = loadDB().config;
  // El nombre se fija en la instalación con la variable AGENCY_NAME (lo pones TÚ,
  // no el cliente). Así cada agencia ve SU nombre y se siente hecho a su medida.
  if (process.env.AGENCY_NAME) c.nombreAgencia = process.env.AGENCY_NAME;
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
    imagenes: Array.isArray(data.imagenes) ? data.imagenes.filter(Boolean) : [],
    disponible: data.disponible !== false,
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
