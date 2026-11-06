# Historial de comparaciones: ciclo de vida (1.4.0)

**Alcance.** Solo el historial temporal de comparaciones que genera el técnico en su dispositivo. El catálogo, los diccionarios OEM, los ejemplos, el motor de comparación y la generación de reportes no se modifican.

## Estados y operaciones

| Operación | Efecto | ¿Libera espacio? | ¿Reversible? |
|---|---|---|---|
| Archivar | `estado` pasa a `archived` y se añade `archivadoEn` | No | Sí |
| Restaurar | `estado` vuelve a `active` y se quita `archivadoEn` | No | Sí (el registro queda idéntico al original) |
| Exportar | Descarga un JSON con todas las comparaciones | No | No aplica: no modifica nada |
| Borrar físicamente | **No existe en esta versión** | — | — |

Archivar y restaurar requieren confirmación cuando son masivos (vista previa con el número y la lista de registros que cambian). Archivar una comparación individual es directo porque es reversible.

## Claves por registro

Cada registro se gestiona por una **clave**, no por su identificador:

- `clave = identificador ~ huella(contenido)`. La huella es un hash de 64 bits del contenido sin el estado.
- Archivar o restaurar no cambia el contenido, así que la clave es estable.
- Si dos registros comparten identificador pero no contenido, cada uno tiene su clave. Archivar uno no afecta al otro.
- Si dos registros son idénticos, reciben sufijo de ocurrencia (`~2`, `~3`…).
- Un identificador repetido **sin clave** no coincide con ningún registro: una operación con ese identificador no hace nada y lo reporta.
- Al cargar un historial con identificadores repetidos, la interfaz muestra un aviso.

## Almacenamiento

| Clave | Contenido | Quién la escribe |
|---|---|---|
| `comparador.historial` | Array JSON del formato 1.3.0 y 1.3.1 | Nadie desde 1.4.0. Se conserva como copia |
| `comparador.historial.v2` | `{ "esquema": 2, "rev": n, "entradas": [...] }` | Solo `js/historial.js` |

Cada entrada conserva todos sus campos originales. Solo se añaden `estado` y, si está archivada, `archivadoEn`.

## Migración y fusión

1. Si existe `comparador.historial.v2`, se usa.
2. Si no existe, se copia el formato 1.3.x en una sola escritura, verificada releyendo lo guardado.
3. Si la escritura falla, el formato anterior sigue siendo la fuente y **no** se crea ningún dato parcial. Se reintenta en cada operación.
4. Si una pestaña 1.3.x sigue abierta y escribe el formato anterior, sus registros nuevos se **fusionan por contenido** en la siguiente lectura. Un registro del formato anterior solo se añade si su contenido no está ya en `v2`. Nunca se elimina un registro de `v2`.

Verificado con historiales reales generados por la versión publicada 1.3.0 y por la línea base 1.3.1 (fixtures en `tests/fixtures/`, ver la auditoría en `docs/PRUEBAS.md`).

## Garantía entre pestañas

El módulo **comprueba antes de operar** qué garantía tiene el navegador:

| Modalidad | Condición | Qué garantiza | Qué hace la interfaz |
|---|---|---|---|
| `web-locks` | `navigator.locks` responde a una sonda | Exclusión mutua de lecturas y escrituras entre pestañas del mismo origen | Operación normal |
| `presencia` | Sin Web Locks, pero con `BroadcastChannel` | Si otra pestaña responde a una comprobación, la escritura se rechaza | Avisa de usar una sola pestaña |
| `sin-garantia` | Sin ninguna de las dos | Nada | **Rechaza las escrituras** con un mensaje claro. Las lecturas siguen |

**Ninguna modalidad garantiza atomicidad total.** La de `web-locks` es la más fuerte. La de `presencia` es una comprobación previa que reduce el riesgo, pero dos pestañas que comprueban a la vez pueden ver ambas el mismo estado. Por eso, en esa modalidad, la interfaz pide cerrar las demás pestañas.

Cada escritura se verifica releyendo el valor guardado. El campo `rev` es solo diagnóstico.

## Cuota, crecimiento y advertencias

**Medición (estimación en UTF-16, la codificación de localStorage en los navegadores habituales):**

| Escenario | Por comparación | Aviso de 4 MB aparece hacia la comparación |
|---|---|---|
| Con la copia del formato anterior (situación actual tras migrar) | ~15 KB | ~278 |
| Solo `v2` (si en el futuro se libera la copia) | ~7,5 KB | ~555 |

El límite real de localStorage varía según el navegador y el dispositivo, y **no está medido en iPhone**. Por eso la cifra de 4 MB es un aviso, no un tope.

**Qué hace el sistema:**
- Muestra un aviso cuando el uso estimado supera 4 MB. Nada se borra automáticamente.
- Si la cuota se llena al guardar, no descarta nada: informa, conserva el historial y deja el reporte descargable.
- El botón **Exportar** descarga una copia JSON completa, para tener respaldo antes de archivar o de cualquier decisión futura.

**Lo que NO hace:** no borra comparaciones, no libera la copia del formato anterior y no aplica ninguna retención automática.

**Propuesta futura (no implementada, requiere autorización):** liberar la copia `comparador.historial` solo después de (1) una exportación verificada y (2) confirmación explícita del técnico. Reduciría el uso a la mitad.

## Recuperación

- **Copia nativa:** el formato 1.3.x permanece en `comparador.historial`.
- **Si la migración falla:** la app sigue leyendo el formato anterior.
- **Si `v2` se daña:** pasa a solo lectura. No se sobrescribe. Se puede exportar lo que se lea.
- **Respaldo del técnico:** Exportar genera un JSON que contiene `entradas` con su markdown, hashes y metadatos.

## Limitaciones conocidas

- Dos pestañas 1.3.x abiertas simultáneamente pueden escribir el formato anterior sin protección. Sus registros se fusionan después, pero pueden verse con retraso.
- La modalidad `presencia` no es atómica.
- En modo `presencia`, si otra pestaña responde a la comprobación, la escritura se rechaza. En modo `sin-garantia` no se escribe nunca.
- Safari de iPhone **no está validado** en esta versión. Ver `docs/VALIDACION_SAFARI_IPHONE.md`.
