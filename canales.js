// canales.js — Enruta el envío al canal correcto del cliente.
// WhatsApp usa whatsapp.js; Messenger e Instagram usan meta.js.
// Así el resto del código solo dice "manda esto a este lead" sin preocuparse del canal.

import { enviarTexto, enviarImagen, enviarVideo, enviarUbicacion } from "./whatsapp.js";
import { enviarMetaTexto, enviarMetaImagen, enviarMetaVideo } from "./meta.js";

export async function enviarTextoCanal(canal, id, texto) {
  if (canal === "instagram" || canal === "messenger") return enviarMetaTexto(id, texto);
  return enviarTexto(id, texto); // whatsapp por defecto
}

export async function enviarImagenCanal(canal, id, url, caption) {
  if (canal === "instagram" || canal === "messenger") return enviarMetaImagen(id, url, caption);
  return enviarImagen(id, url, caption); // whatsapp por defecto
}

export async function enviarVideoCanal(canal, id, url, caption) {
  if (canal === "instagram" || canal === "messenger") return enviarMetaVideo(id, url, caption);
  return enviarVideo(id, url, caption); // whatsapp por defecto
}

export async function enviarUbicacionCanal(canal, id, lat, lng, nombre, direccion) {
  if (canal === "instagram" || canal === "messenger") {
    // Meta no manda pin nativo por aquí: mandamos un link limpio de Maps.
    return enviarMetaTexto(id, `📍 ${nombre}${direccion ? " — " + direccion : ""}\nhttps://maps.google.com/?q=${lat},${lng}`);
  }
  return enviarUbicacion(id, lat, lng, nombre, direccion); // whatsapp: PIN nativo
}
