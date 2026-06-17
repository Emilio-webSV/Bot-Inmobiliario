# 🏡 Bot Inmobiliario para Agencias

Bot de WhatsApp con inteligencia artificial que atiende, califica y da seguimiento
a los clientes de una agencia inmobiliaria 24/7. Incluye dashboard para el dueño.

> Esta es tu guía completa. Si te pierdes, **regresa siempre a este archivo**.
> Está pensada para que la sigas aunque sea tu primer proyecto.

---

## 📋 Índice
1. [Qué hace el bot](#1-qué-hace-el-bot)
2. [Qué hay dentro del proyecto](#2-qué-hay-dentro-del-proyecto)
3. [Las 5 etapas para ponerlo a funcionar](#3-las-5-etapas)
4. [Cómo probarlo](#4-cómo-probarlo)
5. [Cuánto cuesta operarlo](#5-cuánto-cuesta)
6. [Cómo personalizarlo para cada cliente](#6-personalizar-por-cliente)
7. [Si algo falla](#7-solución-de-problemas)
8. [Para cuando crezca (producción real)](#8-para-cuando-crezca)

---

## 1. Qué hace el bot

**Con el cliente final (por WhatsApp):**
- Responde 24/7 con memoria de toda la conversación
- Califica de forma natural: pregunta presupuesto, zona, recámaras, si es para vivir o invertir
- Detecta si está frustrado y lo escala a un asesor humano al instante
- Habla como experto local usando datos reales de cada zona
- Da seguimiento solo: a las 24h, 72h, y reactiva leads fríos a los 30/60/90 días
- Recuerda la cita 24h antes

**Para el dueño / agentes:**
- Asigna cada lead al agente correcto según la zona
- Le da a cada lead un **score 0-100** y una **temperatura** (🔴 caliente / 🟡 tibio / 🔵 frío)
- Avisa al agente cuando le cae un lead calificado, con todo el perfil
- Alerta al dueño si un lead caliente lleva +2h sin atender
- Manda un **reporte cada lunes** con leads nuevos, calientes y pipeline en pesos
- Dashboard web en vivo donde se ve todo y el agente puede **tomar el control** de un chat

---

## 2. Qué hay dentro del proyecto

```
bot-inmobiliario/
├── server.js          ← El servidor: recibe WhatsApp y orquesta todo
├── package.json       ← Lista de lo que el proyecto necesita instalar
├── .env.example       ← Plantilla de tus claves secretas (cópiala a .env)
├── store.js           ← Guarda leads y conversaciones (base de datos)
├── gemini.js          ← El "cerebro" (genera las respuestas)
├── whatsapp.js        ← Envía mensajes por WhatsApp
├── scoring.js         ← Califica y pone score a los leads
├── frustration.js     ← Detecta clientes molestos
├── zones.js           ← Datos de cada zona (TU diferenciador)
├── agents.js          ← Asigna leads a los agentes
├── followups.js       ← Seguimientos automáticos (los lunes, 24h, etc.)
└── dashboard.html     ← El panel del dueño
```

Todos los archivos van **en la raíz**, sin carpetas. Así no hay forma de
equivocarse al subirlos a GitHub.

**Tú NO tienes que escribir código.** Solo configurar las claves y subirlo.

---

## 3. Las 5 etapas

### ⏱️ Etapa 1 — Descarga y descomprime
Descomprime el ZIP. Vas a ver la carpeta `bot-inmobiliario` con todo lo de arriba.

---

### 🔑 Etapa 2 — Saca tus 3 llaves (haz esto PRIMERO, es lo más tardado)

Son gratis para empezar. Apúntalas en una nota, las vas a pegar en la Etapa 3.

**a) Llave de Gemini (el cerebro)**
1. Entra a https://aistudio.google.com
2. Inicia sesión con tu Gmail
3. Clic en **"Get API key"** → **"Create API key"**
4. Copia esa clave larga. → es tu `GEMINI_API_KEY`

**b) WhatsApp Cloud API (el canal)**
1. Entra a https://developers.facebook.com
2. Crea una app (tipo "Business") y agrégale el producto **WhatsApp**
3. Meta te da gratis un **número de prueba**
4. En esa pantalla copia dos cosas:
   - El **token de acceso temporal** → es tu `WHATSAPP_TOKEN`
   - El **Phone Number ID** (el ID, no el número) → es tu `WHATSAPP_PHONE_ID`
5. En "To" agrega tu número personal para poder probar (Meta lo exige en modo prueba)

> ⚠️ El token de prueba dura 24h. Para que no se venza, más adelante creas un
> "usuario de sistema" en Meta Business y generas un **token permanente**. Para
> empezar a probar, el temporal está bien.

**c) Tu número** (`OWNER_PHONE`)
Tu WhatsApp con código de país, sin signos. Ejemplo México: `5215512345678`.
Ahí te llegan las alertas de leads calientes y el reporte de los lunes.

**d) Una palabra secreta que TÚ inventas** (`WHATSAPP_VERIFY_TOKEN`)
Lo que sea, ej. `sagetech2026`. La usarás en la Etapa 4. Anótala.

---

### 🚀 Etapa 3 — Súbelo a internet (Railway)

**3.1 Sube el proyecto a GitHub**
1. Crea cuenta en https://github.com
2. Crea un repositorio nuevo (botón "New")
3. Sube ahí la carpeta del proyecto (puedes arrastrar los archivos en "uploading an existing file")

**3.2 Conéctalo a Railway**
1. Entra a https://railway.app y regístrate con GitHub
2. **New Project → Deploy from GitHub repo →** elige tu repositorio
3. Railway detecta que es Node.js e instala todo solo

**3.3 Pega tus llaves**
1. En tu proyecto de Railway, ve a la pestaña **Variables**
2. Agrega una por una (nombre = valor):
   ```
   GEMINI_API_KEY        = (tu clave de Gemini)
   GEMINI_MODEL          = gemini-2.0-flash
   WHATSAPP_TOKEN        = (tu token de WhatsApp)
   WHATSAPP_PHONE_ID     = (tu phone number id)
   WHATSAPP_VERIFY_TOKEN = (tu palabra secreta)
   OWNER_PHONE           = (tu número con código de país)
   ```
3. Railway reinicia solo. En **Settings → Networking → Generate Domain**
   obtienes tu **URL pública** (ej. `tubot.up.railway.app`). **Cópiala.**

---

### 🔗 Etapa 4 — Casa WhatsApp con tu bot

1. Regresa a Meta (developers.facebook.com), a tu app → **WhatsApp → Configuration**
2. En la sección **Webhook**, clic en "Edit":
   - **Callback URL:** tu URL de Railway + `/webhook`
     → `https://tubot.up.railway.app/webhook`
   - **Verify token:** tu palabra secreta (la misma de `WHATSAPP_VERIFY_TOKEN`)
3. Clic en **Verify and save**. Si las palabras coinciden → ✅ verificado
4. Abajo, en "Webhook fields", activa el check de **messages**

---

### 📱 Etapa 5 — Pruébalo

1. Desde tu celular, manda un WhatsApp al número de prueba de Meta
2. El bot te contesta en segundos 🎉
3. Abre tu dashboard: tu URL de Railway + `/dashboard`
   → `https://tubot.up.railway.app/dashboard`
4. Ahí ves el lead aparecer con su score y temperatura

**Orden real recomendado:** Etapa 2 (llaves) → 3 (subir) → 4 (conectar) → 5 (probar).

---

## 4. Cómo probarlo

### En tu computadora (opcional, antes de subir)
1. Instala Node.js 20+ desde https://nodejs.org
2. Abre una terminal en la carpeta del proyecto
3. Copia `.env.example` a un archivo llamado `.env` y llena tus claves
4. Corre:
   ```bash
   npm install
   npm start
   ```
5. Abre http://localhost:3000/dashboard

> Sin claves de Gemini/WhatsApp, el bot "simula" los envíos (los ves en la
> terminal). Sirve para ver que todo arranca antes de conectar lo real.

---

## 5. Cuánto cuesta

**Demo / pruebas:** $0 — todos los servicios tienen capa gratuita.

**Con cliente real (mensual aprox.):**
| Servicio | Costo |
|---|---|
| Railway | ~$150 MXN |
| WhatsApp Cloud API | ~$400–600 MXN (según volumen de conversaciones) |
| Gemini | ~$100–200 MXN |
| **Total** | **~$700–1,000 MXN/mes** |

Si cobras $2,500 MXN/mes de mensualidad, tu utilidad por cliente es de
~$1,500–1,800 MXN. Con 5 clientes: ~$9,000 MXN/mes recurrentes.

---

## 6. Personalizar por cliente

Lo que cambias para cada agencia (sin tocar lógica):

- **Nombre y tono:** edita `store.js` → `DEFAULT_DB.config`
  (o cambia el archivo `data/db.json` ya generado).
- **Agentes:** edita `agents.js` → `seedAgentesDemo()` con los nombres,
  teléfonos y zonas reales de la agencia.
- **Datos de zona (tu oro):** edita `zones.js` con los precios y tendencias
  reales de las colonias donde opera tu cliente. Esto es lo que hace al bot
  irremplazable: nadie más tiene la data calibrada de SU mercado.

---

## 7. Solución de problemas

**El webhook no verifica (❌ en Meta):**
La palabra de `WHATSAPP_VERIFY_TOKEN` en Railway debe ser **idéntica** a la que
pusiste en Meta. Sin espacios de más.

**El bot no responde:**
- Revisa que activaste el check **messages** en Meta.
- Revisa los logs en Railway (pestaña "Deployments" → "View logs").
- Confirma que tu número está en la lista "To" de Meta (modo prueba).

**Responde raro o genérico:**
Falta `GEMINI_API_KEY` o está mal copiada. Revísala en Variables de Railway.

**Los leads desaparecen al redeploy:**
Normal en el demo (se guardan en un archivo). Para producción, migra a base de
datos real (ver siguiente sección).

---

## 8. Para cuando crezca

El demo guarda todo en `data/db.json`. Funciona perfecto para arrancar y para
tus primeros clientes. Cuando tengas volumen:

1. **Fase 1 (hoy):** archivo JSON — cero costo, cero configuración ✅
2. **Fase 2:** PostgreSQL en Railway — datos seguros, no se borran al redeploy
3. **Fase 3:** AWS/Firebase — para escalar a muchos clientes

Cuando llegues a la Fase 2, solo se cambia `store.js` por una versión con
base de datos. El resto del bot queda igual.

---

¡Éxito! 🚀 Cualquier ajuste, vuelve a este archivo o pídelo.
