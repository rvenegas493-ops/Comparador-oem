// Pruebas del historial con ciclo de vida: migración, reversibilidad, claves por registro,
// identificadores repetidos, cuota, verificación de escritura, datos dañados, fusión,
// modalidades de garantía (Web Locks, alternativa de presencia y sin garantía), uso y exportación.
// Solo datos sintéticos. Sin navegador: almacenamiento y bloqueo simulados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  crearAlmacenHistorial, bloqueoNavegador, esErrorCuota, estadoDe, calcularClaves,
  identificadoresRepetidos, UMBRAL_AVISO_BYTES, MENSAJE_SIN_GARANTIA, MENSAJE_OTRA_PESTANA,
  CLAVE_LEGADO, CLAVE_V2, ESTADO, ErrorCuota, ErrorDatos, ErrorEscritura,
} from "../../js/historial.js";

const RAIZ_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// ---------- Dobles de prueba ----------

function almacenFalso({ cuotaBytes = Infinity } = {}) {
  const datos = new Map();
  const almacen = {
    datos,
    fallarEscritura: null, // (clave, valor) => Error | null
    cuotaBytes,
    get length() { return datos.size; },
    key: (i) => [...datos.keys()][i] ?? null,
    getItem: (k) => (datos.has(k) ? datos.get(k) : null),
    setItem(k, v) {
      const err = almacen.fallarEscritura?.(k, v);
      if (err) throw err;
      const total = [...datos.entries()].filter(([c]) => c !== k).reduce((s, [, x]) => s + x.length, 0) + String(v).length;
      if (total > almacen.cuotaBytes) throw Object.assign(new Error("cuota"), { name: "QuotaExceededError" });
      datos.set(k, String(v));
    },
    removeItem: (k) => datos.delete(k),
  };
  return almacen;
}

// Bloqueo exclusivo con la misma semántica que navigator.locks: una tarea a la vez.
function bloqueoExclusivo({ disponible = true } = {}) {
  let cola = Promise.resolve();
  return {
    async probar() { return disponible; },
    ejecutar(fn) {
      const r = cola.then(() => fn());
      cola = r.catch(() => {});
      return r;
    },
  };
}

const MARKDOWN = "# Reporte\n\nValor \"A\" → 650 rpm, citas: `DEMO-DOC-01` §2.1.\nLínea con acentos: ralentí, año, ñ.\n";
function entradaLegada(i) {
  return {
    id: `176240000${i}-demo${i}abc`,
    fecha: `2026-11-0${i}T12:00:00.000Z`,
    a: { nombre: `A${i}.csv`, sha256: "a".repeat(63) + i },
    b: { nombre: `B${i}.csv`, sha256: "b".repeat(63) + i },
    d: { nombre: "diccionario.csv (ejemplo)", sha256: "d".repeat(63) + i },
    cambios: i, noComparables: 0, errores: 0,
    markdown: MARKDOWN + `Registro ${i}\n`,
  };
}
const legado3 = () => [entradaLegada(3), entradaLegada(2), entradaLegada(1)];

function almacenConLegado(lista = legado3(), opciones = {}) {
  const almacen = almacenFalso(opciones);
  almacen.datos.set(CLAVE_LEGADO, JSON.stringify(lista));
  return almacen;
}

const FECHA_FIJA = new Date("2026-11-06T15:00:00Z");
const crear = (almacen, extra = {}) =>
  crearAlmacenHistorial({ almacen, bloqueo: bloqueoExclusivo(), canal: null, ahora: () => FECHA_FIJA, ...extra });

// Claves de los registros, en el orden que devuelve leer().
const clavesDe = (r) => r.registros.map((x) => x.clave);

// ---------- Migración y compatibilidad ----------

test("migra un historial 1.3.x sin modificar ningún registro", async () => {
  const lista = legado3();
  const almacen = almacenConLegado(lista);
  const antes = almacen.datos.get(CLAVE_LEGADO);
  const s = await crear(almacen).leer();
  assert.equal(s.modo, "listo");
  assert.equal(s.migrado, true);
  assert.equal(s.entradas.length, 3);
  s.entradas.forEach((e, i) => assert.deepEqual(e, { ...lista[i], estado: ESTADO.ACTIVO }));
  assert.equal(almacen.datos.get(CLAVE_LEGADO), antes, "el formato anterior no se toca");
  assert.ok(almacen.datos.has(CLAVE_V2));
});

