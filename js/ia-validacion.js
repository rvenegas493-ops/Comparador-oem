// Validaciones de la capa de IA. Compartidas por la PWA y por el backend.
// Son funciones puras: no hacen red ni tocan el DOM.
//
// Principio: la IA solo explica diferencias de valor que tienen documentación
// citada en el registro. Toda respuesta del modelo se revalida antes de mostrarse:
// citas, cifras, términos prohibidos, longitud y que el parámetro sea mencionado.
import { esEmisiones } from "./motor.js";

export const MAX_ITEMS = 8;
export const MAX_CITAS = 5;
export const MIN_CARACTERES = 20;
export const MAX_CARACTERES = 400;
export const MAX_BYTES_SOLICITUD = 8000;
export const ESTADOS_COMPARACION = ["cambiado", "agregado", "eliminado"];

// Superconjunto de la lista de ia.py: incluye sus términos y añade raíces verbales
// y términos que afirmarían corrección, riesgo o falla.
export const TERMINOS_PROHIBIDOS = [
  "desactiv", "anul", "bypass", "evad", "salt", "reprogram", "modific", "ajustar",
  "compatib", "segur", "recomend", "deb", "instal", "sustitu", "quit", "apag",
  "reinici", "borr", "elimin", "efect", "consecuenc", "provoc", "caus", "afect",
  "mejor", "empeor", "override", "disable", "delete", "como hacer", "como cambiar",
  "como modificar", "pasos",
  "correct", "incorrect", "riesgo", "peligro", "dano", "falla", "fallo", "garantiz",
  // Raíces verbales que ia.py no cubre (p. ej. "modifique" no contiene "modific").
  "modifi", "corrig", "calibr", "reprogram", "desactiv", "reemplaz", "reemplac", "recomi",
];

const RE_NOMBRE = /^[A-Za-z0-9_-]{1,80}$/;
const RE_CIFRA = /\d+(?:[.,]\d+)?/g;

const normalizar = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const cifras = (t) => new Set([...String(t ?? "").matchAll(RE_CIFRA)].map((m) => m[0].replace(",", ".")));
const claveCita = (c) => `${c.doc}#${c.seccion}`;
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const contieneTermino = (texto, termino) =>
  new RegExp(`(^|[^\\p{L}\\d])${escaparRegex(termino)}(?=$|[^\\p{L}\\d])`, "iu").test(texto);

// ---------- Registro documental ----------

export function citasPermitidas(registro, nombre) {
  return registro.parametros[nombre] ?? [];
}

export function fragmento(registro, cita) {
  const doc = registro.documentos.find((d) => d.id === cita.doc);
  if (!doc) return null;
  const sec = doc.secciones.find((s) => s.seccion === cita.seccion);
  if (!sec) return null;
  return { doc: doc.id, version: doc.version, fuente: doc.fuente, seccion: sec.seccion, texto: sec.texto };
}

// Comprueba que el registro sea coherente: referencias existentes, identificadores únicos y aviso.
export function validarRegistro(registro) {
  const problemas = [];
  if (typeof registro?.aviso !== "string" || !registro.aviso) problemas.push("falta el aviso del registro");
  const ids = new Set();
  for (const d of registro?.documentos ?? []) {
    if (ids.has(d.id)) problemas.push(`identificador de documento repetido: ${d.id}`);
    ids.add(d.id);
    if (!d.version || !d.fuente) problemas.push(`documento ${d.id} sin versión o fuente`);
  }
  for (const [nombre, citas] of Object.entries(registro?.parametros ?? {})) {
    if (esEmisiones(nombre)) problemas.push(`parámetro de emisiones con documentación: ${nombre}`);
    for (const c of citas) {
      if (!fragmento(registro, c)) problemas.push(`${nombre} cita una sección inexistente: ${claveCita(c)}`);
    }
  }
  return problemas;
}

// ---------- Solicitud ----------

