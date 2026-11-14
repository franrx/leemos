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

**Sobre el catalán:** la app usa el catalán central (estándar), que es el de las voces neuronales (Joana, Ximena) y el del libro de clase. Si algún día quieres otro acento, graba tú las palabras con «Grabar mi voz».

Las frases de ánimo llevan el nombre («¡Muy bien, Elsa!»). Se generan con `NAME` del `.env` (por defecto Elsa). Si en la app se cambia el nombre, esas frases usan la voz del navegador.

## Modo Leo (letras y sonidos)
Para quien aún no lee. Pulsa 🧒 en la cabecera, escribe el nombre y elige «Aprende letras y sonidos» (o «Ya lee sílabas» para otro lector como Elsa). Cada niño o niña tiene su progreso y sus pegatinas por separado; Elsa no se toca.
- Juego: tarjeta con la letra grande, su sonido y un dibujo; luego suena el sonido y toca la letra entre 2 (o 3) opciones. Un fallo nunca penaliza: se repite el sonido.
- Letras en `src/data/sounds.<idioma>.json`. Los clips (`sound`) se generan con `npm run audio`; una letra suelta suele salir mal en TTS, así que lo más fiable es grabarlos con tu voz: con `npm run dev` en marcha abre <http://localhost:5173/tools/record.html> en el portátil (`npm run record` te recuerda la dirección). Graba cada sonido (di «mmm» o «pa», no el nombre de la letra), escúchalo y pulsa Guardar: se convierte a mp3, se guarda en `audio/` y se apunta en `audio/manifest.json`, así que vale para todos los dispositivos tras hacer commit. La barra de nivel te avisa si el micrófono no te oye. Necesita `ffmpeg`. (El botón «Grabar mi voz» del panel de padres graba solo en el navegador de ese dispositivo.)
- Frases de ánimo con su nombre: `npm run audio -- --provider <p> --name Leo`.
- **Generar los sonidos con Azure** (acepta el IPA que ya envía `spoken.mjs`): crea un recurso «Speech» en Azure (región europea, p. ej. `westeurope`), copia la clave y la región a `.env` (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`; nunca las pegues en un chat ni las subas a git), comprueba con `npm run azure:voices` que las voces existen, genera una prueba corta con `npm run audio -- --provider azure --lang es --only "a,e,i,o,u,m,s,l,p"` y escúchala en `/tools/review.html` antes de generar el resto.

## Cuentas y sincronización (opcional)

Sin configurar nada, la app funciona como siempre y no hace ninguna petición a terceros. Para que el progreso y las pegatinas sigan al niño entre dispositivos:

1. Crea un proyecto en [Supabase](https://supabase.com) en una región de la UE.
2. En el editor SQL ejecuta `supabase/migrations/20261017000000_child_profiles.sql`.
3. **Primero configura SMTP propio** (Authentication → Emails → SMTP Settings; p. ej. Resend con `smtp.resend.com`, puerto 465, usuario `resend`, la API key como contraseña): Supabase solo deja editar las plantillas con SMTP propio, y sin editarlas el email lleva un enlace en vez del código. Luego, en Emails → Templates, edita **Confirm sign up** y **Magic link** (vista Source) para que muestren `{{ .Token }}` y el texto en castellano y catalán a la vez (el email no sabe el idioma de la familia):
   ```html
   <h2>Leemos</h2>
   <p style="font-size:32px;letter-spacing:6px;margin:8px 0"><b>{{ .Token }}</b></p>
   <p><b>Castellano:</b> este es tu código para entrar en Leemos. Escríbelo en la app; caduca en una hora.</p>
   <p><b>Català:</b> aquest és el teu codi per entrar a Leemos. Escriu-lo a l'aplicació; caduca d'aquí a una hora.</p>
   ```
   Asunto: `Leemos · tu código / el teu codi`. El remitente de prueba `onboarding@resend.dev` solo entrega a tu propio email; para otras familias hace falta un dominio verificado.
4. Copia la *Project URL* (solo la raíz, `https://xxxx.supabase.co`) y la clave `anon` (pestaña «Legacy anon, service_role») a `src/data/sync.config.json` (`{"url": "...", "anonKey": "..."}`). La clave `anon` es pública por diseño (los permisos los pone la base de datos); **nunca** pongas ahí la `service_role`.
5. Añade `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_KEY` a `.env` y ejecuta `node scripts/check-rls.mjs`: todas las líneas deben salir `PASS` (comprueba que un usuario no puede leer ni tocar los datos de otro).
6. El envío de emails incluido en Supabase está limitado a unos pocos por hora: para uso real configura SMTP propio (Authentication → SMTP Settings).

El adulto inicia sesión desde «Para papá y mamá → Guardar mi progreso» (email, código de 6 dígitos y casilla de consentimiento). Antes de abrirlo a otras familias hace falta la revisión legal de `privacy.html` (exportar y borrar la cuenta ya existen). Para el paso a producción de profesores y clases, ver la sección siguiente.

## Profesores y clases: puesta en producción

Orden obligatorio. La migración `supabase/migrations/20261113000000_teachers_classes.sql` cambia las políticas de `child_profiles`: no se aplica sin los pasos 1 a 3.

1. Con Docker en marcha, `npm run test:rls` levanta un Supabase local, aplica todas las migraciones y ejecuta `scripts/check-rls.mjs`. Tiene que acabar con `All RLS checks passed`. Las claves de producción no van en `.env` para esto: el script inyecta las locales.
2. Repite el paso 1 después de cualquier cambio en la migración.
3. En producción, haz copia de seguridad de `child_profiles`: en el editor SQL `select * from child_profiles` y descarga el CSV.
4. Aplica la migración en producción (editor SQL, pegando el archivo). Es una sola transacción: si falla, no queda nada a medias.
5. Nombra al primer admin por SQL: `update public.accounts set role='admin' where user_id=(select id from auth.users where email='tu@email');`
6. Comprueba a mano con tu cuenta real que los perfiles de Elsa y Leo siguen sincronizando (entrar, cambiar algo en un dispositivo, verlo en otro). **No ejecutes `scripts/check-rls.mjs` contra producción** (crea y borra usuarios de prueba): la base de datos se prueba en local, en el paso 1.
7. Solo entonces, fusiona y publica.

Antes de empezar, en Supabase Auth debe estar activado **Confirm email**: la invitación de un profesor casa con el email verificado.

**Si el paso 6 falla (marcha atrás):** restaura la copia del paso 3 (reimporta el CSV en `child_profiles` si hiciera falta) y borra lo nuevo, en este orden:

```sql
begin;
-- funciones públicas
drop function if exists public.whoami(), public.ack_teacher(), public.create_invite(uuid, text), public.redeem_invite(text, uuid),
  public.leave_class(uuid), public.unlink_me(uuid), public.delete_child(uuid), public.export_my_data(), public.delete_my_account(),
  public.admin_list_accounts(), public.admin_list_classes(), public.admin_invite_teacher(text), public.admin_revoke_invite(text),
  public.admin_demote_teacher(uuid), public.admin_create_class(text), public.admin_rename_class(uuid, text), public.admin_delete_class(uuid),
  public.admin_assign_teacher(uuid, uuid), public.admin_unassign_teacher(uuid, uuid), public.has_parent(public.child_profiles);
-- disparadores sobre tablas ajenas
drop trigger if exists accounts_for_new_user on auth.users;
drop trigger if exists child_profiles_link_creator on public.child_profiles;
drop trigger if exists child_profiles_owner_limit on public.child_profiles;
drop trigger if exists child_profiles_class_limit on public.child_profiles;
-- tablas nuevas
alter table public.child_profiles drop column if exists class_id;
drop table if exists public.child_links, public.class_teachers, public.invites, public.invite_attempts, public.role_invites,
  public.admin_log, public.deleted_children, public.classes, public.accounts cascade;
drop schema if exists private cascade;
-- los niños sin propietario (si los hay) hay que asignarlos o borrarlos antes de la siguiente línea
alter table public.child_profiles alter column owner set not null;
alter table public.child_profiles drop constraint child_profiles_owner_fkey;
alter table public.child_profiles add constraint child_profiles_owner_fkey foreign key (owner) references auth.users(id) on delete cascade;
commit;
-- después, vuelve a crear las políticas y los grants de child_profiles tal como están en 20261017000000_child_profiles.sql
```

Revisa el SQL contra la migración antes de lanzarlo (si añadió o cambió algo, lo nuevo también hay que borrarlo). Para quitar un usuario de prueba usa `delete_my_account`, no `delete from auth.users` en el panel: dejaría niños de clase sin ningún vínculo.

### Pendiente de revisión humana

- **Revisión legal de `privacy.html`**: es un borrador con marcas PENDIENTE (responsable, base legal, plazos, proveedores).
- **Revisión por un nativo de las cadenas en catalán** (claves de `i18n.ca.json`): `teachShareAsk`, `teachLeaveAskParent`, `teachTakeAsk`, `teachDeleteAsk`, `teachOrphan`, `teachCodeTeacher`, `teachCodeParent`, `teachRedeem`, `teachHaveCode`, `teachAckText`, `teachHasParent`, `teachDelForbidden`, `teachLimit`, `acctExported`, `acctDelAsk1`, `acctDelAsk2`, `acctDelYes1`, `acctDelYes2`, `acctDelNo`, `acctDeleted`, `acctLastAdmin`, `teachWipe`, `teachWipeAsk`, `teachWipeAskClass`, `teachWipeYes`, `teachWiped`, `teachDownload`, `acctExport`, y la parte catalana de `privacy.html` (aviso de «esborrany», «enganxines», «sobrenom»). Dudas de vocabulario: «mestre» frente a «docent», «infant» frente a «nen/nena».
- **Autohospedar la fuente Andika** (OFL): la política de privacidad menciona que hoy se pide a Google Fonts.

## Publicar e instalar en la tablet
Es un sitio estático: sirve cualquier hosting con **https** (Netlify, Cloudflare Pages, GitHub Pages…). Hace falta https para el micrófono y el modo offline. Una vez abierta en la tablet, «Añadir a pantalla de inicio» la instala; tras la primera visita con conexión, descarga los audios y funciona sin internet.

## Personalizar contenido
- Palabras y sílabas: `src/data/levels.<idioma>.json`. El campo `g` (mundos, ids de `worlds.json`) ya no se usa: el mundo es solo el paisaje y no cambia qué palabras salen.
- Camino de letras: el orden está en `STEPS` de `src/levelrule.js` (M P L N T S F B D R C y «el resto»); el adulto lo ajusta en «Para papá y mamá».
- «Busca la paraula»: tercer modo (botón «Busca»). Encuentra las 3 copias de la palabra entre 12 parecidas, de la letra del Camino en la que va; 5 páginas y una pegatina. No cambia el progreso. Lógica en `src/find.js`.
- «Cierra / Tanca»: cuarto modo (botón «Cierra»), sílabas cerradas con s/r/l armadas como «2+1», con sonido alargado y palabras con ficha ancla; se abre en el paso L del Camino. Banco en `src/data/closed.<idioma>.json`; los clips alargados (`stretch`) se escuchan en `/tools/review.html`. Lógica en `src/close.js`.
- Textos de interfaz: `src/data/i18n.<idioma>.json` (mismas claves en los dos).
- Mundos y pegatinas: `worlds.json` (cada mundo trae su conjunto de 6 pegatinas en `stk`). `stickers.json` solo conserva el orden de las 24 pegatinas originales para migrar guardados antiguos: no lo cambies.
- Tras cambiar palabras: `npm run audio:plan` y `npm run audio` generan solo los clips nuevos.

Más contexto de diseño y pedagogía en `CLAUDE.md`.
