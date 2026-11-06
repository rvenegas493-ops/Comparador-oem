// Cliente de la interpretación asistida por IA. Solo envía al servicio autorizado
// los nombres de los parámetros, sus valores y las citas documentales. Nunca envía
// archivos, nombres de archivo, SHA-256 ni datos de clientes.
//
// Seguridad del token: se guarda solo en sessionStorage (se borra al cerrar la pestaña).
// Nunca se guarda en localStorage, en la URL ni en el código. La dirección del servicio
// sí se guarda en localStorage porque no es secreta.
import { validarExplicacion, fragmento } from "./ia-validacion.js";

export const CLAVE_IA = "comparador.ia";           // localStorage: solo la URL
export const CLAVE_TOKEN_IA = "comparador.ia.token"; // sessionStorage: el token
export const RUTA_INTERPRETAR = "/v1/interpretar";
export const CABECERA_DEMO = "x-modo-demostracion";
export const VALOR_CONFIRMACION_DEMO = "sintetico-confirmado";

const sinAlmacen = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const seguro = (almacen) => almacen ?? sinAlmacen;

// Lee la configuración. Elimina cualquier token que quedara en localStorage de versiones anteriores.
export function leerConfiguracionIA(almacenUrl = globalThis.localStorage, almacenToken = globalThis.sessionStorage) {
  let url = "";
  try {
    const c = JSON.parse(seguro(almacenUrl).getItem(CLAVE_IA) ?? "{}");
    url = typeof c.url === "string" ? c.url : "";
    if ("token" in c) seguro(almacenUrl).setItem(CLAVE_IA, JSON.stringify({ url }));
  } catch {
    url = "";
  }
  let token = "";
  try {
    token = seguro(almacenToken).getItem(CLAVE_TOKEN_IA) ?? "";
  } catch {
    token = "";
  }
  return { url, token };
}

// Acepta HTTPS, o HTTP solo para localhost (pruebas locales).
export function validarUrlServicio(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "la dirección del servicio no es válida";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return "la dirección del servicio debe usar HTTPS";
  }
  if (u.username || u.password || u.search || u.hash) {
    return "la dirección del servicio no debe incluir credenciales, consulta ni fragmento";
  }
  return null;
}

export function guardarConfiguracionIA(config, almacenUrl = globalThis.localStorage, almacenToken = globalThis.sessionStorage) {
  const url = String(config.url ?? "").trim();
  const token = String(config.token ?? "").trim();
  if (url === "" && token === "") {
    borrarConfiguracionIA(almacenUrl, almacenToken);
    return { ok: true };
  }
  const error = validarUrlServicio(url);
  if (error) return { ok: false, error };
  if (token.length < 16) return { ok: false, error: "el token debe tener al menos 16 caracteres" };
  seguro(almacenUrl).setItem(CLAVE_IA, JSON.stringify({ url }));
  seguro(almacenToken).setItem(CLAVE_TOKEN_IA, token);
  return { ok: true };
}

export function borrarConfiguracionIA(almacenUrl = globalThis.localStorage, almacenToken = globalThis.sessionStorage) {
  seguro(almacenUrl).removeItem(CLAVE_IA);
  seguro(almacenToken).removeItem(CLAVE_TOKEN_IA);
}

// La IA solo está disponible con configuración completa y conexión.
export function iaDisponible(config, enLinea = true) {
  return enLinea && !validarUrlServicio(config.url ?? "") && (config.token ?? "").length >= 16;
}

// Texto exacto de lo que se enviará. Se muestra al usuario antes de cualquier envío.
export function resumenEnvio(solicitud) {
  const lineas = solicitud.items.map((it) => `• ${it.nombre}: A=${it.a ?? "nulo"}, B=${it.b ?? "nulo"}${it.unidad ? ` ${it.unidad}` : ""}; citas ${it.citas.map((c) => `${c.doc} §${c.seccion}`).join(", ")}`);
  return [
    "Se enviará al servicio de interpretación:",
    ...lineas,
    "",
    "No se envía ningún archivo, nombre de archivo, huella SHA-256 ni dato de cliente.",
    "El texto de la documentación lo toma el servicio de su propio registro, no de este dispositivo.",
  ].join("\n");
}

// Revalida en el navegador cada explicación recibida. No confía en el servidor.
export function revalidarRespuesta(respuesta, items, registro) {
  const salida = items.map((item) => {
    const r = respuesta.items?.find((x) => x && x.nombre === item.nombre);
    if (!r) return { nombre: item.nombre, estado: "no_determinable", motivo: "sin respuesta del servicio" };
    if (r.estado === "no_determinable") return { nombre: item.nombre, estado: "no_determinable", motivo: "evidencia insuficiente en la documentación citada" };
    if (r.estado !== "validada") return { nombre: item.nombre, estado: "rechazada", motivo: r.motivo ?? "no superó la validación del servicio" };
    const v = validarExplicacion({ nombre: item.nombre, estado: "explicado", texto: r.texto, citas: r.citas }, item, registro);
    if (!v.ok) return { nombre: item.nombre, estado: "rechazada", motivo: v.motivo };
    const fuentes = r.citas.map((c) => fragmento(registro, c)).filter(Boolean);
    return { nombre: item.nombre, estado: "validada", texto: v.texto, fuentes };
  });
  return { items: salida, descartados: respuesta.descartados ?? 0 };
}

const MENSAJES_ERROR = {
  401: "token no autorizado: revise el token en Ajustes",
  403: "el servicio requiere confirmar que se usan datos sintéticos",
  429: "límite de uso alcanzado: la cuota de prueba puede haberse agotado. Intente más tarde; el comparador sigue funcionando sin IA.",
  502: "la IA no respondió (fallo temporal del servicio). El comparador sigue funcionando sin IA.",
  503: "el servicio de interpretación no está disponible",
};

// Envía la solicitud. Devuelve { ok, items, descartados, huella, modelo, modo } o { ok:false, error }.
// Si modoDemo es true, envía la confirmación de datos sintéticos (el usuario la marcó en pantalla).
export async function consultarIA({ solicitud, items, registro, config, modoDemo = false, fetchFn = globalThis.fetch, timeoutMs = 30000 }) {
  const error = validarUrlServicio(config.url);
  if (error) return { ok: false, error };
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  const cabeceras = { "content-type": "application/json", authorization: `Bearer ${config.token}` };
  if (modoDemo) cabeceras[CABECERA_DEMO] = VALOR_CONFIRMACION_DEMO;
  let resp;
  try {
    resp = await fetchFn(`${config.url.replace(/\/$/, "")}${RUTA_INTERPRETAR}`, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify({ items: solicitud.items }),
      signal: controlador.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { ok: false, error: "no se pudo conectar con el servicio de interpretación" };
  } finally {
    clearTimeout(temporizador);
  }

  if (!resp.ok) return { ok: false, error: MENSAJES_ERROR[resp.status] ?? "el servicio devolvió un error" };

  let cuerpo;
  try {
    cuerpo = await resp.json();
  } catch {
    return { ok: false, error: "respuesta del servicio no válida" };
  }
  const revalidada = revalidarRespuesta(cuerpo, items, registro);
  return {
    ok: true,
    modo: cuerpo.modo ?? "produccion",
    items: revalidada.items,
    descartados: revalidada.descartados,
    huella: cuerpo.huella ?? null,
    modelo: cuerpo.modelo ?? null,
    generado: cuerpo.generado_utc ?? null,
  };
}