test("sin historial previo no crea ningún dato", async () => {
  const almacen = almacenFalso();
  const s = await crear(almacen).leer();
  assert.equal(s.modo, "listo");
  assert.deepEqual(s.entradas, []);
  assert.equal(almacen.datos.size, 0);
});

test("un historial anterior con formato no válido bloquea escrituras sin modificarlo", async () => {
  const almacen = almacenFalso();
  almacen.datos.set(CLAVE_LEGADO, "{no es un array");
  const alm = crear(almacen);
  const s = await alm.leer();
  assert.equal(s.modo, "bloqueado");
  await assert.rejects(() => alm.agregar(entradaLegada(9)), ErrorDatos);
  assert.equal(almacen.datos.get(CLAVE_LEGADO), "{no es un array");
  assert.equal(almacen.datos.has(CLAVE_V2), false);
});

test("una migración con cuota llena conserva el formato anterior y reintenta después", async () => {
  const lista = legado3();
  const almacen = almacenConLegado(lista, { cuotaBytes: 10 });
  const antes = almacen.datos.get(CLAVE_LEGADO);
  const alm = crear(almacen);
  const s1 = await alm.leer();
  assert.equal(s1.modo, "legado");
  assert.match(s1.avisos[0], /no se pierde nada/);
  assert.equal(s1.entradas.length, 3, "los registros siguen visibles");
  assert.equal(almacen.datos.get(CLAVE_LEGADO), antes);
  assert.equal(almacen.datos.has(CLAVE_V2), false, "ninguna migración parcial");

  almacen.cuotaBytes = Infinity;
  const s2 = await alm.leer();
  assert.equal(s2.modo, "listo");
  assert.equal(s2.migrado, true);
  assert.equal(s2.entradas.length, 3);
});

test("registros añadidos por una pestaña 1.3.x tras la migración se fusionan sin perder nada", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  await alm.leer();
  almacen.datos.set(CLAVE_LEGADO, JSON.stringify([entradaLegada(4), ...legado3()]));
  const s = await alm.leer();
  assert.equal(s.entradas.length, 4);
  assert.ok(s.entradas.some((e) => e.id === entradaLegada(4).id && e.estado === ESTADO.ACTIVO));
});

test("la fusión nunca elimina registros que el formato anterior ya no contiene", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  await alm.leer();
  almacen.datos.set(CLAVE_LEGADO, JSON.stringify([]));
  const s = await alm.leer();
  assert.equal(s.entradas.length, 3);
});

test("la fusión no repite registros ya presentes en el formato nuevo", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  await alm.leer();
  await alm.cambiarEstado(clavesDe(await alm.leer()).slice(0, 1), ESTADO.ARCHIVADO);
  const s = await alm.leer();
  assert.equal(s.entradas.length, 3, "un registro archivado no se duplica al fusionar");
});

// ---------- Identificadores repetidos: cada registro tiene su clave ----------

test("dos registros con el mismo identificador y contenido distinto tienen claves distintas", async () => {
  const a = entradaLegada(1);
  const b = { ...entradaLegada(1), markdown: "# Otro reporte con el mismo identificador\n" };
  const alm = crear(almacenConLegado([a, b]));
  const s = await alm.leer();
  const claves = clavesDe(s);
  assert.equal(new Set(claves).size, 2);
  assert.deepEqual(identificadoresRepetidos(s.entradas), [a.id]);
  assert.ok(s.avisos.some((m) => /repetido/.test(m)), "el técnico recibe el aviso");
});

test("archivar una clave con identificador repetido no afecta al otro registro", async () => {
  const a = entradaLegada(1);
  const b = { ...entradaLegada(1), markdown: "# Otro reporte\n" };
  const alm = crear(almacenConLegado([a, b]));
  const claves = clavesDe(await alm.leer());
  await alm.cambiarEstado([claves[0]], ESTADO.ARCHIVADO);
  const s = await alm.leer();
  assert.equal(estadoDe(s.entradas[0]), ESTADO.ARCHIVADO);
  assert.equal(estadoDe(s.entradas[1]), ESTADO.ACTIVO, "el registro hermano sigue activo");
  assert.equal(s.entradas[1].markdown, b.markdown);
});

test("un identificador repetido sin clave no coincide con ningún registro", async () => {
  const a = entradaLegada(1);
  const b = { ...entradaLegada(1), markdown: "# Otro\n" };
  const alm = crear(almacenConLegado([a, b]));
  const r = await alm.cambiarEstado([a.id], ESTADO.ARCHIVADO);
  assert.deepEqual(r.cambiados, []);
  assert.deepEqual(r.noEncontrados, [a.id]);
  assert.ok((await alm.leer()).entradas.every((e) => estadoDe(e) === ESTADO.ACTIVO));
});

