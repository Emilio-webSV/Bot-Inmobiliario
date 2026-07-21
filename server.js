// server.js
// ---------------------------------------------------------------------------
// Servidor principal del bot inmobiliario.
//  - Recibe mensajes de WhatsApp (webhook)
//  - Los procesa: memoria -> perfil -> frustración -> scoring -> Gemini
//  - Responde por WhatsApp y asigna agente
//  - Sirve el dashboard y su API
// ---------------------------------------------------------------------------

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import {
  loadDB, upsertLead, pushHistorial, getLead, getAllLeads, getConfig, saveDB, deleteLead,
  getProperties, getProperty, createProperty, updateProperty, deleteProperty,
  getAgents, updateConfig, createAgent, updateAgent, deleteAgent,
  getZones, createZone, updateZone, deleteZone, zonaEnUso, seedZonasDemo,
} from "./store.js";
import { generarRespuesta } from "./gemini.js";
import { enviarTexto, enviarImagen, enviarTextoOPlantilla } from "./whatsapp.js";
import { enviarTextoCanal, enviarImagenCanal, enviarVideoCanal } from "./canales.js";
import { descargarMediaWhatsApp, analizarImagen, transcribirAudio } from "./vision.js";
import { extraerPerfil, calcularScore } from "./scoring.js";
import { analizarFrustracion } from "./frustration.js";
import { asignarAgente, seedAgentesDemo } from "./agents.js";
import { buscarPropiedades, contextoPropiedades, marcarEnviada, seedPropiedadesDemo } from "./properties.js";
import { iniciarCronJobs, enviarReporteAhora, revisarLeadsCalientesAhora } from "./followups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "15mb" })); // 15mb: permite recibir fotos en base64

// Carpeta donde se guardan las fotos que sube el usuario (en el disco persistente).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Se sirven PÚBLICAS (sin contraseña) para que WhatsApp pueda descargarlas.
app.use("/uploads", express.static(UPLOADS_DIR));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "cambia_esto";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // protección básica del panel

// ---------------------------------------------------------------------------
// CANDADO: TODA la información del CRM (rutas /api) exige contraseña.
// El webhook (/webhook) NO pasa por aquí (lo llama Meta, va aparte).
// Las páginas /dashboard y /admin se sirven, pero sin contraseña no muestran datos.
// ---------------------------------------------------------------------------
app.use("/api", (req, res, next) => {
  const pass = req.headers["x-admin-password"] || req.query.pass;
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
});

// Subir una foto (llega en base64 desde el navegador). La guarda en el disco y
// devuelve su URL pública, lista para usarse en una propiedad.
app.post("/api/upload", (req, res) => {
  try {
    const data = req.body?.data || "";
    const m = data.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
    const mime = m ? m[1] : "image/jpeg";
    const b64 = m ? m[2] : data.replace(/^data:.*;base64,/, "");
    if (!b64) return res.status(400).json({ error: "Sin imagen" });
    const buf = Buffer.from(b64, "base64");
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: "Imagen muy pesada (máx 12MB)" });
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
    const nombre = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, nombre), buf);
    const base = process.env.PUBLIC_URL || `https://${req.get("host")}`;
    res.json({ url: `${base}/uploads/${nombre}` });
  } catch (e) {
    console.error("[upload]", e.message);
    res.status(500).json({ error: "No se pudo subir la imagen" });
  }
});

// ---------------------------------------------------------------------------
// 1) VERIFICACIÓN DEL WEBHOOK (Meta toca la puerta una vez al conectar)
// ---------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] Verificado correctamente ✅");
    return res.status(200).send(challenge);
  }
  console.warn("[webhook] Falló la verificación (revisa tu VERIFY_TOKEN)");
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// 2) RECEPCIÓN DE MENSAJES (aquí llega cada WhatsApp del cliente)
// ---------------------------------------------------------------------------

// Anti-duplicados: Meta a veces manda el mismo mensaje dos veces (reintentos o
// doble suscripción). Guardamos los IDs ya procesados y los ignoramos si repiten.
const idsProcesados = new Map(); // id -> timestamp
function mensajeDuplicado(id) {
  if (!id) return false;
  const ahora = Date.now();
  // Limpieza: quita IDs de hace más de 10 min para no crecer sin límite.
  if (idsProcesados.size > 1000) {
    for (const [k, t] of idsProcesados) if (ahora - t > 10 * 60 * 1000) idsProcesados.delete(k);
  }
  if (idsProcesados.has(id)) return true; // ya lo vimos
  idsProcesados.set(id, ahora);
  return false;
}

