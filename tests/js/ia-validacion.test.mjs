// Pruebas del módulo de validación de IA (compartido por la PWA y el backend).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  validarRegistro, validarSolicitud, construirSolicitud, construirMensajeModelo,
  interpretarRespuesta, validarExplicacion, fragmento, TERMINOS_PROHIBIDOS,
} from "../../js/ia-validacion.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const registro = JSON.parse(readFileSync(path.join(RAIZ, "ejemplo/documentos-demo/documentos.json"), "utf-8"));

const cambio = (nombre, a, b, unidad = "rpm", emision = false) => ({
  nombre, estado: "cambiado", a: { valor: a, unidad }, b: { valor: b, unidad }, emision, confianza: "con definición documentada",
});
const itemRalenti = () => ({
  nombre: "DEMO_REGIMEN_RALENTI", estado: "cambiado", a: "650", b: "700", unidad: "rpm",
  citas: [{ doc: "DEMO-DOC-01", seccion: "2.1" }],
});
const TEXTO_OK = "DEMO_REGIMEN_RALENTI indica el régimen de giro del motor en ralentí, expresado en rpm. Los valores son 650 rpm en A y 700 rpm en B.";
const expl = (texto, citas = [{ doc: "DEMO-DOC-01", seccion: "2.1" }]) => ({ nombre: "DEMO_REGIMEN_RALENTI", estado: "explicado", texto, citas });

// ---------- Registro ----------

test("el registro DEMO pasa las validaciones de coherencia", () => {
  assert.deepEqual(validarRegistro(registro), []);
});

test("el registro detecta citas a secciones inexistentes", () => {
  const malo = structuredClone(registro);
  malo.parametros.DEMO_REGIMEN_RALENTI = [{ doc: "DEMO-DOC-01", seccion: "9.9" }];
  assert.ok(validarRegistro(malo).some((p) => /inexistente/.test(p)));
});

test("el registro no puede documentar parámetros de emisiones", () => {
  const malo = structuredClone(registro);
  malo.parametros.DEF_DOSIFICACION = [{ doc: "DEMO-DOC-01", seccion: "2.1" }];
  assert.ok(validarRegistro(malo).some((p) => /emisiones/.test(p)));
});

test("fragmento devuelve null para citas desconocidas", () => {
  assert.equal(fragmento(registro, { doc: "X", seccion: "1" }), null);
  assert.equal(fragmento(registro, { doc: "DEMO-DOC-01", seccion: "2.1" }).fuente, "Manual de demostración X15 (ficticio)");
});

// ---------- Construcción de la solicitud ----------

test("construirSolicitud envía solo diferencias de valor con documentación", () => {
  const resultado = {
    valores: [cambio("DEMO_REGIMEN_RALENTI", "650", "700"), cambio("DEMO_SOLO_B", null, "3", "")],
    noComparables: [],
  };
  const s = construirSolicitud(resultado, registro);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].nombre, "DEMO_REGIMEN_RALENTI");
  assert.deepEqual(s.noDeterminables, [{ nombre: "DEMO_SOLO_B", motivo: "sin documentación en el registro" }]);
});

test("construirSolicitud excluye emisiones aunque tengan valores", () => {
  const resultado = { valores: [cambio("DEF_DOSIFICACION", "40", "35", "%", true)], noComparables: [] };
  const s = construirSolicitud(resultado, registro);
  assert.equal(s.items.length, 0);
  assert.match(s.noDeterminables[0].motivo, /emisiones/);
});

test("construirSolicitud respeta el máximo de parámetros por consulta", () => {
  const extra = structuredClone(registro);
  const valores = [];
  for (let i = 0; i < 10; i++) {
    const n = `DEMO_EXTRA_${i}`;
    extra.parametros[n] = [{ doc: "DEMO-DOC-01", seccion: "2.1" }];
    valores.push(cambio(n, "1", "2"));
  }
  const s = construirSolicitud({ valores, noComparables: [] }, extra);
  assert.equal(s.items.length, 8);
  assert.equal(s.noDeterminables.length, 2);
  assert.match(s.noDeterminables[0].motivo, /máximo/);
});

test("el mensaje al modelo contiene solo texto del registro y valores del motor", () => {
  const mensaje = JSON.parse(construirMensajeModelo([itemRalenti()], registro));
  assert.equal(mensaje.parametros[0].fragmentos[0].texto, registro.documentos[0].secciones[0].texto);
  assert.equal(mensaje.parametros[0].valor_a, "650");
});

// ---------- Validación de la solicitud ----------

test("validarSolicitud acepta una solicitud correcta", () => {
  assert.equal(validarSolicitud({ items: [itemRalenti()] }, registro).ok, true);
});

test("validarSolicitud rechaza campos desconocidos y nombres no válidos", () => {
  assert.equal(validarSolicitud({ items: [itemRalenti()], extra: 1 }, registro).ok, false);
  assert.equal(validarSolicitud({ items: [{ ...itemRalenti(), nombre: "DEMO ESPACIO" }] }, registro).ok, false);
  assert.equal(validarSolicitud({ items: [{ ...itemRalenti(), estado: "correcto" }] }, registro).ok, false);
});

