// Pruebas de las reglas de seguridad de la interpretación: compatibilidad, unidades,
// estructura de la respuesta y documentación suficiente. Solo datos DEMO sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  construirSolicitud, validarSolicitud, interpretarRespuesta, estructuraExplicacion, contieneTermino,
} from "../../js/ia-validacion.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const registro = JSON.parse(readFileSync(path.join(RAIZ, "ejemplo/documentos-demo/documentos.json"), "utf-8"));
const CITA = [{ doc: "DEMO-DOC-01", seccion: "2.1" }];
const TEXTO = "DEMO_REGIMEN_RALENTI indica el régimen de giro del motor en ralentí, expresado en rpm. Los valores son 650 rpm en A y 700 rpm en B.";
const item = { nombre: "DEMO_REGIMEN_RALENTI", estado: "cambiado", a: "650", b: "700", unidad: "rpm", citas: CITA };
const valor = (nombre, estado, a, b, unidad) => ({
  nombre, estado, emision: false,
  a: a === null ? null : { valor: a, unidad }, b: b === null ? null : { valor: b, unidad },
});

// ---------- Documentación suficiente antes de enviar ----------

test("una unidad que no aparece en la documentación citada no se envía", () => {
  const s = construirSolicitud({ valores: [valor("DEMO_REGIMEN_RALENTI", "cambiado", "650", "700", "kPa")], noComparables: [] }, registro);
  assert.equal(s.items.length, 0);
  assert.match(s.noDeterminables[0].motivo, /unidad no aparece/);
});

test("un parámetro agregado o eliminado no se interpreta como diferencia de valor", () => {
  const s = construirSolicitud({ valores: [valor("DEMO_REGIMEN_RALENTI", "agregado", null, "700", "rpm")], noComparables: [] }, registro);
  assert.equal(s.items.length, 0);
  assert.match(s.noDeterminables[0].motivo, /no es una diferencia de valor/);
});

test("el servidor rechaza una unidad no documentada aunque el cliente la envíe", () => {
  const r = validarSolicitud({ items: [{ ...item, unidad: "kPa" }] }, registro);
  assert.equal(r.ok, false);
  assert.ok(r.errores.some((e) => /unidad no aparece/.test(e)));
});

test("el servidor rechaza items que no son diferencias de valor", () => {
  const r = validarSolicitud({ items: [{ ...item, estado: "agregado" }] }, registro);
  assert.equal(r.ok, false);
  assert.ok(r.errores.some((e) => /solo se interpretan diferencias de valor/.test(e)));
});

test("la coincidencia de unidades respeta límites de palabra", () => {
  assert.equal(contieneTermino("expresado en rpms", "rpm"), false);
  assert.equal(contieneTermino("expresado en rpm.", "rpm"), true);
  assert.equal(contieneTermino("en (bar) y", "bar"), true);
});

// ---------- Compatibilidad siempre NO VERIFICADA ----------

test("una explicación que declara compatibilidad se rechaza", () => {
  const texto = TEXTO + " Las calibraciones son compatibles entre sí.";
  const r = interpretarRespuesta(JSON.stringify({ explicaciones: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "explicado", texto, citas: CITA }] }), [item], registro);
  assert.equal(r.items[0].estado, "rechazada");
  assert.match(r.items[0].motivo, /compatib/);
});

test("ninguna explicación validada puede llevar un campo de compatibilidad", () => {
  const r = interpretarRespuesta(JSON.stringify({
    explicaciones: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "explicado", texto: TEXTO, citas: CITA, compatibilidad: "verificada" }],
  }), [item], registro);
  assert.equal(r.items[0].estado, "rechazada");
  assert.match(r.items[0].motivo, /campo no permitido: compatibilidad/);
});

// ---------- Estructura JSON estricta ----------

test("una respuesta con campos extra en el nivel superior se rechaza completa", () => {
  const r = interpretarRespuesta(JSON.stringify({ explicaciones: [], veredicto: "compatible" }), [item], registro);
  assert.equal(r.items[0].estado, "rechazada");
});

test("una cita con campos adicionales se rechaza", () => {
  const r = interpretarRespuesta(JSON.stringify({
    explicaciones: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "explicado", texto: TEXTO, citas: [{ doc: "DEMO-DOC-01", seccion: "2.1", url: "x" }] }],
  }), [item], registro);
  assert.equal(r.items[0].estado, "rechazada");
  assert.match(r.items[0].motivo, /campo de cita no permitido/);
});

test("el validador de estructura detecta tipos incorrectos", () => {
  assert.equal(estructuraExplicacion({ nombre: "X", estado: "explicado", texto: "t", citas: [] }), null);
  assert.match(estructuraExplicacion({ nombre: 5, estado: "explicado", texto: "t", citas: [] }), /nombre/);
  assert.match(estructuraExplicacion({ nombre: "X", estado: "probable", texto: "t", citas: [] }), /estado/);
  assert.match(estructuraExplicacion({ nombre: "X", estado: "explicado", texto: "t", citas: "no" }), /lista/);
  assert.match(estructuraExplicacion({ nombre: "X", estado: "explicado", texto: "t", citas: [{ doc: 1, seccion: "2" }] }), /mal formada/);
});

// ---------- Registro de rechazos ----------

test("cada rechazo lleva un motivo legible para el registro de auditoría", () => {
  const r = interpretarRespuesta(JSON.stringify({ explicaciones: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "explicado", texto: TEXTO.replace("700 rpm", "999 rpm"), citas: CITA }] }), [item], registro);
  assert.equal(r.items[0].estado, "rechazada");
  assert.match(r.items[0].motivo, /cifra no presente en los datos: 999/);
});
