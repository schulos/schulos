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
| `buecherei_teaching_materials` | Lernmittel: Titel, ISBN, Verlag, Fach, Jahrgänge, Kurs/Zweig, „leiht die Schule aus“/„selbst kaufen“, Preis, archiviert – ohne Personenbezug | BU-10 |
| `buecherei_material_copies` | Lernmittel-Exemplar: Inventarnummer `L-…` (eigener Nummernkreis, Prüfziffer), Zustand + Vermerk zur Sache, Anschaffungsjahr, ausgesondert – ohne Personenbezug | BU-10 |
| `buecherei_booklists` | Bücherliste je Jahrgang: Hinweistext für Eltern, freigegeben ja/nein – ohne Personenbezug | BU-10 |
| `buecherei_material_issues` | Schulbuch-Ausgabe: Exemplar ↔ Person mit Schuljahr (`school_year_id`), ausgegeben am, zurück bis (Schuljahresende), Mahnstufe; Rücknahme ohne Befund löscht die Zeile, mit Befund bleibt sie bis zur Erledigung | BU-11 |
| `buecherei_compensations` | Ersatzforderung: Person, Quelle (Ausleihe-Befund oder Schulbuch-Ausgabe), Gegenstand als Text, Grund, Betrag, Status offen/bezahlt/erlassen, Brief gedruckt am | BU-12 |

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
- Schulbuchausleihe: Zuordnung Exemplar ↔ Person nur im laufenden Schuljahr, nach Rücknahme entkoppelt (Löschregel unten,
  „Stufe 2 – Festlegungen“). Lernmittel, Exemplare und Bücherlisten (BU-10) haben keinen Personenbezug; die Bücherliste lesen
  alle mit Bücherei-Zugang und Eltern, aber nur freigegebene Jahrgänge.
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

## Stufe 2 – Festlegungen (BU-10, 2026-10-20)

Datensparsam vorbelegt bei der Umsetzung; Abweichungen entscheidet die Projektleitung (offene Fragen in DSB-FRAGEN §18).

1. **Eigene Datenhaltung:** Lernmittel und ihre Exemplare stehen in eigenen Tabellen (Inventarnummer `L-…`, eigener
   Nummernkreis) – nicht im Bestand der Bücherei. Katalog, Theke, Mahnungen und Statistik der Stufe 1 sehen sie nicht.
2. **Schalter:** `buecherei.lernmittel` ab Werk aus; ausgeschaltet verschwinden Seiten und Reiter, gespeicherte Lernmittel bleiben.
3. **Bücherliste:** je Jahrgang ein Hinweistext und eine Freigabe; Lernmittel mit „selbst kaufen“ erscheinen mit Preis und
   Summe (nur Information, keine Zahlungen). Entwürfe sieht nur, wer Lernmittel pflegt (`buecherei.materials`).
4. **Löschregel für die Zuordnung Exemplar ↔ Person (gilt ab BU-11):** Sie gehört zum laufenden Schuljahr (`school_year_id`).
   Rücknahme **ohne** Befund löscht die Zeile sofort (wie Stufe 1: kein Verlauf, nur Zähler ohne Person). Rücknahme **mit**
   Befund bleibt bis zur Erledigung der Ersatzforderung (BU-12), danach `LK-SJ-1J`. Nicht zurückgegebene Schulbücher bleiben
   über das Schuljahresende nur als offener Posten (Prüfschritt im Schuljahreswechsel, BU-13) und gehen spätestens mit dem
   Konto (`LK-KONTO`, Kontolöschung leert die Person). Querschnittstest dazu in BU-11 (Gegenstück zu `gate-bu1.test.ts`);
   BU-10 prüft in `lernmittel.test.ts`, dass Lernmittel, Exemplare und Bücherlisten keine Personenspalten haben.
5. **Elternmahnung bei Schulbüchern von Anfang an** (Entscheidung 4) – wie Stufe 1 nur bei Minderjährigen über „handelt für“,
   ohne Titel; umgesetzt mit BU-11 (Mahnung nach Ablauf der Rückgabefrist, Stufen 1–3 im Abstand der Bücherei, Mail optional).
   Der Elternbrief zur Ersatzforderung folgt mit BU-12.

## Stufe 2 – Ausgabe und Rücknahme (BU-11, 2026-10-20)

- **Rückgabefrist** = Ende des Schuljahres der Ausgabe (`school_years.ends_on`, beim Ausgeben in `due_on` festgehalten). Gemahnt
  wird erst danach und nur an Schultagen – in der Praxis also ab dem ersten Schultag des neuen Schuljahres (offene Frage in
  DSB-FRAGEN §18: eigener Rückgabetag vor den Sommerferien?).
- **Ausgabe** unter „Schulbuchausgabe“ (`/buecherei/ausgabe`, nur `buecherei.materials`): Klasse oder Kurs wählen (Klassen,
  Kurse, Wahlpflicht), die Liste zeigt je Schüler:in ausgegebene Schulbücher und was laut Lernmitteln des Jahrgangs (nur
  „leiht die Schule aus“, bei Kursen mit Fach nur dieses Fach) noch fehlt. Person per Klick oder Büchereiausweis wählen, dann
  Inventarnummern scannen. Je Person und Schuljahr höchstens ein Exemplar je Lernmittel (Doppelscan).
