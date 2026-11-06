#!/usr/bin/env python3
"""Prueba de extremo a extremo del ciclo de vida del historial en Chrome real.

Verifica con el navegador de verdad (no con dobles de prueba):
- migración de un historial 1.3.1 sin modificar el formato anterior;
- archivar, restaurar y selección múltiple con vista previa, sin borrar nada;
- concurrencia entre dos pestañas con Web Locks reales;
- cuota de almacenamiento llena: aviso al técnico y ningún registro perdido.

Solo datos sintéticos. Requisitos: playwright (Python) y Google Chrome o Chromium.
"""
import functools
import http.server
import json
import shutil
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

RAIZ = Path(__file__).resolve().parents[2]
WEB = RAIZ
CAPTURAS = RAIZ / "tests" / "e2e" / "capturas"
EJEMPLO = RAIZ / "ejemplo"
CLAVE_LEGADO = "comparador.historial"
CLAVE_V2 = "comparador.historial.v2"

fallos: list[str] = []


def comprobar(condicion: bool, mensaje: str):
    print(("OK   " if condicion else "FALLO ") + mensaje)
    if not condicion:
        fallos.append(mensaje)


def servir(puerto: int):
    class Silencioso(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Silencioso, directory=str(WEB))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", puerto), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def esperar_filas(pagina, n: int):
    pagina.wait_for_function(f"document.querySelectorAll('.fila-historial').length === {n}", timeout=10000)


def historial_1_3_1() -> list[dict]:
    """Entradas con el formato exacto que guardaban las versiones 1.3.0 y 1.3.1."""
    lista = []
    for i in (1, 2, 3):
        lista.append({
            "id": f"176240000{i}-seed{i}ab",
            "fecha": f"2026-11-0{i}T12:00:00.000Z",
            "a": {"nombre": f"A{i}.csv", "sha256": "a" * 63 + str(i)},
            "b": {"nombre": f"B{i}.csv", "sha256": "b" * 63 + str(i)},
            "d": {"nombre": "diccionario.csv (ejemplo)", "sha256": "d" * 63 + str(i)},
            "cambios": i, "noComparables": 0, "errores": 0,
            "markdown": f"# Reporte sintético {i}\n\nValor \"A\": 650 rpm · acentos: ralentí.\n",
        })
    return lista


# Siembra el historial anterior una sola vez por pestaña, antes de que cargue la app.
def script_sembrar(lista: list[dict]) -> str:
    return (
        "if (!sessionStorage.getItem('sembrado')) {"
        f"  localStorage.setItem('{CLAVE_LEGADO}', {json.dumps(json.dumps(lista))});"
        "  sessionStorage.setItem('sembrado', '1');"
        "}"
    )


# Simula QuotaExceededError solo para la clave nueva, cuando la prueba lo activa.
SCRIPT_CUOTA = (
    "const _setItem = Storage.prototype.setItem;"
    "Storage.prototype.setItem = function (k, v) {"
    f"  if (window.__cuotaLlena && k === '{CLAVE_V2}') {{"
    "    throw new DOMException('cuota llena (simulada)', 'QuotaExceededError');"
    "  }"
    "  return _setItem.call(this, k, v);"
    "};"
)


