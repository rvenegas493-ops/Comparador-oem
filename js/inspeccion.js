// Inspección estructural de CSV desconocidos.
// Solo examina la forma del archivo: codificación tentativa, delimitador,
// encabezados, vacíos, duplicados y registros mal formados. No interpreta
// valores ni parámetros y no produce conclusiones técnicas.
import { parsear, ComillaSinCerrar } from "./motor.js";

export const LEYENDA_INSPECCION =
  "Solo inspección estructural. No se interpretaron valores ni parámetros; no determina compatibilidad.";

const CANDIDATOS_DELIMITADOR = [",", ";", "\t", "|"];
const LIMITE_VISTA = 20;
const LIMITE_LISTA = 20;
const MAX_CELDA = 60;

// Convención de nombre documentada por Cummins para exportaciones de imágenes
// de órdenes de trabajo: I-[año][mes][día]-[segundos].csv. Es solo una pista.
const RE_NOMBRE_INSITE = /^I-\d{8}-\d+\.csv$/i;

// Detección tentativa de codificación a partir de los bytes.
export function detectarCodificacion(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { codificacion: "utf-8-sig", confianza: "alta", motivo: "marca BOM de UTF-8 presente" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { codificacion: "utf-16le", confianza: "alta", motivo: "marca BOM de UTF-16 (little endian)" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { codificacion: "utf-16be", confianza: "alta", motivo: "marca BOM de UTF-16 (big endian)" };
  }

  const n = bytes.length;
  let nulos = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) nulos++;
  if (n > 0 && nulos / n > 0.05) {
    // Un archivo de texto UTF-16 sin marca tiene ceros en una posición fija
    // (uno de cada dos bytes en texto latino). Si no ocurre, parece binario.
    const muestra = bytes.subarray(0, Math.min(n, 4096));
    let pares = 0;
    let impares = 0;
    for (let i = 0; i < muestra.length; i++) {
      if (muestra[i] === 0) (i % 2 === 0 ? pares++ : impares++);
    }
    const mitad = muestra.length / 2;
    if (impares > 0.3 * mitad && pares < 0.02 * mitad) {
      return { codificacion: "utf-16le", confianza: "media", motivo: "patrón de ceros típico de UTF-16 sin marca" };
    }
    if (pares > 0.3 * mitad && impares < 0.02 * mitad) {
      return { codificacion: "utf-16be", confianza: "media", motivo: "patrón de ceros típico de UTF-16 sin marca" };
    }
    return { codificacion: null, confianza: "ninguna", motivo: "contiene muchos bytes nulos; probablemente no es texto" };
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let ascii = true;
    for (let i = 0; i < n; i++) {
      if (bytes[i] > 0x7f) {
        ascii = false;
        break;
      }
    }
    return ascii
      ? { codificacion: "utf-8", confianza: "media", motivo: "solo caracteres ASCII; puede ser UTF-8 o Windows-1252" }
      : { codificacion: "utf-8", confianza: "alta", motivo: "secuencias UTF-8 válidas" };
  } catch {
    return { codificacion: "windows-1252", confianza: "media", motivo: "no es UTF-8 válido" };
  }
}

// Decodificación con la codificación indicada. Devuelve texto o error.
export function decodificar(bytes, codificacion) {
  // TextDecoder con "utf-8" ya retira la marca BOM.
  const etiqueta = codificacion === "utf-8-sig" ? "utf-8" : codificacion;
  try {
    return { texto: new TextDecoder(etiqueta, { fatal: true }).decode(bytes) };
  } catch {
    return { error: `no se pudo decodificar como ${codificacion}` };
  }
}