app.post("/webhook", async (req, res) => {
  // Respondemos 200 de inmediato para que Meta no reintente
  res.sendStatus(200);

  try {
    const body = req.body;
    const obj = body?.object;

    // --- WhatsApp ---
    if (obj === "whatsapp_business_account" || body?.entry?.[0]?.changes) {
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      const mensaje = value?.messages?.[0];
      if (!mensaje) return;
      if (mensajeDuplicado(mensaje.id)) return; // ya lo procesamos, no repitas
      const nombre = value?.contacts?.[0]?.profile?.name || null;
      if (mensaje.type === "image") {
        // El cliente mandó una foto: la bajamos y el bot la "ve".
        const media = await descargarMediaWhatsApp(mensaje.image?.id);
        await manejarImagen(mensaje.from, nombre, "whatsapp", media, mensaje.image?.caption);
        return;
      }
      if (mensaje.type === "audio") {
        // El cliente mandó una nota de voz: la bajamos y el bot la "escucha".
        const media = await descargarMediaWhatsApp(mensaje.audio?.id);
        await manejarAudio(mensaje.from, nombre, "whatsapp", media);
        return;
      }
      if (mensaje.type === "sticker") {
        // El cliente mandó un sticker: lo bajamos para verlo en el CRM y el bot reacciona.
        const media = await descargarMediaWhatsApp(mensaje.sticker?.id);
        const url = guardarMediaLocal(media);
        const tok = url ? `[img:${url}] ` : "";
        await procesarMensaje(mensaje.from, `😄 ${tok}(El cliente te mandó un sticker)`, nombre, "whatsapp");
        return;
      }
      if (mensaje.type !== "text") {
        await manejarNoTexto(mensaje.from, nombre, "whatsapp"); // ubicación, contacto, etc.
        return;
      }
      await procesarMensaje(mensaje.from, mensaje.text.body, nombre, "whatsapp");
      return;
    }

    // --- Facebook Messenger o Instagram ---
    if (obj === "page" || obj === "instagram" || body?.entry?.[0]?.messaging) {
      const canal = obj === "instagram" ? "instagram" : "messenger";
      for (const e of body?.entry || []) {
        for (const ev of e.messaging || []) {
          const msg = ev.message;
          if (!msg || msg.is_echo) continue; // ignora echos
          if (mensajeDuplicado(msg.mid)) continue; // duplicado, ya lo procesamos
          const remitente = ev.sender?.id;
          if (!remitente) continue;
          if (msg.text) await procesarMensaje(remitente, msg.text, null, canal);
          else {
            const img = (msg.attachments || []).find((a) => a.type === "image" && a.payload?.url);
            const aud = (msg.attachments || []).find((a) => a.type === "audio" && a.payload?.url);
            if (aud) await manejarAudio(remitente, null, canal, { url: aud.payload.url });
            else if (img) await manejarImagen(remitente, null, canal, { url: img.payload.url }, null);
            else await manejarNoTexto(remitente, null, canal); // otro adjunto
          }
        }
      }
      return;
    }
  } catch (err) {
    console.error("[webhook] Error procesando mensaje:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Lógica central: qué hace el bot con cada mensaje entrante
// ---------------------------------------------------------------------------
// El cliente mandó algo que no es texto (imagen, audio, sticker...). El bot
// todavía no "ve" imágenes, así que responde con gracia en vez de quedarse callado.
async function manejarNoTexto(remitente, nombre, canal) {
  let lead = getLead(remitente);
  if (!lead) lead = upsertLead(remitente, { nombre, canal });
  pushHistorial(remitente, "user", "[imagen/archivo recibido]");
  if (lead.humanoEnControl) return; // si un asesor ya está atendiendo, no respondas
  const msg = "¡Gracias! 😄 Oye, mejor cuéntame qué andas buscando —zona, presupuesto, recámaras— y te encuentro algo padre. 🏠";
  await enviarTextoCanal(canal, remitente, msg);
  pushHistorial(remitente, "bot", msg);
}

// El cliente mandó una NOTA DE VOZ. La transcribimos con Whisper y la tratamos
// como si la hubiera escrito (el bot responde a lo que dijo). Si no se pudo
// escuchar, responde con gracia.
async function manejarAudio(remitente, nombre, canal, audio) {
  let lead = getLead(remitente);
  if (!lead) lead = upsertLead(remitente, { nombre, canal });
  if (lead.humanoEnControl) {
    pushHistorial(remitente, "user", "[🎙️ nota de voz]");
    return; // un asesor ya está atendiendo
  }

  const texto = audio ? await transcribirAudio(audio) : null;

  if (texto && texto.trim().length > 1) {
    // El bot "escuchó" la nota. La pasamos a su cerebro como mensaje del cliente,
    // con una marca al inicio para que en el CRM se vea que fue nota de voz.
    await procesarMensaje(remitente, `🎙️ ${texto.trim()}`, nombre, canal);
    return;
  }

  // No se pudo transcribir: respuesta con gracia.
  pushHistorial(remitente, "user", "[🎙️ nota de voz]");
  const msg = "¡Gracias por tu nota de voz! 🙂 No alcancé a escucharla bien. ¿Me cuentas por aquí qué estás buscando (zona, presupuesto, recámaras)?";
  await enviarTextoCanal(canal, remitente, msg);
  pushHistorial(remitente, "bot", msg);
}
// Guarda un archivo que llegó del cliente (foto/sticker) en el disco, para poder
// mostrarlo en el CRM. Devuelve una URL relativa (/uploads/xxx) o null.
function guardarMediaLocal(imagen) {
  try {
    if (imagen?.url) return imagen.url; // Messenger/Instagram ya dan URL pública
    if (imagen?.base64) {
      const mime = imagen.mime || "image/jpeg";
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
      const nombre = `rx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, nombre), Buffer.from(imagen.base64, "base64"));
      return `/uploads/${nombre}`;
    }
  } catch (e) { console.error("[media] No se pudo guardar:", e.message); }
  return null;
}

async function manejarImagen(remitente, nombre, canal, imagen, caption) {
  let lead = getLead(remitente);
  if (!lead) lead = upsertLead(remitente, { nombre, canal });

  const imgUrl = guardarMediaLocal(imagen);      // la guardamos para verla en el CRM
  const tok = imgUrl ? `[img:${imgUrl}] ` : "";

  if (lead.humanoEnControl) {
    // Un asesor ya está atendiendo: el bot NO responde, pero SÍ registra la imagen
    // para que el humano la VEA en el panel (antes se perdía).
    pushHistorial(remitente, "user", `📷 ${tok}${caption || ""}`.trim());
    return;
  }

  const desc = imagen ? await analizarImagen(imagen) : null;

  if (desc && /NO_PROPIEDAD/i.test(desc)) {
    const quees = desc.replace(/.*NO_PROPIEDAD:?\s*/i, "").trim() || "algo";
    const texto = `📷 ${tok}(El cliente te mandó una foto que NO es una propiedad; se ve: ${quees}. Reacciona MUY breve con buena onda y de inmediato regresa la conversación a ayudarlo a encontrar una propiedad.)`;
    await procesarMensaje(remitente, texto, nombre, canal);
    return;
  }

  if (desc) {
    const cap = caption ? ` El cliente escribió junto a la foto: "${caption}".` : "";
    const texto = `📷 ${tok}(El cliente te envió una foto de una propiedad que le interesa. En la foto se ve: ${desc}.${cap})`;
    await procesarMensaje(remitente, texto, nombre, canal);
    return;
  }

  // No se pudo analizar, pero si la guardamos igual la mostramos en el CRM.
  pushHistorial(remitente, "user", `📷 ${tok}${caption || ""}`.trim());
  const msg = "¡Gracias por la foto! 🙂 Se me complicó abrirla, pero cuéntame qué estás buscando —zona, presupuesto, recámaras— y te ayudo igual. 🏠";
  await enviarTextoCanal(canal, remitente, msg);
  pushHistorial(remitente, "bot", msg);
}

// Detecta la etiqueta oculta [CITA: YYYY-MM-DD HH:MM] que pone el bot al agendar.
// Devuelve la fecha en ISO y el texto ya sin la etiqueta, o null si no hay cita.
function extraerCita(texto) {
  const m = texto.match(/\[CITA:\s*(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})\]/i);
  if (!m) return null;
  const hh = m[2].length === 4 ? "0" + m[2] : m[2];
  const d = new Date(`${m[1]}T${hh}:00-06:00`); // hora de Ciudad de México (UTC-6)
  const textoLimpio = texto.replace(m[0], "").trim();
  if (isNaN(d.getTime())) return { iso: null, textoLimpio };

  // Red de seguridad: aunque el bot lo intente, NO registramos citas absurdas.
  // (1) nada en el pasado. (2) solo dentro del horario de visitas (L-S, 9:00-19:00).
  if (d.getTime() < Date.now() - 5 * 60 * 1000) return { iso: null, textoLimpio };
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City", weekday: "short", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const hora = parseInt(partes.find((p) => p.type === "hour").value, 10);
  const dia = partes.find((p) => p.type === "weekday").value; // Sun, Mon, ...
  if (dia === "Sun" || hora < 9 || hora > 19) return { iso: null, textoLimpio };

  return { iso: d.toISOString(), textoLimpio };
}

// Detecta la etiqueta oculta [NOMBRE: ...] que el bot agrega cuando el cliente
// dice su nombre. Devuelve el nombre y el texto ya sin la etiqueta.
function extraerNombre(texto) {
  const m = texto.match(/\[NOMBRE:\s*([^\]]+)\]/i);
  if (!m) return null;
  const nombre = m[1].trim().replace(/["']/g, "").slice(0, 40);
  return { nombre, textoLimpio: texto.replace(m[0], "").trim() };
}

// Arma un link de "Agregar a Google Calendar" (un toque y la cita queda en el
// calendario del asesor/dueño). No requiere conectar cuentas: es una URL.
function gcalLink(iso, titulo, detalles) {
  const start = new Date(iso);
  const end = new Date(start.getTime() + 60 * 60 * 1000); // dura 1 hora por defecto
  const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: titulo,
    dates: `${f(start)}/${f(end)}`,
    details: detalles || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function procesarMensaje(telefono, texto, nombrePerfil, canal = "whatsapp") {
  const config = getConfig();

  // Asegura que el lead exista y guarda el nombre del perfil y el canal de origen.
  // También registramos CUÁNDO escribió el cliente: mientras estemos dentro de las
  // 24 h siguientes, WhatsApp permite mandarle texto libre (y sale gratis).
  let lead = getLead(telefono);
  const ahoraISO = new Date().toISOString();
  if (!lead) {
    lead = upsertLead(telefono, { nombre: nombrePerfil, canal, ultimoMsgCliente: ahoraISO });
  } else {
    lead = upsertLead(telefono, {
      ultimoMsgCliente: ahoraISO,
      ...(!lead.nombre && nombrePerfil ? { nombre: nombrePerfil } : {}),
    });
  }

  // Guarda el mensaje del cliente en el historial
  pushHistorial(telefono, "user", texto);

  // 1) ¿Está frustrado? -> escalar a humano y no seguir con el bot
  const fr = analizarFrustracion(texto);

  // Si estaba escalado pero ahora escribe tranquilo (ej. "vamos a agendar"),
  // lo des-escalamos para que el bot vuelva a ayudarlo con normalidad.
  if (lead.escalado && !fr.frustrado) {
    lead = upsertLead(telefono, { escalado: false });
  }

  if (fr.frustrado) {
    lead = upsertLead(telefono, { escalado: true, temperatura: "caliente" });
    const agente = lead.agenteAsignado || asignarAgente(lead.perfil.zona);
    if (agente && !lead.agenteAsignado) {
      lead = upsertLead(telefono, { agenteAsignado: agente.id });
    }
    const respuesta = "Entiendo perfectamente 🙏 Voy a pasar tu caso ahora mismo con uno de nuestros asesores para atenderte personalmente. En un momento te contactan.";
    await enviarTextoCanal(canal, telefono, respuesta);
    pushHistorial(telefono, "bot", respuesta);

    // Avisar al dueño / agente
    const dueno = process.env.OWNER_PHONE;
    if (dueno) {
      await enviarTextoOPlantilla(dueno, `⚠️ Cliente requiere atención humana\n${lead.nombre || telefono}\nÚltimo mensaje: "${texto}"`, process.env.WA_TPL_ALERTA, ["Cliente requiere atencion humana", `${lead.nombre || telefono}: ${texto}`]);
    }
    return;
  }

  // 2) Si un humano ya tomó el control, el bot NO responde (solo registra)
  if (lead.humanoEnControl) {
    console.log(`[bot] ${telefono} en control humano, no respondo.`);
    return;
  }

  // 3) Actualiza el perfil con lo que se pueda extraer del mensaje
  const perfilNuevo = extraerPerfil(texto, lead.perfil);
  lead = upsertLead(telefono, { perfil: perfilNuevo });

  // 4) Propiedades reales de SU zona que le quedan. `nuevas` = hasta 3 opciones
  //    que aún no le hemos mostrado (se le mandan sus fotos). El bot habla justo
  //    de las que manda, no de otras.
  const matches = buscarPropiedades(lead, 3);
  const yaEnviadas = lead.propiedadesEnviadas || [];
  const nuevas = matches.filter((m) => !yaEnviadas.includes(m.id) && (m.imagenes || []).length).slice(0, 3);
  const propiedadesCtx = contextoPropiedades(matches, nuevas);

  // 5) Genera respuesta con el bot (ya conoce las propiedades reales)
  let respuesta = await generarRespuesta({ config, lead, propiedadesCtx });

  // 5b) ¿El bot agendó una cita? Detecta la etiqueta oculta [CITA: YYYY-MM-DD HH:MM]
  const cita = extraerCita(respuesta);
  if (cita) {
    respuesta = cita.textoLimpio; // quita la etiqueta antes de mandársela al cliente
    if (cita.iso) { // solo si pasó la validación (no pasado, dentro de horario)
      const esReagenda = lead.citaProgramada && lead.citaProgramada !== cita.iso;
      upsertLead(telefono, { citaProgramada: cita.iso, seguimientos: { recordatorioCita: false } });
      const fechaTxt = new Date(cita.iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      const link = gcalLink(cita.iso, `Cita: ${lead.nombre || telefono}`, `Visita agendada por el asistente. Cliente: ${lead.nombre || telefono} (${telefono}).`);
      const titulo = esReagenda ? "🔄 Cita REAGENDADA" : "📅 Cita agendada";
      let cuerpo = `Cliente: ${lead.nombre || telefono}\n`;
      if (esReagenda) {
        const antesTxt = new Date(lead.citaProgramada).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
        cuerpo += `Antes: ${antesTxt}\nAhora: ${fechaTxt}`;
      } else {
        cuerpo += fechaTxt;
      }
      const aviso = `${titulo}\n${cuerpo}\n\n➕ Agrégala a tu calendario:\n${link}`;
      const dueno = process.env.OWNER_PHONE;
      if (dueno) await enviarTextoOPlantilla(dueno, aviso, process.env.WA_TPL_ALERTA, [titulo.replace(/[^\p{L}\s]/gu, "").trim(), `${lead.nombre || telefono} - ${fechaTxt}`]).catch(() => {});
      // También al asesor asignado, si tiene teléfono (y no es el mismo del dueño)
      const ag = lead.agenteAsignado ? (getAgents() || []).find((a) => a.id === lead.agenteAsignado) : null;
      if (ag && ag.telefono && ag.telefono !== dueno) await enviarTextoOPlantilla(ag.telefono, aviso, process.env.WA_TPL_ALERTA, [titulo.replace(/[^\p{L}\s]/gu, "").trim(), `${lead.nombre || telefono} - ${fechaTxt}`]).catch(() => {});
    }
  }

  // 5c) ¿El bot captó el nombre del cliente? Detecta [NOMBRE: ...] y lo guarda.
  const nm = extraerNombre(respuesta);
  if (nm) {
    respuesta = nm.textoLimpio;
    if (nm.nombre) upsertLead(telefono, { nombre: nm.nombre });
  }

  await enviarTextoCanal(canal, telefono, respuesta);
  pushHistorial(telefono, "bot", respuesta);

  // 6) Manda las fotos de las propiedades que el bot acaba de presentar.
  //    Si es UNA sola propiedad, manda varias fotos de ella (hasta 4). Si son
  //    varias opciones, manda 1 foto de cada una para no saturar.
  if (nuevas.length && lead.perfil.zona) {
    const fmt = (n) => "$" + (n || 0).toLocaleString("es-MX");
    const maxFotos = nuevas.length === 1 ? 4 : 1;
    for (const prop of nuevas) {
      const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(prop.titulo + " Ciudad de México")}`;
      const caption = `🏡 ${prop.titulo}\n${fmt(prop.precio)}${prop.operacion === "renta" ? "/mes" : ""} · ${prop.recamaras} rec · ${prop.banos} baños · ${prop.m2} m²\n📍 Ubicación: ${maps}`;
      const fotos = (prop.imagenes || []).slice(0, maxFotos);
      for (let i = 0; i < fotos.length; i++) {
        // Solo la primera foto lleva el texto (precio, specs); las demás van sin caption.
        await enviarImagenCanal(canal, telefono, fotos[i], i === 0 ? caption : "");
      }
      pushHistorial(telefono, "bot", `[${fotos.length} foto(s) enviada(s)] ${prop.titulo}`);
      marcarEnviada(telefono, prop.id);
      // Si la propiedad tiene video, también se lo mandamos.
      if (prop.video) {
        await enviarVideoCanal(canal, telefono, prop.video, `🎥 Video: ${prop.titulo}`).catch(() => {});
        pushHistorial(telefono, "bot", `[video enviado] ${prop.titulo}`);
      }
    }
  }

  // 7) Recalcula score y temperatura, asigna agente si subió a tibio/caliente
  lead = getLead(telefono);
  const { score, temperatura } = calcularScore(lead);
  const patch = { score, temperatura };

  if (!lead.agenteAsignado && temperatura !== "frio") {
    const agente = asignarAgente(lead.perfil.zona);
    if (agente) {
      patch.agenteAsignado = agente.id;
      // Notificar al agente que tiene un lead calificado
      await enviarTexto(
        agente.telefono,
        `🎯 Nuevo lead ${temperatura.toUpperCase()} (score ${score})\nCliente: ${lead.nombre || telefono}\nZona: ${lead.perfil.zona || "?"}\nPresupuesto: ${lead.perfil.presupuesto ? "$" + lead.perfil.presupuesto.toLocaleString("es-MX") : "?"}\nPropósito: ${lead.perfil.proposito || "?"}`
      ).catch(() => {});
    }
  }
  upsertLead(telefono, patch);
}

// ---------------------------------------------------------------------------
// 3) API DEL DASHBOARD
// ---------------------------------------------------------------------------

// Lista de leads + agentes + métricas para el panel
app.get("/api/leads", (req, res) => {
  const db = loadDB();
  const leads = Object.values(db.leads).sort((a, b) => b.score - a.score);
  const agentesById = Object.fromEntries(db.agents.map((a) => [a.id, a.nombre]));

  const metricas = {
    total: leads.length,
    sinAtender: leads.filter((l) => (l.estado || "sin_atender") === "sin_atender").length,
    calientes: leads.filter((l) => l.temperatura === "caliente").length,
    tibios: leads.filter((l) => l.temperatura === "tibio").length,
    frios: leads.filter((l) => l.temperatura === "frio").length,
    citas: leads.filter((l) => l.citaProgramada).length,
    pipeline: leads
      .filter((l) => l.perfil?.presupuesto)
      .reduce((s, l) => s + l.perfil.presupuesto, 0),
  };

  res.json({ leads, agentes: db.agents, agentesById, zonas: db.zones || [], metricas, config: getConfig() });
});

// Exportar todos los leads a CSV (se abre en Excel). Va ANTES de /:telefono
// para que "export" no se interprete como un número de teléfono.
app.get("/api/leads/export", (req, res) => {
  const db = loadDB();
  const agentesById = Object.fromEntries(db.agents.map((a) => [a.id, a.nombre]));
  const estadoLabel = { sin_atender: "Sin atender", en_atencion: "En atención", cerrado: "Cerrado", perdido: "Perdido" };
  const cols = ["Nombre", "Teléfono", "Estado", "Temperatura", "Score", "Zona", "Presupuesto", "Recámaras", "Propósito", "Asesor", "Etiquetas", "Notas", "Creado"];

  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const filas = Object.values(db.leads).map((l) => {
    const p = l.perfil || {};
    return [
      l.nombre || "", l.telefono, estadoLabel[l.estado] || l.estado || "", l.temperatura || "", l.score || 0,
      p.zona || "", p.presupuesto || "", p.recamaras || "", p.proposito || "",
      l.agenteAsignado ? (agentesById[l.agenteAsignado] || "") : "",
      (l.etiquetas || []).join(" | "), (l.notas || "").replace(/\n/g, " "),
      l.creado ? new Date(l.creado).toLocaleString("es-MX", { timeZone: "America/Mexico_City" }) : "",
    ].map(esc).join(",");
  });

  const csv = "\uFEFF" + cols.join(",") + "\n" + filas.join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
  res.send(csv);
});

// Detalle de un lead (incluye historial completo de la conversación)
app.get("/api/leads/:telefono", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  res.json(lead);
});

// El agente "toma el control" de la conversación (el bot deja de responder)
app.post("/api/leads/:telefono/tomar-control", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  upsertLead(req.params.telefono, { humanoEnControl: true });
  res.json({ ok: true });
});

// El agente devuelve el control al bot
app.post("/api/leads/:telefono/devolver-control", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  upsertLead(req.params.telefono, { humanoEnControl: false });
  res.json({ ok: true });
});

// Asignar (o reasignar) el lead a un asesor
app.post("/api/leads/:telefono/asignar", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  const agenteId = req.body?.agenteId || null;
  upsertLead(req.params.telefono, { agenteAsignado: agenteId });
  res.json({ ok: true });
});

