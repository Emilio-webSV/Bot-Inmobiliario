// lib/frustration.js
// ---------------------------------------------------------------------------
// Detección de frustración. Si el cliente está molesto, NO insistas con el bot:
// escala a un humano. Un cliente enojado que se siente atendido por una persona
// se recupera; uno que sigue peleando con un bot se pierde.
// ---------------------------------------------------------------------------

const SENALES_FRUSTRACION = [
  "no me entiendes", "no entiendes", "ya te dije", "estás mal", "estas mal",
  "no sirve", "no funciona", "pésimo", "pesimo", "horrible", "estúpido", "estupido",
  "eres un bot", "quiero hablar con una persona", "quiero un humano", "agente real",
  "asesor real", "déjame hablar", "dejame hablar", "esto no me ayuda", "no me ayudas",
  "ya basta", "qué mal", "que mal", "no me estás", "no me estas",
];

// Patrones que indican que el cliente quiere hablar con una PERSONA de verdad.
// Usamos expresiones flexibles (no frases exactas) para no dejar fuera formas
// como "necesito un asesor humano" o "pásame con alguien".
const PATRONES_PIDE_HUMANO = [
  // Menciona "humano" / "persona real" / "gente real" en casi cualquier forma
  /\bhuman[oa]s?\b/i,
  /\bpersona\s+(real|de\s+verdad|f[ií]sica)\b/i,
  /\bgente\s+real\b/i,
  // Pedir explícitamente que lo atienda/pase con alguien
  /\b(quiero|necesito|puedo|p[aá]same|pasame|com?un[ií]came|contactame|cont[aá]ctame|atiendame|at[ié]ndame)\b[^.]{0,40}\b(asesor|agente|persona|alguien|vendedor|encargado|due[ñn]o)\b/i,
  /\bhablar\s+con\s+(una?\s+)?(persona|alguien|asesor|agente|humano|vendedor|encargado)\b/i,
  // Pedir que le llamen
  /\bque\s+me\s+(llamen|marquen|hablen)\b/i,
  /\bquiero\s+que\s+me\s+llame\b/i,
];

// Preguntas directas de si es un bot / una IA. Aquí NUNCA se puede mentir.
const PATRONES_PREGUNTA_BOT = [
  /\beres\s+(una?\s+)?(bot|robot|m[aá]quina|ia|inteligencia\s+artificial|chatbot|programa)\b/i,
  /\b(es|esto\s+es)\s+(un\s+)?(bot|robot|ia|chatbot)\b/i,
  /\bhablo\s+con\s+(un\s+)?(bot|robot|ia|m[aá]quina)\b/i,
  /\beres\s+(una\s+)?persona\s+(real|de\s+verdad)\b/i,
  /\beres\s+human[oa]\b/i,
];

export function analizarFrustracion(texto) {
  if (!texto) return { frustrado: false, pideHumano: false, preguntaSiEsBot: false, nivel: 0 };
  const t = texto.toLowerCase();

  let nivel = 0;
  for (const s of SENALES_FRUSTRACION) if (t.includes(s)) nivel++;

  // Mayúsculas sostenidas = gritando
  const letras = texto.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ]/g, "");
  if (letras.length > 6 && letras === letras.toUpperCase()) nivel++;

  // Signos de exclamación múltiples
  if ((texto.match(/!/g) || []).length >= 3) nivel++;

  const preguntaSiEsBot = PATRONES_PREGUNTA_BOT.some((r) => r.test(texto));
  // Si SOLO pregunta si es un bot, no lo escalamos: el bot responde honesto y sigue.
  const pideHumano = !preguntaSiEsBot && PATRONES_PIDE_HUMANO.some((r) => r.test(texto));

  return {
    // Solo escalamos si PIDE humano explícitamente, o si hay VARIAS señales de
    // enojo juntas (nivel >= 2). Una sola palabra suelta NO escala — así el bot
    // no se "rompe" por cualquier cosa.
    frustrado: pideHumano || nivel >= 2,
    pideHumano,
    preguntaSiEsBot,
    nivel, // 0 = tranquilo, 1 = ligeramente molesto, 2+ = muy molesto
  };
}
