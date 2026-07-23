// ---------------------------------------------------------------------------
// availability.js — Quién puede y cuándo
//
// Aquí vive todo lo relacionado con la DISPONIBILIDAD para agendar visitas:
//  - Los bloqueos que el dueño registra en el CRM ("María no puede el sábado
//    de 3 a 6").
//  - Las citas que YA están agendadas (para no encimar dos en la misma hora).
//
// El bot usa esto de dos formas: (1) se le dice en su prompt qué horarios NO
// están libres, para que no los ofrezca, y (2) si aun así intenta agendar en
// una hora ocupada, aquí se detecta y se le pide que proponga otra.
// ---------------------------------------------------------------------------

import { getBlocks, getAgents, loadDB } from "./store.js";

const TZ = "America/Mexico_City";

// Convierte "HH:MM" a minutos desde medianoche (para comparar rangos fácil).
function aMinutos(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// De una fecha ISO saca "YYYY-MM-DD" y "HH:MM" en hora de Ciudad de México.
export function partesFecha(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const h = new Intl.DateTimeFormat("es-MX", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return { fecha: f, hora: h.replace(/^24/, "00") };
}

// ¿La hora pedida choca con un bloqueo o con otra cita del mismo asesor?
// Devuelve null si está libre, o { motivo } explicando por qué no se puede.
export function revisarDisponibilidad(iso, agenteId = null) {
  const { fecha, hora } = partesFecha(iso);
  const min = aMinutos(hora);

  // 1) Bloqueos registrados en el CRM
  for (const b of getBlocks()) {
    if (b.fecha !== fecha) continue;
    // Un bloqueo sin asesor aplica a toda la agencia
    if (b.agenteId && agenteId && b.agenteId !== agenteId) continue;
    if (min >= aMinutos(b.horaInicio) && min < aMinutos(b.horaFin)) {
      const quien = b.agenteId
        ? (getAgents().find((a) => a.id === b.agenteId)?.nombre || "el asesor")
        : "la agencia";
      return { motivo: `${quien} no tiene disponibilidad en ese horario${b.motivo ? ` (${b.motivo})` : ""}` };
    }
  }

  // 2) Citas ya agendadas del mismo asesor (no encimar). Se considera que una
  //    visita dura 1 hora.
  if (agenteId) {
    const leads = Object.values(loadDB().leads || {});
    for (const l of leads) {
      if (!l.citaProgramada || l.agenteAsignado !== agenteId) continue;
      const p = partesFecha(l.citaProgramada);
      if (p.fecha !== fecha) continue;
      const otro = aMinutos(p.hora);
      if (Math.abs(min - otro) < 60) {
        return { motivo: "ese asesor ya tiene otra visita a esa hora" };
      }
    }
  }

  return null; // libre
}

// Texto corto con los horarios NO disponibles de los próximos días, para
// metérselo al bot en su prompt y que no ofrezca esas horas.
export function resumenNoDisponible(dias = 10) {
  const bloques = getBlocks();
  if (!bloques.length) return "";

  const hoy = new Date();
  const limite = new Date(hoy.getTime() + dias * 24 * 60 * 60 * 1000);
  const hoyStr = partesFecha(hoy.toISOString()).fecha;
  const limStr = partesFecha(limite.toISOString()).fecha;

  const agentes = getAgents();
  const lineas = bloques
    .filter((b) => b.fecha >= hoyStr && b.fecha <= limStr)
    .sort((a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio))
    .map((b) => {
      const quien = b.agenteId
        ? (agentes.find((a) => a.id === b.agenteId)?.nombre || "un asesor")
        : "TODA la agencia";
      const dia = new Date(b.fecha + "T12:00:00").toLocaleDateString("es-MX", {
        timeZone: TZ, weekday: "long", day: "numeric", month: "long",
      });
      const todoElDia = b.horaInicio === "00:00" && b.horaFin === "23:59";
      const rango = todoElDia ? "todo el día" : `de ${b.horaInicio} a ${b.horaFin}`;
      return `  · ${quien}: ${dia}, ${rango}${b.motivo ? ` (${b.motivo})` : ""}`;
    });

  if (!lineas.length) return "";
  return `\nHORARIOS NO DISPONIBLES (NO ofrezcas ni agendes en estos horarios):\n${lineas.join("\n")}\n  Si el cliente pide una de esas horas, dile con naturalidad que justo a esa hora no hay disponibilidad y ofrécele otra cercana.`;
}