// Cambiar el estado del lead (sin_atender | en_atencion | cerrado | perdido)
app.post("/api/leads/:telefono/estado", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  const estado = req.body?.estado;
  const validos = ["sin_atender", "en_atencion", "cerrado", "perdido"];
  if (!validos.includes(estado)) return res.status(400).json({ error: "Estado inválido" });
  const patch = { estado };
  // Si un asesor lo va a atender, el bot deja de responder automáticamente
  if (estado === "en_atencion") patch.humanoEnControl = true;
  upsertLead(req.params.telefono, patch);
  res.json({ ok: true });
});

// Registrar una VENTA cerrada: liga el lead con la propiedad vendida y el monto.
// Marca el lead como "cerrado" Y la propiedad como "vendido" (las dos cosas ligadas).
app.post("/api/leads/:telefono/venta", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  const propiedadId = req.body?.propiedadId || null;
  const monto = Number(req.body?.monto) || 0;
  const fecha = new Date().toISOString();
  const agente = (getAgents() || []).find((a) => a.id === lead.agenteAsignado);
  upsertLead(req.params.telefono, {
    estado: "cerrado",
    venta: { propiedadId, monto, fecha, agenteId: lead.agenteAsignado || null },
  });
  if (propiedadId) {
    updateProperty(propiedadId, {
      estado: "vendido",
      venta: {
        agenteId: lead.agenteAsignado || null,
        agenteNombre: agente ? agente.nombre : null,
        monto,
        fecha,
        cliente: lead.nombre || null,
        leadTel: lead.telefono,
      },
    });
  }
  res.json({ ok: true });
});

