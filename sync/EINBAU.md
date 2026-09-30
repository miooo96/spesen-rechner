# Einbau: Auto-Sync – Version „nur für mich"

> **Stand:** Der Code ist fertig und die eine Einbauzeile steht bereits in
> `index.html`. Trotzdem ist der Sync **aus**, solange keine echte
> `sync/firebase-config.js` vorhanden ist. Bis dahin verhält sich der
> Rechner exakt wie bisher – auch für alle anderen.
>
> Diese Fassung ist **auf Mirkos E-Mail verriegelt** (in `firestore.rules`).
> Selbst wenn sich jemand anders anmeldet, kann er nichts speichern oder
> lesen. Es ist damit ein reines Ein-Mann-Werkzeug – keine Datenschutz-
> Freigabe nötig, weil nur Ihre eigenen Daten betroffen sind.

Damit es läuft, fehlt genau **ein** Teil, den nur Sie machen können (Ihr
Google-Konto): das Firebase-Projekt anlegen. ~10 Minuten, einmalig.

---

## Ihre 6 Schritte

**1. Projekt anlegen**
https://console.firebase.google.com → mit Google anmelden → „Projekt
hinzufügen" → Name z. B. `spesen-rechner`. Analytics kann aus bleiben.

**2. Web-App registrieren**
Im Projekt auf **`</>`** klicken → Name z. B. „Spesen Web", **kein** Hosting.
Firebase zeigt einen `firebaseConfig`-Block (apiKey, projectId, …) → für
Schritt 5 brauchen.

**3. Anmeldung einschalten**
Links **Authentication** → „Los geht's" → Anbieter **E-Mail/Passwort**
öffnen → darin **„E-Mail-Link (ohne Passwort)"** aktivieren → speichern.
Dann **Authentication → Settings → Authorized domains** →
`hall-spesen-rechner.de` eintragen.

**4. Datenbank einschalten (EU!)**
Links **Firestore Database** → „Datenbank erstellen" → Standort
**`europe-west3` (Frankfurt)** → Produktionsmodus.
Reiter **Rules** → Inhalt von `sync/firestore.rules` einfügen →
**Veröffentlichen**. (Dort steht schon Ihre E-Mail als Schloss.)

**5. Konfiguration hinterlegen**
`sync/firebase-config.example.js` kopieren zu `sync/firebase-config.js` und
die „DEIN_…"-Platzhalter durch die echten Werte aus Schritt 2 ersetzen.

**6. Fertig – es läuft.**
Die Einbauzeile steht schon in `index.html`. Sobald `firebase-config.js`
echte Werte hat, erscheint unten rechts „☁︎ Anmelden".

---

## Damit es auf hall-spesen-rechner.de funktioniert

Ihre `firebase-config.js` ist bewusst per `.gitignore` vom Hochladen
ausgenommen – damit Ihre Projektwerte nicht **versehentlich** öffentlich
werden. Zum Ausprobieren auf einem Gerät reicht das lokal.

**Wenn Sie den Sync auf der echten Adresse (Handy + PC) nutzen wollen**,
muss `firebase-config.js` mit hochgeladen (deployt) werden. Das ist bei
Firebase üblich und sicher: Der `apiKey` ist **kein Geheimnis** – der Schutz
liegt in der Regel (Schritt 4), die nur Ihr Konto zulässt. Sagen Sie
Bescheid, wenn Sie so weit sind; ich nehme die Datei dann bewusst von der
Ignorier-Liste und lade sie mit hoch. Ich mache das **nicht von selbst**,
weil „hochladen/veröffentlichen" Ihre Entscheidung ist.

---

## Testen (der Pflicht-Teil)
Mit zwei echten Geräten, angemeldet mit **derselben** E-Mail:
1. Unten rechts „☁︎ Anmelden" → E-Mail → Login-Link **auf dem Gerät** öffnen → Marke wird grün.
2. Gerät A: Arbeitszeit eintragen → taucht auf Gerät B nach wenigen Sekunden auf.
3. Gerät B offline schalten, etwas ändern, wieder online → geht von allein hoch.
4. Monat einreichen → bleibt auf beiden gesperrt.

## Wieder abschalten
`sync/firebase-config.js` löschen **oder** die Zeile
`<script type="module" src="sync/firebase-sync.js"></script>` aus
`index.html` entfernen. Danach ist alles wieder rein lokal, ohne Datenverlust.

## Nicht mit dabei
„Neue Ware zählen" und die im Tool abgelegten **PDFs** (kommen als Version 2
über Firebase Storage). Für die PDFs bis dahin weiter „Backup speichern".
