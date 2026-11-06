// Motor determinista de comparación (port de comparador.py y parser_csv.py).
// Debe producir resultados idénticos al motor Python de referencia; la
// equivalencia se verifica con equivalencia/ y tests/js/equivalencia.test.mjs.
// Sin dependencias. Sin red. Solo lectura de los bytes recibidos.

export class LecturaError extends Error {}
export class ConfigError extends Error {}
class ComillaSinCerrar extends Error {}

export const COMPATIBILIDAD = "no verificada";
const CAMPOS_META = ["ecm_id", "engine", "cal_id", "sw_version"];
const COLUMNAS_DICCIONARIO = ["nombre", "definicion", "fuente"];
const TOKENS_EMISIONES = new Set(["def", "dpf", "scr", "egr", "vgt", "nox", "aftertreatment", "emisiones"]);
// La versión web solo soporta codificaciones que decodifican igual que Python.
const CODIFICACIONES_WEB = ["utf-8", "utf-8-sig"];

export const ADAPTADOR_POR_DEFECTO = Object.freeze({
  delimitador: ",",
  codificacion: "utf-8-sig",
  col_tipo: "tipo",
  col_nombre: "nombre",
  col_valor: "valor",
  col_unidad: "unidad",
  tipo_meta: "meta",
  tipo_param: "param",
});

// ---------- Equivalentes de Python ----------

// Espacios que Python considera para str.strip() (str.isspace).
const ESPACIOS_PY = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RE_STRIP = new RegExp(`^[${ESPACIOS_PY}]+|[${ESPACIOS_PY}]+$`, "g");
export function pyStrip(s) {
  return s.replace(RE_STRIP, "");
}

const limpio = (t) => pyStrip(t ?? "");

// repr() de str en Python (para mensajes de error idénticos).
export function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === q || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += ch;
  }
  return q + out + q;
}

// repr() de list[str] en Python.
export function pyList(arr) {
  return "[" + arr.map(pyRepr).join(", ") + "]";
}

// Comparación de cadenas por puntos de código, como en Python.
export function cmpCodePoint(a, b) {
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i].codePointAt(0);
    const y = B[i].codePointAt(0);
    if (x !== y) return x - y;
  }
  return A.length - B.length;
}

// float() de Python. Devuelve null si Python lanzaría ValueError.
const DIGITOS = "\\d(?:_?\\d)*";
const RE_FLOAT_NUM = new RegExp(
  `^[+-]?(?:(?:${DIGITOS})\\.?(?:${DIGITOS})?|\\.${DIGITOS})(?:[eE][+-]?${DIGITOS})?$`
);
const RE_FLOAT_ESP = /^([+-]?)(inf|infinity|nan)$/i;
export function pyFloat(s) {
  if (RE_FLOAT_ESP.test(s)) {
    const [, signo, nombre] = s.match(RE_FLOAT_ESP);
    if (nombre.toLowerCase() === "nan") return NaN;
    return signo === "-" ? -Infinity : Infinity;
  }
  if (!RE_FLOAT_NUM.test(s)) return null;
  return Number(s.replace(/_/g, ""));
}

// Igual que _valores_iguales de comparador.py.
export function valoresIguales(a, b) {
  const fa = pyFloat(a);
  const fb = pyFloat(b);
  if (fa === null || fb === null) return a === b;
  if (Number.isFinite(fa) && Number.isFinite(fb)) return fa === fb;
  return a === b;
}

export function esEmisiones(nombre) {
  return nombre.toLowerCase().split(/[^a-z0-9]+/).some((t) => TOKENS_EMISIONES.has(t));
}

// ---------- Parser CSV (port de parser_csv.py) ----------

const START_RECORD = 0;
const START_FIELD = 1;
const IN_FIELD = 2;
const IN_QUOTED = 3;
const QUOTE_IN_QUOTED = 4;
const RE_LINEA = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g;

