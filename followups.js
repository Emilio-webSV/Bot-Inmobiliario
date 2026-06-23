// lib/followups.js
// ---------------------------------------------------------------------------
// Seguimientos automáticos (cron). Esto es lo que NO hace un agente humano por
// flojera y es justo donde se pierden las ventas:
//   - Follow-up si el cliente no responde (24h y 72h)
//   - Recordatorio de cita 24h antes
//   - Reactivación de leads fríos a los 30, 60 y 90 días
//   - Alerta al DUEÑO si un lead caliente lleva +2h sin atención humana
//   - Reporte semanal cada lunes
// ---------------------------------------------------------------------------

import cron from "node-cron";
import { loadDB, upsertLead, pushHistorial, getConfig } from "./store.js";
import { enviarTexto } from "./whatsapp.js";
import { enviarTextoCanal } from "./canales.js";

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

function horasDesde(iso) {
  return (Date.now() - new Date(iso).getTime()) / HORA;
}
function diasDesde(iso) {
  return (Date.now() - new Date(iso).getTime()) / DIA;
}

// --- Follow-ups por inactividad + reactivación de fríos --------------------
async function revisarSeguimientos() {
  const db = loadDB();
  const config = getConfig();

  for (const lead of Object.values(db.leads)) {
    if (lead.humanoEnControl) continue; // si un agente lo tomó, el bot no molesta

    const ultimo = lead.historial?.[lead.historial.length - 1];
    if (!ultimo) continue;

    // Solo seguimos si el ÚLTIMO mensaje fue del bot (cliente no contestó)
    const esperandoRespuesta = ultimo.rol === "bot";
    const h = horasDesde(lead.ultimoMensaje);
    const d = diasDesde(lead.ultimoMensaje);

    // 24h sin responder
    if (esperandoRespuesta && h >= 24 && h < 72 && !lead.seguimientos.f24) {
      const msg = `Hola${lead.nombre ? " " + lead.nombre : ""} 👋 ¿Sigues interesado en encontrar tu propiedad? Con gusto te ayudo a dar el siguiente paso cuando quieras.`;
      await enviarTextoCanal(lead.canal, lead.telefono, msg);
      pushHistorial(lead.telefono, "bot", msg);
      upsertLead(lead.telefono, { seguimientos: { f24: true } });
      continue;
    }

    // 72h sin responder
    if (esperandoRespuesta && h >= 72 && h < 24 * 30 && !lead.seguimientos.f72) {
      const msg = `${lead.nombre ? lead.nombre + ", t" : "T"}e cuento que el mercado se mueve rápido y tengo opciones que quizá te encanten. ¿Retomamos? 🏡`;
      await enviarTextoCanal(lead.canal, lead.telefono, msg);
      pushHistorial(lead.telefono, "bot", msg);
      upsertLead(lead.telefono, { seguimientos: { f72: true } });
      continue;
    }

    // Reactivación de leads fríos
    const reactivar = async (mensaje, flag) => {
      await enviarTextoCanal(lead.canal, lead.telefono, mensaje);
      pushHistorial(lead.telefono, "bot", mensaje);
      upsertLead(lead.telefono, { seguimientos: { [flag]: true } });
    };

    if (d >= 30 && d < 60 && !lead.seguimientos.frio30) {
      await reactivar(`Hola${lead.nombre ? " " + lead.nombre : ""} 🙌 Pasó un mes desde que platicamos. Han salido propiedades nuevas en tu zona de interés. ¿Te muestro?`, "frio30");
    } else if (d >= 60 && d < 90 && !lead.seguimientos.frio60) {
      await reactivar(`¡Hola de nuevo! Los precios en tu zona han tenido movimiento. Si todavía buscas, es buen momento para revisar opciones. ¿Lo vemos?`, "frio60");
    } else if (d >= 90 && !lead.seguimientos.frio90) {
      await reactivar(`Hola${lead.nombre ? " " + lead.nombre : ""}, soy de ${config.nombreAgencia}. Sé que pasó tiempo, pero si aún te interesa una propiedad, me encantaría apoyarte sin compromiso. 🙂`, "frio90");
    }
  }
}

// --- Recordatorio de cita 24h antes ----------------------------------------
async function revisarCitas() {
  const db = loadDB();
  for (const lead of Object.values(db.leads)) {
    if (!lead.citaProgramada) continue;
    const h = (new Date(lead.citaProgramada).getTime() - Date.now()) / HORA;
    if (h <= 24 && h > 23 && !lead.seguimientos.recordatorioCita) {
      const fecha = new Date(lead.citaProgramada).toLocaleString("es-MX", {
        timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
      });
      const msg = `Recordatorio 📅 Tienes tu cita el ${fecha}. ¿Confirmas asistencia? Aquí estaré para lo que necesites.`;
      await enviarTextoCanal(lead.canal, lead.telefono, msg);
      pushHistorial(lead.telefono, "bot", msg);
      upsertLead(lead.telefono, { seguimientos: { recordatorioCita: true } });
    }
  }
}

