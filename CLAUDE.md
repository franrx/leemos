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
src/data/worlds.json    16 paisajes: id, icon, name, nameCa, a/b (colores), deco (franja de emojis), stk (6 pegatinas del mundo)
src/data/i18n.{es,ca}.json     textos de interfaz. MISMAS claves en los dos archivos (lo comprueba npm test)
src/data/stickers.json  las 24 pegatinas originales (solo su orden, para migrar guardados antiguos); las pegatinas actuales están en worlds.json (campo stk: 6 por mundo, 96 en total)
src/data/pronunciation.{es,ca}.json   sobrescribe lo que se envía al TTS para un clip concreto
scripts/                generate-audio.mjs, spoken.mjs, lib/, providers/ (elevenlabs, azure, google, edge, piper, mock), dev-server.mjs
sw.js, manifest.webmanifest, icons/    PWA instalable y offline
tools/review.html       escuchar clips, marcar los malos y copiar el comando para regenerarlos
tests/smoke.mjs         pruebas
src/sounds.js           modo pre-lector (Leo): lógica pura + createSounds(ctx); app.js lo carga con import() solo si el perfil es kind:'pre'
src/data/sounds.{es,ca}.json   grupos de letras: l, w (palabra), e (emoji), ph opcional (mismo sonido: b/v, c/qu)
tests/sounds.mjs        pruebas unitarias de la lógica pura y del listado de clips
tools/record.html+.js   grabar clips con tu voz en el portátil: POST al servidor de desarrollo, que convierte a mp3, guarda en audio/ y actualiza el manifest
scripts/lib/clipstore.mjs, clipapi.mjs   lista de clips a grabar, guardado, y rutas /__clips y /__clip (solo loopback + Host/Origin locales: el servidor escucha en todas las interfaces)
tests/clipstore.mjs, tests/record.mjs    pruebas del guardado/API y de la página (jsdom con micro y servidor falsos)
src/levelrule.js        regla de colocación por nivel (sylLevel, minLevel, letterOf) y del Camino de letras (STEPS, unitsOf, stepOf); módulo puro, lo usan tests, scripts y app.js (por import())
tests/levels.mjs        pruebas de la regla, del formato de los datos, de la cobertura por letra (≥12 palabras) y de las sílabas inversas
src/merge.js            fusión pura del estado sincronizable de un niño (contadores al máximo, reset por idioma); la usan sync.js, app.js (import()) y tests
src/sync.js             cliente de Supabase con fetch (sin SDK): código por email, refresco de sesión, pull-merge-push de perfiles. app.js lo carga con import() solo si hay config
src/data/sync.config.json  {url, anonKey}; vacío = función apagada (no se carga nada ni se pide nada a terceros). En git van SOLO valores públicos: URL raíz del proyecto + clave anon (nunca service_role; lo comprueba tests/migration.mjs). Sitio publicado: https://franrx.github.io/leemos/ (GitHub Pages, rama main)
supabase/migrations/    tabla child_profiles con RLS por propietario. scripts/check-rls.mjs la verifica contra un proyecto real (lo ejecuta Fran)
tests/merge.mjs, tests/sync.mjs, tests/migration.mjs, tests/lib/fake-supabase.mjs    pruebas de la fusión (propiedades), del protocolo contra un Supabase falso y de la migración
```
Sin frameworks ni bundler, a propósito. No introducir uno sin una razón clara. `app.js` es grande (~540 líneas): trocearlo en módulos es razonable si se toca mucho, pero hacerlo en un cambio aparte y con `npm test` en verde.

## Pedagogía: decisiones que no hay que romper sin hablarlo
- **Método silábico.** El español y el catalán son transparentes; la unidad es la sílaba, no la letra.
- Progresión de 5 niveles: directas (m s l n) → más consonantes (p t b d c) → tres sílabas y f v r g j → inversas y trabadas → casos especiales (ch/tx, ll, rr, qu, gu, ñ/ny, h, ç, x…). Las palabras deben caber en el nivel.
- **El dibujo (emoji) de la palabra se revela solo después de leerla**, para que no adivine por la imagen.
- **Lee ella en voz alta; el adulto juzga** (✅ / 🔁). No hay reconocimiento de voz a propósito (falla mucho con niños de 6 años).
- **Repetición adaptativa:** peso = `max(.25, 1 + fallos*2.5 − aciertos*.35 + (sin intentos ? 1.5 : 0))`. Lo que le cuesta vuelve más.
- Dominado = `ok >= 2 && ok > fail`. La barra de cada nivel es el % de ítems dominados (sílabas + palabras).
- Sesiones de 5/10/15/20 ejercicios (por defecto 10, unos 5 minutos). La barra de sesión cuenta ejercicios hechos, no aciertos. Pegatina al terminar cada sesión, del mundo en el que juega (si ese conjunto está completo, del primer mundo incompleto; nada se bloquea). Spec: `docs/superpowers/specs/2026-10-17-world-stickers-design.md`.
- **Retroalimentación siempre amable:** un fallo suena suave y Lumi anima; nada de sonidos de castigo.
- Interruptor Aa: minúsculas / MAYÚSCULAS (los libros de inicio suelen ir en mayúsculas).
- **Leo (4 años, pre-lector):** perfil aparte (`kind:'pre'`). Asocia letra con SONIDO (fonema, no nombre). Tarjeta de presentación (letra grande, sonido, dibujo+palabra) y luego juego: suena el sonido, toca la letra entre 2 opciones (3 si ya la domina). El dibujo sale en la tarjeta a propósito (aquí no se lee). Máximo 2 letras nuevas por sesión. Grupos: vocales, m s l p, t n d c, r b f g, v j z ñ, ch ll qu (en catalán x, ll ny; sin `tx`, suena como `x` en algunos dialectos). La `h` no entra (no tiene sonido). Dos letras con el mismo `ph` nunca salen juntas; m/n, b/d, p/b y s/z solo juntas cuando ambas están dominadas. La carta de presentación no cuenta la letra como vista hasta que responde en el juego. Los padres cambian de perfil desde su panel (Leo no ve el chip 🧒). Siguiente grupo cuando ≥75% del actual está dominado.
- **Contenido alineado con el libro del cole (catalán, todo en mayúsculas).** Niveles por estructura silábica, no por tema: 1 directas m s l n; 2 +p t b d c; 3 +f v r g j y palabras de 3+ sílabas; 4 sílabas cerradas (al, am, oc…), diptongos finales (neu, bou, rei) y grupos (pl, tr, gr…); 5 grafías especiales (tx ny ll rr qu, gu+e/i, ç x z h ñ ch, c/g suaves). `src/levelrule.js` calcula el nivel mínimo y un test falla si una palabra está por debajo. La letra del libro de una palabra es su primer grafema (`letterOf`), no se guarda. Cada una de las 11 letras del libro (M P L N T S F B D R C) tiene ≥12 palabras en cada idioma. El emoji de una palabra es opcional (sin emoji, no hay hueco de dibujo). Mayúsculas por defecto; a los perfiles lector existentes se les cambió una sola vez (`S.upperMigrated`).
- **Camino de Elsa (letras en el orden del libro):** 12 pasos = M P L N T S F B D R C y «el resto» (todas las demás letras de golpe). Un ítem (sílaba o palabra) sale solo si TODAS sus consonantes están abiertas (`stepOf` en `levelrule.js`; las vocales siempre; `rr` cuenta como R; cualquier letra desconocida abre con el último paso). El nivel sigue siendo el techo de estructura y el banco es acumulativo (niveles 1..actual). No se repiten los últimos `min(6, mitad del banco)` ejercicios (en memoria). Palabras necesita ≥4 palabras abiertas; si no, el botón se atenúa y salen sílabas (la preferencia guardada no se toca). Las letras se abren solas al dominar ≥75% de lo que acaba de abrir la letra actual, contando solo los ítems del modo que practica (sílabas en Sílabas; las palabras que no le salen no la frenan) (un paso por sesión, mensaje en la pantalla final) y el adulto puede abrir o cerrar tocando el bloque «Camino de letras» del panel; un interruptor apaga la apertura automática. La oferta de subir de nivel solo sale con todas las letras abiertas. Posición por idioma (`pathEs`, `pathCa`, 1..12) y `pathAuto` son preferencias sincronizadas (la última gana). Un perfil con progreso empieza con todo abierto; uno nuevo en M; un dispositivo nuevo sin progreso que recibe a una niña con progreso pasa a todo abierto (el M inicial no estaba elegido ni sellado). Si `levelrule.js` no carga (stub), no se bloquea, abre ni ofrece nada y el bloque del panel se oculta. Leo no ve el bloque. Spec: `docs/superpowers/specs/2026-10-17-elsas-path-design.md`.
- **Mundos:** el nivel es la dificultad; el mundo (16 paisajes, o 🎲 Sorpresa que rota por sesión) es solo el paisaje. El mundo ya NO sesga las palabras (antes se prefería el etiquetado con el mundo actual; se quitó para que las palabras sigan solo nivel, letra y pesos adaptativos). 🎲 Sorpresa es el valor por defecto. El campo `g` de las palabras queda sin uso (inofensivo; un test sigue comprobando que sean ids válidos) y las pegatinas sí dependen del mundo.

## Audio: orden de prioridad (ver `say()` en app.js)
1. **Grabación del padre/madre** (IndexedDB `leemos-audio`, botón «Grabar mi voz»).
2. **Clip generado** (`audio/<lang>/<archivo>.mp3`, indexado en `audio/manifest.json`).
3. **Voz del navegador** (`speechSynthesis`), con la mejor voz disponible para el idioma.

Claves: el texto en minúsculas. En catalán, las claves de IndexedDB llevan prefijo `ca:` y las de estadísticas también (`ca:s:ma`, `ca:w:ne-na`); las del castellano no llevan prefijo (compatibilidad con progreso ya guardado, no cambiarlo).
Las frases de ánimo incluyen el nombre («¡Muy bien, Elsa!»). Los clips se generan con `NAME` (por defecto Elsa); si el nombre cambia en la app, esas frases caen a la voz del navegador.
Los sonidos de letras son clips de tipo `sound` (clave = la letra). Un TTS suele leer una «m» suelta como «eme»: ajustar con `scripts/spoken.mjs`, `pronunciation.*.json`, o grabarlos con «Grabar mi voz» (para Leo la lista empieza por los sonidos). El grabador muestra una barra de nivel en vivo y no guarda grabaciones en silencio (pico < 0.01, `SILENT_PEAK` en app.js): la causa habitual es que el navegador abra otro micrófono (auriculares Bluetooth) o el volumen de entrada esté a cero. Frases de ánimo de Leo: `npm run audio -- --provider <p> --name Leo`.
Voz de Lumi: los clips `phrase` (ánimo y frases de instrucción `hintSyl/hintWord/hintJudge`) usan `es-ES-XimenaMultilingualNeural` en los dos idiomas (`AZURE_VOICE_LUMI`, `AZURE_RATE_LUMI`); sílabas y palabras siguen con Elvira/Joana. Regenerar frases: `npm run audio -- --provider azure --kind phrase --force` (`--only` no sirve: las claves llevan comas). Tocar el globo de Lumi (`#hint`) o a Lumi mismo reproduce su frase y él crece al centro (`#lumiBig`, copia del SVG) moviendo el pico (variable CSS `--jaw`, seguida del volumen real del clip con un AnalyserNode; el contexto de audio se crea solo en un toque real, porque uno creado al cargar queda suspendido y silenciaría el clip; sin Web Audio, ritmo de temporizador); también viene grande con sus frases de ánimo (tras cada respuesta, pegatina y fin de sesión: `sayLumi`; sin clip, voz del navegador y sin zoom); la primera frase de instrucción de cada sesión suena sola, sin zoom (solo se mueve el pico del Lumi pequeño). Con `prefers-reduced-motion` no hay zoom ni vaivén. Solo grabación o clip, **nunca la voz del navegador** (es robótica): sin clip, silencio.
Sílabas inversas de 2 letras (ab, ic, um…): Azure las deletrea («a be»). Receta que funciona, en `pronunciation.*.json`: `<phoneme alphabet='ipa' ph='ˈub'>ub</phoneme>` (con acento ˈ; sin él solo funcionaba para algunas). Ojo: el cache del service worker es por URL; el clip se pide con `?v=<rev>` y la página de revisión también.
**Lo difícil son las sílabas sueltas**: cualquier TTS puede darles entonación de pregunta o leerlas como nombre de letra. El sitio para experimentar es `scripts/spoken.mjs` (qué texto se envía por tipo de clip) y `pronunciation.*.json` (casos concretos, admite SSML en Azure/Google). Escuchar con `tools/review.html` y regenerar con `--only`.