test("validarSolicitud rechaza valores demasiado largos", () => {
  assert.equal(validarSolicitud({ items: [{ ...itemRalenti(), a: "x".repeat(61) }] }, registro).ok, false);
});

// ---------- Explicaciones ----------

test("una explicación válida pasa todas las validaciones", () => {
  assert.equal(validarExplicacion(expl(TEXTO_OK), itemRalenti(), registro).ok, true);
});

test("una cifra que no aparece en los datos o fragmentos invalida la explicación", () => {
  const v = validarExplicacion(expl(TEXTO_OK.replace("700 rpm", "900 rpm")), itemRalenti(), registro);
  assert.equal(v.ok, false);
  assert.match(v.motivo, /cifra no presente en los datos: 900/);
});

test("una cita a una sección no autorizada invalida la explicación", () => {
  const v = validarExplicacion(expl(TEXTO_OK, [{ doc: "DEMO-DOC-01", seccion: "3.1" }]), itemRalenti(), registro);
  assert.equal(v.ok, false);
  assert.match(v.motivo, /cita no autorizada/);
});

test("una explicación sin citas invalida la explicación", () => {
  assert.equal(validarExplicacion(expl(TEXTO_OK, []), itemRalenti(), registro).ok, false);
});

test("una explicación que no menciona el parámetro se rechaza", () => {
  const v = validarExplicacion(expl("El régimen en ralentí cambia entre 650 rpm y 700 rpm según el documento citado."), itemRalenti(), registro);
  assert.equal(v.ok, false);
  assert.match(v.motivo, /no menciona/);
});

test("términos prohibidos se detectan sin distinguir mayúsculas ni acentos", () => {
  for (const termino of ["Modifique", "CORRECTO", "riésgo", "recomiendo", "causa", "mejor", "reemplace"]) {
    const texto = `DEMO_REGIMEN_RALENTI indica el régimen en ralentí, expresado en rpm. ${termino} con 650 y 700 rpm.`;
    const v = validarExplicacion(expl(texto), itemRalenti(), registro);
    assert.equal(v.ok, false, `debería rechazarse por "${termino}"`);
  }
});

test("la lista de términos prohibidos incluye los de ia.py", () => {
  for (const t of ["desactiv", "anul", "bypass", "reprogram", "modific", "recomend", "caus", "efect", "como cambiar"]) {
    assert.ok(TERMINOS_PROHIBIDOS.includes(t), `falta ${t}`);
  }
});

test("texto demasiado corto o demasiado largo se rechaza", () => {
  assert.equal(validarExplicacion(expl("corto 650 700"), itemRalenti(), registro).ok, false);
  assert.equal(validarExplicacion(expl("DEMO_REGIMEN_RALENTI " + "a".repeat(400) + " 650 700"), itemRalenti(), registro).ok, false);
});

// ---------- Interpretación de la respuesta ----------

test("interpretarRespuesta acepta JSON envuelto en bloque de código", () => {
  const texto = "```json\n" + JSON.stringify({ explicaciones: [expl(TEXTO_OK)] }) + "\n```";
  const r = interpretarRespuesta(texto, [itemRalenti()], registro);
  assert.equal(r.items[0].estado, "validada");
});

test("un parámetro no respondido queda como no determinable", () => {
  const r = interpretarRespuesta(JSON.stringify({ explicaciones: [] }), [itemRalenti()], registro);
  assert.equal(r.items[0].estado, "no_determinable");
});

test("elementos no solicitados se descartan y se cuentan", () => {
  const texto = JSON.stringify({ explicaciones: [expl(TEXTO_OK), { nombre: "OTRO", estado: "explicado", texto: "x", citas: [] }] });
  const r = interpretarRespuesta(texto, [itemRalenti()], registro);
  assert.equal(r.descartados, 1);
  assert.equal(r.items[0].estado, "validada");
});

test("una respuesta repetida para el mismo parámetro se rechaza", () => {
  const texto = JSON.stringify({ explicaciones: [expl(TEXTO_OK), expl(TEXTO_OK)] });
  assert.equal(interpretarRespuesta(texto, [itemRalenti()], registro).items[0].estado, "rechazada");
});

test("un estado no reconocido se rechaza", () => {
  const texto = JSON.stringify({ explicaciones: [{ ...expl(TEXTO_OK), estado: "probable" }] });
  assert.equal(interpretarRespuesta(texto, [itemRalenti()], registro).items[0].estado, "rechazada");
});

test("la salida nunca contiene texto de una explicación rechazada", () => {
  const texto = JSON.stringify({ explicaciones: [expl(TEXTO_OK.replace("700 rpm", "999 rpm"))] });
  const r = interpretarRespuesta(texto, [itemRalenti()], registro);
  assert.equal(r.items[0].estado, "rechazada");
  assert.equal(r.items[0].texto, undefined);
});

test("no determinable del modelo se respeta sin inventar texto", () => {
  const texto = JSON.stringify({ explicaciones: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "no_determinable", texto: null, citas: [] }] });
  const r = interpretarRespuesta(texto, [itemRalenti()], registro);
  assert.equal(r.items[0].estado, "no_determinable");
  assert.equal(r.items[0].texto, undefined);
});
