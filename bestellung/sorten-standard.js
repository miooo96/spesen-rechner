/* Sortentabelle Tour 12 - Grundbestand.
 *
 * Quelle: "Warenbedarfsrechnung 100%", Tour 12, Zeitraum 17.08.2026 -
 * 23.08.2026. Uebertragen am 06.09.2026 und GEGEN DIE PRUEFSUMME DES
 * VORDRUCKS nachgerechnet - die Fusszeile nennt vier Summen, alle vier
 * stimmen mit den uebertragenen Zeilen ueberein:
 *
 *     Zeilen  46 + 14 = 60            Fusszeile ** 60 **
 *     WKN     2239 + 584 = 2823       Fusszeile 2823
 *     Pack.   9830 + 1805 = 11635     Fusszeile 11635,00
 *     Stg     902 + 218 = 1120        Fusszeile 1120
 *     EUR     103790 + 20592 = 124382 Fusszeile 124382,00
 *
 * Ein Zahlendreher haette mindestens eine dieser Summen gekippt.
 *
 * PREIS = EUR / Stg, also der Preis je Stange. Er entspricht dem KVP im
 * Inventurblatt. Gegenprobe mit der Liste einer anderen Woche
 * (31.08.-06.09.): 060 -> 80,00 in beiden, 890 -> 100,00 in beiden,
 * 953 -> 84,00 in beiden. Die Preise sind ueber Wochen stabil.
 *
 * Alle 60 Preise sind glatte Betraege (75, 80, 84, 90, 95, 96, 100, 104,
 * 120, 180, 200). Ein Lesefehler haette fast zwangslaeufig einen krummen
 * Wert erzeugt - auch das spricht fuer die Uebertragung.
 *
 * ps  = Packungen je Stange (Spalte "P/St")
 * wgr = Warengruppe, leer wo der Vordruck nichts nennt
 *
 * DIESE DATEI IST NUR DER GRUNDBESTAND. Gearbeitet wird mit der Fassung im
 * Geraetespeicher; die Sortenzahl schwankt (60 in dieser Woche, 56 in der
 * anderen), also muss sie wachsen und schrumpfen koennen.
 */