test("dos registros idénticos reciben claves distintas: archivar uno no archiva el otro", async () => {
  const a = entradaLegada(1);
  const alm = crear(almacenConLegado([a, { ...a }]));
  const claves = clavesDe(await alm.leer());
  assert.equal(new Set(claves).size, 2);
  await alm.cambiarEstado([claves[1]], ESTADO.ARCHIVADO);
  const s = await alm.leer();
  assert.deepEqual(s.entradas.map(estadoDe), [ESTADO.ACTIVO, ESTADO.ARCHIVADO]);
});

test("la clave no cambia al archivar ni al restaurar", async () => {
  const alm = crear(almacenConLegado(legado3()));
  const antes = clavesDe(await alm.leer());
  await alm.cambiarEstado([antes[0]], ESTADO.ARCHIVADO);
  assert.deepEqual(clavesDe(await alm.leer()), antes);
  await alm.cambiarEstado([antes[0]], ESTADO.ACTIVO);
  assert.deepEqual(clavesDe(await alm.leer()), antes);
});

test("calcularClaves es determinista y no depende del estado", () => {
  const e = entradaLegada(2);
  const c1 = calcularClaves([e]);
  const c2 = calcularClaves([{ ...e, estado: ESTADO.ARCHIVADO, archivadoEn: "2026-11-06T00:00:00.000Z" }]);
  assert.deepEqual(c1, c2);
  assert.equal(calcularClaves([null, { sinId: true }])[0], null);
});

// ---------- Estados: archivar y restaurar ----------

test("archivar y restaurar es reversible: el registro vuelve idéntico al original", async () => {
  const lista = legado3();
  const almacen = almacenConLegado(lista);
  const alm = crear(almacen);
  const original = (await alm.leer()).entradas.find((e) => e.id === lista[0].id);
  const clave = clavesDe(await alm.leer())[0];
  await alm.cambiarEstado([clave], ESTADO.ARCHIVADO);
  const archivada = (await alm.leer()).entradas.find((e) => e.id === lista[0].id);
  assert.equal(archivada.estado, ESTADO.ARCHIVADO);
  assert.equal(archivada.archivadoEn, "2026-11-06T15:00:00.000Z");
  assert.equal(archivada.markdown, lista[0].markdown);
  await alm.cambiarEstado([clave], ESTADO.ACTIVO);
  const restaurada = (await alm.leer()).entradas.find((e) => e.id === lista[0].id);
  assert.deepEqual(restaurada, original);
});

test("archivar solo cambia el registro indicado; los demás quedan byte a byte iguales", async () => {
  const lista = legado3();
  const alm = crear(almacenConLegado(lista));
  const claves = clavesDe(await alm.leer());
  await alm.cambiarEstado([claves[1]], ESTADO.ARCHIVADO);
  const s = await alm.leer();
  assert.equal(JSON.stringify(s.entradas[0]), JSON.stringify({ ...lista[0], estado: ESTADO.ACTIVO }));
  assert.equal(JSON.stringify(s.entradas[2]), JSON.stringify({ ...lista[2], estado: ESTADO.ACTIVO }));
});

test("selección múltiple: archiva solo las claves indicadas y reporta las que no cambian", async () => {
  const alm = crear(almacenConLegado(legado3()));
  const claves = clavesDe(await alm.leer());
  const r1 = await alm.cambiarEstado([claves[0], claves[2]], ESTADO.ARCHIVADO);
  assert.deepEqual(r1.cambiados.sort(), [claves[0], claves[2]].sort());
  const r2 = await alm.cambiarEstado([claves[0], "no-existe"], ESTADO.ARCHIVADO);
  assert.deepEqual(r2.cambiados, []);
  assert.deepEqual(r2.sinCambio, [claves[0]]);
  assert.deepEqual(r2.noEncontrados, ["no-existe"]);
  const s = await alm.leer();
  assert.equal(s.entradas.filter((e) => estadoDe(e) === ESTADO.ARCHIVADO).length, 2);
});

test("una operación sin cambios no escribe en el almacenamiento", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  const claves = clavesDe(await alm.leer());
  const antes = almacen.datos.get(CLAVE_V2);
  await alm.cambiarEstado([claves[0]], ESTADO.ACTIVO);
  assert.equal(almacen.datos.get(CLAVE_V2), antes);
});

