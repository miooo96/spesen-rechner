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
  /* Ergaenzt 07.10.2026: Firebase legt selbst Merker im Browserspeicher ab
     ("firestore_zombie_firestore/[DEFAULT]/…"). Der Abgleich versuchte, auch
     diese hochzuladen - das scheitert an den Schraegstrichen (gefunden im
     Zwei-Geraete-Test mit dem Emulator, sync-pruefen.js). Schluessel mit "/"
     kann Firestore grundsaetzlich nicht als Dokument anlegen. */
  const istIntern = (k) =>
    k.startsWith("__sync") || k.includes("__shadow_") || k === "emailForSignIn"
    || k.startsWith("firestore_") || k.includes("/");

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

  // ---- PDF-Sync (Version 2) -------------------------------------------
  // Die im Tool abgelegten PDFs (IndexedDB "spesen-pdf-archiv") wandern als
  // Base64 in die Unter-Sammlung users/{uid}/pdfs/{id}. Dieselbe Gatung wie
  // der state-Sync (nur Mirko, nur angemeldet). Siehe firestore.rules.
  const PDF_TOOBIG_KEY = "__sync_pdf_toobig"; // { id: byteGroesse } – zu gross fuer ein Firestore-Dok
  const cloudPdfIds = new Set();              // IDs, die aktuell in der Cloud liegen (aus dem Snapshot)
  let anwendenPdfLaeuft = false;              // Echo-Sperre: ein Download wird gerade lokal abgelegt
  let pdfPeriodischLaeuft = false;            // Intervall-Wächter nur einmal starten

  const pdfToobigLesen = () => {
    try { return JSON.parse(localStorage.getItem(PDF_TOOBIG_KEY) || "{}") || {}; } catch { return {}; }
  };
  const pdfToobigMerken = (id, size) => {
    try { const m = pdfToobigLesen(); m[id] = size; _setItem.call(localStorage, PDF_TOOBIG_KEY, JSON.stringify(m)); } catch {}
  };
  const pdfToobigLoeschen = (id) => {
    try { const m = pdfToobigLesen(); if (m[id] != null) { delete m[id]; _setItem.call(localStorage, PDF_TOOBIG_KEY, JSON.stringify(m)); } } catch {}
  };

  // Blob -> Base64 (ohne "data:...;base64,"-Praefix). Null bei Fehler.
  function blobZuBase64(blob) {
    return new Promise((res) => {
      try {
        const r = new FileReader();
        r.onload = () => {
          const s = String(r.result || "");
          const i = s.indexOf(",");
          res(i >= 0 ? s.slice(i + 1) : "");
        };
        r.onerror = () => { console.warn("[Sync] Blob->Base64 fehlgeschlagen"); res(null); };
        r.readAsDataURL(blob);
      } catch (e) { console.warn("[Sync] Blob->Base64 fehlgeschlagen:", e.message); res(null); }
    });
  }

  // Base64 -> Blob (application/pdf). Null bei Fehler.
  function base64ZuBlob(b64) {
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: "application/pdf" });
    } catch (e) { console.warn("[Sync] Base64->Blob fehlgeschlagen:", e.message); return null; }
  }

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

    /* PRUEFUMGEBUNG (07.10.2026): NUR auf diesem Rechner (localhost) und NUR
       mit ?sync-test in der Adresse -> lokale Firebase-Emulatoren statt
       echter Cloud. So laesst sich der Abgleich mit zwei Browsern pruefen,
       ohne Mirkos Konto und ohne echte Daten (sync-test/ im Spesen-Tool-
       Ordner). Auf hall-spesen-rechner.de wirkungslos: dort ist der
       Hostname nie localhost. */
    const lokal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (lokal && (params.has("sync-test") || sessionStorage.getItem("__sync_test") === "ja")) {
      sessionStorage.setItem("__sync_test", "ja");
      authMod.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      fsMod.connectFirestoreEmulator(db, "127.0.0.1", 8080);
      console.info("[Sync] PRUEFUMGEBUNG: Firebase-Emulatoren auf diesem Rechner");
    }

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
        // Konto gewechselt (oder erstmalig)? Dann den Sync-Merker leeren,
        // damit die lokalen Daten frisch mit DIESEM Konto abgeglichen und
        // (bei leerem Cloud-Konto) vollstaendig hochgeladen werden. Ohne das
        // wuerde nach einem Kontowechsel nichts hochgehen (alte Zeitstempel).
        if (localStorage.getItem("__sync_uid") !== user.uid) {
          _removeItem.call(localStorage, META_KEY);
          _setItem.call(localStorage, "__sync_uid", user.uid);
        }
        patchAnbringen();
        anhoeren();          // Cloud -> Geraet (Live)
        // Beim Start ERST alles aus der Cloud holen, DANN vorhandene lokale
        // Daten hochschieben, die es in der Cloud noch nicht gibt. So wandert
        // beim ersten Login auf einem Geraet mit bestehenden Daten alles
        // nach oben, und ein leeres zweites Geraet bekommt es danach.
        ersteVollsicht().then(erstPushAllesRauf);

        // --- Dasselbe fuer die abgelegten PDFs (Version 2) ---
        pdfPatchAnbringen();                           // neue PDFs prompt hochladen
        pdfAnhoeren();                                 // Cloud -> Geraet (Live)
        pdfErstVollsicht().then(pdfErstPushRauf);      // erst holen, dann fehlende hochladen
        pdfPeriodischStarten();                        // Sicherheitsnetz, falls der Patch mal nicht greift
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

  // Anmeldung per E-Mail + Passwort. Kein Mailversand -> kein Tageslimit.
  // Erstanlage: Gibt es noch kein Konto mit diesem Passwort, wird nach
  // Rueckfrage eines angelegt (createUser schickt KEINE Mail).
  async function anmeldenFrage() {
    const email = window.prompt("E-Mail:", "mirkorieb@t-online.de");
    if (!email) return;
    const pw = window.prompt("Passwort (mindestens 6 Zeichen):");
    if (!pw) return;
    try {
      await AUTH.signInWithEmailAndPassword(auth, email.trim(), pw);
      return; // onAuthStateChanged uebernimmt den Rest
    } catch (e) {
      // "invalid-credential"/"user-not-found" = Konto/Passwort passt nicht.
      const evtlNeu = ["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password"].includes(e.code);
      if (!evtlNeu) { alert("Anmeldung fehlgeschlagen: " + e.message); return; }
      if (!confirm("Kein passendes Konto gefunden.\n\nFalls Sie zum ersten Mal ein Passwort vergeben: jetzt ein Konto mit diesem Passwort anlegen?")) return;
      try {
        await AUTH.createUserWithEmailAndPassword(auth, email.trim(), pw);
      } catch (e2) {
        if (e2.code === "auth/email-already-in-use") {
          alert("Für diese E-Mail gibt es schon ein Konto – aber noch OHNE Passwort (von der früheren Mail-Anmeldung).\n\nBitte dieses Konto einmal in der Firebase-Konsole löschen:\nAuthentication → Users → den Eintrag mirkorieb@t-online.de löschen.\nDanach hier mit E-Mail + Passwort erneut anmelden – dann wird es neu angelegt.\n\n(Ihre Daten bleiben erhalten, sie liegen auf diesem Gerät und werden nach dem Anmelden wieder hochgeladen.)");
        } else if (e2.code === "auth/weak-password") {
          alert("Das Passwort ist zu kurz – bitte mindestens 6 Zeichen.");
        } else {
          alert("Konnte kein Konto anlegen: " + e2.message);
        }
      }
    }
  }

  async function abmeldenFrage() {
    if (!confirm("Von der Synchronisierung abmelden? Ihre Daten bleiben lokal auf diesem Geraet erhalten.")) return;
    try { await AUTH.signOut(auth); location.reload(); } catch (e) { alert(e.message); }
  }

  // =====================================================================
  //  PDF-Ablage synchronisieren (Version 2)
  // =====================================================================

  // Monkey-Patch von window.pdfDbAblegen: nach erfolgreichem lokalem Ablegen
  // (Rueckgabe true) die PDF zusaetzlich in die Cloud schieben. Verhalten und
  // Rueckgabewert des Originals bleiben unveraendert; der Upload laeuft daneben.
  // index.html ist ein KLASSISCHES Script -> die Funktionsdeklaration
  // pdfDbAblegen ist eine window-Property, der Patch greift also auch fuer die
  // bare-identifier-Aufrufe aus index.html (im Test verifiziert).
  function pdfPatchAnbringen() {
    if (window.__spesenPdfGepatcht) return;
    const orig = window.pdfDbAblegen;
    if (typeof orig !== "function") return; // index.html noch nicht so weit -> spaeter erneut
    window.pdfDbAblegen = async function (id, blob) {
      const ok = await orig.call(this, id, blob);
      try {
        // Nicht hochladen, wenn gerade ein DOWNLOAD lokal abgelegt wird (Echo-Schleife),
        // oder wenn noch kein Nutzer angemeldet ist.
        if (ok === true && uid && db && !anwendenPdfLaeuft) pdfHochladen(id);
      } catch (e) { /* Upload darf das lokale Ablegen nie stoeren */ }
      return ok;
    };
    window.__spesenPdfGepatcht = true;
  }

  // Eine lokal abgelegte PDF in die Cloud schreiben.
  async function pdfHochladen(id) {
    if (!uid || !db || !FS) return;
    if (typeof window.pdfDbHolen !== "function") return;
    try {
      const blob = await window.pdfDbHolen(id);
      if (!blob) return;
      const b64 = await blobZuBase64(blob);
      if (!b64) return;
      if (b64.length > MAX_WERT) {
        console.warn("[Sync] PDF zu gross fuer Firestore, uebersprungen:", id, b64.length);
        pdfToobigMerken(id, blob.size);
        return;
      }
      pdfToobigLoeschen(id); // war evtl. frueher zu gross, jetzt passt es
      const ref = FS.doc(db, "users", uid, "pdfs", id);
      await FS.setDoc(ref, {
        b64,
        size: blob.size,
        updatedAt: FS.serverTimestamp(),
        device: geraet,
      });
      cloudPdfIds.add(id);
    } catch (e) {
      console.warn("[Sync] PDF-Upload wartet/fehlgeschlagen:", id, e.message);
    }
  }

  // Live auf die Cloud-PDFs hoeren und fehlende/abweichende herunterladen.
  function pdfAnhoeren() {
    if (!uid || !FS) return;
    const coll = FS.collection(db, "users", uid, "pdfs");
    FS.onSnapshot(coll, (snap) => {
      // Cloud-Id-Menge frisch aufbauen (dient dem Erst-Upload als Echo-Schutz)
      cloudPdfIds.clear();
      snap.forEach((d) => cloudPdfIds.add(d.id));
      let etwasGeholt = false;
      const arbeiten = [];
      snap.docChanges().forEach((ch) => {
        if (ch.type === "removed") return; // Loeschungen konservativ ignorieren
        arbeiten.push(pdfHerunterladen(ch.doc.id, ch.doc.data()).then((g) => { if (g) etwasGeholt = true; }));
      });
      Promise.all(arbeiten).then(() => { if (etwasGeholt) ordnerAuffrischen(); });
    }, (e) => console.warn("[Sync] PDF-Listener-Fehler:", e.message));
  }

  // Eine Cloud-PDF lokal ablegen, WENN sie fehlt oder eine andere Groesse hat.
  // Liefert true, wenn wirklich etwas geschrieben wurde.
  async function pdfHerunterladen(id, data) {
    if (!data || !data.b64) return false;
    if (typeof window.pdfDbHolen !== "function" || typeof window.pdfDbAblegen !== "function") return false;
    try {
      const vorhanden = await window.pdfDbHolen(id);
      if (vorhanden && typeof data.size === "number" && vorhanden.size === data.size) return false; // schon da
      const blob = base64ZuBlob(data.b64);
      if (!blob) return false;
      // Lokal ablegen OHNE erneuten Upload (Echo-Sperre)
      anwendenPdfLaeuft = true;
      try { await window.pdfDbAblegen(id, blob); }
      finally { anwendenPdfLaeuft = false; }
      cloudPdfIds.add(id);
      return true;
    } catch (e) {
      console.warn("[Sync] PDF-Download fehlgeschlagen:", id, e.message);
      return false;
    }
  }

  // Beim Login einmal alle Cloud-PDFs holen und die Id-Menge aufbauen.
  async function pdfErstVollsicht() {
    if (!uid || !FS) return;
    try {
      const coll = FS.collection(db, "users", uid, "pdfs");
      const snap = await FS.getDocs(coll);
      cloudPdfIds.clear();
      let etwasGeholt = false;
      const arbeiten = [];
      snap.forEach((d) => {
        cloudPdfIds.add(d.id);
        arbeiten.push(pdfHerunterladen(d.id, d.data()).then((g) => { if (g) etwasGeholt = true; }));
      });
      await Promise.all(arbeiten);
      if (etwasGeholt) ordnerAuffrischen();
    } catch (e) {
      console.warn("[Sync] PDF-Erstabgleich:", e.message);
    }
  }

  // Beim Login alle lokalen PDFs hochladen, die in der Cloud fehlen.
  async function pdfErstPushRauf() {
    if (!uid) return;
    if (typeof window.pdfDbSchluessel !== "function") return;
    try {
      const ids = await window.pdfDbSchluessel();
      for (const id of ids) {
        if (cloudPdfIds.has(id)) continue; // schon in der Cloud (oder gerade geholt)
        await pdfHochladen(id);
      }
    } catch (e) {
      console.warn("[Sync] PDF-Erstupload:", e.message);
    }
  }

  // Sicherheitsnetz: falls der Monkey-Patch einmal nicht greift (andere
  // Lade-Reihenfolge o.ae.), in Ruhe periodisch lokale PDFs abgleichen.
  function pdfPeriodischStarten() {
    if (pdfPeriodischLaeuft) return;
    pdfPeriodischLaeuft = true;
    setInterval(() => {
      if (!uid) return;
      // Patch nachziehen, falls index.html pdfDbAblegen spaeter definiert hat
      if (!window.__spesenPdfGepatcht) pdfPatchAnbringen();
      pdfErstPushRauf();
    }, 60000);
  }

  // Sichtbare Ordner-Ansichten in index.html neu rendern (Guards, falls die
  // Funktionen fehlen). Deckt die vier PDF-Ordner (Zeit/Urlaub/Jahr/Inventur) ab.
  function ordnerAuffrischen() {
    try {
      if (typeof window.ordnerAlleAuffrischen === "function") window.ordnerAlleAuffrischen();
    } catch (e) { /* nie fatal */ }
  }

  // Echter Wipe: ALLE Cloud-Dokumente dieses Kontos (pdfs + state) loeschen und
  // den lokalen Sync-Merker leeren. Wird von index.htmls testResetAlles() VOR
  // dem lokalen Loeschen aufgerufen, damit ein Reset nicht sofort wieder aus der
  // Cloud nachgeladen wird. Ohne Anmeldung passiert nichts.
  window.spesenSyncCloudLeeren = async function () {
    if (!uid || !db || !FS) return; // nicht angemeldet -> nichts tun
    try {
      for (const sammlung of ["pdfs", "state"]) {
        try {
          const coll = FS.collection(db, "users", uid, sammlung);
          const snap = await FS.getDocs(coll);
          const weg = [];
          snap.forEach((d) => weg.push(FS.deleteDoc(FS.doc(db, "users", uid, sammlung, d.id))));
          await Promise.all(weg);
        } catch (e) { console.warn("[Sync] Cloud-Leeren (" + sammlung + "):", e.message); }
      }
      cloudPdfIds.clear();
      // Lokale Sync-Merker leeren, damit nach dem Reset nichts "schon gesehen" ist
      _removeItem.call(localStorage, META_KEY);
      _removeItem.call(localStorage, "__sync_uid");
      _removeItem.call(localStorage, PDF_TOOBIG_KEY);
    } catch (e) {
      console.warn("[Sync] Cloud-Leeren fehlgeschlagen:", e.message);
    }
  };
})();
