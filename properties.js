// properties.js
// ---------------------------------------------------------------------------
// Busca propiedades que le queden al perfil del cliente y arma el texto que el
// bot usa para recomendarlas (sin inventar nada: solo propiedades reales que la
// agencia dio de alta en el panel de admin).
// ---------------------------------------------------------------------------

import { getProperties, loadDB, saveDB } from "./store.js";

// Devuelve las mejores propiedades disponibles para el perfil del lead.
// ESTRICTO: si el cliente dijo una zona, SOLO devuelve propiedades de esa zona
// (nunca de otra). Si aún no hay zona, no adivina: devuelve [].
export function buscarPropiedades(lead, limite = 3) {
  const p = lead.perfil || {};
  if (!p.zona) return []; // sin zona no presentamos nada (evita ofrecer lo que no pidió)

  let props = getProperties().filter(
    (x) => x.disponible !== false && (x.imagenes || []).length >= 0 && x.zona === p.zona
  );

  // Si el cliente busca renta o compra, solo le mostramos lo que cuadra.
  if (p.operacion) props = props.filter((x) => x.operacion === p.operacion);

  const scored = props.map((prop) => {
    let s = 10; // ya cumple la zona
    if (p.recamaras && prop.recamaras >= p.recamaras) s += 20;
    if (p.recamaras && prop.recamaras === p.recamaras) s += 10;
    if (p.presupuesto) {
      if (prop.precio <= p.presupuesto) s += 30;            // dentro de presupuesto
      else if (prop.precio <= p.presupuesto * 1.1) s += 15; // un poquito arriba
      else s -= 40;                                         // muy caro: casi descártala
    }
    if (p.proposito === "invertir" && prop.operacion === "venta") s += 5;
    return { prop, s };
  });

  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limite)
    .map((x) => x.prop);
}

// Texto compacto para inyectar al prompt del bot (para que recomiende reales).
// `featured` es la propiedad cuya foto se enviará enseguida: el bot debe hablar
// de ESA para que el texto y la foto coincidan.
export function contextoPropiedades(props, mostrar) {
  if (!props.length) {
    return `NO TIENES una propiedad que cuadre EXACTO con lo que pidió el cliente,
pero NO lo dejes ir — SIEMPRE inclínate a la venta:
- Dile con naturalidad y buena actitud que justo con esas características no tienes
  algo disponible en este momento (NUNCA inventes una propiedad ni precios).
- INMEDIATAMENTE ofrece alternativas para mantener vivo el interés: pregúntale si
  consideraría algo con recámaras/presupuesto un poco distinto, o una zona cercana
  parecida; ofrécele apuntarlo para avisarle apenas entre algo que le quede (pídele
  confirmar sus datos para el seguimiento); o invítalo a contarte más de lo que
  busca para encontrarle la mejor opción.
- Mantén el tono positivo y de asesor que quiere ayudarle a encontrar SU casa, no
  el de "no hay, adiós". El objetivo es que siga conversando y avance.
- Solo NO inventes ni le ofrezcas una propiedad específica de otra zona como si la
  tuvieras; puedes SUGERIR explorar una zona cercana, pero sin inventar inmuebles.`;
  }
  const fmt = (n) => "$" + (n || 0).toLocaleString("es-MX");
  const linea = (p) =>
    `"${p.titulo}" — ${p.tipo} en ${p.zona}, ${p.operacion}. ${fmt(p.precio)}${p.operacion === "renta" ? "/mes" : ""}, ${p.recamaras} rec, ${p.banos} baños, ${p.m2} m². ${p.descripcion}${p.direccion ? ` [Dirección exacta: ${p.direccion}]` : ""}`;

  let txt = `PROPIEDADES REALES DISPONIBLES (SOLO estas existen, NO inventes otras ni de otra zona):\n`;
  txt += props.map((p, i) => `${i + 1}. ${linea(p)}`).join("\n");

  const lista = mostrar && mostrar.length ? mostrar : [];
  if (lista.length === 1) {
    txt += `\n\nVAS A MOSTRARLE AHORITA esta propiedad (su foto se envía enseguida): "${lista[0].titulo}".
Háblale de ESA en específico (nombre, precio y por qué le puede gustar) y di que le mandas la foto.`;
  } else if (lista.length > 1) {
    txt += `\n\nVAS A MOSTRARLE AHORITA estas ${lista.length} opciones (se le envían sus fotos enseguida): ${lista
      .map((p) => `"${p.titulo}" (${fmt(p.precio)})`)
      .join(", ")}.
Preséntalas como un CONJUNTO: di algo como "te paso unas opciones que te pueden interesar 👇" y
menciona cada una breve por nombre y precio. NO te claves en una sola ni inventes otras.`;
  }
  return txt;
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
