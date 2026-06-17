// lib/whatsapp.js
// ---------------------------------------------------------------------------
// Envío de mensajes por WhatsApp Cloud API.
// Necesitas (de Meta for Developers):
//   - WHATSAPP_TOKEN          (token de acceso)
//   - WHATSAPP_PHONE_ID       (Phone Number ID)
// El webhook de RECEPCIÓN está en server.js.
// ---------------------------------------------------------------------------

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

function baseUrl() {
  return `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`;
}

export async function enviarTexto(to, texto) {
  if (!TOKEN || !PHONE_ID) {
    console.warn(`[whatsapp] Faltan credenciales. (Simulado) -> ${to}: ${texto}`);
    return { simulado: true };
  }
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: texto },
  };
  return enviar(body, to);
}

export async function enviarImagen(to, urlImagen, caption = "") {
  if (!TOKEN || !PHONE_ID) {
    console.warn(`[whatsapp] (Simulado imagen) -> ${to}: ${urlImagen}`);
    return { simulado: true };
  }
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: urlImagen, caption },
  };
  return enviar(body, to);
}

async function enviar(body, to) {
  try {
    const res = await fetch(baseUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[whatsapp] Error envío:", res.status, err);
      return { error: true };
    }
    return await res.json();
  } catch (err) {
    console.error("[whatsapp] Excepción:", err.message);
    return { error: true };
  }
}
