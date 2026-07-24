// vision.js
// ---------------------------------------------------------------------------
// Le da "ojos" al bot. Cuando un cliente manda una foto de una propiedad que le
// gustó, esto la baja de WhatsApp y la analiza con un modelo de visión de Groq
// (Llama 4, misma API que el resto del bot, NO necesita otra API key).
// ---------------------------------------------------------------------------

// Proveedor de VISIÓN (mismo switch que el chat: IA_PROVIDER) + plan B automático.
const PROVIDER = (process.env.IA_PROVIDER || "groq").toLowerCase();
const GROQ_KEY = process.env.GROQ_API_KEY;

function makeVisCfg(nombre) {
  if (nombre === "gemini") {
    return {
      nombre: "gemini",
      apiKey: process.env.GEMINI_API_KEY,
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: process.env.GEMINI_VISION_MODEL || "gemini-3.5-flash-lite",
    };
  }
  return {
    nombre: "groq",
    apiKey: GROQ_KEY,
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
  };
}

const VIS_PRIMARY = PROVIDER === "gemini" ? "gemini" : "groq";
const VIS_SECONDARY = VIS_PRIMARY === "gemini" ? "groq" : "gemini";
const VIS_PROVIDERS = [makeVisCfg(VIS_PRIMARY), makeVisCfg(VIS_SECONDARY)].filter((c) => c.apiKey);

// Las NOTAS DE VOZ (transcripción) SIEMPRE usan Groq Whisper: es gratis, rapidísimo
// y sus límites van aparte (no tocan tu cuota de tokens del chat). Por eso conviene
// dejar tu GROQ_API_KEY puesta aunque el cerebro esté en Gemini.
const MODELO_STT = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const GRAPH = "https://graph.facebook.com/v19.0";

// Baja una imagen de WhatsApp. Son DOS pasos:
//  1) con el media_id, pedir a Meta la URL temporal del archivo
//  2) bajar los bytes de esa URL (con el mismo token)
// Devuelve { base64, mime } o null si algo falla (sin token, error, etc.)
export async function descargarMediaWhatsApp(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta.url) return null;

    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!binRes.ok) return null;
    const buf = Buffer.from(await binRes.arrayBuffer());

    // Límite de Groq: 20MB por imagen. Si pesa más, no la mandamos.
    if (buf.length > 19 * 1024 * 1024) return null;

    return { base64: buf.toString("base64"), mime: meta.mime_type || "image/jpeg" };
  } catch (e) {
    console.error("[vision] No se pudo bajar la imagen:", e.message);
    return null;
  }
}

// Llama al modelo de visión. `imagen` puede ser:
//   - { base64, mime }  (foto bajada de WhatsApp), o
//   - { url }           (foto con URL pública, ej. adjunto de Messenger/IG)
// Devuelve una descripción corta en español, "NO_PROPIEDAD", o null si falla.
export async function analizarImagen(imagen) {
  if (!VIS_PROVIDERS.length || !imagen) return null;
  const url = imagen.url
    ? imagen.url
    : `data:${imagen.mime || "image/jpeg"};base64,${imagen.base64}`;

  const prompt =
    "Eres un asesor inmobiliario. Te muestro la foto que un cliente envió de una " +
    "propiedad que le interesa. Descríbela MUY BREVE (máximo 2 frases) y SOLO con lo " +
    "relevante para bienes raíces: tipo (casa o departamento), estilo (moderno, " +
    "clásico, minimalista...), número de pisos si se ve, y características visibles " +
    "(jardín, alberca, balcón, terraza, mucha luz, doble altura, etc.). " +
    "NO inventes ubicación, colonia, precio ni metros: solo lo que se ve. " +
    "Si la imagen NO es de una propiedad o inmueble, responde: NO_PROPIEDAD: " +
    "seguido de MUY pocas palabras diciendo qué es (ej. 'NO_PROPIEDAD: un gatito', " +
    "'NO_PROPIEDAD: un meme gracioso', 'NO_PROPIEDAD: una selfie').";

  const payload = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
    max_tokens: 600,
    temperature: 0.3,
  };

  // Plan B: intenta el proveedor principal de visión y, si falla o se satura,
  // pasa al de respaldo. Si ninguno pudo, devuelve null (el bot sigue sin foto).
  for (const cfg of VIS_PROVIDERS) {
    try {
      const bodyVis = { model: cfg.model, ...payload };
      if (cfg.nombre === "gemini") bodyVis.reasoning_effort = "low"; // no gastar tokens "pensando"
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(bodyVis),
      });
      if (!res.ok) {
        console.error(`[vision] ${cfg.nombre} respondió`, res.status);
        continue; // probamos el proveedor de respaldo
      }
      const data = await res.json();
      const txt = data?.choices?.[0]?.message?.content?.trim();
      if (txt) {
        if (cfg.nombre !== VIS_PRIMARY) console.warn(`[vision] ⚠️ Foto analizada con proveedor de RESPALDO (${cfg.nombre}).`);
        return txt;
      }
    } catch (e) {
      console.error(`[vision] Error analizando imagen (${cfg.nombre}):`, e.message);
    }
  }
  return null;
}

// Transcribe una nota de voz a texto con Groq Whisper (misma API key). `audio`
// puede ser { base64, mime } (nota de voz de WhatsApp) o { url } (adjunto de
// Messenger/IG). Devuelve el texto, o null si no se pudo.
export async function transcribirAudio(audio) {
  if (!GROQ_KEY || !audio) return null;
  try {
    let buffer, mime;
    if (audio.url) {
      const r = await fetch(audio.url);
      if (!r.ok) return null;
      buffer = Buffer.from(await r.arrayBuffer());
      mime = r.headers.get("content-type") || "audio/ogg";
    } else {
      buffer = Buffer.from(audio.base64, "base64");
      mime = audio.mime || "audio/ogg";
    }
    // Groq acepta hasta 25MB por archivo.
    if (buffer.length > 24 * 1024 * 1024) return null;

    // Le ponemos una extensión coherente con el tipo (las notas de WhatsApp son ogg).
    const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a"
      : mime.includes("mpeg") || mime.includes("mp3") ? "mp3"
      : mime.includes("wav") ? "wav"
      : mime.includes("webm") ? "webm"
      : "ogg";

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
    form.append("model", MODELO_STT);
    form.append("language", "es"); // mejora precisión y velocidad
    form.append("response_format", "json");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` }, // NO seteamos Content-Type: fetch pone el boundary
      body: form,
    });
    if (!res.ok) {
      console.error("[audio] Groq respondió", res.status);
      return null;
    }
    const data = await res.json();
    const txt = (data.text || "").trim();
    return txt || null;
  } catch (e) {
    console.error("[audio] Error transcribiendo:", e.message);
    return null;
  }
}
