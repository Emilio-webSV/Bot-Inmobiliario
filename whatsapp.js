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

// ¿Estamos dentro de la ventana de 24 h desde el último mensaje del cliente?
// Dentro de esa ventana, WhatsApp deja mandar texto libre (y es GRATIS).
// Fuera de ella, Meta SOLO acepta plantillas aprobadas.
export function dentroVentana24h(isoUltimoMensajeCliente) {
  if (!isoUltimoMensajeCliente) return false;
  const t = new Date(isoUltimoMensajeCliente).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t < 24 * 60 * 60 * 1000;
}

// Envía una PLANTILLA aprobada por Meta (lo único permitido fuera de las 24 h).
// `params` son los valores que rellenan las variables {{1}}, {{2}}... del cuerpo.
export async function enviarPlantilla(to, nombrePlantilla, params = [], idioma = process.env.WA_TPL_IDIOMA || "es_MX") {
  if (!TOKEN || !PHONE_ID) {
    console.warn(`[whatsapp] (Simulado plantilla "${nombrePlantilla}") -> ${to}: ${params.join(" | ")}`);
    return { simulado: true };
  }
  // Meta RECHAZA parámetros con saltos de línea o espacios de más: los limpiamos.
  const limpios = params.map((p) => String(p).replace(/\s*\n\s*/g, " · ").replace(/\s{2,}/g, " ").trim());
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: nombrePlantilla,
      language: { code: idioma },
      ...(limpios.length
        ? { components: [{ type: "body", parameters: limpios.map((p) => ({ type: "text", text: p })) }] }
        : {}),
    },
  };
  return enviar(body, to);
}

// Manda texto normal y, si WhatsApp lo rechaza (típicamente por estar fuera de
// la ventana de 24 h), reintenta con la plantilla aprobada. Así el mensaje llega
// igual sin que tengamos que adivinar si la ventana sigue abierta.
export async function enviarTextoOPlantilla(to, texto, plantilla, params = []) {
  const r = await enviarTexto(to, texto);
  if (r && r.error && plantilla) {
    console.warn(`[whatsapp] Texto rechazado; reintento con plantilla "${plantilla}".`);
    return enviarPlantilla(to, plantilla, params);
  }
  return r;
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

export async function enviarVideo(to, urlVideo, caption = "") {
  if (!TOKEN || !PHONE_ID) {
    console.warn(`[whatsapp] (Simulado video) -> ${to}: ${urlVideo}`);
    return { simulado: true };
  }
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "video",
    video: { link: urlVideo, caption },
  };
  return enviar(body, to);
}

export async function enviarDocumento(to, urlDoc, filename = "archivo", caption = "") {
  if (!TOKEN || !PHONE_ID) {
    console.warn(`[whatsapp] (Simulado documento) -> ${to}: ${urlDoc}`);
    return { simulado: true };
  }
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { link: urlDoc, filename, caption },
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
