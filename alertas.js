// alertas.js
// ---------------------------------------------------------------------------
// Te avisa A TI (el desarrollador) cuando algo se rompe, para que entres a
// arreglarlo antes de que el cliente se dé cuenta.
//
// Variables (Railway -> Variables):
//   DEV_PHONE  -> TU WhatsApp con código de país (ej. 5215534169702)
//   DEV_EMAIL  -> tu correo (respaldo, por si lo que falló ES WhatsApp)
//   APP_NOMBRE -> cómo identificar esta instalación (ej. "Agencia Diamante")
//
// Si no defines nada, simplemente no manda alertas (no truena).
// ---------------------------------------------------------------------------

import { enviarTexto } from "./whatsapp.js";
import { enviarCorreo, correoActivo } from "./email.js";

const DEV_PHONE = (process.env.DEV_PHONE || "").replace(/\D/g, "");
const DEV_EMAIL = process.env.DEV_EMAIL || "";
const APP = process.env.APP_NOMBRE || process.env.AGENCY_NAME || "instalación sin nombre";

// Anti-spam: no mandamos la misma alerta más de una vez cada 30 minutos.
// Si algo falla 500 veces, tú recibes UN mensaje, no 500.
const VENTANA_MS = 30 * 60 * 1000;
const ultimaVez = new Map();   // clave -> { ts, repeticiones }
const MAX_POR_HORA = 8;
let enviadasEstaHora = 0;
let horaActual = new Date().getHours();

function puedeEnviar(clave) {
  const ahora = Date.now();
  // Tope por hora, para no llenarte el teléfono si el servidor entra en bucle.
  const h = new Date().getHours();
  if (h !== horaActual) { horaActual = h; enviadasEstaHora = 0; }
  if (enviadasEstaHora >= MAX_POR_HORA) return false;

  const prev = ultimaVez.get(clave);
  if (prev && ahora - prev.ts < VENTANA_MS) {
    prev.repeticiones++;
    return false;
  }
  const repeticiones = prev ? prev.repeticiones : 0;
  ultimaVez.set(clave, { ts: ahora, repeticiones: 0 });
  enviadasEstaHora++;
  return { repeticiones };
}

const ICONO = { critico: "🚨", alto: "⚠️", medio: "🔔" };

/**
 * Avisa de un problema.
 * @param {string} clave    identificador corto y estable (para el anti-spam)
 * @param {string} titulo   qué pasó, en una línea
 * @param {string} detalle  el error o contexto
 * @param {string} gravedad "critico" | "alto" | "medio"
 * @param {string} queHacer sugerencia concreta de cómo arreglarlo
 */
export async function alertarDev(clave, titulo, detalle = "", gravedad = "alto", queHacer = "") {
  const permiso = puedeEnviar(clave);
  if (!permiso) return;

  const hora = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const extra = permiso.repeticiones ? `\n(ocurrió ${permiso.repeticiones} veces más en la última media hora)` : "";
  const texto = `${ICONO[gravedad] || "⚠️"} ${titulo}\n\n📍 ${APP}\n🕐 ${hora}\n\n${String(detalle).slice(0, 400)}${extra}${queHacer ? `\n\n👉 ${queHacer}` : ""}`;

  console.error(`[alerta:${gravedad}] ${titulo} — ${detalle}`);

  // 1) WhatsApp (si el problema no es WhatsApp mismo)
  if (DEV_PHONE && clave !== "whatsapp_caido") {
    try { await enviarTexto(DEV_PHONE, texto); } catch (e) { /* seguimos al correo */ }
  }
  // 2) Correo: siempre que se pueda. Es el respaldo cuando WhatsApp es el problema.
  if (DEV_EMAIL && correoActivo()) {
    try {
      await enviarCorreo({
        para: DEV_EMAIL,
        asunto: `${ICONO[gravedad] || "⚠️"} ${APP}: ${titulo}`,
        texto,
        html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px">
          <h2 style="color:${gravedad === "critico" ? "#dc2626" : "#d97706"};margin:0 0 6px">${ICONO[gravedad] || "⚠️"} ${titulo}</h2>
          <p style="color:#666;margin:0 0 14px;font-size:13px">${APP} · ${hora}</p>
          <pre style="background:#f4f7f6;padding:14px;border-radius:8px;font-size:12.5px;white-space:pre-wrap;overflow-x:auto">${String(detalle).slice(0, 1200).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</pre>
          ${queHacer ? `<p style="background:#eff6ff;border-left:3px solid #2563eb;padding:12px 14px;font-size:14px"><b>Qué hacer:</b> ${queHacer}</p>` : ""}
        </div>`,
      });
    } catch (e) { /* ya quedó en el log */ }
  }
}

// Atrapa los errores que nadie manejó: son los que tumban el servidor.
export function instalarCazadorDeErrores() {
  process.on("uncaughtException", (err) => {
    alertarDev("uncaught", "El servidor tuvo un error grave", `${err.message}\n\n${(err.stack || "").split("\n").slice(0, 4).join("\n")}`,
      "critico", "Revisa los logs de Railway. El servidor puede haberse reiniciado solo.");
  });
  process.on("unhandledRejection", (r) => {
    alertarDev("unhandled", "Falló una operación en segundo plano", String(r?.message || r),
      "alto", "Suele ser una llamada a WhatsApp, a la IA o al correo que no respondió.");
  });
  console.log("[alertas] Cazador de errores activo.");
}

export function alertasActivas() { return Boolean(DEV_PHONE || DEV_EMAIL); }
export function destinoAlertas() { return { whatsapp: DEV_PHONE || null, correo: DEV_EMAIL || null, app: APP }; }
