// Modo de simulación: Cummins X15 — DEMO.
// Usa el mismo motor de comparación (procesar) que los archivos importados.
// Los archivos son sintéticos e identificados como tales; no son información
// oficial de Cummins ni sirven para diagnóstico.
import { procesar, ADAPTADOR_POR_DEFECTO } from "./motor.js";

export const LEYENDA_SIMULACION = "SIMULACIÓN — NO VÁLIDA PARA DIAGNÓSTICO";

const ARCHIVOS = {
  a: "demo_a.csv",
  b: "demo_b.csv",
  diccionario: "demo_diccionario.csv",
};

// Explicación escrita de antemano para la demostración. No es generada por IA
// ni se produce a partir de los datos: se muestra separada de los resultados.
export const EXPLICACION_DEMOSTRATIVA = [
  "Esta explicación está escrita de antemano para la demostración. No fue generada por IA.",
  "El valor de ralentí pasa de 650 a 700 rpm entre las dos configuraciones ficticias. Es un cambio de valor entre dos archivos; la herramienta no indica si es correcto ni qué lo causó.",
  "El parámetro de dosificación DEF aparece como revisión humana obligatoria porque su nombre se relaciona con emisiones. Un técnico calificado debe revisarlo; la herramienta no interpreta su efecto.",
  "Los parámetros marcados como no comparables no se comparan: tienen unidades distintas, valores nulos o duplicados.",
];

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// `leer(nombre)` devuelve los bytes del archivo de demostración.
export async function ejecutarSimulacion(leer) {
  const [bytesA, bytesB, bytesD] = await Promise.all([
    leer(ARCHIVOS.a),
    leer(ARCHIVOS.b),
    leer(ARCHIVOS.diccionario),
  ]);
  const [shaA, shaB, shaD] = await Promise.all([sha256Hex(bytesA), sha256Hex(bytesB), sha256Hex(bytesD)]);

  const r = procesar({
    diccionario: { bytes: bytesD, nombre: "SIMULACIÓN " + ARCHIVOS.diccionario, sha256: shaD },
    a: { bytes: bytesA, nombre: "SIMULACIÓN " + ARCHIVOS.a, sha256: shaA },
    b: { bytes: bytesB, nombre: "SIMULACIÓN " + ARCHIVOS.b, sha256: shaB },
    adaptador: ADAPTADOR_POR_DEFECTO,
  });

  const cabecera = `> **${LEYENDA_SIMULACION}.** Cummins X15 — DEMO: identificadores y parámetros inventados. No son información oficial de Cummins.\n\n`;
  return {
    ...r,
    leyenda: LEYENDA_SIMULACION,
    explicacion: EXPLICACION_DEMOSTRATIVA,
    markdown: cabecera + r.markdown,
    hashes: { a: shaA, b: shaB, diccionario: shaD },
  };
}
