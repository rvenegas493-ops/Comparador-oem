# Validación manual en Safari de iPhone

**Estado: NO EJECUTADO.** Esta lista describe qué comprobar. No declara compatibilidad. Solo se considerará validado lo que se marque como resultado tras una prueba real, con la versión de iOS y de Safari anotada.

## Preparación

1. Anotar el modelo de iPhone y la versión de iOS.
2. Abrir la PWA desde la URL publicada (no desde una copia local) en Safari.
3. Repetir en modo pantalla de inicio (añadida desde Safari) y, si es posible, en navegación privada.
4. Antes de empezar, anotar cuántas comparaciones hay en el historial.

## Casos que requieren validación

| # | Caso | Cómo comprobarlo | Resultado esperado | Resultado real (iOS / Safari) |
|---|---|---|---|---|
| 1 | Migración del formato 1.3.x | Con un historial guardado con la versión anterior, abrir la 1.4.0 | El historial aparece completo; `comparador.historial` no cambia | ☐ |
| 2 | Archivar y restaurar una comparación | Archivar y luego restaurar; recargar la página | Vuelve al estado original; el aviso de archivado desaparece | ☐ |
| 3 | Archivar todo con vista previa | Pulsar "Archivar todo"; leer la vista previa; confirmar | Solo cambian los registros listados; nada se borra | ☐ |
| 4 | Identificadores duplicados | Cargar un historial con dos registros de igual identificador y distinto contenido | Aviso de duplicados; archivar uno no afecta al otro | ☐ |
| 5 | Web Locks | En Safari con Web Inspector (Mac conectado), ejecutar `typeof navigator.locks` | Anotar si es `"object"`. Si no existe, la app debe usar el modo `presencia` o `sin-garantia` | ☐ |
| 6 | Modo presencia con dos pestañas | Si Web Locks no está disponible, abrir dos pestañas y escribir en una | La escritura se rechaza con el mensaje de otra pestaña | ☐ |
| 7 | Modo sin garantía | Forzar la ausencia de ambos mecanismos (solo en desarrollo) | Lectura permitida, escritura rechazada con mensaje claro | ☐ |
| 8 | Cuota de almacenamiento | Medir con comparaciones reales cuándo aparece el aviso de 4 MB y si `setItem` lanza error | Anotar el número de comparaciones y el mensaje mostrado | ☐ |
| 9 | Fallo de escritura por cuota | Llegar al límite real (si es alcanzable) y guardar una comparación nueva | El historial se conserva; se muestra el aviso; el reporte sigue descargable | ☐ |
| 10 | Exportar el historial | Pulsar "Exportar" | Se descarga o se abre el JSON. Anotar si Safari lo guarda en Archivos o lo muestra en pantalla | ☐ |
| 11 | Descarga de reportes | Descargar un reporte Markdown y otro HTML | El archivo se obtiene y es legible | ☐ |
| 12 | Modo sin conexión | Cargar la app, poner el teléfono en modo avión, recargar | La app abre desde la caché del service worker | ☐ |
| 13 | Actualización de versión | Con una versión anterior en caché, publicar y recargar | Se muestra la versión 1.4.0 (VERSION en `js/app.js`) | ☐ |
| 14 | Pantalla pequeña | Revisar la lista y el detalle del historial a 390 px de ancho | Sin desplazamiento horizontal; botones accesibles | ☐ |
| 15 | Suspensión de la pestaña | Dejar la app en segundo plano varios minutos y volver | Los datos siguen íntegros; el historial se relee | ☐ |
| 16 | Modo navegación privada | Abrir en privado, guardar y archivar | Anotar si localStorage está disponible y el comportamiento al cerrar | ☐ |

## Cómo registrar un resultado

Para cada caso anotar: fecha, modelo, versión de iOS, versión de Safari, resultado (cumple / no cumple / no aplicable) y, si no cumple, una captura de la pantalla con los datos ficticios.

No introducir datos reales de clientes ni de ECM en estas pruebas. Usar solo `ejemplo/` o los fixtures sanitizados.

## Qué no cubre esta lista

- Compatibilidad con otros navegadores móviles (Chrome en Android, Firefox).
- Rendimiento con miles de comparaciones.
- Comportamiento del backend de IA, que sigue desactivado.