test("estado no válido se rechaza sin tocar los datos", async () => {
  const alm = crear(almacenConLegado(legado3()));
  await alm.leer();
  await assert.rejects(() => alm.cambiarEstado(["x"], "borrado"), /Estado no válido/);
});

// ---------- Alta, cuota y escritura verificada ----------

test("agregar pone la comparación nueva al principio sin descartar ninguna", async () => {
  const alm = crear(almacenConLegado(legado3()));
  await alm.leer();
  await alm.agregar(entradaLegada(7));
  const s = await alm.leer();
  assert.equal(s.entradas.length, 4);
  assert.equal(s.entradas[0].id, entradaLegada(7).id);
});

test("cuota llena: se informa el error y el historial queda exactamente como estaba", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  await alm.leer();
  const antesV2 = almacen.datos.get(CLAVE_V2);
  almacen.cuotaBytes = antesV2.length + 5;
  await assert.rejects(() => alm.agregar(entradaLegada(8)), ErrorCuota);
  assert.equal(almacen.datos.get(CLAVE_V2), antesV2);
  assert.equal((await alm.leer()).entradas.length, 3, "no se descarta ningún registro antiguo");
});

test("un fallo de escritura no genérico se reporta como ErrorEscritura sin cambiar el estado", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  await alm.leer();
  const antes = almacen.datos.get(CLAVE_V2);
  almacen.fallarEscritura = (k) => (k === CLAVE_V2 ? new Error("disco") : null);
  await assert.rejects(() => alm.agregar(entradaLegada(8)), ErrorEscritura);
  assert.equal(almacen.datos.get(CLAVE_V2), antes);
});

test("si la lectura posterior no coincide con lo escrito, se reporta como fallo de escritura", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crear(almacen);
  await alm.leer();
  const real = almacen.getItem;
  almacen.getItem = (k) => (k === CLAVE_V2 ? '{"esquema":2,"rev":999,"entradas":[]}' : real(k));
  await assert.rejects(() => alm.agregar(entradaLegada(8)), ErrorEscritura);
});

test("reconoce los nombres y códigos de error de cuota de los distintos navegadores", () => {
  assert.equal(esErrorCuota({ name: "QuotaExceededError" }), true);
  assert.equal(esErrorCuota({ name: "NS_ERROR_DOM_QUOTA_REACHED" }), true);
  assert.equal(esErrorCuota({ code: 22 }), true);
  assert.equal(esErrorCuota({ code: 1014 }), true);
  assert.equal(esErrorCuota(new Error("otro")), false);
  assert.equal(esErrorCuota(null), false);
});

test("agregar una comparación con identificador repetido se rechaza sin duplicarla", async () => {
  const alm = crear(almacenConLegado(legado3()));
  await alm.leer();
  await assert.rejects(() => alm.agregar(entradaLegada(3)), /Ya existe/);
  assert.equal((await alm.leer()).entradas.length, 3);
});

// ---------- Datos ilegibles: protección ----------

test("un historial actual dañado pasa a solo lectura y no se sobrescribe", async () => {
  const almacen = almacenConLegado(legado3());
  almacen.datos.set(CLAVE_V2, "{roto");
  const alm = crear(almacen);
  const s = await alm.leer();
  assert.equal(s.modo, "solo-lectura");
  assert.equal(almacen.datos.get(CLAVE_V2), "{roto");
  await assert.rejects(() => alm.agregar(entradaLegada(9)), ErrorDatos);
  await assert.rejects(() => alm.cambiarEstado([clavesDe(s)[0] ?? "x"], ESTADO.ARCHIVADO), ErrorDatos);
  assert.equal(almacen.datos.get(CLAVE_V2), "{roto");
});

test("un historial con esquema desconocido no se sobrescribe", async () => {
  const almacen = almacenFalso();
  almacen.datos.set(CLAVE_V2, JSON.stringify({ esquema: 99, rev: 1, entradas: [] }));
  const alm = crear(almacen);
  await assert.rejects(() => alm.agregar(entradaLegada(9)), ErrorDatos);
  assert.equal(JSON.parse(almacen.datos.get(CLAVE_V2)).esquema, 99);
});

test("registros sin identificador se conservan y no se muestran como válidos", async () => {
  const lista = [...legado3(), { sinId: true }];
  const alm = crear(almacenConLegado(lista));
  const s = await alm.leer();
  assert.equal(s.entradas.length, 4, "nada se elimina");
  assert.equal(s.registros.filter((r) => r.clave !== null).length, 3);
});