## Persistencia
- `localStorage['leemos-v1']`: estado `S` (stats, level, mode, world, lang, name, total, progress, stickers, sound, voiceURIs, sessionLen, upper, rate, theme…). Al añadir campos, dar un valor por defecto en la línea de `Object.assign` para que no rompa estados guardados.
- Perfiles: `localStorage['leemos-profiles']` = `{active, list:[{id,name,kind}]}`. Elsa sigue en `leemos-v1` (no renombrar); los demás en `leemos-v1:<id>`. Cambiar de perfil recarga la página. Estadísticas del modo sonidos: `snd:<letra>` y `ca:snd:<letra>`; `S.pre = {es:n, ca:n}` es el grupo desbloqueado por idioma.
- Pegatinas: `S.stk {mundo:n}` guarda cuántas tiene de cada mundo (las primeras n de su conjunto en `worlds.json`); `S.stickers` es siempre el total. Se sincroniza como máximo por mundo. Un guardado antiguo (solo el contador) se migra al cargar, antes de tomar `lastFp` (así no toca `modAt`), con `LEGACY_WORLD` de `merge.js`; `app.js` hace lo mismo derivando el mundo de `worlds.json` (no puede importar `merge.js`) y un test comprueba que coinciden. Si `stk` existe, el contador antiguo se ignora al leer ese estado. Al fusionar con un dispositivo de versión antigua (solo manda el contador, que es el mayor entre el suyo y NUESTRO total), solo cuenta lo que pasa de nuestro total: las que ganó él (las siguientes del orden antiguo); si no, cada ronda inventaría pegatinas. Esa mezcla no es asociativa a propósito. `earnSticker()` (app.js) lo usan lectores y Leo.
- Cuentas **opcionales** con Supabase (solo adultos; el niño nunca inicia sesión): se sincronizan apodo, contadores, pegatinas y grupos de Leo (`stats`, `total`, `stickers`, `pre`, `resets`, `level`, `name`, `modAt`), la sesión en curso (`session`) y las preferencias (`prefs`: mode, world, sessionLen, upper, lang, rate, sound, theme, pathEs, pathCa, pathAuto; ver el punto siguiente). **Nunca** se sincronizan la voz (`voiceURI`, `voiceURIs`) ni las grabaciones. Sigue sin haber analítica ni seguimiento, y sin config (`sync.config.json` vacío) no hay ninguna petición a terceros.
- Sesión en curso y preferencias sincronizadas (spec `docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md`): `S.session {done,ok,stk,at}` refleja los contadores `sDone/sOk/sStk` y se guarda en local (sobrevive a recargar; si tiene más de 12 h o está terminada, empieza de cero); `S.prefs {clave:{v,at}}` guarda solo las preferencias que alguien cambió (mode, world, sessionLen, upper, lang, rate, sound, theme, pathEs, pathCa, pathAuto), cada una con su marca de tiempo. Ninguna toca `modAt` (huellas separadas en `save()`). Nunca se sincroniza la voz (`voiceURI(s)`) ni las grabaciones. Al aplicar un pull (`storeState` → `applyMerged`), un valor cambiado en este dispositivo hace menos de 30 s se conserva y se devuelve al servidor (regla de inactividad); lo que viene del servidor no marca ni dispara otra sincronización. `PREF_KEYS` está duplicada en `merge.js` y `app.js` (app.js no puede importar): mantenerlas iguales.
- Sincronización: las entradas de `leemos-profiles` pueden tener `rid` (uuid del perfil en la cuenta); también `leemos-auth` (sesión), `leemos-auth-user` (último usuario) y `leemos-sync-at`. El estado gana `resets {es,ca}` ("Borrar progreso" suma 1 al idioma actual para que no lo deshaga otro dispositivo) y `modAt`, que `save()` solo actualiza si cambió un campo sincronizable (huella `fpOf`). Fusión: contadores al máximo; `level` y `name` del lado con `modAt` mayor; un reset gana a un dispositivo antiguo. Tras fusionar datos del servidor se pone `lastFp=fpOf()` para no re-sincronizar.