- **Rücknahme** nur scannen (ohne Person zu wählen); vorher optional Zustand, Zustandsvermerk (Sache, keine Namen) oder Befund
  wählen – Zustand/Vermerk landen am Exemplar, der Befund an der Ausgabe (bis zur Erledigung, Liste „Offene Befunde“).
- **Offene Posten aus früheren Schuljahren** bleiben an der Person sichtbar („aus dem Vorjahr“) und lassen sich wie immer
  zurücknehmen; ein Schuljahr mit Ausgaben lässt sich nicht löschen. Den Prüfschritt im Schuljahreswechsel bringt BU-13.
- **Theke der Stufe 1** erkennt `L-`-Nummern und verweist auf die Schulbuchausgabe; umgekehrt weist die Ausgabe `B-`-Nummern ab.
- Ausgabe/Rücknahme im Audit-Log nur mit Inventarnummer, ohne Person (Nachweis über den Bestand, kein Verlauf je Person).
- Nicht umgesetzt (für später notiert): Klassenleitung sieht offene Schulbücher der Klasse (Rollen-Tabelle oben) – braucht
  eine eigene Freigabe, weil Lehrkräfte bisher keine Bücherei-Daten anderer sehen.

## Stufe 2 – Ersatzforderungen (BU-12, 2026-10-20)

- **Nur erfassen und Brief** (Entscheidung 6): Betrag, Grund, Status offen/bezahlt/erlassen – keine Zahlungsdaten, keine
  Bankverbindung im Brief, keine Säumnisgebühren. Wie bezahlt wird, sagt das Sekretariat; gleichwertiger Ersatz ist möglich.
- **Ausgangspunkt:** Befunde aus Rückgaben der Bücherei (Stufe 1), Schulbuch-Rücknahmen mit Befund und Schulbücher nach Ablauf
  der Rückgabefrist (Verlust). Je Befund höchstens eine Forderung; der Verlust schließt die Ausgabe mit Befund ab (die Mahnung
  endet) und sondert das Exemplar aus. Vorschlag für den Betrag: Preis des Lernmittels (Bücherei-Titel haben keinen Preis).
- **Abschluss:** bezahlt oder erlassen erledigt den Befund; danach gehen Forderung und Befund nach `LK-SJ-1J`. „Wieder öffnen“
  nimmt beides zurück. Offene Forderungen bleiben bis zum Abschluss und gehen spätestens mit dem Konto (Person geleert).
- **Brief** (`/druck/buecherei-ersatz`): an die Eltern Minderjähriger (über „handelt für“, alle Elternteile mit Namen), sonst an
  die Person selbst; Browserdruck (auch als PDF). Das Öffnen vermerkt „Brief gedruckt am“ (und steht im Audit-Log).
- **Sicht:** nur `buecherei.materials`; Person und Eltern sehen offene Forderungen unter „Meine Ausleihen“. Seit BU-15
  (2026-10-26) unabhängig von der Schulbuchausleihe: Befunde der Bücherei (Stufe 1) lassen sich auch ohne Stufe 2 fordern; die
  Schulbuch-Quellen (Rücknahme mit Befund, Verlust) bleiben an den Schalter gebunden.
- **Hinweis im Ersatzbrief** (BU-17): Freitext der Schule (bis 600 Zeichen, nur die Sache, keine Namen) auf `/buecherei/ersatz`;
  steht im Brief unter Betrag und Grund, leer = nichts.
- **Rückgabetag der Schulbücher** (BU-14): je Schuljahr auf `/buecherei/ausgabe` einstellbar (nicht vor heute, höchstens
  Schuljahresende), leer = Schuljahresende. Fälligkeit neuer und bereits ausgegebener Schulbücher des Schuljahres und der
  Mahnlauf folgen dem Tag; er steht bei der Ausgabe und unter „Meine Ausleihen“. Beide Einstellungen liegen ohne Migration in
  `app_settings` und haben keinen Personenbezug.

## Stufe 2 – Schuljahreswechsel und Abgang (BU-13, 2026-10-20)

- **Schuljahreswechsel (B-08):** Der Pflichtschritt „Löschprotokoll und Sperren prüfen“ zeigt, wie viele Schulbücher aus dem
  endenden Schuljahr noch nicht zurück sind (Personen, davon vorgemerkte Abgänger:innen) und wie viele Ersatzforderungen offen
  sind – nur Zahlen, mit Links zur Schulbuchausgabe und zu den Ersatzforderungen. Der Wechsel wird nicht aufgehalten; offene
  Schulbücher bleiben als offener Posten an der Person und werden ab dem ersten Schultag gemahnt.
- **Abgang (B-02):** Die Benutzer-Detailseite (Abgangsdialog) nennt offene Bücherei-Posten der Person („2 Ausleihen,
  1 Schulbuch, 1 offene Ersatzforderung“) als Hinweis. Abgang und Löschung laufen weiter (Festlegung „Abgang“ oben); mit der
  Kontolöschung verlieren Ausleihe, Ausgabe und Forderung die Person.