// Delimitador más consistente entre las primeras líneas no vacías.
export function detectarDelimitador(texto) {
  const muestra = texto
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 200)
    .join("\n");
  const evaluados = [];
  for (const d of CANDIDATOS_DELIMITADOR) {
    let registros;
    try {
      registros = parsear(muestra, d);
    } catch {
      continue;
    }
    const cuentas = registros.filter((r) => !r[2]).map((r) => r[0].length);
    if (cuentas.length < 2) continue;
    const frecuencia = new Map();
    for (const c of cuentas) frecuencia.set(c, (frecuencia.get(c) ?? 0) + 1);
    let moda = 0;
    let veces = 0;
    for (const [c, v] of frecuencia) {
      if (v > veces || (v === veces && c > moda)) {
        moda = c;
        veces = v;
      }
    }
    if (moda < 2) continue;
    evaluados.push({ delimitador: d, campos: moda, consistencia: veces / cuentas.length });
  }
  if (!evaluados.length) return { delimitador: null, consistencia: 0, evaluados };
  evaluados.sort((x, y) => y.consistencia - x.consistencia || y.campos - x.campos);
  const mejor = evaluados[0];
  // Se acepta aunque haya registros irregulares (se reportan aparte), siempre que
  // el delimitador sea claramente el más frecuente. Con menos de la mitad de
  // registros consistentes no se asume ninguno.
  if (mejor.consistencia < 0.5) return { delimitador: null, consistencia: mejor.consistencia, evaluados };
  return { delimitador: mejor.delimitador, consistencia: mejor.consistencia, evaluados };
}

const nombreDelimitador = (d) => ({ ",": "coma", ";": "punto y coma", "\t": "tabulador", "|": "barra vertical" })[d] ?? "no identificado";

// Inspección completa. Nunca lanza excepciones: los errores quedan en `error`.
export function inspeccionar({ bytes, nombre, sha256 }) {
  const base = {
    nombre,
    sha256,
    bytes: bytes.length,
    pistaNombre: RE_NOMBRE_INSITE.test(nombre ?? ""),
    avisos: [],
    error: null,
  };

  const det = detectarCodificacion(bytes);
  base.codificacion = det;
  if (!det.codificacion) {
    return { ...base, error: `No es un archivo de texto reconocible: ${det.motivo}.` };
  }

  const dec = decodificar(bytes, det.codificacion);
  if (dec.error) {
    return { ...base, error: `Error de codificación: ${dec.error}.` };
  }
  const texto = dec.texto;

  if (texto.includes("\u0000")) base.avisos.push("El texto contiene caracteres nulos.");
  if (texto.includes("�")) base.avisos.push("Hay caracteres de reemplazo; la codificación podría no ser la correcta.");

  const delim = detectarDelimitador(texto);
  base.delimitador = delim.delimitador;
  base.consistenciaDelimitador = delim.consistencia;
  base.delimitadoresEvaluados = delim.evaluados;
  const usado = delim.delimitador ?? ",";
  if (!delim.delimitador) {
    base.avisos.push("No se identificó un delimitador consistente; se analiza como coma.");
  } else if (delim.consistencia < 0.9) {
    base.avisos.push(`El delimitador aparece de forma consistente solo en ${Math.round(delim.consistencia * 100)}% de los registros.`);
  }

  let registros;
  try {
    registros = parsear(texto, usado);
  } catch (e) {
    if (e instanceof ComillaSinCerrar) return { ...base, error: `Comilla sin cerrar: ${e.message}` };
    return { ...base, error: `Error de lectura: ${e.message}` };
  }

  const validos = registros.filter((r) => !r[2]);
  const blancos = registros.length - validos.length;
  base.lineasEnBlanco = blancos;
  if (!validos.length) return { ...base, error: "El archivo está vacío." };

  const encabezados = validos[0][0];
  const datos = validos.slice(1);
  base.encabezados = encabezados;
  base.filas = datos.length;
  base.columnas = encabezados.length;

  // Encabezados repetidos o vacíos.
  const conteo = new Map();
  for (const h of encabezados) conteo.set(h, (conteo.get(h) ?? 0) + 1);
  base.encabezadosRepetidos = [...conteo].filter(([, v]) => v > 1).map(([h, v]) => ({ nombre: h, veces: v }));
  base.encabezadosVacios = encabezados.filter((h) => h.trim() === "").length;

  // Vacíos por columna (solo celdas presentes).
  base.vaciosPorColumna = encabezados.map((h, i) => {
    let vacios = 0;
    for (const [campos] of datos) {
      if (i < campos.length && campos[i].trim() === "") vacios++;
    }
    return { nombre: h, vacios };
  });

  // Registros con número de campos distinto al encabezado.
  const malformados = [];
  for (const [campos, linea] of datos) {
    if (campos.length !== encabezados.length) malformados.push({ linea, campos: campos.length });
  }
  base.malformados = malformados;

  // Filas exactamente repetidas.
  const vistas = new Map();
  const repetidas = [];
  for (const [campos, linea] of datos) {
    const clave = JSON.stringify(campos);
    if (vistas.has(clave)) repetidas.push({ linea, primeraLinea: vistas.get(clave) });
    else vistas.set(clave, linea);
  }
  base.filasRepetidas = repetidas;

  // Vista previa: solo para pantalla, con celdas recortadas.
  base.vistaPrevia = [encabezados, ...datos.slice(0, LIMITE_VISTA).map(([c]) => c)].map((fila) =>
    fila.map((c) => (c.length > MAX_CELDA ? c.slice(0, MAX_CELDA) + "…" : c))
  );

  if (base.filas === 0) base.avisos.push("El archivo tiene encabezados pero ningún registro de datos.");
  if (base.columnas === 1 && !delim.delimitador) base.avisos.push("Una sola columna: puede faltar el delimitador correcto.");
  return base;
}

