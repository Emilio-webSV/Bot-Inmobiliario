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
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

// Estructura inicial de la base de datos
const DEFAULT_DB = {
  leads: {},        // { telefono: { ...datosDelLead } }
  agents: [],       // [ { id, nombre, telefono, zonas: [], activo } ]
  config: {
    nombreAgencia: "Inmobiliaria Demo",
    tono: "profesional y cálido", // formal | relajado | lujoso
    idiomaDefault: "es",
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
      agenteAsignado: null,
      humanoEnControl: false, // si un agente tomó el control
      escalado: false,        // si se escaló por frustración
      seguimientos: {         // banderas para no mandar follow-ups repetidos
        f24: false, f72: false, frio30: false, frio60: false, frio90: false,
      },
      citaProgramada: null,   // ISO string si hay cita
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
  return loadDB().config;
}