- Beides nur bei eingeschalteter Bücherei; Schulbücher und Forderungen nur mit eingeschalteter Schulbuchausleihe.

## GATE BU2 – Prüfliste Stufe 2 (2026-10-20)

Umfang: BU-10, BU-11, BU-12, BU-13 (PRs #47, #49, #52, #53), Migrationen 0097–0099; SICHERHEIT S81–S83; DSB-FRAGEN §18.
Abnahme: Review-PR, gemerged von der Projektleitung.

| # | Prüfpunkt | Ergebnis |
|---|---|---|
| 1 | Löschregel Stufe 2: Zuordnung nur im laufenden Schuljahr, Rücknahme ohne Befund löscht sofort | ✅ Querschnittstest `loeschregel-stufe2.test.ts` (Gegenstück zu `gate-bu1.test.ts`): nach Ausgabe, Mahnung (Eltern + Mail) und Rücknahme nennt keine Zeile einer `buecherei_*`-Tabelle die Person (außer dem Ausweis), Zustand nur am Exemplar, Audit ohne Person; gegengetestet (ohne Löschen rot) |
| 2 | Befund und Ersatzforderung bis zur Erledigung, danach LK-SJ-1J; offene Posten bis zur Kontolöschung | ✅ `loeschregel-stufe2.test.ts` „GATE BU2 …“ (Verlust → Forderung → Brief → bezahlt → Löschlauf nach Schuljahresende + 1 Jahr: keine Person mehr in Bücherei-Zeilen, Exemplar bleibt ausgesondert), „nicht zurückgegeben …“ (kein Löschlauf, Kontolöschung leert die Person), `ersatz.test.ts` „Löschklassen …“ |
| 3 | Rechte: Ausgabe, Ersatzforderungen, Brief nur `buecherei.materials` + Schalter; Büchereiteam, Lehrkräfte, Schüler:innen, Eltern nicht | ✅ `ausgabe.test.ts` „S82 …“, `ersatz.test.ts` „S83 …“, `lernmittel.test.ts` „S81 …“, E2E BU-10/11 (404 für das Büchereiteam); Code-Review aller Seiten/Druckansichten (prüfen Recht und Schalter selbst) |
| 4 | Gong, Mail und Brief: keine Titel in Benachrichtigung/Mail, Elternmahnung bei Schulbüchern ab Stufe 1 nur bei Minderjährigen | ✅ `ausgabe.test.ts` „Mahnung …“, `loeschregel-stufe2.test.ts`; der Brief nennt das Medium (er geht an die Eltern bzw. die Person und ist Grundlage der Forderung) |
| 5 | Schalter `buecherei.lernmittel` ab Werk aus; aus → Seiten 404, Aktionen mit Meldung, Daten bleiben; Mahnlauf und Schuljahreswechsel-Hinweis ruhen | ✅ Tests je Datei („Schalter aus …“), `offen.test.ts` |
| 6 | Code-Review `ausgabe.ts`, `ersatz.ts`, `offen.ts` | ✅ ohne Fehlerbefund: Rechte in jedem Service, eindeutige Teilindizes gegen Doppelscan/Doppelforderung (Meldung statt Serverfehler, Test für gleichzeitige Ausgabe), Verlust nur über bedingtes UPDATE in derselben Transaktion, Schuljahr `restrict`. **Härtung G-BU2-01:** der Link „Brief drucken“ lädt nicht vorab (`prefetch={false}`) – das Öffnen der Druckansicht vermerkt „Brief gedruckt am“ und schreibt ins Audit-Log. Hinweise ohne Handlungsbedarf: gleichzeitige Rücknahme desselben Schulbuchs schreibt zwei Audit-Einträge (harmlos); Befunde der Stufe 1 lassen sich nur mit eingeschalteter Schulbuchausleihe in eine Forderung überführen (dokumentiert) |
| 7 | Volle Tests | ✅ `npm run check` (Vitest mit 2 Workern) grün, Build grün, volle E2E grün bis auf bekannte Lastausfälle (`anmeldung-entscheidung`, `datenschutz:176`), einzeln grün; E2E Backup 4/4; CI je PR grün |
| 8 | Nur mit echter Hardware/Praxis prüfbar | ⏳ offen für die Projektleitung, blockiert das Gate nicht: Klassensatz mit Handscanner ausgeben und zurücknehmen (Tempo, Fokus nach jedem Scan), Brief ausdrucken |
| 9 | Offene DSB-Fragen §18 (Stufe 2) | ⏳ blockieren das Gate nicht: Elternmahnung ab Stufe 1, offener Posten über das Schuljahresende, Rückgabefrist = Schuljahresende oder eigener Rückgabetag, Aufbewahrung abgeschlossener Forderungen, Rechtsgrundlage im Ersatzbrief |
| 10 | Nicht umgesetzt, bewusst | Klassenleitung sieht offene Schulbücher der Klasse (braucht eine eigene Freigabe); Befund-Erledigung ohne Forderung bleibt wie in Stufe 1 möglich |
