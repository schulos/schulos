# Modul Schulbücherei (`buecherei`)

Freigegeben von der Projektleitung am 2026-10-19 (Konzept ausgearbeitet 2026-10-17). Aufgaben: `docs/BACKLOG.md`,
Block „Schulbücherei“ (BU-xx). Dieses Dokument hält Umfang, Datenmodell, Rechte, Datenschutz und Entscheidungen fest.

## Ziel

Ein Modul für die **Bücherei/Mediothek** (Stufe 1) und die **Schulbuchausleihe/Lernmittel** (Stufe 2, per Moduleinstellung
`buecherei.lernmittel` zuschaltbar – manche Schulen haben nur das eine oder das andere).

| Rolle | Nutzen |
|---|---|
| Schüler:innen | Katalog durchsuchen, eigene Ausleihen mit Rückgabedatum, vormerken, verlängern; Schulbücher des Jahres |
| Eltern | Ausleihen und Schulbücher ihrer Kinder (nur lesend), Rückgabe-/Ersatzhinweise |
| Lehrkräfte | wie Schüler:innen; Klassensätze; Klassenleitung sieht offene Schulbücher der Klasse |
| Büchereiteam (Gruppe) | Theke: Ausleihe/Rückgabe per Hand-Scanner, Mahnliste |
| Verwaltung | Bestand, Schulbuchausleihe je Jahrgang, Ersatzforderungen, offene Posten bei Abgang |
| Schulleitung | Bestands- und Ausleihzahlen ohne Personenbezug |

## Umfang

**Stufe 1 – Bücherei/Mediothek:** Bestand (Titel + Exemplare), Erfassung von Hand, CSV-Import und optional per ISBN-Abfrage;
Theke (Ausweis- oder Personensuche → Exemplare scannen, Rückgabe nur scannen), Leihfrist je Medienart, Verlängern;
Katalog/Suche, Vormerkung; Erinnerung, Mahnstufen, Mahnliste, Widgets; Etiketten und Ausweise drucken; Statistik ohne Personenbezug.

**Stufe 2 – Schulbuchausleihe:** Lernmittel je Jahrgang/Fach, Bücherliste für Eltern, klassen-/kursweise Ausgabe und Rücknahme
mit Zustand, Ersatzforderungen (nur erfassen + Brief), Anbindung Schuljahreswechsel (B-08) und Abgang (B-02).

**Ausdrücklich nicht:** Verbundkatalog/Fernleihe, Datenaustausch mit Fremdsystemen, Zahlungsabwicklung, Säumnisgebühren,
Leseempfehlungen aus dem Ausleihverhalten (Profilbildung), Kamera-Scan in der PWA (spätere Ausbaustufe), Direktdruck vom Server.

## Datenmodell (Präfix `buecherei_`)

| Tabelle | Inhalt | Aufgabe |
|---|---|---|
| `buecherei_titles` | Titel, Autor:in, ISBN, Verlag, Jahr, Schlagwörter, Altersempfehlung, Medienart (Buch/Film/Spiel/Gerät/Sonstiges) | BU-01 |
| `buecherei_copies` | Exemplarnummer (= Barcode, Präfix + laufende Nummer + Prüfziffer), Signatur, Standort, Zustand, ausgesondert; Etikett gedruckt am, Zahl der Ausleihen und Monat der letzten (ohne Person) | BU-01/05 |
| `buecherei_loans` | Exemplar, Person, ausgeliehen, fällig, zurück, Verlängerungen, Mahnstufe (BU-04: Stufe, letzte Mahnung, erinnerte Fälligkeit); Personenbezug wird bei Rückgabe ohne Befund entfernt | BU-02/04 |
| `buecherei_cards` | pseudonymer Ausweis-Code je Konto (zufällig, bei Verlust neu = alter ungültig) | BU-07 |
| `buecherei_reservations` | Vormerkung Titel ↔ Person | BU-03 |
| `buecherei_stats` | Zähler ohne Personenbezug (Ausleihen, Verlängerungen, Mahnungen je Monat/Medienart) | BU-02/04/05 |
| `buecherei_teaching_materials`, `buecherei_compensations` | Lernmittel ↔ Jahrgang/Fach, Ersatzforderungen | Stufe 2 |

