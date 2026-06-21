// canales.js — Enruta el envío al canal correcto del cliente.
// WhatsApp usa whatsapp.js; Messenger e Instagram usan meta.js.
// Así el resto del código solo dice "manda esto a este lead" sin preocuparse del canal.

import { enviarTexto, enviarImagen } from "./whatsapp.js";
import { enviarMetaTexto, enviarMetaImagen } from "./meta.js";

export async function enviarTextoCanal(canal, id, texto) {
  if (canal === "instagram" || canal === "messenger") return enviarMetaTexto(id, texto);
  return enviarTexto(id, texto); // whatsapp por defecto
}

export async function enviarImagenCanal(canal, id, url, caption) {
  if (canal === "instagram" || canal === "messenger") return enviarMetaImagen(id, url, caption);
  return enviarImagen(id, url, caption); // whatsapp por defecto
}
