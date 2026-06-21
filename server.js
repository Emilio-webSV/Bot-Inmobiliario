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
import { fileURLToPath } from "url";

import {
  loadDB, upsertLead, pushHistorial, getLead, getAllLeads, getConfig, saveDB,
  getProperties, getProperty, createProperty, updateProperty, deleteProperty,
  getAgents, updateConfig, createAgent, updateAgent, deleteAgent,
} from "./store.js";
import { generarRespuesta } from "./gemini.js";
import { enviarTexto, enviarImagen } from "./whatsapp.js";
import { enviarTextoCanal, enviarImagenCanal } from "./canales.js";
import { extraerPerfil, calcularScore } from "./scoring.js";
import { analizarFrustracion } from "./frustration.js";
import { asignarAgente, seedAgentesDemo } from "./agents.js";
import { buscarPropiedades, contextoPropiedades, marcarEnviada, seedPropiedadesDemo } from "./properties.js";
import { iniciarCronJobs, enviarReporteAhora, revisarLeadsCalientesAhora } from "./followups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

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
      if (!mensaje || mensaje.type !== "text") return;
      const nombre = value?.contacts?.[0]?.profile?.name || null;
      await procesarMensaje(mensaje.from, mensaje.text.body, nombre, "whatsapp");
      return;
    }

    // --- Facebook Messenger o Instagram ---
    if (obj === "page" || obj === "instagram" || body?.entry?.[0]?.messaging) {
      const canal = obj === "instagram" ? "instagram" : "messenger";
      for (const e of body?.entry || []) {
        for (const ev of e.messaging || []) {
          const msg = ev.message;
          // Ignora "echos" (mensajes que mandamos nosotros) y lo que no sea texto
          if (!msg || msg.is_echo || !msg.text) continue;
          const remitente = ev.sender?.id;
          if (!remitente) continue;
          await procesarMensaje(remitente, msg.text, null, canal);
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
// Detecta la etiqueta oculta [CITA: YYYY-MM-DD HH:MM] que pone el bot al agendar.
// Devuelve la fecha en ISO y el texto ya sin la etiqueta, o null si no hay cita.
function extraerCita(texto) {
  const m = texto.match(/\[CITA:\s*(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})\]/i);
  if (!m) return null;
  const hh = m[2].length === 4 ? "0" + m[2] : m[2];
  const d = new Date(`${m[1]}T${hh}:00-06:00`); // hora de Ciudad de México (UTC-6)
  if (isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), textoLimpio: texto.replace(m[0], "").trim() };
}

async function procesarMensaje(telefono, texto, nombrePerfil, canal = "whatsapp") {
  const config = getConfig();

  // Asegura que el lead exista y guarda el nombre del perfil y el canal de origen
  let lead = getLead(telefono);
  if (!lead) {
    lead = upsertLead(telefono, { nombre: nombrePerfil, canal });
  } else if (!lead.nombre && nombrePerfil) {
    lead = upsertLead(telefono, { nombre: nombrePerfil });
  }

  // Guarda el mensaje del cliente en el historial
  pushHistorial(telefono, "user", texto);

  // 1) ¿Está frustrado? -> escalar a humano y no seguir con el bot
  const fr = analizarFrustracion(texto);
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
      await enviarTexto(dueno, `⚠️ Cliente requiere atención humana\n${lead.nombre || telefono}\nÚltimo mensaje: "${texto}"`);
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

  // 4) Busca propiedades reales que le queden y se las da al bot como contexto
  const matches = buscarPropiedades(lead, 3);
  const propiedadesCtx = contextoPropiedades(matches);

  // 5) Genera respuesta con el bot (ya conoce las propiedades reales)
  let respuesta = await generarRespuesta({ config, lead, propiedadesCtx });

  // 5b) ¿El bot agendó una cita? Detecta la etiqueta oculta [CITA: YYYY-MM-DD HH:MM]
  const cita = extraerCita(respuesta);
  if (cita) {
    respuesta = cita.textoLimpio; // quita la etiqueta antes de mandársela al cliente
    upsertLead(telefono, { citaProgramada: cita.iso, seguimientos: { recordatorioCita: false } });
    const dueno = process.env.OWNER_PHONE;
    const fechaTxt = new Date(cita.iso).toLocaleString("es-MX", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    if (dueno) {
      await enviarTexto(dueno, `📅 Cita agendada\nCliente: ${lead.nombre || telefono}\n${fechaTxt}`).catch(() => {});
    }
  }

  await enviarTextoCanal(canal, telefono, respuesta);
  pushHistorial(telefono, "bot", respuesta);

  // 6) Si el cliente ya está calificado (zona + presupuesto) y hay match nuevo,
  //    le manda la foto de la mejor propiedad que no le hayamos enviado antes.
  if (lead.perfil.zona && lead.perfil.presupuesto && matches.length) {
    const yaEnviadas = lead.propiedadesEnviadas || [];
    const nueva = matches.find((m) => !yaEnviadas.includes(m.id) && m.imagenes.length);
    if (nueva) {
      const fmt = (n) => "$" + (n || 0).toLocaleString("es-MX");
      const caption = `🏡 ${nueva.titulo}\n${fmt(nueva.precio)}${nueva.operacion === "renta" ? "/mes" : ""} · ${nueva.recamaras} rec · ${nueva.banos} baños · ${nueva.m2} m²`;
      await enviarImagenCanal(canal, telefono, nueva.imagenes[0], caption);
      pushHistorial(telefono, "bot", `[foto enviada] ${nueva.titulo}`);
      marcarEnviada(telefono, nueva.id);
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

  res.json({ leads, agentes: db.agents, agentesById, metricas, config: db.config });
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
      l.creado ? new Date(l.creado).toLocaleString("es-MX") : "",
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

// Panel de administración
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
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
  iniciarCronJobs();       // activa seguimientos automáticos
  console.log(`🚀 Bot inmobiliario corriendo en puerto ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   Admin:     http://localhost:${PORT}/admin`);
});