(function () {
  "use strict";

  var SORTEN_STANDARD = [
    { nr: "018", kuerzel: "JPF10", art: "09988", wgr: "1", ps: 8,  preis: 80 },
    { nr: "020", kuerzel: "10LBL", art: "09412", wgr: "1", ps: 12, preis: 120 },
    { nr: "060", kuerzel: "10PMR", art: "01827", wgr: "1", ps: 8,  preis: 80 },
    { nr: "068", kuerzel: "10LMB", art: "09515", wgr: "1", ps: 8,  preis: 80 },
    { nr: "078", kuerzel: "10LMR", art: "09518", wgr: "1", ps: 8,  preis: 80 },
    { nr: "086", kuerzel: "10GBG", art: "09479", wgr: "1", ps: 8,  preis: 80 },
    { nr: "105", kuerzel: "12PRD", art: "09510", wgr: "1", ps: 8,  preis: 96 },
    { nr: "141", kuerzel: "10PMB", art: "01828", wgr: "1", ps: 8,  preis: 80 },
    { nr: "207", kuerzel: "15MRD", art: "09450", wgr: "",  ps: 8,  preis: 120 },
    { nr: "292", kuerzel: "10JPR", art: "09490", wgr: "",  ps: 8,  preis: 80 },
    { nr: "298", kuerzel: "10EYR", art: "12125", wgr: "1", ps: 8,  preis: 80 },
    { nr: "339", kuerzel: "15MGO", art: "09451", wgr: "",  ps: 8,  preis: 120 },
    { nr: "350", kuerzel: "10CFI", art: "06069", wgr: "1", ps: 10, preis: 100 },
    { nr: "379", kuerzel: "WRD10", art: "00454", wgr: "",  ps: 10, preis: 100 },
    { nr: "397", kuerzel: "9CAYE", art: "00406", wgr: "1", ps: 10, preis: 90 },
    /* ArtNr. 00454 steht bei 379 UND 398 - vermutlich eine der beiden
       falsch gelesen. Die Pruefsumme faengt das nicht, weil
       Artikelnummern nicht aufsummiert werden. Von Mirko zu bestaetigen. */
    { nr: "398", kuerzel: "9WIRD", art: "00454", wgr: "",  ps: 10, preis: 90,  pruefen: true, auslauf: true },
    { nr: "423", kuerzel: "75TRU", art: "10407", wgr: "",  ps: 10, preis: 75,  auslauf: true },
    { nr: "424", kuerzel: "8TTUR", art: "09292", wgr: "",  ps: 10, preis: 80 },
    { nr: "425", kuerzel: "75TAM", art: "10401", wgr: "",  ps: 10, preis: 75,  auslauf: true },
    { nr: "426", kuerzel: "75TUR", art: "10405", wgr: "",  ps: 10, preis: 75,  auslauf: true },
    { nr: "427", kuerzel: "75TSI", art: "10404", wgr: "",  ps: 10, preis: 75,  auslauf: true },
    { nr: "428", kuerzel: "8TAMB", art: "09171", wgr: "",  ps: 10, preis: 80 },
    { nr: "429", kuerzel: "8TSIE", art: "09172", wgr: "",  ps: 10, preis: 80 },
    { nr: "447", kuerzel: "95PAL", art: "00183", wgr: "1", ps: 10, preis: 95 },
    { nr: "470", kuerzel: "MRD10", art: "08459", wgr: "1", ps: 20, preis: 200 },
    { nr: "471", kuerzel: "MGO10", art: "08460", wgr: "1", ps: 20, preis: 200 },
    { nr: "472", kuerzel: "MMX10", art: "08368", wgr: "1", ps: 20, preis: 200 },
    { nr: "478", kuerzel: "12LMR", art: "09906", wgr: "",  ps: 8,  preis: 96 },
    { nr: "490", kuerzel: "LMRD9", art: "06280", wgr: "1", ps: 20, preis: 180 },
    { nr: "491", kuerzel: "LMBL9", art: "01822", wgr: "1", ps: 20, preis: 180 },
    { nr: "500", kuerzel: "12MRD", art: "06085", wgr: "",  ps: 8,  preis: 96 },
    { nr: "501", kuerzel: "12MGO", art: "06086", wgr: "",  ps: 8,  preis: 96 },
    { nr: "502", kuerzel: "MMX12", art: "08198", wgr: "",  ps: 8,  preis: 96 },
    { nr: "605", kuerzel: "LRD13", art: "17033", wgr: "1", ps: 8,  preis: 104 },
    { nr: "610", kuerzel: "10PAU", art: "09546", wgr: "1", ps: 8,  preis: 80 },
    { nr: "620", kuerzel: "10HB",  art: "00401", wgr: "1", ps: 20, preis: 200 },
    { nr: "621", kuerzel: "10PRI", art: "00445", wgr: "1", ps: 20, preis: 200 },
    { nr: "660", kuerzel: "12VBI", art: "13165", wgr: "",  ps: 1,  preis: 12 },
    { nr: "661", kuerzel: "12VPI", art: "13166", wgr: "",  ps: 1,  preis: 12 },
    { nr: "700", kuerzel: "LRD10", art: "06882", wgr: "1", ps: 20, preis: 200 },
    { nr: "701", kuerzel: "LAR10", art: "17034", wgr: "1", ps: 20, preis: 200 },
    { nr: "805", kuerzel: "10STY", art: "00411", wgr: "1", ps: 10, preis: 100 },
    { nr: "806", kuerzel: "10R1B", art: "00443", wgr: "1", ps: 10, preis: 100 },
    { nr: "820", kuerzel: "10JPB", art: "06032", wgr: "1", ps: 8,  preis: 80 },
    { nr: "830", kuerzel: "DDGO9", art: "00440", wgr: "1", ps: 10, preis: 90 },
    { nr: "831", kuerzel: "DDCL9", art: "00459", wgr: "1", ps: 10, preis: 90 },
    { nr: "842", kuerzel: "10WTR", art: "00463", wgr: "1", ps: 10, preis: 100 },
    { nr: "843", kuerzel: "10WTS", art: "00467", wgr: "1", ps: 10, preis: 100 },
    { nr: "850", kuerzel: "GBL12", art: "12075", wgr: "",  ps: 8,  preis: 96 },
    { nr: "851", kuerzel: "GRD12", art: "12076", wgr: "",  ps: 8,  preis: 96 },
    { nr: "890", kuerzel: "GBR10", art: "06080", wgr: "1", ps: 10, preis: 100 },
    { nr: "891", kuerzel: "GBL10", art: "08199", wgr: "1", ps: 10, preis: 100 },
    { nr: "892", kuerzel: "10GLI", art: "06115", wgr: "1", ps: 10, preis: 100 },
    { nr: "900", kuerzel: "JPRD9", art: "00432", wgr: "1", ps: 10, preis: 90 },
    { nr: "901", kuerzel: "JPBL9", art: "01066", wgr: "1", ps: 10, preis: 90 },
    { nr: "950", kuerzel: "15GBL", art: "09445", wgr: "",  ps: 6,  preis: 90 },
    { nr: "951", kuerzel: "15GRD", art: "09446", wgr: "",  ps: 6,  preis: 90 },
    { nr: "953", kuerzel: "14JPR", art: "06078", wgr: "1", ps: 6,  preis: 84 },
    { nr: "972", kuerzel: "9DGSL", art: "00126", wgr: "1", ps: 10, preis: 90 },
    { nr: "989", kuerzel: "9VBLU", art: "12142", wgr: "",  ps: 10, preis: 90 }
  ];

  if (typeof module !== "undefined" && module.exports) module.exports = SORTEN_STANDARD;
  else window.SORTEN_STANDARD = SORTEN_STANDARD;
})();
