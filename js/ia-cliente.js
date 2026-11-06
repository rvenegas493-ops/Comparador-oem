// Cliente de la interpretación asistida por IA. Solo envía al servicio autorizado
// los nombres de los parámetros, sus valores y las citas documentales. Nunca envía
// archivos, nombres de archivo, SHA-256 ni datos de clientes.
//
// El navegador solo guarda la URL del servicio y un token de acceso revocable.
// No contiene ninguna clave del proveedor de IA.
import { validarExplicacion, fragmento } from "./ia-validacion.js";

export const CLAVE_IA = "comparador.ia";
export const RUTA_INTERPRETAR = "/v1/interpretar";

// Lee la configuración guardada. Nunca lanza excepciones.
export function leerConfiguracionIA(almacen = globalThis.localStorage) {
  try {
    const c = JSON.parse(almacen?.getItem(CLAVE_IA) ?? "{}");
    return { url: typeof c.url === "string" ? c.url : "", token: typeof c.token === "string" ? c.token : "" };
  } catch {
    return { url: "", token: "" };
  }
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

export function guardarConfiguracionIA(config, almacen = globalThis.localStorage) {
  const url = String(config.url ?? "").trim();
  const token = String(config.token ?? "").trim();
  if (url === "" && token === "") {
    almacen.removeItem(CLAVE_IA);
    return { ok: true };
  }
  const error = validarUrlServicio(url);
  if (error) return { ok: false, error };
  if (token.length < 16) return { ok: false, error: "el token debe tener al menos 16 caracteres" };
  almacen.setItem(CLAVE_IA, JSON.stringify({ url, token }));
  return { ok: true };
}

export function borrarConfiguracionIA(almacen = globalThis.localStorage) {
  almacen.removeItem(CLAVE_IA);
}

// La IA solo se ofrece si hay URL válida y token, y el dispositivo tiene conexión.
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

// Envía la solicitud y devuelve { ok, items, descartados, huella, modelo } o { ok:false, error }.
// fetchFn y config son inyectables para pruebas.
export async function consultarIA({ solicitud, items, registro, config, fetchFn = globalThis.fetch, timeoutMs = 30000 }) {
  const error = validarUrlServicio(config.url);
  if (error) return { ok: false, error };
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetchFn(`${config.url.replace(/\/$/, "")}${RUTA_INTERPRETAR}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
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

  if (resp.status === 401) return { ok: false, error: "token no autorizado: revise la configuración" };
  if (resp.status === 429) return { ok: false, error: "límite de uso alcanzado: intente más tarde" };
  if (resp.status === 503) return { ok: false, error: "el servicio de interpretación no está disponible" };
  if (!resp.ok) return { ok: false, error: "el servicio devolvió un error" };

  let cuerpo;
  try {
    cuerpo = await resp.json();
  } catch {
    return { ok: false, error: "respuesta del servicio no válida" };
  }
  const revalidada = revalidarRespuesta(cuerpo, items, registro);
  return { ok: true, items: revalidada.items, descartados: revalidada.descartados, huella: cuerpo.huella ?? null, modelo: cuerpo.modelo ?? null, generado: cuerpo.generado_utc ?? null };
}