// Reporte estructural anonimizado: sin valores, sin vista previa y sin el nombre del archivo.
export function reporteEstructural(ins) {
  const celda = (t) => String(t ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const tabla = (encabezados, filas) =>
    [
      `| ${encabezados.map(celda).join(" | ")} |`,
      `|${encabezados.map(() => "---").join("|")}|`,
      ...filas.map((f) => `| ${f.map(celda).join(" | ")} |`),
    ].join("\n");

  const lineas = [];
  lineas.push("# Inspección estructural de archivo CSV", "");
  lineas.push(`> ${LEYENDA_INSPECCION}`, "");
  lineas.push("## Identificación del archivo", "");
  lineas.push(tabla(["Dato", "Valor"], [
    ["SHA-256", ins.sha256],
    ["Tamaño (bytes)", ins.bytes],
    ["Nombre del archivo", ins.pistaNombre
      ? "no incluido; coincide con la convención de nombre de INSITE (pista, no confirmación)"
      : "no incluido; no coincide con la convención de nombre de INSITE"],
  ]), "");

  if (ins.error) {
    lineas.push("## Resultado", "", `**Error:** ${ins.error}`, "");
    return lineas.join("\n");
  }

  lineas.push("## Estructura detectada", "");
  lineas.push(tabla(["Propiedad", "Valor", "Confianza / motivo"], [
    ["Codificación", ins.codificacion.codificacion, `${ins.codificacion.confianza}: ${ins.codificacion.motivo}`],
    ["Delimitador", nombreDelimitador(ins.delimitador), ins.delimitador ? `consistencia ${Math.round(ins.consistenciaDelimitador * 100)}%` : "no identificado"],
    ["Registros de datos", ins.filas, ""],
    ["Columnas", ins.columnas, ""],
    ["Líneas en blanco", ins.lineasEnBlanco, ""],
  ]), "");

  lineas.push("## Encabezados", "");
  lineas.push(ins.encabezados.map((h, i) => `${i + 1}. ${h === "" ? "(vacío)" : celda(h)}`).join("\n"), "");

  lineas.push("## Campos vacíos por columna", "");
  lineas.push(tabla(["Columna", "Celdas vacías"], ins.vaciosPorColumna.map((c) => [c.nombre === "" ? "(vacío)" : c.nombre, c.vacios])), "");

  lineas.push("## Errores de estructura", "");
  const lista = (titulo, items) => {
    lineas.push(`- ${titulo}: ${items.length}`);
    if (items.length) lineas.push(`  - líneas: ${items.slice(0, LIMITE_LISTA).map((i) => i.linea).join(", ")}${items.length > LIMITE_LISTA ? " …" : ""}`);
  };
  lista("registros con número de campos distinto al encabezado", ins.malformados);
  lineas.push(`- encabezados repetidos: ${ins.encabezadosRepetidos.length}${ins.encabezadosRepetidos.length ? " (" + ins.encabezadosRepetidos.map((h) => `${celda(h.nombre) || "(vacío)"} ×${h.veces}`).join(", ") + ")" : ""}`);
  lineas.push(`- encabezados vacíos: ${ins.encabezadosVacios}`);
  lista("filas exactamente repetidas", ins.filasRepetidas);
  lineas.push("");

  if (ins.avisos.length) {
    lineas.push("## Avisos", "");
    for (const a of ins.avisos) lineas.push(`- ${a}`);
    lineas.push("");
  }

  lineas.push("## Siguiente paso", "");
  lineas.push("Revise los encabezados y la estructura con la documentación de su exportación. Este reporte no contiene valores ni vista previa; los encabezados pueden incluir nombres propios, revíselos antes de compartir.", "");
  return lineas.join("\n");
}
