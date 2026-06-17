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
} from "./store.js";
import { generarRespuesta } from "./gemini.js";
import { enviarTexto, enviarImagen } from "./whatsapp.js";
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
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const mensaje = value?.messages?.[0];
    if (!mensaje || mensaje.type !== "text") return;

    const telefono = mensaje.from;
    const texto = mensaje.text.body;
    const nombrePerfil = value?.contacts?.[0]?.profile?.name || null;

    await procesarMensaje(telefono, texto, nombrePerfil);
  } catch (err) {
    console.error("[webhook] Error procesando mensaje:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Lógica central: qué hace el bot con cada mensaje entrante
// ---------------------------------------------------------------------------
async function procesarMensaje(telefono, texto, nombrePerfil) {
  const config = getConfig();

  // Asegura que el lead exista y guarda el nombre del perfil si aún no lo hay
  let lead = getLead(telefono);
  if (!lead) {
    lead = upsertLead(telefono, { nombre: nombrePerfil });
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
    await enviarTexto(telefono, respuesta);
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
  const respuesta = await generarRespuesta({ config, lead, propiedadesCtx });
  await enviarTexto(telefono, respuesta);
  pushHistorial(telefono, "bot", respuesta);

  // 6) Si el cliente ya está calificado (zona + presupuesto) y hay match nuevo,
  //    le manda la foto de la mejor propiedad que no le hayamos enviado antes.
  if (lead.perfil.zona && lead.perfil.presupuesto && matches.length) {
    const yaEnviadas = lead.propiedadesEnviadas || [];
    const nueva = matches.find((m) => !yaEnviadas.includes(m.id) && m.imagenes.length);
    if (nueva) {
      const fmt = (n) => "$" + (n || 0).toLocaleString("es-MX");
      const caption = `🏡 ${nueva.titulo}\n${fmt(nueva.precio)}${nueva.operacion === "renta" ? "/mes" : ""} · ${nueva.recamaras} rec · ${nueva.banos} baños · ${nueva.m2} m²`;
      await enviarImagen(telefono, nueva.imagenes[0], caption);
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
    calientes: leads.filter((l) => l.temperatura === "caliente").length,
    tibios: leads.filter((l) => l.temperatura === "tibio").length,
    frios: leads.filter((l) => l.temperatura === "frio").length,
    pipeline: leads
      .filter((l) => l.perfil?.presupuesto)
      .reduce((s, l) => s + l.perfil.presupuesto, 0),
  };

  res.json({ leads, agentes: db.agents, agentesById, metricas, config: db.config });
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

// ---------------------------------------------------------------------------
// 4) API DE PROPIEDADES (la usa el panel de admin)
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
