# Raumsteckbrief

Freigegeben von der Projektleitung am 2026-10-28 (Fragebogen Runde 11). Aufgaben: `docs/BACKLOG.md`, Block „Raumsteckbrief“
(RS-02 ff.; RS-01 – Bearbeiten, Auffindbarkeit, Stilllegen – ist umgesetzt). Dieses Dokument hält Umfang, Datenmodell grob,
Rechte, Datenschutz und Entscheidungen fest.

## Ziel

Eine Seite je Raum (`/raeume/[id]`) mit Stammdaten, Fotos, Ausstattung, Hinweisen, Belegung und Layout, dazu Pflege durch
Raumverantwortliche. Sekretariat, Hausmeisterei und Fachraumleitungen pflegen Raumdaten mit Kontext; Lehrkräfte (auch in
der Vertretung) finden alles zu einem Raum an einer Stelle; Schüler:innen und Eltern bekommen später einen Raumfinder.

## Reihenfolge (Projektleitung)

Datenpannen-Leitfaden → **Raumsteckbrief Stufe 1–2** → Handbuch → Ganztag → **Raumlayout (Stufe 3)** → **Gebäude/Etagen und
Tür-QR (Stufe 4)**. Jede Stufe ist einzeln auslieferbar.

## Umfang

- **Stufe 1 – Steckbrief (RS-02):** Kopf (Name, Art, Gebäude/Etage, Plätze, barrierefrei, Status), Heute/Woche (Belegung,
  Buchungen, Raumsperren, offene Mängel, fällige Prüfungen), Banner „gesperrt bis …“ bzw. „stillgelegt“, Knöpfe „Mangel
  melden“, „Raum buchen“, „Bearbeiten“, Druckansicht, Verlinkung aus allen Raumlisten und der globalen Suche.
- **Stufe 2 – Infofelder, Fotos, Ausstattung, Zuständigkeit (RS-03 bis RS-07):**
  - Infofelder (Technik/Netz, Nutzungshinweise, Sicherheit, Fenster/Lüftung, Fläche, Durchwahl).
  - Fotos: höchstens 8 je Raum, auf 1600 px verkleinert, ein Titelbild, Bildunterschrift, keine Personen.
  - **Ausstattung als selbstwachsender Katalog mit Menge je Raum:** Wer am Raum eine Ausstattung einträgt, bekommt per
    Typeahead die vorhandenen Einträge angeboten; ein neuer Eintrag wird beim ersten Mal automatisch in den schulweiten
    Katalog aufgenommen und ist danach für alle Räume auswählbar. Es gibt keine getrennte Katalogpflege; die Verwaltung
    räumt Dubletten auf (Zusammenführen, Umbenennen). Die acht bisherigen festen Einträge werden übernommen, danach entfällt
    die feste Liste.
  - Raumverantwortliche (Person oder Gruppe) mit Kontakt, Änderungshistorie aus dem Audit.
- **Stufe 3 – Raumlayout (RS-08, RS-09):** Varianten (Reihen, U-Form, Gruppentische, Prüfung, frei) auf dem Raster des
  Sitzplans (bis 12×12) mit Objekten (Pult, Tafel/Display, Tür, Fenster, Schrank, Waschbecken, Abzug) und Platzzahl je
  Variante. Kapazität wird vorgeschlagen, nie automatisch überschrieben. Sitzplan übernimmt das Layout als Kopie; der
  Klausurplan nutzt die Prüfungsplätze als Vorschlag/Warnung. Keine freie Zeichnung.
- **Stufe 4 – Gebäude/Etagen und Tür-QR (RS-10 bis RS-12):** Gebäude und Etagen als Stammdaten (optional Grundriss, Räume
  verortet, Raumfinder). Tür-QR `/r/<code>` mit nicht ratbarem Code; ohne Anmeldung erscheint nur die Anmeldeseite. Der
  gemeinsame Unterbau (Kurz-URL, Codeerzeugung, Etiketten-PDF) wird mit der Inventar-Idee nur einmal gebaut.

