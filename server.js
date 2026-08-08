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
  loadDB, upsertLead, pushHistorial, actualizarEstadoMensaje, reaccionarMensaje, getLead, getAllLeads, getConfig, saveDB, deleteLead,
  getProperties, getProperty, createProperty, updateProperty, deleteProperty,
  getAgents, updateConfig, createAgent, updateAgent, deleteAgent,
  getBlocks, createBlock, deleteBlock,
  getZones, createZone, updateZone, deleteZone, zonaEnUso, seedZonasDemo,
  getCampanas, getCampana, crearCampana, actualizarCampana, borrarCampana, marcarContacto, marcarRespuestaCampana,
} from "./store.js";
import { generarRespuesta } from "./gemini.js";
import { enviarTexto, enviarImagen, enviarTextoOPlantilla, enviarPlantilla, enviarDocumento, plantillasAprobadas } from "./whatsapp.js";
import { enviarTextoCanal, enviarImagenCanal, enviarVideoCanal, enviarUbicacionCanal } from "./canales.js";
import { descargarMediaWhatsApp, analizarImagen, transcribirAudio } from "./vision.js";
import { enviarCorreo, plantillaHTML, extraerEmail, correoActivo } from "./email.js";
import { alertarDev, instalarCazadorDeErrores, alertasActivas, destinoAlertas } from "./alertas.js";
import { notificar, suscribir, desuscribir, llavePublica, guardarPrefs, misSuscripciones, AVISOS } from "./push.js";
import { armar as armarMosaico, leer as leerMosaico, activo as mosaicoActivo } from "./mosaico.js";
import { resumen as consumoDelMes, historico as consumoHistorico } from "./consumo.js";
import { leerReferencia, registrarOrigen, sumarResultado, resumenAnuncios } from "./anuncios.js";
import { extraerPerfil, calcularScore } from "./scoring.js";
import { analizarFrustracion } from "./frustration.js";
import { asignarAgente, seedAgentesDemo } from "./agents.js";
import { buscarPropiedades, contextoPropiedades, marcarEnviada, seedPropiedadesDemo, cargarPropiedadesDemoForzado, backfillCoordsDemo } from "./properties.js";
import { iniciarCronJobs, enviarReporteAhora, revisarLeadsCalientesAhora , enviarReporteAsesoresAhora } from "./followups.js";
import { revisarDisponibilidad, citasAfectadasPorBloqueo, asesorAlternativoLibre } from "./availability.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "15mb" })); // 15mb: permite recibir fotos en base64

// Carpeta donde se guardan las fotos que sube el usuario (en el disco persistente).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Se sirven PÚBLICAS (sin contraseña) para que WhatsApp pueda descargarlas.
app.use("/uploads", express.static(UPLOADS_DIR));

// El servidor necesita saber su propia dirección para armar las ligas que
// WhatsApp va a descargar (fotos, mosaicos). Si no está PUBLIC_URL, la
// aprendemos de la primera petición que llegue.
let DOMINIO_PROPIO = process.env.PUBLIC_URL || "";
app.use((req, _res, next) => {
  if (!DOMINIO_PROPIO && req.get("host")) {
    const proto = req.get("x-forwarded-proto") || (req.secure ? "https" : "http");
    DOMINIO_PROPIO = `${proto}://${req.get("host")}`;
  }
  next();
});
export const miDominio = () => DOMINIO_PROPIO;

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "cambia_esto";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // protección básica del panel

// ---------------------------------------------------------------------------
// CANDADO: TODA la información del CRM (rutas /api) exige contraseña.
// El webhook (/webhook) NO pasa por aquí (lo llama Meta, va aparte).
// Las páginas /dashboard y /admin se sirven, pero sin contraseña no muestran datos.
// ---------------------------------------------------------------------------
// Identifica quién entra: el DUEÑO (con ADMIN_PASSWORD) o un ASESOR (con su PIN).
// Devuelve null si la credencial no es válida.
function quienEs(req) {
  const pass = String(req.headers["x-admin-password"] || req.query.pass || "");
  if (!pass) return null;
  if (pass === ADMIN_PASSWORD) return { rol: "dueno", id: null, nombre: "Dueño" };
  const ag = (getAgents() || []).find((a) => a.activo !== false && a.pin && String(a.pin) === pass);
  if (ag) return { rol: "asesor", id: ag.id, nombre: ag.nombre };
  return null;
}

app.use("/api", (req, res, next) => {
  const yo = quienEs(req);
  if (!yo) return res.status(401).json({ error: "No autorizado" });
  req.yo = yo;
  next();
});

// ¿Este lead le pertenece a quien está viendo? El dueño ve todos.
function esMiLead(req, lead) {
  if (!req.yo || req.yo.rol === "dueno") return true;
  return lead && lead.agenteAsignado === req.yo.id;
}
// Filtra una lista de leads según el rol.
function misLeads(req, leads) {
  if (!req.yo || req.yo.rol === "dueno") return leads;
  return leads.filter((l) => l.agenteAsignado === req.yo.id);
}
// Bloquea acciones de administración a los asesores.
function soloDueno(req, res) {
  if (req.yo && req.yo.rol === "dueno") return true;
  res.status(403).json({ error: "Solo el dueño puede hacer esto" });
  return false;
}

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

// --- Agrupador de mensajes (INTELIGENTE) ---
// La gente en WhatsApp escribe en varios mensajitos seguidos ("Hola" / "busco
// casa" / "en Polanco"). Antes esperábamos SIEMPRE unos segundos, lo que hacía
// que hasta un mensaje completo tardara en contestarse. Ahora es más listo:
//   - Si el mensaje SE VE COMPLETO (una pregunta, una frase cerrada) -> contesta
//     casi de inmediato (espera corta, ESPERA_CORTA_MS).
//   - Si SE VE QUE VA A SEGUIR (un saludo suelto, termina en "y", ",", ":", muy
//     cortito...) -> espera más (ESPERA_LARGA_MS, 10s) por si manda otro.
// Si mientras espera llega otro mensaje, se re-evalúa con el nuevo y se junta todo.
// Análisis por texto (rápido, sin llamada extra a la IA).
// INSTANTÁNEO por defecto (0 = contesta de inmediato, sin agrupar). Si algún día
// quieres reactivar el agrupador inteligente, pon ESPERA_LARGA_MS y ESPERA_CORTA_MS
// (en milisegundos) mayores a 0 en Railway.
const ESPERA_LARGA_MS = Number(process.env.ESPERA_LARGA_MS ?? 0);
const ESPERA_CORTA_MS = Number(process.env.ESPERA_CORTA_MS ?? 0);
const pendientes = new Map(); // telefono -> { textos, nombre, canal, timer }

// ¿El último mensaje parece que el cliente AÚN NO termina de escribir?
// true  -> conviene esperar más (va a seguir).  false -> ya se puede contestar.
function pareceIncompleto(texto) {
  const t = String(texto || "").trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  // "..." al final sugiere que sigue.
  if (/(\.\.\.|…)$/.test(t)) return true;
  // Termina en un signo de cierre claro (. ! ?) -> se ve COMPLETO.
  if (/[.!?]$/.test(t)) return false;
  // Termina en coma, dos puntos, punto y coma o guion -> va a seguir.
  if (/[,:;\-]$/.test(t)) return true;

  const palabras = lower.split(/\s+/).filter(Boolean);

  // Frases de apertura típicas que solas casi siempre llevan a otro mensaje.
  if (/^(hola|hey|buenas|buenos dias|buenas tardes|buenas noches|oye|oiga|mira|disculpa|perdon|perdón|una pregunta|tengo una duda|qué onda|que onda|holi)$/i.test(lower)) return true;

  // Muy cortito y sin puntuación -> probablemente aún no termina.
  if (palabras.length <= 2 && t.length <= 15) return true;

  // Termina en una palabra "colgante" (conector, preposición o arranque de idea)
  // que casi nunca cierra un mensaje.
  const colgantes = new Set(["y","e","o","u","pero","porque","pues","que","de","del","en","con","para","por","la","el","los","las","un","una","unos","unas","mi","mis","tu","tus","su","sus","se","al","a","o","sea","es","son","esta","está","como","cuando","donde","cual","cuál","quiero","busco","necesito","tengo","quería","queria","quisiera","me","te","lo","le","les","muy","más","mas","tan","también","tambien","ademas","además","si","sí","entonces"]);
  const ult = palabras[palabras.length - 1];
  if (colgantes.has(ult)) return true;

  return false;
}

function encolarMensaje(telefono, texto, nombre, canal) {
  if (ESPERA_LARGA_MS <= 0) {
    return procesarMensaje(telefono, texto, nombre, canal).catch((e) =>
      console.error("[procesar]", e.message)
    );
  }
  const b = pendientes.get(telefono) || { textos: [], nombre: null, canal };
  b.textos.push(texto);
  if (nombre) b.nombre = nombre;
  b.canal = canal;
  if (b.timer) clearTimeout(b.timer); // llegó otro: reiniciamos y re-evaluamos

  // Cuánto esperar según el ÚLTIMO mensaje: si se ve completo, poquito; si parece
  // que va a seguir, los 10s.
  const espera = pareceIncompleto(texto) ? ESPERA_LARGA_MS : ESPERA_CORTA_MS;

  b.timer = setTimeout(() => {
    pendientes.delete(telefono);
    const juntos = b.textos.join("\n");
    procesarMensaje(telefono, juntos, b.nombre, b.canal).catch((e) =>
      console.error("[procesar]", e.message)
    );
  }, espera);
  pendientes.set(telefono, b);
}

// Envía por el canal y registra en el historial guardando el ID del mensaje de
// WhatsApp (wamid) y su estado inicial "enviado". Con eso el CRM puede mostrar
// las palomitas (enviado ✓ / entregado ✓✓ / leído ✓✓ azul).
async function enviarYRegistrar(canal, telefono, texto, rol = "bot") {
  const r = await enviarTextoCanal(canal, telefono, texto);
  // Si WhatsApp está caído o el token murió, el bot deja de contestarle a TODOS.
  // Es el error más grave posible: hay que enterarse de inmediato.
  if (r && r.error && [190, 131031, 100].includes(r.code)) {
    alertarDev("whatsapp_caido", "🔴 WhatsApp dejó de funcionar", r.motivo || "Error al enviar",
      "critico", "El bot NO le está contestando a nadie. Revisa el token o la cuenta en Meta YA.");
  }
  const msgId = r?.messages?.[0]?.id || null;
  pushHistorial(telefono, rol, texto, msgId ? { estado: "enviado", msgId } : {});
  return r;
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

      // Estados de mensajes salientes (palomitas): WhatsApp avisa enviado/entregado/leído.
      const statuses = value?.statuses;
      if (Array.isArray(statuses) && statuses.length) {
        const mapa = { sent: "enviado", delivered: "entregado", read: "leido" };
        for (const stt of statuses) {
          const nuevo = mapa[stt?.status];
          if (nuevo && stt?.id) actualizarEstadoMensaje(stt.id, nuevo);
        }
        return;
      }

      const mensaje = value?.messages?.[0];
      if (!mensaje) return;
      if (mensajeDuplicado(mensaje.id)) return; // ya lo procesamos, no repitas
      const nombre = value?.contacts?.[0]?.profile?.name || null;

      // ¿Vino de un anuncio? Meta pega el bloque "referral" al primer mensaje.
      // Lo guardamos para que la agencia sepa qué anuncio le trae clientes.
      const refAnuncio = leerReferencia(mensaje);
      if (refAnuncio) {
        // El lead puede no existir todavía; lo registramos en cuanto se cree.
        setTimeout(() => registrarOrigen(mensaje.from, refAnuncio), 1500);
      }
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
        encolarMensaje(mensaje.from, `😄 ${tok}(El cliente te mandó un sticker)`, nombre, "whatsapp");
        return;
      }
      if (mensaje.type === "video") {
        // GIFs y videos cortos llegan como "video". Los bajamos para verlos en el
        // CRM y el bot reacciona con buena onda.
        const media = await descargarMediaWhatsApp(mensaje.video?.id);
        await manejarVideoGif(mensaje.from, nombre, "whatsapp", media, mensaje.video?.caption);
        return;
      }
      if (mensaje.type === "reaction") {
        // El cliente REACCIONÓ a un mensaje (👍, ❤️...). NO es un mensaje nuevo:
        // no se responde ni se le pide "más detalle". Solo se anota discreto en el
        // CRM para que el asesor lo vea.
        // Se PEGA al mensaje al que reaccionó (como en WhatsApp), no es un mensaje nuevo.
        const emoji = mensaje.reaction?.emoji || "";
        const objetivo = mensaje.reaction?.message_id || null;
        reaccionarMensaje(mensaje.from, objetivo, emoji);
        return;
      }
      if (mensaje.type !== "text") {
        await manejarNoTexto(mensaje.from, nombre, "whatsapp"); // ubicación, contacto, etc.
        return;
      }
      encolarMensaje(mensaje.from, mensaje.text.body, nombre, "whatsapp");
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
          if (msg.text) encolarMensaje(remitente, msg.text, null, canal);
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