// Deshacer una venta (si se registró por error): vuelve el lead a "en atención"
// y la propiedad a "disponible".
app.post("/api/leads/:telefono/venta/deshacer", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  const propId = lead.venta?.propiedadId;
  upsertLead(req.params.telefono, { estado: "en_atencion", venta: null });
  if (propId) updateProperty(propId, { estado: "disponible", venta: null });
  res.json({ ok: true });
});

// Analítica de ventas: embudo, por asesor, por zona y totales.
app.get("/api/analytics", (req, res) => {
  const db = loadDB();
  const leads = Object.values(db.leads);
  const props = db.properties || [];
  const propById = Object.fromEntries(props.map((p) => [p.id, p]));
  const agentes = db.agents || [];
  const ahora = new Date();
  const esEsteMes = (iso) => {
    const d = new Date(iso);
    return d.getFullYear() === ahora.getFullYear() && d.getMonth() === ahora.getMonth();
  };

  const conVenta = leads.filter((l) => l.venta && l.estado === "cerrado");
  const calificados = leads.filter((l) => l.perfil && (l.perfil.zona || l.perfil.presupuesto));
  const conCita = leads.filter((l) => l.citaProgramada);

  // Embudo
  const embudo = {
    leads: leads.length,
    calificados: calificados.length,
    citas: conCita.length,
    ventas: conVenta.length,
  };

  // Totales
  const ingresos = conVenta.reduce((s, l) => s + (l.venta.monto || 0), 0);
  const ingresosMes = conVenta.filter((l) => esEsteMes(l.venta.fecha)).reduce((s, l) => s + (l.venta.monto || 0), 0);
  const totales = {
    ventas: conVenta.length,
    ingresos,
    ingresosMes,
    ticket: conVenta.length ? Math.round(ingresos / conVenta.length) : 0,
    conversion: leads.length ? +(conVenta.length / leads.length * 100).toFixed(1) : 0,
  };

  // Por asesor
  const porAsesor = agentes.map((a) => {
    const susLeads = leads.filter((l) => l.agenteAsignado === a.id);
    const susVentas = conVenta.filter((l) => (l.venta.agenteId || l.agenteAsignado) === a.id);
    return {
      id: a.id,
      nombre: a.nombre,
      leads: susLeads.length,
      citas: susLeads.filter((l) => l.citaProgramada).length,
      ventas: susVentas.length,
      ingresos: susVentas.reduce((s, l) => s + (l.venta.monto || 0), 0),
    };
  }).sort((x, y) => y.ingresos - x.ingresos);

  // Por zona (según la zona de la propiedad vendida; si no, la del perfil del lead)
  const zonaNombre = Object.fromEntries((db.zones || []).map((z) => [z.slug || z.id, z.nombre]));
  const zonasAcc = {};
  for (const l of conVenta) {
    const prop = l.venta.propiedadId ? propById[l.venta.propiedadId] : null;
    const zkey = (prop && prop.zona) || (l.perfil && l.perfil.zona) || "otra";
    if (!zonasAcc[zkey]) zonasAcc[zkey] = { zona: zonaNombre[zkey] || zkey, ventas: 0, ingresos: 0 };
    zonasAcc[zkey].ventas++;
    zonasAcc[zkey].ingresos += l.venta.monto || 0;
  }
  const porZona = Object.values(zonasAcc).sort((x, y) => y.ingresos - x.ingresos);

  res.json({ embudo, totales, porAsesor, porZona });
});