## Rechte

| Recht | Inhalt | Vorgabe |
|---|---|---|
| `buecherei.use` | Katalog, eigene Ausleihen, vormerken, verlängern | alle Rollen außer Eltern und Admin (schueler, lehrkraft, personal, beratung, verwaltung); Eltern lesen über die Eltern-Kind-Zuordnung |
| `buecherei.desk` | Theke: verbuchen; sieht nur Name, Klasse, offene Ausleihen – keine Historie, keine Mahnstufen anderer | Gruppe „Büchereiteam“ |
| `buecherei.stock` | Titel/Exemplare, Import, Aussondern, Etiketten | verwaltung, Büchereiteam |
| `buecherei.materials` | Schulbuchausleihe, Ersatzforderungen (Stufe 2), Befunde bei der Rückgabe (mit Namen) sehen und erledigen | verwaltung |

## Datenschutz

- Leseverhalten ist persönlich → **Personenbezug einer Ausleihe wird bei Rückgabe ohne Befund sofort entfernt**, nur anonyme
  Zähler bleiben; kein Ausleihverlauf je Person. Schadensfälle/Ersatzforderungen bis zur Erledigung + `LK-SJ-1J`.
- Bestand (Titel, Exemplare) hat keinen Personenbezug; Zustandsvermerke ohne Namen.
- Vormerkungen mit der Ausleihe bzw. `LK-90`; Ausweis-Code gehört zum Konto (`LK-KONTO`). Vormerken nur bei ganz ausgeliehenen
  Titeln; Abholfrist (Vorgabe 1 Woche) danach rückt die nächste nach; andere sehen nur die Zahl, nie Namen; der Gong nennt keinen Titel.
- „Meine Ausleihen“ zeigt nur Aktuelles (offene Ausleihen, Vormerkungen) – keinen Verlauf.
- Erinnerung und Mahnungen (BU-04) nennen keinen Titel (Benachrichtigung und Mail), nur „Meine Ausleihen“ nach der Anmeldung.
  Die Mahnstufe hängt an der offenen Ausleihe und endet mit Rückgabe oder Verlängern; Mahnungen werden nur je Monat und
  Medienart gezählt. Eltern ab der 2. Stufe nur bei Minderjährigen (Zuordnung „handelt für“, nicht bei Eigenständigen – auch
  nicht mit Einwilligung „Eltern informieren“: eine Mahnung fordert zum Handeln auf, das tut dann die Person selbst).
  Mahnliste fürs Team: Mahnstufen nur für Erwachsene, Schüler-Helfer:innen sehen nur „fällig seit“.
- Schulbuchausleihe: Zuordnung Exemplar ↔ Person nur im laufenden Schuljahr, nach Rücknahme entkoppelt.
- Abgang: offene Ausleihen blockieren die Löschung nicht, erscheinen aber als Hinweis.
- Auskunft (Art. 15) und Eigenexport: eigene offene Ausleihen, Vormerkungen, Forderungen.
- Externe ISBN-Abfrage überträgt nur die ISBN; Vorgabe aus, im VVT als Empfänger genannt. Umgesetzt (BU-06): Schalter
  `buecherei.isbn` und je Quelle `buecherei.isbn_dnb`, `_lobid`, `_openlibrary` (nur mit `verwaltung.privacy`; GATE BU1: ab Werk nur
  die beiden deutschen Kataloge, Open Library – Empfänger außerhalb der EU – ab Werk aus), Zeitlimit 5 s,
  Zwischenspeicher im Arbeitsspeicher, Dublette ohne Anfrage nach außen, Hinweis „Externer Dienst“ vor dem Nachschlagen.

## Entscheidungen (Projektleitung 2026-10-17, Freigabe 2026-10-19)