// ---------- Concurrencia y modalidades de garantía ----------

test("dos pestañas que escriben a la vez con bloqueo no pierden registros", async () => {
  const almacen = almacenFalso();
  const bloqueo = bloqueoExclusivo();
  const pestanaA = crearAlmacenHistorial({ almacen, bloqueo, canal: null });
  const pestanaB = crearAlmacenHistorial({ almacen, bloqueo, canal: null });
  const tareas = [];
  for (let i = 0; i < 25; i++) {
    tareas.push(pestanaA.agregar({ ...entradaLegada(1), id: `A-${i}` }));
    tareas.push(pestanaB.agregar({ ...entradaLegada(2), id: `B-${i}` }));
  }
  await Promise.all(tareas);
  const s = await pestanaA.leer();
  assert.equal(s.entradas.length, 50);
  assert.equal(new Set(s.entradas.map((e) => e.id)).size, 50, "sin identificadores duplicados");
});

test("archivar y agregar en dos pestañas a la vez no pierden ni modifican registros", async () => {
  const lista = legado3();
  const almacen = almacenConLegado(lista);
  const bloqueo = bloqueoExclusivo();
  const pestanaA = crearAlmacenHistorial({ almacen, bloqueo, canal: null });
  const pestanaB = crearAlmacenHistorial({ almacen, bloqueo, canal: null });
  const claves = clavesDe(await pestanaA.leer());
  await Promise.all([
    pestanaA.cambiarEstado([claves[0]], ESTADO.ARCHIVADO),
    pestanaB.agregar(entradaLegada(5)),
    pestanaA.cambiarEstado([claves[1]], ESTADO.ARCHIVADO),
    pestanaB.agregar(entradaLegada(6)),
  ]);
  const s = await pestanaA.leer();
  assert.equal(s.entradas.length, 5);
  assert.equal(s.entradas.filter((e) => estadoDe(e) === ESTADO.ARCHIVADO).length, 2);
});

test("cada lectura y cada escritura se ejecutan dentro del bloqueo exclusivo", async () => {
  const base = bloqueoExclusivo();
  let llamadas = 0;
  const espia = { probar: base.probar, ejecutar: (fn) => { llamadas++; return base.ejecutar(fn); } };
  const alm = crear(almacenConLegado(legado3()), { bloqueo: espia });
  await alm.leer();
  await alm.agregar(entradaLegada(7));
  await alm.cambiarEstado([clavesDe(await alm.leer())[0]], ESTADO.ARCHIVADO);
  assert.equal(llamadas, 4); // dos lecturas y dos operaciones, todas bajo el bloqueo
});

test("sin Web Locks ni alternativa, las escrituras se rechazan con un mensaje claro y las lecturas siguen", async () => {
  const almacen = almacenConLegado(legado3());
  const alm = crearAlmacenHistorial({ almacen, bloqueo: null, canal: null, ahora: () => FECHA_FIJA });
  assert.equal(await alm.modoActual(), "sin-garantia");
  await assert.rejects(() => alm.agregar(entradaLegada(9)), (e) => e instanceof ErrorEscritura && e.message === MENSAJE_SIN_GARANTIA);
  assert.equal(almacen.datos.has(CLAVE_V2), false, "no se migra ni escribe sin garantía");
  const s = await alm.leer();
  assert.equal(s.entradas.length, 3, "las lecturas siguen funcionando");
});

test("si la API de Web Locks existe pero no responde, se usa la alternativa, no se asume el bloqueo", async () => {
  const roto = { probar: async () => false, ejecutar: () => { throw new Error("no debe usarse"); } };
  const alm = crearAlmacenHistorial({ almacen: almacenFalso(), bloqueo: roto, canal: null });
  assert.equal(await alm.modoActual(), "sin-garantia");
});

test("bloqueoNavegador devuelve null cuando el navegador no tiene Web Locks", async () => {
  assert.equal(bloqueoNavegador({ navigator: {} }), null);
  assert.equal(bloqueoNavegador({}), null);
  const b = bloqueoNavegador({ navigator: { locks: { request: async (n, o, f) => f(null) } } });
  assert.equal(typeof b.ejecutar, "function");
  assert.equal(await b.probar(), true);
  const roto = bloqueoNavegador({ navigator: { locks: { request: async () => { throw new Error("x"); } } } });
  assert.equal(await roto.probar(), false);
});

