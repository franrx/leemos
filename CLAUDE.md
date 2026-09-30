# Leemos: contexto para Claude Code

## Qué es y para quién
App web (PWA, sin build) para que **Elsa, 6 años**, practique lectura por sílabas en **castellano y catalán**. La construyó su padre (Fran, ingeniero de software) junto con Claude en la interfaz de chat. Ahora se continúa aquí para poder usar voz de calidad, hospedarla como web instalable y seguir iterando.

Trabaja en **español** con Fran. Preferencias suyas: edición quirúrgica en vez de reconstruir, propuestas pragmáticas y ejecutables antes que elegantes, tono directo y técnico, actuar interpretando la intención en lugar de preguntar lo evidente.

## Comandos
- `npm run dev`: servidor estático en http://localhost:5173 (los service workers y el micrófono exigen localhost o https).
- `npm test`: pruebas de humo en jsdom (carga el `index.html` y `src/app.js` reales, recorre niveles, idiomas, sesión, pegatinas, prioridad de audio).
- `npm run audio:plan`: cuántos clips y caracteres se generarían. `npm run audio -- --provider <p> [--lang es|ca] [--only "ma,me"] [--force]`: genera audio (ver README).
- Revisión de clips: con `npm run dev`, abrir `/tools/review.html`.

## Arquitectura
```
index.html              marcado; carga src/app.js como módulo
src/app.js              TODA la lógica (módulo ES con top-level await; carga los JSON al arrancar)
src/styles.css          estilos (tokens claro/oscuro en :root, respeta prefers-reduced-motion)
src/data/levels.{es,ca}.json   niveles: name, sub, syl[], words[{w:"ma-no", e:"✋", g:"selva circo"}]
src/data/worlds.json    16 paisajes: id, icon, name, nameCa, a/b (colores), deco (franja de emojis)
src/data/i18n.{es,ca}.json     textos de interfaz. MISMAS claves en los dos archivos (lo comprueba npm test)
src/data/stickers.json  24 pegatinas (emoji), se ganan cada 8 aciertos
src/data/pronunciation.{es,ca}.json   sobrescribe lo que se envía al TTS para un clip concreto
scripts/                generate-audio.mjs, spoken.mjs, lib/, providers/ (elevenlabs, azure, google, edge, piper, mock), dev-server.mjs
sw.js, manifest.webmanifest, icons/    PWA instalable y offline
tools/review.html       escuchar clips, marcar los malos y copiar el comando para regenerarlos
tests/smoke.mjs         pruebas
```
Sin frameworks ni bundler, a propósito. No introducir uno sin una razón clara. `app.js` es grande (~540 líneas): trocearlo en módulos es razonable si se toca mucho, pero hacerlo en un cambio aparte y con `npm test` en verde.

## Pedagogía: decisiones que no hay que romper sin hablarlo
- **Método silábico.** El español y el catalán son transparentes; la unidad es la sílaba, no la letra.
- Progresión de 5 niveles: directas (m s l n) → más consonantes (p t b d c) → tres sílabas y f v r g j → inversas y trabadas → casos especiales (ch/tx, ll, rr, qu, gu, ñ/ny, h, ç, x…). Las palabras deben caber en el nivel.
- **El dibujo (emoji) de la palabra se revela solo después de leerla**, para que no adivine por la imagen.
- **Lee ella en voz alta; el adulto juzga** (✅ / 🔁). No hay reconocimiento de voz a propósito (falla mucho con niños de 6 años).
- **Repetición adaptativa:** peso = `max(.25, 1 + fallos*2.5 − aciertos*.35 + (sin intentos ? 1.5 : 0))`. Lo que le cuesta vuelve más.
- Dominado = `ok >= 2 && ok > fail`. La barra de cada nivel es el % de ítems dominados (sílabas + palabras).
- Sesiones de 5/10/15/20 ejercicios (por defecto 10, unos 5 minutos). La barra de sesión cuenta ejercicios hechos, no aciertos. Pegatina cada 8 aciertos.
- **Retroalimentación siempre amable:** un fallo suena suave y Lumi anima; nada de sonidos de castigo.
- Interruptor Aa: minúsculas / MAYÚSCULAS (los libros de inicio suelen ir en mayúsculas).
- **Mundos:** el nivel es la dificultad; el mundo (16 paisajes, o 🎲 Sorpresa que rota por sesión) es solo el paisaje. En modo Palabras, se prefieren las palabras etiquetadas con el mundo actual (80% con ≥3 candidatas, 40% con menos). Etiquetas = ids de `worlds.json` en el campo `g`, separadas por espacios.

