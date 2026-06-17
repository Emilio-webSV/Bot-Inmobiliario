// lib/scoring.js
// ---------------------------------------------------------------------------
// Calificación de leads. Extrae datos del mensaje (presupuesto, zona, recámaras,
// propósito) y calcula un score 0-100 que define la temperatura del lead.
//
// La extracción es por reglas (gratis e instantánea). Gemini ayuda a entender
// el lenguaje natural, pero el scoring final lo controlamos nosotros para que
// sea consistente y explicable al dueño de la agencia.
// ---------------------------------------------------------------------------

import { detectarZona } from "./zones.js";

// Extrae un monto en pesos de un texto. Maneja "2 millones", "2.5 mdp",
// "1,500,000", "800 mil", etc.
export function extraerPresupuesto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase().replace(/,/g, "");

  // "2 millones", "2.5 mdp", "3 mdp"
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:millones|millon|millón|mdp|mill)/);
  if (m) return Math.round(parseFloat(m[1]) * 1_000_000);

  // "800 mil", "500mil"
  m = t.match(/(\d+(?:\.\d+)?)\s*mil/);
  if (m) return Math.round(parseFloat(m[1]) * 1_000);

  // Número grande directo: 1500000, 2000000
  m = t.match(/\b(\d{6,9})\b/);
  if (m) return parseInt(m[1], 10);

  return null;
}

export function extraerRecamaras(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  const m = t.match(/(\d+)\s*(?:rec|recamara|recámara|recamaras|recámaras|cuarto|cuartos|habitacion|habitación|habitaciones)/);
  if (m) return parseInt(m[1], 10);
  if (t.includes("una recamara") || t.includes("una recámara")) return 1;
  if (t.includes("dos recamaras") || t.includes("dos recámaras")) return 2;
  if (t.includes("tres recamaras") || t.includes("tres recámaras")) return 3;
  return null;
}

export function extraerProposito(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  if (t.includes("invert") || t.includes("inversión") || t.includes("inversion") || t.includes("rentar") || t.includes("plusvalía") || t.includes("plusvalia")) return "invertir";
  if (t.includes("vivir") || t.includes("habitar") || t.includes("mudar") || t.includes("para mi familia") || t.includes("para mí")) return "vivir";
  return null;
}

const SENALES_URGENCIA = [
  "este mes", "lo antes posible", "urge", "ya", "cuanto antes", "esta semana",
  "necesito mudarme", "tengo que", "pronto", "inmediato",
];
const SENALES_CURIOSEO = [
  "solo pregunto", "solo veo", "nada más viendo", "curiosidad", "tal vez",
  "quizá", "quiza", "algún día", "algun dia", "más adelante", "mas adelante",
  "no por ahora", "solo cotizando",
];

// Actualiza el perfil del lead con lo nuevo que encontró en el mensaje
export function extraerPerfil(texto, perfilActual = {}) {
  const nuevo = { ...perfilActual };
  const presupuesto = extraerPresupuesto(texto);
  const zona = detectarZona(texto);
  const recamaras = extraerRecamaras(texto);
  const proposito = extraerProposito(texto);

  if (presupuesto) nuevo.presupuesto = presupuesto;
  if (zona) nuevo.zona = zona;
  if (recamaras) nuevo.recamaras = recamaras;
  if (proposito) nuevo.proposito = proposito;

  return nuevo;
}

// Calcula score 0-100 y temperatura a partir del perfil + señales de la conversación
export function calcularScore(lead) {
  const p = lead.perfil || {};
  let score = 0;

  // Datos completos del perfil suman (lead que comparte info = lead serio)
  if (p.presupuesto) score += 25;
  if (p.zona) score += 15;
  if (p.recamaras) score += 10;
  if (p.proposito) score += 10;

  // Interacción: mientras más conversa, más interesado
  const mensajesCliente = (lead.historial || []).filter((h) => h.rol === "user").length;
  score += Math.min(mensajesCliente * 3, 20); // hasta 20 pts

  // Señales en el último texto del cliente
  const ultimo = [...(lead.historial || [])].reverse().find((h) => h.rol === "user");
  const t = (ultimo?.texto || "").toLowerCase();
  if (SENALES_URGENCIA.some((s) => t.includes(s))) score += 20;
  if (SENALES_CURIOSEO.some((s) => t.includes(s))) score -= 15;

  // Pidió cita o quiere ver propiedad = muy caliente
  if (t.includes("cita") || t.includes("agendar") || t.includes("visitar") || t.includes("ver la propiedad") || t.includes("cuando puedo ver")) {
    score += 25;
  }

  score = Math.max(0, Math.min(100, score));

  let temperatura = "frio";
  if (score >= 65) temperatura = "caliente";
  else if (score >= 35) temperatura = "tibio";

  return { score, temperatura, serio: score >= 35, mensajesCliente };
}
