// Pruebas del cliente de IA. El servicio se simula con un fetch de prueba (test double).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  leerConfiguracionIA, guardarConfiguracionIA, validarUrlServicio, iaDisponible, CLAVE_TOKEN_IA,
  resumenEnvio, revalidarRespuesta, consultarIA, CLAVE_IA,
} from "../../js/ia-cliente.js";
import { construirSolicitud } from "../../js/ia-validacion.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const registro = JSON.parse(readFileSync(path.join(RAIZ, "ejemplo/documentos-demo/documentos.json"), "utf-8"));

const almacenFalso = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};
const TOKEN = "token-de-prueba-0123456789";
const CONFIG = { url: "https://servicio.ejemplo.test", token: TOKEN };
const TEXTO = "DEMO_REGIMEN_RALENTI indica el régimen de giro del motor en ralentí, expresado en rpm. Los valores son 650 rpm en A y 700 rpm en B.";

const cambio = (nombre, a, b) => ({ nombre, estado: "cambiado", a: { valor: a, unidad: "rpm" }, b: { valor: b, unidad: "rpm" }, emision: false });
const resultadoDemo = { valores: [cambio("DEMO_REGIMEN_RALENTI", "650", "700")], noComparables: [] };
const { items } = construirSolicitud(resultadoDemo, registro);
const solicitud = { items };

// Respuesta de servicio "de prueba": imita el contrato de handler.js.
const respuestaServicio = (cuerpo, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => cuerpo,
});

test("la configuración se guarda y se lee sin lanzar excepciones", () => {
  const a = almacenFalso();
  assert.equal(guardarConfiguracionIA(CONFIG, a, a).ok, true);
  assert.deepEqual(leerConfiguracionIA(a, a), CONFIG);
  a.setItem(CLAVE_IA, "{no es json");
  // La URL corrupta se ignora; el token vive aparte en sessionStorage.
  assert.deepEqual(leerConfiguracionIA(a, a), { url: "", token: TOKEN });
});

test("vaciar URL y token borra la configuración", () => {
  const a = almacenFalso();
  guardarConfiguracionIA(CONFIG, a, a);
  assert.equal(guardarConfiguracionIA({ url: "", token: "" }, a, a).ok, true);
  assert.equal(a.getItem(CLAVE_IA), null);
});

test("solo se acepta HTTPS, o HTTP en localhost para pruebas", () => {
  assert.equal(validarUrlServicio("https://a.test"), null);
  assert.equal(validarUrlServicio("http://localhost:8787"), null);
  assert.match(validarUrlServicio("http://a.test"), /HTTPS/);
  assert.match(validarUrlServicio("no es url"), /no es válida/);
  assert.match(validarUrlServicio("https://usuario:clave@a.test"), /credenciales/);
  assert.match(validarUrlServicio("https://a.test/?x=1"), /consulta/);
});

test("un token corto no se guarda", () => {
  const r = guardarConfiguracionIA({ url: "https://a.test", token: "corto" }, almacenFalso());
  assert.equal(r.ok, false);
});

test("la IA solo está disponible con configuración completa y conexión", () => {
  assert.equal(iaDisponible(CONFIG, true), true);
  assert.equal(iaDisponible(CONFIG, false), false);
  assert.equal(iaDisponible({ url: "", token: "" }, true), false);
  assert.equal(iaDisponible({ url: "https://a.test", token: "" }, true), false);
});

test("el texto de confirmación lista parámetros y citas, y niega el envío de archivos", () => {
  const texto = resumenEnvio(solicitud);
  assert.match(texto, /DEMO_REGIMEN_RALENTI: A=650, B=700 rpm/);
  assert.match(texto, /DEMO-DOC-01 §2\.1/);
  assert.match(texto, /No se envía ningún archivo/);
  assert.doesNotMatch(texto, /sha256|\.csv/i);
});