## Audio: orden de prioridad (ver `say()` en app.js)
1. **Grabación del padre/madre** (IndexedDB `leemos-audio`, botón «Grabar mi voz»).
2. **Clip generado** (`audio/<lang>/<archivo>.mp3`, indexado en `audio/manifest.json`).
3. **Voz del navegador** (`speechSynthesis`), con la mejor voz disponible para el idioma.

Claves: el texto en minúsculas. En catalán, las claves de IndexedDB llevan prefijo `ca:` y las de estadísticas también (`ca:s:ma`, `ca:w:ne-na`); las del castellano no llevan prefijo (compatibilidad con progreso ya guardado, no cambiarlo).
Las frases de ánimo incluyen el nombre («¡Muy bien, Elsa!»). Los clips se generan con `NAME` (por defecto Elsa); si el nombre cambia en la app, esas frases caen a la voz del navegador.
**Lo difícil son las sílabas sueltas**: cualquier TTS puede darles entonación de pregunta o leerlas como nombre de letra. El sitio para experimentar es `scripts/spoken.mjs` (qué texto se envía por tipo de clip) y `pronunciation.*.json` (casos concretos, admite SSML en Azure/Google). Escuchar con `tools/review.html` y regenerar con `--only`.

## Persistencia
- `localStorage['leemos-v1']`: estado `S` (stats, level, mode, world, lang, name, total, progress, stickers, sound, voiceURIs, sessionLen, upper, rate, theme…). Al añadir campos, dar un valor por defecto en la línea de `Object.assign` para que no rompa estados guardados.
- No hay servidor, cuentas ni analítica. **No añadir seguimiento, anuncios ni envío de datos del niño.**

## Convenciones de UI
- Colores como tokens en `:root` con variante oscura; objetivos táctiles ≥ 44 px; foco visible; `prefers-reduced-motion` desactiva animaciones (confeti, mascota, transiciones).
- Tipografía Andika (pensada para lectores iniciales). Tiene que haber fallback.
- Al añadir texto de interfaz: clave en `i18n.es.json` **y** `i18n.ca.json`, y `data-i="clave"` en el HTML (o `t('clave')` en JS). Atributos traducibles con `data-ia="atributo:clave;otro:clave"`.
- La mascota es **Lumi**, un búho original. **No usar personajes con derechos de autor** (Frozen, etc.) aunque el nombre de la niña invite a ello.

## Pendientes, por orden
1. **Generar el audio real** y revisarlo (ver README). Empezar por un nivel y un idioma para afinar `spoken.mjs` antes de generar todo.
2. **Revisar el catalán con alguien nativo.** Palabras dudosas: *camí, dofí, cranc, espasa, ninot, formiga, pingüí, mona, mus-sol*. El nivel 1 es corto (con m s l n hay pocas palabras).
3. **Catalán mallorquín** (viven en Palma): no se conocen voces neuronales comerciales de balear; lo realista es que Fran grabe las palabras con la app («Grabar mi voz»).
4. Autohospedar la fuente Andika (licencia OFL) para que funcione 100% offline; hoy se pide a Google Fonts.
5. Frases cortas con palabras que ya domina; modo «arma la palabra» arrastrando bloques.
6. Pegatinas por mundo (granja, mar, dinosaurios) como razón extra para probar cada uno.
7. Persistir la sesión en curso; sincronizar perfil entre dispositivos (solo si Fran lo pide).
8. Pruebas e2e con un navegador real (Playwright). Hoy solo hay jsdom.

## Ojo con esto
- **Nunca se ha probado en un navegador real**, solo en jsdom. Lo primero: `npm run dev` y probarlo en la tablet de Elsa (audio, micrófono, instalación).
- Los proveedores `elevenlabs`, `azure` y `google` **no se han probado con claves reales**; sí `mock`, `edge` (funcionando, es/ca) y todo el pipeline (postprocesado, manifest, nombres con tildes). Verificar en la documentación actual del proveedor los nombres de voces/modelos y si soportan catalán.
- `app.js` es un módulo (modo estricto). `tests/smoke.mjs` lo evalúa dentro de una función async porque jsdom no ejecuta módulos.
- Si cambias la lista `SHELL` de `sw.js`, sube `VERSION`.
- El micrófono y el service worker solo funcionan en `localhost` o `https`. Una IP de red local con `http://` no sirve para probarlos en la tablet: usa un hosting con https.
