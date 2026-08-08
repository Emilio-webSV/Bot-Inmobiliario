// consumo.js
// ---------------------------------------------------------------------------
// Lleva la cuenta de lo que gasta ESTA agencia: cada mensaje que sale por
// WhatsApp y cada llamada a la inteligencia artificial, con sus tokens reales.
//
// Sirve para dos cosas:
//   · Saber cuánto cuesta de verdad cada cliente, sin adivinar.
//   · Darse cuenta a tiempo si una agencia se está disparando, en vez de
//     enterarse cuando llega el recibo.
//
// Se guarda por mes dentro de la misma base de datos, así que sobrevive a los
// reinicios y se puede consultar el histórico.
// ---------------------------------------------------------------------------

import { loadDB, saveDB } from "./store.js";

// --- Precios de origen, en DÓLARES. Se pueden ajustar por variable de entorno
//     cuando Meta publique la tarifa definitiva del mensaje de servicio.
const P = {
  servicio:  Number(process.env.PRECIO_MSG_SERVICIO  ?? 0.0080),
  utilidad:  Number(process.env.PRECIO_MSG_UTILIDAD  ?? 0.0080),
  marketing: Number(process.env.PRECIO_MSG_MARKETING ?? 0.0436),
  iaEntrada: Number(process.env.PRECIO_IA_ENTRADA    ?? 0.30) / 1e6,
  iaSalida:  Number(process.env.PRECIO_IA_SALIDA     ?? 2.50) / 1e6,
  railway:   Number(process.env.PRECIO_RAILWAY       ?? 5.00),
};
const USD = Number(process.env.TIPO_CAMBIO ?? 17.25);

const mesActual = () => new Date().toISOString().slice(0, 7);   // "2026-08"

function bolsa(mes = mesActual()) {
  const db = loadDB();
  db.consumo = db.consumo || {};
  db.consumo[mes] = db.consumo[mes] || {
    msgServicio: 0, msgUtilidad: 0, msgMarketing: 0, msgOtros: 0,
    iaLlamadas: 0, iaTokEntrada: 0, iaTokSalida: 0, iaFallos: 0,
    conversaciones: {},          // teléfonos distintos atendidos este mes
  };
  return { db, m: db.consumo[mes] };
}

/** Clasifica una plantilla según cómo la registró la agencia en Meta. */
function categoriaPlantilla(nombre) {
  if (!nombre) return "utilidad";
  if (nombre === process.env.WA_TPL_SEGUIMIENTO) return "marketing";
  return "utilidad";   // cita y alerta son de utilidad
}

/** Se llama con CADA mensaje que el negocio manda por WhatsApp. */
export function contarMensaje(body, telefono) {
  try {
    const { db, m } = bolsa();
    if (body?.type === "template") {
      const cat = categoriaPlantilla(body?.template?.name);
      if (cat === "marketing") m.msgMarketing++; else m.msgUtilidad++;
    } else if (["text", "image", "video", "document", "location", "audio"].includes(body?.type)) {
      m.msgServicio++;
    } else {
      m.msgOtros++;
    }
    if (telefono) m.conversaciones[telefono] = 1;
    saveDB(db);
  } catch { /* medir nunca debe romper el envío */ }
}

/** Se llama con cada respuesta de la IA. */
export function contarIA({ entrada = 0, salida = 0, fallo = false } = {}) {
  try {
    const { db, m } = bolsa();
    if (fallo) { m.iaFallos++; } else {
      m.iaLlamadas++;
      m.iaTokEntrada += entrada;
      m.iaTokSalida += salida;
    }
    saveDB(db);
  } catch { /* igual: no romper nada */ }
}

/** Devuelve el consumo de un mes, ya convertido a pesos. */
export function resumen(mes = mesActual()) {
  const db = loadDB();
  const m = (db.consumo || {})[mes];
  if (!m) return null;

  const usd = {
    servicio:  m.msgServicio  * P.servicio,
    utilidad:  m.msgUtilidad  * P.utilidad,
    marketing: m.msgMarketing * P.marketing,
    ia:        m.iaTokEntrada * P.iaEntrada + m.iaTokSalida * P.iaSalida,
    railway:   P.railway,
  };
  usd.total = usd.servicio + usd.utilidad + usd.marketing + usd.ia + usd.railway;

  const convs = Object.keys(m.conversaciones || {}).length;
  const mxn = Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, +(v * USD).toFixed(2)]));

  // Proyección a fin de mes según el ritmo que lleva
  const hoy = new Date();
  const diaDelMes = hoy.getDate();
  const diasDelMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const esMesEnCurso = mes === mesActual();
  const factor = esMesEnCurso && diaDelMes > 0 ? diasDelMes / diaDelMes : 1;

  const mensualidad = Number(process.env.MENSUALIDAD ?? 3000);
  return {
    mes,
    agencia: (db.config || {}).nombreAgencia || "—",
    mensajes: {
      servicio: m.msgServicio, utilidad: m.msgUtilidad,
      marketing: m.msgMarketing, otros: m.msgOtros,
      total: m.msgServicio + m.msgUtilidad + m.msgMarketing + m.msgOtros,
    },
    ia: { llamadas: m.iaLlamadas, tokensEntrada: m.iaTokEntrada, tokensSalida: m.iaTokSalida, fallos: m.iaFallos },
    conversaciones: convs,
    costoMXN: mxn,
    proyeccionFinDeMesMXN: +(mxn.total * factor).toFixed(2),
    mensualidad,
    utilidadMXN: +(mensualidad - mxn.total).toFixed(2),
    margenPct: +(((mensualidad - mxn.total) / mensualidad) * 100).toFixed(1),
    alerta:
      mxn.total > mensualidad * 0.8 ? "critico" :
      mxn.total * factor > mensualidad * 0.8 ? "va_a_pasarse" :
      mxn.total > mensualidad * 0.5 ? "atencion" : "ok",
    tipoCambio: USD,
  };
}

/** Todos los meses que hay registrados. */
export function historico() {
  const db = loadDB();
  return Object.keys(db.consumo || {}).sort().reverse().map((m) => resumen(m));
}
