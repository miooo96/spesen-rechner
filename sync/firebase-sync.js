/* =====================================================================
   Spesen-Rechner – Auto-Sync ueber Firebase (Version 1)
   ---------------------------------------------------------------------
   Aufgabe: Der komplette Stand eines Fahrers liegt auf jedem seiner
   Geraete automatisch vor. Login pro Fahrer, jeder sieht NUR seine
   eigenen Daten, Offline-Betrieb inklusive.

   WICHTIG – Sicherheitsschalter:
   Das Modul tut GAR NICHTS, solange keine echte firebase-config.js
   geladen ist (window.SPESEN_FIREBASE_CONFIG fehlt oder enthaelt noch
   "DEIN_..."). Der Live-Rechner bleibt dann unveraendert.

   Andockpunkt an den bestehenden Code:
   - Jede Eingabe schreibt im Rechner bereits localStorage. Dieses Modul
     haengt sich an localStorage.setItem/removeItem (Monkey-Patch), ohne
     dass eine der ~90 vorhandenen Speicherstellen geaendert werden muss.
   - Welche Schluessel NICHT synchronisiert werden, ist dieselbe Regel
     wie gehoertInsBackup() im index.html: "kfz-kaefig-v1" (Neue Ware
     zaehlen) und "hall-letzter-bereich" (Merk-Hilfe) bleiben draussen.

   Konflikt-Regel (siehe Sync-Konzept, Abschnitt 5):
   - je Schluessel "neuerer gewinnt" (Last-Write-Wins)
   - der grosse Block spesen_overrides wird vor dem Ueberschreiben lokal
     als Schatten-Sicherung weggeschrieben -> kein Tag geht unwiederbring-
     lich verloren
   - ein eingereichter Monat (spesen_submitted_*) wird per Sync nie
     stillschweigend entfernt
   ===================================================================== */

