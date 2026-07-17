// vision.js
// ---------------------------------------------------------------------------
// Le da "ojos" al bot. Cuando un cliente manda una foto de una propiedad que le
// gustó, esto la baja de WhatsApp y la analiza con un modelo de visión de Groq
// (Llama 4, misma API que el resto del bot, NO necesita otra API key).
// ---------------------------------------------------------------------------

const API_KEY = process.env.GROQ_API_KEY;
const MODELO_VISION = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
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
  if (!API_KEY || !imagen) return null;
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

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODELO_VISION,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url } },
            ],
          },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      console.error("[vision] Groq respondió", res.status);
      return null;
    }
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content?.trim();
    return txt || null;
  } catch (e) {
    console.error("[vision] Error analizando imagen:", e.message);
    return null;
  }
}

// Transcribe una nota de voz a texto con Groq Whisper (misma API key). `audio`
// puede ser { base64, mime } (nota de voz de WhatsApp) o { url } (adjunto de
// Messenger/IG). Devuelve el texto, o null si no se pudo.
export async function transcribirAudio(audio) {
  if (!API_KEY || !audio) return null;
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
      headers: { Authorization: `Bearer ${API_KEY}` }, // NO seteamos Content-Type: fetch pone el boundary
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