def escenario_migracion_y_estados(navegador, url, lista):
    print("\n== Migración, archivado y restauración ==")
    contexto = navegador.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                     is_mobile=True, has_touch=True, locale="es-MX")
    contexto.add_init_script(script_sembrar(lista))
    p = contexto.new_page()
    p.goto(url)
    p.wait_for_load_state("networkidle")
    legado_inicial = p.evaluate(f"localStorage.getItem('{CLAVE_LEGADO}')")

    p.click("nav.inferior >> text=Historial")
    p.wait_for_selector("#lista-historial .fila-historial")
    comprobar(p.locator(".fila-historial").count() == 3, "las 3 comparaciones 1.3.1 aparecen en Activos")
    comprobar(p.locator("#vista-historial >> text=Borrar").count() == 0, "no hay ninguna acción de borrado en la vista")

    v2 = p.evaluate(f"localStorage.getItem('{CLAVE_V2}') !== null")
    legado_tras = p.evaluate(f"localStorage.getItem('{CLAVE_LEGADO}')")
    comprobar(v2, "la migración crea el formato nuevo")
    comprobar(legado_tras == legado_inicial, "el formato 1.3.1 queda byte a byte intacto")

    # Archivar dos comparaciones con vista previa y confirmación.
    p.locator("[data-sel]").nth(0).check()
    p.locator("[data-sel]").nth(1).check()
    p.click("[data-accion=archivar]")
    p.wait_for_selector(".vista-previa")
    comprobar("se van a archivar 2" in p.inner_text(".vista-previa"), "la vista previa indica cuántas se archivarán")
    comprobar(p.locator(".fila-historial").count() == 3, "nada cambia antes de confirmar")
    p.click("[data-accion=confirmar]")
    p.wait_for_selector("#estado-historial:has-text('archivada')")
    esperar_filas(p, 1)
    comprobar(p.locator(".fila-historial").count() == 1, "Activos muestra solo la comparación no archivada")
    p.click("[data-filtro=archivados]")
    esperar_filas(p, 2)
    comprobar(p.locator(".fila-historial").count() == 2, "Archivados muestra las dos comparaciones archivadas")

    # El contenido archivado se conserva.
    contenido = p.evaluate(f"""(() => {{
      const v = JSON.parse(localStorage.getItem('{CLAVE_V2}')).entradas;
      const orig = JSON.parse(localStorage.getItem('{CLAVE_LEGADO}'));
      const archivadas = v.filter(x => x.estado === 'archived');
      const activas = v.filter(x => x.estado === 'active');
      const sinEstado = (x) => JSON.stringify({{...x, estado: undefined, archivadoEn: undefined}});
      const ok = archivadas.every(e => {{
        const o = orig.find(x => x.id === e.id);
        return o && e.archivadoEn && e.markdown === o.markdown && e.a.sha256 === o.a.sha256 && sinEstado(e) === sinEstado(o);
      }});
      const ok2 = activas.every(e => JSON.stringify(e) === JSON.stringify({{...orig.find(x => x.id === e.id), estado: 'active'}}));
      return ok && ok2 && archivadas.length === 2 && activas.length === 1;
    }})()""")
    comprobar(contenido, "archivar conserva markdown, hashes y metadatos de origen")

    # Restaurar una comparación desde su detalle y comprobar que vuelve idéntica.
    # Una restauración individual desde el detalle.
    p.locator(".fila-historial .item-historial").first.click()
    p.wait_for_selector("#hist-estado")
    p.click("#hist-estado")
    p.wait_for_selector("#estado-historial:has-text('restaurada a Activos')", timeout=5000)
    esperar_filas(p, 1)
    p.click("[data-filtro=archivados]")
    esperar_filas(p, 1)
    # Y una restauración múltiple con vista previa y confirmación para la que queda.
    p.locator("[data-sel]").nth(0).check()
    p.click("[data-accion=restaurar]")
    p.wait_for_selector(".vista-previa")
    comprobar("se van a restaurar 1" in p.inner_text(".vista-previa"), "vista previa de restauración múltiple")
    p.click("[data-accion=confirmar]")
    p.wait_for_selector("#estado-historial:has-text('restaurada(s)')")
    p.click("[data-filtro=todos]")
    esperar_filas(p, 3)
    restaurada = p.evaluate(f"""(() => {{
      const v = JSON.parse(localStorage.getItem('{CLAVE_V2}')).entradas;
      const orig = JSON.parse(localStorage.getItem('{CLAVE_LEGADO}'));
      return orig.every(o => JSON.stringify(v.find(x => x.id === o.id)) === JSON.stringify({{...o, estado: 'active'}}));
    }})()""")
    comprobar(restaurada, "restaurar devuelve cada registro exactamente igual al original")
    comprobar(p.evaluate(f"localStorage.getItem('{CLAVE_LEGADO}')") == legado_inicial, "el formato anterior sigue intacto")
    p.screenshot(path=str(CAPTURAS / "historial_ciclo.png"), full_page=True)
    contexto.close()


