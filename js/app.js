// Interfaz de la PWA. Toda la lógica de comparación está en motor.js.
// Ningún dato sale del dispositivo: no hay llamadas de red salvo la carga de la app
// y del diccionario de ejemplo, ambos servidos desde la caché del service worker.
import { procesar, crearAdaptador, ADAPTADOR_POR_DEFECTO, LecturaError, ConfigError } from "./motor.js";
import { mdToHtml, htmlDocumento } from "./markdown.js";
import { inspeccionar, reporteEstructural, LEYENDA_INSPECCION } from "./inspeccion.js";
import { ejecutarSimulacion, LEYENDA_SIMULACION, EXPLICACION_DEMOSTRATIVA } from "./simulacion.js";

const VERSION = "1.1.0";
const CLAVE_AJUSTES = "comparador.adaptador";
const CLAVE_HISTORIAL = "comparador.historial";
const MAX_HISTORIAL = 30;

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
    guardarEnHistorial(entrada);
    renderResultados(r, entrada);
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

  $(destino).innerHTML = `
    <div class="banner-no-verificado" role="status">
      <strong>Compatibilidad: NO VERIFICADA</strong>
      <p>Esta herramienta no determina compatibilidad entre calibraciones. Solo el fabricante puede confirmarla.</p>
    </div>

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
    <div class="ia-nota">No disponible en esta versión. La interpretación asistida requiere un servicio autorizado que aún no está configurado. No se muestra ninguna explicación generada.</div>

    <div class="fila-botones">
      <button id="dl-md${sufijo}" type="button" class="secundario">Descargar Markdown</button>
      <button id="dl-html${sufijo}" type="button" class="secundario">Descargar HTML</button>
    </div>
    <p class="pie">A: ${esc(entrada.a.nombre)} · SHA-256 ${esc(entrada.a.sha256)}<br>
      B: ${esc(entrada.b.nombre)} · SHA-256 ${esc(entrada.b.sha256)}<br>
      Diccionario: ${esc(entrada.d.nombre)} · SHA-256 ${esc(entrada.d.sha256)}</p>`;

  const nombreBase = `reporte_${entrada.fecha.slice(0, 19).replace(/[:T]/g, "-")}`;
  $(`#dl-md${sufijo}`).addEventListener("click", () => descargar(`${nombreBase}.md`, entrada.markdown, "text/markdown"));
  $(`#dl-html${sufijo}`).addEventListener("click", () =>
    descargar(`${nombreBase}.html`, htmlDocumento(entrada.markdown, "Reporte de comparación"), "text/html"));
  $(destino).scrollIntoView({ behavior: "smooth", block: "start" });
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

// ---------- Historial local ----------

function leerHistorial() {
  try {
    const h = JSON.parse(localStorage.getItem(CLAVE_HISTORIAL) ?? "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function guardarEnHistorial(entrada) {
  let lista = [entrada, ...leerHistorial()].slice(0, MAX_HISTORIAL);
  while (true) {
    try {
      localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(lista));
      return;
    } catch {
      if (lista.length <= 1) return; // espacio agotado: el reporte sigue descargable
      lista = lista.slice(0, -1);
    }
  }
}

function renderHistorial() {
  const lista = leerHistorial();
  $("#detalle-historial").innerHTML = "";
  if (!lista.length) {
    $("#lista-historial").innerHTML = '<p class="ayuda">Aún no hay comparaciones guardadas.</p>';
    return;
  }
  $("#lista-historial").innerHTML = lista.map((h) => `
    <button class="item-historial" type="button" data-id="${esc(h.id)}">
      ${esc(h.a.nombre)} vs ${esc(h.b.nombre)}
      <small>${esc(new Date(h.fecha).toLocaleString("es-MX"))} · ${esc(h.cambios)} cambios · ${esc(h.errores)} errores</small>
    </button>`).join("");
}

function verHistorial(id) {
  const h = leerHistorial().find((x) => x.id === id);
  if (!h) return;
  $("#detalle-historial").innerHTML = `
    <div class="fila-botones">
      <button id="hist-md" type="button" class="secundario">Descargar Markdown</button>
      <button id="hist-html" type="button" class="secundario">Descargar HTML</button>
      <button id="hist-borrar" type="button" class="peligro">Borrar este reporte</button>
    </div>
    <div class="reporte">${mdToHtml(h.markdown)}</div>`;
  const base = `reporte_${h.fecha.slice(0, 19).replace(/[:T]/g, "-")}`;
  $("#hist-md").addEventListener("click", () => descargar(`${base}.md`, h.markdown, "text/markdown"));
  $("#hist-html").addEventListener("click", () =>
    descargar(`${base}.html`, htmlDocumento(h.markdown, "Reporte de comparación"), "text/html"));
  $("#hist-borrar").addEventListener("click", () => {
    localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(leerHistorial().filter((x) => x.id !== id)));
    renderHistorial();
  });
  $("#detalle-historial").scrollIntoView({ behavior: "smooth", block: "start" });
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
    guardarEnHistorial(entrada);
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
  $("#lista-historial").addEventListener("click", (e) => {
    const b = e.target.closest("[data-id]");
    if (b) verHistorial(b.dataset.id);
  });
  $("#btn-borrar-historial").addEventListener("click", () => {
    if (confirm("¿Borrar todo el historial de este dispositivo?")) {
      localStorage.removeItem(CLAVE_HISTORIAL);
      renderHistorial();
    }
  });
  $("#form-ajustes").addEventListener("submit", guardarAjustes);
  $("#btn-restaurar").addEventListener("click", restaurarAjustes);

  cargarFormularioAjustes();
  renderHistorial();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Sin service worker la app funciona en línea; solo se pierde el modo sin conexión.
    });
  }
}

init();