1. Ein Modul, Stufe 2 per Schalter `buecherei.lernmittel`.
2. Personenbezug bei Rückgabe ohne Befund sofort entfernen; Ausnahme Schadensfälle bis zur Erledigung.
3. Theke auch für Schüler-Helfer:innen über die Gruppe „Büchereiteam“ (sehen nur Name, Klasse, offene Ausleihen).
4. Elternmahnung: Bücherei ab der 2. Mahnstufe an Eltern Minderjähriger, Schulbücher von Anfang an.
5. Externe ISBN-Abfrage anbieten, Vorgabe aus; Quellen öffentliche Bibliothekskataloge (Nationalbibliothek per SRU,
   Verbundkatalog eines Hochschulbibliothekszentrums, eine offene Online-Bibliothek), einzeln abschaltbar, nur serverseitig.
6. Ersatzforderungen nur erfassen und Brief erzeugen, keine Zahlungen.
7. Ausweis-Code direkt in Stufe 1 (BU-07).
8. Eigener Block nach INST-08, Stufe 1 zuerst; je Stufe ein Gate mit Review.
9. Labeldruck: A4-Etikettenbögen und Etikettendrucker über den Browserdruck (`@page` in mm, Code 128 als selbst erzeugtes SVG,
   kein PDF-/Barcode-Paket), kein Direktdruck vom Server.
10. Cover nur als eigenes Foto (Upload mit Virenscan), kein externer Abruf.

## Entschieden durch Projektleitung 19.10.2026 (BU-03)

11. Befunde (Rückgaben mit Schaden, mit Namen) sehen und erledigen nur Inhaber von `buecherei.materials` (ab Werk Verwaltung),
    nicht das Büchereiteam.
12. Ausleihen dürfen alle Rollen außer Eltern und Admin (`buecherei.use` ab Werk für Schüler:innen, Lehrkräfte, weiteres
    Personal, Beratung und Verwaltung).

## GATE BU1 – Prüfliste Stufe 1 (2026-10-20)