// ---------------------------------------------------------------------------
// Aviso al celular cuando un asesor tomó el chat (bot desactivado).
// Se ve como una notificación normal de WhatsApp: el nombre arriba y lo que
// escribió abajo. Al tocarla, el CRM abre ESE chat.
// OJO: solo se manda si humanoEnControl está encendido. Mientras el bot
// atienda, no molestamos a nadie.
// ---------------------------------------------------------------------------
function avisarChatHumano(lead, texto, tipo) {
  if (!lead || !lead.humanoEnControl) return;          // el bot sigue atendiendo: no avisar
  const quien = lead.nombre || lead.telefono;
  // Igual que WhatsApp: si no es texto, se describe el tipo de archivo
  const cuerpo = {
    foto:  "📷 Foto",
    audio: "🎤 Nota de voz",
    video: "🎬 Video",
    doc:   "📄 Archivo",
  }[tipo] || String(texto || "").replace(/\[(img|vid|doc):[^\]]*\]/g, "").trim().slice(0, 140) || "Mensaje nuevo";

  notificar("mensaje_chat", {
    titulo: quien,
    cuerpo,
    url: `/dashboard?lead=${lead.telefono}`,
    tag: `chat-${lead.telefono}`,                       // se apilan como en WhatsApp
    urgente: true,                                      // vibra y se queda hasta que la veas
  }, lead.agenteAsignado || null).catch(() => {});
  console.log(`[aviso] Chat de ${quien}: "${String(cuerpo).slice(0, 40)}"`);
}

// El cliente mandó algo que no es texto (imagen, audio, sticker...). El bot
// todavía no "ve" imágenes, así que responde con gracia en vez de quedarse callado.
async function manejarNoTexto(remitente, nombre, canal) {
  let lead = getLead(remitente);
  if (!lead) lead = upsertLead(remitente, { nombre, canal });
  pushHistorial(remitente, "user", "[imagen/archivo recibido]");
  if (lead.humanoEnControl) { avisarChatHumano(lead, null, "doc"); return; }
  const msg = "¡Gracias! 😄 Oye, mejor cuéntame qué andas buscando —zona, presupuesto, recámaras— y te encuentro algo padre. 🏠";
  await enviarYRegistrar(canal, remitente, msg);
}

// El cliente mandó un GIF o video corto. Lo guardamos para verlo en el CRM y el
// bot reacciona con naturalidad (sin inventar exactamente qué muestra).
async function manejarVideoGif(remitente, nombre, canal, media, caption) {
  let lead = getLead(remitente);
  if (!lead) lead = upsertLead(remitente, { nombre, canal });
  const url = guardarMediaLocal(media);
  const tok = url ? `[vid:${url}] ` : "";
  if (lead.humanoEnControl) {
    pushHistorial(remitente, "user", `🎞️ ${tok}${caption || ""}`.trim());
    avisarChatHumano(lead, caption, caption ? null : "video");
    return;
  }
  const capTxt = caption ? ` Escribió junto al GIF: "${caption}".` : "";
  encolarMensaje(remitente, `🎞️ ${tok}(El cliente te mandó un GIF o video corto y divertido.${capTxt} Reacciona con buena onda y humor si aplica, SIN inventar exactamente qué muestra, y de inmediato sigue la conversación por donde iba o pregúntale qué está buscando.)`, nombre, canal);
}

// El cliente mandó una NOTA DE VOZ. La transcribimos con Whisper y la tratamos
// como si la hubiera escrito (el bot responde a lo que dijo). Si no se pudo
// escuchar, responde con gracia.
async function manejarAudio(remitente, nombre, canal, audio) {
  let lead = getLead(remitente);
  if (!lead) lead = upsertLead(remitente, { nombre, canal });
  if (lead.humanoEnControl) {
    pushHistorial(remitente, "user", "[🎙️ nota de voz]");
    avisarChatHumano(lead, null, "audio");
    return; // un asesor ya está atendiendo
  }

  const texto = audio ? await transcribirAudio(audio) : null;

  if (texto && texto.trim().length > 1) {
    // El bot "escuchó" la nota. La pasamos a su cerebro como mensaje del cliente,
    // con una marca al inicio para que en el CRM se vea que fue nota de voz.
    encolarMensaje(remitente, `🎙️ ${texto.trim()}`, nombre, canal);
    return;
  }

  // No se pudo transcribir: respuesta con gracia.
  pushHistorial(remitente, "user", "[🎙️ nota de voz]");
  const msg = "¡Gracias por tu nota de voz! 🙂 No alcancé a escucharla bien. ¿Me cuentas por aquí qué estás buscando (zona, presupuesto, recámaras)?";
  await enviarYRegistrar(canal, remitente, msg);
}
// Guarda un archivo que llegó del cliente (foto/sticker) en el disco, para poder
// mostrarlo en el CRM. Devuelve una URL relativa (/uploads/xxx) o null.
function guardarMediaLocal(imagen) {
  try {
    if (imagen?.url) return imagen.url; // Messenger/Instagram ya dan URL pública
    if (imagen?.base64) {
      const mime = imagen.mime || "image/jpeg";
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : (mime.includes("mp4") || mime.includes("video")) ? "mp4" : mime.includes("webm") ? "webm" : "jpg";
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
    avisarChatHumano(lead, caption, caption ? null : "foto");
    return;
  }

  const desc = imagen ? await analizarImagen(imagen) : null;

  if (desc && /NO_PROPIEDAD/i.test(desc)) {
    const quees = desc.replace(/.*NO_PROPIEDAD:?\s*/i, "").trim() || "algo";
    const texto = `📷 ${tok}(El cliente te mandó una foto que NO es una propiedad; se ve: ${quees}. Reacciona MUY breve con buena onda y de inmediato regresa la conversación a ayudarlo a encontrar una propiedad.)`;
    encolarMensaje(remitente, texto, nombre, canal);
    return;
  }

  if (desc) {
    const cap = caption ? ` El cliente escribió junto a la foto: "${caption}".` : "";
    const texto = `📷 ${tok}(El cliente te envió una foto de una propiedad que le interesa. En la foto se ve: ${desc}.${cap})`;
    encolarMensaje(remitente, texto, nombre, canal);
    return;
  }

  // No se pudo analizar: en vez de un mensaje enlatado que REINICIA la charla, se
  // lo pasamos al modelo con contexto para que responda natural y SIN inventar
  // (la foto igual queda guardada para verla en el CRM).
  const capTxt = caption ? ` El cliente escribió junto a la imagen: "${caption}".` : "";
  encolarMensaje(remitente, `📷 ${tok}(El cliente te mandó una imagen pero el sistema NO pudo ver su contenido.${capTxt} NO inventes ni describas qué muestra. Reacciona breve y con buena onda, y SIGUE la conversación por donde iba: si ya estaban agendando o calificando, continúa con eso; si no, pregúntale con naturalidad qué está buscando.)`, nombre, canal);
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

// Detecta [EMAIL: correo@x.com] que el bot pone cuando el cliente da su correo.
function extraerCorreo(texto) {
  const m = texto.match(/\[EMAIL:\s*([^\]]+)\]/i);
  if (!m) return null;
  return { email: extraerEmail(m[1]), textoLimpio: texto.replace(m[0], "").trim() };
}

// Detecta [ASESOR: Nombre] que el bot pone cuando el cliente elige asesor.
// Devuelve el id del asesor (si coincide con la lista) y el texto ya sin etiqueta.
function extraerAsesor(texto) {
  const m = texto.match(/\[ASESOR:\s*([^\]]+)\]/i);
  if (!m) return null;
  const nombre = m[1].trim();
  const nl = nombre.toLowerCase();
  const ag = (getAgents() || []).find((a) => a.nombre && (
    a.nombre.toLowerCase() === nl ||
    a.nombre.toLowerCase().includes(nl) ||
    nl.includes(a.nombre.toLowerCase())
  ));
  return { agenteId: ag ? ag.id : null, nombre, textoLimpio: texto.replace(m[0], "").trim() };
}