export function parsear(texto, delimitador = ",") {
  const registros = [];
  let campos = [];
  let campo = [];
  let estado = START_RECORD;
  let linea = 0;

  for (const m of texto.matchAll(RE_LINEA)) {
    linea += 1;
    for (const c of m[0]) {
      if (estado === START_RECORD) {
        if (c === "\r" || c === "\n") {
          registros.push([[], linea, true]);
          break;
        }
        estado = START_FIELD;
      }

      if (estado === START_FIELD) {
        if (c === "\r" || c === "\n") {
          campos.push(campo.join(""));
          registros.push([campos, linea, false]);
          campos = [];
          campo = [];
          estado = START_RECORD;
          break;
        }
        if (c === '"') estado = IN_QUOTED;
        else if (c === delimitador) campos.push("");
        else {
          campo.push(c);
          estado = IN_FIELD;
        }
      } else if (estado === IN_FIELD) {
        if (c === "\r" || c === "\n") {
          campos.push(campo.join(""));
          registros.push([campos, linea, false]);
          campos = [];
          campo = [];
          estado = START_RECORD;
          break;
        }
        if (c === delimitador) {
          campos.push(campo.join(""));
          campo = [];
          estado = START_FIELD;
        } else campo.push(c);
      } else if (estado === IN_QUOTED) {
        if (c === '"') estado = QUOTE_IN_QUOTED;
        else campo.push(c);
      } else if (estado === QUOTE_IN_QUOTED) {
        if (c === '"') {
          campo.push('"');
          estado = IN_QUOTED;
        } else if (c === delimitador) {
          campos.push(campo.join(""));
          campo = [];
          estado = START_FIELD;
        } else if (c === "\r" || c === "\n") {
          campos.push(campo.join(""));
          registros.push([campos, linea, false]);
          campos = [];
          campo = [];
          estado = START_RECORD;
          break;
        } else {
          campo.push(c);
          estado = IN_FIELD;
        }
      }
    }
  }

  if (estado === IN_QUOTED) {
    throw new ComillaSinCerrar(
      `el archivo termina dentro de un campo entre comillas (última línea ${linea})`
    );
  }
  if (estado !== START_RECORD) {
    campos.push(campo.join(""));
    registros.push([campos, linea, false]);
  }
  return registros;
}

// Equivalente de csv.DictReader con las mismas reglas que comparador.py.
function leerFilas(texto, delimitador, requeridas, ruta) {
  let registros;
  try {
    registros = parsear(texto, delimitador);
  } catch (e) {
    if (e instanceof ComillaSinCerrar) throw new LecturaError(`${ruta}: ${e.message}`);
    throw e;
  }
  const cabecera = registros.length ? registros[0][0] : [];
  const faltantes = requeridas.filter((c) => !cabecera.includes(c));
  if (faltantes.length) {
    throw new LecturaError(
      `${ruta}: faltan columnas requeridas ${pyList(faltantes)}; encabezado encontrado: ${pyList(cabecera)}`
    );
  }
  const filas = [];
  for (const [campos, linea, enBlanco] of registros.slice(1)) {
    if (enBlanco) continue;
    const fila = new Map();
    cabecera.forEach((nombre, i) => fila.set(nombre, i < campos.length ? campos[i] : null));
    filas.push({ fila, linea, extra: campos.length > cabecera.length });
  }
  return filas;
}

function decodificar(bytes, ruta, codificacion) {
  let texto;
  try {
    texto = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new LecturaError(`${ruta}: no se pudo decodificar como ${codificacion}`);
  }
  if (codificacion === "utf-8-sig" && texto.startsWith("﻿")) texto = texto.slice(1);
  return texto;
}

// ---------- Adaptador ----------

export function crearAdaptador(obj = {}) {
  const permitidas = Object.keys(ADAPTADOR_POR_DEFECTO);
  const desconocidas = Object.keys(obj).filter((k) => !permitidas.includes(k)).sort(cmpCodePoint);
  if (desconocidas.length) {
    throw new ConfigError(`claves desconocidas en la configuración: ${pyList(desconocidas)}`);
  }
  const a = { ...ADAPTADOR_POR_DEFECTO, ...obj };
  for (const k of permitidas) {
    if (typeof a[k] !== "string") throw new ConfigError(`el valor de ${k} debe ser texto`);
  }
  if ([...a.delimitador].length !== 1) {
    throw new ConfigError("el delimitador debe ser exactamente un carácter");
  }
  if (!CODIFICACIONES_WEB.includes(a.codificacion)) {
    throw new ConfigError(`codificación no soportada en la versión web: ${a.codificacion}`);
  }
  const columnas = [a.col_tipo, a.col_nombre, a.col_valor, a.col_unidad];
  if (new Set(columnas).size !== columnas.length) {
    throw new ConfigError("los nombres de columna deben ser distintos entre sí");
  }
  if (a.tipo_meta === a.tipo_param) {
    throw new ConfigError("tipo_meta y tipo_param deben ser distintos");
  }
  return Object.freeze(a);
}

// ---------- Carga ----------

