// Interfaz de la PWA. Toda la lógica de comparación está en motor.js.
// Ningún dato sale del dispositivo: no hay llamadas de red salvo la carga de la app
// y del diccionario de ejemplo, ambos servidos desde la caché del service worker.
import { procesar, crearAdaptador, ADAPTADOR_POR_DEFECTO, LecturaError, ConfigError } from "./motor.js";
import { mdToHtml, htmlDocumento } from "./markdown.js";
import { construirResumen } from "./resumen.js";
import { inspeccionar, reporteEstructural, LEYENDA_INSPECCION } from "./inspeccion.js";
import { ejecutarSimulacion, LEYENDA_SIMULACION, EXPLICACION_DEMOSTRATIVA } from "./simulacion.js";
import { construirSolicitud, validarRegistro } from "./ia-validacion.js";
import {
  leerConfiguracionIA, guardarConfiguracionIA, borrarConfiguracionIA,
  iaDisponible, resumenEnvio, consultarIA,
} from "./ia-cliente.js";
import { crearAlmacenHistorial, ErrorCuota, ErrorEscritura, ErrorDatos, ESTADO, estadoDe, CLAVE_LEGADO, CLAVE_V2 } from "./historial.js";

const VERSION = "1.4.0";
const RUTA_REGISTRO_IA = "ejemplo/documentos-demo/documentos.json";
let registroIA = null;
const CLAVE_AJUSTES = "comparador.adaptador";

const $ = (sel) => document.querySelector(sel);

// Escapa cualquier dato del archivo antes de insertarlo en la página.
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const dato = (v) => (v === null || v === undefined || v === "" ? "—" : esc(v));

// ---------- Navegación ----------

function mostrarVista(id) {
  for (const v of document.querySelectorAll(".vista")) v.hidden = v.id !== id;
  // Simulación e inspección se abren desde la pantalla de inicio (pestaña Comparar).
  const pestana = id === "vista-simulacion" || id === "vista-inspeccion" ? "vista-comparar" : id;
  for (const b of document.querySelectorAll(".nav")) b.classList.toggle("activo", b.dataset.vista === pestana);
  if (id === "vista-historial") renderHistorial();
  window.scrollTo({ top: 0 });
}

// ---------- Red ----------

function actualizarEstadoRed() {
  const el = $("#estado-red");
  const enLinea = navigator.onLine;
  el.textContent = enLinea ? "En línea" : "Sin conexión";
  el.classList.toggle("en-linea", enLinea);
}

// ---------- Ajustes (adaptador) ----------

function ajustesGuardados() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_AJUSTES) ?? "{}");
  } catch {
    return {};
  }
}

function adaptadorActual() {
  return crearAdaptador(ajustesGuardados());
}

function cargarFormularioAjustes() {
  const cfg = { ...ADAPTADOR_POR_DEFECTO, ...ajustesGuardados() };
  for (const k of Object.keys(ADAPTADOR_POR_DEFECTO)) {
    const el = $(`#a-${k}`);
    if (el) el.value = cfg[k];
  }
}

function guardarAjustes(e) {
  e.preventDefault();
  const obj = {};
  for (const k of Object.keys(ADAPTADOR_POR_DEFECTO)) {
    const el = $(`#a-${k}`);
    if (el) obj[k] = el.value.trim();
  }
  try {
    crearAdaptador(obj);
    localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(obj));
    $("#estado-ajustes").textContent = "Ajustes guardados.";
  } catch (err) {
    $("#estado-ajustes").textContent = `No se guardó: ${err.message}`;
  }
}

function restaurarAjustes() {
  localStorage.removeItem(CLAVE_AJUSTES);
  cargarFormularioAjustes();
  $("#estado-ajustes").textContent = "Valores por defecto restaurados.";
}

// ---------- Ajustes de IA (URL del servicio y token de acceso) ----------

function cargarFormularioIA() {
  const c = leerConfiguracionIA();
  $("#ia-url").value = c.url;
  $("#ia-token").value = c.token;
}

function guardarFormularioIA(e) {
  e.preventDefault();
  const r = guardarConfiguracionIA({ url: $("#ia-url").value, token: $("#ia-token").value });
  $("#estado-ia").textContent = r.ok
    ? "Configuración de IA guardada en este dispositivo."
    : `No se guardó: ${r.error}`;
}

function limpiarFormularioIA() {
  borrarConfiguracionIA();
  cargarFormularioIA();
  $("#estado-ia").textContent = "Configuración de IA borrada de este dispositivo.";
}

