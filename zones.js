// lib/zones.js
// ---------------------------------------------------------------------------
// INTELIGENCIA DE ZONA — este es tu diferenciador. El bot habla como experto
// local porque conoce precios, tendencias y perfil de comprador por colonia.
//
// IMPORTANTE: estos números son referencias de ejemplo para CDMX. Antes de
// vender a un cliente, actualízalos con datos reales de SU zona (Inmuebles24,
// Lamudi, Propiedades.com). Eso es justo lo que hace al bot irremplazable:
// nadie más tiene la data calibrada de tu cliente.
// ---------------------------------------------------------------------------

export const ZONAS = {
  polanco: {
    nombre: "Polanco",
    precioM2: 95000,            // MXN por m² (referencia)
    rentaPromedio: 45000,        // renta mensual depto 2 rec
    tendencia: "estable-alta",   // subiendo | estable-alta | estable | bajando
    diasCierrePromedio: 75,
    perfilComprador: "ejecutivos, inversionistas, extranjeros; busca lujo y ubicación",
    tipico: "departamentos de lujo, 2-3 recámaras, amenidades premium",
  },
  chapultepec: {
    nombre: "Bosques de Chapultepec / Lomas",
    precioM2: 78000,
    rentaPromedio: 38000,
    tendencia: "subiendo",
    diasCierrePromedio: 80,
    perfilComprador: "familias de alto poder adquisitivo, busca espacio y seguridad",
    tipico: "casas y departamentos amplios, jardín, seguridad privada",
  },
  reforma: {
    nombre: "Paseo de la Reforma / Cuauhtémoc",
    precioM2: 72000,
    rentaPromedio: 32000,
    tendencia: "subiendo",
    diasCierrePromedio: 65,
    perfilComprador: "jóvenes profesionistas, inversionistas en renta, corporativos",
    tipico: "departamentos modernos en torre, 1-2 recámaras, vista a la ciudad",
  },
  condesa: {
    nombre: "Condesa / Roma",
    precioM2: 68000,
    rentaPromedio: 28000,
    tendencia: "estable-alta",
    diasCierrePromedio: 60,
    perfilComprador: "creativos, expats, inversionistas en renta corta (Airbnb)",
    tipico: "departamentos con estilo, edificios art déco, lofts",
  },
  delvalle: {
    nombre: "Del Valle / Nápoles",
    precioM2: 58000,
    rentaPromedio: 24000,
    tendencia: "estable",
    diasCierrePromedio: 55,
    perfilComprador: "familias clase media-alta, primer comprador con buen ingreso",
    tipico: "departamentos familiares, buena conectividad, escuelas cerca",
  },
  santafe: {
    nombre: "Santa Fe",
    precioM2: 52000,
    rentaPromedio: 26000,
    tendencia: "estable",
    diasCierrePromedio: 70,
    perfilComprador: "ejecutivos que trabajan en corporativos de la zona",
    tipico: "departamentos en torre, plusvalía corporativa, amenidades",
  },
};

// Normaliza texto del cliente a una llave de zona conocida
export function detectarZona(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  if (t.includes("polanco")) return "polanco";
  if (t.includes("chapultepec") || t.includes("lomas")) return "chapultepec";
  if (t.includes("reforma") || t.includes("cuauhtemoc") || t.includes("cuauhtémoc")) return "reforma";
  if (t.includes("condesa") || t.includes("roma")) return "condesa";
  if (t.includes("valle") || t.includes("napoles") || t.includes("nápoles")) return "delvalle";
  if (t.includes("santa fe") || t.includes("santafe") || t.includes("santa fé")) return "santafe";
  return null;
}

// Devuelve un resumen de texto para inyectar al prompt de Gemini
export function contextoZona(zonaKey) {
  const z = ZONAS[zonaKey];
  if (!z) return "";
  return `DATOS DE ${z.nombre.toUpperCase()} (úsalos para sonar como experto local):
- Precio aprox: $${z.precioM2.toLocaleString("es-MX")} MXN/m²
- Renta promedio: $${z.rentaPromedio.toLocaleString("es-MX")} MXN/mes
- Tendencia del mercado: ${z.tendencia}
- Tiempo promedio de cierre: ${z.diasCierrePromedio} días
- Perfil de comprador típico: ${z.perfilComprador}
- Inventario típico: ${z.tipico}`;
}

// Valida si el presupuesto cuadra con la zona (en MXN, precio de compra)
export function presupuestoCuadra(zonaKey, presupuesto, recamaras = 2) {
  const z = ZONAS[zonaKey];
  if (!z || !presupuesto) return null;
  const m2Estimado = recamaras === 1 ? 55 : recamaras === 2 ? 80 : 120;
  const precioEstimado = z.precioM2 * m2Estimado;
  if (presupuesto >= precioEstimado * 0.9) return "ok";
  if (presupuesto >= precioEstimado * 0.6) return "ajustado";
  return "insuficiente";
}