export function cargarDiccionario({ bytes, nombre, codificacion = "utf-8-sig" }) {
  const texto = decodificar(bytes, nombre, codificacion);
  const filas = leerFilas(texto, ",", COLUMNAS_DICCIONARIO, nombre);
  const definiciones = new Map();
  const errores = [];
  for (const { fila, linea, extra } of filas) {
    const origen = `${nombre}:${linea}`;
    if (extra) {
      errores.push(`${origen}: fila con más columnas de las esperadas`);
      continue;
    }
    const nombreParam = limpio(fila.get("nombre"));
    const textoDef = limpio(fila.get("definicion"));
    const fuente = limpio(fila.get("fuente"));
    if (!nombreParam) {
      errores.push(`${origen}: definición sin nombre de parámetro`);
    } else if (!textoDef || !fuente) {
      errores.push(`${origen}: definición de '${nombreParam}' sin texto o sin fuente; se ignora`);
    } else if (definiciones.has(nombreParam)) {
      errores.push(`${origen}: definición duplicada para '${nombreParam}'; se ignora la segunda`);
    } else {
      definiciones.set(nombreParam, { texto: textoDef, fuente });
    }
  }
  return { definiciones, errores };
}

export function cargarExportacion({ bytes, nombre, adaptador, sha256 }) {
  const texto = decodificar(bytes, nombre, adaptador.codificacion);
  const requeridas = [adaptador.col_tipo, adaptador.col_nombre, adaptador.col_valor, adaptador.col_unidad];
  const filas = leerFilas(texto, adaptador.delimitador, requeridas, nombre);

  const exp = {
    archivo: nombre,
    sha256,
    meta: new Map(),
    parametros: new Map(),
    duplicados: new Map(),
    errores: [],
  };
  for (const { fila, linea, extra } of filas) {
    const origen = `${exp.archivo}:${linea}`;
    if (extra) {
      exp.errores.push(`${origen}: fila con más columnas de las esperadas`);
      continue;
    }
    if (requeridas.some((c) => fila.get(c) === null)) {
      exp.errores.push(`${origen}: fila incompleta`);
      continue;
    }
    const tipo = limpio(fila.get(adaptador.col_tipo)).toLowerCase();
    const nombreParam = limpio(fila.get(adaptador.col_nombre));
    const valor = limpio(fila.get(adaptador.col_valor)) || null;
    const unidad = limpio(fila.get(adaptador.col_unidad)) || null;

    if (tipo === adaptador.tipo_meta) {
      if (!nombreParam) exp.errores.push(`${origen}: campo meta sin nombre`);
      else if (exp.meta.has(nombreParam)) {
        exp.errores.push(`${origen}: campo meta '${nombreParam}' repetido; se conserva el primero`);
      } else {
        exp.meta.set(nombreParam, { nombre: nombreParam, valor, unidad, origen });
      }
    } else if (tipo === adaptador.tipo_param) {
      if (!nombreParam) {
        exp.errores.push(`${origen}: parámetro sin nombre`);
        continue;
      }
      const nuevo = { nombre: nombreParam, valor, unidad, origen };
      if (exp.duplicados.has(nombreParam)) {
        exp.duplicados.get(nombreParam).push(origen);
        exp.errores.push(`${origen}: parámetro duplicado '${nombreParam}'`);
      } else if (exp.parametros.has(nombreParam)) {
        const primero = exp.parametros.get(nombreParam);
        exp.parametros.delete(nombreParam);
        exp.duplicados.set(nombreParam, [primero.origen, origen]);
        exp.errores.push(
          `${origen}: parámetro duplicado '${nombreParam}'; ambos quedan excluidos de la comparación`
        );
      } else {
        exp.parametros.set(nombreParam, nuevo);
      }
    } else {
      exp.errores.push(`${origen}: tipo desconocido '${tipo}'`);
    }
  }
  return exp;
}

// ---------- Comparación ----------

function origenes(ea, eb, nombre) {
  const out = [];
  out.push(...(ea.duplicados.get(nombre) ?? []));
  out.push(...(eb.duplicados.get(nombre) ?? []));
  if (ea.parametros.has(nombre)) out.push(ea.parametros.get(nombre).origen);
  if (eb.parametros.has(nombre)) out.push(eb.parametros.get(nombre).origen);
  return out;
}

function identificacion(ea, eb) {
  return CAMPOS_META.map((campo) => {
    const pa = ea.meta.get(campo) ?? null;
    const pb = eb.meta.get(campo) ?? null;
    let estado;
    if (pa === null || pb === null) estado = "ausente";
    else if (pa.valor === null || pb.valor === null) estado = "nulo";
    else if (pa.valor === pb.valor) estado = "igual";
    else estado = "distinto";
    return { campo, a: pa, b: pb, estado };
  });
}

