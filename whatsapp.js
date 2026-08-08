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

export async function enviarUbicacion(to, lat, lng, nombre = "", direccion = "") {
  if (!TOKEN || !PHONE_ID) {
    console.warn(`[whatsapp] (Simulado ubicación) -> ${to}: ${lat},${lng}`);
    return { simulado: true };
  }
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "location",
    location: { latitude: Number(lat), longitude: Number(lng), name: nombre, address: direccion },
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

// Traduce los errores de Meta a algo que un humano entienda y pueda arreglar.
export function traducirErrorMeta(code, detalle = "") {
  const d = String(detalle).toLowerCase();
  if (code === 131030 || d.includes("not in allowed list"))
    return "Estás usando el NÚMERO DE PRUEBA de Meta: solo puede escribirle a números que hayas autorizado. Agrega ese número en Meta (WhatsApp → API Setup → 'To') o usa ya un número real verificado.";
  if (code === 132001 || d.includes("template name does not exist") || d.includes("template not found"))
    return "Esa plantilla NO existe o no está aprobada en Meta. Revisa el nombre exacto en WhatsApp Manager → Plantillas de mensajes (debe ir en minúsculas y con guiones bajos).";
  if (code === 132000 || d.includes("number of parameters"))
    return "La plantilla espera un número distinto de variables. Revisa cuántas {{1}}, {{2}} tiene en Meta.";
  if (code === 132005 || d.includes("hydrated_text"))
    return "El texto de la plantilla es demasiado largo o tiene formato no permitido.";
  if (code === 132012 || d.includes("parameter format"))
    return "El formato de las variables de la plantilla no coincide con lo aprobado en Meta.";
  if (code === 132015 || d.includes("template is paused"))
    return "Meta PAUSÓ esa plantilla por mala calidad (mucha gente la reportó o la bloqueó). Crea una nueva con otro texto.";
  if (code === 132016 || d.includes("template is disabled"))
    return "Meta DESHABILITÓ esa plantilla. Tienes que crear una nueva.";
  if (code === 131026 || d.includes("message undeliverable"))
    return "Ese número no tiene WhatsApp, o no puede recibir mensajes.";
  if (code === 131047 || d.includes("re-engagement"))
    return "Pasaron más de 24 h desde el último mensaje del cliente: solo se puede escribir con plantilla aprobada.";
  if (code === 131056 || d.includes("pair rate limit"))
    return "Le has escrito demasiadas veces seguidas a ese mismo número. Espera un rato.";
  if (code === 130429 || d.includes("rate limit"))
    return "Se alcanzó el límite de mensajes por hora de WhatsApp. Baja el ritmo de la campaña o espera.";
  if (code === 131031 || d.includes("account has been locked"))
    return "⚠️ La cuenta de WhatsApp fue restringida por Meta. Entra a WhatsApp Manager para ver el motivo.";
  if (code === 190 || d.includes("access token"))
    return "El token de WhatsApp expiró o es inválido. Genera uno permanente en Meta y actualiza WHATSAPP_TOKEN.";
  if (code === 100 && d.includes("phone_number_id"))
    return "El WHATSAPP_PHONE_ID no es correcto. Cópialo de nuevo desde Meta.";
  return detalle ? `WhatsApp rechazó el envío: ${detalle}` : "WhatsApp rechazó el envío (sin detalle)";
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
      const txt = await res.text();
      console.error("[whatsapp] Error envío:", res.status, txt);
      let code = null, detalle = "";
      try {
        const j = JSON.parse(txt);
        code = j?.error?.code ?? null;
        detalle = j?.error?.error_data?.details || j?.error?.message || "";
      } catch (e) { detalle = txt.slice(0, 160); }
      return { error: true, code, motivo: traducirErrorMeta(code, detalle), detalle };
    }
    // Solo contamos lo que Meta ACEPTÓ. Un mensaje rechazado no se cobra, así
    // que contarlo inflaría el gasto y nos haría tomar malas decisiones.
    import("./consumo.js").then((c) => c.contarMensaje(body, to)).catch(() => {});
    return await res.json();
  } catch (err) {
    console.error("[whatsapp] Excepción:", err.message);
    return { error: true, motivo: "No se pudo conectar con WhatsApp" };
  }
}

// ---------------------------------------------------------------------------
// Diagnóstico de campañas.
// Le pregunta a Meta qué plantillas tiene aprobadas esta cuenta, para que en el
// CRM salgan en una lista en vez de escribirlas a mano (y equivocarse).
// ---------------------------------------------------------------------------
export async function plantillasAprobadas() {
  const TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  const V = process.env.WHATSAPP_API_VERSION || "v21.0";
  if (!TOKEN || !PHONE_ID) {
    return { listo: false, motivo: "Falta configurar WHATSAPP_TOKEN o WHATSAPP_PHONE_ID.", plantillas: [] };
  }
  try {
    // 1) Del número sacamos a qué cuenta de WhatsApp (WABA) pertenece
    const rn = await fetch(`https://graph.facebook.com/${V}/${PHONE_ID}?fields=whatsapp_business_account_id,display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${TOKEN}` } });
    const dn = await rn.json();
    if (dn.error) return { listo: false, motivo: traducirErrorMeta(dn.error.code, dn.error.message), plantillas: [] };

    const waba = dn.whatsapp_business_account_id;
    if (!waba) return { listo: false, motivo: "No pude leer la cuenta de WhatsApp Business del número.", plantillas: [] };

    // 2) Y de la cuenta, sus plantillas
    const rt = await fetch(`https://graph.facebook.com/${V}/${waba}/message_templates?limit=100&fields=name,status,category,language,components`,
      { headers: { Authorization: `Bearer ${TOKEN}` } });
    const dt = await rt.json();
    if (dt.error) return { listo: false, motivo: traducirErrorMeta(dt.error.code, dt.error.message), plantillas: [] };

    const plantillas = (dt.data || []).map((p) => {
      const body = (p.components || []).find((c) => c.type === "BODY");
      const texto = body?.text || "";
      const huecos = (texto.match(/\{\{\d+\}\}/g) || []).length;
      return {
        nombre: p.name, estado: p.status, categoria: p.category, idioma: p.language,
        texto, huecos,
        sirve: p.status === "APPROVED" && huecos === 2,   // la campaña manda 2 datos
      };
    });
    return {
      listo: true,
      numero: dn.display_phone_number, nombreVerificado: dn.verified_name, calidad: dn.quality_rating,
      plantillas,
      aprobadas: plantillas.filter((p) => p.estado === "APPROVED").length,
      utiles: plantillas.filter((p) => p.sirve).length,
    };
  } catch (e) {
    return { listo: false, motivo: "No pude conectar con Meta: " + e.message, plantillas: [] };
  }
}