## Convenciones de UI
- Colores como tokens en `:root` con variante oscura; objetivos táctiles ≥ 44 px; foco visible; `prefers-reduced-motion` desactiva animaciones (confeti, mascota, transiciones).
- Tipografía Andika (pensada para lectores iniciales). Tiene que haber fallback.
- Movimiento: una sola escena de autor por pantalla y solo transform/opacity. La letra nueva del Camino aparece como una ficha (los mismos colores que las fichas de sílaba) al terminar la sesión, con un anillo y un estallido de chispas; la pegatina recién ganada se encuentra en el álbum (se abre desplazado a su hueco, que aparece una vez: `freshSticker`); las letras del bloque Camino se actualizan en su sitio (no se reconstruyen) para poder transicionar. Todo con `prefers-reduced-motion`: estático y visible. No se puede probar la animación en jsdom: solo las clases y las chispas (`.spark`, que el arnés borra al instante, se cuentan con un MutationObserver).
- Al añadir texto de interfaz: clave en `i18n.es.json` **y** `i18n.ca.json`, y `data-i="clave"` en el HTML (o `t('clave')` en JS). Atributos traducibles con `data-ia="atributo:clave;otro:clave"`.
- La mascota es **Lumi**, un búho original. **No usar personajes con derechos de autor** (Frozen, etc.) aunque el nombre de la niña invite a ello.

