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
| `buecherei_copies` | Exemplarnummer (= Barcode, Präfix + laufende Nummer + Prüfziffer), Signatur, Standort, Zustand, ausgesondert | BU-01 |
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
- Externe ISBN-Abfrage überträgt nur die ISBN; Vorgabe aus, im VVT als Empfänger genannt.

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
