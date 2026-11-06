# Cómo ejecutar las pruebas

Estas instrucciones están escritas para reproducirse desde una instalación limpia del repositorio. No requieren servicios de pago ni credenciales.

## Requisitos

- Git.
- Node.js 18 o superior (para las pruebas unitarias).
- Python 3.10 o superior y Playwright para Python (solo para la prueba E2E de Chromium).

## 1. Instalación limpia

```bash
git clone https://github.com/rvenegas493-ops/Comparador-oem.git comprobacion
cd comprobacion
git checkout feature/data-lifecycle-f0-f1
```

## 2. Pruebas unitarias y de datos (Node)

```bash
npm test
```

Equivale a `node --test tests/js/*.test.mjs`. Usa el glob del shell: `node --test tests/js/` falla en Node 22, que lo trata como un fichero.

Incluye:

| Fichero | Qué cubre |
|---|---|
| `historial.test.mjs` | Migración, claves por contenido, archivar y restaurar, cuota, verificación de escritura, datos dañados, fusión, concurrencia con bloqueo simulado, modo presencia con `BroadcastChannel` real, historiales reales 1.3.0 y 1.3.1 |
| `fixtures.test.mjs` | Auditoría automática de los fixtures: patrones prohibidos (correos, URL, rutas locales, IP, VIN, posibles secretos) y coherencia de hashes con los ejemplos publicados |
| `ia-validacion.test.mjs`, `ia-cliente.test.mjs`, `ia-seguridad.test.mjs` | Pruebas existentes de la interpretación IA. No se modifican; la IA sigue desactivada |

## 3. Prueba E2E del historial en Chromium

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/e2e/prueba_historial_ciclo.py
```

Abre `index.html` en un servidor local en el puerto 8766 con viewport de teléfono (390×844). Cubre migración, archivar y restaurar desde la interfaz, dos pestañas con Web Locks reales, cuota llena simulada, identificadores duplicados y exportación. Las capturas se guardan en `tests/e2e/capturas/`, que está excluido del repositorio.

## 4. Lo que NO está incluido

- `prueba_pwa.py` (40 comprobaciones de la PWA completa) necesita el motor de referencia en Python (`comparador.py`) y `ejemplo/adaptador.json`. Ese motor no forma parte de este repositorio, así que esta prueba se ejecuta solo en el entorno de desarrollo y no se incluye en la rama.
- Pruebas en Safari de iPhone. Ver `docs/VALIDACION_SAFARI_IPHONE.md`. **No se han ejecutado.**

## 5. Resultados registrados

Los resultados se rellenan al ejecutar el paso de comprobación desde una instalación limpia. Ver la sección de la pull request.