def escenario_dos_pestanas(navegador, url):
    print("\n== Concurrencia entre dos pestañas (Web Locks reales) ==")
    contexto = navegador.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, locale="es-MX")
    a = contexto.new_page()
    b = contexto.new_page()
    a.goto(url); b.goto(url)
    a.wait_for_load_state("networkidle"); b.wait_for_load_state("networkidle")

    script = """
      window.__fin = null; window.__errores = 0;
      (async () => {
        const m = await import('./js/historial.js');
        const alm = m.crearAlmacenHistorial({ almacen: localStorage });
        window.__bloqueo = await alm.modoActual();
        for (let i = 0; i < 25; i++) {
          try {
            await alm.agregar({ id: 'PREFIJO-' + i + '-' + Math.random().toString(36).slice(2),
              fecha: new Date().toISOString(), a: { nombre: 'x', sha256: '0' }, b: { nombre: 'y', sha256: '1' },
              d: { nombre: 'z', sha256: '2' }, cambios: 0, noComparables: 0, errores: 0, markdown: '# r' });
          } catch (e) { window.__errores++; }
        }
        window.__fin = true;
      })();
    """
    a.evaluate(script.replace("PREFIJO", "A"))
    b.evaluate(script.replace("PREFIJO", "B"))
    a.wait_for_function("window.__fin === true", timeout=60000)
    b.wait_for_function("window.__fin === true", timeout=60000)

    comprobar(a.evaluate("window.__bloqueo") == "web-locks", "Chrome usa Web Locks como garantía entre pestañas")
    comprobar(a.evaluate("window.__errores") + b.evaluate("window.__errores") == 0, "ninguna escritura concurrente falló")
    total = a.evaluate(f"JSON.parse(localStorage.getItem('{CLAVE_V2}')).entradas.length")
    ids = a.evaluate(f"JSON.parse(localStorage.getItem('{CLAVE_V2}')).entradas.map(e => e.id)")
    comprobar(total == 50, f"50 de 50 comparaciones guardadas desde dos pestañas ({total})")
    comprobar(len(set(ids)) == len(ids), "sin identificadores duplicados")
    contexto.close()


def escenario_cuota(navegador, url, lista):
    print("\n== Cuota de almacenamiento llena ==")
    contexto = navegador.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                     has_touch=True, locale="es-MX", accept_downloads=True)
    contexto.add_init_script(script_sembrar(lista))
    contexto.add_init_script(SCRIPT_CUOTA)
    contexto.add_init_script("window.__cuotaLlena = true")  # desde la carga, incluida la migración
    p = contexto.new_page()
    p.goto(url)
    p.wait_for_load_state("networkidle")
    legado_inicial = p.evaluate(f"localStorage.getItem('{CLAVE_LEGADO}')")
    comprobar(p.evaluate(f"localStorage.getItem('{CLAVE_V2}')") is None, "con la cuota llena, la migración no escribe nada")

    def comparar():
        p.check("#usar-ejemplo")
        p.set_input_files("#fa", str(EJEMPLO / "export_a.csv"))
        p.set_input_files("#fb", str(EJEMPLO / "export_b.csv"))
        p.click("#btn-comparar")
        p.wait_for_selector("#resultados .banner-no-verificado", timeout=15000)

    p.click("nav.inferior >> text=Comparar")
    comparar()
    p.wait_for_selector("#resultados .alerta-historial", timeout=5000)
    texto = p.inner_text("#resultados .alerta-historial")
    comprobar("No se guardó esta comparación" in texto, "con la cuota llena, el técnico ve un aviso claro")
    comprobar(p.locator("#resultados .banner-no-verificado").count() == 1, "el reporte sigue visible con el aviso")
    comprobar(p.evaluate(f"localStorage.getItem('{CLAVE_LEGADO}')") == legado_inicial, "el historial anterior no cambia")
    comprobar(p.evaluate(f"localStorage.getItem('{CLAVE_V2}')") is None, "no queda ninguna escritura parcial")

    p.evaluate("window.__cuotaLlena = false")
    p.evaluate("document.querySelector('#resultados').innerHTML = ''")  # evita leer el reporte anterior
    comparar()
    comprobar(p.locator("#resultados .alerta-historial").count() == 0, "sin cuota llena, la comparación se guarda sin aviso")
    p.click("nav.inferior >> text=Historial")
    esperar_filas(p, len(lista) + 1)
    comprobar(p.locator(".fila-historial").count() == len(lista) + 1,
              "al liberar espacio, la migración pendiente conserva las 3 anteriores y añade la nueva")
    contexto.close()


