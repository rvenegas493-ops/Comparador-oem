// Service worker: precarga la app para funcionar sin conexión.
// Al cambiar cualquier archivo de la app, incrementar VERSION para que los
// dispositivos reciban la nueva versión.
const VERSION = "comparador-v1.0.0";

const RECURSOS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/motor.js",
  "./js/markdown.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./ejemplo/diccionario.csv",
  "./ejemplo/export_a.csv",
  "./ejemplo/export_b.csv",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(RECURSOS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cacheada) => {
      if (cacheada) return cacheada;
      return fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copia = resp.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copia));
          }
          return resp;
        })
        .catch(() => {
          if (req.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        });
    })
  );
});