**Ausdrücklich nicht:** Inventarverwaltung der Gegenstände (eigene Idee, der Steckbrief verlinkt später darauf),
Schlüsselausgabe an Personen, CO₂-Sensorik, 3D- oder maßstäbliche Pläne, Türschild-Monitor, Reinigungsplanung.

## Datenmodell (grob)

Neue Tabellen im Kernschema mit Präfix `room_` (Räume sind Kernstammdaten, die Seite darf nicht von abschaltbaren Modulen
abhängen): `room_photos`, `room_equipment_types` (Katalog, wächst beim Eintragen), `room_equipment_items` (Raum, Typ,
Menge, Notiz), Infofelder (Tabelle `room_info` oder Spalten an `rooms`), `room_layouts` (Variante, Raster, Tische, Objekte,
Platzzahl), `room_responsibles`; später `buildings`, `building_floors`, `room_codes`. `rooms.building`/`rooms.floor` bleiben
als Anzeigespalten, bis die Datenübernahme in die Stammdaten läuft. Migrationen mehrstufig: erst anlegen und übernehmen,
nach Umstellung aller Verbraucher die alte Spalte `rooms.equipment` entfernen.

## Rechte

Lesen: jede angemeldete Person, Felder nach Rolle gefiltert. Stammdaten bearbeiten bleibt `verwaltung.school`. Neues Recht
„Raumdaten pflegen“ (Fotos, Ausstattung, Infofelder, Layouts; Vorgabe Hausmeisterei/Verwaltung per Gruppe), zusätzlich dürfen
Raumverantwortliche ihren eigenen Raum pflegen. Jede Aktion prüft serverseitig, nicht nur im Menü.

| Sicht | Sieht |
|---|---|
| Schüler:innen, Eltern | Name, Art, Gebäude/Etage, Plätze, barrierefrei, Titelbild, Ausstattung grob, Belegung nur als frei/belegt |
| Personal | zusätzlich Technik, Nutzung, Sicherheit, Verantwortliche, Layouts, Mängel, Belegung mit Details |

## Datenschutz

Räume haben keinen Personenbezug. Personenbezug entsteht nur durch Raumverantwortliche und Kontakt (Löschklasse folgt dem
Konto, `LK-KONTO`). Fotos zeigen Räume und Sachen, keine Personen; EXIF/GPS wird entfernt, Virenscan, Hinweis am Upload.
Technik-, Netz- und Sicherheitsangaben sind nur für Personal sichtbar. Der Tür-QR verrät ohne Anmeldung nichts. Räume werden
nie automatisch gelöscht, nur stillgelegt. Kein Bezug zu besonderen Datenkategorien. Rechtliche Einordnung: zu prüfen.

## Entscheidungen (Projektleitung 2026-10-28)

1. Stufe 1–2 zuerst als Block, Layout und Gebäude/QR danach getrennt.
2. Neues Recht „Raumdaten pflegen“ plus Raumverantwortliche für den eigenen Raum; Stammdaten bleiben bei `verwaltung.school`.
3. Ausstattung: freier, selbstwachsender Katalog (siehe oben) statt fester Liste; Dubletten räumt die Verwaltung auf.
4. Höchstens 8 Fotos je Raum, 1600 px, ein Titelbild.
5. Sichtbarkeit wie in der Tabelle oben.
6. Raster-Editor wie der Sitzplan, keine freie Zeichnung.
7. Sitzplan-Vorlage als Kopie beim Anlegen, mit Hinweis bei späterer Änderung des Raumlayouts.
8. Tür-QR ohne Anmeldung zeigt nur die Anmeldeseite.
9. Gebäude und Etagen als Stufe 4, nach dem Steckbrief.
10. Raumsperre und Stilllegung als Banner im Steckbrief.