def escenario_duplicados_y_exportacion(navegador, url, lista):
    print("\n== Identificadores repetidos y exportación ==")
    duplicado = dict(lista[0], markdown="# Otro reporte con el mismo identificador\\n")
    sembrado = [lista[0], duplicado, lista[1]]
    contexto = navegador.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                     has_touch=True, locale="es-MX", accept_downloads=True)
    contexto.add_init_script(script_sembrar(sembrado))
    p = contexto.new_page()
    p.goto(url)
    p.wait_for_load_state("networkidle")
    p.click("nav.inferior >> text=Historial")
    esperar_filas(p, 3)
    comprobar("identificador(es) repetido" in p.inner_text("#lista-historial"), "el técnico ve el aviso de identificador repetido")
    comprobar(p.locator(".fila-historial").count() == 3, "los dos registros repetidos se muestran por separado")

    # Archivar solo uno de los dos registros con el mismo identificador (ambos muestran A1.csv).
    p.locator(".fila-historial").filter(has_text="A1.csv").locator("[data-sel]").first.check()
    p.click("[data-accion=archivar]")
    p.wait_for_selector(".vista-previa")
    comprobar("se van a archivar 1" in p.inner_text(".vista-previa"), "la vista previa cuenta un solo registro")
    p.click("[data-accion=confirmar]")
    p.wait_for_selector("#estado-historial:has-text('archivada')")
    esperar_filas(p, 2)
    activos_con_id = p.evaluate(f"""(() => {{
      const v = JSON.parse(localStorage.getItem('{CLAVE_V2}')).entradas;
      const id = {json.dumps(lista[0]["id"])};
      return {{
        total: v.filter(x => x.id === id).length,
        archivados: v.filter(x => x.id === id && x.estado === 'archived').length,
        activos: v.filter(x => x.id === id && x.estado === 'active').length,
      }};
    }})()""")
    comprobar(activos_con_id == {"total": 2, "archivados": 1, "activos": 1},
              f"archivar un registro repetido no afecta a su hermano (estado: {activos_con_id})")
    p.click("[data-filtro=archivados]")
    esperar_filas(p, 1)
    p.click("[data-filtro=todos]")
    esperar_filas(p, 3)

    # Exportación: descarga real, sin modificar el historial.
    antes = p.evaluate(f"localStorage.getItem('{CLAVE_V2}')")
    with p.expect_download() as descarga:
        p.click("#btn-exportar-historial")
    archivo = Path(tempfile.mkdtemp()) / descarga.value.suggested_filename
    descarga.value.save_as(str(archivo))
    exportado = json.loads(archivo.read_text(encoding="utf-8"))
    comprobar(exportado.get("formato") == "comparador-historial" and len(exportado.get("entradas", [])) == 3,
              "la exportación contiene las 3 comparaciones en JSON")
    comprobar(p.evaluate(f"localStorage.getItem('{CLAVE_V2}')") == antes, "exportar no modifica el historial")
    contexto.close()


def main() -> int:
    CAPTURAS.mkdir(parents=True, exist_ok=True)
    srv = servir(8766)
    url = "http://127.0.0.1:8766/index.html"
    lista = historial_1_3_1()
    with sync_playwright() as p:
        navegador = p.chromium.launch(
            executable_path=shutil.which("google-chrome") or shutil.which("chromium"),
            args=["--no-sandbox"],
        )
        escenario_migracion_y_estados(navegador, url, lista)
        escenario_dos_pestanas(navegador, url)
        escenario_cuota(navegador, url, lista)
        escenario_duplicados_y_exportacion(navegador, url, lista)
        navegador.close()
    srv.shutdown()
    print("\nRESULTADO:", "APROBADO" if not fallos else f"FALLIDO ({len(fallos)})")
    return 0 if not fallos else 1


if __name__ == "__main__":
    raise SystemExit(main())
