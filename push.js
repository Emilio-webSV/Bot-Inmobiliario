// push.js
// ---------------------------------------------------------------------------
// Notificaciones al celular, como las de WhatsApp: llegan aunque el CRM esté
// cerrado. Cada persona recibe SOLO lo suyo y elige qué quiere que le avise.
//
// No hay que configurar nada: las llaves se generan solas la primera vez y se
// guardan en la base de datos.
// ---------------------------------------------------------------------------

import webpush from "web-push";
import { loadDB, saveDB } from "./store.js";

let listo = false;

// Genera (una sola vez) las llaves que identifican a este servidor ante los
// servicios de notificaciones de Google/Apple/Mozilla.
function iniciar() {
  if (listo) return true;
  const db = loadDB();
  db.push = db.push || {};
  if (!db.push.publicKey || !db.push.privateKey) {
    const k = webpush.generateVAPIDKeys();
    db.push.publicKey = k.publicKey;
    db.push.privateKey = k.privateKey;
    db.push.suscripciones = db.push.suscripciones || [];
    saveDB(db);
    console.log("[push] Llaves generadas.");
  }
  webpush.setVapidDetails(
    `mailto:${process.env.DEV_EMAIL || "avisos@realtorsolutions.ai"}`,
    db.push.publicKey, db.push.privateKey
  );
  listo = true;
  return true;
}

export function llavePublica() { iniciar(); return loadDB().push.publicKey; }

// Preferencias por defecto: qué te avisa cuando te suscribes.
export const AVISOS = {
  cliente_nuevo:   { nombre: "Cliente nuevo",              def: true },
  atencion_humana: { nombre: "Alguien pide un asesor",     def: true },
  cita_agendada:   { nombre: "Cita agendada",              def: true },
  cita_cambio:     { nombre: "Cita cancelada o movida",    def: true },
  lead_caliente:   { nombre: "Lead caliente sin atender",  def: true },
  mensaje_chat:    { nombre: "Mensaje en un chat que llevo", def: true },
  venta:           { nombre: "Venta registrada",           def: false },
};

function prefsPorDefecto() {
  const p = {};
  for (const k in AVISOS) p[k] = AVISOS[k].def;
  return p;
}

// Guarda el "buzón" del dispositivo de una persona.
export function suscribir(usuarioId, nombre, suscripcion, prefs) {
  iniciar();
  const db = loadDB();
  db.push = db.push || {}; db.push.suscripciones = db.push.suscripciones || [];
  const i = db.push.suscripciones.findIndex((s) => s.sub?.endpoint === suscripcion?.endpoint);
  const reg = {
    id: "sub_" + Date.now().toString(36),
    usuarioId: usuarioId || "dueno",
    nombre: nombre || "Dueño",
    sub: suscripcion,
    prefs: prefs || (i !== -1 ? db.push.suscripciones[i].prefs : prefsPorDefecto()),
    creada: new Date().toISOString(),
  };
  if (i !== -1) { reg.id = db.push.suscripciones[i].id; reg.creada = db.push.suscripciones[i].creada; db.push.suscripciones[i] = reg; }
  else db.push.suscripciones.push(reg);
  saveDB(db);
  return reg;
}

export function desuscribir(endpoint) {
  const db = loadDB();
  if (!db.push?.suscripciones) return false;
  const antes = db.push.suscripciones.length;
  db.push.suscripciones = db.push.suscripciones.filter((s) => s.sub?.endpoint !== endpoint);
  saveDB(db);
  return db.push.suscripciones.length < antes;
}

export function misSuscripciones(usuarioId) {
  const db = loadDB();
  return (db.push?.suscripciones || []).filter((s) => s.usuarioId === usuarioId);
}

export function guardarPrefs(usuarioId, prefs) {
  const db = loadDB();
  let n = 0;
  for (const s of (db.push?.suscripciones || [])) {
    if (s.usuarioId === usuarioId) { s.prefs = { ...s.prefs, ...prefs }; n++; }
  }
  if (n) saveDB(db);
  return n;
}

/**
 * Manda la notificación.
 * @param {string} tipo    una de las llaves de AVISOS
 * @param {object} datos   { titulo, cuerpo, url, tag, urgente }
 * @param {string|null} paraUsuario  id del asesor, o null = para todos
 */
export async function notificar(tipo, datos, paraUsuario = null) {
  try {
    iniciar();
    const db = loadDB();
    const subs = (db.push?.suscripciones || []).filter((s) => {
      if (s.prefs && s.prefs[tipo] === false) return false;           // lo apagó
      if (paraUsuario && s.usuarioId !== paraUsuario && s.usuarioId !== "dueno") return false;
      return true;
    });
    if (!subs.length) return { enviadas: 0 };

    const payload = JSON.stringify({
      title: datos.titulo || "Novedad",
      body: datos.cuerpo || "",
      url: datos.url || "/dashboard",
      tag: datos.tag || tipo,
      urgente: Boolean(datos.urgente),
      tipo,
    });

    let enviadas = 0; const muertas = [];
    await Promise.all(subs.map(async (s) => {
      try { await webpush.sendNotification(s.sub, payload, { TTL: 3600, urgency: datos.urgente ? "high" : "normal" }); enviadas++; }
      catch (e) {
        // 404/410 = el navegador ya no existe (desinstalaron la app o limpiaron datos)
        if (e.statusCode === 404 || e.statusCode === 410) muertas.push(s.sub.endpoint);
      }
    }));
    if (muertas.length) {
      const d2 = loadDB();
      d2.push.suscripciones = (d2.push.suscripciones || []).filter((s) => !muertas.includes(s.sub?.endpoint));
      saveDB(d2);
    }
    return { enviadas };
  } catch (e) {
    console.error("[push] Error:", e.message);
    return { enviadas: 0, error: e.message };
  }
}

export function pushActivo() {
  const db = loadDB();
  return (db.push?.suscripciones || []).length > 0;
}
