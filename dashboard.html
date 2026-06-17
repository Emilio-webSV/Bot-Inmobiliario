// lib/gemini.js
// ---------------------------------------------------------------------------
// Conexión con Gemini. Construye el "cerebro" del bot: personalidad de la
// agencia + datos de zona + historial de la conversación.
//
// Usa fetch nativo de Node 20+ (no necesitas instalar nada).
// El modelo es configurable por variable de entorno para que lo actualices
// sin tocar código cuando Google saque uno nuevo.
// ---------------------------------------------------------------------------

import { contextoZona } from "./zones.js";

const MODELO = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_KEY = process.env.GEMINI_API_KEY;

function construirSystemPrompt({ config, lead }) {
  const p = lead.perfil || {};
  const zonaCtx = p.zona ? contextoZona(p.zona) : "";
  const idioma = p.idioma === "en" ? "inglés" : "español";

  // Qué datos faltan por preguntar (calificación natural, no interrogatorio)
  const faltantes = [];
  if (!p.presupuesto) faltantes.push("presupuesto aproximado");
  if (!p.zona) faltantes.push("zona de interés");
  if (!p.recamaras) faltantes.push("número de recámaras");
  if (!p.proposito) faltantes.push("si es para vivir o invertir");

  return `Eres el asistente virtual de "${config.nombreAgencia}", una agencia inmobiliaria.
Tu tono es ${config.tono}. Respondes SIEMPRE en ${idioma}.

TU MISIÓN:
1. Atender al cliente de forma cálida y profesional, como un asesor experto.
2. Calificar al cliente de forma NATURAL (sin parecer formulario). Datos que aún
   no conoces y conviene averiguar con el tiempo: ${faltantes.length ? faltantes.join(", ") : "ya tienes lo principal"}.
3. Generar confianza y avanzar hacia agendar una visita o llamada con un asesor.

REGLAS:
- Mensajes cortos, naturales, estilo WhatsApp. Nada de párrafos enormes.
- NO inventes propiedades, precios exactos ni direcciones que no te den.
- Si no sabes algo puntual, di que un asesor lo confirmará.
- Una pregunta a la vez. No interrogues.
- Si el cliente da un dato (presupuesto, zona, etc.), reconócelo y sigue.
- Usa los datos de zona de abajo para sonar como experto local, sin presumir.

${zonaCtx ? "CONTEXTO DE ZONA:\n" + zonaCtx : ""}

DATOS QUE YA SABES DEL CLIENTE:
- Nombre: ${lead.nombre || "aún no lo sabes"}
- Presupuesto: ${p.presupuesto ? "$" + p.presupuesto.toLocaleString("es-MX") + " MXN" : "desconocido"}
- Zona: ${p.zona || "desconocida"}
- Recámaras: ${p.recamaras || "desconocidas"}
- Propósito: ${p.proposito || "desconocido"}`;
}

// Convierte tu historial interno al formato que espera Gemini
function historialAContents(historial) {
  return historial.map((h) => ({
    role: h.rol === "bot" ? "model" : "user",
    parts: [{ text: h.texto }],
  }));
}

export async function generarRespuesta({ config, lead }) {
  if (!API_KEY) {
    console.warn("[gemini] Falta GEMINI_API_KEY. Devuelvo respuesta de respaldo.");
    return "¡Hola! Gracias por escribir. En un momento te atiendo. 🙂";
  }

  const systemPrompt = construirSystemPrompt({ config, lead });
  const contents = historialAContents(lead.historial || []);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${API_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 350,
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      console.error("[gemini] Error API:", res.status, errTxt);
      return "Disculpa, tuve un detalle técnico. ¿Me repites por favor? 🙏";
    }

    const data = await res.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return texto?.trim() || "¿Me puedes dar un poco más de detalle? 🙂";
  } catch (err) {
    console.error("[gemini] Excepción:", err.message);
    return "Disculpa, tuve un problema de conexión. ¿Me escribes de nuevo? 🙏";
  }
}
