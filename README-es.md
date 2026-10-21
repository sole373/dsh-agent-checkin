# dsh-agent-checkin

> Registro diario agregado y conexión de modelos para DeepSeek Harness — un plugin, tres tareas.

[English](README.md) | [中文](README-zh.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

## What it does

Este plugin conecta los clientes de IA que ya tiene instalados con DeepSeek Harness (DSH) de tres maneras:

1. **Registro agregado** — ejecuta una ronda de registro en todas las plataformas admitidas y luego
   informa el resultado de cada plataforma *y* su saldo de créditos en vivo en un solo lugar.
2. **Clientes locales como proveedores de modelos** — lee el catálogo de modelos de los clientes de
   IA ya conectados en esta máquina (TRAE, Qoder CN, WorkBuddy, Baidu DuMate, WPS Lingxi) y los
   registra como proveedores, de modo que sus modelos aparezcan en el selector y puedan usarse en
   el chat.
3. **Conexión de modelos** — toma un endpoint compatible con OpenAI o con Anthropic y lo registra
   como ruta de proveedor dentro de DSH.

Las tres partes leen el mismo conjunto de clientes locales. Los saldos del panel y los modelos del
selector pertenecen a las mismas cuentas.

El **panel de uso de tokens** es una cuarta superficie, independiente: lee los propios registros de
sesión de DSH, informa de cuántos tokens ha consumido cada proveedor / modelo y, al final, ofrece un
**ranking autorizado de modelos con recomendaciones por tarea** (las puntuaciones de capacidad vienen
de una lista pública; «qué modelos existen» solo se mira en esta máquina). No tiene nada que ver con
las tres cosas anteriores — véase «[Panel de uso de tokens](#panel-de-uso-de-tokens)».

> **Estado de avance (2026-10-19, v0.8.0).** ① El registro agregado está **terminado y
> funciona**. ② La conexión de modelos desde clientes locales está **corregida y ampliada a cinco
> plataformas**: TRAE (CN/global), Qoder CN, WorkBuddy (CN/global), Baidu DuMate y WPS Lingxi
> comparten la arquitectura de cinco capas de `lib/connect/` (credenciales locales → catálogo de
> modelos → shim de bucle invertido → PiAiAdapter → registro); elija las plataformas y los modelos
> de cada una en **Ajustes → Registro agregado → Plataformas y modelos**, y el cambio se aplica al
> guardar sin reiniciar. ③ El **panel de uso de tokens está terminado** — una entrada «Uso de
> tokens» en la barra lateral lee los propios registros de sesión de DSH y desglosa por proveedor y
> modelo el consumo de tokens, el número de llamadas y la tasa de aciertos de caché (con tendencia,
> distribución por fuente, ranking y tabla de detalle), además de una insignia de saldo de créditos
> del proveedor actual a la izquierda del campo de entrada. En la parte inferior de ese mismo panel
> hay además un **ranking autorizado de modelos con recomendaciones por tipo de tarea** (las
> puntuaciones de capacidad vienen de la lista pública Artificial Analysis / OpenRouter; «qué modelos
> existen» solo del catálogo local y de sus propias casillas marcadas — **aparecer en el ranking no
> significa que ya esté suscrito**). ④ La mitad de `modelRoutes` funciona, pero solo admite
> `apiKeyEnv` estático y no tiene soporte de `headers`; el perfil actual no declara ninguna ruta.
>
> **PhanthyWork no es conectable (medido).** Su puerto de proxy inverso 3456 nunca escucha, y las
> credenciales reales solo viven en la memoria del proceso principal, así que no hay rodeo posible.

## Requirements

- DSH `0.2.x`.
- Python 3.9+ en `PATH` (solo para la parte de registro).
- Node 22.19+ o 24+ con el módulo integrado `node:sqlite` (solo para `traeProvider`).
- El motor viene **incluido** en este paquete, bajo `engine/` — no hay nada más que instalar.
  Si mantiene su propia copia del motor, apunte `homeDir` a ella.

## Installation

```bash
dsh plugin install ./dsh-agent-checkin
```

O añádalo manualmente a un perfil:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- insert:
    - id: dsh-agent-checkin
      name: dsh-agent-checkin
```

## Usage

### Registrar

| Superficie | Cómo |
| --- | --- |
| Comando | `/checkin` — una ronda en todas las plataformas |
| Comando | `/checkin trae,dumate` — solo las plataformas indicadas |
| Comando | `/checkin --force` — ignora la idempotencia del día y vuelve a reclamar |
| Comando | `/checkin-status` — muestra la ronda anterior sin volver a ejecutarla |
| Herramienta | `checkin_run` — lo mismo, invocable por el agente |
| Panel de ajustes | el botón «Fichar ahora» — un clic lanza una ronda y muestra los resultados por plataforma |
| HTTP | `GET /dsh-agent-checkin/status` — instantánea JSON para un panel |
| Navegador | `GET /dsh-agent-checkin` — panel legible por personas |

**Por defecto no se reclama nada.** El plugin se distribuye con `allowClaim: false`, lo que fuerza
cada ronda al modo de solo lectura. Un registro que realmente cambia el saldo de una cuenta es una
acción sobre el mundo real, así que debe activarse a propósito:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    allowClaim: true
```

También puede cambiarse desde el **panel de ajustes de plugins** del host: `allowClaim`,
`pythonCommand`, `homeDir`, `timeoutMs` y `pushResult` admiten recarga en caliente, así que el
cambio surte efecto en la siguiente ronda sin reiniciar el host.

El interruptor de reclamación de ese panel sí está conectado: escribe el nuevo valor en el
`cordis.patch.yml` de tu perfil mediante el servicio `configEditor` del host (bloqueo de archivo,
validación, escritura atómica, reversión si falla) y el hot-commit volatile hace que la instancia en
marcha lea el valor al instante. Basta un clic: ni editar YAML a mano, ni reiniciar. Si la escritura
falla, el panel muestra el motivo real del servidor en lugar de una falsa éxito; y si el valor ya era
el pedido, lo dice en vez de fingir que guardó algo.

### El panel

Abre `http://127.0.0.1:<puerto>/dsh-agent-checkin` en un navegador de la misma máquina. Solo se sirve en
la interfaz de bucle local: cualquier petición cuyo `Host` u `Origin` no sea una dirección de bucle
local recibe un 403, de modo que otra aplicación local (o una página alcanzada mediante DNS
rebinding) no pueda leer tus saldos.

La página sigue las mismas reglas de honestidad que la salida por comandos:

- **El modo de solo lectura se indica arriba.** Con `allowClaim: false` la cabecera dice que la
  ronda no reclamó nada.
- **Las plataformas de solo lectura tienen su propia sección.** Las plataformas sin punto de
  reclamación nunca cuentan como «registro exitoso», porque esa acción no existió.
- **No hay un total entre plataformas.** Puntos, créditos e 灵感值 son monedas distintas; sumarlas
  produce un número sin significado. La página lo dice en vez de mostrar uno.
- **Un saldo desconocido se muestra como `—`, no como `0`.** Cero es una lectura; «no se pudo
  leer» no lo es.
- **Lo que se leyó se muestra.** Cada plataforma guarda su saldo disponible bajo un campo distinto
  (QwenWork en la suma de tres tramos, TRAE y WorkBuddy CN en `total_credits`). La normalización
  vive en `bridge.py` del motor; el plugin la repite por seguridad, así que los saldos se siguen
  mostrando aunque apuntes `homeDir` a tu propia copia del motor sin ese parche.
- **Cada cifra lleva su origen**: leída en esta ronda, cargada del archivo de estado, o ausente.
- **Los riesgos por plataforma aparecen en la página.** Las advertencias sobre huellas de
  dispositivo se muestran al pie en lugar de quedarse solo en los comentarios del código.

El punto JSON `/dsh-agent-checkin/status` devuelve los mismos datos para scripts.

### Panel de uso de tokens

Al final de la barra lateral de ajustes, después de las secciones integradas, hay otra entrada:
**Uso de tokens**. No vive dentro del panel de ajustes, sino que es un panel independiente de la
zona principal: basta con pulsar ese icono de la barra lateral para abrirlo.

El panel mide el consumo de modelos de **todos los workspace y todas las sesiones de esta máquina**,
y su fuente de datos son los registros de sesión que escribe el propio DSH (`$DSH_HOME/sessions/`),
no los resultados de registro de este plugin; por eso es completamente independiente de la mitad de
registro: puedes verlo sin fichar, y un registro fallido tampoco lo afecta.

- **Siete tarjetas de estadísticas**: consumo acumulado, hoy, últimos 7 días y número de llamadas,
  más aciertos de caché, fallos de caché y tasa de aciertos de caché. El subtítulo de la tarjeta de
  llamadas añade además «cuántas fuentes · cuántos modelos» — **el número de fuentes no es el número
  de modelos**: bajo un proveedor suelen colgar decenas de modelos, y solo informando ambas cifras
  por separado se evita que «conecté 11 fuentes» se lea mal como «solo hay 11 modelos».
- **El criterio de las tres métricas de caché** (escrito en las ayudas de las tarjetas y también
  aquí): **acierto = `cacheRead`**; **fallo = `input + cacheWrite`**;
  **tasa de aciertos = aciertos ÷ (entrada + aciertos + escritura)**. El denominador **no incluye la
  salida** — los tokens de salida nunca son candidatos a caché, e incluirlos haría que la tasa de
  aciertos se viera mejor de lo que es. Cuando el denominador es 0 se muestra «—» y **no 0 %**: 0 %
  es una lectura, «no hay denominador que calcular» no lo es. Estas tres métricas comparten base con
  el «consumo acumulado» (todo el periodo) y no cambian con la ventana temporal — calcularlas por
  ventana exigiría que el backend extendiera también el agrupado diario a cuatro tramos, y eso ya es
  otra cosa.
- **La ventana temporal es conmutable**: 7 días / 30 días / 90 días / todo. Cambiarla solo mueve el
  rango mostrado, no vuelve a escanear — el escáner clasifica todo el historial de una vez, y la
  ventana se recorta sobre el resultado.
- **Tres gráficos en una misma fila**: tendencia de consumo (conmutable entre «diario» y
  «acumulado»), distribución por fuente (gráfico de anillo, con las 6 primeras fuentes) y ranking de
  uso de modelos (los 8 primeros modelos). El gráfico de tendencia está diseñado para un tercio del
  ancho de columna (ancho de coordenadas 360, no los 640 de la primera versión — con 640, dentro de
  una columna de un tercio, la escala derecha queda aplastada y deja de verse).
- **Tabla de detalle por fuente**: cada fila enumera los cuatro tramos de uso y el número de llamadas
  de cada combinación proveedor / modelo, más tres columnas de eficiencia calculadas al momento con
  esos mismos datos — **tasa de aciertos**, **consumo medio por llamada** (total ÷ número de
  llamadas) y **proporción de salida** (salida ÷ total). Las dos últimas sirven para distinguir
  «caro pero lo resuelve de una vez» de «barato pero va y viene probando».
- **El pie informa honestamente del coste del escaneo**: cuántos archivos de sesión se escanearon,
  cuántos MB, cuántos se reescaneó esta vez, cuántos mensajes facturables y cuántos milisegundos
  costó. **Si esta vez no terminó por tiempo de espera, lo dice con todas las letras —
  «esta vez no se terminó de escanear por tiempo de espera»**, en lugar de hacer pasar media tanda de
  datos por un resultado completo.

El endpoint HTTP `GET /dsh-agent-checkin/usage` devuelve los mismos datos para scripts:

| Parámetro | Significado |
| --- | --- |
| `days=7` | Ventana temporal (días). Si se omite, se usa la ventana por defecto; `3650` significa «todo» |
| `refresh=1` | Ignora la caché en memoria y fuerza un nuevo escaneo |

El endpoint comparte el mismo guardián que el resto de rutas del plugin: solo acepta peticiones de
bucle local (cualquier otra recibe 403), solo acepta `GET` / `HEAD`, y toda respuesta lleva
`cache-control: no-store` — «acabo de refrescar y siguen saliendo los números viejos» es el modo de
fallo que más destruye la confianza en un panel así.

#### Cómo se calculan los números

Vale la pena explicar bien esta parte, porque aquí se pisaron cuatro trampas que **calculan mal en
silencio**:

- **Un registro de sesión es «zstd multiframe», no un solo frame.** En una medición real, un
  `session.v4.jsonl.zstd` contiene **12829** frames zstd independientes encadenados uno tras otro;
  llamar directamente a `zstdDecompressSync` descomprime solo el primero, y **el otro 99 % del
  contenido se descarta en silencio**, sin ningún error. Por eso el escáner corta frame a frame
  (localizando las fronteras por el número mágico de zstd `0xfd2fb528`) y descomprime cada uno.
- **El uso de `assistant/attempt` está duplicado.** Una misma llamada anota usage dos veces, en
  `attempt` y en `message` (el de `attempt` solo aparece en `data.stream[].chunk.usage`, y es la
  misma copia que el `data.usage` final); contar ambas infla el total sin motivo. El escáner **solo
  reconoce `assistant/message`**; `attempt` sirve para deduplicar y correlacionar, no entra en el
  recuento.
- **El campo `totalTokens` es de un criterio antiguo.** Equivale siempre a
  `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` (verificado con 8129 registros:
  7952 coinciden exactamente y los 177 restantes son registros de versiones antiguas a los que les
  falta `cacheWriteTokens`), mientras que la verdadera «entrada facturable» es
  `input + cacheRead + cacheWrite`. Por eso el total que muestra la página se calcula siempre
  **sumando los cuatro tramos**, sin leer ese campo ya hecho: no se puede dar por supuesto que
  siempre esté al día.
- **Si varias versiones de una misma sesión conviven, solo se lee la de versión más alta**
  (`session.v4.jsonl` y `session.jsonl` a la vez); de lo contrario, el mismo uso se contaría dos
  veces.

#### Caché incremental

Los registros solo crecen, así que la estrategia de caché es «instantánea en memoria + invalidación
por archivo»: se anota el `size:mtime` de cada archivo de sesión y, la próxima vez, solo se
reescanean los que cambiaron. En el caso medido de 44 archivos y 9333 mensajes facturables, un
escaneo en frío tarda unos 1,5 segundos y uno en caliente unos 150 milisegundos.

El TTL de la caché lo controla la clave de configuración `usageCacheSeconds` (30 segundos por
defecto). El botón «Refrescar» del panel siempre ignora la caché y vuelve a escanear; este valor solo
afecta al sondeo automático y a otros llamadores. **No se introduce ninguna base de datos**: 43
registros / 48 MB se escanean en frío en 1,3 segundos, y como los registros solo crecen, la caché en
memoria ya reduce el refresco diario a milisegundos de un solo dígito; meter SQLite solo añadiría una
copia más que habría que migrar y cuadrar contra los registros.

#### Insignia de saldo en el campo de entrada

A la izquierda del campo de entrada (`conversation.input.left`) también se muestra **el saldo de
créditos del proveedor que usa el agente referenciado actualmente**. Aquí lo más importante es **no
mentir**:

- **Solo se dibuja cuando la plataforma tiene de verdad el concepto de «saldo de créditos»** (por
  ejemplo WorkBuddy). Las plataformas de facturación por tokens a posteriori no tienen nada
  parecido, e inventarse una cifra sería mentir; por eso, en ese caso **la insignia entera no se
  dibuja** y tampoco **se arranca ningún sondeo**.
- **Si el saldo es desconocido, la insignia no aparece en absoluto**; no se muestra `0`. Cero es una
  lectura; «no se pudo leer» no lo es.
- **Al pasar el cursor se muestra el origen**: si la cifra es «medida» o «introducida a mano» va
  escrito en el `title`, y ambas cosas nunca se mezclan.
- **El sondeo es muy espaciado**: el saldo cambia como mucho a diario, así que una vez por minuto ya
  supera de sobra lo necesario.
- **Convive con `dsh-connect-workbuddy`**: el plugin antiguo también ocupa este slot (order 4 y solo
  dibuja para su propio proveedor), y este plugin va justo detrás con order 5; ambos se distinguen
  porque «solo reconocen los proveedores que conocen», así que nunca aparecen dos insignias a la vez.

#### La frontera de error del panel

El panel de uso está envuelto en una frontera de error de React (un componente de clase —
`getDerivedStateFromError` es exclusivo de las clases y los componentes de función no tienen
equivalente). **Por qué es obligatoria**: si un componente del slot `main` lanza una excepción
durante el renderizado, el host deja todo el panel en blanco o en su estado de reserva, y **esa
línea de error de la consola del navegador el usuario no la ve** (la versión de escritorio no tiene
entrada a devtools), así que el síntoma es «pulsé el botón de la barra lateral y no pasó nada». Con
esta frontera, el mismo fallo se convierte en una línea roja en la página, y el usuario puede leerle
la causa directamente al mantenedor.

La sección de ranking tiene **además** su propia frontera encima de esa: que no se pueda alcanzar la
lista no debe dejar en blanco las estadísticas de uso que están por encima, porque las dos cosas
fallan por motivos que no tienen nada que ver.

#### El ranking autorizado de modelos y las recomendaciones por tarea

Al final del panel hay un bloque más: el **ranking autorizado de modelos**, junto con
recomendaciones por tipo de tarea. Se compone de dos mitades cuyos orígenes se mantienen
estrictamente separados:

- **Las puntuaciones de capacidad vienen de una lista pública** — los índices de inteligencia,
  código y agentic de Artificial Analysis, obtenidos a través de la API pública de OpenRouter
  (`https://openrouter.ai/api/v1/models`, sin autenticación). **Este plugin no estima ni una sola
  puntuación**: el catálogo de clientes locales solo lleva un id, un nombre, un multiplicador y si
  admite imágenes — **ninguna dimensión de calidad** —, así que adivinar la potencia a partir de los
  nombres sería inventárselo.
- **«Qué modelos existen» solo se mira en esta máquina** — solo se listan los modelos realmente
  presentes en el catálogo de clientes locales (la región con la que se ha iniciado sesión), y ya
  aplicadas las casillas que haya marcado en «Plataformas y modelos». Todo lo que aparece en la lista
  pública pero no en el catálogo local queda excluido: el ranking sirve para «qué puedo usar ahora
  mismo», no para «qué existe en el mundo».

**Una cosa que hay que dejar clara**: el catálogo de clientes es un **catálogo de producto y no se
filtra por la suscripción de la cuenta**. Medido en una cuenta `workbuddy-global` sin suscripción,
el catálogo sigue listando `gpt-6-astra` / `gpt-5.4` y el resto de la familia GPT. Por eso
**que un modelo aparezca en el ranking no significa que su cuenta tenga derecho a llamarlo** — esa
frase está impresa tal cual en el panel, y el panel no finge que el ranking equivalga a los derechos
de suscripción. El panel tampoco puede determinar la suscripción automáticamente: ninguno de los
catálogos de plataforma lleva **ningún campo de derechos** (un grep completo del catálogo de
WorkBuddy por `vip|subscrib|entitle|tier|quota` solo encuentra un comentario sobre un «modelo
gratuito»). Cuando de verdad no se pueda llamar, el error de la plataforma saldrá como siempre — esa
es la señal autoritativa.

Contenido del panel:

- **Ranking general**: por índice de inteligencia descendente, como máximo 12 filas, y cada fila da
  las plataformas por las que está disponible, los índices de inteligencia / código / agentes, la
  ventana de contexto, el precio por millón de tokens de entrada y el multiplicador que da el
  cliente (el multiplicador se marca con el prefijo `x` para que no se confunda con parte de la
  puntuación).
- **Recomendaciones por tipo de tarea**, seis: escribir código, razonamiento y matemáticas, agentes y
  uso de herramientas, documentos largos, multimodal (ver imágenes) y rápido y económico.
  **Cada tarjeta imprime su propia regla de ordenación en la tarjeta**, para que «por qué este es el
  primero» se pueda recalcular en el momento:
  - Escribir código → por índice de código descendente, y los que no tienen índice de código usan el
    de inteligencia como respaldo;
  - Razonamiento y matemáticas → por índice de inteligencia descendente;
  - Agentes y uso de herramientas → por índice agentic descendente, y los que no lo tienen usan el de
    inteligencia como respaldo;
  - Documentos largos → por ventana de contexto descendente;
  - Multimodal → solo modelos que admiten entrada de imagen, por índice de inteligencia descendente;
  - Rápido y económico → solo modelos con índice de inteligencia ≥ 40, por precio por millón de
    tokens de entrada ascendente. **Ese umbral de 40 es deliberado**: un modelo barato por debajo de
    él no merece el nombre de «económico», simplemente es débil.

Dos criterios numéricos merecen explicarse aparte, porque son las dos caras del mismo tipo de error:

- **«Falta este índice» y «este índice es 0» son dos cosas distintas.** La lista pública envía un
  **`null` explícito** para un índice ausente (medido: `anthropic/claude-haiku-5.5` tiene
  `coding_index` a `null`), y `Number(null)` es `0`. Una primera versión llamaba directamente a
  `Number(value)`, así que **98 modelos sin índice de código se trataron como «código 0 puntos»** y
  en el ranking de código quedaron por delante de modelos realmente débiles. Ahora `null` se mantiene
  como `null` y la página muestra «—».
- **Un modelo sin índice de inteligencia se va al fondo y no se usa como 0.** Al ordenar el ranking
  general, `null` queda detrás de todos los modelos con puntuación, en lugar de mezclarse con los
  tramos bajos.

Un fallo del ranking **no** es un error fatal: si hay una lista antigua a mano, el panel sigue
usándola y marca «esta actualización falló; abajo está la última lista obtenida con éxito» junto con
el motivo. Solo «nunca ha funcionado ni una vez» muestra un fallo — y aun entonces debe explicar
**por qué no hay ranking**, en lugar de dibujar una tabla vacía que haga creer que esta máquina no
tiene modelos usables. A la inversa, que se lea la lista pero no coincida ni un solo modelo tampoco
es un error, sino un hecho, y el panel lo dice: «ninguno de los N modelos disponibles en esta máquina
coincide con la lista — puede que aún no los incluya», y enumera los nombres que no coincidieron,
para que se pueda juzgar si a la lista le faltan entradas o si los nombres no cuadran.

La caché de la lista usa el mismo patrón que el escáner de uso: instantánea en memoria + respaldo en
disco (`$DSH_HOME/dsh-agent-checkin/model-rank.json`) + serialización de peticiones concurrentes.
TTL de 6 horas — la lista cambia a escala de días, así que refrescar más a menudo solo gasta red.

El endpoint HTTP `GET /dsh-agent-checkin/model-rank` devuelve los mismos datos; `?refresh=1` fuerza
una nueva descarga de la lista saltándose la caché. Los guardianes son iguales que los de `/usage`
(solo bucle local, solo `GET`/`HEAD`, `no-store`).

### El panel de ajustes

**Ajustes → Agent Check-in** — está al final de la barra lateral de ajustes, después de las secciones
integradas — así que el trabajo diario no exige la línea de comandos:

- **Fichar ahora** lanza una ronda completa de check-in desde el panel (equivale a `/checkin` en una
  conversación), sin línea de comandos.
  - El botón responde "iniciado" enseguida; **`started` solo significa que la ronda fue aceptada, no
    que haya triunfado.** Al terminar, una tabla por plataforma aparece bajo los botones, y esa tabla
    es el único veredicto (`ALREADY` / ya reclamado hoy se muestra tal cual).
  - Es la **única acción del panel que cambia saldos de verdad**: el texto del botón y el subtítulo
    dicen claramente si la ronda reclama o solo verifica (lo decide `allowClaim`). Mientras corre, los
    botones se desactivan y muestran "en marcha"; clics repetidos nunca arrancan una segunda ronda.
  - "Forzar repetición" omite la protección de "ya reclamado hoy", y si eso duplica el reclamo lo
    decide cada plataforma — el panel lo dice al lado del botón. Un clic normal nunca lo hace.
  - Si el motor no arranca, el panel muestra la razón (jamás reporta "sin resultado" como "sin
    fallo"); si una ronda no trae detalle por plataforma, lo dice en vez de pintar una tabla vacía
    como si no faltara nada.
- **Comprobar inicio de sesión (solo lectura)** llama de verdad a un endpoint de solo lectura de cada
  plataforma y reporta uno de tres estados — OK / sin configurar / falló. **No reclama nada**, y no
  empieza a reclamar solo porque `allowClaim` esté activo.
- **Inicio de sesión en un clic** da a cuatro plataformas un botón *Abrir ventana de inicio de
  sesión*, en dos formas:
  - **Basadas en cookie (WPS Lingxi, 即梦)**: lanza una ventana de navegador aparte en esta máquina;
    tú inicias sesión con normalidad y el plugin recoge la cookie, la verifica una vez y solo entonces
    la escribe en disco. Sin F12, sin copiar cabeceras, sin parámetros de línea de comandos.
  - **Basadas en perfil (Coze, Kling)**: estas dos plataformas entregan su beneficio diario a cambio de
    *una visita con la sesión iniciada*, y la credencial es un perfil de navegador entero, no una
    cookie suelta. El botón también abre su propia ventana; tras iniciar sesión cierras esa ventana
    tú mismo, y solo entonces el plugin ejecuta una verificación de solo lectura de la sesión: pasarla
    es lo que cuenta como sesión válida.
  - El control es un **botón normal que hace POST** a un endpoint local: no navega a ningún sitio, así
    que la página de ajustes y el resto del harness se quedan donde están. Merece la pena decirlo
    porque dos diseños anteriores fallaron justo aquí: un enlace que abría en la misma pestaña
    (`target: '_self'`) derribaba toda la interfaz del host, y uno que abría una pestaña nueva
    (`target: '_blank'`) no producía ninguna ventana en este shell de Electron.
  - Las peticiones del panel **no llevan `Origin`**, lo cual es normal en este host (el propio guardián
    de DSH acepta la ausencia de `Origin`). Por eso la comprobación de escritura es: si viene `Origin`
    debe ser de mismo origen y apuntar a este puerto de loopback; si no viene, solo se rechazan las
    peticiones escritas desde la barra de direcciones (`Sec-Fetch-Site: none`). Todo lo demás desde un
    socket de loopback se acepta: quien pueda falsificar eso ya está ejecutando código en esta máquina
    y podría leer el archivo de credenciales directamente.
  - **`started: true` solo significa que la ventana de captura se abrió.** No es un inicio de sesión
    correcto. El panel consulta el endpoint de estado cada 2 s y decide por el resultado de la captura,
    nunca por el hecho de que el botón haya respondido.
  - La ventana usa un **perfil desechable**, así que no ve tu sesión habitual del navegador. Es a
    propósito: si no, «capturado» podría significar solo una cookie prestada de otro navegador.
  - La captura espera en segundo plano; el panel consulta cada 2 s y un tiempo de espera agotado
    (5 minutos por defecto) se reporta como tal. Un tiempo agotado **nunca** se registra como éxito,
    y tampoco un código de salida 0 sin una marca explícita de éxito. *Cancelar* solo detiene la
    espera y dice con claridad que el inicio de sesión no terminó.
  - Cuando la ventana no puede abrirse, el motivo lo da el propio servidor y aparece debajo del botón.
    Ese fallo cuenta solo como «la petición no pasó»; nunca se registra como un inicio de sesión
    fallido.
- **Credenciales manuales (respaldo)** siguen disponibles para las dos plataformas basadas en cookie,
  para entornos donde la ventana automática no arranca. Al guardar se ejecuta una verificación de solo
  lectura y el resultado aparece bajo el campo — **«guardado» no es «puede hacer check-in»**, y se
  muestran por separado. El campo se vacía en cuanto el guardado tiene éxito, para que el secreto no se
  quede en la página. Las dos plataformas basadas en perfil no tienen campo donde pegar: su credencial
  no es una cookie, y pegarla no serviría de nada.
- **Las otras seis plataformas no tienen ni botón de inicio de sesión ni campo de entrada**, cada una
  con su motivo en una línea (la credencial está cifrada dentro del cliente, o no hay ningún endpoint
  al que reclamar). La entrada no está porque no serviría, no porque se haya olvidado.
- **Saldo actual por plataforma: primero lo medido, con entrada manual de respaldo.** Se lista el saldo
  que muestra actualmente cada plataforma: el valor que el motor leyó de verdad en la última ronda se
  marca «medido» (indicando el campo de respuesta de donde vino); las plataformas sin endpoint de
  saldo permiten anotar un valor a mano, marcado «manual» con una nota opcional. Un valor manual es tu
  propia anotación, **no una recarga**, y nunca se hace pasar por medido — la siguiente medición real
  gana automáticamente.
- **Los saldos se listan por plataforma sin total**, igual que el panel y la salida de comandos: cada
  plataforma usa una moneda distinta y sumarlas no significaría nada.
- **El interruptor de reclamación sí funciona de verdad.** Al pulsarlo escribe el nuevo valor en el
  `cordis.patch.yml` de tu perfil mediante el servicio `configEditor` del host (bloqueo de archivo,
  validación, escritura atómica, reversión si falla) y el hot-commit volatile hace que la instancia en
  marcha lo lea al instante: sin editar YAML a mano y sin reiniciar. Si la escritura falla, el panel
  muestra el motivo real del servidor en lugar de fingir que funcionó; si el valor ya era el pedido,
  dice claramente que no se escribió nada.
- **Pestaña «Plataformas y modelos»: elija plataformas y modelos aquí mismo.** Cada proveedor
  conectado tiene su tarjeta: active «mostrar esta plataforma en el selector de modelos» y luego
  elija **todos los modelos (seguir el catálogo del cliente)** — los modelos que el cliente añada
  después aparecen solos — o **elijo yo**, que empieza vacío y guarda un subconjunto explícito. Los
  botones «todo / nada / invertir» hacen que «solo tres» sean un clic y tres, no todo y luego
  desmarcar uno a uno.
- **La tasa tras cada modelo es el multiplicador del propio cliente** — `creditMultiplier` de
  WorkBuddy, `priceFactor` de Qoder (`0` se muestra como *gratis*), `features.consumption_rate.data.rate`
  de TRAE (precio de promoción primero). Cuando el cliente no publica ninguno, la columna queda
  **vacía**; la página nunca enseña una cifra adivinada.
- **La entrada de imagen es por modelo y no depende de qué modelos se muestran.** Cada tarjeta
  tiene un bloque aparte con tres estados: **seguir la capacidad nativa** (el valor por defecto —
  lo que el catálogo diga que acepta imágenes, y los modelos multimodales que el cliente añada
  después funcionarán solos), **elijo yo** (una lista explícita) o un clic para apagarlas o
  encenderlas todas. Un modelo mostrado pero sin la marca de imagen sigue apareciendo en el
  selector, simplemente no puede recibir imágenes; al revés, un modelo que el catálogo no declara
  se puede marcar a mano — **si el origen lo acepta de verdad se comprueba midiendo, y el plugin no
  decide eso en nombre del origen.** El interruptor de plataforma, la lista blanca de modelos y la
  lista de imágenes son tres almacenes independientes: apagar una plataforma no borra las marcas de
  imagen.
- **Guardar se aplica al instante.** El plugin escribe el archivo y emite `llm/adapters-updated`, así
  que el selector de modelos del host se redibuja en el acto — **sin reiniciar el host**. La elección
  vive en `~/.dsh/dsh-agent-checkin/model-selection.json` (solo interruptores e ids de modelo, nunca
  una credencial). El panel de navegador `/dsh-agent-checkin/models` es la entrada equivalente
  cuando no hay interfaz de ajustes; ambos leen y escriben ese mismo archivo.

Todo esto necesita que el proceso host lance Python y lea archivos, así que ocurre en el host; la
mitad de navegador solo emite llamadas HTTP a subrutas de `/dsh-agent-checkin/settings`. La credencial nunca
atraviesa el frontend ni llega a un log — un guardado correcto responde solo con nombres de campo,
nunca con valores. Los informes de progreso del inicio de sesión tampoco llevan id de proceso.


### Idempotencia y persistencia

Cada ronda correcta se escribe en `$DSH_HOME/dsh-agent-checkin/last-run.json`, y una ronda no vuelve a
reclamar una plataforma que **ya tuvo éxito hoy** (día natural local). Esto importa porque los
puntos de reclamación son peticiones de red reales: ejecutar `/checkin` dos veces por accidente no
debe golpearlos dos veces.

- La protección es por plataforma **y por día natural**, y solo cuenta `OK` / `ALREADY` / `DONE`
  en plataformas que realmente tienen acción de reclamación.
- **Los fallos nunca se recuerdan** — una plataforma que falló puede reintentarse de inmediato.
- **Las simulaciones no activan la protección** — no reclaman nada, así que no son prueba de
  «ya hecho hoy».
- `/checkin --force` (o `checkin_run` con `force: true`) la omite; esa salida es deliberada y no
  silenciosa.
- Cuando ya está todo hecho, la ronda informa `source: skipped` y **no envía ninguna petición**.
  Es un tercer resultado, ni éxito ni fallo.
- El archivo de estado guarda solo una lista blanca de campos de presentación. Las cookies, los
  tokens y los JWT nunca llegan al disco.
- Si el archivo de estado no se puede leer o es de un formato anterior, se ignora en vez de
  confiar en él, y la ronda se comporta como la primera.

### Registro diario automático

| Comando | Qué hace |
| --- | --- |
| `/checkin-schedule on 09:00` | activa un recordatorio diario en esta sesión (hora opcional, por defecto 09:00) |
| `/checkin-schedule off` | lo desactiva |
| `/checkin-schedule status` | muestra el estado y la hora realmente en vigor |

La tarea vive en el servicio Schedule del host y se dispara **con el reloj local de tu máquina**.
Cuando se dispara, la sesión actual recibe un recordatorio que pide al agente llamar a
`checkin_run` y reportar el resultado.

El plugin solo promete lo que realmente puede garantizar:

- El host garantiza que el recordatorio **entra en la bandeja de la sesión**, no que el modelo se
  despierte en el instante exacto. Si la sesión está inactiva, el recordatorio se procesa cuando
  vuelvas a abrirla.
- Por tanto el registro ocurre en la ruta **el agente recibe el recordatorio y llama a la
  herramienta**; el plugin no ejecuta nada en secreto por detrás.
- Repetir `on` en la misma sesión no apila tareas duplicadas; `off` solo borra la tarea que creó
  este plugin y no toca tus otros recordatorios.
- Con `allowClaim: false` el horario también se dispara, pero esa ronda sigue siendo de solo
  lectura: la salida del comando lo dice explícitamente.

Para cambiar la hora, ejecuta `on HH:mm` otra vez; reemplaza la tarea anterior.

### Empujar resultados a la sesión

Con `pushResult: true` (por defecto), `/checkin` inyecta un resumen de la ronda en la sesión actual
para consultarlo después. Usa `agent.inject()`, no `followup()`: **la inyección no despierta una
sesión inactiva**; el contenido se ve en la siguiente petición de esa sesión. El resultado de un
registro es algo que la sesión debe saber, pero por lo que no debe ser interrumpida.

Si el empuje falla (sin sesión, rechazo del host) solo se registra un aviso y nunca convierte el
resultado del registro en un fallo: estás viendo el resultado real de la ronda y no debe
reclasificarse porque un envío secundario no llegó.

### ¿Hay que dejar el cliente abierto?

Si los modelos de una plataforma funcionan depende de **de dónde sale la credencial**, no de si la
app está abierta. Tres grupos:

| Plataforma | ¿El cliente debe seguir abierto? | Por qué |
| --- | --- | --- |
| **DuMate (Baidu)** | **Sí — debe seguir abierto** (haya sesión o no) | Su pasarela de modelos es **local**: un `dumate-main-server` en un puerto aleatorio, y tanto el puerto como `X-Dumate-Inapp-Key` cambian en cada arranque. Cierras el cliente y los modelos desaparecen. **Es la única plataforma que lo exige de verdad.** |
| **WPS Lingxi** | **No** (pero la cookie debe estar fresca) | Su API de modelos está **en la nube** (`lingxi.wps.cn`): se crea una sesión con `POST /api/aioffice/v1/sessions` y la inferencia corre por `wss://…/completions/ws`. No interviene ningún puerto local. El cliente es solo el **origen del estado de sesión**: la cookie se recoge de él y luego el cliente puede cerrarse. La cookie **caduca a los tres días** (`exp=259200`), así que de vez en hay que reabrir el cliente para volver a recogerla. |
| **WorkBuddy CN / global** | **No, pero el cliente debe estar instalado** | La API de modelos también está en la nube (`copilot.tencent.com` / `www.codebuddy.ai`). Pero desde la 5.6.x el cliente cifra sus campos de sesión (`$wbEncrypted`), y la clave de descifrado la entrega el **binario de escritorio** vía `ELECTRON_RUN_AS_NODE` — así que `WorkBuddy.exe` tiene que estar presente y ser **ejecutable** en esta máquina (instalado basta; no hace falta que esté corriendo). |
| **TRAE CN / global** | No | Credencial y catálogo son **archivos estáticos** (`storage.json` + `state.vscdb`), se leen una vez. |
| **Qoder CN** | No | La credencial vive en el almacenamiento OSCrypt de Chromium y se descifra en memoria con el DPAPI del sistema, sin relación con el proceso del cliente. |

En una frase: **solo DuMate exige el cliente abierto; Lingxi necesita una cookie fresca (no el cliente
abierto); WorkBuddy necesita el cliente instalado (no abierto).**

> **Dónde vive la cookie de Lingxi**: `<dshHome>/dsh-agent-checkin/engine/lx_cookie.txt` (recomendado:
> reinstalar el plugin ya no la borra). El plugin busca en este orden: la variable de entorno
> `LINGXI_COOKIE_FILE` → esa ruta → el `engine/lx_cookie.txt` incluido en el paquete. Solo cuando
> fallan las tres la plataforma cuenta como «no conectada», y la tarjeta lista entonces todas las
> rutas que probó.

### Usar TRAE como proveedor de modelos

Actívelo:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    traeProvider: true
```

Al activarse, el plugin lee dos archivos del cliente TRAE ya conectado, **en modo solo lectura**:

| Archivo | Qué aporta |
| --- | --- |
| `%APPDATA%\TRAE CN\User\globalStorage\storage.json` | el token de sesión descifrado, el id de dispositivo, el id de usuario, la región |
| `%APPDATA%\TRAE CN\User\globalStorage\state.vscdb` | el catálogo de modelos — la lista de modelos que su cuenta puede usar |

No se escribe nada de vuelta. Las credenciales no se envían a ningún sitio salvo al propio dominio
de API de TRAE — el mismo dominio con el que habla el cliente, tomado de la credencial y no
codificado de forma fija.

El proveedor aparece entonces en el selector de modelos como **TRAE（本机客户端）**. Después puede
conversar con cualquier modelo del catálogo. El plugin envía la misma petición real que hace el
propio cliente — `POST /api/agent/v3/llm_utils_chat` en la pasarela de su región
(`https://trae-api-cn.mchost.guru` para el cliente CN), con la misma autenticación `Cloud-IDE-JWT`
y la misma identidad de dispositivo — así que se aplica la cuota propia de la cuenta.

El plugin dice tres cosas con toda claridad:

- **La disponibilidad depende del `function` bajo el que esté listado el modelo.** El endpoint de
  chat es `/api/agent/v3/llm_utils_chat`, y el cuerpo de la petición lleva un `function` junto a
  `model`: **un modelo solo existe bajo algunos de ellos**. El plugin elige a partir de
  `appearedIn` del catálogo en el orden `solo_work_remote` → `solo_work_lite` →
  `solo_agent_remote` → `chat_v3` → `solo_coder`, y siempre cae en `solo_work_remote`; nunca
  reenvía nombres de categoría que no sean de chat, como `assistant` o `solo_agent`.
- **No todos los modelos son invocables: 30 de los 34 seleccionables responden, 4 son rechazados
  por el servidor.** El 2026-10-18 se envió una petición real mínima a cada uno.
  `deepseek//deepseek-v4-flash`, `deepseek//deepseek-v4-pro` (variantes con `base_url` propio),
  `kimi-k2.8-preview` y `qwen3.8-flash` devolvieron `4001` bajo todos los `function` candidatos,
  así que se consideran no disponibles en origen — el propio cliente tampoco puede invocar esas
  dos variantes. Un modelo que sí funciona puede funcionar bajo un solo `function`:
  `DeepSeek-V4-Flash-Official` responde en `solo_work_remote` / `solo_work_lite` /
  `solo_agent_remote`, devuelve `1005` (el plan de pago no lo cubre) en `chat_v3` y `4001` en
  `solo_coder`. El servidor puede cambiar todo esto, así que el plugin no filtra de antemano.
- **La respuesta es transmisión real, pero las tramas tienen nombre, no forma de OpenAI.** El
  origen envía `event: output` (`response` / `reasoning_content` / `tool_calls`),
  `event: token_usage` y `event: done`, además de tramas de contabilidad (`metadata` /
  `timing_cost` / `progress_notice`). El plugin convierte `output` en chunks de OpenAI, normaliza
  `token_usage` en usage y traduce `done` en `finish_reason`; las tramas de contabilidad se
  descartan. Así el texto aparece token a token, con las trazas internas ocultas.

> **Corrección de una afirmación anterior de este README.** Antes decía «los 34 modelos
> respondieron `HTTP 200`». Era falso: esas pruebas iban a `/api/ide/v2/llm_raw_chat`, un endpoint
> inferido que el cliente local nunca envía, y los 200 eran tramas de error de peticiones GET o no
> JSON. Contra el endpoint real `llm_utils_chat` el resultado es el 30 / 4 de arriba.

Si TRAE no está instalado, no hay sesión iniciada, o los archivos no se pueden leer, el proveedor
simplemente no se registra y el registro dice por qué. Todo lo demás del plugin sigue funcionando.

> **Estado de implementación (v0.6.0, 2026-10-17).** El antiguo problema de «el registro en DSH
> está roto» está **corregido**. La integración de TRAE se rehízo sobre la arquitectura común de
> cinco capas de `lib/connect/`: credenciales locales (solo lectura) → catálogo de modelos
> (state.vscdb, con refresco TTL) → shim de bucle invertido (`127.0.0.1`, puerto aleatorio +
> bearer aleatorio, que traduce el protocolo agent-task a SSE de OpenAI) → el PiAiAdapter del
> propio host (streaming / uso / niveles de pensamiento) → `registerAdapter` +
> `registerConfigurableProviders` (array de providers, settingsNs, declared:false, según el
> contrato del host). Los clientes CN y global son proveedores separados, controlados por
> `traeProvider` / `traeIntlEnabled` respectivamente.

### Usar Qoder CN como proveedor de modelos

Actívelo:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    qoderCnEnabled: true
```

El plugin lee el estado de sesión del cliente Qoder conectado (almacenado con OSCrypt de
Chromium, descifrado vía DPAPI del sistema en memoria; los archivos temporales se borran de
inmediato) y registra el catálogo de modelos a través del mismo shim de bucle invertido como
proveedor **Qoder CN (cliente local)**. Si el cliente no está, no hay sesión o la credencial no
se puede descifrar, el proveedor no se registra y el registro explica por qué; todo lo demás
sigue funcionando.

### Usar WorkBuddy como proveedor de modelos

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    wbProvider: true        # cliente CN
    wbProviderIntl: true    # cliente global (opcional)
```

> **Nota de conflicto.** Esta función asume la conexión de modelos del plugin heredado
> **dsh-connect-workbuddy**. Tener ambos activos los hace competir por el mismo id de proveedor.
> Desactive primero el plugin heredado: ajustes de DSH → Plugins → dsh-connect-workbuddy →
> desactivar, y reinicie el host; desinstálelo si desactivarlo no basta. Ante un conflicto de id,
> este plugin registra una advertencia y omite el registro de WorkBuddy, sin afectar a las demás
> plataformas ni al registro de puntos.

El catálogo proviene del `/v3/config` del cliente (separado por canal CN/global), y los id de
modelo son **idénticos byte a byte** a los del plugin heredado, así que las sesiones y ajustes
existentes migran directamente. La renovación del token próxima a expirar ocurre solo en memoria
del proceso: nada se escribe en disco y ningún archivo del cliente se modifica.

### Conectar modelos

Declare una ruta en la configuración:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    modelRoutes:
      - provider: my-gateway
        displayName: My Gateway
        api: openai-completions
        baseURL: https://gateway.example.com/v1
        apiKeyEnv: MY_GATEWAY_API_KEY
        models:
          - id: some-model
            name: Some Model
            contextWindow: 131072
            maxTokens: 8192
```

Luego aplíquela:

| Superficie | Cómo |
| --- | --- |
| Comando | `/checkin-models` — escribe las rutas en el perfil actual |
| Herramienta | `model_route_apply` — igual, con `dryRun: true` para previsualizar |

`api` acepta `openai-completions`, `openai-responses` o `anthropic-messages`. Una ruta
autoconstruida **debe** enumerar sus modelos: el host no tiene entrada de catálogo a la que
recurrir, y una ruta sin modelos se rechaza de plano.

La aplicación pasa por el servicio `configEditor` del host cuando está disponible: esa ruta
conserva los comentarios YAML, escribe de forma atómica, revierte si falla y recarga la
configuración. Cuando falta `configEditor`, el plugin edita directamente el parche del perfil, lo
que requiere reiniciar DSH.

> **Limitación (aún sin implementar).** `modelRoutes` admite **solo credenciales estáticas**:
> `apiKeyEnv` es el *nombre de una variable de entorno*, no un token que pueda tomarse del estado
> de sesión de un cliente de escritorio en el momento de la petición. Cualquier upstream cuya
> credencial solo exista dentro de otra app en tiempo de ejecución no puede conectarse así.
> Tampoco admite `headers` todavía: el `PiAiProviderProfile` del host tiene ese campo, pero ni el
> esquema `modelRoutes` de este plugin ni `toProviderProfile()` lo exponen. Véase
> `模型接入路线-逐平台定案.md` §1 y §3.4.

## Honest reporting

El resumen de registro mantiene deliberadamente cuatro números separados:

- **success** cuenta `OK` / `ALREADY` / `DONE`
- **neutral** cubre `DRY_RUN` / `READONLY` / `INACTIVE`
- **blocked** cubre `SANDBOX_BLOCKED`
- **failure** cubre `AUTH_REJECTED` / `FORBIDDEN` / `NETWORK` / `ERROR` / `EXCEPTION`

`READONLY` significa «esta plataforma no tiene ninguna acción de reclamo que ejecutar». No es un
éxito, y fundirlo en el recuento de éxitos inflaría el numerador y disfrazaría de completada una
acción inexistente. El resumen informa `healthy` por separado: plataformas que *sí* tienen una
acción de reclamo real **y** tuvieron éxito.

`blocked` existe porque algunos fallos no tienen nada que ver con la plataforma. Descifrar las
credenciales guardadas requiere un archivo temporal, así que los adaptadores llaman a
`tempfile.mkdtemp()` y escriben allí una clave. Bajo un sandbox workspace-write el proceso hijo
puede crear el directorio pero no escribir dentro, y el descifrado falla con
`PermissionError [Errno 13]`. Los adaptadores lo clasifican como «credenciales no disponibles», lo
que te llevaría a iniciar sesión de nuevo — y volver a iniciar sesión no arregla nada. El plugin lo
reclasifica como `SANDBOX_BLOCKED`, conserva el error original para poder rastrearlo y dice
claramente que es un límite del entorno, no un problema de credenciales. Solo la combinación de un
error de permiso denegado **y** evidencia que apunte al entorno de ejecución (una ruta temporal, o
que el propio sandbox se nombre) activa la reclasificación; un archivo de credenciales realmente
ilegible o una sesión caducada siguen informando `failure`.

Los saldos nunca se suman entre plataformas. Créditos, puntos y valores de inspiración son monedas
distintas; sumarlos produce un número sin significado.

### Plataformas admitidas

`workbuddy`, `workbuddy_intl`, `trae`, `lingxi`, `dumate`, `qwenwork` y `phanthywork` tienen una
acción de reclamo real (`claiming: true`). `jimeng`, `coze` y `kling` son solo sondas de estado de
solo lectura (`claiming: false`): informan de lo que tiene la cuenta, pero el plugin nunca reclama
por ellas.

### Dónde escribe el motor

El motor incluido vive dentro del paquete instalado. Dos adaptadores guardan junto a él las cookies
introducidas a mano, y el adaptador de automatización de navegador crea allí su perfil desechable
(`jimeng_cookie.txt`, `lx_cookie.txt`, `.<name>_profile/`). Los paquetes instalados con npm suelen
ser de solo lectura, así que o bien:

- apunta `homeDir` a una copia escribible del motor, **o**
- deja preparados `jimeng_cookie.txt` / `lx_cookie.txt` en un lugar donde el motor pueda escribir, y
  asume que los adaptadores de automatización de navegador (`jimeng`) fallarán en vez de funcionar a
  medias en silencio.

Todo lo que toca credenciales reales se queda en esos archivos; nada sale de tu máquina. La política
de los autores del motor está en `engine/SECURITY.md` y los riesgos del registro automático en
`engine/DISCLAIMER.md`.

### La pasarela local de DuMate y su clave efímera

La app de escritorio de DuMate expone un endpoint compatible con OpenAI en un puerto local
aleatorio, pero cada petición debe llevar la cabecera `X-Dumate-Inapp-Key`: una cadena hexadecimal
aleatoria de 32 bytes generada al arrancar el proceso e inyectada en el renderer y en los procesos
hijo mediante una variable de entorno. **Cambia en cada reinicio.**

El valor no está en ningún archivo de configuración, pero **sí se imprime en los logs de la
propia app**:

```
log\electron.log        DUMATE_INAPP_KEY: '<64 hex>'
log\desktop-main\Main.log
  [OPENCODE PROXY] ... headers: map[ ... X-Dumate-Inapp-Key:[<64 hex>] ]
```

Así que un proceso DSH independiente *sí* puede leerlo en tiempo de ejecución (y el puerto
también, de la línea `doInitServices completed, result: {"backendPort":…}`). Con dos costes:
DuMate tiene que estar **en marcha** para que existan puerto y clave, y el formato del log es un
detalle de implementación de la versión actual (1.0.83.335) que puede cambiar.

El plugin **sí** distribuye una ruta de modelo de DuMate: lee el puerto y `X-Dumate-Inapp-Key` de
los logs y reenvía por un shim local a `http://127.0.0.1:<port>/api/qianfanproxy/v1/chat/completions`
(el upstream ya es compatible con OpenAI, así que no hace falta traducir el protocolo). Eso hace de
DuMate la **única plataforma de modelos que exige que el cliente siga abierto**: si lo cierras no
hay puerto ni clave, y los modelos desaparecen. El *registro* de DuMate funciona perfectamente y no
usa nada de esto: lee la cookie que la propia app guarda y llama a los endpoints oficiales de Baidu.

## Configuration reference

| Clave | Predeterminado | Significado |
| --- | --- | --- |
| `pythonCommand` | `python` | Ejecutable de Python que impulsa el motor de registro |
| `homeDir` | `engine/` incluido | Raíz que contiene `adapters/` y `bridge.py` |
| `timeoutMs` | `180000` | Tiempo de espera por ronda |
| `allowClaim` | `false` | Permite el reclamo real; `false` fuerza solo lectura |
| `pushResult` | `true` | Inyectar el resumen de una ronda manual en la sesión actual |
| `statusRoute` | `/dsh-agent-checkin` | Prefijo del endpoint HTTP de estado |
| `traeProvider` | `false` | Registrar el cliente TRAE CN conectado como proveedor de modelos |
| `traeIntlEnabled` | `false` | Registrar el cliente TRAE global (puede convivir con CN) |
| `qoderCnEnabled` | `false` | Registrar el cliente Qoder CN conectado como proveedor de modelos |
| `wbProvider` | `false` | Registrar el cliente WorkBuddy CN conectado como proveedor de modelos |
| `wbProviderIntl` | `false` | Registrar el cliente WorkBuddy global (puede convivir con CN) |
| `modelRoutes` | `[]` | Rutas de proveedor a conectar en DSH |

`pythonCommand` / `homeDir` / `timeoutMs` / `allowClaim` / `pushResult` admiten **recarga en
caliente** (`volatile`): aparecen en el panel de ajustes del host y surten efecto en la siguiente
ronda sin reiniciar. `statusRoute` / `modelRoutes` y los cinco interruptores de proveedor de
arriba no, porque son **hechos del momento de registro**: deciden qué ruta HTTP y qué proveedor
se registran. Hacerlos editables en caliente permitiría que la interfaz mostrara «desactivado»
mientras el proveedor sigue montado, lo cual es una mentira, así que exigen reinicio.

`sessionsDir` y `usageCacheSeconds` tampoco son `volatile`: solo los lee una vez el escáner de uso
(el escáner se crea en la fase de montaje, y sus parámetros quedan fijados en ese momento), así que
cambiarlos exige reiniciar el host para que surtan efecto.

El TTL de refresco de la lista (6 horas) y la dirección de la lista **no son** actualmente opciones de
configuración, sino constantes de `lib/model-rank.js` (`DEFAULT_RANK_TTL_MS`, `LEADERBOARD_URL`). No
se han expuesto como configuración porque cambiarlas mal solo puede hacer el panel más lento o más
propenso a fallar, nunca más exacto — y cuando de verdad haga falta refrescar más a menudo, el botón
«Refrescar lista» del panel es ese camino.

La **hora del registro diario no está en esta tabla a propósito**: vive en el registro de tareas del
servicio Schedule del host y se gestiona con `/checkin-schedule on HH:mm`. El plugin no mantiene su
propia copia de `dailyTime`, porque eso acabaría derivando en dos fuentes de verdad.

## Design notes

**¿Por qué un subproceso en lugar de un port nativo?** Las diez plataformas descifran sus
credenciales de diez maneras distintas (Electron at-rest AES-256-GCM, Chromium OSCrypt, AES-CBC
simple, firma Ed25519, automatización de navegador por CDP). Esas implementaciones ya están
endurecidas y cubiertas por ejecuciones reales, así que el plugin incluye un subconjunto cuidado de
ese motor (`engine/`, MIT, © 2026 sole373) en lugar de reescribirlo en Node: reescribir añadiría
modos de fallo sin eliminar ninguno. La tarea del plugin es la orquestación y la presentación.

**¿Por qué no escribir un `LlmAdapter`?** El host ya incluye `@deepseek-ai/dsh-llm-pi-ai`, que
gestiona el troceado en streaming, los deltas de llamadas a herramientas, la normalización de
`usage`, el mapeo de niveles de pensamiento y los presupuestos de imagen. Reimplementarlo
significaría reimplementar un protocolo de streaming *y* competir por la misma ranura de registro
LLM, lo que se desvía en silencio la próxima vez que el host se actualice. Registrar una ruta es un
problema de configuración, así que el plugin lo resuelve como tal.

Los proveedores de cliente local TRAE / Qoder / WorkBuddy también usan el mismo PiAiAdapter: la
regla ya no se dobla. El plugin solo levanta un shim de bucle invertido en `127.0.0.1` (puerto
aleatorio + bearer aleatorio) en su propio lado, que traduce el protocolo privado de cada cliente
a un `/v1/chat/completions` compatible con OpenAI, y PiAiAdapter lo llama como a cualquier
endpoint OpenAI. La traducción de protocolo es el único código más allá de la configuración, y
tiene que existir: estos clientes no exponen ningún endpoint público al que apuntar, y sus
credenciales viven dentro de un cliente de escritorio con sesión iniciada, no en una clave de
API. Las credenciales permanecen en la memoria del proceso y en el puerto de bucle invertido:
ningún secreto nuevo se escribe en disco.

## Licence

MIT — para este plugin. El subconjunto `engine/` incluido también es MIT, Copyright (c) 2026
sole373; su aviso se conserva en `engine/ENGINE-LICENSE.txt`, y sus `DISCLAIMER.md` /
`SECURITY.md` viajan con el paquete y obligan en el uso de esa parte.