## Pendientes, por orden
1. **Generar el audio real** y revisarlo (ver README). Empezar por un nivel y un idioma para afinar `spoken.mjs` antes de generar todo.
2. **Revisar el catalán con alguien nativo.** Palabras dudosas: *camí, dofí, cranc, espasa, ninot, formiga, pingüí, mona, mus-sol*. El nivel 1 es corto (con m s l n hay pocas palabras).
3. **Catalán mallorquín** (viven en Palma): no se conocen voces neuronales comerciales de balear; lo realista es que Fran grabe las palabras con la app («Grabar mi voz»).
4. Autohospedar la fuente Andika (licencia OFL) para que funcione 100% offline; hoy se pide a Google Fonts.
5. Frases cortas con palabras que ya domina; modo «arma la palabra» arrastrando bloques.
6. ~~Pegatinas por mundo~~ **hecho** (6 por mundo; el selector de mundos muestra n/6 y el álbum va agrupado por mundo).
7. **Persistir la sesión en curso: hecho** (y se sincroniza). **Sincronizar entre dispositivos: hecho** (subproyecto 1, spec `docs/superpowers/specs/2026-10-17-accounts-sync-design.md`). Faltan el subproyecto 2 (política de privacidad, consentimiento, exportar y borrar la cuenta; **imprescindible antes de abrirlo a otras familias**) y el 3 (hosting https, proveedor de email, límites de abuso).
8. Pruebas e2e con un navegador real (Playwright). Hoy solo hay jsdom.
9. **Audio generado con Azure** (voces Elvira/Joana, mismas que los clips de Edge). El proveedor `edge` devuelve 403 desde 2026-10-15; no se intenta saltar la verificación de Microsoft. Pendiente: escuchar los clips de sonidos de letras de Leo que aún no se han revisado y revisar con nativo las palabras de sounds.ca.json.
10. **Siguientes proyectos (cada uno con su spec):** (a) ~~«Camino de Elsa»~~ **hecho** (letras en el orden del libro, banco acumulativo y ventana de repetición reciente); (b) juego «Busca la paraula» (3 copias entre 12 palabras parecidas); (c) modo libro (página por letra: buscar la palabra, leer la frase con dibujo, fila de sílabas).

## Ojo con esto
- **Nunca se ha probado en un navegador real**, solo en jsdom. Lo primero: `npm run dev` y probarlo en la tablet de Elsa (audio, micrófono, instalación).
- Los proveedores `elevenlabs`, `azure` y `google` **no se han probado con claves reales**; sí `mock`, `edge` (funcionando, es/ca) y todo el pipeline (postprocesado, manifest, nombres con tildes). Verificar en la documentación actual del proveedor los nombres de voces/modelos y si soportan catalán.
- `app.js` es un módulo (modo estricto). `tests/smoke.mjs` lo evalúa dentro de una función async porque jsdom no ejecuta módulos.
- `app.js` no puede tener sentencias `import` (el test lo evalúa como texto): `sounds.js` se carga con `import()` y `tests/smoke.mjs` inyecta `window.__leemosImport`.
- Si cambias la lista `SHELL` de `sw.js`, sube `VERSION`.
- El micrófono y el service worker solo funcionan en `localhost` o `https`. Una IP de red local con `http://` no sirve para probarlos en la tablet: usa un hosting con https.
