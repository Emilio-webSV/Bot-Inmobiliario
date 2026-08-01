// email.js
// ---------------------------------------------------------------------------
// El bot también manda correos. Es el respaldo perfecto de WhatsApp: cuando
// pasan más de 24 h y Meta ya no deja escribir libre, el correo sí llega.
//
// Variables (Railway -> Variables):
//   RESEND_API_KEY   -> clave de resend.com (gratis hasta 3,000 correos/mes)
//   EMAIL_FROM       -> remitente, ej. "Casa Linda <hola@tudominio.com>"
//                       Si no tienes dominio propio, usa: onboarding@resend.dev
// Sin estas variables, el sistema simplemente no manda correos (no truena).
// ---------------------------------------------------------------------------

const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || "onboarding@resend.dev";
const ENDPOINT = "https://api.resend.com/emails";

export function correoActivo() {
  return Boolean(API_KEY);
}

// ¿El texto trae un correo válido? Devuelve el correo o null.
export function extraerEmail(texto) {
  const m = String(texto || "").match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/);
  if (!m) return null;
  const mail = m[0].toLowerCase().replace(/[.,;:)]+$/, "");
  return /^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/.test(mail) ? mail : null;
}

// Plantilla HTML con la marca de la agencia. Simple, limpia y se ve bien en
// cualquier cliente de correo (nada de CSS moderno que Outlook rompa).
export function plantillaHTML({ agencia, logoUrl, titulo, saludo, cuerpo, cta, ctaUrl, pie, color }) {
  const acento = color || "#2E8B6F";
  const esc = (t) => String(t || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const parrafos = String(cuerpo || "").split("\n").filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3F4B55">${esc(p)}</p>`).join("");
  const botones = cta && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="border-radius:8px;background:${acento}">
       <a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${esc(cta)}</a>
       </td></tr></table>` : "";
  const cabecera = logoUrl
    ? `<img src="${logoUrl}" alt="${esc(agencia)}" style="max-height:44px;max-width:190px">`
    : `<div style="font-size:20px;font-weight:700;color:#16232E">${esc(agencia)}</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F7F6;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7F6;padding:28px 12px">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)">
   <tr><td style="padding:24px 30px 0">${cabecera}</td></tr>
   <tr><td style="padding:20px 30px 0">
     ${titulo ? `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#16232E">${esc(titulo)}</h1>` : ""}
     ${saludo ? `<p style="margin:0 0 16px;font-size:15px;color:#3F4B55">${esc(saludo)}</p>` : ""}
     ${parrafos}${botones}
   </td></tr>
   <tr><td style="padding:8px 30px 26px">
     <hr style="border:none;border-top:1px solid #E4E7EC;margin:18px 0">
     <p style="margin:0;font-size:12.5px;line-height:1.6;color:#8A97A3">${esc(pie || `${agencia} — gracias por tu interés.`)}</p>
   </td></tr>
  </table>
  <p style="margin:16px 0 0;font-size:11.5px;color:#9AA8B2">Si no esperabas este correo, puedes ignorarlo.</p>
 </td></tr>
</table></body></html>`;
}

// Envía el correo. Devuelve { ok } o { error }.
export async function enviarCorreo({ para, asunto, html, texto, responderA }) {
  if (!API_KEY) {
    console.warn(`[email] Sin RESEND_API_KEY. (Simulado) -> ${para}: ${asunto}`);
    return { simulado: true };
  }
  if (!para || !asunto) return { error: true, motivo: "Faltan destinatario o asunto" };
  try {
    const body = { from: FROM, to: [para], subject: asunto };
    if (html) body.html = html;
    if (texto) body.text = texto;
    if (responderA) body.reply_to = responderA;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[email] Error al enviar:", res.status, err);
      return { error: true, motivo: res.status === 403 ? "El remitente no está verificado en Resend" : "El servicio rechazó el envío" };
    }
    const data = await res.json();
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("[email] Excepción:", e.message);
    return { error: true, motivo: e.message };
  }
}
