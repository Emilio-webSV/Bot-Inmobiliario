// gemini.js
// ---------------------------------------------------------------------------
// Cerebro del bot — corriendo sobre GROQ (gratis, sin tarjeta, rapidísimo).
// El archivo se sigue llamando "gemini.js" a propósito (no toques server.js).
//
// Variables (Railway -> Variables):
//   GROQ_API_KEY  -> tu clave de https://console.groq.com/keys
//   GROQ_MODEL    -> opcional. Por defecto: llama-3.3-70b-versatile
// ---------------------------------------------------------------------------

import { contextoZona } from "./zones.js";

const MODELO = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const API_KEY = process.env.GROQ_API_KEY;
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

function construirSystemPrompt({ config, lead, propiedadesCtx }) {
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

ALCANCE (MUY IMPORTANTE):
- SOLO ayudas con temas de bienes raíces y de la agencia: propiedades, zonas,
  precios, rentas, compra, inversión, citas y dudas relacionadas.
- Si te preguntan algo FUERA de tema (matemáticas, cultura general, chistes,
  política, lo que sea), NO lo respondas. Con amabilidad regresa al tema. Ej:
  "Jeje, en eso no te puedo ayudar 🙂 pero con gusto te ayudo a encontrar tu
  propiedad ideal. ¿Qué estás buscando?"

ESTILO:
- Mensajes MUY cortos: 1 a 3 frases máximo, estilo WhatsApp. Nada de párrafos largos.
- UNA sola pregunta a la vez. No interrogues.

TU MISIÓN:
1. Atender cálido y profesional, como un asesor experto local.
2. Calificar de forma NATURAL (sin parecer formulario). Datos que aún no
   conoces y conviene averiguar con el tiempo: ${faltantes.length ? faltantes.join(", ") : "ya tienes lo principal"}.
3. Generar confianza. SOLO cuando el cliente ya esté interesado y calificado,
   invítalo a agendar una visita o llamada con un asesor. NO ofrezcas pasar con
   un asesor en los primeros mensajes.

REGLAS:
- NUNCA inventes zonas, colonias, propiedades, precios ni direcciones. Si no
  tienes el dato, pregunta o di que un asesor lo confirmará.
- ZONAS QUE MANEJA LA AGENCIA: Polanco, Lomas/Chapultepec, Reforma, Condesa/Roma,
  Del Valle, Santa Fe. Trabaja SOLO con estas. Si el cliente menciona otra zona,
  o la escribe con errores (ej. "planc0", "polaco"), NO inventes una colonia ni
  su descripción: pregúntale amablemente a cuál de las zonas que manejas se refiere
  (ej. "¿Te refieres a Polanco? 🙂").
- Si el cliente da un dato (presupuesto, zona, etc.), reconócelo breve y sigue.
- Usa los datos de zona para sonar como experto local, sin presumir ni soltar
  todo de golpe.

${zonaCtx ? "CONTEXTO DE ZONA:\n" + zonaCtx : ""}

${propiedadesCtx || ""}

DATOS QUE YA SABES DEL CLIENTE:
- Nombre: ${lead.nombre || "aún no lo sabes"}
- Presupuesto: ${p.presupuesto ? "$" + p.presupuesto.toLocaleString("es-MX") + " MXN" : "desconocido"}
- Zona: ${p.zona || "desconocida"}
- Recámaras: ${p.recamaras || "desconocidas"}
- Propósito: ${p.proposito || "desconocido"}`;
}

function construirMensajes({ config, lead, propiedadesCtx }) {
  const mensajes = [
    { role: "system", content: construirSystemPrompt({ config, lead, propiedadesCtx }) },
  ];
  for (const h of lead.historial || []) {
    mensajes.push({
      role: h.rol === "bot" ? "assistant" : "user",
      content: h.texto,
    });
  }
  return mensajes;
}

export async function generarRespuesta({ config, lead, propiedadesCtx }) {
  if (!API_KEY) {
    console.warn("[groq] Falta GROQ_API_KEY. Devuelvo respuesta de respaldo.");
    return "¡Hola! Gracias por escribir. En un momento te atiendo. 🙂";
  }

  const body = {
    model: MODELO,
    messages: construirMensajes({ config, lead, propiedadesCtx }),
    temperature: 0.6,
    max_tokens: 220,
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