// Valida la solicitud enviada por la PWA. Las citas deben existir en el registro
// del servidor; el texto de los fragmentos nunca viene del cliente.
export function validarSolicitud(cuerpo, registro) {
  const errores = [];
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return { ok: false, errores: ["cuerpo no válido"] };
  for (const k of Object.keys(cuerpo)) if (k !== "items") errores.push(`campo no permitido: ${k}`);
  const items = cuerpo.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
    return { ok: false, errores: [...errores, `items debe tener entre 1 y ${MAX_ITEMS} elementos`] };
  }
  const vistos = new Set();
  items.forEach((it, i) => {
    const etiqueta = `items[${i}]`;
    if (!it || typeof it !== "object") return errores.push(`${etiqueta} no es un objeto`);
    for (const k of Object.keys(it)) {
      if (!["nombre", "estado", "a", "b", "unidad", "citas"].includes(k)) errores.push(`${etiqueta}: campo no permitido ${k}`);
    }
    if (typeof it.nombre !== "string" || !RE_NOMBRE.test(it.nombre)) return errores.push(`${etiqueta}: nombre no válido`);
    if (vistos.has(it.nombre)) errores.push(`${etiqueta}: nombre repetido`);
    vistos.add(it.nombre);
    if (esEmisiones(it.nombre)) errores.push(`${etiqueta}: parámetro de emisiones excluido de la interpretación`);
    if (!ESTADOS_COMPARACION.includes(it.estado)) errores.push(`${etiqueta}: estado no válido`);
    for (const campo of ["a", "b"]) {
      const v = it[campo];
      if (v !== null && (typeof v !== "string" || v.length > 60)) errores.push(`${etiqueta}: ${campo} no válido`);
    }
    if (it.unidad !== null && (typeof it.unidad !== "string" || it.unidad.length > 20)) errores.push(`${etiqueta}: unidad no válida`);
    if (!Array.isArray(it.citas) || it.citas.length < 1 || it.citas.length > MAX_CITAS) {
      return errores.push(`${etiqueta}: citas debe tener entre 1 y ${MAX_CITAS} elementos`);
    }
    const permitidas = new Set(citasPermitidas(registro, it.nombre).map(claveCita));
    if (permitidas.size === 0) errores.push(`${etiqueta}: el parámetro no tiene documentación en el registro`);
    for (const c of it.citas) {
      if (!c || typeof c.doc !== "string" || typeof c.seccion !== "string") errores.push(`${etiqueta}: cita mal formada`);
      else if (!permitidas.has(claveCita(c))) errores.push(`${etiqueta}: cita no autorizada ${claveCita(c)}`);
    }
  });
  // Segunda comprobación de documentación suficiente (el cliente no es de confianza).
  items.forEach((it, i) => {
    if (!it || typeof it !== "object") return;
    if (it.estado !== "cambiado") errores.push(`items[${i}]: solo se interpretan diferencias de valor`);
    const textos = (Array.isArray(it.citas) ? it.citas : []).map((c) => fragmento(registro, c)?.texto ?? "").join(" ");
    if (typeof it.unidad !== "string" || !contieneTermino(textos, it.unidad)) {
      errores.push(`items[${i}]: la unidad no aparece en la documentación citada`);
    }
  });
  return { ok: errores.length === 0, errores };
}

// Construye la solicitud a partir del resultado del motor (solo lectura).
// Los parámetros sin documentación, de emisiones o sin cambio de valor quedan
// como "no determinable" y no se envían.
export function construirSolicitud(resultado, registro) {
  const items = [];
  const noDeterminables = [];
  for (const d of resultado.valores) {
    if (!ESTADOS_COMPARACION.includes(d.estado)) continue;
    if (d.emision) {
      noDeterminables.push({ nombre: d.nombre, motivo: "parámetro de emisiones: excluido de la interpretación" });
      continue;
    }
    const citas = citasPermitidas(registro, d.nombre).map((c) => ({ doc: c.doc, seccion: c.seccion }));
    if (citas.length === 0) {
      noDeterminables.push({ nombre: d.nombre, motivo: "sin documentación en el registro" });
      continue;
    }
    // Solo diferencias de valor (ambos lados presentes) pueden interpretarse.
    if (d.estado !== "cambiado") {
      noDeterminables.push({ nombre: d.nombre, motivo: "no es una diferencia de valor: falta el valor en A o en B" });
      continue;
    }
    // La unidad debe aparecer literalmente en la documentación citada. Sin ella no hay evidencia suficiente.
    const unidad = d.a?.unidad ?? d.b?.unidad ?? null;
    const textoCitado = citas.map((c) => fragmento(registro, c)?.texto ?? "").join(" ");
    if (!unidad || !contieneTermino(textoCitado, unidad)) {
      noDeterminables.push({ nombre: d.nombre, motivo: "documentación insuficiente: la unidad no aparece en la documentación citada" });
      continue;
    }
    if (items.length >= MAX_ITEMS) {
      noDeterminables.push({ nombre: d.nombre, motivo: `excede el máximo de ${MAX_ITEMS} parámetros por consulta` });
      continue;
    }
    items.push({
      nombre: d.nombre,
      estado: d.estado,
      a: d.a?.valor ?? null,
      b: d.b?.valor ?? null,
      unidad: d.a?.unidad ?? d.b?.unidad ?? null,
      citas,
    });
  }
  return { items, noDeterminables };
}

// Mensaje que recibe el modelo: datos del motor y fragmentos tomados del registro del servidor.
export function construirMensajeModelo(items, registro) {
  return JSON.stringify({
    parametros: items.map((it) => ({
      nombre: it.nombre,
      estado: it.estado,
      valor_a: it.a,
      valor_b: it.b,
      unidad: it.unidad,
      fragmentos: it.citas.map((c) => fragmento(registro, c)).filter(Boolean),
    })),
  });
}

// ---------- Respuesta ----------

