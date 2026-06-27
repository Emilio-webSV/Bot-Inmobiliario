// vision.js
// ---------------------------------------------------------------------------
// Le da "ojos" al bot. Cuando un cliente manda una foto de una propiedad que le
// gustó, esto la baja de WhatsApp y la analiza con un modelo de visión de Groq
// (Llama 4, misma API que el resto del bot, NO necesita otra API key).
// ---------------------------------------------------------------------------

const API_KEY = process.env.GROQ_API_KEY;
const MODELO_VISION = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
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
    "Si la imagen NO es de una propiedad o inmueble, responde EXACTAMENTE: NO_PROPIEDAD";

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
