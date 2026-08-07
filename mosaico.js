// mosaico.js
// ---------------------------------------------------------------------------
// Pega hasta 4 fotos de una propiedad en UNA sola imagen.
//
// ¿Por qué existe esto? Desde el 1 de octubre de 2026 Meta cobra por cada
// mensaje que envía el negocio. Mandar 4 fotos sueltas = 4 cobros y 4
// notificaciones seguidas al cliente. Con el mosaico es 1 mensaje, 1 cobro,
// y el cliente ve las 4 de un vistazo.
//
// Si algo falla (una foto no carga, el servidor va lento), devuelve null y el
// bot manda las fotos como siempre. Nunca deja al cliente sin ver nada.
// ---------------------------------------------------------------------------

import { Jimp } from "jimp";
import { createHash } from "crypto";

const LADO = 900;                  // el mosaico final mide 900x900
const SEP = 6;                     // separación entre fotos, en píxeles
const FONDO = 0xffffffff;          // blanco
const VIDA_MS = 12 * 60 * 60e3;    // se guarda 12 horas en memoria
const LIMITE_BAJADA = 9000;        // ms por foto

const CACHE = new Map();

export const activo = () => String(process.env.MOSAICO_FOTOS ?? "1") !== "0";

export function idDe(urls) {
  return createHash("sha1").update(urls.join("|")).digest("hex").slice(0, 16);
}
export function leer(id) {
  const e = CACHE.get(id);
  if (!e) return null;
  if (Date.now() - e.hecho > VIDA_MS) { CACHE.delete(id); return null; }
  return e.buf;
}
function guardar(id, buf) {
  CACHE.set(id, { buf, hecho: Date.now() });
  if (CACHE.size > 200) {                       // no crecer sin límite
    const viejo = [...CACHE.entries()].sort((a, b) => a[1].hecho - b[1].hecho)[0];
    if (viejo) CACHE.delete(viejo[0]);
  }
}

async function abrir(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LIMITE_BAJADA);
    const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    return await Jimp.read(Buffer.from(await r.arrayBuffer()));
  } catch { return null; }
}

// Recorta al centro y ajusta a un cuadro exacto (sin deformar la foto)
function encuadrar(img, w, h) {
  return img.cover({ w, h });
}

/**
 * Arma el mosaico. Devuelve { id, buf } o null si no se pudo.
 *  1 foto  -> se manda tal cual (no hay nada que pegar)
 *  2 fotos -> una arriba, otra abajo
 *  3 fotos -> una grande a la izquierda, dos apiladas a la derecha
 *  4 fotos -> rejilla de 2x2
 */
export async function armar(urls) {
  const lista = (urls || []).filter(Boolean).slice(0, 4);
  if (lista.length < 2) return null;

  const id = idDe(lista);
  const guardado = leer(id);
  if (guardado) return { id, buf: guardado };

  const imgs = (await Promise.all(lista.map(abrir))).filter(Boolean);
  if (imgs.length < 2) return null;                    // no alcanzó, que mande normal

  const lienzo = new Jimp({ width: LADO, height: LADO, color: FONDO });
  const m = SEP / 2;
  const mitad = Math.floor((LADO - SEP) / 2);

  try {
    if (imgs.length === 2) {
      lienzo.composite(encuadrar(imgs[0], LADO, mitad), 0, 0);
      lienzo.composite(encuadrar(imgs[1], LADO, mitad), 0, mitad + SEP);
    } else if (imgs.length === 3) {
      lienzo.composite(encuadrar(imgs[0], mitad, LADO), 0, 0);
      lienzo.composite(encuadrar(imgs[1], mitad, mitad), mitad + SEP, 0);
      lienzo.composite(encuadrar(imgs[2], mitad, mitad), mitad + SEP, mitad + SEP);
    } else {
      lienzo.composite(encuadrar(imgs[0], mitad, mitad), 0, 0);
      lienzo.composite(encuadrar(imgs[1], mitad, mitad), mitad + SEP, 0);
      lienzo.composite(encuadrar(imgs[2], mitad, mitad), 0, mitad + SEP);
      lienzo.composite(encuadrar(imgs[3], mitad, mitad), mitad + SEP, mitad + SEP);
    }
    const buf = await lienzo.getBuffer("image/jpeg", { quality: 82 });
    guardar(id, buf);
    return { id, buf, cuantas: imgs.length };
  } catch (e) {
    console.error("[mosaico] No se pudo armar:", e.message);
    return null;
  }
}