// Guardar notas y etiquetas del lead
app.post("/api/leads/:telefono/notas", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  const patch = {};
  if (req.body?.notas !== undefined) patch.notas = String(req.body.notas);
  if (req.body?.etiquetas !== undefined) {
    patch.etiquetas = Array.isArray(req.body.etiquetas)
      ? req.body.etiquetas.map((e) => String(e).trim()).filter(Boolean)
      : [];
  }
  upsertLead(req.params.telefono, patch);
  res.json({ ok: true });
});

// Programar / editar / quitar la cita de un lead a mano desde el panel
app.post("/api/leads/:telefono/cita", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  let iso = req.body?.cita || null; // viene de un input datetime-local, o null para quitar
  if (iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return res.status(400).json({ error: "Fecha inválida" });
    iso = d.toISOString();
  }
  upsertLead(req.params.telefono, { citaProgramada: iso, seguimientos: { recordatorioCita: false } });
  res.json({ ok: true });
});

// El asesor escribe al cliente DIRECTO desde el CRM (por el canal del lead).
// Al mandar, el bot deja de responder solo (el humano tomó el control).
app.post("/api/leads/:telefono/enviar", async (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "Texto vacío" });
  await enviarTextoCanal(lead.canal, req.params.telefono, texto);
  pushHistorial(req.params.telefono, "bot", texto);
  upsertLead(req.params.telefono, { humanoEnControl: true });
  res.json({ ok: true });
});