// ---------- Archivos y huellas ----------

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function leerArchivo(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function mostrarNombre(input, destino) {
  const f = input.files[0];
  $(destino).textContent = f ? `${f.name} (${f.size.toLocaleString("es-MX")} bytes)` : "";
}

// ---------- Comparación ----------

function mostrarError(msg) {
  const el = $("#error");
  el.textContent = msg;
  el.hidden = false;
}

function ocultarError() {
  $("#error").hidden = true;
}

async function comparar() {
  ocultarError();
  const fa = $("#fa").files[0];
  const fb = $("#fb").files[0];
  const usarEjemplo = $("#usar-ejemplo").checked;
  const fd = $("#fd").files[0];

  if (!fa || !fb) return mostrarError("Seleccione las exportaciones A y B.");
  if (!usarEjemplo && !fd) return mostrarError("Seleccione el diccionario o marque el diccionario de ejemplo.");

  let adaptador;
  try {
    adaptador = adaptadorActual();
  } catch (err) {
    return mostrarError(`Ajustes no válidos: ${err.message}`);
  }

  try {
    const bytesA = await leerArchivo(fa);
    const bytesB = await leerArchivo(fb);
    let bytesD;
    let nombreD;
    if (usarEjemplo) {
      const resp = await fetch("ejemplo/diccionario.csv");
      if (!resp.ok) throw new Error("no se encontró el diccionario de ejemplo");
      bytesD = new Uint8Array(await resp.arrayBuffer());
      nombreD = "diccionario.csv (ejemplo)";
    } else {
      bytesD = await leerArchivo(fd);
      nombreD = fd.name;
    }

    const [shaA, shaB, shaD] = await Promise.all([sha256Hex(bytesA), sha256Hex(bytesB), sha256Hex(bytesD)]);
    const r = procesar({
      diccionario: { bytes: bytesD, nombre: nombreD, sha256: shaD },
      a: { bytes: bytesA, nombre: fa.name, sha256: shaA },
      b: { bytes: bytesB, nombre: fb.name, sha256: shaB },
      adaptador,
    });

    const entrada = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fecha: new Date().toISOString(),
      a: { nombre: fa.name, sha256: shaA },
      b: { nombre: fb.name, sha256: shaB },
      d: { nombre: nombreD, sha256: shaD },
      cambios: r.resultado.valores.length,
      noComparables: r.resultado.noComparables.length,
      errores: r.resultado.errores.length,
      markdown: r.markdown,
    };
    const avisoGuardado = await guardarEnHistorial(entrada);
    renderResultados(r, entrada);
    if (avisoGuardado) mostrarAvisoGuardado(avisoGuardado, "#resultados");
  } catch (err) {
    if (err instanceof LecturaError || err instanceof ConfigError) {
      mostrarError(err.message);
      $("#resultados").innerHTML = "";
    } else {
      mostrarError(`Error inesperado: ${err.message}`);
    }
  }
}

// ---------- Presentación de resultados ----------

const kpi = (n, etiqueta) => `<div class="kpi"><b>${esc(n)}</b><span>${esc(etiqueta)}</span></div>`;

function valorConUnidad(p) {
  if (!p) return "—";
  const valor = p.valor === null ? "nulo" : p.valor;
  return esc(valor) + (p.unidad ? ` <span class="ayuda">${esc(p.unidad)}</span>` : "");
}

function renderResumenHTML(res) {
  const filas = [
    ["Motor", res.motor],
    ["ECM", res.ecm],
    ["Calibración A", res.calibracionA],
    ["Calibración B", res.calibracionB],
    ["Software A", res.softwareA],
    ["Software B", res.softwareB],
  ];
  const hallazgos = res.hallazgos.length
    ? res.hallazgos.map((h) => `<li class="hallazgo ${esc(h.tipo)}">${esc(h.texto)}</li>`).join("")
    : '<li class="hallazgo">No se encontraron diferencias entre parámetros comparables.</li>';
  return `
    <div class="banner-no-verificado" role="status">
      <strong>Compatibilidad: NO VERIFICADA</strong>
      <p>Esta herramienta no determina compatibilidad entre calibraciones. Solo el fabricante puede confirmarla.</p>
    </div>

    <h2>Resumen del análisis</h2>
    <div class="tarjeta">
      <div class="datos-resumen">
        ${filas.map(([e, v]) => `<div class="dato"><span class="meta">${esc(e)}</span><b>${esc(v)}</b></div>`).join("")}
      </div>
    </div>

    <div class="resumen">
      ${kpi(res.diferencias, "diferencias de valor")}
      ${kpi(res.noComparables, "no comparables")}
      ${kpi(res.revision, "requieren revisión")}
      ${kpi(res.errores, "errores de lectura")}
    </div>

    <h2>Hallazgos principales</h2>
    <p class="ayuda">Descripción de los resultados del software. No indican cuál configuración es correcta.</p>
    <ul class="hallazgos">${hallazgos}</ul>

    <div class="ia-nota">${res.iaEjecutada
      ? ""
      : "No se ejecutó ningún modelo de IA en este análisis. Los hallazgos los genera el software a partir de los resultados, no una IA."}</div>`;
}

