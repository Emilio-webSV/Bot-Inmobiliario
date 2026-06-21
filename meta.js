// meta.js — Envío de mensajes por Facebook Messenger e Instagram.
// Ambos usan la misma Send API de Meta (Messenger Platform) con el token de la
// página. Si no hay token configurado, simula el envío (para pruebas).

const GRAPH = "https://graph.facebook.com/v19.0/me/messages";

async function postMeta(payload) {
  const token = process.env.PAGE_ACCESS_TOKEN;
  if (!token) {
    console.log("[meta] (simulado, falta PAGE_ACCESS_TOKEN):", JSON.stringify(payload.message));
    return { simulado: true };
  }
  try {
    const res = await fetch(`${GRAPH}?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("[meta] Error de envío:", res.status, t);
    }
    return res;
  } catch (err) {
    console.error("[meta] Falló el envío:", err.message);
    return { error: true };
  }
}

// Enviar texto a un usuario de Messenger o Instagram (id = PSID / IGSID)
export async function enviarMetaTexto(id, texto) {
  return postMeta({ recipient: { id }, message: { text: texto } });
}

// Enviar una imagen (con un texto opcional antes, como "caption")
export async function enviarMetaImagen(id, url, caption) {
  if (caption) await postMeta({ recipient: { id }, message: { text: caption } });
  return postMeta({
    recipient: { id },
    message: { attachment: { type: "image", payload: { url, is_reusable: true } } },
  });
}