(async () => {
  "use strict";

  // Konfiguration selbst laden – so genuegt EINE Zeile in der index.html.
  // Fehlt die Datei (z. B. auf einem Geraet ohne Einrichtung), bleibt der
  // Sync einfach aus und der Rechner verhaelt sich wie bisher.
  try { await import("./firebase-config.js"); } catch (e) { /* keine Konfig -> aus */ }

  const cfg = window.SPESEN_FIREBASE_CONFIG;
  const istEcht = cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("DEIN_");
  if (!istEcht) {
    // Kein echtes Projekt hinterlegt -> Sync bleibt aus. Bewusst leise.
    console.info("[Sync] Keine Firebase-Konfiguration – Auto-Sync ist aus.");
    return;
  }

  // ---- Aktivierung: nur fuer Mirko ------------------------------------
  // Gleiche Erkennung wie istMirko() im Tool: config.name == "Mirko Rieb".
  // Kollegen haben ihren eigenen Namen -> sie sehen NICHTS (kein Anmelde-
  // Knopf, kein Firebase). Vorteil gegenueber dem alten ?sync=an: das hier
  // funktioniert in JEDER Oberflaeche – auch in der installierten Home-App,
  // die keine Adresszeile hat. Not-Aus bleibt ueber ?sync=aus moeglich.
  const params = new URLSearchParams(location.search);
  if (params.get("sync") === "aus") localStorage.setItem("spesen_sync_aus", "ja");
  if (params.get("sync") === "an") localStorage.removeItem("spesen_sync_aus");
  const toolConfig = (() => {
    try { return JSON.parse(localStorage.getItem("spesen_config") || "{}"); }
    catch (e) { return {}; }
  })();
  const istMirko = (toolConfig.name || "").trim().toLowerCase() === "mirko rieb";
  if (localStorage.getItem("spesen_sync_aus") === "ja" || !istMirko) {
    console.info("[Sync] Nicht aktiv (nur fuer Mirko; oder ?sync=aus gesetzt).");
    return;
  }

  const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

  // ---- Schluessel, die NICHT in die Cloud gehen -----------------------
  const AUSGESCHLOSSEN = new Set([
    "kfz-kaefig-v1",        // "Neue Ware zaehlen" – jede Woche neu, kein Nachweis
    "hall-letzter-bereich", // nur "welcher Bereich war offen"
    "spesen_sync_aus",      // Geraete-Not-Aus, gehoert nicht in die Cloud
  ]);
  // Interne Hilfsschluessel dieses Moduls (nie synchronisieren)
  const istIntern = (k) =>
    k.startsWith("__sync") || k.includes("__shadow_") || k === "emailForSignIn";

  const syncFaehig = (k) =>
    typeof k === "string" && !AUSGESCHLOSSEN.has(k) && !istIntern(k);

  const META_KEY = "__sync_meta";          // { key: zuletztGeaendertMillis }
  const DEVICE_KEY = "__sync_device";       // stabile Geraete-Kennung
  const MAX_WERT = 900_000;                 // Firestore-Dok-Limit ~1 MB

  // Original-Funktionen sichern (bevor gepatcht wird)
  const _setItem = Storage.prototype.setItem;
  const _removeItem = Storage.prototype.removeItem;

  const geraet = (() => {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) { d = "g_" + Math.random().toString(36).slice(2, 10); _setItem.call(localStorage, DEVICE_KEY, d); }
    return d;
  })();

  const metaLesen = () => {
    try { return JSON.parse(localStorage.getItem(META_KEY) || "{}"); } catch { return {}; }
  };
  const metaSchreiben = (m) => _setItem.call(localStorage, META_KEY, JSON.stringify(m));
  const metaSetzen = (key, ts) => { const m = metaLesen(); m[key] = ts; metaSchreiben(m); };

  // ---- Firebase laden & starten ---------------------------------------
  let db, auth, uid = null;
  const pushWarteschlange = new Map();   // key -> timer
  let anwendenLaeuft = false;            // Echo-Sperre: Remote wird gerade angewendet
  let reloadTimer = null;

  Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]).then(([appMod, authMod, fsMod]) => {
    starten(appMod, authMod, fsMod).catch((e) => console.error("[Sync] Start fehlgeschlagen:", e));
  }).catch((e) => console.error("[Sync] Firebase-SDK konnte nicht geladen werden:", e));

  async function starten(appMod, authMod, fsMod) {
    const app = appMod.initializeApp(cfg);
    auth = authMod.getAuth(app);

    // Firestore mit Offline-Speicher (puffert Schreibvorgaenge ohne Netz)
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({}),
    });
    // Modul-weit gebrauchte Firestore-Funktionen merken
    FS = fsMod;

    // --- Magic-Link: Rueckkehr vom Login-Link abfangen ---------------
    if (authMod.isSignInWithEmailLink(auth, window.location.href)) {
      let email = localStorage.getItem("emailForSignIn");
      if (!email) email = window.prompt("Zur Bestaetigung bitte dieselbe E-Mail eingeben:");
      try {
        await authMod.signInWithEmailLink(auth, email, window.location.href);
        localStorage.removeItem("emailForSignIn");
        // Login-Parameter aus der Adresszeile entfernen
        history.replaceState(null, "", window.location.pathname);
      } catch (e) {
        alert("Anmeldung fehlgeschlagen: " + e.message);
      }
    }

    AUTH = authMod;
    authMod.onAuthStateChanged(auth, (user) => {
      uid = user ? user.uid : null;
      badgeZeichnen(user ? user.email : null);
      if (user) {
        localStorage.removeItem("emailForSignIn");
        patchAnbringen();
        anhoeren();          // Cloud -> Geraet (Live)
        // Beim Start ERST alles aus der Cloud holen, DANN vorhandene lokale
        // Daten hochschieben, die es in der Cloud noch nicht gibt. So wandert
        // beim ersten Login auf einem Geraet mit bestehenden Daten alles
        // nach oben, und ein leeres zweites Geraet bekommt es danach.
        ersteVollsicht().then(erstPushAllesRauf);
      }
    });

    loginOberflaeche();
  }

  let FS, AUTH;

  // ---- Geraet -> Cloud: localStorage patchen --------------------------
  function patchAnbringen() {
    if (Storage.prototype.__spesenGepatcht) return;
    Storage.prototype.setItem = function (key, value) {
      _setItem.call(this, key, value);
      if (this === window.localStorage && !anwendenLaeuft && syncFaehig(key)) {
        metaSetzen(key, Date.now());
        pushPlanen(key);
      }
    };
    Storage.prototype.removeItem = function (key) {
      _removeItem.call(this, key);
      if (this === window.localStorage && !anwendenLaeuft && syncFaehig(key)) {
        // Einen eingereichten Monat NICHT per Loeschung in die Cloud tragen
        if (!key.startsWith("spesen_submitted_")) {
          metaSetzen(key, Date.now());
          pushPlanen(key, true);
        }
      }
    };
    Storage.prototype.__spesenGepatcht = true;
  }

  function pushPlanen(key, geloescht = false) {
    if (!uid) return;
    clearTimeout(pushWarteschlange.get(key));
    pushWarteschlange.set(key, setTimeout(() => pushJetzt(key, geloescht), 1500));
  }

  async function pushJetzt(key, geloescht) {
    if (!uid) return;
    try {
      const ref = FS.doc(db, "users", uid, "state", key);
      if (geloescht) {
        await FS.deleteDoc(ref);
        return;
      }
      const value = localStorage.getItem(key);
      if (value == null) return;
      if (value.length > MAX_WERT) {
        console.warn("[Sync] Wert zu gross fuer Sync, uebersprungen:", key, value.length);
        return;
      }
      await FS.setDoc(ref, {
        value,
        clientTime: Date.now(),
        updatedAt: FS.serverTimestamp(),
        device: geraet,
      });
    } catch (e) {
      // Offline landet der Schreibvorgang im Firestore-Puffer und geht spaeter raus.
      console.warn("[Sync] Push wartet/fehlgeschlagen:", key, e.message);
    }
  }

  // ---- Cloud -> Geraet: Live zuhoeren ---------------------------------
  function anhoeren() {
    if (!uid) return;
    const coll = FS.collection(db, "users", uid, "state");
    FS.onSnapshot(coll, (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type === "removed") return; // Loeschungen konservativ ignorieren
        anwenden(ch.doc.id, ch.doc.data());
      });
    }, (e) => console.warn("[Sync] Listener-Fehler:", e.message));
  }

  async function ersteVollsicht() {
    try {
      const coll = FS.collection(db, "users", uid, "state");
      const snap = await FS.getDocs(coll);
      snap.forEach((d) => anwenden(d.id, d.data()));
    } catch (e) {
      console.warn("[Sync] Erstabgleich:", e.message);
    }
  }

  // Bereits vorhandene lokale Daten, die noch NICHT synchronisiert wurden,
  // einmalig hochschieben. Laeuft NACH ersteVollsicht(): Alles, was von dort
  // schon einen Zeitstempel (meta) hat, ueberspringen; nur die echten
  // Alt-Bestaende dieses Geraets gehen rauf. So landen beim ersten Login die
  // vorhandenen Eintraege in der Cloud, ohne Cloud-Neueres zu ueberschreiben.
  function erstPushAllesRauf() {
    const meta = metaLesen();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!syncFaehig(k)) continue;
      if (meta[k]) continue; // schon von hier gepusht oder aus der Cloud geholt
      metaSetzen(k, Date.now());
      pushJetzt(k, false);
    }
  }

  // Einen Remote-Stand ins localStorage uebernehmen, WENN er neuer ist.
  function anwenden(key, data) {
    if (!data || typeof data.value === "undefined") return;
    if (!syncFaehig(key)) return;

    const meta = metaLesen();
    const lokalTs = meta[key] || 0;
    const remoteTs = data.clientTime || 0;
    // Nur uebernehmen, wenn Remote echt neuer ist (und nicht das eigene Echo)
    if (remoteTs <= lokalTs) return;
    if (localStorage.getItem(key) === data.value) { metaSetzen(key, remoteTs); return; }

    // Schatten-Sicherung fuer den grossen Arbeitszeit-Block
    if (key === "spesen_overrides") {
      const alt = localStorage.getItem(key);
      if (alt) _setItem.call(localStorage, key + "__shadow_" + Date.now(), alt);
      schattenAufraeumen(key); // nur die letzten paar behalten
    }

    // Anwenden OHNE erneuten Push (Echo-Sperre)
    anwendenLaeuft = true;
    _setItem.call(localStorage, key, data.value);
    anwendenLaeuft = false;
    metaSetzen(key, remoteTs);

    // Ansicht auffrischen – aber nicht, waehrend gerade getippt wird.
    reloadPlanen();
  }

  function schattenAufraeumen(key) {
    const praefix = key + "__shadow_";
    const treffer = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(praefix)) treffer.push(k);
    }
    treffer.sort();
    while (treffer.length > 5) _removeItem.call(localStorage, treffer.shift());
  }

  // Weiches Neuladen: erst wenn der Nutzer ein paar Sekunden nichts tippt.
  function reloadPlanen() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      const aktiv = document.activeElement;
      const tippt = aktiv && (aktiv.tagName === "INPUT" || aktiv.tagName === "TEXTAREA" || aktiv.tagName === "SELECT");
      if (tippt) { reloadPlanen(); return; } // noch beschaeftigt -> spaeter
      location.reload();
    }, 4000);
  }

  // ---- Kleine Login-Oberflaeche ---------------------------------------
  function loginOberflaeche() {
    // Schwebende Statusmarke unten rechts
    if (document.getElementById("syncBadge")) return;
    const b = document.createElement("div");
    b.id = "syncBadge";
    b.style.cssText =
      "position:fixed;right:10px;bottom:10px;z-index:99999;font:13px/1.3 system-ui,sans-serif;" +
      "background:#123;color:#fff;padding:8px 12px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;opacity:.92";
    b.textContent = "☁︎ Sync";
    b.onclick = () => (uid ? abmeldenFrage() : anmeldenFrage());
    document.body.appendChild(b);
  }

  function badgeZeichnen(email) {
    const b = document.getElementById("syncBadge");
    if (!b) return;
    if (email) { b.textContent = "☁︎ " + email + " ✓"; b.style.background = "#0a5"; }
    else { b.textContent = "☁︎ Anmelden"; b.style.background = "#123"; }
  }

  async function anmeldenFrage() {
    const email = window.prompt("E-Mail fuer die Anmeldung (Sie bekommen einen Login-Link zugeschickt):");
    if (!email) return;
    try {
      await AUTH.sendSignInLinkToEmail(auth, email, {
        url: window.location.origin + window.location.pathname,
        handleCodeInApp: true,
      });
      localStorage.setItem("emailForSignIn", email);
      alert("Login-Link verschickt. Bitte die E-Mail an " + email + " oeffnen und auf den Link tippen – auf DIESEM Geraet.");
    } catch (e) {
      alert("Konnte keinen Link verschicken: " + e.message);
    }
  }

  async function abmeldenFrage() {
    if (!confirm("Von der Synchronisierung abmelden? Ihre Daten bleiben lokal auf diesem Geraet erhalten.")) return;
    try { await AUTH.signOut(auth); location.reload(); } catch (e) { alert(e.message); }
  }
})();