// RED DE SEGURIDAD FINAL: quita CUALQUIER etiqueta interna que se cuele en la
// respuesta antes de enviarla al cliente — esté bien formada, mal formada, vacía
// o truncada (ej. "[CITA:]", "[CITA: sábado]", "[NOMBRE: Juan", "[CITA: 2026-..."
// cortada por el límite de tokens). Solo toca lo que esté ENTRE CORCHETES, así que
// NUNCA borra la palabra normal "cita" o "nombre" de una frase real del cliente.
function limpiarEtiquetas(texto) {
  return String(texto || "")
    .replace(/\[\s*CITA\b[^\]]*\]/gi, "")   // [CITA: ...] completa (o vacía)
    .replace(/\[\s*CITA\b[^\]]*$/gi, "")    // [CITA: ... truncada (sin cierre)
    .replace(/\[\s*NOMBRE\b[^\]]*\]/gi, "") // [NOMBRE: ...] completa
    .replace(/\[\s*NOMBRE\b[^\]]*$/gi, "")  // [NOMBRE: ... truncada
    .replace(/\[\s*MOSTRAR\s*\]?/gi, "")     // etiqueta interna de mostrar propiedad
    .replace(/\[\s*UBICACION\b[^\]]*\]?/gi, "")
    .replace(/\[\s*ASESOR\b[^\]]*\]?/gi, "")
    .replace(/\[\s*ESCALAR\s*\]?/gi, "")
    .replace(/\[\s*EMAIL\b[^\]]*\]?/gi, "")
    .replace(/[ \t]{2,}/g, " ")                // dobles espacios que queden
    .replace(/[ \t]+([.,;:!?])/g, "$1")         // espacio suelto antes de un signo
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  let esClienteNuevo = false;
  if (!lead) {
    esClienteNuevo = true;
    lead = upsertLead(telefono, { nombre: nombrePerfil, canal, ultimoMsgCliente: ahoraISO });
  } else {
    lead = upsertLead(telefono, {
      ultimoMsgCliente: ahoraISO,
      ...(!lead.nombre && nombrePerfil ? { nombre: nombrePerfil } : {}),
    });
  }

  // Guarda el mensaje del cliente en el historial
  pushHistorial(telefono, "user", texto);
  marcarRespuestaCampana(telefono); // si venía de una campaña, cuenta como respuesta

  // 🔔 Cliente nuevo: avisa a los celulares (el bot ya lo está atendiendo)
  if (esClienteNuevo) {
    notificar("cliente_nuevo", {
      titulo: `👋 Cliente nuevo: ${nombrePerfil || telefono}`,
      cuerpo: `"${String(texto).slice(0, 90)}"\n\nEl asistente ya lo está atendiendo.`,
      url: `/dashboard?lead=${telefono}`,
      tag: `nuevo-${telefono}`,
    }).catch(() => {});
  } else {
    // Si un asesor tomó el chat, le llega el mensaje como notificación normal.
    avisarChatHumano(lead, texto);
  }

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
    await enviarYRegistrar(canal, telefono, respuesta);

    // 🔔 Urgente: vibra distinto y se queda fija hasta que la vean
    notificar("atencion_humana", {
      titulo: `🚨 ${lead.nombre || telefono} necesita un asesor YA`,
      cuerpo: `"${String(texto).slice(0, 100)}"\n\nEl cliente está molesto. Entra al chat.`,
      url: `/dashboard?lead=${telefono}`,
      tag: `urgente-${telefono}`,
      urgente: true,
    }, lead.agenteAsignado || null).catch(() => {});

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

  // 5a) ¿El cliente eligió asesor? [ASESOR: Nombre] -> asignarlo ANTES de validar
  //     la cita, para revisar la disponibilidad de ESE asesor.
  const asesorPick = extraerAsesor(respuesta);
  if (asesorPick) {
    respuesta = asesorPick.textoLimpio;
    if (asesorPick.agenteId && asesorPick.agenteId !== lead.agenteAsignado) {
      lead = upsertLead(telefono, { agenteAsignado: asesorPick.agenteId });
    }
  }

  // 5a-mail) ¿El cliente dio su correo? Lo guardamos y le mandamos la bienvenida.
  const mailPick = extraerCorreo(respuesta);
  if (mailPick) {
    respuesta = mailPick.textoLimpio;
    if (mailPick.email && mailPick.email !== lead.email) {
      lead = upsertLead(telefono, { email: mailPick.email });
      enviarBienvenidaCorreo(lead, config).catch(() => {});
    }
  }

  // 5a-esc) El BOT decidió pasar el caso a un asesor -> etiqueta [ESCALAR].
  // Esto NO depende de detectar palabras exactas: si el modelo entendió que el
  // cliente quiere un humano (aunque lo escriba con errores), dispara la alerta.
  if (/\[ESCALAR\]/i.test(respuesta)) {
    respuesta = respuesta.replace(/\[\s*ESCALAR\s*\]/gi, "").trim();
    if (!lead.escalado) {
      lead = upsertLead(telefono, { escalado: true, temperatura: "caliente" });
      const ag = lead.agenteAsignado || asignarAgente(lead.perfil?.zona);
      if (ag && !lead.agenteAsignado) lead = upsertLead(telefono, { agenteAsignado: ag.id });
      const quien = lead.nombre || telefono;
      const aviso = `⚠️ Cliente pide un asesor\n${quien} (${telefono})\nÚltimo mensaje: "${texto}"\n\nEntra al CRM para atenderlo.`;
      const dueno = process.env.OWNER_PHONE;
      if (dueno) await enviarTextoOPlantilla(dueno, aviso, process.env.WA_TPL_ALERTA, ["Cliente pide un asesor", `${quien}: ${String(texto).slice(0, 60)}`]).catch(() => {});
      const agObj = lead.agenteAsignado ? (getAgents() || []).find((a) => a.id === lead.agenteAsignado) : null;
      if (agObj && agObj.telefono && agObj.telefono !== dueno) {
        await enviarTextoOPlantilla(agObj.telefono, aviso, process.env.WA_TPL_ALERTA, ["Cliente pide un asesor", `${quien}: ${String(texto).slice(0, 60)}`]).catch(() => {});
      }
      notificar("atencion_humana", {
        titulo: `🙋 ${quien} pide un asesor`,
        cuerpo: `"${String(texto).slice(0, 100)}"\n\nEntra al CRM para atenderlo.`,
        url: `/dashboard?lead=${telefono}`,
        tag: `urgente-${telefono}`,
        urgente: true,
      }, lead.agenteAsignado || null).catch(() => {});
      console.log(`[escalado] ${telefono} pidió asesor -> alerta enviada.`);
    }
  }

  // 5a-bis) ¿El bot quiere mostrar UNA propiedad o mandar la ubicación?
  const quiereMostrar = /\[MOSTRAR\]/i.test(respuesta);
  // Red de seguridad: si el CLIENTE pidió la ubicación (aunque el modelo no ponga
  // la etiqueta), igual mandamos el PIN.
  const clientePidioUbicacion = /(d[oó]nde\s+(est|se\s+ubic|qued|se\s+encuentr)|c[oó]mo\s+(llego|llegar|se\s+llega)|(m[aá]ndam|p[aá]sam|env[ií]am|comp[aá]rt).{0,18}ubicaci|ubicaci[oó]n\s+exacta|direcci[oó]n\s+exacta|en\s+qu[eé]\s+(calle|parte\s+exacta))/i.test(texto || "");
  const quiereUbicacion = /\[UBICACION\]/i.test(respuesta) || clientePidioUbicacion;

  // 5b) ¿El bot agendó una cita? Detecta la etiqueta oculta [CITA: YYYY-MM-DD HH:MM]
  const cita = extraerCita(respuesta);
  if (cita) {
    respuesta = cita.textoLimpio; // quita la etiqueta antes de mandársela al cliente
    if (cita.iso) { // solo si pasó la validación (no pasado, dentro de horario)
      // Red de seguridad extra: ¿ese horario está bloqueado o ya ocupado?
      // (El bot ya sabe los bloqueos por su prompt, pero puede equivocarse.)
      const choque = revisarDisponibilidad(cita.iso, lead.agenteAsignado || null, telefono);
      if (choque) {
        const hTxt = new Date(cita.iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", hour: "2-digit", minute: "2-digit" });
        respuesta = `Uy, justo ${hTxt} no tengo disponibilidad 😕 (${choque.motivo}). ¿Te acomoda otro horario? Dime cuál te queda mejor y lo agendamos. 🗓️`;
        console.log(`[cita] Rechazada por disponibilidad: ${cita.iso} — ${choque.motivo}`);
      } else {
      const yaTenia = lead.citaProgramada;
      const esReagenda = yaTenia && yaTenia !== cita.iso;
      const esMismaCita = yaTenia && yaTenia === cita.iso;

      // Solo avisamos cuando de verdad hay algo nuevo: la primera vez que se
      // agenda, o cuando el cliente la MUEVE a otra fecha. Si solo se vuelve a
      // mencionar la misma cita en la plática, NO se manda otra notificación
      // (antes se repetía y confundía al dueño y al cliente).
      if (!esMismaCita) {
        upsertLead(telefono, { citaProgramada: cita.iso, seguimientos: { recordatorioCita: false } });
        sumarResultado(telefono, "cita");   // si vino de anuncio, se le apunta
        const fechaTxt = new Date(cita.iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
        const link = gcalLink(cita.iso, `Cita: ${lead.nombre || telefono}`, `Visita agendada por el asistente. Cliente: ${lead.nombre || telefono} (${telefono}).`);
        const titulo = esReagenda ? "🔄 Cita REAGENDADA" : "📅 Cita agendada";
        let cuerpo = `Cliente: ${lead.nombre || telefono}\n`;
        if (esReagenda) {
          const antesTxt = new Date(yaTenia).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
          cuerpo += `Antes: ${antesTxt}\nAhora: ${fechaTxt}`;
        } else {
          cuerpo += fechaTxt;
        }
        const aviso = `${titulo}\n${cuerpo}\n\n➕ Agrégala a tu calendario:\n${link}`;
        // 🔔 Al celular del asesor que la va a atender
        notificar(esReagenda ? "cita_cambio" : "cita_agendada", {
          titulo: esReagenda ? `🔄 Cita movida: ${lead.nombre || telefono}` : `📅 Cita nueva: ${lead.nombre || telefono}`,
          cuerpo: esReagenda ? cuerpo.split("\n").slice(1).join(" → ") : fechaTxt,
          url: `/dashboard?lead=${telefono}`,
          tag: `cita-${telefono}`,
        }, lead.agenteAsignado || null).catch(() => {});
        enviarCorreoCita(getLead(telefono), cita.iso, config, esReagenda).catch(() => {});
        const dueno = process.env.OWNER_PHONE;
        if (dueno) await enviarTextoOPlantilla(dueno, aviso, process.env.WA_TPL_ALERTA, [titulo.replace(/[^\p{L}\s]/gu, "").trim(), `${lead.nombre || telefono} - ${fechaTxt}`]).catch(() => {});
        // También al asesor asignado, si tiene teléfono (y no es el mismo del dueño)
        const ag = lead.agenteAsignado ? (getAgents() || []).find((a) => a.id === lead.agenteAsignado) : null;
        if (ag && ag.telefono && ag.telefono !== dueno) await enviarTextoOPlantilla(ag.telefono, aviso, process.env.WA_TPL_ALERTA, [titulo.replace(/[^\p{L}\s]/gu, "").trim(), `${lead.nombre || telefono} - ${fechaTxt}`]).catch(() => {});
      }
      } // cierra el else de disponibilidad
    }
  }

  // 5c) ¿El bot captó el nombre del cliente? Detecta [NOMBRE: ...] y lo guarda.
  const nm = extraerNombre(respuesta);
  if (nm) {
    respuesta = nm.textoLimpio;
    if (nm.nombre) upsertLead(telefono, { nombre: nm.nombre });
  }

  // Limpieza final: que NUNCA se le escape una etiqueta interna al cliente.
  respuesta = limpiarEtiquetas(respuesta);

  await enviarYRegistrar(canal, telefono, respuesta);

  // 6) Manda las fotos de las propiedades que el bot acaba de presentar.
  //    Si es UNA sola propiedad, manda varias fotos de ella (hasta 4). Si son
  //    varias opciones, manda 1 foto de cada una para no saturar.
  // Solo mandamos fotos cuando el bot lo pidió con [MOSTRAR], y UNA sola propiedad
  // (la siguiente sin enviar), sin el link de mapa. Nunca varias de golpe.
  if (quiereMostrar && nuevas.length && lead.perfil.zona) {
    const prop = nuevas[0];
    const fmt = (n) => "$" + (n || 0).toLocaleString("es-MX");
    const caption = `🏡 ${prop.titulo}\n${fmt(prop.precio)}${prop.operacion === "renta" ? "/mes" : ""} · ${prop.recamaras} rec · ${prop.banos} baños · ${prop.m2} m²`;
    const fotos = (prop.imagenes || []).slice(0, 4);

    // Meta cobra por mensaje enviado. Si son varias fotos las pegamos en una
    // sola imagen: 1 mensaje en vez de 4, y el cliente las ve todas de golpe.
    let mandadas = 0;
    if (mosaicoActivo() && fotos.length > 1 && (process.env.PUBLIC_URL || DOMINIO_PROPIO)) {
      const m = await armarMosaico(fotos).catch(() => null);
      if (m) {
        const base = process.env.PUBLIC_URL || DOMINIO_PROPIO;
        const urlM = `${base}/mosaico/${m.id}.jpg`;
        const r = await enviarImagenCanal(canal, telefono, urlM, caption).catch(() => null);
        if (r && !r.error) {
          mandadas = m.cuantas;
          pushHistorial(telefono, "bot", `[${m.cuantas} fotos en una imagen] ${prop.titulo}`);
          console.log(`[mosaico] ${m.cuantas} fotos -> 1 mensaje (${prop.titulo})`);
        }
      }
    }
    // Respaldo: si el mosaico no salió, van una por una como siempre.
    if (!mandadas) {
      for (let i = 0; i < fotos.length; i++) {
        await enviarImagenCanal(canal, telefono, fotos[i], i === 0 ? caption : "");
      }
      mandadas = fotos.length;
      pushHistorial(telefono, "bot", `[${fotos.length} foto(s) enviada(s)] ${prop.titulo}`);
    }
    marcarEnviada(telefono, prop.id);
    upsertLead(telefono, { ultimaPropiedadMostrada: prop.id });
    if (prop.video) {
      await enviarVideoCanal(canal, telefono, prop.video, `🎥 Video: ${prop.titulo}`).catch(() => {});
      pushHistorial(telefono, "bot", `[video enviado] ${prop.titulo}`);
    }
  }

  // 6b) Ubicación (PIN de WhatsApp) si el bot lo pidió con [UBICACION], de la
  //     última propiedad mostrada. Si no hay coordenadas, manda la dirección.
  if (quiereUbicacion) {
    const lp = getLead(telefono);
    let prop = lp && lp.ultimaPropiedadMostrada ? getProperty(lp.ultimaPropiedadMostrada) : null;
    if (!prop) { const mm = buscarPropiedades(lp, 1); prop = mm[0] || null; } // si no se "mostró" formal, usa la más acorde
    if (prop && prop.lat && prop.lng) {
      await enviarUbicacionCanal(canal, telefono, prop.lat, prop.lng, prop.titulo, prop.direccion || "").catch(() => {});
      pushHistorial(telefono, "bot", `[📍 ubicación enviada] ${prop.titulo}`);
    } else if (prop) {
      // Sin coordenadas: mandamos un link limpio de Maps (mejor que dejarlo sin nada).
      const q = encodeURIComponent(`${prop.titulo} ${prop.zona || ""} Ciudad de México`);
      await enviarYRegistrar(canal, telefono, `📍 ${prop.titulo}\nhttps://maps.google.com/?q=${q}`);
    }
  }

  // 7) Recalcula score y temperatura, asigna agente si subió a tibio/caliente
  lead = getLead(telefono);
  const { score, temperatura } = calcularScore(lead);
  const patch = { score, temperatura };

  // 🔔 Se puso caliente por primera vez: hay que hablarle YA
  if (temperatura === "caliente" && lead.temperatura !== "caliente" && !lead.escalado) {
    const p = lead.perfil || {};
    const detalle = [
      p.zona ? `Zona: ${p.zona}` : null,
      p.presupuesto ? `Presupuesto: $${Number(p.presupuesto).toLocaleString("es-MX")}` : null,
      p.proposito ? `Busca: ${p.proposito}` : null,
    ].filter(Boolean).join(" · ");
    notificar("lead_caliente", {
      titulo: `🔥 Lead caliente: ${lead.nombre || telefono}`,
      cuerpo: (detalle || "Ya está calificado") + "\n\nEs buen momento para entrarle.",
      url: `/dashboard?lead=${telefono}`,
      tag: `caliente-${telefono}`,
    }, lead.agenteAsignado || patch.agenteAsignado || null).catch(() => {});
  }

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
// Quién soy (para que el CRM adapte la vista al rol)
app.get("/api/whoami", (req, res) => {
  res.json({ rol: req.yo.rol, id: req.yo.id, nombre: req.yo.nombre });
});

app.get("/api/leads", (req, res) => {
  const db = loadDB();
  const leads = misLeads(req, Object.values(db.leads)).sort((a, b) => b.score - a.score);
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
// Descarga TODO el respaldo (el db.json completo). Solo el dueño.
app.get("/api/backup", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const db = loadDB();
  const fecha = new Date().toISOString().slice(0, 10);
  const nombre = (getConfig().nombreAgencia || "agencia").replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="respaldo-${nombre}-${fecha}.json"`);
  res.send(JSON.stringify(db, null, 2));
});

// Restaura un respaldo (reemplaza TODO). Solo el dueño. Guarda una copia previa.
app.post("/api/backup/restaurar", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const nuevo = req.body;
  if (!nuevo || typeof nuevo !== "object" || !("leads" in nuevo)) {
    return res.status(400).json({ error: "El archivo no parece un respaldo válido" });
  }
  try {
    const previo = loadDB();
    fs.writeFileSync(path.join(DATA_DIR, `db-antes-de-restaurar-${Date.now()}.json`), JSON.stringify(previo, null, 2));
  } catch (e) { console.error("[backup] No pude guardar copia previa:", e.message); }
  saveDB(nuevo);
  res.json({ ok: true, leads: Object.keys(nuevo.leads || {}).length, propiedades: (nuevo.properties || []).length });
});

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
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  res.json(lead);
});

// El agente "toma el control" de la conversación (el bot deja de responder)
app.post("/api/leads/:telefono/tomar-control", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  upsertLead(req.params.telefono, { humanoEnControl: true });
  res.json({ ok: true });
});

// El agente devuelve el control al bot
app.post("/api/leads/:telefono/devolver-control", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  upsertLead(req.params.telefono, { humanoEnControl: false });
  res.json({ ok: true });
});

// Asignar (o reasignar) el lead a un asesor
app.post("/api/leads/:telefono/asignar", (req, res) => {
  if (!soloDueno(req, res)) return;
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  const agenteId = req.body?.agenteId || null;
  upsertLead(req.params.telefono, { agenteAsignado: agenteId });
  res.json({ ok: true });
});

// Cambiar el estado del lead (sin_atender | en_atencion | cerrado | perdido)
app.post("/api/leads/:telefono/estado", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
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
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  const propiedadId = req.body?.propiedadId || null;
  const monto = Number(req.body?.monto) || 0;
  const fecha = new Date().toISOString();
  // El asesor vendedor: el que se elija al registrar la venta, o el asignado al lead.
  const agenteId = req.body?.agenteId || lead.agenteAsignado || null;
  const agente = (getAgents() || []).find((a) => a.id === agenteId);
  upsertLead(req.params.telefono, {
    estado: "cerrado",
    venta: { propiedadId, monto, fecha, agenteId },
  });
  sumarResultado(req.params.telefono, "venta", monto);   // se le apunta al anuncio que lo trajo
  if (propiedadId) {
    updateProperty(propiedadId, {
      estado: "vendido",
      venta: {
        agenteId,
        agenteNombre: agente ? agente.nombre : null,
        monto,
        fecha,
        cliente: lead.nombre || null,
        leadTel: lead.telefono,
      },
    });
  }
  // 🔔 Aviso de venta (viene apagado por defecto; quien lo quiera lo prende)
  notificar("venta", {
    titulo: `🎉 Venta registrada`,
    cuerpo: `${lead.nombre || lead.telefono}${monto ? " · $" + monto.toLocaleString("es-MX") : ""}${agente ? "\nVendió: " + agente.nombre : ""}`,
    url: "/dashboard",
    tag: `venta-${lead.telefono}`,
  }).catch(() => {});
  res.json({ ok: true });
});

// Deshacer una venta (si se registró por error): vuelve el lead a "en atención"
// y la propiedad a "disponible".
app.post("/api/leads/:telefono/venta/deshacer", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  const propId = lead.venta?.propiedadId;
  upsertLead(req.params.telefono, { estado: "en_atencion", venta: null });
  if (propId) updateProperty(propId, { estado: "disponible", venta: null });
  res.json({ ok: true });
});

// Analítica de ventas: embudo, por asesor, por zona y totales.
app.get("/api/analytics", (req, res) => {
  const db = loadDB();
  const leads = misLeads(req, Object.values(db.leads));
  const props = db.properties || [];
  const propById = Object.fromEntries(props.map((p) => [p.id, p]));
  const agentes = db.agents || [];
  const ahora = new Date();
  const esEsteMes = (iso) => {
    const d = new Date(iso);
    return d.getFullYear() === ahora.getFullYear() && d.getMonth() === ahora.getMonth();
  };

  // VENTAS: se cuentan de DOS fuentes, sin duplicar —
  //  (a) las registradas en un lead (botón "Registrar venta"), y
  //  (b) las marcadas directo en la propiedad (botón de estado -> Vendida).
  const conVenta = leads.filter((l) => l.venta && l.estado === "cerrado");
  const ventas = conVenta.map((l) => ({
    monto: l.venta.monto || 0,
    fecha: l.venta.fecha,
    agenteId: l.venta.agenteId || l.agenteAsignado || null,
    propiedadId: l.venta.propiedadId || null,
    zona: (l.venta.propiedadId && propById[l.venta.propiedadId]?.zona) || l.perfil?.zona || null,
  }));
  const yaContadas = new Set(ventas.map((v) => v.propiedadId).filter(Boolean));
  for (const p of props) {
    const est = p.estado || (p.disponible === false ? "vendido" : "disponible");
    if (est !== "vendido" || !p.venta || yaContadas.has(p.id)) continue;
    // Si es un asesor viendo, solo cuenta las que él vendió.
    if (req.yo && req.yo.rol !== "dueno" && p.venta.agenteId !== req.yo.id) continue;
    ventas.push({
      monto: p.venta.monto || 0,
      fecha: p.venta.fecha,
      agenteId: p.venta.agenteId || null,
      propiedadId: p.id,
      zona: p.zona || null,
    });
  }
  const calificados = leads.filter((l) => l.perfil && (l.perfil.zona || l.perfil.presupuesto));
  const conCita = leads.filter((l) => l.citaProgramada);

  // Embudo
  const embudo = {
    leads: leads.length,
    calificados: calificados.length,
    citas: conCita.length,
    ventas: ventas.length,
  };

  // Totales
  const ingresos = ventas.reduce((acc, v) => acc + (v.monto || 0), 0);
  const ingresosMes = ventas.filter((v) => esEsteMes(v.fecha)).reduce((acc, v) => acc + (v.monto || 0), 0);
  const totales = {
    ventas: ventas.length,
    ingresos,
    ingresosMes,
    ticket: ventas.length ? Math.round(ingresos / ventas.length) : 0,
    conversion: leads.length ? +(ventas.length / leads.length * 100).toFixed(1) : 0,
  };

  // Por asesor
  const agentesVista = (req.yo && req.yo.rol !== "dueno") ? agentes.filter((a) => a.id === req.yo.id) : agentes;
  const porAsesor = agentesVista.map((a) => {
    const susLeads = leads.filter((l) => l.agenteAsignado === a.id);
    const susVentas = ventas.filter((v) => v.agenteId === a.id);
    return {
      id: a.id,
      nombre: a.nombre,
      leads: susLeads.length,
      citas: susLeads.filter((l) => l.citaProgramada).length,
      ventas: susVentas.length,
      ingresos: susVentas.reduce((acc, v) => acc + (v.monto || 0), 0),
    };
  }).sort((x, y) => y.ingresos - x.ingresos);

  // Por zona (según la zona de la propiedad vendida; si no, la del perfil del lead)
  const zonaNombre = Object.fromEntries((db.zones || []).map((z) => [z.slug || z.id, z.nombre]));
  const zonasAcc = {};
  for (const v of ventas) {
    const zkey = v.zona || "otra";
    if (!zonasAcc[zkey]) zonasAcc[zkey] = { zona: zonaNombre[zkey] || zkey, ventas: 0, ingresos: 0 };
    zonasAcc[zkey].ventas++;
    zonasAcc[zkey].ingresos += v.monto || 0;
  }
  const porZona = Object.values(zonasAcc).sort((x, y) => y.ingresos - x.ingresos);

  res.json({ embudo, totales, porAsesor, porZona });
});

// Guardar notas y etiquetas del lead
app.post("/api/leads/:telefono/notas", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
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
// Agenda una cita MANUAL desde el CRM (para clientes que llamaron por teléfono,
// llegaron a la oficina, etc.). Si el teléfono no existe, crea el lead.
app.post("/api/citas", (req, res) => {
  const b = req.body || {};
  const telefono = String(b.telefono || "").replace(/\D/g, "");
  const iso = b.cita;
  if (!telefono || telefono.length < 10) return res.status(400).json({ error: "Teléfono inválido" });
  if (!iso) return res.status(400).json({ error: "Falta la fecha y hora" });

  let lead = getLead(telefono);
  const esNuevo = !lead;
  if (!lead) {
    lead = upsertLead(telefono, {
      nombre: b.nombre || null,
      canal: "whatsapp",
      estado: "en_atencion",
      origen: "manual",
      perfil: b.zona ? { zona: b.zona } : {},
    });
  } else if (b.nombre && !lead.nombre) {
    lead = upsertLead(telefono, { nombre: b.nombre });
  }
  // Un asesor solo puede agendar para SUS leads (o para uno nuevo, que se le asigna).
  if (!esNuevo && !esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });

  const agenteId = b.agenteId || (req.yo.rol === "asesor" ? req.yo.id : lead.agenteAsignado) || null;
  const choque = revisarDisponibilidad(iso, agenteId, telefono);
  if (choque && !b.forzar) {
    return res.status(409).json({ error: "No disponible", motivo: choque.motivo });
  }
  const patch = { citaProgramada: iso, seguimientos: { ...(lead.seguimientos || {}), recordatorioCita: false } };
  sumarResultado(req.params.telefono, "cita");
  if (agenteId) patch.agenteAsignado = agenteId;
  if (b.notas) patch.notas = ((lead.notas || "") + "\n" + b.notas).trim();
  upsertLead(telefono, patch);
  res.json({ ok: true, creado: esNuevo, telefono });
});

app.post("/api/leads/:telefono/cita", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  let iso = req.body?.cita || null; // viene de un input datetime-local, o null para quitar
  if (iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return res.status(400).json({ error: "Fecha inválida" });
    iso = d.toISOString();
  }
  upsertLead(req.params.telefono, { citaProgramada: iso, seguimientos: { recordatorioCita: false } });
  if (iso) sumarResultado(req.params.telefono, "cita");   // si vino de anuncio, se le apunta
  res.json({ ok: true });
});

// El asesor escribe al cliente DIRECTO desde el CRM (por el canal del lead).
// Al mandar, el bot deja de responder solo (el humano tomó el control).
app.post("/api/leads/:telefono/enviar", async (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "Texto vacío" });
  await enviarYRegistrar(lead.canal, req.params.telefono, texto);
  upsertLead(req.params.telefono, { humanoEnControl: true });
  res.json({ ok: true });
});

// El asesor manda una IMAGEN o ARCHIVO al cliente desde el CRM. La foto/archivo ya
// se subió antes con /api/upload, aquí solo se manda por WhatsApp y se registra.
app.post("/api/leads/:telefono/enviar-media", async (req, res) => {
  const tel = req.params.telefono;
  const lead = getLead(tel);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  let url = String(req.body?.url || "");
  const tipo = req.body?.tipo === "documento" ? "documento" : "imagen";
  const caption = String(req.body?.caption || "").trim();
  const filename = String(req.body?.filename || "archivo").slice(0, 80);
  if (!url) return res.status(400).json({ error: "Sin archivo" });

  // WhatsApp necesita una URL pública (con dominio). Si viene relativa, la completamos.
  const urlPublica = url.startsWith("http") ? url : `${process.env.PUBLIC_URL || `https://${req.get("host")}`}${url}`;

  let r;
  if (tipo === "documento") r = await enviarDocumento(tel, urlPublica, filename, caption);
  else r = await enviarImagen(tel, urlPublica, caption);

  if (r && r.error) return res.json({ ok: false, error: "WhatsApp rechazó el envío (¿fuera de las 24 h, o URL no pública?)." });

  // Guardamos en el historial para verlo en el chat del CRM.
  const marca = tipo === "documento" ? `📎 [doc:${url}|${filename}]` : `📷 [img:${url}]`;
  pushHistorial(tel, "bot", `${marca}${caption ? " " + caption : ""}`);
  upsertLead(tel, { humanoEnControl: true });
  res.json({ ok: true });
});

// Acciones en lote: borrar o cambiar estado de varios leads seleccionados
app.post("/api/leads/bulk", (req, res) => {
  if (!soloDueno(req, res)) return;
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
  if (req.yo && req.yo.rol === "dueno") return true;
  if (req.yo) { res.status(403).json({ error: "Solo el dueño puede hacer esto" }); return false; }
  res.status(401).json({ error: "Contraseña incorrecta" });
  return false;
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

// Cargar 20 propiedades de ejemplo a demanda (para demos). No borra las que ya haya.
app.post("/api/demo-propiedades", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const agregadas = cargarPropiedadesDemoForzado();
  res.json({ ok: true, agregadas });
});

// Iniciar conversación con un número NUEVO desde el CRM. Como la persona no nos ha
// escrito, WhatsApp obliga a que el primer mensaje sea una PLANTILLA aprobada.
app.post("/api/iniciar-conversacion", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  const config = getConfig();
  let telefono = String(req.body?.telefono || "").replace(/[^0-9]/g, "");
  const nombre = (req.body?.nombre || "").trim();
  if (telefono.length < 10) return res.json({ ok: false, error: "Número inválido. Escríbelo con LADA (10 dígitos) o con el 52 al inicio." });
  // México: si son 10 dígitos, le anteponemos 521 (formato de WhatsApp).
  if (telefono.length === 10) telefono = "521" + telefono;

  const plantilla = req.body?.plantilla || process.env.WA_TPL_SEGUIMIENTO;
  if (!plantilla) {
    return res.json({ ok: false, error: "Aún no tienes una plantilla configurada. Crea la plantilla de seguimiento en Meta (Guía 6) y define WA_TPL_SEGUIMIENTO." });
  }

  const r = await enviarPlantilla(telefono, plantilla, [nombre || "", config.nombreAgencia || "la inmobiliaria"]);
  if (r && r.error) {
    return res.json({ ok: false, error: r.motivo || "WhatsApp rechazó el mensaje." });
  }

  // Creamos el lead para que aparezca en el CRM y guardamos el mensaje enviado.
  upsertLead(telefono, { nombre: nombre || null, canal: "whatsapp" });
  pushHistorial(telefono, "bot", `📤 (Mensaje de apertura enviado por plantilla "${plantilla}")`);
  res.json({ ok: true, telefono });
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
// ---- Bloqueos de horario (cuándo NO puede un asesor) ----
app.get("/api/blocks", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ blocks: getBlocks(), agents: getAgents() });
});

// Cuando se bloquea un horario, avisa a los clientes cuya cita cae en ese hueco:
// les ofrece otro asesor a la misma hora (si hay) u otro horario, libera la cita
// para que el bot la renegocie, y avisa al dueño.
async function procesarConflictosBloqueo(bloque, afectadas) {
  const config = getConfig();
  const dueno = process.env.OWNER_PHONE;
  const agBloq = bloque.agenteId ? (getAgents() || []).find((x) => x.id === bloque.agenteId) : null;
  const nombreAgBloq = agBloq ? agBloq.nombre : "el asesor";
  const avisos = [];
  for (const af of afectadas) {
    const lead = getLead(af.telefono);
    if (!lead) continue;
    const fechaTxt = new Date(af.iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    // ¿Hay otro asesor libre a la MISMA hora? (solo si el bloqueo fue de un asesor específico)
    const alt = bloque.agenteId ? asesorAlternativoLibre(af.iso, bloque.agenteId, lead.perfil && lead.perfil.zona) : null;
    const nom = lead.nombre ? ` ${lead.nombre}` : "";
    const msg = alt
      ? `¡Hola${nom}! 👋 Tuvimos un ajuste en la agenda y ${nombreAgBloq} ya no podrá atenderte el ${fechaTxt} 😕. Te puedo atender a la MISMA hora con ${alt.nombre}. ¿Te parece? Si prefieres, también te busco otro horario. Dime y lo dejamos listo 🗓️`
      : `¡Hola${nom}! 👋 Tuvimos un ajuste en la agenda y ya no podremos atender tu visita del ${fechaTxt} 😕. ¿Te acomoda otro horario? Dime cuál te queda mejor y lo reagendamos enseguida 🗓️`;
    // Liberamos la cita para que, cuando el cliente responda, el bot la renegocie.
    upsertLead(af.telefono, { citaProgramada: null, seguimientos: { ...(lead.seguimientos || {}), recordatorioCita: false } });
    await enviarTextoOPlantilla(af.telefono, msg, process.env.WA_TPL_SEGUIMIENTO, [config.nombreAgencia || "la agencia", `reagendar visita del ${fechaTxt}`]).catch(() => {});
    pushHistorial(af.telefono, "bot", msg);
    avisos.push(`${lead.nombre || af.telefono} (${fechaTxt})${alt ? ` -> ofrecido ${alt.nombre}` : ""}`);
  }
  if (dueno && avisos.length) {
    const resumen = `⚠️ Bloqueo con conflicto de citas
${nombreAgBloq} tenía ${avisos.length} cita(s) en ese horario. Se avisó a el/los cliente(s) para reagendar:
- ${avisos.join("\n- ")}`;
    await enviarTextoOPlantilla(dueno, resumen, process.env.WA_TPL_ALERTA, ["Bloqueo con conflicto de citas", `${nombreAgBloq}: ${avisos.length} cita(s)`]).catch(() => {});
  }
}

app.post("/api/blocks", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  const b = req.body || {};
  if (!b.fecha) return res.status(400).json({ error: "Falta la fecha" });
  const block = createBlock(b);
  const afectadas = citasAfectadasPorBloqueo(block);
  res.json({ ok: true, block, citasAfectadas: afectadas.length });
  // En segundo plano: avisar y reagendar (no bloquea la respuesta al CRM).
  if (afectadas.length) procesarConflictosBloqueo(block, afectadas).catch((e) => console.error("[bloqueo] conflicto:", e.message));
});

app.delete("/api/blocks/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ ok: deleteBlock(req.params.id) });
});

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
// ===========================================================================
// CORREO — el respaldo perfecto de WhatsApp. Después de 24 h Meta ya no deja
// escribir libre, pero el correo siempre llega.
// ===========================================================================
async function enviarBienvenidaCorreo(lead, config) {
  if (!correoActivo() || !lead.email) return;
  const p = lead.perfil || {};
  const detalles = [
    p.zona ? `Zona: ${p.zona}` : null,
    p.presupuesto ? `Presupuesto: $${p.presupuesto.toLocaleString("es-MX")} MXN` : null,
    p.recamaras ? `Recámaras: ${p.recamaras}` : null,
  ].filter(Boolean).join(" · ");

  const html = plantillaHTML({
    agencia: config.nombreAgencia || "la agencia",
    logoUrl: config.logoUrl || process.env.LOGO_URL || "",
    color: config.brandColor,
    titulo: "Gracias por escribirnos",
    saludo: `Hola${lead.nombre ? " " + lead.nombre : ""},`,
    cuerpo: `Guardamos tu correo para mandarte las fichas de las propiedades que te interesen, con fotos y todos los detalles.
${detalles ? "Esto es lo que buscas: " + detalles : ""}
Seguimos por WhatsApp cuando quieras.`,
    pie: `${config.nombreAgencia || "La agencia"} — puedes responder este correo si prefieres.`,
  });
  await enviarCorreo({ para: lead.email, asunto: `Gracias por escribirnos — ${config.nombreAgencia || "tu agencia"}`, html });
  pushHistorial(lead.telefono, "bot", "📩 (Correo de bienvenida enviado)");
}

// Correo de confirmación de cita
async function enviarCorreoCita(lead, iso, config, esReagenda) {
  if (!correoActivo() || !lead.email) return;
  const fechaTxt = new Date(iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const ag = lead.agenteAsignado ? (getAgents() || []).find((a) => a.id === lead.agenteAsignado) : null;
  const html = plantillaHTML({
    agencia: config.nombreAgencia || "la agencia",
    logoUrl: config.logoUrl || process.env.LOGO_URL || "",
    color: config.brandColor,
    titulo: esReagenda ? "Tu visita quedó reagendada" : "¡Tu visita está confirmada!",
    saludo: `Hola${lead.nombre ? " " + lead.nombre : ""},`,
    cuerpo: `Te esperamos el ${fechaTxt}.
${ag ? "Te va a atender " + ag.nombre + "." : ""}
Si necesitas cambiarla, contéstanos por WhatsApp y la movemos sin problema.`,
    cta: "Agregar a mi calendario",
    ctaUrl: gcalLink(iso, `Visita — ${config.nombreAgencia || "propiedad"}`, `Cita agendada. ${ag ? "Asesor: " + ag.nombre : ""}`),
    pie: `${config.nombreAgencia || "La agencia"} — nos vemos pronto.`,
  });
  await enviarCorreo({ para: lead.email, asunto: `${esReagenda ? "Cita reagendada" : "Cita confirmada"}: ${fechaTxt}`, html });
  pushHistorial(lead.telefono, "bot", "📩 (Correo de confirmación de cita enviado)");
}

// Enviar un correo a mano desde el CRM
app.post("/api/leads/:telefono/correo", async (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  if (!correoActivo()) return res.status(400).json({ error: "Falta configurar el correo (RESEND_API_KEY)" });
  const destino = (req.body?.email || lead.email || "").trim();
  const asunto = String(req.body?.asunto || "").trim();
  const cuerpo = String(req.body?.cuerpo || "").trim();
  if (!extraerEmail(destino)) return res.status(400).json({ error: "El correo no es válido" });
  if (!asunto || !cuerpo) return res.status(400).json({ error: "Falta asunto o mensaje" });

  const config = getConfig();
  const html = plantillaHTML({
    agencia: config.nombreAgencia || "la agencia",
    logoUrl: config.logoUrl || process.env.LOGO_URL || "",
    color: config.brandColor,
    titulo: asunto, saludo: `Hola${lead.nombre ? " " + lead.nombre : ""},`,
    cuerpo, pie: `${config.nombreAgencia || "La agencia"} — puedes responder este correo.`,
  });
  const r = await enviarCorreo({ para: destino, asunto, html });
  if (r.error) return res.status(502).json({ error: r.motivo || "No se pudo enviar" });
  if (!lead.email) upsertLead(req.params.telefono, { email: destino });
  pushHistorial(req.params.telefono, "bot", `📩 ${asunto}`);
  res.json({ ok: true, simulado: !!r.simulado });
});

// Guardar/actualizar el correo de un lead
app.post("/api/leads/:telefono/email", (req, res) => {
  const lead = getLead(req.params.telefono);
  if (!lead) return res.status(404).json({ error: "No encontrado" });
  if (!esMiLead(req, lead)) return res.status(403).json({ error: "Este lead no es tuyo" });
  const mail = extraerEmail(req.body?.email || "");
  if (req.body?.email && !mail) return res.status(400).json({ error: "El correo no es válido" });
  upsertLead(req.params.telefono, { email: mail });
  res.json({ ok: true, email: mail });
});

app.get("/api/correo/estado", (req, res) => {
  res.json({ activo: correoActivo(), remitente: process.env.EMAIL_FROM || "onboarding@resend.dev" });
});

// ===========================================================================
// ROI — lo que el sistema le está devolviendo al cliente, con datos REALES.
// Todo sale del historial del CRM; los supuestos (comisión, minutos por lead)
// son editables y se muestran al usuario para que sea transparente.
// ===========================================================================
app.get("/api/roi", (req, res) => {
  const db = loadDB();
  const cfg = getConfig();
  const comision = Number(cfg.roiComision) || 4;
  const mensualidad = Number(cfg.roiMensualidad) || 3000;
  const minPorLead = Number(cfg.roiMinutosPorLead) || 8;
  const leads = misLeads(req, Object.values(db.leads || {}));

  // ¿Está fuera del horario de oficina? (L-S 9:00-19:00, hora de México)
  const fueraDeHorario = (iso) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date(iso));
    const dia = p.find((x) => x.type === "weekday").value;
    const hora = parseInt(p.find((x) => x.type === "hour").value, 10);
    return dia === "Sun" || hora < 9 || hora >= 19;
  };

  let msgsCliente = 0, msgsBot = 0, msgsFuera = 0, leadsRescatados = 0, msTotalRespuesta = 0, nRespuestas = 0;
  const porHora = Array(24).fill(0);

  for (const l of leads) {
    const h = l.historial || [];
    let primero = null;
    for (let i = 0; i < h.length; i++) {
      const m = h[i];
      if (m.rol === "user") {
        msgsCliente++;
        if (!primero) primero = m.ts;
        if (m.ts && fueraDeHorario(m.ts)) msgsFuera++;
        if (m.ts) {
          const hr = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", hour: "2-digit", hour12: false }).format(new Date(m.ts)), 10);
          porHora[hr % 24]++;
        }
        // Tiempo hasta la respuesta del bot
        const sig = h[i + 1];
        if (sig && sig.rol === "bot" && m.ts && sig.ts) {
          const d = new Date(sig.ts) - new Date(m.ts);
          if (d >= 0 && d < 10 * 60 * 1000) { msTotalRespuesta += d; nRespuestas++; }
        }
      } else if (m.rol === "bot") msgsBot++;
    }
    // Un lead "rescatado" es el que escribió POR PRIMERA VEZ fuera de horario:
    // si no hubiera bot, ese mensaje habría esperado hasta el día siguiente.
    if (primero && fueraDeHorario(primero)) leadsRescatados++;
  }

  const conCita = leads.filter((l) => l.citaProgramada).length;
  const pipeline = leads.filter((l) => l.perfil?.presupuesto && l.estado !== "perdido")
    .reduce((sum, l) => sum + l.perfil.presupuesto, 0);

  // Ventas cerradas (mismas dos fuentes que el análisis)
  const props = db.properties || [];
  const ventasLead = leads.filter((l) => l.venta && l.estado === "cerrado");
  const idsContados = new Set(ventasLead.map((l) => l.venta.propiedadId).filter(Boolean));
  let montoVendido = ventasLead.reduce((s, l) => s + (l.venta.monto || 0), 0);
  let nVentas = ventasLead.length;
  for (const p of props) {
    const est = p.estado || (p.disponible === false ? "vendido" : "disponible");
    if (est !== "vendido" || !p.venta || idsContados.has(p.id)) continue;
    if (req.yo && req.yo.rol !== "dueno" && p.venta.agenteId !== req.yo.id) continue;
    montoVendido += p.venta.monto || 0; nVentas++;
  }

  // Meses que lleva operando (mínimo 1)
  const fechas = leads.map((l) => l.creado).filter(Boolean).sort();
  const desde = fechas[0] ? new Date(fechas[0]) : new Date();
  const meses = Math.max(1, Math.ceil((Date.now() - desde.getTime()) / (30 * 24 * 3600 * 1000)));

  const horasAhorradas = +((msgsCliente * minPorLead) / 60).toFixed(1);
  const comisionGenerada = Math.round(montoVendido * (comision / 100));
  const invertido = mensualidad * meses;
  const roi = invertido ? +(comisionGenerada / invertido).toFixed(1) : 0;
  const valorPipeline = Math.round(pipeline * (comision / 100));
  const segRespuesta = nRespuestas ? Math.round(msTotalRespuesta / nRespuestas / 1000) : 0;

  res.json({
    supuestos: { comision, mensualidad, minPorLead, meses },
    atencion: {
      mensajesCliente: msgsCliente, mensajesBot: msgsBot,
      mensajesFueraDeHorario: msgsFuera,
      porcentajeFuera: msgsCliente ? +(msgsFuera / msgsCliente * 100).toFixed(1) : 0,
      leadsRescatados, tiempoRespuestaSeg: segRespuesta, horasAhorradas,
    },
    resultados: {
      leads: leads.length, citas: conCita, ventas: nVentas,
      montoVendido, comisionGenerada, pipeline, valorPipeline,
    },
    retorno: { invertido, roi, mesesOperando: meses },
    porHora,
  });
});

app.put("/api/roi/supuestos", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const b = req.body || {};
  const cfg = updateConfig({
    roiComision: Math.min(Math.max(Number(b.comision) || 4, 0.5), 20),
    roiMensualidad: Math.max(Number(b.mensualidad) || 3000, 0),
    roiMinutosPorLead: Math.min(Math.max(Number(b.minPorLead) || 8, 1), 60),
  });
  res.json({ ok: true, config: cfg });
});

// ===========================================================================
// PROSPECCIÓN SALIENTE — campañas de primer contacto
// ---------------------------------------------------------------------------
// Manda la PRIMERA plantilla a una lista. Va DESPACIO a propósito: si se mandan
// cientos de mensajes de golpe, WhatsApp lo detecta como spam y puede limitar o
// tumbar el número del cliente. Mejor tardar y no arriesgar su cuenta.
// ===========================================================================
const campanasCorriendo = new Set();

async function correrCampana(campId) {
  if (campanasCorriendo.has(campId)) return;
  campanasCorriendo.add(campId);
  try {
    const config = getConfig();
    while (true) {
      const c = getCampana(campId);
      if (!c || c.estado !== "enviando") break;

      // Tope diario: si ya se cumplió, se pausa hasta mañana.
      const hoy = new Date().toISOString().slice(0, 10);
      const enviadosHoy = c.diaContador === hoy ? (c.enviadosHoy || 0) : 0;
      if (enviadosHoy >= c.maxPorDia) {
        actualizarCampana(campId, { estado: "pausada", notaPausa: `Se llegó al tope de ${c.maxPorDia} mensajes de hoy. Reanúdala mañana.` });
        console.log(`[campaña] ${c.nombre}: tope diario alcanzado.`);
        break;
      }

      const pend = c.contactos.find((x) => x.estado === "pendiente");
      if (!pend) {
        actualizarCampana(campId, { estado: "terminada" });
        console.log(`[campaña] ${c.nombre}: terminada.`);
        break;
      }

      // No le escribimos a alguien que YA es cliente activo del CRM.
      const yaExiste = getLead(pend.telefono);
      if (yaExiste && yaExiste.historial && yaExiste.historial.length > 1) {
        marcarContacto(campId, pend.telefono, "omitido", "Ya es un contacto activo");
        continue;
      }

      const r = await enviarPlantilla(pend.telefono, c.plantilla,
        [pend.nombre || "", config.nombreAgencia || "la inmobiliaria"]);

      if (r && r.error) {
        marcarContacto(campId, pend.telefono, "error", r.motivo || "WhatsApp rechazó el envío");
        // Si el error es de cuenta/token/plantilla, no tiene caso seguir: se pausa
        // y se avisa, en vez de quemar toda la lista con el mismo problema.
        const fatales = [132001, 132015, 132016, 131031, 190, 100];
        if (fatales.includes(r.code)) {
          actualizarCampana(campId, { estado: "pausada", notaPausa: r.motivo || "Error de configuración" });
          alertarDev(`campana_${r.code}`, "Se detuvo una campaña", `Campaña: "${c.nombre}"\nError ${r.code}: ${r.motivo}`,
            "alto", "Entra al CRM → Campañas para reanudarla cuando lo arregles.");
          break;
        }
      } else {
        marcarContacto(campId, pend.telefono, "enviado");
        upsertLead(pend.telefono, { nombre: pend.nombre || null, canal: "whatsapp", origen: "campaña" });
        pushHistorial(pend.telefono, "bot", `📤 (Campaña "${c.nombre}" — plantilla "${c.plantilla}")`);
      }
      await new Promise((res) => setTimeout(res, c.ritmoSegundos * 1000));
    }
  } catch (e) {
    console.error("[campaña] error:", e.message);
    actualizarCampana(campId, { estado: "pausada", notaPausa: "Se detuvo por un error: " + e.message });
  } finally {
    campanasCorriendo.delete(campId);
  }
}

function resumenCampana(c) {
  const n = (e) => c.contactos.filter((x) => x.estado === e).length;
  return {
    id: c.id, nombre: c.nombre, plantilla: c.plantilla, estado: c.estado,
    ritmoSegundos: c.ritmoSegundos, maxPorDia: c.maxPorDia, creada: c.creada,
    notaPausa: c.notaPausa || null,
    total: c.contactos.length,
    pendientes: n("pendiente"), enviados: n("enviado"), respondieron: n("respondio"),
    errores: n("error"), omitidos: n("omitido"),
    tasaRespuesta: n("enviado") + n("respondio") ? +(n("respondio") / (n("enviado") + n("respondio")) * 100).toFixed(1) : 0,
  };
}

// Cuánto lleva gastado esta agencia. Protegido con la contraseña del dueño.

// Pantalla de gasto. La abre el dueño del negocio (tú), no la agencia:
// va protegida con la contraseña de administrador en la propia liga.
app.get("/consumo", (req, res) => {
  const pass = String(req.query.pass || "");
  if (pass !== (process.env.ADMIN_PASSWORD || "")) return res.status(401).send("Contraseña incorrecta");
  const r = consumoDelMes();
  const hist = consumoHistorico();
  const n = (v) => "$" + Number(v || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const color = { ok: "#61987D", atencion: "#A28B6D", va_a_pasarse: "#A28B6D", critico: "#AF8389" };
  const texto = { ok: "Todo tranquilo", atencion: "Ojo, va a la mitad", va_a_pasarse: "Al ritmo actual se pasa", critico: "Se está comiendo el margen" };
  const vacio = !r || r.vacio;

  res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gasto · ${vacio ? "—" : r.agencia}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:'Inter',system-ui,sans-serif;background:#FAFAFA;color:#303540;line-height:1.6;
   padding:32px 20px 60px;font-feature-settings:"tnum"}
 .caja{max-width:820px;margin:0 auto}
 h1{font-size:26px;font-weight:600;letter-spacing:-.02em}
 .sub{font-size:13px;color:#6F7785;margin-bottom:26px}
 .estado{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:500;
   padding:7px 13px;border-radius:99px;margin-bottom:24px}
 .estado i{width:7px;height:7px;border-radius:50%;display:block}
 .grande{background:#fff;border:1px solid #E8EAED;border-radius:12px;padding:26px;margin-bottom:14px}
 .grande .n{font-size:44px;font-weight:600;letter-spacing:-.03em;line-height:1.1}
 .grande .l{font-size:12.5px;color:#6F7785;margin-top:4px}
 .fila{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
 .tarj{background:#fff;border:1px solid #E8EAED;border-radius:12px;padding:20px}
 .tarj .n{font-size:26px;font-weight:600;letter-spacing:-.02em}
 .tarj .l{font-size:12px;color:#6F7785;margin-top:2px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E8EAED;border-radius:12px;overflow:hidden}
 th{text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;
   color:#6F7785;padding:13px 18px;border-bottom:1px solid #E8EAED}
 td{padding:12px 18px;font-size:14px;border-bottom:1px solid #F0F2F5}
 tr:last-child td{border-bottom:none}
 td.d{text-align:right;font-variant-numeric:tabular-nums}
 .tot td{font-weight:600;background:#F8F9FB}
 h2{font-size:15px;font-weight:600;margin:32px 0 12px}
 .pie{font-size:11.5px;color:#9098A5;margin-top:26px;line-height:1.7}
</style></head><body><div class="caja">
${vacio ? `<h1>Sin consumo todavía</h1><p class="sub">Esta agencia aún no ha mandado ningún mensaje este mes.</p>` : `
<h1>${r.agencia}</h1>
<p class="sub">Gasto de ${r.mes} · dólar a $${r.tipoCambio}</p>
<div class="estado" style="background:${color[r.alerta]}22;color:${color[r.alerta]}">
  <i style="background:${color[r.alerta]}"></i>${texto[r.alerta]}</div>

<div class="grande">
  <div class="n">${n(r.costoMXN.total)}</div>
  <div class="l">gastado en lo que va del mes · proyección a fin de mes ${n(r.proyeccionFinDeMesMXN)}</div>
</div>

<div class="fila">
  <div class="tarj"><div class="n">${n(r.utilidadMXN)}</div><div class="l">te queda de los ${n(r.mensualidad)}</div></div>
  <div class="tarj"><div class="n">${r.margenPct}%</div><div class="l">de margen</div></div>
</div>
<div class="fila">
  <div class="tarj"><div class="n">${r.conversaciones}</div><div class="l">conversaciones atendidas</div></div>
  <div class="tarj"><div class="n">${r.mensajes.total}</div><div class="l">mensajes enviados</div></div>
</div>

<h2>En qué se fue</h2>
<table>
 <tr><th>Concepto</th><th style="text-align:right">Cantidad</th><th style="text-align:right">Costo</th></tr>
 <tr><td>Servidor (Railway)</td><td class="d">—</td><td class="d">${n(r.costoMXN.railway)}</td></tr>
 <tr><td>Mensajes de servicio</td><td class="d">${r.mensajes.servicio}</td><td class="d">${n(r.costoMXN.servicio)}</td></tr>
 <tr><td>Plantillas de utilidad</td><td class="d">${r.mensajes.utilidad}</td><td class="d">${n(r.costoMXN.utilidad)}</td></tr>
 <tr><td>Plantillas de marketing</td><td class="d">${r.mensajes.marketing}</td><td class="d">${n(r.costoMXN.marketing)}</td></tr>
 <tr><td>Inteligencia artificial</td><td class="d">${r.ia.llamadas} respuestas</td><td class="d">${n(r.costoMXN.ia)}</td></tr>
 <tr class="tot"><td>Total</td><td class="d"></td><td class="d">${n(r.costoMXN.total)}</td></tr>
</table>
${r.ia.fallos ? `<p class="pie">⚠️ La inteligencia artificial falló ${r.ia.fallos} ${r.ia.fallos === 1 ? "vez" : "veces"} este mes.</p>` : ""}
${hist.length > 1 ? `<h2>Meses anteriores</h2><table>
 <tr><th>Mes</th><th style="text-align:right">Conversaciones</th><th style="text-align:right">Costo</th><th style="text-align:right">Margen</th></tr>
 ${hist.slice(1).map((h) => `<tr><td>${h.mes}</td><td class="d">${h.conversaciones}</td><td class="d">${n(h.costoMXN.total)}</td><td class="d">${h.margenPct}%</td></tr>`).join("")}
</table>` : ""}
<p class="pie">Los tokens de la inteligencia artificial son los que reporta el propio proveedor, no una estimación.<br>
El precio del mensaje de servicio es el estimado; se ajusta con la variable PRECIO_MSG_SERVICIO cuando Meta publique el definitivo.</p>
`}
</div></body></html>`);
});

// Qué anuncio está trayendo clientes de verdad
app.get("/api/anuncios", (req, res) => {
  if (!soloDueno(req, res)) return;
  res.json(resumenAnuncios());
});

app.get("/api/consumo", (req, res) => {
  if (!soloDueno(req, res)) return;
  const r = consumoDelMes(req.query.mes);
  if (!r) return res.json({ vacio: true, mensaje: "Todavía no hay consumo registrado este mes." });
  res.json(r);
});
app.get("/api/consumo/historico", (req, res) => {
  if (!soloDueno(req, res)) return;
  res.json({ meses: consumoHistorico() });
});

app.get("/api/campanas/diagnostico", async (req, res) => {
  if (!soloDueno(req, res)) return;
  res.json(await plantillasAprobadas());
});
app.get("/api/campanas", (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ campanas: getCampanas().map(resumenCampana) });
});

