// gemini.js
// ---------------------------------------------------------------------------
// Cerebro del bot — ahora corriendo sobre GROQ (gratis, sin tarjeta, rapidísimo).
//
// Nota: el archivo se sigue llamando "gemini.js" a propósito, para que NO tengas
// que tocar server.js. Por dentro ahora llama a Groq, que es compatible con el
// formato de OpenAI. La función exportada sigue siendo generarRespuesta().
//
// Variables que necesita (en Railway -> Variables):
//   GROQ_API_KEY  -> tu clave de https://console.groq.com/keys
//   GROQ_MODEL    -> opcional. Por defecto: llama-3.3-70b-versatile
// ---------------------------------------------------------------------------

import { contextoZona } from "./zones.js";

const MODELO = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const API_KEY = process.env.GROQ_API_KEY;
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

function construirSystemPrompt({ config, lead }) {
  const p = lead.perfil || {};
  const zonaCtx = p.zona ? contextoZona(p.zona) : "";
  const idioma = p.idioma === "en" ? "inglés" : "español";

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

function construirMensajes({ config, lead }) {
  const mensajes = [
    { role: "system", content: construirSystemPrompt({ config, lead }) },
  ];
  for (const h of lead.historial || []) {
    mensajes.push({
      role: h.rol === "bot" ? "assistant" : "user",
      content: h.texto,
    });
  }
  return mensajes;
}

export async function generarRespuesta({ config, lead }) {
  if (!API_KEY) {
    console.warn("[groq] Falta GROQ_API_KEY. Devuelvo respuesta de respaldo.");
    return "¡Hola! Gracias por escribir. En un momento te atiendo. 🙂";
  }

  const body = {
    model: MODELO,
    messages: construirMensajes({ config, lead }),
    temperature: 0.7,
    max_tokens: 350,
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      console.error("[groq] Error API:", res.status, errTxt);
      return "Disculpa, tuve un detalle técnico. ¿Me repites por favor? 🙏";
    }

    const data = await res.json();
    const texto = data?.choices?.[0]?.message?.content;
    return texto?.trim() || "¿Me puedes dar un poco más de detalle? 🙂";
  } catch (err) {
    console.error("[groq] Excepción:", err.message);
    return "Disculpa, tuve un problema de conexión. ¿Me escribes de nuevo? 🙏";
  }
}
