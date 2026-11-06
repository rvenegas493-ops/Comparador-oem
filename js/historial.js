// Historial de comparaciones: almacenamiento con estados `active` y `archived`.
//
// Reglas de seguridad (detalladas en docs/HISTORIAL.md):
// - Ninguna operación borra registros. Archivar y restaurar solo cambian `estado`
//   y `archivadoEn`. Restaurar quita `archivadoEn`, así que el registro vuelve idéntico.
// - Las lecturas y escrituras se hacen dentro de un bloqueo exclusivo entre pestañas
//   (Web Locks). Un contador de revisión en localStorage NO se usa como garantía de atomicidad.
// - Cada escritura se verifica releyendo el valor guardado.
// - Si el formato actual no se puede leer, el historial pasa a solo lectura y no se modifica.
// - El formato anterior (clave `comparador.historial`, un array JSON de 1.3.0 y 1.3.1)
//   nunca se borra ni se sobrescribe. Se migra copiando, y luego se fusiona por identificador.
//
// Sin dependencias de la interfaz: todo entra por parámetros, para poder probarlo en Node.

export const CLAVE_LEGADO = "comparador.historial";
export const CLAVE_V2 = "comparador.historial.v2";
const NOMBRE_BLOQUEO = "comparador.historial";
const ESQUEMA = 2;

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

// Bloqueo entre pestañas. Devuelve null si el navegador no admite Web Locks.
export function bloqueoNavegador(global = globalThis) {
  const locks = global.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return null;
  return { ejecutar: (fn) => locks.request(NOMBRE_BLOQUEO, { mode: "exclusive" }, fn) };
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

export function crearAlmacenHistorial({ almacen, bloqueo = bloqueoNavegador(), ahora = () => new Date() } = {}) {
  if (!almacen) throw new Error("Falta el almacenamiento del historial.");
  const conBloqueo = (fn) => (bloqueo ? bloqueo.ejecutar(fn) : fn());
  const bloqueoActivo = Boolean(bloqueo);

  function leerClave(clave) {
    try { return almacen.getItem(clave); } catch {
      throw new ErrorDatos("No se puede acceder al almacenamiento de este navegador.");
    }
  }

  // Escribe el historial completo en una sola operación y verifica que quedó igual.
  // Una escritura de localStorage reemplaza el valor entero o no cambia nada.
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
      throw new ErrorEscritura("La escritura no se pudo verificar. Es posible que otra pestaña haya cambiado el historial.");
    }
    return revAnterior + 1;
  }

  // Lee el estado actual. Migra el formato anterior o fusiona registros que aparezcan
  // solo en él (por ejemplo, desde una pestaña 1.3.x que siga abierta).
  // Debe ejecutarse dentro del bloqueo.
  function sincronizar() {
    const rawV2 = leerClave(CLAVE_V2);
    const rawLegado = leerClave(CLAVE_LEGADO);

    if (rawV2 !== null) {
      let v2;
      try { v2 = parsearV2(rawV2); } catch (e) {
        return {
          modo: "solo-lectura", rev: null, entradas: legadoSeguro(rawLegado),
          aviso: `${e.message} El historial se muestra sin cambios y no se modificará para protegerlo.`,
        };
      }
      const ids = new Set(v2.entradas.filter(objetoConId).map((e) => e.id));
      const nuevas = legadoSeguro(rawLegado)
        .filter((e) => objetoConId(e) && !ids.has(e.id))
        .map(normalizar);
      if (nuevas.length === 0) return { modo: "listo", rev: v2.rev, entradas: v2.entradas };
      const fusion = [...v2.entradas, ...nuevas];
      try {
        return { modo: "listo", rev: escribir(v2.rev, fusion), entradas: fusion };
      } catch (e) {
        // La fusión no se guardó, pero el formato anterior conserva esos registros.
        return {
          modo: "listo", rev: v2.rev, entradas: fusion,
          aviso: `No se pudo guardar la fusión con el formato anterior (${e.message}). Ningún registro se perdió.`,
        };
      }
    }

    let legado;
    try { legado = parsearLegado(rawLegado); } catch (e) {
      return { modo: "bloqueado", rev: null, entradas: [], aviso: `${e.message} No se modificó nada.` };
    }
    if (legado.length === 0) return { modo: "listo", rev: 0, entradas: [] };

    const entradas = legado.map(normalizar);
    try {
      return { modo: "listo", rev: escribir(0, entradas), entradas, migrado: true };
    } catch (e) {
      // El formato anterior sigue intacto; se volverá a intentar en la siguiente operación.
      return {
        modo: "legado", rev: 0, entradas,
        aviso: `No se pudo migrar el historial (${e.message}). Se sigue usando el formato anterior; no se pierde nada.`,
      };
    }
  }

  // Ejecuta una transformación dentro del bloqueo y escribe solo si hubo cambios.
  function operar(transformar) {
    return conBloqueo(() => {
      const s = sincronizar();
      if (s.modo === "bloqueado" || s.modo === "solo-lectura") throw new ErrorDatos(s.aviso);
      const { entradas, resultado } = transformar(s.entradas);
      if (entradas !== s.entradas) escribir(s.rev ?? 0, entradas);
      return resultado;
    });
  }

  return {
    bloqueoActivo,

    leer() {
      return conBloqueo(() => {
        const s = sincronizar();
        return { modo: s.modo, entradas: s.entradas, aviso: s.aviso ?? null, migrado: Boolean(s.migrado) };
      });
    },

    agregar(entrada) {
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

    // Cambia el estado de varios registros. Solo modifica `estado` y `archivadoEn`.
    cambiarEstado(ids, estado) {
      if (!Object.values(ESTADO).includes(estado)) throw new Error("Estado no válido.");
      const pedidos = new Set(ids);
      return operar((entradas) => {
        const instante = ahora().toISOString();
        const cambiados = [];
        const sinCambio = [];
        const nuevas = entradas.map((e) => {
          if (!objetoConId(e) || !pedidos.has(e.id)) return e;
          if (estadoDe(e) === estado) {
            if (!sinCambio.includes(e.id)) sinCambio.push(e.id);
            return e;
          }
          if (!cambiados.includes(e.id)) cambiados.push(e.id);
          const copia = { ...e, estado };
          if (estado === ESTADO.ARCHIVADO) copia.archivadoEn = instante;
          else delete copia.archivadoEn;
          return copia;
        });
        const existentes = new Set(entradas.filter(objetoConId).map((e) => e.id));
        const noEncontrados = [...pedidos].filter((id) => !existentes.has(id));
        return {
          entradas: cambiados.length ? nuevas : entradas,
          resultado: { cambiados, sinCambio, noEncontrados },
        };
      });
    },
  };
}
