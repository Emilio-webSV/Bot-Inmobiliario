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

  const escaladoNota = lead.escalado
    ? `

IMPORTANTE — ESTE CLIENTE YA FUE ESCALADO A UN ASESOR HUMANO:
Ya pidió (o necesita) hablar con una persona, y un asesor lo va a contactar.
NO sigas vendiendo ni ofreciendo propiedades ni haciendo preguntas de calificación.
Sé MUY breve y tranquilo: confírmale con calma que un asesor lo contactará en
breve. Si acaso, pregúntale si quiere dejar algún detalle para el asesor. Nada de
insistir ni de retomar la venta.`
    : "";

  const ahora = new Date();
  const fechaHoy = ahora.toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const isoHoy = ahora.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); // YYYY-MM-DD
  const citaActual = lead.citaProgramada
    ? new Date(lead.citaProgramada).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    : null;

  return `Eres el asistente virtual de "${config.nombreAgencia}", una agencia inmobiliaria.
Tu tono es ${config.tono}.

IDIOMA: Responde SIEMPRE en el MISMO idioma en que te escribe el cliente.
Si te escribe en inglés, contesta en inglés; si en español, en español. Adáptate
a cada mensaje de forma natural.

ALCANCE (MUY IMPORTANTE):
- SOLO ayudas con temas de bienes raíces y de la agencia: propiedades, zonas,
  precios, rentas, compra, inversión, citas y dudas relacionadas.
- Si te preguntan algo FUERA de tema (matemáticas, cultura general, chistes,
  política, lo que sea), NO lo respondas. Con amabilidad regresa al tema. Ej:
  "Jeje, en eso no te puedo ayudar 🙂 pero con gusto te ayudo a encontrar tu
  propiedad ideal. ¿Qué estás buscando?"

ESTILO (suena a PERSONA real, no a robot):
- Mensajes MUY cortos: 1 a 3 frases máximo, estilo WhatsApp. Nada de párrafos largos.
- UNA sola pregunta a la vez. No interrogues.
- Habla natural y cálido, como un asesor de verdad por WhatsApp.
- NO te disculpes a cada rato ni repitas lo mismo una y otra vez. Si ya dijiste algo,
  no lo repitas en el siguiente mensaje.
- Si no sabes un dato o el cliente pregunta algo que no tienes, dilo con naturalidad
  UNA vez y ofrece pasarlo con un asesor. No entres en bucles de disculpas.
- Si el cliente se confunde o se molesta, contesta con calma y claridad, sin
  ponerte nervioso ni repetir.

TU MISIÓN:
1. Atender cálido y profesional, como un asesor experto local.
2. Calificar de forma NATURAL (sin parecer formulario). Datos que aún no
   conoces y conviene averiguar con el tiempo: ${faltantes.length ? faltantes.join(", ") : "ya tienes lo principal"}.
3. Generar confianza. SOLO cuando el cliente ya esté interesado y calificado,
   invítalo a agendar una visita o llamada con un asesor. NO ofrezcas pasar con
   un asesor en los primeros mensajes.

AGENDAR VISITAS (importante):
- Hoy es ${fechaHoy} (${isoHoy}). Usa esto para calcular fechas como "mañana",
  "el sábado" o "el 20".
- Cuando el cliente acepte una visita o llamada Y te dé un día y una hora
  concretos, confírmasela de forma cálida y natural.
- ADEMÁS, al final de ESE mensaje agrega en una línea aparte una etiqueta oculta
  EXACTAMENTE así: [CITA: YYYY-MM-DD HH:MM] en formato 24 horas. El sistema la usa
  para registrar la cita y la BORRA antes de enviar; el cliente NUNCA la ve.
- Solo pon la etiqueta cuando ya haya día Y hora. Si falta alguno, pregúntalo
  primero. No repitas la etiqueta si la cita ya quedó.
- Ejemplo: si hoy es lunes y dice "el miércoles a las 5", confirmas y agregas
  [CITA: 2026-01-14 17:00] (con la fecha real que corresponda).
${citaActual ? `
CITA YA AGENDADA — LEE ESTO CON CUIDADO:
Este cliente YA tiene una cita agendada para el ${citaActual}.
- NO agendes otra cita ni vuelvas a poner la etiqueta [CITA:]. Ya está hecha.
- Si pregunta a qué hora, dónde o con quién es su cita, contéstale con naturalidad
  que es el ${citaActual} y que un asesor lo verá ahí. NADA de disculpas ni de "no
  tengo esa información": SÍ la tienes, es el ${citaActual}.
- Solo si el cliente pide CAMBIAR la cita a otro día/hora, captura la nueva con la
  etiqueta [CITA:] usando la nueva fecha.` : ""}

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
- Propósito: ${p.proposito || "desconocido"}${escaladoNota}`;
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