function limpiarFormato(texto) {
  return String(texto).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// Valida la explicación de un parámetro. Devuelve { ok, motivo }.
export function validarExplicacion(e, item, registro) {
  if (typeof e.texto !== "string") return { ok: false, motivo: "texto ausente" };
  const texto = e.texto.trim();
  if (texto.length < 20 || texto.length > 400) return { ok: false, motivo: "longitud fuera de rango" };
  if (!texto.includes(item.nombre)) return { ok: false, motivo: "no menciona el parámetro" };

  const norm = normalizar(texto);
  const prohibido = TERMINOS_PROHIBIDOS.find((t) => norm.includes(t));
  if (prohibido) return { ok: false, motivo: `término no permitido: ${prohibido}` };

  if (!Array.isArray(e.citas) || e.citas.length < 1 || e.citas.length > MAX_CITAS) {
    return { ok: false, motivo: "sin citas válidas" };
  }
  const permitidas = new Set(item.citas.map(claveCita));
  for (const c of e.citas) {
    if (!c || !permitidas.has(claveCita(c))) return { ok: false, motivo: `cita no autorizada: ${c?.doc ?? "?"}` };
  }

  // Cifras: solo las que aparecen en los datos o en los fragmentos citados.
  const fuentes = [item.a, item.b, ...item.citas.map((c) => fragmento(registro, c)?.texto ?? "")].join(" ");
  const permitidasCifras = cifras(fuentes);
  for (const c of cifras(texto)) {
    if (!permitidasCifras.has(c)) return { ok: false, motivo: `cifra no presente en los datos: ${c}` };
  }
  return { ok: true, motivo: null, texto };
}

const CAMPOS_EXPLICACION = ["nombre", "estado", "texto", "citas"];
const CAMPOS_CITA = ["doc", "seccion"];

// Verifica la forma exacta de una explicación: sin campos extra y con tipos correctos.
// Devuelve el motivo del fallo o null.
export function estructuraExplicacion(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "la explicación no es un objeto";
  for (const k of Object.keys(e)) if (!CAMPOS_EXPLICACION.includes(k)) return `campo no permitido: ${k}`;
  if (typeof e.nombre !== "string") return "nombre no válido";
  if (!["explicado", "no_determinable"].includes(e.estado)) return "estado no válido";
  if (e.estado === "explicado" && typeof e.texto !== "string") return "texto ausente";
  if (!Array.isArray(e.citas)) return "las citas no son una lista";
  for (const c of e.citas) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return "cita no es un objeto";
    for (const k of Object.keys(c)) if (!CAMPOS_CITA.includes(k)) return `campo de cita no permitido: ${k}`;
    if (typeof c.doc !== "string" || typeof c.seccion !== "string") return "cita mal formada";
  }
  return null;
}

// Interpreta la respuesta del modelo para cada parámetro solicitado.
// Nunca devuelve texto no validado: cada parámetro queda en "validada",
// "no_determinable" o "rechazada".
export function interpretarRespuesta(textoModelo, items, registro) {
  const rechazarTodo = (motivo) => ({
    items: items.map((it) => ({ nombre: it.nombre, estado: "rechazada", motivo })),
    descartados: 0,
  });

  let obj;
  try {
    obj = JSON.parse(limpiarFormato(textoModelo));
  } catch {
    return rechazarTodo("la respuesta no es JSON válido");
  }
  if (!obj || !Array.isArray(obj.explicaciones)) return rechazarTodo("formato de respuesta no válido");
  if (Object.keys(obj).some((k) => k !== "explicaciones")) return rechazarTodo("formato no válido: campos no permitidos en la respuesta");

  const solicitados = new Set(items.map((i) => i.nombre));
  const conteo = new Map();
  let descartados = 0;
  for (const e of obj.explicaciones) {
    if (!e || typeof e.nombre !== "string" || !solicitados.has(e.nombre)) {
      descartados++;
      continue;
    }
    conteo.set(e.nombre, (conteo.get(e.nombre) ?? 0) + 1);
  }

  const salida = items.map((item) => {
    const repeticiones = conteo.get(item.nombre) ?? 0;
    if (repeticiones > 1) return { nombre: item.nombre, estado: "rechazada", motivo: "respuesta repetida" };
    const e = obj.explicaciones.find((x) => x && x.nombre === item.nombre);
    if (!e) return { nombre: item.nombre, estado: "no_determinable", motivo: "el modelo no respondió este parámetro" };
    const fallo = estructuraExplicacion(e);
    if (fallo) return { nombre: item.nombre, estado: "rechazada", motivo: `estructura: ${fallo}` };
    if (e.estado === "no_determinable") {
      return { nombre: item.nombre, estado: "no_determinable", motivo: "evidencia insuficiente en la documentación citada" };
    }
    if (e.estado !== "explicado") return { nombre: item.nombre, estado: "rechazada", motivo: "estado no válido" };
    const v = validarExplicacion(e, item, registro);
    if (!v.ok) return { nombre: item.nombre, estado: "rechazada", motivo: v.motivo };
    return {
      nombre: item.nombre,
      estado: "validada",
      texto: v.texto,
      citas: e.citas.map((c) => ({ doc: c.doc, seccion: c.seccion })),
    };
  });
  return { items: salida, descartados };
}
