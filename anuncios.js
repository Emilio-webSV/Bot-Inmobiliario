// anuncios.js
// ---------------------------------------------------------------------------
// Captación por anuncios de Facebook e Instagram.
//
// La forma que sí funciona para este negocio son los anuncios de "clic a
// WhatsApp": el cliente toca el anuncio y se abre una conversación con la
// agencia. Como el cliente escribe primero, se abre la ventana de 24 horas y
// el asistente puede contestarle de inmediato y gratis.
//
// (La otra modalidad, los formularios de Facebook, deja al cliente FUERA de esa
//  ventana: para escribirle habría que gastar una plantilla y además la persona
//  no está esperando el mensaje. Convierte mucho peor.)
//
// Cuando alguien llega por un anuncio, Meta manda un bloque "referral" pegado
// al primer mensaje. Aquí lo leemos y lo guardamos, para que la agencia sepa
// qué anuncio le está trayendo clientes y cuáles solo gastan.
//
// Cada agencia paga y administra su propia cuenta publicitaria. Nosotros no
// tocamos su dinero ni sus campañas: solo medimos lo que llega.
// ---------------------------------------------------------------------------

import { loadDB, saveDB } from "./store.js";

/** Saca los datos del anuncio del mensaje entrante. Devuelve null si no vino de uno. */
export function leerReferencia(mensaje) {
  const r = mensaje?.referral;
  if (!r) return null;
  const fuente = { ig_ad: "Instagram", fb_ad: "Facebook", ad: "Facebook" }[r.source_type] || "Anuncio";
  return {
    origen: "anuncio",
    red: fuente,
    anuncioId: r.source_id || null,          // el id del anuncio en Meta
    tipo: r.source_type || null,
    titulo: (r.headline || "").slice(0, 140),
    texto: (r.body || "").slice(0, 200),
    liga: r.source_url || null,
    clicId: r.ctwa_clid || null,             // sirve para medir conversiones en Meta
    cuando: new Date().toISOString(),
  };
}

/** Guarda de qué anuncio vino un cliente. Solo la PRIMERA vez: si vuelve por
 *  otro anuncio no le borramos el origen real. */
export function registrarOrigen(telefono, ref) {
  if (!ref) return;
  const db = loadDB();
  const lead = db.leads[telefono];
  if (!lead) return;
  if (lead.anuncio) return;                  // ya tenía origen, no lo pisamos
  lead.origen = "anuncio";
  lead.anuncio = ref;
  db.anuncios = db.anuncios || {};
  const k = ref.anuncioId || "sin_id";
  db.anuncios[k] = db.anuncios[k] || {
    id: k, red: ref.red, titulo: ref.titulo, leads: 0, citas: 0, ventas: 0,
    montoVentas: 0, primero: ref.cuando,
  };
  db.anuncios[k].leads++;
  db.anuncios[k].ultimo = ref.cuando;
  saveDB(db);
  console.log(`[anuncio] Nuevo lead de ${ref.red}: "${ref.titulo || ref.anuncioId}"`);
}

/** Se llama cuando un lead que vino de anuncio agenda cita o cierra venta,
 *  para poder decirle a la agencia qué anuncio de verdad vendió. */
export function sumarResultado(telefono, tipo, monto = 0) {
  const db = loadDB();
  const lead = db.leads[telefono];
  if (!lead?.anuncio) return;
  const k = lead.anuncio.anuncioId || "sin_id";
  if (!db.anuncios?.[k]) return;
  if (tipo === "cita") db.anuncios[k].citas++;
  if (tipo === "venta") { db.anuncios[k].ventas++; db.anuncios[k].montoVentas += Number(monto) || 0; }
  saveDB(db);
}

/** Resumen para el panel: qué trajo cada anuncio. */
export function resumenAnuncios() {
  const db = loadDB();
  const anuncios = Object.values(db.anuncios || {});
  const leads = Object.values(db.leads || {});
  const dePago = leads.filter((l) => l.origen === "anuncio").length;
  const organicos = leads.length - dePago;

  const filas = anuncios.map((a) => ({
    ...a,
    conversion: a.leads ? +((a.citas / a.leads) * 100).toFixed(1) : 0,
  })).sort((a, b) => b.leads - a.leads);

  return {
    totalLeads: leads.length,
    dePago, organicos,
    porcentajeDePago: leads.length ? +((dePago / leads.length) * 100).toFixed(1) : 0,
    anuncios: filas,
    citasDePago: filas.reduce((s, a) => s + a.citas, 0),
    ventasDePago: filas.reduce((s, a) => s + a.ventas, 0),
    montoDePago: filas.reduce((s, a) => s + a.montoVentas, 0),
  };
}