export function comparar(ea, eb, definiciones, erroresExtra = []) {
  const identif = identificacion(ea, eb);
  const valores = [];
  const noComparables = [];

  const nombres = new Set([
    ...ea.parametros.keys(),
    ...eb.parametros.keys(),
    ...ea.duplicados.keys(),
    ...eb.duplicados.keys(),
  ]);
  for (const nombre of [...nombres].sort(cmpCodePoint)) {
    const emision = esEmisiones(nombre);
    const orig = origenes(ea, eb, nombre);
    if (ea.duplicados.has(nombre) || eb.duplicados.has(nombre)) {
      const lado = ea.duplicados.has(nombre) ? "A" : "B";
      noComparables.push({ nombre, motivo: `parámetro duplicado en ${lado}`, origenes: orig, emision });
      continue;
    }

    const pa = ea.parametros.get(nombre) ?? null;
    const pb = eb.parametros.get(nombre) ?? null;
    const confianza = definiciones.has(nombre)
      ? "con definición documentada"
      : "sin definición documentada";

    if (pa && pb) {
      if (pa.valor === null || pb.valor === null) {
        const faltan = [["A", pa], ["B", pb]].filter(([, p]) => p.valor === null).map(([l]) => l).join(" y ");
        noComparables.push({ nombre, motivo: `valor nulo en ${faltan}`, origenes: orig, emision });
        continue;
      }
      if ((pa.unidad ?? "") !== (pb.unidad ?? "")) {
        const motivo = `unidades distintas: A=${pa.unidad ?? "—"}, B=${pb.unidad ?? "—"}`;
        noComparables.push({ nombre, motivo, origenes: orig, emision });
        continue;
      }
      if (valoresIguales(pa.valor, pb.valor)) continue;
      valores.push({ nombre, estado: "cambiado", a: pa, b: pb, confianza, emision });
    } else {
      const presente = pa || pb;
      if (presente.valor === null) {
        const lado = pa ? "A" : "B";
        noComparables.push({ nombre, motivo: `valor nulo en ${lado}`, origenes: orig, emision });
        continue;
      }
      const estado = pb === null ? "eliminado" : "agregado";
      valores.push({ nombre, estado, a: pa, b: pb, confianza, emision });
    }
  }

  const errores = [
    ...ea.errores.map((e) => `[A] ${e}`),
    ...eb.errores.map((e) => `[B] ${e}`),
    ...erroresExtra,
  ];
  return { identificacion: identif, valores, noComparables, errores, compatibilidad: COMPATIBILIDAD };
}

// ---------- Reporte Markdown (port de generar_reporte) ----------

function celda(texto) {
  if (texto === null || texto === undefined || texto === "") return "—";
  return String(texto).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function tabla(encabezados, filas) {
  const L = ["| " + encabezados.join(" | ") + " |", "|" + "---|".repeat(encabezados.length)];
  for (const f of filas) L.push("| " + f.map(celda).join(" | ") + " |");
  return L;
}

function dictRepr(obj) {
  return "{" + Object.entries(obj).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ") + "}";
}

export const AVISO_IA =
  "Interpretación generada por IA a partir únicamente de la definición documentada citada. " +
  "No está verificada por el motor de comparación y no determina efecto, compatibilidad " +
  "ni cumplimiento. Use la fuente técnica original para cualquier decisión.";