app.get("/api/campanas/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const c = getCampana(req.params.id);
  if (!c) return res.status(404).json({ error: "No encontrada" });
  res.json({ ...resumenCampana(c), contactos: c.contactos });
});

app.post("/api/campanas", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const b = req.body || {};
  if (!b.plantilla) return res.status(400).json({ error: "Falta la plantilla aprobada de Meta" });
  if (!Array.isArray(b.contactos) || !b.contactos.length) return res.status(400).json({ error: "La lista está vacía" });
  const c = crearCampana(b);
  if (!c.contactos.length) return res.status(400).json({ error: "Ningún número de la lista es válido" });
  res.json({ ok: true, campana: resumenCampana(c) });
});

app.post("/api/campanas/:id/estado", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const accion = req.body?.accion; // iniciar | pausar
  const c = getCampana(req.params.id);
  if (!c) return res.status(404).json({ error: "No encontrada" });
  if (accion === "iniciar") {
    if (!process.env.WHATSAPP_TOKEN) return res.status(400).json({ error: "Falta conectar WhatsApp" });
    actualizarCampana(c.id, { estado: "enviando", iniciada: c.iniciada || new Date().toISOString(), notaPausa: null });
    correrCampana(c.id);
    return res.json({ ok: true, estado: "enviando" });
  }
  if (accion === "pausar") {
    actualizarCampana(c.id, { estado: "pausada", notaPausa: "Pausada manualmente" });
    return res.json({ ok: true, estado: "pausada" });
  }
  res.status(400).json({ error: "Acción no válida" });
});

