// Resumen ejecutivo e hallazgos en lenguaje sencillo.
// Solo lee el resultado que ya calculó el motor (motor.js). No recalcula,
// no reclasifica y no afirma cuál configuración es correcta.
// Cada texto describe un hecho leído de los archivos y no atribuye causas,
// efectos ni consecuencias técnicas.

const sinDato = "no identificado";

const valorDe = (p) => (p === null || p === undefined ? null : p.valor);

function textoValor(p) {
  if (p === null || p === undefined) return "—";
  if (p.valor === null) return "vacío";
  return p.unidad ? `${p.valor} ${p.unidad}` : String(p.valor);
}

// Traduce el motivo técnico del motor a una frase sencilla. Conserva el dato original.
function textoNoComparable(n) {
  const m = n.motivo;
  if (m.startsWith("parámetro duplicado")) {
    return `${n.nombre} aparece más de una vez en ${m.endsWith("A") ? "la configuración A" : "la configuración B"}. Ninguna de sus filas se compara.`;
  }
  if (m.startsWith("valor nulo")) {
    return `${n.nombre} tiene un valor vacío ${m.replace("valor nulo ", "")}. No se compara.`;
  }
  if (m.startsWith("unidades distintas")) {
    return `${n.nombre} tiene unidades distintas (${m.replace("unidades distintas: ", "")}). No se compara.`;
  }
  return `${n.nombre} no se compara: ${m}.`;
}

const SIN_DEF = " No tiene definición en el diccionario de este análisis.";

export function construirResumen(resultado) {
  const { identificacion, valores, noComparables, errores, compatibilidad } = resultado;
  const campo = (nombre) => identificacion.find((f) => f.campo === nombre) ?? { a: null, b: null, estado: "ausente" };

  const pares = (nombre) => {
    const f = campo(nombre);
    const a = valorDe(f.a);
    const b = valorDe(f.b);
    if (a === null && b === null) return { a: sinDato, b: sinDato, igual: true };
    return { a: a ?? sinDato, b: b ?? sinDato, igual: a === b };
  };

  const motor = pares("engine");
  const ecm = pares("ecm_id");
  const calibracion = pares("cal_id");
  const software = pares("sw_version");

  const revisionEmision = [
    ...valores.filter((d) => d.emision).map((d) => ({ nombre: d.nombre, origen: "valor" })),
    ...noComparables.filter((n) => n.emision).map((n) => ({ nombre: n.nombre, origen: "no comparable" })),
  ];

  const hallazgos = [];

  // 1. Parámetros que requieren revisión humana (primero, para que se vean).
  for (const r of revisionEmision) {
    hallazgos.push({
      tipo: "revision",
      texto: `${r.nombre} está relacionado con emisiones y requiere revisión por personal calificado. La herramienta no interpreta su efecto.`,
    });
  }

  // 2. Diferencias de valor entre parámetros comparables.
  for (const d of valores) {
    const sinDef = d.confianza === "sin definición documentada" ? SIN_DEF : "";
    if (d.estado === "cambiado") {
      hallazgos.push({
        tipo: "cambio",
        texto: `${d.nombre} presenta valores diferentes entre ambas configuraciones: ${textoValor(d.a)} en A y ${textoValor(d.b)} en B.${sinDef}`,
      });
    } else if (d.estado === "agregado") {
      hallazgos.push({
        tipo: "solo_una",
        texto: `${d.nombre} aparece solo en la configuración B, con valor ${textoValor(d.b)}.${sinDef}`,
      });
    } else if (d.estado === "eliminado") {
      hallazgos.push({
        tipo: "solo_una",
        texto: `${d.nombre} aparece solo en la configuración A, con valor ${textoValor(d.a)}.${sinDef}`,
      });
    }
  }

  // 3. Datos que no pueden compararse.
  for (const n of noComparables) {
    if (n.emision) continue; // ya listado arriba
    hallazgos.push({ tipo: "no_comparable", texto: textoNoComparable(n) });
  }

  // 4. Identificación distinta entre ambas configuraciones.
  for (const f of identificacion) {
    if (f.estado === "distinto") {
      const a = valorDe(f.a) ?? sinDato;
      const b = valorDe(f.b) ?? sinDato;
      hallazgos.push({ tipo: "identificacion", texto: `${f.campo} es distinto: ${a} en A y ${b} en B.` });
    }
  }

  return {
    motor: motor.a === motor.b ? motor.a : `A: ${motor.a} · B: ${motor.b}`,
    ecm: ecm.a === ecm.b ? ecm.a : `A: ${ecm.a} · B: ${ecm.b}`,
    calibracionA: calibracion.a,
    calibracionB: calibracion.b,
    softwareA: software.a,
    softwareB: software.b,
    diferencias: valores.length,
    noComparables: noComparables.length,
    revision: revisionEmision.length,
    errores: errores.length,
    compatibilidad,
    hallazgos,
    iaEjecutada: false,
  };
}
