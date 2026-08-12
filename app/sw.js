/* Service Worker fuer "Hall Arbeitszeit"
   ======================================

   Zweck: Die App soll ohne Empfang funktionieren (Lager, Lkw, Funkloch)
   und sich auf Android und iPhone installieren lassen.

   WICHTIGSTE ENTSCHEIDUNG - "Netz zuerst" fuer die Seite selbst:
   Der klassische Fehler bei Service Workern ist "Cache zuerst" fuer HTML.
   Dann bekommt der Nutzer monatelang eine veraltete Fassung ausgeliefert,
   und niemand versteht, warum eine laengst behobene Sache immer noch
   kaputt ist. Deshalb hier:

     index.html   -> NETZ zuerst, Cache nur als Rueckfall
     version.txt  -> NUR Netz (das Auto-Update muss ehrlich sehen koennen,
                     ob es etwas Neues gibt)
     Symbole/Logo -> Cache zuerst (aendern sich fast nie)

   Damit gilt: online immer aktuell, offline immer benutzbar.

   Bei jeder Aenderung: CACHE_VERSION hochzaehlen. Diese Datei muss sich
   dabei aendern, sonst installiert der Browser den neuen Worker nicht.
*/

const CACHE_VERSION = "2026-08-12-1";
const CACHE_NAME = "hall-arbeitszeit-" + CACHE_VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "../hall-logo.png",
  "../icons/icon-192.png",
  "../icons/icon-512.png",
  "../icons/icon-maskable-512.png",
  "../icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Einzeln statt addAll: eine fehlende Datei soll nicht die ganze
      // Installation scheitern lassen.
      Promise.all(SHELL.map((url) =>
        cache.add(new Request(url, { cache: "reload" })).catch(() => null)
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(
        namen.filter((n) => n.startsWith("hall-arbeitszeit-") && n !== CACHE_NAME)
             .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // version.txt: ausschliesslich Netz, damit das Auto-Update ehrlich bleibt
  if (url.pathname.endsWith("version.txt")) {
    event.respondWith(fetch(req).catch(() => new Response("", { status: 504 })));
    return;
  }

  const istSeite = req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/");

  if (istSeite) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const kopie = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, kopie)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((t) => t || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((t) => t || fetch(req).then((res) => {
      const kopie = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(req, kopie)).catch(() => {});
      return res;
    }))
  );
});
