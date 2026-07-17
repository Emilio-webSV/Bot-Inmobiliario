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

const SENALES_PEDIR_HUMANO = [
  "hablar con una persona", "hablar con alguien", "hablar con un humano",
  "hablar con un asesor", "hablar con un agente", "hablar con una asesora",
  "una persona real", "un humano real", "que me llamen", "que me marquen",
  "quiero que me llame", "me puede llamar una persona", "atiéndame una persona",
];

export function analizarFrustracion(texto) {
  if (!texto) return { frustrado: false, pideHumano: false, nivel: 0 };
  const t = texto.toLowerCase();

  let nivel = 0;
  for (const s of SENALES_FRUSTRACION) if (t.includes(s)) nivel++;

  // Mayúsculas sostenidas = gritando
  const letras = texto.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ]/g, "");
  if (letras.length > 6 && letras === letras.toUpperCase()) nivel++;

  // Signos de exclamación múltiples
  if ((texto.match(/!/g) || []).length >= 3) nivel++;

  const pideHumano = SENALES_PEDIR_HUMANO.some((s) => t.includes(s));

  return {
    // Solo escalamos si PIDE humano explícitamente, o si hay VARIAS señales de
    // enojo juntas (nivel >= 2). Una sola palabra suelta NO escala — así el bot
    // no se "rompe" por cualquier cosa.
    frustrado: pideHumano || nivel >= 2,
    pideHumano,
    nivel, // 0 = tranquilo, 1 = ligeramente molesto, 2+ = muy molesto
  };
}
