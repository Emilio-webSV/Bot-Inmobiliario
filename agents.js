// lib/agents.js
// ---------------------------------------------------------------------------
// Asigna el lead al agente correcto según la zona de interés.
// Si nadie cubre la zona, reparte de forma rotativa (round-robin) para que
// ningún agente acapare ni se quede sin leads.
// ---------------------------------------------------------------------------

import { getAgents, loadDB, saveDB } from "./store.js";

let rrIndex = 0; // round-robin

export function asignarAgente(zonaKey) {
  const agentes = getAgents().filter((a) => a.activo !== false);
  if (agentes.length === 0) return null;

  // 1) Buscar especialista de la zona
  if (zonaKey) {
    const especialistas = agentes.filter(
      (a) => Array.isArray(a.zonas) && a.zonas.includes(zonaKey)
    );
    if (especialistas.length === 1) return especialistas[0];
    if (especialistas.length > 1) {
      // entre especialistas, el que tenga menos leads asignados
      return menosCargado(especialistas);
    }
  }

  // 2) Sin especialista -> round-robin
  const agente = agentes[rrIndex % agentes.length];
  rrIndex++;
  return agente;
}

function menosCargado(agentes) {
  const db = loadDB();
  const conteo = {};
  for (const a of agentes) conteo[a.id] = 0;
  for (const lead of Object.values(db.leads)) {
    if (lead.agenteAsignado && conteo[lead.agenteAsignado] !== undefined) {
      conteo[lead.agenteAsignado]++;
    }
  }
  return agentes.sort((a, b) => conteo[a.id] - conteo[b.id])[0];
}

// Crea agentes de ejemplo si no hay ninguno (para que el demo funcione solo)
export function seedAgentesDemo() {
  const db = loadDB();
  if (db.agents.length > 0) return;
  db.agents = [
    { id: "a1", nombre: "María López", telefono: "521555000001", zonas: ["polanco", "chapultepec"], activo: true },
    { id: "a2", nombre: "Carlos Ruiz", telefono: "521555000002", zonas: ["reforma", "condesa"], activo: true },
    { id: "a3", nombre: "Ana Torres", telefono: "521555000003", zonas: ["delvalle", "santafe"], activo: true },
  ];
  saveDB(db);
  console.log("[agents] Agentes demo creados.");
}
