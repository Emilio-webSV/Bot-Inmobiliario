// properties.js
// ---------------------------------------------------------------------------
// Busca propiedades que le queden al perfil del cliente y arma el texto que el
// bot usa para recomendarlas (sin inventar nada: solo propiedades reales que la
// agencia dio de alta en el panel de admin).
// ---------------------------------------------------------------------------

import { getProperties, loadDB, saveDB } from "./store.js";

// Coordenadas aproximadas del centro de cada colonia (para el PIN de ubicación).
// En propiedades reales, el dueño pone las exactas en el CRM.
const ZONA_COORDS = {
  polanco: [19.4333, -99.1936], chapultepec: [19.4204, -99.2160],
  reforma: [19.4270, -99.1677], condesa: [19.4110, -99.1710],
  delvalle: [19.3905, -99.1650], santafe: [19.3600, -99.2600],
};

// Rellena coordenadas de las propiedades DEMO (id "pd...") que aún no las tengan,
// según su zona. Así los pines funcionan aunque ya estuvieran guardadas de antes.
// NO toca propiedades reales del cliente (esas llevan coords exactas del CRM).
export function backfillCoordsDemo() {
  const db = loadDB();
  db.meta = db.meta || {};
  if (db.meta.demoUnicasV1) return; // ya se aplicó una vez; no vuelve a pisar tus ediciones
  const canon = {};
  for (const c of listaPropiedadesDemo()) canon[c.id] = c;
  let n = 0;
  for (const prop of (db.properties || [])) {
    const c = canon[prop.id];
    if (!c) continue; // no es una propiedad demo -> no se toca
    prop.imagenes = c.imagenes;
    prop.lat = c.lat;
    prop.lng = c.lng;
    n++;
  }
  db.meta.demoUnicasV1 = true;
  saveDB(db);
  if (n) console.log(`[properties] ${n} propiedades demo con fotos y ubicación únicas.`);
}

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
      if (prop.precio <= p.presupuesto) s += 30;             // dentro de presupuesto
      else if (prop.precio <= p.presupuesto * 1.15) s += 18; // hasta 15% arriba: se ofrece
      else if (prop.precio <= p.presupuesto * 1.3) s += 4;   // estirado: opción de respaldo
      else s -= 40;                                          // ya muy caro
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
  txt += `\n\nSÉ MUY FLEXIBLE Y SIEMPRE INCLÍNATE A LA VENTA: si alguna de estas está un poco
arriba o abajo del presupuesto del cliente, ofrécela igual como una gran opción
("por un poquito más te llevas esta que está buenísima"). Puedes decirle que el
PRECIO es NEGOCIABLE y que se le puede conseguir un mejor trato o ajuste con el
asesor. Nunca digas "no tengo nada en tu presupuesto exacto" si tienes algo
cercano: preséntalo como la mejor opción y acércalo al cierre. NUNCA inventes
precios ni propiedades, pero SÍ puedes ofrecer negociar el precio de las reales.`;

  const lista = mostrar && mostrar.length ? mostrar : [];
  if (lista.length) {
    txt += `\n\nCUANDO el cliente ACEPTE ver una opción, muéstrale UNA SOLA: la más
recomendable ahora es "${lista[0].titulo}" (${fmt(lista[0].precio)}). Habla de ESA
(nombre, precio y por qué le queda) y pon la etiqueta [MOSTRAR] al final de tu
mensaje para que el sistema le envíe SUS fotos. NUNCA muestres varias a la vez;
si el cliente quiere otra después, se la muestras una a una.`;
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
function listaPropiedadesDemo() {
  // FOTO PRINCIPAL única por propiedad (20 distintas). La primera es la que se
  // manda/ve primero, así cada propiedad se ve diferente.
  const UNICA = [
    "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=800",
    "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800",
    "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800",
    "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800",
    "https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=800",
    "https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800",
    "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800",
    "https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800",
    "https://images.unsplash.com/photo-1576941089067-2de3c901e126?w=800",
    "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800",
    "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800",
    "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800",
    "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800",
    "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=800",
    "https://images.unsplash.com/photo-1512918728675-ed5a9ecdebfd?w=800",
    "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?w=800",
    "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=800",
    "https://images.unsplash.com/photo-1600585152220-90363fe7e115?w=800",
    "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=800",
    "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?w=800",
  ];
  // Fotos de respaldo (confiables) para completar el álbum de cada propiedad.
  const RESPALDO = [
    "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=800",
    "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800",
    "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800",
    "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800",
    "https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=800",
    "https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800",
    "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800",
    "https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800",
    "https://images.unsplash.com/photo-1576941089067-2de3c901e126?w=800",
    "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800",
    "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800",
    "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800",
  ];
  // [id, título, zona, tipo, operación, precio, recámaras, baños, m2, descripción]
  const base = [
    ["pd01","Depto de lujo en Polanco","polanco","departamento","venta",5200000,2,2,95,"Edificio con amenidades premium, listo para habitar. Ubicación inmejorable."],
    ["pd02","Penthouse en Polanco","polanco","departamento","venta",9800000,3,3,180,"Penthouse con roof garden privado y vista panorámica. Acabados de lujo."],
    ["pd03","Depto amueblado en Polanco (renta)","polanco","departamento","renta",48000,2,2,90,"Totalmente amueblado, ideal para ejecutivos. Incluye mantenimiento."],
    ["pd04","Casa con jardín en Lomas","chapultepec","casa","venta",14500000,4,4,420,"Casa amplia con jardín, seguridad privada y espacio para 3 autos."],
    ["pd05","Residencia en Lomas","chapultepec","casa","venta",22000000,5,5,600,"Residencia de lujo con alberca, jardín y cuarto de servicio."],
    ["pd06","Depto amplio en Chapultepec","chapultepec","departamento","venta",7300000,3,2,150,"Departamento amplio con vista al bosque, muy iluminado."],
    ["pd07","Departamento moderno en Reforma","reforma","departamento","venta",3100000,1,1,60,"Torre nueva con vista a la ciudad, ideal para inversión o primer hogar."],
    ["pd08","Depto 2 recámaras en Reforma","reforma","departamento","venta",4600000,2,2,88,"Torre con gimnasio y coworking. Excelente plusvalía."],
    ["pd09","Estudio en Reforma (renta)","reforma","departamento","renta",18000,1,1,45,"Estudio moderno, perfecto para profesionista. Incluye amenidades."],
    ["pd10","Depto en torre Cuauhtémoc","reforma","departamento","venta",5400000,2,2,98,"Departamento en piso alto con vista despejada. Estrena."],
    ["pd11","Loft en Condesa","condesa","departamento","venta",4200000,1,1,70,"Loft con estilo en edificio art déco. Zona de cafés y parques."],
    ["pd12","Depto con terraza en Roma","condesa","departamento","venta",5900000,2,2,105,"Departamento con terraza privada, ideal para quien busca estilo."],
    ["pd13","Depto para Airbnb en Condesa","condesa","departamento","venta",3800000,1,1,55,"Excelente para renta corta. Ya operando con buen rendimiento."],
    ["pd14","Departamento en Roma Norte (renta)","condesa","departamento","renta",26000,2,1,80,"En el corazón de Roma Norte, cerca de todo. Amueblado."],
    ["pd15","Casa familiar en Del Valle","delvalle","casa","venta",6800000,3,3,220,"Casa familiar con jardín, cerca de escuelas y parques. Muy tranquila."],
    ["pd16","Depto familiar en Del Valle","delvalle","departamento","venta",4100000,3,2,110,"Departamento amplio, ideal para familia. Excelente conectividad."],
    ["pd17","Depto en Nápoles","delvalle","departamento","venta",3500000,2,2,85,"Bien ubicado, listo para habitar. Buena zona en crecimiento."],
    ["pd18","Casa en Del Valle (renta)","delvalle","casa","renta",32000,3,2,200,"Casa en renta con jardín, ideal para familia. Zona segura."],
    ["pd19","Depto en torre Santa Fe","santafe","departamento","venta",5600000,2,2,100,"En torre corporativa con amenidades. Plusvalía asegurada."],
    ["pd20","Depto amplio en Santa Fe (renta)","santafe","departamento","renta",35000,3,2,130,"Departamento amplio y amueblado, cerca de los corporativos."],
  ];
  return base.map((b, i) => {
    const [id, titulo, zona, tipo, operacion, precio, recamaras, banos, m2, descripcion] = b;
    const bc = ZONA_COORDS[zona] || [null, null];
    // Offset único por propiedad (se mantiene dentro de ~1 km del centro de la zona).
    const offLat = (((i * 37) % 21) - 10) * 0.0008;
    const offLng = (((i * 53) % 21) - 10) * 0.0008;
    return {
      id, titulo, zona, tipo, operacion, precio, recamaras, banos, m2, descripcion,
      imagenes: [UNICA[i], RESPALDO[(i + 3) % 12], RESPALDO[(i + 7) % 12]],
      lat: bc[0] != null ? +(bc[0] + offLat).toFixed(5) : null,
      lng: bc[1] != null ? +(bc[1] + offLng).toFixed(5) : null,
      disponible: true, creado: new Date().toISOString(),
    };
  });
}

// Al arrancar: solo crea las demo si la base está vacía (no toca datos de un cliente real).
export function seedPropiedadesDemo() {
  const db = loadDB();
  if ((db.properties || []).length > 0) return;
  db.properties = listaPropiedadesDemo();
  saveDB(db);
  console.log("[properties] " + db.properties.length + " propiedades demo creadas.");
}

// A demanda (botón del CRM): agrega las 20 demo que falten, SIN borrar las que ya haya.
export function cargarPropiedadesDemoForzado() {
  const db = loadDB();
  db.properties = db.properties || [];
  const existentes = new Set(db.properties.map((p) => p.id));
  let agregadas = 0;
  for (const prop of listaPropiedadesDemo()) {
    if (!existentes.has(prop.id)) { db.properties.push(prop); agregadas++; }
  }
  saveDB(db);
  return agregadas;
}