function renderResultados(r, entrada, destino = "#resultados", sufijo = "") {
  const { resultado, definiciones } = r;
  const emisiones =
    resultado.valores.filter((d) => d.emision).length +
    resultado.noComparables.filter((n) => n.emision).length;

  const identificacion = resultado.identificacion.map((f) => `
    <div class="fila-dato">
      <div><strong>${esc(f.campo)}</strong><span class="estado ${esc(f.estado)}">${esc(f.estado)}</span></div>
      <div>A: ${dato(f.a?.valor)} · B: ${dato(f.b?.valor)}</div>
      <div class="meta">${dato(f.a?.origen)} / ${dato(f.b?.origen)}</div>
    </div>`).join("");

  const valores = resultado.valores.length
    ? resultado.valores.map((d) => `
      <article class="tarjeta-dif">
        <header>${esc(d.nombre)} <span class="estado ${esc(d.estado)}">${esc(d.estado)}</span></header>
        <p class="valores">A: <b>${valorConUnidad(d.a)}</b> → B: <b>${valorConUnidad(d.b)}</b></p>
        <p class="doc ${d.confianza.startsWith("con") ? "ok" : "alerta"}">${esc(d.confianza)}${
          definiciones.has(d.nombre) ? `: ${esc(definiciones.get(d.nombre).fuente)}` : ""}</p>
        ${d.a ? `<p class="origen">${esc(d.a.origen)}</p>` : ""}
        ${d.b ? `<p class="origen">${esc(d.b.origen)}</p>` : ""}
        ${d.emision ? '<span class="revision">Revisión humana obligatoria</span>' : ""}
      </article>`).join("")
    : '<p class="ayuda">No se encontraron diferencias de valor entre parámetros comparables.</p>';

  const noComp = resultado.noComparables.length
    ? resultado.noComparables.map((n) => `
      <article class="tarjeta-dif">
        <header>${esc(n.nombre)}</header>
        <p class="doc alerta">${esc(n.motivo)}</p>
        <p class="origen">${esc(n.origenes.join(", ") || "—")}</p>
        ${n.emision ? '<span class="revision">Revisión humana obligatoria</span>' : ""}
      </article>`).join("")
    : '<p class="ayuda">Ninguno.</p>';

  const docs = resultado.valores.filter((d) => definiciones.has(d.nombre));
  const documentacion = docs.length
    ? docs.map((d) => `<p class="fila-dato">${esc(d.nombre)} — <span class="meta">${esc(definiciones.get(d.nombre).fuente)}</span></p>`).join("")
    : '<p class="ayuda">Ningún parámetro con diferencias tiene definición documentada.</p>';

  const errores = resultado.errores.length
    ? `<ul class="lista">${resultado.errores.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
    : '<p class="ayuda">Sin errores de lectura.</p>';

  const res = construirResumen(resultado);
  $(destino).innerHTML = `
    ${renderResumenHTML(res)}

    <div class="fila-botones">
      <button id="dl-md${sufijo}" type="button" class="secundario">Descargar Markdown</button>
      <button id="dl-html${sufijo}" type="button" class="secundario">Descargar HTML</button>
    </div>

    <details class="detalles-tecnicos">
      <summary>Detalles técnicos: tablas completas, SHA-256 y trazabilidad</summary>
      <div class="detalles-cuerpo">
        <div class="resumen">
          ${kpi(resultado.valores.length, "diferencias de valor")}
          ${kpi(resultado.noComparables.length, "no comparables")}
          ${kpi(emisiones, "revisión de emisiones")}
          ${kpi(resultado.errores.length, "errores de lectura")}
        </div>

        <h2>1. Identificación</h2>
        <div class="tarjeta">${identificacion}</div>

        <h2>2. Diferencias de valores</h2>
        ${valores}

        <h2>3. Datos no comparables</h2>
        ${noComp}

        <h2>4. Revisión humana obligatoria (emisiones)</h2>
        <p class="ayuda">Estos parámetros requieren revisión por personal calificado. La herramienta no interpreta su efecto.</p>

        <h2>5. Documentación utilizada</h2>
        <div class="tarjeta">${documentacion}</div>

        <h2>6. Errores de lectura y trazabilidad</h2>
        <div class="tarjeta">${errores}</div>

        <h2>7. Interpretación asistida por IA</h2>
        <div class="ia-nota">La interpretación asistida, si se solicita, se muestra en la pantalla de resultados. No forma parte del reporte descargable, que contiene solo datos deterministas.</div>
        <p class="pie">A: ${esc(entrada.a.nombre)} · SHA-256 ${esc(entrada.a.sha256)}<br>
          B: ${esc(entrada.b.nombre)} · SHA-256 ${esc(entrada.b.sha256)}<br>
          Diccionario: ${esc(entrada.d.nombre)} · SHA-256 ${esc(entrada.d.sha256)}</p>
      </div>
    </details>`;

  if (sufijo === "") montarBloqueIA(r);

  const nombreBase = `reporte_${entrada.fecha.slice(0, 19).replace(/[:T]/g, "-")}`;
  $(`#dl-md${sufijo}`).addEventListener("click", () => descargar(`${nombreBase}.md`, entrada.markdown, "text/markdown"));
  $(`#dl-html${sufijo}`).addEventListener("click", () =>
    descargar(`${nombreBase}.html`, htmlDocumento(entrada.markdown, "Reporte de comparación"), "text/html"));
  $(destino).scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Interpretación asistida por IA (solo comparación, nunca simulación) ----------

// Bloque que aparece debajo del resumen. Sin configuración el botón queda deshabilitado.
function montarBloqueIA(r) {
  const cont = $("#resultados");
  const bloque = document.createElement("section");
  bloque.className = "bloque-ia";
  bloque.innerHTML = `
    <h2>Interpretación asistida por IA (opcional)</h2>
    <div class="tarjeta">
      <p class="ayuda">La IA solo explica diferencias que tienen documentación citada. Toda explicación requiere validación técnica humana.</p>
      <p id="ia-estado" class="ayuda" role="status"></p>
      <label class="casilla-demo"><input id="ia-demo" type="checkbox"> Autorizo esta prueba de IA y confirmo que solo se usarán datos sintéticos (parámetros DEMO_).</label>
      <button id="btn-ia" type="button" class="primario">Explicar diferencias con IA</button>
      <div id="ia-resultado"></div>
    </div>`;
  cont.appendChild(bloque);

  const config = leerConfiguracionIA();
  const disponible = iaDisponible(config, navigator.onLine);
  const actualizarBoton = () => { $("#btn-ia").disabled = !(disponible && $("#ia-demo").checked); };
  $("#ia-demo").addEventListener("change", actualizarBoton);
  actualizarBoton();
  $("#ia-estado").textContent = disponible
    ? "Servicio configurado. Antes de enviar se le mostrará exactamente qué información se enviará."
    : config.url
      ? "El servicio no está disponible: revise la conexión y el token en Ajustes."
      : "Servicio no configurado. Puede configurarlo en Ajustes; mientras tanto, el comparador funciona sin IA.";
  $("#btn-ia").addEventListener("click", () => explicarConIA(r));
}

async function cargarRegistroIA() {
  if (registroIA) return registroIA;
  const resp = await fetch(RUTA_REGISTRO_IA);
  if (!resp.ok) throw new Error("no se encontró el registro documental");
  const reg = await resp.json();
  const problemas = validarRegistro(reg);
  if (problemas.length) throw new Error("el registro documental no es coherente");
  registroIA = reg;
  return reg;
}

async function explicarConIA(r) {
  const salida = $("#ia-resultado");
  const boton = $("#btn-ia");
  const config = leerConfiguracionIA();
  let registro;
  try {
    registro = await cargarRegistroIA();
  } catch (err) {
    salida.innerHTML = `<div class="error">No se pudo preparar la interpretación: ${esc(err.message)}</div>`;
    return;
  }

  if (!$("#ia-demo").checked) {
    salida.innerHTML = '<p class="error">Marque la casilla de autorización para usar la IA en modo demostración.</p>';
    return;
  }
  // Modo demostración: solo parámetros sintéticos (DEMO_). Lo demás no se envía.
  const construida = construirSolicitud(r.resultado, registro);
  const items = construida.items.filter((it) => it.nombre.startsWith("DEMO_"));
  const noDeterminables = [
    ...construida.noDeterminables,
    ...construida.items
      .filter((it) => !it.nombre.startsWith("DEMO_"))
      .map((it) => ({ nombre: it.nombre, motivo: "fuera del modo demostración: solo se envían parámetros sintéticos DEMO_" })),
  ];
  if (items.length === 0) {
    salida.innerHTML = `<div class="tarjeta"><p class="ayuda">No hay diferencias de valor con documentación en el registro. No se envió nada.</p>
      ${noDeterminables.length ? `<ul class="lista">${noDeterminables.map((n) => `<li>${esc(n.nombre)}: ${esc(n.motivo)}</li>`).join("")}</ul>` : ""}</div>`;
    return;
  }

  // Confirmación explícita: el usuario ve exactamente lo que sale del dispositivo.
  const solicitud = { items };
  if (!confirm(`${resumenEnvio(solicitud)}\n\n¿Enviar esta información?`)) {
    salida.innerHTML = '<p class="ayuda">Envío cancelado. No se envió nada.</p>';
    return;
  }

  boton.disabled = true;
  salida.innerHTML = '<p class="ayuda">Consultando el servicio…</p>';
  const resp = await consultarIA({ solicitud, items, registro, config, modoDemo: true });
  boton.disabled = false;
  if (!resp.ok) {
    salida.innerHTML = `<div class="error">${esc(resp.error)}</div>`;
    return;
  }
  salida.innerHTML = renderIA(resp, noDeterminables, r);
}

function renderIA(resp, noDeterminables, r) {
  const datos = construirResumen(r.resultado).hallazgos;
  const validadas = resp.items.filter((i) => i.estado === "validada");
  const noDet = [
    ...noDeterminables.map((n) => ({ nombre: n.nombre, motivo: n.motivo })),
    ...resp.items.filter((i) => i.estado !== "validada").map((i) => ({ nombre: i.nombre, motivo: i.motivo })),
  ];

  const etiqueta = resp.modo === "demostracion"
    ? `<div class="aviso-demo" role="note"><strong>MODO DEMOSTRACIÓN</strong> · prueba técnica con datos sintéticos. No es una función de producción ni sirve para diagnóstico.</div>`
    : "";
  return `
    ${etiqueta}
    <div class="ia-bloque comprobado">
      <h3>Datos comprobados por el comparador</h3>
      <p class="ayuda">Obtenidos directamente de los archivos. No son interpretación.</p>
      <ul class="lista">${datos.map((h) => `<li>${esc(h.texto)}</li>`).join("")}</ul>
    </div>

    <div class="ia-bloque interpretacion">
      <h3>Interpretación de IA <span class="estado">requiere validación técnica</span></h3>
      ${validadas.length ? validadas.map((v) => `
        <article class="ia-explicacion">
          <p>${esc(v.texto)}</p>
          <p class="fuentes"><b>Fuentes:</b> ${v.fuentes.map((f) =>
            `${esc(f.doc)} ${esc(f.version)} · sección ${esc(f.seccion)} · ${esc(f.fuente)}`).join("; ")}</p>
          <p class="alerta-ia">Requiere validación técnica antes de cualquier decisión.</p>
        </article>`).join("")
        : '<p class="ayuda">Ninguna explicación superó la validación automática.</p>'}
    </div>

    <div class="ia-bloque no-determinable">
      <h3>No determinable</h3>
      ${noDet.length ? `<ul class="lista">${noDet.map((n) => `<li><b>${esc(n.nombre)}</b>: ${esc(n.motivo)}</li>`).join("")}</ul>`
        : '<p class="ayuda">Ningún parámetro quedó sin determinar.</p>'}
      ${resp.descartados ? `<p class="ayuda">${resp.descartados} respuesta(s) del modelo se descartaron por no superar la validación.</p>` : ""}
    </div>

    <p class="pie">Modelo: ${esc(resp.modelo ?? "—")} · Huella de la solicitud: ${esc(resp.huella ?? "—")} · ${esc(resp.generado ?? "")}</p>`;
}

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: `${tipo};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Historial local (estados: activo / archivado) ----------
// La lógica de almacenamiento está en historial.js. Aquí solo se muestra y se confirma.
// Ninguna acción de esta pantalla borra registros: solo archivar, restaurar y exportar.
// Cada registro se gestiona por su clave, así que un identificador repetido nunca afecta a otros.

let almacenHistorialInstancia = null;
const historial = () => {
  if (!almacenHistorialInstancia) {
    almacenHistorialInstancia = crearAlmacenHistorial({ almacen: globalThis.localStorage });
  }
  return almacenHistorialInstancia;
};

let filtroHistorial = "activos"; // "activos" | "archivados" | "todos"
const seleccion = new Set();     // claves de registro
let pendiente = null;            // { claves, estado } esperando confirmación
let ultimosRegistros = [];       // registros válidos del último render
let ultimasVisibles = [];        // claves visibles del último render
const ETIQUETAS_FILTRO = { activos: "Activos", archivados: "Archivados", todos: "Todos" };

const estaArchivada = (e) => estadoDe(e) === ESTADO.ARCHIVADO;
const fechaLegible = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("es-MX");
};

function mensajeFalloGuardado(err) {
  if (err instanceof ErrorCuota) {
    return "No se guardó esta comparación en el historial: el almacenamiento de este navegador está lleno. El reporte sigue disponible para descargar abajo. Archive comparaciones o exporte una copia para liberar espacio.";
  }
  if (err instanceof ErrorEscritura) {
    return `No se guardó esta comparación. ${err.message} El reporte sigue disponible para descargar abajo.`;
  }
  if (err instanceof ErrorDatos) {
    return "No se guardó esta comparación: el historial existente no se pudo leer y se protege sin modificarlo. El reporte sigue disponible para descargar abajo.";
  }
  return "No se guardó esta comparación por un fallo inesperado. El historial anterior se conserva. El reporte sigue disponible para descargar abajo.";
}

// Devuelve null si se guardó, o el mensaje que debe ver el técnico.
async function guardarEnHistorial(entrada) {
  try {
    await historial().agregar(entrada);
    return null;
  } catch (err) {
    return mensajeFalloGuardado(err);
  }
}

function mostrarAvisoGuardado(mensaje, destino) {
  $(destino).insertAdjacentHTML("afterbegin", `<div class="alerta-historial" role="alert">${esc(mensaje)}</div>`);
}

function mensajeHistorial(texto, esError = false) {
  const el = $("#estado-historial");
  el.textContent = texto;
  el.classList.toggle("error-historial", esError);
}

async function renderHistorial() {
  const lista = $("#lista-historial");
  let estado;
  try {
    estado = await historial().leer();
  } catch (err) {
    lista.innerHTML = `<div class="alerta-historial" role="alert">No se pudo leer el historial: ${esc(err.message)}</div>`;
    return;
  }

  const registros = estado.registros
    .filter((r) => r.clave !== null)
    .sort((a, b) => String(b.entrada.fecha ?? "").localeCompare(String(a.entrada.fecha ?? "")));
  ultimosRegistros = registros;
  const cuentas = {
    activos: registros.filter((r) => !estaArchivada(r.entrada)).length,
    archivados: registros.filter((r) => estaArchivada(r.entrada)).length,
    todos: registros.length,
  };
  const visibles = registros.filter((r) =>
    filtroHistorial === "todos" || (filtroHistorial === "archivados") === estaArchivada(r.entrada));
  ultimasVisibles = visibles.map((r) => r.clave);
  for (const clave of [...seleccion]) if (!ultimasVisibles.includes(clave)) seleccion.delete(clave);

  const avisos = estado.avisos.map((m) => `<div class="alerta-historial" role="alert">${esc(m)}</div>`);
  if (estado.modoGarantia !== "web-locks") {
    avisos.push(`<p class="ayuda">${estado.modoGarantia === "presencia"
      ? "Este navegador no admite bloqueo entre pestañas. Guarde o archive desde una sola pestaña de la aplicación."
      : "Este navegador no permite guardar el historial de forma segura. Puede consultarlo y exportarlo."}</p>`);
  }
  const uso = historial().uso();
  if (uso?.supera) {
    const mb = (uso.bytes / (1024 * 1024)).toFixed(1);
    avisos.push(`<div class="alerta-historial" role="status">El historial de este navegador ocupa aproximadamente ${mb} MB. Puede archivar lo que ya no necesite o exportar una copia. Nada se borra automáticamente.</div>`);
  }

  const filtros = Object.entries(ETIQUETAS_FILTRO).map(([clave, texto]) =>
    `<button type="button" class="filtro-historial" data-filtro="${clave}" aria-pressed="${filtroHistorial === clave}">${texto} (${cuentas[clave]})</button>`
  ).join("");

  const filas = visibles.length
    ? visibles.map(({ clave, entrada: h }) => `
      <div class="fila-historial">
        <input type="checkbox" data-sel="${esc(clave)}" aria-label="Seleccionar ${esc(h.a?.nombre ?? "")} contra ${esc(h.b?.nombre ?? "")}" ${seleccion.has(clave) ? "checked" : ""}>
        <button class="item-historial" type="button" data-id="${esc(clave)}">
          ${esc(h.a?.nombre ?? "")} vs ${esc(h.b?.nombre ?? "")}${estaArchivada(h) ? ' <span class="etiqueta-archivado">Archivado</span>' : ""}
          <small>${esc(fechaLegible(h.fecha))} · ${esc(h.cambios ?? 0)} cambios · ${esc(h.errores ?? 0)} errores${h.simulacion ? " · simulación" : ""}</small>
        </button>
      </div>`).join("")
    : '<p class="ayuda">No hay comparaciones en esta vista.</p>';

  const n = seleccion.size;
  const acciones = [
    '<button type="button" class="secundario" data-accion="seleccionar-visibles">Seleccionar visibles</button>',
  ];
  if (filtroHistorial !== "archivados") {
    acciones.push(`<button type="button" class="secundario" data-accion="archivar" ${n ? "" : "disabled"}>Archivar seleccionados (${n})</button>`);
  }
  if (filtroHistorial !== "activos") {
    acciones.push(`<button type="button" class="secundario" data-accion="restaurar" ${n ? "" : "disabled"}>Restaurar seleccionados (${n})</button>`);
  }

  let previa = "";
  if (pendiente) {
    const cambian = registros.filter((r) => pendiente.claves.includes(r.clave) && estadoDe(r.entrada) !== pendiente.estado);
    const accionTexto = pendiente.estado === ESTADO.ARCHIVADO ? "archivar" : "restaurar";
    const nombres = cambian.slice(0, 10).map(({ entrada: e }) => `<li>${esc(e.a?.nombre ?? "")} vs ${esc(e.b?.nombre ?? "")}</li>`).join("");
    const resto = cambian.length > 10 ? `<li>… y ${cambian.length - 10} más</li>` : "";
    previa = `
      <div class="vista-previa" role="region" aria-label="Vista previa de la operación">
        <p><strong>Vista previa:</strong> se van a ${accionTexto} ${cambian.length} comparación(es). Nada se borra; podrá revertirlo desde la vista correspondiente.</p>
        ${cambian.length ? `<ul class="lista">${nombres}${resto}</ul>` : "<p class=\"ayuda\">No hay cambios que aplicar.</p>"}
        <div class="fila-botones">
          <button type="button" data-accion="confirmar" ${cambian.length ? "" : "disabled"}>Confirmar</button>
          <button type="button" class="secundario" data-accion="cancelar">Cancelar</button>
        </div>
      </div>`;
  }

  lista.innerHTML = `
    ${avisos.join("")}
    <div class="filtros-historial" role="group" aria-label="Filtrar por estado">${filtros}</div>
    ${previa}
    <div class="fila-botones acciones-historial">${acciones.join("")}</div>
    ${filas}`;
}

function prepararCambio(claves, estado) {
  if (!claves.length) return;
  pendiente = { claves: [...claves], estado };
  renderHistorial();
}

async function confirmarCambio() {
  if (!pendiente) return;
  const { claves, estado } = pendiente;
  pendiente = null;
  try {
    const r = await historial().cambiarEstado(claves, estado);
    for (const clave of r.cambiados) seleccion.delete(clave);
    const verbo = estado === ESTADO.ARCHIVADO ? "archivada(s)" : "restaurada(s)";
    const extra = r.noEncontrados.length ? ` ${r.noEncontrados.length} no se encontró(aron) y no se modificó(aron).` : "";
    mensajeHistorial(`${r.cambiados.length} comparación(es) ${verbo}. Nada se borró.${extra}`);
  } catch (err) {
    mensajeHistorial(`No se aplicó el cambio: ${err.message} Los registros no se modificaron.`, true);
  }
  await renderHistorial();
}

async function exportarHistorial() {
  try {
    const json = await historial().exportar();
    const fecha = new Date().toISOString().slice(0, 10);
    descargar(`historial-comparador-${fecha}.json`, json, "application/json");
    mensajeHistorial("Copia exportada. El historial no se modificó.");
  } catch (err) {
    mensajeHistorial(`No se pudo exportar el historial: ${err.message}`, true);
  }
}

function accionHistorial(accion) {
  if (accion === "seleccionar-visibles") {
    for (const clave of ultimasVisibles) seleccion.add(clave);
    pendiente = null;
    return renderHistorial();
  }
  if (accion === "archivar") return prepararCambio([...seleccion], ESTADO.ARCHIVADO);
  if (accion === "restaurar") return prepararCambio([...seleccion], ESTADO.ACTIVO);
  if (accion === "archivar-todo") {
    return prepararCambio(ultimosRegistros.filter((r) => !estaArchivada(r.entrada)).map((r) => r.clave), ESTADO.ARCHIVADO);
  }
  if (accion === "exportar") return exportarHistorial();
  if (accion === "confirmar") return confirmarCambio();
  if (accion === "cancelar") {
    pendiente = null;
    return renderHistorial();
  }
}

async function verHistorial(clave) {
  let h;
  try {
    const r = (await historial().leer()).registros.find((x) => x.clave === clave);
    h = r?.entrada;
  } catch (err) {
    mensajeHistorial(`No se pudo abrir la comparación: ${err.message}`, true);
    return;
  }
  if (!h) return;
  const archivada = estaArchivada(h);
  $("#detalle-historial").innerHTML = `
    <div class="fila-botones">
      <button id="hist-md" type="button" class="secundario">Descargar Markdown</button>
      <button id="hist-html" type="button" class="secundario">Descargar HTML</button>
      <button id="hist-estado" type="button" class="secundario">${archivada ? "Restaurar esta comparación" : "Archivar esta comparación"}</button>
    </div>
    <div class="reporte">${mdToHtml(h.markdown)}</div>`;
  const base = `reporte_${h.fecha.slice(0, 19).replace(/[:T]/g, "-")}`;
  $("#hist-md").addEventListener("click", () => descargar(`${base}.md`, h.markdown, "text/markdown"));
  $("#hist-html").addEventListener("click", () =>
    descargar(`${base}.html`, htmlDocumento(h.markdown, "Reporte de comparación"), "text/html"));
  $("#hist-estado").addEventListener("click", async () => {
    // Acción individual y reversible: no requiere vista previa.
    try {
      await historial().cambiarEstado([clave], archivada ? ESTADO.ACTIVO : ESTADO.ARCHIVADO);
      mensajeHistorial(archivada ? "Comparación restaurada a Activos." : "Comparación archivada. Puede restaurarla desde Archivados. Nada se borró.");
      $("#detalle-historial").innerHTML = "";
      await renderHistorial();
    } catch (err) {
      mensajeHistorial(`No se aplicó el cambio: ${err.message} Los registros no se modificaron.`, true);
    }
  });
  $("#detalle-historial").scrollIntoView({ behavior: "smooth", block: "start" });
}

function iniciarHistorial() {
  const vista = $("#vista-historial");
  vista.addEventListener("click", (e) => {
    const filtro = e.target.closest("[data-filtro]");
    if (filtro) {
      filtroHistorial = filtro.dataset.filtro;
      pendiente = null;
      return renderHistorial();
    }
    const accion = e.target.closest("[data-accion]");
    if (accion && !accion.disabled) return accionHistorial(accion.dataset.accion);
    const item = e.target.closest(".item-historial[data-id]");
    if (item) verHistorial(item.dataset.id);
  });
  vista.addEventListener("change", (e) => {
    const casilla = e.target.closest("[data-sel]");
    if (!casilla) return;
    if (casilla.checked) seleccion.add(casilla.dataset.sel);
    else seleccion.delete(casilla.dataset.sel);
    renderHistorial();
  });
  // Otra pestaña cambió el historial: se vuelve a leer para no mostrar datos antiguos.
  window.addEventListener("storage", (e) => {
    if ((e.key === CLAVE_V2 || e.key === CLAVE_LEGADO) && !vista.hidden) renderHistorial();
  });
}

// ---------- Pantalla de inicio: tres opciones ----------

function abrirOpcion(accion) {
  if (accion === "simulacion") return mostrarVista("vista-simulacion");
  if (accion === "inspeccionar") return mostrarVista("vista-inspeccion");
  mostrarVista("vista-comparar");
  $("#analizar").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Simulación (Cummins X15 — DEMO) ----------

async function leerDemo(nombre) {
  const resp = await fetch(`ejemplo/demo/${nombre}`);
  if (!resp.ok) throw new Error(`no se encontró ${nombre}`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function iniciarSimulacion() {
  const error = $("#error-simulacion");
  error.hidden = true;
  $("#resultado-simulacion").innerHTML = "";
  try {
    const r = await ejecutarSimulacion(leerDemo);
    const entrada = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fecha: new Date().toISOString(),
      a: { nombre: "SIMULACIÓN demo_a.csv", sha256: r.hashes.a },
      b: { nombre: "SIMULACIÓN demo_b.csv", sha256: r.hashes.b },
      d: { nombre: "SIMULACIÓN demo_diccionario.csv", sha256: r.hashes.diccionario },
      cambios: r.resultado.valores.length,
      noComparables: r.resultado.noComparables.length,
      errores: r.resultado.errores.length,
      markdown: r.markdown,
      simulacion: true,
    };
    const avisoGuardado = await guardarEnHistorial(entrada);
    const bloque = `
      <h2>Explicación demostrativa</h2>
      <div class="tarjeta">
        <p class="ayuda">${esc(EXPLICACION_DEMOSTRATIVA[0])}</p>
        <ul class="lista">${EXPLICACION_DEMOSTRATIVA.slice(1).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>
      <h2>Resultados deterministas</h2>
      <div id="sim-tabla"></div>`;
    $("#resultado-simulacion").innerHTML = bloque;
    renderResultados(r, entrada, "#sim-tabla", "-sim");
    if (avisoGuardado) mostrarAvisoGuardado(avisoGuardado, "#resultado-simulacion");
  } catch (err) {
    error.textContent = `No se pudo ejecutar la simulación: ${err.message}`;
    error.hidden = false;
  }
}

// ---------- Inspección estructural ----------

let ultimaInspeccion = null;

const chip = (t) => `<span class="estado">${esc(t)}</span>`;

function renderInspeccion(ins) {
  const cont = $("#resultado-inspeccion");
  if (ins.error) {
    cont.innerHTML = `
      <div class="ia-nota">${esc(LEYENDA_INSPECCION)}</div>
      <div class="error">${esc(ins.error)}</div>
      <p class="ayuda">No se muestra ningún dato del archivo porque no pudo leerse como texto tabular.</p>`;
    return;
  }
  const cod = ins.codificacion;
  const delimNombre = { ",": "coma", ";": "punto y coma", "\t": "tabulador", "|": "barra vertical" }[ins.delimitador] ?? "no identificado";
  const lista = (items, vacio) =>
    items.length ? items.map((t) => `<li>${t}</li>`).join("") : `<li>${esc(vacio)}</li>`;

  cont.innerHTML = `
    <div class="ia-nota">${esc(LEYENDA_INSPECCION)}</div>
    <div class="resumen">
      <div class="kpi"><b>${esc(ins.filas)}</b><span>registros</span></div>
      <div class="kpi"><b>${esc(ins.columnas)}</b><span>columnas</span></div>
      <div class="kpi"><b>${esc(ins.malformados.length)}</b><span>mal formados</span></div>
      <div class="kpi"><b>${esc(ins.filasRepetidas.length)}</b><span>filas repetidas</span></div>
    </div>

    <h2>Archivo</h2>
    <div class="tarjeta">
      <div class="fila-dato"><strong>Nombre</strong><span>${esc(ins.nombre)}</span></div>
      <div class="fila-dato"><strong>Tamaño</strong><span>${esc(ins.bytes.toLocaleString("es-MX"))} bytes</span></div>
      <div class="fila-dato"><strong>Codificación</strong><span>${esc(cod.codificacion)} ${chip(cod.confianza)}<br><span class="meta">${esc(cod.motivo)}</span></span></div>
      <div class="fila-dato"><strong>Delimitador</strong><span>${esc(delimNombre)}${ins.delimitador ? ` <span class="meta">consistencia ${esc(Math.round(ins.consistenciaDelimitador * 100))}%</span>` : " <span class=\"chip-alerta\">revisar</span>"}</span></div>
      <div class="fila-dato"><strong>SHA-256</strong><span class="meta" style="word-break:break-all">${esc(ins.sha256)}</span></div>
      <div class="fila-dato"><strong>Pista de procedencia</strong><span>${ins.pistaNombre
        ? "El nombre coincide con la convención de INSITE. Esto es solo una pista; no confirma el origen."
        : "El nombre no coincide con la convención de INSITE. No confirma ni descarta su origen."}</span></div>
    </div>

    <h2>Encabezados</h2>
    <div class="tarjeta"><ol class="lista">${ins.encabezados.map((h) => `<li>${h === "" ? "<em>(vacío)</em>" : esc(h)}</li>`).join("")}</ol></div>

    <h2>Campos vacíos por columna</h2>
    <div class="tarjeta"><ul class="lista">${ins.vaciosPorColumna.map((c) => `<li>${esc(c.nombre || "(vacío)")}: ${esc(c.vacios)}</li>`).join("")}</ul></div>

    <h2>Errores de estructura</h2>
    <div class="tarjeta"><ul class="lista">
      ${lista(ins.malformados.slice(0, 20).map((m) => `Línea ${esc(m.linea)}: ${esc(m.campos)} campos (encabezado: ${esc(ins.columnas)})`), "Ningún registro con número de campos distinto al encabezado.")}
      ${lista(ins.filasRepetidas.slice(0, 20).map((f) => `Línea ${esc(f.linea)} repite la línea ${esc(f.primeraLinea)}`), "Sin filas repetidas.")}
      ${lista(ins.encabezadosRepetidos.map((h) => `Encabezado repetido: ${esc(h.nombre || "(vacío)")} ×${esc(h.veces)}`), "Sin encabezados repetidos.")}
    </ul></div>

    ${ins.avisos.length ? `<h2>Avisos</h2><div class="tarjeta"><ul class="lista">${ins.avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}

    <h2>Vista previa (primeros registros)</h2>
    <p class="ayuda">Solo para revisar la forma del archivo. Las celdas se recortan y no se interpretan.</p>
    <div class="tabla-scroll"><table class="tabla-simple"><tbody>
      ${ins.vistaPrevia.map((fila, i) => `<tr class="${i === 0 ? "cabecera" : ""}">${fila.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>

    <div class="fila-botones">
      <button id="ins-md" type="button" class="secundario">Descargar reporte (Markdown)</button>
      <button id="ins-html" type="button" class="secundario">Descargar reporte (HTML)</button>
    </div>
    <p class="pie">El reporte no incluye valores, vista previa ni el nombre del archivo.</p>`;

  const base = `inspeccion_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  const md = reporteEstructural(ins);
  $("#ins-md").addEventListener("click", () => descargar(`${base}.md`, md, "text/markdown"));
  $("#ins-html").addEventListener("click", () =>
    descargar(`${base}.html`, htmlDocumento(md, "Inspección estructural de archivo CSV"), "text/html"));
  cont.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function inspeccionarArchivo() {
  const error = $("#error-inspeccion");
  error.hidden = true;
  $("#resultado-inspeccion").innerHTML = "";
  const f = $("#fi").files[0];
  if (!f) {
    error.textContent = "Seleccione un archivo CSV para inspeccionar.";
    error.hidden = false;
    return;
  }
  try {
    const bytes = await leerArchivo(f);
    const sha = await sha256Hex(bytes);
    ultimaInspeccion = inspeccionar({ bytes, nombre: f.name, sha256: sha });
    renderInspeccion(ultimaInspeccion);
  } catch (err) {
    error.textContent = `No se pudo leer el archivo: ${err.message}`;
    error.hidden = false;
  }
}

// ---------- Arranque ----------

function init() {
  $("#version").textContent = VERSION;
  actualizarEstadoRed();
  window.addEventListener("online", actualizarEstadoRed);
  window.addEventListener("offline", actualizarEstadoRed);

  for (const b of document.querySelectorAll(".nav")) {
    b.addEventListener("click", () => mostrarVista(b.dataset.vista));
  }
  $("#fa").addEventListener("change", () => mostrarNombre($("#fa"), "#nombre-a"));
  $("#fb").addEventListener("change", () => mostrarNombre($("#fb"), "#nombre-b"));
  $("#fd").addEventListener("change", () => mostrarNombre($("#fd"), "#nombre-d"));
  $("#btn-comparar").addEventListener("click", comparar);
  for (const b of document.querySelectorAll(".opcion")) {
    b.addEventListener("click", () => abrirOpcion(b.dataset.accion));
  }
  $("#btn-simular").addEventListener("click", iniciarSimulacion);
  $("#fi").addEventListener("change", () => mostrarNombre($("#fi"), "#nombre-i"));
  $("#btn-inspeccionar").addEventListener("click", inspeccionarArchivo);
  $("#form-ajustes").addEventListener("submit", guardarAjustes);
  $("#btn-restaurar").addEventListener("click", restaurarAjustes);
  $("#form-ia").addEventListener("submit", guardarFormularioIA);
  $("#btn-borrar-ia").addEventListener("click", limpiarFormularioIA);

  cargarFormularioAjustes();
  cargarFormularioIA();
  iniciarHistorial();
  renderHistorial();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Sin service worker la app funciona en línea; solo se pierde el modo sin conexión.
    });
  }
}

init();