test("consultarIA envía solo los items con Bearer y sin cookies ni referrer", async () => {
  let capturado;
  const fetchFn = async (url, opciones) => {
    capturado = { url, opciones };
    return respuestaServicio({ modelo: "m", huella: "h", items: [], descartados: 0 });
  };
  await consultarIA({ solicitud, items, registro, config: CONFIG, fetchFn });
  assert.equal(capturado.url, "https://servicio.ejemplo.test/v1/interpretar");
  assert.equal(capturado.opciones.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(capturado.opciones.credentials, "omit");
  assert.equal(capturado.opciones.referrerPolicy, "no-referrer");
  const cuerpo = JSON.parse(capturado.opciones.body);
  assert.deepEqual(Object.keys(cuerpo), ["items"]);
  assert.ok(!capturado.opciones.body.includes("sha256"));
});

test("una explicación con cifra inventada se rechaza en el navegador aunque el servidor la marque válida", () => {
  const respuesta = {
    items: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "validada", texto: TEXTO.replace("700 rpm", "950 rpm"), citas: [{ doc: "DEMO-DOC-01", seccion: "2.1" }] }],
    descartados: 0,
  };
  const r = revalidarRespuesta(respuesta, items, registro);
  assert.equal(r.items[0].estado, "rechazada");
  assert.equal(r.items[0].texto, undefined);
});

test("una cita no autorizada se rechaza en el navegador", () => {
  const respuesta = {
    items: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "validada", texto: TEXTO, citas: [{ doc: "DEMO-DOC-01", seccion: "3.1" }] }],
    descartados: 0,
  };
  assert.equal(revalidarRespuesta(respuesta, items, registro).items[0].estado, "rechazada");
});

test("una explicación válida conserva las fuentes del registro para mostrarlas", () => {
  const respuesta = {
    items: [{ nombre: "DEMO_REGIMEN_RALENTI", estado: "validada", texto: TEXTO, citas: [{ doc: "DEMO-DOC-01", seccion: "2.1" }] }],
    descartados: 0,
  };
  const r = revalidarRespuesta(respuesta, items, registro);
  assert.equal(r.items[0].estado, "validada");
  assert.equal(r.items[0].fuentes[0].version, "0.1");
  assert.equal(r.items[0].fuentes[0].seccion, "2.1");
});

test("un parámetro sin respuesta queda como no determinable", () => {
  const r = revalidarRespuesta({ items: [], descartados: 0 }, items, registro);
  assert.equal(r.items[0].estado, "no_determinable");
});

test("errores del servicio se traducen a mensajes sin detalles internos", async () => {
  const casos = [
    [401, /token no autorizado/],
    [429, /límite de uso/],
    [503, /no está disponible/],
    [502, /fallo temporal/],
    [403, /datos sintéticos/],
  ];
  for (const [status, mensaje] of casos) {
    const r = await consultarIA({ solicitud, items, registro, config: CONFIG, fetchFn: async () => respuestaServicio({}, status) });
    assert.equal(r.ok, false);
    assert.match(r.error, mensaje);
  }
});

test("un fallo de red no muestra el error técnico", async () => {
  const r = await consultarIA({ solicitud, items, registro, config: CONFIG, fetchFn: async () => { throw new Error("ECONNRESET 10.0.0.5"); } });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /ECONNRESET|10\.0\.0\.5/);
});

test("sin URL válida no se envía nada", async () => {
  let llamadas = 0;
  const r = await consultarIA({ solicitud, items, registro, config: { url: "http://externo.test", token: TOKEN }, fetchFn: async () => { llamadas++; } });
  assert.equal(r.ok, false);
  assert.equal(llamadas, 0);
});

test("el token nunca se guarda en localStorage: solo en sessionStorage", () => {
  const local = almacenFalso();
  const sesion = almacenFalso();
  guardarConfiguracionIA(CONFIG, local, sesion);
  assert.equal(local.getItem(CLAVE_IA).includes(TOKEN), false);
  assert.equal(sesion.getItem(CLAVE_TOKEN_IA), TOKEN);
});

test("un token guardado por una versión anterior en localStorage se elimina al leer", () => {
  const local = almacenFalso();
  const sesion = almacenFalso();
  local.setItem(CLAVE_IA, JSON.stringify({ url: "https://a.test", token: TOKEN }));
  const c = leerConfiguracionIA(local, sesion);
  assert.equal(c.url, "https://a.test");
  assert.equal(c.token, "");
  assert.equal(local.getItem(CLAVE_IA).includes(TOKEN), false);
});

test("la cabecera de modo demostración solo se envía con confirmación", async () => {
  const cabeceras = [];
  const fetchFn = async (url, opciones) => { cabeceras.push(opciones.headers); return respuestaServicio({ items: [], descartados: 0 }); };
  await consultarIA({ solicitud, items, registro, config: CONFIG, modoDemo: true, fetchFn });
  await consultarIA({ solicitud, items, registro, config: CONFIG, fetchFn });
  assert.equal(cabeceras[0]["x-modo-demostracion"], "sintetico-confirmado");
  assert.equal(cabeceras[1]["x-modo-demostracion"], undefined);
});
