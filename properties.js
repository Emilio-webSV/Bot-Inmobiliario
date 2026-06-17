// properties.js
// ---------------------------------------------------------------------------
// Busca propiedades que le queden al perfil del cliente y arma el texto que el
// bot usa para recomendarlas (sin inventar nada: solo propiedades reales que la
// agencia dio de alta en el panel de admin).
// ---------------------------------------------------------------------------

import { getProperties, loadDB, saveDB } from "./store.js";

// Devuelve las mejores propiedades disponibles para el perfil del lead
export function buscarPropiedades(lead, limite = 3) {
  const p = lead.perfil || {};
  let props = getProperties().filter((x) => x.disponible !== false && x.imagenes.length >= 0);

  // Puntaje de coincidencia para ordenar
  const scored = props.map((prop) => {
    let s = 0;
    if (p.zona && prop.zona === p.zona) s += 50;          // misma zona = lo más importante
    if (p.recamaras && prop.recamaras >= p.recamaras) s += 20;
    if (p.recamaras && prop.recamaras === p.recamaras) s += 10;
    if (p.presupuesto) {
      if (prop.precio <= p.presupuesto) s += 30;          // dentro de presupuesto
      else if (prop.precio <= p.presupuesto * 1.1) s += 15; // un poquito arriba
      else s -= 20;                                        // muy caro
    }
    // propósito invertir/vivir no filtra duro, pero da un empujoncito
    if (p.proposito === "invertir" && prop.operacion === "venta") s += 5;
    return { prop, s };
  });

  return scored
    .filter((x) => x.s > 0)        // que al menos coincida en algo
    .sort((a, b) => b.s - a.s)
    .slice(0, limite)
    .map((x) => x.prop);
}

// Texto compacto para inyectar al prompt del bot (para que recomiende reales)
export function contextoPropiedades(props) {
  if (!props.length) return "";
  const fmt = (n) => "$" + (n || 0).toLocaleString("es-MX");
  const lineas = props.map((p, i) => {
    return `${i + 1}. ${p.titulo} — ${p.tipo} en ${p.zona || "zona N/D"}, ${p.operacion}. ${fmt(p.precio)}${p.operacion === "renta" ? "/mes" : ""}, ${p.recamaras} rec, ${p.banos} baños, ${p.m2} m². ${p.descripcion}`;
  });
  return `PROPIEDADES REALES DISPONIBLES QUE LE PUEDES OFRECER (NO inventes otras):
${lineas.join("\n")}

Si alguna le queda al cliente, menciónala con naturalidad (nombre y precio). Las fotos se le envían aparte automáticamente, así que puedes decir algo como "te paso unas fotos".`;
}

// Marca una propiedad como ya enviada a un lead (para no repetir fotos)
export function marcarEnviada(telefono, propId) {
  const db = loadDB();
  const lead = db.leads[telefono];
  if (!lead) return;
  lead.propiedadesEnviadas = lead.propiedadesEnviadas || [];
  if (!lead.propiedadesEnviadas.includes(propId)) {
    lead.propiedadesEnviadas.push(propId);
    saveDB(db);
  }
}

// Crea propiedades de ejemplo si no hay ninguna (para que el demo funcione solo)
export function seedPropiedadesDemo() {
  const db = loadDB();
  if ((db.properties || []).length > 0) return;
  db.properties = [
    {
      id: "pdemo1",
      titulo: "Depto de lujo en Polanco",
      zona: "polanco",
      tipo: "departamento",
      operacion: "venta",
      precio: 5200000,
      recamaras: 2,
      banos: 2,
      m2: 95,
      descripcion: "Excelente ubicación, edificio con amenidades, listo para habitar.",
      imagenes: ["https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=800"],
      disponible: true,
      creado: new Date().toISOString(),
    },
    {
      id: "pdemo2",
      titulo: "Departamento moderno en Reforma",
      zona: "reforma",
      tipo: "departamento",
      operacion: "venta",
      precio: 3100000,
      recamaras: 1,
      banos: 1,
      m2: 60,
      descripcion: "Torre nueva con vista a la ciudad, ideal para inversión.",
      imagenes: ["https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800"],
      disponible: true,
      creado: new Date().toISOString(),
    },
    {
      id: "pdemo3",
      titulo: "Casa familiar en Del Valle",
      zona: "delvalle",
      tipo: "casa",
      operacion: "venta",
      precio: 6800000,
      recamaras: 3,
      banos: 3,
      m2: 180,
      descripcion: "Casa amplia con jardín, cerca de escuelas y excelente conectividad.",
      imagenes: ["https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800"],
      disponible: true,
      creado: new Date().toISOString(),
    },
  ];
  saveDB(db);
  console.log("[properties] Propiedades demo creadas.");
}