test("alternativa de presencia: con otra pestaña abierta la escritura se rechaza y al cerrarla vuelve a funcionar", async () => {
  const { BroadcastChannel } = await import("node:worker_threads");
  const almacen = almacenConLegado(legado3());
  // Dos instancias de la aplicación: cada una escucha y responde a las comprobaciones de la otra.
  const canalA = new BroadcastChannel("comparador.historial.presencia");
  const canalB = new BroadcastChannel("comparador.historial.presencia");
  const pestanaA = crearAlmacenHistorial({ almacen, bloqueo: null, canal: canalA, ahora: () => FECHA_FIJA });
  const pestanaB = crearAlmacenHistorial({ almacen, bloqueo: null, canal: canalB, ahora: () => FECHA_FIJA });
  try {
    assert.equal(await pestanaA.modoActual(), "presencia");
    await assert.rejects(() => pestanaA.agregar(entradaLegada(9)), (e) => e instanceof ErrorEscritura && e.message === MENSAJE_OTRA_PESTANA);
    assert.equal(almacen.datos.has(CLAVE_V2), false, "con otra pestaña abierta no se migra");
    pestanaB.cerrar();
    await pestanaA.agregar(entradaLegada(9));
    assert.equal((await pestanaA.leer()).entradas.length, 4);
  } finally {
    pestanaA.cerrar();
    canalB.close();
  }
});

test("sin Web Locks ni canal, las comprobaciones de la alternativa no bloquean la lectura", async () => {
  const alm = crearAlmacenHistorial({ almacen: almacenConLegado(legado3()), bloqueo: null, canal: null });
  const s = await alm.leer();
  assert.equal(s.modoGarantia, "sin-garantia");
  assert.equal(s.entradas.length, 3);
});

// ---------- Uso y exportación ----------

test("uso() estima los bytes del origen y avisa al superar el umbral", async () => {
  const pequeno = crear(almacenConLegado(legado3()));
  await pequeno.leer();
  const u = pequeno.uso();
  assert.ok(u.bytes > 0);
  assert.equal(u.supera, false);

  const grande = almacenConLegado(legado3());
  grande.datos.set("comparador.relleno", "x".repeat(UMBRAL_AVISO_BYTES / 2 + 10));
  assert.equal(crear(grande).uso().supera, true);
});

test("exportar devuelve todos los registros en JSON sin modificar el almacenamiento", async () => {
  const lista = legado3();
  const almacen = almacenConLegado(lista);
  const alm = crear(almacen);
  const antes = almacen.datos.get(CLAVE_LEGADO);
  const json = JSON.parse(await alm.exportar());
  assert.equal(json.formato, "comparador-historial");
  assert.equal(json.entradas.length, 3);
  assert.equal(json.exportado, "2026-11-06T15:00:00.000Z");
  assert.equal(almacen.datos.get(CLAVE_LEGADO), antes);
});

// ---------- Historiales reales generados por las versiones publicadas ----------

for (const version of ["1_3_0", "1_3_1"]) {
  test(`migra el historial real de la versión ${version.replace(/_/g, ".")} sin pérdidas`, async () => {
    const real = JSON.parse(readFileSync(path.join(RAIZ_FIXTURES, `historial_${version}.json`), "utf-8"));
    assert.equal(real.length, 2, "la fixture contiene dos comparaciones reales");
    const almacen = almacenFalso();
    const crudo = JSON.stringify(real);
    almacen.datos.set(CLAVE_LEGADO, crudo);
    const alm = crear(almacen);

    const s = await alm.leer();
    assert.equal(s.modo, "listo");
    assert.equal(s.entradas.length, real.length);
    s.entradas.forEach((e, i) => {
      assert.deepEqual(e, { ...real[i], estado: ESTADO.ACTIVO });
      assert.equal(e.markdown, real[i].markdown, "markdown idéntico");
      assert.equal(e.a.sha256, real[i].a.sha256, "hash A idéntico");
    });
    assert.equal(almacen.datos.get(CLAVE_LEGADO), crudo, "el formato anterior no cambia");

    const claves = clavesDe(s);
    await alm.cambiarEstado(claves, ESTADO.ARCHIVADO);
    await alm.cambiarEstado(claves, ESTADO.ACTIVO);
    const final = (await alm.leer()).entradas;
    real.forEach((o, i) => assert.deepEqual(final[i], { ...o, estado: ESTADO.ACTIVO }));
  });
}