Umfang: BU-01, BU-02, BU-07, BU-03, BU-04, BU-05, BU-06 (PRs #24, #26, #28, #30, #34, #36, #38), Migrationen 0087, 0089–0091,
0093, 0095; SICHERHEIT S73–S78; DSB-FRAGEN §18. Abnahme: Review-PR, nach grüner CI vom Agenten gemerged (Projektleitung
2026-10-19: Gate-PRs bis auf Widerruf).

| # | Prüfpunkt | Ergebnis |
|---|---|---|
| 1 | Nach Rückgabe ohne Befund sind alle Personendaten weg | ✅ Querschnittstest `gate-bu1.test.ts`: nach Vormerkung, Ausleihe, Erinnerung, 2. Mahnung (Eltern + Mail), Rückgabe, Nachrücken, Ausleihe an die Vormerkende und deren Rückgabe nennt keine Zeile einer `buecherei_*`-Tabelle die Personen – einzige Ausnahme der Ausweis (`buecherei_cards`: nur Konto, Code, angelegt am; `LK-KONTO`). Exemplar nur `loan_count`/`last_loan_month`, Zähler nur Monat/Medienart/Zahlen, kein Audit-Eintrag zu Ausleihe/Rückgabe. Dazu `loans.test.ts`, `statistik.test.ts`, `mahnungen.test.ts` |
| 2 | Schüler-Helfer:innen sehen keine Mahnstufen und keine Befunde | ✅ `mahnungen.test.ts` „S76 …“ (Theke ohne Stufe, Mahnliste/Widget ohne Stufe für die Rolle Schüler:in), `loans.test.ts` „Rückgabe mit Befund …“ (Befunde nur `buecherei.materials`, Helfer:in `ForbiddenError`); Code-Review Seiten Theke/Mahnliste/Widget |
| 3 | Gong, Benachrichtigungen und Mails nennen nie einen Titel | ✅ `mahnungen.test.ts` (Erinnerung, Stufen 1–3, Eltern, Mail), `katalog.test.ts` (Vormerkung bereit), `gate-bu1.test.ts` (alle Bücherei-Gongs und -Mails eines Durchlaufs); Code-Review: alle fünf `notify`/`enqueueMail`-Stellen nutzen feste Texte |
| 4 | ISBN-Abfrage ab Werk aus, nur mit `verwaltung.privacy`, nur die ISBN nach außen | ✅ `isbn.test.ts` (Vorgabe aus, Recht je Schalter, nur ISBN in der Adresse, keine Cookies, Dublette ohne Anfrage), E2E BU-06 |
| 5 | Open Library (außerhalb der EU) ab Werk aus | ✅ **umgestellt** (Entscheidung G-BU1-02, datensparsam): ab Werk nur Deutsche Nationalbibliothek und Verbundkatalog; Open Library einzeln zuschaltbar (dann als letzte Quelle), Hinweis „außerhalb der EU“ an der Einstellung. Test `isbn.test.ts` „GATE BU1 …“, E2E BU-06; VVT, DATENSCHUTZ §3.4, DSB-FRAGEN §18, SICHERHEIT S78, INSTALLATION §8.2 nachgezogen |
| 6 | Code-Review `isbn.ts`, `loans.ts`, `mahnungen.ts` | ✅ ein echter Fehler behoben: **G-BU1-01** gleichzeitiges Verbuchen desselben Exemplars (zwei Theken, Doppelscan) endete als Serverfehler (Verletzung des eindeutigen Index) → jetzt Meldung „wurde gerade ausgeliehen“, genau eine Ausleihe, Zähler einmal (Test in `gate-bu1.test.ts`, ohne Fix rot). Sonst ohne Befund: Rechte in jedem Service, Mahnstufe/Verlängern/Vormerken mit bedingtem UPDATE bzw. eindeutigem Index, Termine als Berliner Datum, Fristen auf Schultage verschoben, Mahnungen nur an Schultagen; ISBN nur feste HTTPS-Ziele, Zeitlimit gesamt, Fehler → „nicht erreichbar“. Hinweise ohne Handlungsbedarf: Antwortgröße wird nach dem Lesen geprüft (begrenzt durch das Zeitlimit); eine gleichzeitige Rückgabe zweier Exemplare kann eine Vormerkung zu viel „bereit“ setzen (harmlos, die Theke prüft beim Ausleihen erneut) |
| 7 | Volle Tests | ✅ `npm run check` grün (2140 Vitest in 293 Dateien), Build grün, volle E2E: 275 bestanden, 1 übersprungen; 3 Ausfälle unter Last (`offline-notenbuch.spec.ts:51` mit 5 Folgetests, `pinnwaende.spec.ts:4/56` – Anmeldung lief ins Zeitlimit, drei Agenten parallel) auf frisch geseedeter DB einzeln nachgeprüft: 9/9 grün, ohne Bezug zur Bücherei; CI grün (Gate-PR) |
| 8 | Nur auf echter Hardware prüfbar | ⏳ offen für die Projektleitung, blockiert das Gate nicht: echtes Etikettenblatt (A4-Bogen) und Ausweiskarte drucken und mit einem Handscanner scannen (Code 128, Prüfziffer); Format am Etikettendrucker (62 × 29 / 54 × 25 mm, Browserdruck ohne Ränder) |
| 9 | Modul ab Werk aus | ✅ bleibt so (`defaultEnabled: false`): Die Bücherei verarbeitet Ausleihen mit Personenbezug, braucht ein Büchereiteam und eine Belehrung (Baustein §18) – Schulen schalten sie bewusst ein; der Plan sagt nichts anderes |
| 10 | Offene DSB-Fragen §18 | ⏳ bleiben offen, blockieren das Gate nicht: Schüler-Helfer:innen an der Theke (Belehrung genügt?), Eltern sehen Vormerkungen Minderjähriger, Elternmahnung ab Stufe 2, Mail-Mahnung ab Werk aus, Open Library zuschaltbar? |

Für Stufe 2 (BU-10 ff.): Schulbücher haben eine eigene Zuordnung Exemplar ↔ Person im laufenden Schuljahr (nicht die
Ausleihe der Stufe 1); Elternmahnung bei Schulbüchern von Anfang an (Entscheidung 4); Befunde/Ersatzforderungen hängen an
`buecherei.materials` – die Rückgaben mit Befund aus Stufe 1 sind ihr Ausgangspunkt.