// --- Alerta al dueño: lead caliente sin atender +2h ------------------------
async function revisarLeadsCalientes() {
  const db = loadDB();
  const dueno = process.env.OWNER_PHONE;
  if (!dueno) return;

  for (const lead of Object.values(db.leads)) {
    if (lead.temperatura !== "caliente") continue;
    if (lead.humanoEnControl) continue;
    if (lead.seguimientos.alertaCaliente) continue;

    if (horasDesde(lead.ultimoMensaje) >= 2) {
      const msg = `🔴 LEAD CALIENTE SIN ATENDER\nCliente: ${lead.nombre || lead.telefono}\nZona: ${lead.perfil.zona || "?"}\nPresupuesto: ${lead.perfil.presupuesto ? "$" + lead.perfil.presupuesto.toLocaleString("es-MX") : "?"}\nScore: ${lead.score}/100\nLleva +2h sin respuesta humana. ¡Contáctalo ya!`;
      await enviarTexto(dueno, msg);
      upsertLead(lead.telefono, { seguimientos: { alertaCaliente: true } });
    }
  }
}

// --- Reporte semanal (lunes 9am) -------------------------------------------
async function reporteSemanal() {
  const db = loadDB();
  const dueno = process.env.OWNER_PHONE;
  if (!dueno) return;

  const leads = Object.values(db.leads);
  const nuevos = leads.filter((l) => diasDesde(l.creado) <= 7);
  const calientes = leads.filter((l) => l.temperatura === "caliente");
  const tibios = leads.filter((l) => l.temperatura === "tibio");
  const pipeline = leads
    .filter((l) => l.perfil.presupuesto)
    .reduce((sum, l) => sum + l.perfil.presupuesto, 0);

  const msg = `📊 REPORTE SEMANAL — ${getConfig().nombreAgencia}
Leads nuevos (7 días): ${nuevos.length}
🔴 Calientes: ${calientes.length}
🟡 Tibios: ${tibios.length}
Total en base: ${leads.length}
💰 Pipeline potencial: $${pipeline.toLocaleString("es-MX")} MXN

¡Buena semana! Entra al dashboard para el detalle.`;
  await enviarTexto(dueno, msg);
}

// --- Registrar todos los cron jobs -----------------------------------------
export function iniciarCronJobs() {
  // Cada 30 minutos: seguimientos, citas, leads calientes
  cron.schedule("*/30 * * * *", async () => {
    try {
      await revisarSeguimientos();
      await revisarCitas();
      await revisarLeadsCalientes();
    } catch (e) {
      console.error("[cron] Error en revisión periódica:", e.message);
    }
  });

  // Lunes 9:00 AM hora de México
  cron.schedule("0 9 * * 1", reporteSemanal, { timezone: "America/Mexico_City" });

  console.log("[cron] Seguimientos automáticos activos.");
}

// ---------------------------------------------------------------------------
// FUNCIONES DE PRUEBA — para dispararlas a mano desde /api/test/...
// ---------------------------------------------------------------------------

// Manda el reporte AHORA (sin esperar al lunes)
export async function enviarReporteAhora() {
  const dueno = process.env.OWNER_PHONE;
  if (!dueno) return "Falta OWNER_PHONE en las variables.";
  await reporteSemanal();
  return `Reporte enviado al dueño (${dueno}).`;
}

// Revisa leads calientes AHORA. Si force=true, ignora el "+2h" y el flag previo
// para que puedas ver la alerta al instante durante una prueba o demo.
export async function revisarLeadsCalientesAhora(force = false) {
  const dueno = process.env.OWNER_PHONE;
  if (!dueno) return "Falta OWNER_PHONE en las variables.";
  if (!force) {
    await revisarLeadsCalientes();
    return "Revisión normal hecha.";
  }
  const db = loadDB();
  let enviadas = 0;
  for (const lead of Object.values(db.leads)) {
    if (lead.temperatura !== "caliente") continue;
    const msg = `🔴 LEAD CALIENTE SIN ATENDER (prueba)\nCliente: ${lead.nombre || lead.telefono}\nZona: ${lead.perfil.zona || "?"}\nPresupuesto: ${lead.perfil.presupuesto ? "$" + lead.perfil.presupuesto.toLocaleString("es-MX") : "?"}\nScore: ${lead.score}/100\n¡Contáctalo ya!`;
    await enviarTexto(dueno, msg);
    enviadas++;
  }
  return `Alertas enviadas: ${enviadas} (de leads calientes).`;
}