app.delete("/api/campanas/:id", (req, res) => {
  if (!checarAdmin(req, res)) return;
  actualizarCampana(req.params.id, { estado: "pausada" });
  res.json({ ok: borrarCampana(req.params.id) });
});

// Estado del sistema: para revisar de un vistazo que todo esté bien.
app.get("/api/salud", (req, res) => {
  if (!checarAdmin(req, res)) return;
  const db = loadDB();
  res.json({
    ok: true,
    agencia: getConfig().nombreAgencia,
    whatsapp: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    ia: { proveedor: (process.env.IA_PROVIDER || "groq"), gemini: Boolean(process.env.GEMINI_API_KEY), groq: Boolean(process.env.GROQ_API_KEY) },
    correo: correoActivo(),
    alertas: alertasActivas() ? destinoAlertas() : false,
    datos: { leads: Object.keys(db.leads || {}).length, propiedades: (db.properties || []).length, asesores: (db.agents || []).length, campanas: (db.campanas || []).length },
    discoPersistente: Boolean(process.env.DATA_DIR),
    tiempoEncendido: Math.round(process.uptime() / 60) + " min",
  });
});

// Probar que las alertas te llegan (mándate una a ti mismo).
app.get("/api/test/alerta", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  if (!alertasActivas()) return res.json({ ok: false, error: "Falta configurar DEV_PHONE o DEV_EMAIL en Railway." });
  await alertarDev("prueba_" + Date.now(), "Prueba de alerta", "Si estás leyendo esto, las alertas funcionan correctamente.",
    "medio", "No tienes que hacer nada, era una prueba.");
  res.json({ ok: true, mensaje: "Alerta enviada a " + JSON.stringify(destinoAlertas()) });
});

