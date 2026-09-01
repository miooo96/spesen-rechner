/* Service Worker für hall-spesen-rechner.de
   =========================================

   EIN Worker für alles: Spesen-Rechner, Anleitung und die App unter /app/.

   Warum im Stammordner und nicht in /app/:
   Ein Service Worker darf nur den Ordner bedienen, in dem er liegt. Lag er
   in /app/, konnte er das Spesenblatt nicht offline verfügbar machen -
   und genau das ist gewünscht, damit in der App beides ohne Empfang läuft.
   Zwei Worker mit überlappendem Zustaendigkeitsbereich waeren unnoetig
   fehleranfaellig, deshalb einer.

   WICHTIGSTE ENTSCHEIDUNG - "Netz zuerst" fuer alle Seiten:
   Der klassische Fehler ist "Cache zuerst" fuer HTML. Dann bekommen Nutzer
   monatelang eine veraltete Fassung, und niemand versteht, warum eine
   laengst behobene Sache immer noch kaputt ist. Deshalb:

     index.html / Anleitung.html / app/  -> NETZ zuerst, Cache als Rueckfall
     version.txt                         -> NUR Netz (das Auto-Update muss
                                            ehrlich sehen koennen, ob es
                                            etwas Neues gibt)
     Bilder, Symbole, vendor/*.js        -> Cache zuerst (aendern sich fast
                                            nie, sind aber gross)

   Damit gilt: online immer aktuell, offline immer benutzbar.

   HINWEIS ZUR WEBSEITE:
   Dieser Worker macht die Webseite NICHT zur App. Dafuer braeuchte
   index.html ein verlinktes Manifest - das hat sie bewusst nicht. Es gibt
   also kein "App installieren"-Fenster fuer Kollegen. Sie merken nur, dass
   das Tool auch ohne Empfang funktioniert.

   Bei jeder Aenderung: CACHE_VERSION hochzaehlen. Diese Datei muss sich
   dabei aendern, sonst installiert der Browser den neuen Worker nicht.
*/

const CACHE_VERSION = "2026-09-01-2";
const CACHE_NAME = "hall-spesen-" + CACHE_VERSION;

/* Was beim Installieren mitgenommen wird, damit auch der allererste
   Offline-Start vollstaendig ist. Die Anleitungsbilder sind bewusst NICHT
   dabei - die sind gross und werden bei Bedarf nachgeladen. */
const SHELL = [
  "./",
  "./index.html",
  "./Anleitung.html",
  "./hall-logo.png",
  "./app/",
  "./app/index.html",
  "./app/manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./vendor/html2canvas.min.js",
  "./vendor/jspdf.umd.min.js",
  "./vendor/qrcode.min.js",
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
        namen.filter((n) => (n.startsWith("hall-spesen-") || n.startsWith("hall-arbeitszeit-")) && n !== CACHE_NAME)
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
    // Netz zuerst, Cache als Rueckfall
    event.respondWith(
      fetch(req)
        .then((res) => {
          const kopie = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, kopie)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((treffer) =>
          treffer || caches.match(url.pathname.indexOf("/app/") === 0 ? "./app/index.html" : "./index.html")))
    );
    return;
  }

  // Alles andere: Cache zuerst, sonst Netz
  event.respondWith(
    caches.match(req).then((treffer) => treffer || fetch(req).then((res) => {
      const kopie = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(req, kopie)).catch(() => {});
      return res;
    }))
  );
});
