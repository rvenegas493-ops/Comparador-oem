// Historial de comparaciones: almacenamiento con estados `active` y `archived`.
//
// Reglas de seguridad (detalladas en docs/HISTORIAL.md):
// - Ninguna operación borra registros. Archivar y restaurar solo cambian `estado`
//   y `archivadoEn`. Restaurar quita `archivadoEn`, así que el registro vuelve idéntico.
// - Cada registro se gestiona por su CLAVE, no por su identificador. Si dos registros
//   comparten `id`, cada uno tiene su propia clave y una operación sobre una clave
//   nunca afecta a otro registro. Un identificador repetido sin clave no coincide con nada.
// - Las operaciones se hacen dentro de un bloqueo exclusivo entre pestañas (Web Locks).
//   Se comprueba antes si el navegador lo admite. Si no lo admite, se usa una alternativa
//   que detecta otras pestañas abiertas. Ninguna de las dos garantiza atomicidad total.
//   Sin ninguna de ellas, las escrituras se rechazan.
// - Cada escritura se verifica releyendo el valor guardado.
// - Si el formato actual no se puede leer, el historial pasa a solo lectura.
// - El formato anterior (clave `comparador.historial`, array JSON de 1.3.0 y 1.3.1)
//   nunca se borra ni se sobrescribe.
//
// Sin dependencias de la interfaz: todo entra por parámetros, para poder probarlo en Node.

export const CLAVE_LEGADO = "comparador.historial";
export const CLAVE_V2 = "comparador.historial.v2";
export const NOMBRE_BLOQUEO = "comparador.historial";
export const NOMBRE_PRESENCIA = "comparador.historial.presencia";
const NOMBRE_SONDA = "comparador.historial.sonda";
const ESQUEMA = 2;
const ESPERA_PRESENCIA_MS = 200;

// Aviso de uso: 80 % de 5 MB, un límite típico por origen. Es solo un aviso.
export const UMBRAL_AVISO_BYTES = 4 * 1024 * 1024;

export const MENSAJE_SIN_GARANTIA =
  "Este navegador no permite guardar el historial de forma segura: no admite bloqueo entre pestañas ni comunicación entre ellas. Use un navegador actualizado. La comparación no se guardó; el reporte sigue descargable.";
export const MENSAJE_OTRA_PESTANA =
  "Hay otra pestaña de la aplicación abierta. Cierre las demás y vuelva a guardar. No se modificó nada.";

export const ESTADO = Object.freeze({ ACTIVO: "active", ARCHIVADO: "archived" });

export class ErrorCuota extends Error {
  constructor(mensaje) { super(mensaje); this.name = "ErrorCuota"; }
}
export class ErrorEscritura extends Error {
  constructor(mensaje) { super(mensaje); this.name = "ErrorEscritura"; }
}
export class ErrorDatos extends Error {
  constructor(mensaje) { super(mensaje); this.name = "ErrorDatos"; }
}