export function generarReporte({ resultado, ea, eb, shaDiccionario, nombreDiccionario, adaptador, definiciones }) {
  const L = [];
  L.push("# Reporte de comparación de configuraciones (solo lectura)\n");
  L.push("## Procedencia\n");
  L.push(...tabla(["Entrada", "Archivo", "SHA-256"], [
    ["Exportación A", ea.archivo, ea.sha256],
    ["Exportación B", eb.archivo, eb.sha256],
    ["Diccionario", nombreDiccionario, shaDiccionario],
  ]));
  L.push("");
  L.push(`Configuración del adaptador: \`${dictRepr(adaptador)}\`\n`);

  // 1. Identificación
  L.push("## 1. Identificación\n");
  L.push("Diferencias de identificación del ECM. Son hechos leídos de los archivos, no un juicio de compatibilidad.\n");
  L.push(...tabla(["Campo", "A", "B", "Estado", "Origen A / B"], resultado.identificacion.map((f) => [
    f.campo,
    f.a ? f.a.valor : null,
    f.b ? f.b.valor : null,
    f.estado,
    (f.a ? f.a.origen : "—") + " / " + (f.b ? f.b.origen : "—"),
  ])));
  L.push("");

  // 2. Valores
  L.push("## 2. Diferencias de valores\n");
  if (resultado.valores.length === 0) {
    L.push("No se encontraron diferencias de valor entre parámetros comparables.\n");
  } else {
    L.push(...tabla(["Parámetro", "Estado", "Valor A", "Valor B", "Unidad", "Definición", "Origen A / B"],
      resultado.valores.map((d) => [
        d.nombre,
        d.estado,
        d.a ? d.a.valor : null,
        d.b ? d.b.valor : null,
        (d.a && d.a.unidad) || (d.b && d.b.unidad) || null,
        d.confianza,
        (d.a ? d.a.origen : "—") + " / " + (d.b ? d.b.origen : "—"),
      ])));
    L.push("");
  }

  // 3. No comparables
  L.push("## 3. Datos no comparables\n");
  L.push("Estos parámetros no se comparan porque sus datos no permiten una comparación confiable.\n");
  if (resultado.noComparables.length === 0) {
    L.push("Ninguno.\n");
  } else {
    L.push(...tabla(["Parámetro", "Motivo", "Origen"],
      resultado.noComparables.map((n) => [n.nombre, n.motivo, n.origenes.join(", ") || "—"])));
    L.push("");
  }

  // 4. Revisión de emisiones
  L.push("## 4. Parámetros para revisión humana obligatoria\n");
  const marcados = [
    ...resultado.valores.filter((d) => d.emision).map((d) => ["valor", d.nombre]),
    ...resultado.noComparables.filter((n) => n.emision).map((n) => ["no comparable", n.nombre]),
  ];
  if (marcados.length === 0) {
    L.push("Ningún parámetro coincidió con la clasificación de emisiones.\n");
  } else {
    L.push("Requieren revisión por personal calificado. La herramienta no interpreta su efecto.\n");
    for (const [tipo, nombre] of marcados) L.push(`- \`${nombre}\` (${tipo})`);
    L.push("");
  }

  // 5. Compatibilidad
  L.push("## 5. Compatibilidad\n");
  L.push(`**Estado: ${resultado.compatibilidad}.**\n`);
  L.push(
    "Esta herramienta no determina compatibilidad entre calibraciones. " +
      "Solo el fabricante puede confirmarla. Un reporte sin diferencias tampoco implica compatibilidad.\n"
  );

  // 6. Errores
  L.push("## 6. Errores de lectura\n");
  if (resultado.errores.length) {
    for (const e of resultado.errores) L.push(`- ${e}`);
  } else {
    L.push("Sin errores de lectura.");
  }
  L.push("");

  // 7. Documentación utilizada
  L.push("## 7. Documentación utilizada\n");
  L.push(
    "Parámetros con diferencias y definición documentada. Las definiciones provienen del " +
      "diccionario de entrada; esta herramienta no verifica su autenticidad.\n"
  );
  const documentados = resultado.valores.filter((d) => definiciones.has(d.nombre));
  if (documentados.length === 0) {
    L.push("Ninguno de los parámetros con diferencias tiene definición documentada.\n");
  } else {
    L.push(...tabla(["Parámetro", "Fuente"], documentados.map((d) => [d.nombre, definiciones.get(d.nombre).fuente])));
    L.push("");
  }

  // 8. IA (no ejecutada en la versión web)
  L.push("## 8. Interpretación asistida por IA (no verificada)\n");
  L.push(`> ${AVISO_IA}\n`);
  L.push("No se solicitó interpretación asistida por IA.\n");

  return L.join("\n");
}

// ---------- Procesamiento completo ----------

// Entrada: bytes (Uint8Array) y hashes SHA-256 precalculados por quien llama.
// Lanza LecturaError o ConfigError si los datos no pueden interpretarse.
export function procesar({ diccionario, a, b, adaptador }) {
  const cfg = crearAdaptador(adaptador ?? {});
  const { definiciones, errores: erroresDic } = cargarDiccionario({
    bytes: diccionario.bytes,
    nombre: diccionario.nombre,
    codificacion: cfg.codificacion,
  });
  const ea = cargarExportacion({ bytes: a.bytes, nombre: a.nombre, adaptador: cfg, sha256: a.sha256 });
  const eb = cargarExportacion({ bytes: b.bytes, nombre: b.nombre, adaptador: cfg, sha256: b.sha256 });
  const resultado = comparar(ea, eb, definiciones, erroresDic);
  const markdown = generarReporte({
    resultado,
    ea,
    eb,
    shaDiccionario: diccionario.sha256,
    nombreDiccionario: diccionario.nombre,
    adaptador: cfg,
    definiciones,
  });
  return { markdown, resultado, ea, eb, definiciones, adaptador: cfg };
}
