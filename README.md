# Leemos

Práctica de lectura por sílabas, en **castellano y catalán**, para niños que empiezan a leer. Web instalable (PWA), sin build, sin servidor y sin cuentas: todo el progreso vive en el dispositivo.

## Puesta en marcha
Requisitos: Node 20 o superior. ffmpeg es opcional pero recomendable (recorta silencios y normaliza el volumen de los audios generados).

```bash
npm install        # solo instala jsdom para las pruebas
npm run dev        # http://localhost:5173
npm test           # pruebas de humo
```

## Voz de calidad: generar los audios una vez
La app reproduce, por este orden: **tu grabación** (botón «Grabar mi voz» en el panel de padres) → **clip generado** (`audio/<idioma>/*.mp3`) → **voz del navegador**. Los clips se generan una sola vez y se guardan en el proyecto; la app no llama a ningún servicio de voz mientras se usa.

1. **Calcula el trabajo:**
   ```bash
   npm run audio:plan
   ```
   Con los datos actuales son **735 clips y unos 3.000 caracteres** enviados al proveedor en total.
2. **Configura un proveedor:** `cp .env.example .env` y rellena solo el que vayas a usar.
3. **Prueba primero con poco**, un idioma y un nivel de referencia:
   ```bash
   npm run audio -- --provider elevenlabs --lang es --limit 30
   npm run dev      # y abre /tools/review.html para escucharlos
   ```
4. **Afina las sílabas sueltas** (lo más difícil para cualquier voz sintética): cambia `scripts/spoken.mjs` o añade excepciones en `src/data/pronunciation.<idioma>.json`, y regenera solo lo marcado:
   ```bash
   npm run audio -- --provider elevenlabs --lang es --only "ma,me,mi" --force
   ```
5. **Genera todo** cuando estés contento: `npm run audio -- --provider <p>` (omite lo que ya existe; `--force` regenera todo).
6. Sube a git la carpeta `audio/`: es parte de la app.

Sin claves puedes probar todo el pipeline con `--provider mock` (pitidos; necesita ffmpeg).

| Proveedor | Notas |
|---|---|
| `elevenlabs` | La voz más natural y expresiva. **Comprueba qué modelo soporta catalán hoy** (`ELEVENLABS_MODEL`) y elige una voz que lo hable bien. |
| `azure` | Voces neuronales `es-ES` y `ca-ES` (por defecto Elvira y Joana). SSML para controlar la pronunciación de cada sílaba. |
| `google` | Punto intermedio; revisa la lista actual de voces `es-ES` y `ca-ES`. |
| `piper` | Gratis y local, pero suena menos natural. Necesita el binario `piper`, un modelo `.onnx` por idioma y ffmpeg. |
| `edge` | **Gratis, sin cuenta ni tarjeta.** Mismas voces neuronales que Azure (Elvira, Joana), vía la función "Leer en voz alta" de Microsoft Edge. Protocolo no oficial (ingeniería inversa): puede dejar de funcionar sin aviso si Microsoft lo cambia. Probado y funcionando a fecha de este commit. |

**Aviso:** los cuatro proveedores reales se escribieron siguiendo su documentación pública pero **no se han probado con claves reales**. El proveedor `mock` y el resto del pipeline sí están probados. Si una llamada falla, el mensaje de error del proveedor se imprime tal cual.

**Sobre el catalán mallorquín:** no se conoce ninguna voz neuronal comercial de balear; todas son de catalán central. Para el acento de casa, graba tú las palabras con la app.

Las frases de ánimo llevan el nombre («¡Muy bien, Elsa!»). Se generan con `NAME` del `.env` (por defecto Elsa). Si en la app se cambia el nombre, esas frases usan la voz del navegador.

## Publicar e instalar en la tablet
Es un sitio estático: sirve cualquier hosting con **https** (Netlify, Cloudflare Pages, GitHub Pages…). Hace falta https para el micrófono y el modo offline. Una vez abierta en la tablet, «Añadir a pantalla de inicio» la instala; tras la primera visita con conexión, descarga los audios y funciona sin internet.

## Personalizar contenido
- Palabras y sílabas: `src/data/levels.<idioma>.json`. El campo `g` etiqueta la palabra con mundos (ids de `worlds.json`, separados por espacios) para que salga más en ese paisaje.
- Textos de interfaz: `src/data/i18n.<idioma>.json` (mismas claves en los dos).
- Mundos y pegatinas: `worlds.json`, `stickers.json`.
- Tras cambiar palabras: `npm run audio:plan` y `npm run audio` generan solo los clips nuevos.

Más contexto de diseño y pedagogía en `CLAUDE.md`.
