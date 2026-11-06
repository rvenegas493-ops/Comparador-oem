// Service worker: precarga la app para funcionar sin conexión.
//
// Estrategia:
// - Código de la app (HTML, JS, CSS, manifest): red primero. Así una versión nueva
//   llega en cuanto hay conexión; sin conexión se usa la copia en caché.
// - Ejemplos, iconos y demás recursos: caché primero.
// - Solo se borran cachés de esta aplicación con otra versión. Los reportes e
//   historial viven en localStorage, no en Cache Storage, y no se tocan.
//
// Al cambiar cualquier archivo de la app, incrementar VERSION.
const VERSION = "comparador-v1.4.0";
const PREFIJO = "comparador-";

const RECURSOS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/motor.js",
  "./js/markdown.js",
  "./js/app.js",
  "./js/inspeccion.js",
  "./js/simulacion.js",
  "./js/resumen.js",
  "./js/ia-validacion.js",
  "./js/ia-cliente.js",
  "./js/historial.js",
  "./ejemplo/documentos-demo/documentos.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./ejemplo/diccionario.csv",
  "./ejemplo/export_a.csv",
  "./ejemplo/export_b.csv",
  "./ejemplo/demo/demo_a.csv",
  "./ejemplo/demo/demo_b.csv",
  "./ejemplo/demo/demo_diccionario.csv",
];

// Código de la app: se pide a la red en cada carga cuando hay conexión.
const esCodigo = (url) =>
  url.pathname.endsWith("/") ||
  /\.(html|js|css|webmanifest)$/.test(url.pathname);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // "reload" evita copias antiguas de la caché HTTP al instalar.
      .then((cache) => cache.addAll(RECURSOS.map((r) => new Request(r, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((claves) =>
        Promise.all(
          claves.filter((c) => c.startsWith(PREFIJO) && c !== VERSION).map((c) => caches.delete(c))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function redPrimero(req, url) {
  const cache = await caches.open(VERSION);
  try {
    const resp = await fetch(req, { cache: "no-cache" });
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    const copia = await cache.match(req);
    if (copia) return copia;
    if (req.mode === "navigate") return cache.match("./index.html");
    return Response.error();
  }
}

async function cachePrimero(req) {
  const cacheada = await caches.match(req);
  if (cacheada) return cacheada;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(VERSION);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate" || esCodigo(url)) {
    event.respondWith(redPrimero(req, url));
  } else {
    event.respondWith(cachePrimero(req));
  }
});