app.get("/api/test/reporte", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  const r = await enviarReporteAhora();
  res.json({ ok: true, detalle: r });
});

app.get("/api/test/reporte-asesores", async (req, res) => {
  if (!checarAdmin(req, res)) return;
  res.json({ ok: true, mensaje: await enviarReporteAsesoresAhora() });
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

// ---------------------------------------------------------------------------
// Notificaciones al celular (push) — cada quien recibe lo suyo
// ---------------------------------------------------------------------------
app.get("/api/push/llave", (req, res) => {
  res.json({ publicKey: llavePublica(), avisos: AVISOS });
});

app.get("/api/push/mis-avisos", (req, res) => {
  const id = req.yo.rol === "dueno" ? "dueno" : req.yo.id;
  const subs = misSuscripciones(id);
  res.json({
    activas: subs.length,
    prefs: subs[0]?.prefs || null,
    avisos: AVISOS,
  });
});

app.post("/api/push/suscribir", (req, res) => {
  const { suscripcion, prefs } = req.body || {};
  if (!suscripcion?.endpoint) return res.status(400).json({ error: "Falta la suscripción" });
  const id = req.yo.rol === "dueno" ? "dueno" : req.yo.id;
  const reg = suscribir(id, req.yo.nombre, suscripcion, prefs);
  res.json({ ok: true, id: reg.id, prefs: reg.prefs });
});

app.post("/api/push/cancelar", (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Falta el endpoint" });
  res.json({ ok: desuscribir(endpoint) });
});

app.post("/api/push/preferencias", (req, res) => {
  const id = req.yo.rol === "dueno" ? "dueno" : req.yo.id;
  const n = guardarPrefs(id, req.body?.prefs || {});
  res.json({ ok: true, dispositivos: n });
});

app.post("/api/push/probar", async (req, res) => {
  const id = req.yo.rol === "dueno" ? "dueno" : req.yo.id;
  const r = await notificar("cliente_nuevo", {
    titulo: "🔔 Prueba de notificación",
    cuerpo: `Hola ${req.yo.nombre}, así se van a ver tus avisos.`,
    url: "/dashboard",
    tag: "prueba",
  }, id);
  res.json(r);
});

// Dashboard
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// --- PWA: permite "instalar" el CRM como app en el celular o la compu ---
app.get("/manifest.json", (req, res) => {
  const cfg = getConfig() || {};
  const propio = process.env.ICONO_DEL_CLIENTE === "1";
  const nombre = propio ? (cfg.nombreAgencia || "CRM Inmobiliario") : "Realtor Solutions AI";
  res.json({
    name: nombre,
    short_name: propio ? nombre.slice(0, 12) : "Realtor AI",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#282A47",
    theme_color: "#282A47",
    icons: [
      { src: "/pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/pwa-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  });
});
app.get("/sw.js", (req, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Cache-Control", "no-cache");
  // Service worker: habilita la instalación (PWA) y las notificaciones push.
  // NO cachea nada, para que el panel siempre cargue la versión más reciente.
  res.send(`
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {});

// Llega una notificación (aunque el CRM esté cerrado)
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (err) { d = { title: "CRM", body: "" }; }
  const opciones = {
    body: d.body || "",
    icon: "/pwa-icon-192.png",
    badge: "/pwa-icon-192.png",
    tag: d.tag || "crm",
    renotify: true,
    requireInteraction: Boolean(d.urgente),
    vibrate: d.urgente ? [200, 100, 200, 100, 200] : [120, 60, 120],
    data: { url: d.url || "/dashboard", tipo: d.tipo || "" },
    actions: [{ action: "abrir", title: "Abrir el CRM" }],
  };
  event.waitUntil(self.registration.showNotification(d.title || "CRM", opciones));
});

// El usuario toca la notificación -> abre el CRM justo en ese chat
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if (c.url.includes("/dashboard") && "focus" in c) {
          c.postMessage({ tipo: "abrir", url: destino });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })
  );
});
`.trim());
});
// WhatsApp descarga el mosaico de aquí. No lleva contraseña: la liga es un
// hash impredecible y el contenido caduca a las 12 horas.
app.get("/mosaico/:id.jpg", (req, res) => {
  const buf = leerMosaico(String(req.params.id).replace(/[^a-f0-9]/gi, ""));
  if (!buf) return res.status(404).send("No disponible");
  res.set("Content-Type", "image/jpeg").set("Cache-Control", "public, max-age=43200").send(buf);
});

app.get("/favicon.svg", (req, res) => {
  res.set("Content-Type", "image/svg+xml").set("Cache-Control", "public, max-age=86400");
  res.send(`<svg viewBox="0 0 384 384" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#282A47" d="M 192 25.363281 L 19.207031 161.136719 L 62.257812 161.136719 L 192 59.191406 L 321.742188 161.136719 L 364.792969 161.136719 Z M 192 25.363281"/><path fill="#282A47" d="M 253.183594 43.214844 L 287.871094 43.214844 C 288.542969 43.214844 289.1875 43.480469 289.664062 43.957031 C 290.136719 44.433594 290.402344 45.078125 290.398438 45.75 L 290.398438 103.898438 L 250.65625 103.898438 L 250.65625 45.75 C 250.65625 45.078125 250.921875 44.433594 251.394531 43.957031 C 251.871094 43.480469 252.511719 43.214844 253.183594 43.214844 Z M 253.183594 43.214844"/><path fill="#282A47" d="M 163.433594 216.351562 C 163.433594 222.246094 158.652344 227.023438 152.761719 227.023438 C 146.867188 227.023438 142.085938 222.246094 142.085938 216.351562 C 142.085938 210.457031 146.867188 205.679688 152.761719 205.679688 C 158.652344 205.679688 163.433594 210.457031 163.433594 216.351562 Z M 163.433594 216.351562"/><path fill="#282A47" d="M 202.671875 216.351562 C 202.671875 222.246094 197.894531 227.023438 192 227.023438 C 186.105469 227.023438 181.328125 222.246094 181.328125 216.351562 C 181.328125 210.457031 186.105469 205.679688 192 205.679688 C 197.894531 205.679688 202.671875 210.457031 202.671875 216.351562 Z M 202.671875 216.351562"/><path fill="#282A47" d="M 241.914062 216.351562 C 241.914062 222.246094 237.132812 227.023438 231.238281 227.023438 C 225.347656 227.023438 220.566406 222.246094 220.566406 216.351562 C 220.566406 210.457031 225.347656 205.679688 231.238281 205.679688 C 237.132812 205.679688 241.914062 210.457031 241.914062 216.351562 Z M 241.914062 216.351562"/><path fill="none" stroke="#282A47" stroke-width="26.595" stroke-linejoin="miter" d="M 80.355469 132.210938 L 80.355469 272.28125 C 80.355469 278.179688 82.699219 283.835938 86.871094 288.007812 C 91.042969 292.179688 96.699219 294.523438 102.601562 294.523438 L 132.234375 294.523438 L 132.234375 333.660156 L 190.378906 294.523438 L 281.398438 294.523438 C 287.300781 294.523438 292.957031 292.179688 297.128906 288.007812 C 301.300781 283.835938 303.644531 278.179688 303.644531 272.28125 L 303.644531 132.210938"/><path fill="#00AEB4" d="M 203.503906 119.265625 C 203.503906 125.617188 198.355469 130.769531 192 130.769531 C 185.644531 130.769531 180.496094 125.617188 180.496094 119.265625 C 180.496094 112.910156 185.644531 107.761719 192 107.761719 C 198.355469 107.761719 203.503906 112.910156 203.503906 119.265625 Z M 203.503906 119.265625"/></svg>`);
});
// El ícono de la app instalada: por ahora SIEMPRE el nuestro.
// Si algún día quieres que sea el de cada agencia, pon ICONO_DEL_CLIENTE=1
// y usará su logoUrl cuando lo tenga configurado.
app.get(["/pwa-icon-192.png", "/pwa-icon-512.png", "/apple-touch-icon.png"], (req, res) => {
  if (process.env.ICONO_DEL_CLIENTE === "1") {
    const logo = getConfig()?.logoUrl;
    if (logo && /^https?:\/\//i.test(logo)) return res.redirect(302, logo);
  }
  const f = req.path.includes("512") ? "pwa-icon-512.png" : "pwa-icon-192.png";
  res.sendFile(path.join(__dirname, f));
});

// Salud del servidor
app.get("/", (req, res) => res.send("Bot inmobiliario activo ✅. Ve a /dashboard o /admin"));

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  seedAgentesDemo();       // crea agentes de ejemplo si no hay
  instalarCazadorDeErrores();
seedPropiedadesDemo();
backfillCoordsDemo();   // crea propiedades de ejemplo si no hay
  seedZonasDemo();         // crea zonas de ejemplo si no hay
  iniciarCronJobs();       // activa seguimientos automáticos
  console.log(`🚀 Bot inmobiliario corriendo en puerto ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   Admin:     http://localhost:${PORT}/admin`);
});