// Distintos navegadores reportan la cuota llena con nombres o códigos diferentes.
export function esErrorCuota(e) {
  return Boolean(e) && (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

const objetoConId = (e) => Boolean(e) && typeof e === "object" && typeof e.id === "string";
export const estadoDe = (e) =>
  (e && typeof e === "object" && e.estado === ESTADO.ARCHIVADO ? ESTADO.ARCHIVADO : ESTADO.ACTIVO);
const normalizar = (e) => (e && typeof e === "object" ? { ...e, estado: ESTADO.ACTIVO } : e);

// Contenido del registro sin el estado. Sirve para comparar y para generar claves.
export function canonico(e) {
  const { estado, archivadoEn, ...contenido } = e;
  return JSON.stringify(contenido);
}

// Hash de 64 bits (dos FNV-1a de 32 bits). Sirve para claves, no para seguridad.
function huella(texto) {
  const fnv = (semilla) => {
    let h = semilla >>> 0;
    for (let i = 0; i < texto.length; i++) {
      h ^= texto.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x9e3779b9);
}

// Clave estable por registro: identificador + huella del contenido.
// Archivar o restaurar no cambia el contenido, así que la clave no cambia.
// Dos registros con el mismo identificador y contenido distinto reciben claves distintas.
// Dos registros idénticos reciben sufijo de ocurrencia (~2, ~3…) para seguir siendo distintos.
export function calcularClaves(entradas) {
  const vistas = new Map();
  return entradas.map((e) => {
    if (!objetoConId(e)) return null;
    const base = `${e.id}~${huella(canonico(e))}`;
    const n = (vistas.get(base) ?? 0) + 1;
    vistas.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

// Identificadores que aparecen más de una vez, para avisar al técnico.
export function identificadoresRepetidos(entradas) {
  const cuenta = new Map();
  for (const e of entradas) if (objetoConId(e)) cuenta.set(e.id, (cuenta.get(e.id) ?? 0) + 1);
  return [...cuenta.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

// Bloqueo entre pestañas. Devuelve null si el navegador no tiene Web Locks.
export function bloqueoNavegador(global = globalThis) {
  const locks = global.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return null;
  return {
    // Comprueba que la API responde de verdad, no solo que existe.
    async probar() {
      try {
        await locks.request(NOMBRE_SONDA, { ifAvailable: true }, () => true);
        return true;
      } catch {
        return false;
      }
    },
    ejecutar: (fn) => locks.request(NOMBRE_BLOQUEO, { mode: "exclusive" }, fn),
  };
}

// Canal de presencia para la alternativa sin Web Locks. Devuelve null si no existe.
export function canalPresencia(global = globalThis) {
  return typeof global.BroadcastChannel === "function" ? new global.BroadcastChannel(NOMBRE_PRESENCIA) : null;
}

function parsearLegado(raw) {
  if (raw === null) return [];
  let v;
  try { v = JSON.parse(raw); } catch { throw new ErrorDatos("El historial anterior no es JSON válido."); }
  if (!Array.isArray(v)) throw new ErrorDatos("El historial anterior no tiene el formato esperado.");
  return v;
}

// Lectura de solo consulta para mostrar el formato anterior cuando el actual está dañado.
function legadoSeguro(raw) {
  try { return parsearLegado(raw); } catch { return []; }
}

function parsearV2(raw) {
  let v;
  try { v = JSON.parse(raw); } catch { throw new ErrorDatos("El historial no es JSON válido."); }
  if (!v || typeof v !== "object" || v.esquema !== ESQUEMA || !Array.isArray(v.entradas) || !Number.isInteger(v.rev)) {
    throw new ErrorDatos("El historial no tiene el esquema esperado.");
  }
  return v;
}

export function crearAlmacenHistorial({
  almacen,
  bloqueo = bloqueoNavegador(),
  canal = canalPresencia(),
  ahora = () => new Date(),
} = {}) {
  if (!almacen) throw new Error("Falta el almacenamiento del historial.");

  // Respuesta a las comprobaciones de otras pestañas (alternativa sin Web Locks).
  if (canal) {
    canal.onmessage = (ev) => {
      if (ev.data?.tipo === "ping") canal.postMessage({ tipo: "pong", id: ev.data.id });
    };
  }

  let modoPromesa = null;
  // "web-locks" | "presencia" | "sin-garantia". Se decide una vez, antes de cualquier operación.
  function modo() {
    if (!modoPromesa) {
      modoPromesa = (async () => {
        if (bloqueo && await bloqueo.probar()) return "web-locks";
        if (canal) return "presencia";
        return "sin-garantia";
      })();
    }
    return modoPromesa;
  }

  // Alternativa: pregunta a las otras pestañas si hay alguna abierta.
  function otraPestanaActiva() {
    if (!canal) return Promise.resolve(false);
    const id = Math.random().toString(36).slice(2);
    let encontrada = false;
    return new Promise((resolver) => {
      const escuchar = (ev) => {
        if (ev.data?.tipo === "pong" && ev.data.id === id) encontrada = true;
      };
      canal.addEventListener("message", escuchar);
      canal.postMessage({ tipo: "ping", id });
      setTimeout(() => {
        canal.removeEventListener("message", escuchar);
        resolver(encontrada);
      }, ESPERA_PRESENCIA_MS);
    });
  }

  function leerClave(clave) {
    try { return almacen.getItem(clave); } catch {
      throw new ErrorDatos("No se puede acceder al almacenamiento de este navegador.");
    }
  }

  // Escribe el historial completo en una sola operación y verifica que quedó igual.
  function escribir(revAnterior, entradas) {
    const texto = JSON.stringify({ esquema: ESQUEMA, rev: revAnterior + 1, entradas });
    try {
      almacen.setItem(CLAVE_V2, texto);
    } catch (e) {
      if (esErrorCuota(e)) throw new ErrorCuota("El almacenamiento del navegador está lleno.");
      throw new ErrorEscritura("No se pudo escribir el historial.");
    }
    let verificado = null;
    try { verificado = almacen.getItem(CLAVE_V2); } catch { verificado = null; }
    if (verificado !== texto) {
      throw new ErrorEscritura("La escritura no se pudo verificar. El historial anterior se conserva.");
    }
    return revAnterior + 1;
  }

  // Lee el estado actual. Migra el formato anterior o fusiona registros que aparezcan
  // solo en él. Debe ejecutarse bajo la protección de la modalidad activa.
  function sincronizar(permitirEscritura) {
    const avisos = [];
    const escribirSiPermitido = (rev, entradas) => {
      if (!permitirEscritura) throw new ErrorEscritura("Solo lectura en esta pestaña.");
      return escribir(rev, entradas);
    };
    const rawV2 = leerClave(CLAVE_V2);
    const rawLegado = leerClave(CLAVE_LEGADO);

    if (rawV2 !== null) {
      let v2;
      try { v2 = parsearV2(rawV2); } catch (e) {
        return {
          modo: "solo-lectura", rev: null, entradas: legadoSeguro(rawLegado),
          avisos: [`${e.message} El historial se muestra sin cambios y no se modificará para protegerlo.`],
        };
      }
      // Fusión por contenido: un registro del formato anterior se añade solo si no está ya en v2.
      const disponibles = new Map();
      for (const e of v2.entradas.filter(objetoConId)) {
        const c = canonico(e);
        disponibles.set(c, (disponibles.get(c) ?? 0) + 1);
      }
      const nuevas = [];
      for (const e of legadoSeguro(rawLegado).filter(objetoConId)) {
        const c = canonico(e);
        if ((disponibles.get(c) ?? 0) > 0) disponibles.set(c, disponibles.get(c) - 1);
        else nuevas.push(normalizar(e));
      }
      let entradas = v2.entradas;
      let rev = v2.rev;
      if (nuevas.length) {
        const fusion = [...v2.entradas, ...nuevas];
        try {
          rev = escribirSiPermitido(v2.rev, fusion);
          entradas = fusion;
        } catch (e) {
          entradas = fusion;
          avisos.push(`Registros del formato anterior aún no fusionados (${e.message}). Ningún registro se perdió.`);
        }
      }
      return { modo: "listo", rev, entradas, avisos: avisos.concat(avisoRepetidos(entradas)) };
    }

    let legado;
    try { legado = parsearLegado(rawLegado); } catch (e) {
      return { modo: "bloqueado", rev: null, entradas: [], avisos: [`${e.message} No se modificó nada.`] };
    }
    if (legado.length === 0) return { modo: "listo", rev: 0, entradas: [], avisos: [] };

    const entradas = legado.map(normalizar);
    try {
      return { modo: "listo", rev: escribirSiPermitido(0, entradas), entradas, migrado: true, avisos: avisoRepetidos(entradas) };
    } catch (e) {
      // El formato anterior sigue intacto; se volverá a intentar en la siguiente operación.
      return {
        modo: "legado", rev: 0, entradas,
        avisos: [`No se pudo migrar el historial (${e.message}). Se sigue usando el formato anterior; no se pierde nada.`],
      };
    }
  }

  function avisoRepetidos(entradas) {
    const repetidos = identificadoresRepetidos(entradas);
    return repetidos.length
      ? [`Hay ${repetidos.length} identificador(es) repetido(s). Cada comparación se muestra y se gestiona por separado.`]
      : [];
  }

  // Ejecuta una transformación con la protección adecuada y escribe solo si hubo cambios.
  async function operar(transformar) {
    const m = await modo();
    if (m === "sin-garantia") throw new ErrorEscritura(MENSAJE_SIN_GARANTIA);
    if (m === "presencia" && await otraPestanaActiva()) throw new ErrorEscritura(MENSAJE_OTRA_PESTANA);
    const ejecutar = () => {
      const s = sincronizar(true);
      if (s.modo === "bloqueado" || s.modo === "solo-lectura") throw new ErrorDatos(s.avisos[0]);
      const { entradas, resultado } = transformar(s.entradas);
      if (entradas !== s.entradas) escribir(s.rev ?? 0, entradas);
      return resultado;
    };
    return m === "web-locks" ? bloqueo.ejecutar(ejecutar) : ejecutar();
  }

  function resultadoLectura(s, m) {
    const claves = calcularClaves(s.entradas);
    return {
      modo: s.modo,
      modoGarantia: m,
      entradas: s.entradas,
      registros: s.entradas.map((entrada, i) => ({ clave: claves[i], entrada, indice: i })),
      avisos: s.avisos,
      migrado: Boolean(s.migrado),
    };
  }

  const api = {
    // Modalidad efectiva: "web-locks", "presencia" o "sin-garantia".
    modoActual: modo,

    // Lectura de registros con clave. Migra o fusiona solo cuando puede escribir con garantía.
    async leer() {
      const m = await modo();
      if (m === "web-locks") return bloqueo.ejecutar(() => resultadoLectura(sincronizar(true), m));
      if (m === "presencia") {
        // Con otra pestaña abierta se lee sin escribir, para no competir por el historial.
        if (await otraPestanaActiva()) {
          const s = sincronizar(false);
          const r = resultadoLectura(s, m);
          r.avisos = [...r.avisos, "Otra pestaña está abierta: el historial se muestra sin cambios hasta que la cierre."];
          return r;
        }
        return resultadoLectura(sincronizar(true), m);
      }
      // Sin garantía: se lee, pero no se migra ni se fusiona.
      return resultadoLectura(sincronizar(false), m);
    },

    async agregar(entrada) {
      return operar((entradas) => {
        if (entradas.some((e) => objetoConId(e) && e.id === entrada.id)) {
          throw new Error("Ya existe una comparación con ese identificador.");
        }
        return {
          entradas: [{ ...entrada, estado: ESTADO.ACTIVO }, ...entradas],
          resultado: entrada.id,
        };
      });
    },

    // Cambia el estado de registros indicados por CLAVE. Solo modifica `estado` y `archivadoEn`.
    async cambiarEstado(claves, estado) {
      if (!Object.values(ESTADO).includes(estado)) throw new Error("Estado no válido.");
      const pedidas = [...new Set(claves)];
      return operar((entradas) => {
        const instante = ahora().toISOString();
        const clavesActuales = calcularClaves(entradas);
        const cambiadas = [];
        const sinCambio = [];
        const nuevas = entradas.map((e, i) => {
          const clave = clavesActuales[i];
          if (clave === null || !pedidas.includes(clave)) return e;
          if (estadoDe(e) === estado) {
            sinCambio.push(clave);
            return e;
          }
          cambiadas.push(clave);
          const copia = { ...e, estado };
          if (estado === ESTADO.ARCHIVADO) copia.archivadoEn = instante;
          else delete copia.archivadoEn;
          return copia;
        });
        const noEncontradas = pedidas.filter((c) => !clavesActuales.includes(c));
        return {
          entradas: cambiadas.length ? nuevas : entradas,
          resultado: { cambiados: cambiadas, sinCambio, noEncontrados: noEncontradas },
        };
      });
    },

    // Uso aproximado de almacenamiento de todas las claves "comparador.*" del origen.
    uso() {
      try {
        let bytes = 0;
        for (let i = 0; i < almacen.length; i++) {
          const k = almacen.key(i);
          if (k && k.startsWith("comparador.")) bytes += (k.length + (almacen.getItem(k) ?? "").length) * 2;
        }
        return { bytes, supera: bytes >= UMBRAL_AVISO_BYTES };
      } catch {
        return null;
      }
    },

    // Copia de seguridad en JSON. No modifica nada.
    async exportar() {
      const r = await api.leer();
      return JSON.stringify({
        formato: "comparador-historial",
        esquema: ESQUEMA,
        exportado: ahora().toISOString(),
        entradas: r.entradas,
      }, null, 2);
    },

    cerrar() {
      if (canal) canal.close();
    },
  };
  return api;
}
