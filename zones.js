// zones.js
// ---------------------------------------------------------------------------
// INTELIGENCIA DE ZONA — el diferenciador. El bot habla como experto local
// porque conoce el perfil de cada colonia. Las zonas ahora viven en la base de
// datos (store.js) y se administran desde el panel: agregar/editar/borrar, y
// todo (bot, propiedades, agentes) queda sincronizado al instante.
// ---------------------------------------------------------------------------

import { getZones } from "./store.js";

// Normaliza el texto del cliente a una llave de zona conocida, buscando por las
// "palabras clave" (aliases) que el dueño definió para cada zona.
export function detectarZona(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  const zonas = getZones().filter((z) => z.activa !== false);
  for (const z of zonas) {
    for (const a of z.aliases || []) {
      if (a && t.includes(a)) return z.id;
    }
  }
  return null;
}

// Resumen de texto para inyectar al prompt del bot (sonar como experto local)
export function contextoZona(zonaKey) {
  const z = getZones().find((x) => x.id === zonaKey);
  if (!z) return "";
  let s = `DATOS DE ${(z.nombre || z.id).toUpperCase()} (úsalos para sonar como experto local):`;
  if (z.precioM2) s += `\n- Precio aprox: $${Number(z.precioM2).toLocaleString("es-MX")} MXN/m²`;
  if (z.nota) s += `\n- ${z.nota}`;
  return s;
}

// Lista de nombres de zonas activas, para decirle al bot exactamente cuáles
// maneja la agencia (y que no invente otras).
export function listaZonasNombres() {
  const nombres = getZones()
    .filter((z) => z.activa !== false)
    .map((z) => z.nombre);
  return nombres.length ? nombres.join(", ") : "(aún no hay zonas configuradas)";
}