// Acciones en lote: borrar o cambiar estado de varios leads seleccionados
app.post("/api/leads/bulk", (req, res) => {
  const { accion, telefonos } = req.body || {};
  if (!Array.isArray(telefonos) || !telefonos.length) return res.status(400).json({ error: "Sin leads" });
  let n = 0;
  for (const tel of telefonos) {
    if (accion === "borrar") { if (deleteLead(tel)) n++; }
    else if (["sin_atender", "en_atencion", "cerrado", "perdido"].includes(accion)) { upsertLead(tel, { estado: accion }); n++; }
  }
  res.json({ ok: true, count: n });
});

// ---------------------------------------------------------------------------

// Revisa la contraseña de admin (protección básica para escrituras)
function checarAdmin(req, res) {
  const pass = req.headers["x-admin-password"] || req.query.pass;
  if (pass !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return false;
  }
  return true;
}

// Listar propiedades (lectura libre, la usa el panel)
app.get("/api/properties", (req, res) => {
  res.json({ properties: getProperties() });
});

// Crear propiedad
app.post("/api/properties", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const prop = createProperty(req.body || {});
  res.json({ ok: true, property: prop });
});

// Actualizar propiedad
app.put("/api/properties/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const prop = updateProperty(req.params.id, req.body || {});
  if (!prop) return res.status(404).json({ error: "No encontrada" });
  res.json({ ok: true, property: prop });
});

// Borrar propiedad
app.delete("/api/properties/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const ok = deleteProperty(req.params.id);
  res.json({ ok });
});

// ---------------------------------------------------------------------------
// 4b) API DE AJUSTES (datos de la agencia + agentes) — la usa el panel
// ---------------------------------------------------------------------------

// Configuración de la agencia
app.get("/api/config", (req, res) => {
  res.json({ config: getConfig() });
});
app.put("/api/config", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const c = updateConfig(req.body || {});
  res.json({ ok: true, config: c });
});

// Agentes
app.get("/api/agents", (req, res) => {
  res.json({ agents: getAgents() });
});
app.post("/api/agents", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ ok: true, agent: createAgent(req.body || {}) });
});
app.put("/api/agents/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const a = updateAgent(req.params.id, req.body || {});
  if (!a) return res.status(404).json({ error: "No encontrado" });
  res.json({ ok: true, agent: a });
});
app.delete("/api/agents/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ ok: deleteAgent(req.params.id) });
});

// Zonas (se administran desde el panel; sincronizadas con bot, propiedades y agentes)
app.get("/api/zones", (req, res) => {
  res.json({ zones: getZones() });
});
app.post("/api/zones", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ ok: true, zone: createZone(req.body || {}) });
});
app.put("/api/zones/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const z = updateZone(req.params.id, req.body || {});
  if (!z) return res.status(404).json({ error: "No encontrada" });
  res.json({ ok: true, zone: z });
});
app.delete("/api/zones/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ ok: deleteZone(req.params.id), uso: zonaEnUso(req.params.id) });
});

// ---------------------------------------------------------------------------
// 5) ENDPOINTS DE PRUEBA (para disparar alertas/reportes cuando quieras)
// ---------------------------------------------------------------------------
app.get("/api/test/reporte", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  const r = await enviarReporteAhora();
  res.json({ ok: true, detalle: r });
});

app.get("/api/test/alerta-calientes", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  const r = await revisarLeadsCalientesAhora(true);
  res.json({ ok: true, detalle: r });
});

// Panel de administración (ahora unificado dentro del CRM)
app.get("/admin", (req, res) => {
  res.redirect("/dashboard");
});

// Dashboard
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Salud del servidor
app.get("/", (req, res) => res.send("Bot inmobiliario activo ✅. Ve a /dashboard o /admin"));

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  seedAgentesDemo();       // crea agentes de ejemplo si no hay
  seedPropiedadesDemo();   // crea propiedades de ejemplo si no hay
  seedZonasDemo();         // crea zonas de ejemplo si no hay
  iniciarCronJobs();       // activa seguimientos automáticos
  console.log(`🚀 Bot inmobiliario corriendo en puerto ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   Admin:     http://localhost:${PORT}/admin`);
});
