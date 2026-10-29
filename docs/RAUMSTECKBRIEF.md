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

## Umgesetzt (RS-02/03)

Stand 2026-10-28, Migration 0115 (`room_info_fields`, `room_info_values`, Enum `room_info_visibility`).

- **Seite `/raeume/[id]`** für alle Angemeldeten, ohne Modul-Layout (Räume sind Kernstammdaten). Gefiltert wird im Service
  `roomProfile()` (`src/modules/verwaltung/raumsteckbrief.ts`), nicht erst in der Seite. Sicht „personal“ = Rollen aus
  `STAFF_ROLES` (Lehrkraft, Personal, Beratung, Verwaltung, Admin), Sicht „familie“ = Schüler:innen und Eltern.
- **Kopf:** Name, Art, Gebäude/Etage, Plätze, barrierefrei, Ausstattung grob (seit RS-05 aus dem Katalog mit Menge).
  **Banner** „Raum stillgelegt“ und „Gesperrt bis …“ (laufende Raumsperre) plus geplante Sperren der nächsten 14 Tage; die
  Notiz der Sperre sehen nur Beschäftigte, der Grund (Kategorie) alle.
- **Belegung** als Wochenraster Mo–Fr × Zeitraster mit Wochenwechsel (`?woche=`), heute markiert: Unterricht nach
  Vertretung/Raumänderung/Verlegung, Buchungen, Sperren (`occupancyOn`, jetzt mit Lehrkraft-Kürzel bzw. Vertretung).
  Beschäftigte sehen Fach · Klasse/Kurs und Kürzel, Schüler:innen/Eltern nur „frei“/„belegt“ (auch Sperren und Buchungen).
  Moduleinstellung `verwaltung.room_occupancy_family` („nur frei/belegt“ Vorgabe, „nicht zeigen“), DSB-Thema 13.
  Nur mit Modul Stundenplan.
- **Offene Mängel** (nur Beschäftigte, Modul Gebäude & Technik): Nummer, Titel, Kategorie, Status, seit – ohne Namen; der
  Link auf die Meldung nur für die meldende Person und wer alle Meldungen sieht (Sichtbarkeit der Meldung unverändert).
  **Fällige Prüfungen** (überfällig/bald fällig, Raum oder Anlage im Raum) nur mit `gebaeude.manage`/`view_all`.
- **Knöpfe:** „Mangel melden“ (`gebaeude.report`), „Raum buchen“ (`buchungen.book`, buchbarer Raum), „Bearbeiten“
  (`verwaltung.school`), „Drucken“ → `/druck/raum/[id]` (A4, dieselbe Filterung, ohne Mängel); für Beschäftigte zusätzlich
  „Raumplan mit Vertretungen“.
- **Verlinkung:** Raumliste für alle `/raeume` (neu, ohne Menüeintrag; „Alle Räume“ im Steckbrief), Stammdaten-Raumliste
  (Knopf „Steckbrief“, „Zum Steckbrief“ auf der Bearbeitungsseite), Raumbelegung, Raumsuche und Sperrungen
  (`/stundenplan/raeume`), Raumplan `/stundenplan?raum=`, Buchungen (Raumressource), Mängelmeldung (Ort), globale Suche
  (Gruppe „Räume“, nur aktive Räume).
- **Infofelder (RS-03):** schulweit festgelegte Felder mit Sichtbarkeit je Feld („nur Personal“ oder „alle“), Werte je
  Raum (höchstens 1000 Zeichen, leer = keine Angabe). Vorgaben: Technik/Netz, Nutzungshinweise, Sicherheit, Durchwahl
  (Personal), Fenster/Lüftung, Fläche (alle). Felder verwalten unter `/verwaltung/stammdaten/raeume/infofelder` (anlegen,
  umbenennen, Sichtbarkeit, Reihenfolge, löschen mit Rückfrage; höchstens 30), Werte pflegen im Steckbrief
  („Infofelder bearbeiten“ → `/raeume/[id]/infofelder`). Das Formular weist darauf hin, keine Personendaten einzutragen.
- **Rechte:** Bis RS-06 pflegt Infofelder, wer heute Räume bearbeiten darf (`verwaltung.school`, `canEditRoomInfo()`);
  die Felder selbst legt ebenfalls `verwaltung.school` fest. Jede Aktion prüft im Service.
- **Audit:** `verwaltung.room.info` (welche Felder, nicht die Texte), `verwaltung.room.info_field.create/update/delete`
  (Filter „Räume“ im Protokoll).
- **Datenschutz:** beide Tabellen ohne Personenbezug (`NO_PERSONAL_DATA`, DATENSCHUTZ.md §3.4); Werte gehen mit Raum bzw.
  Feld (Fremdschlüssel, Umbenennen des Raumkürzels zieht mit).

## Umgesetzt (RS-04/05)

Stand 2026-10-28, Migration 0117 (`room_photos`, `room_equipment_types`, `room_equipment_items`; Datenübernahme aus
`rooms.equipment`, danach entfällt die Spalte).

- **Fotos (RS-04):** höchstens 8 je Raum, Upload JPEG/PNG/WebP bis 20 MB (Typ an den Bytes, Pixelgrenze wie beim
  Bild-Baustein), auf dem Server mit sharp (kommt mit Next, liegt im Standalone-Image) auf 1600 px verkleinert und als JPEG ohne
  Metadaten gespeichert (EXIF/GPS/XMP weg, Drehung aus EXIF vorher angewendet), dazu ein Vorschaubild mit 480 px; Virenscan wie
  bei anderen Uploads. Ein Titelbild je Raum (das erste Foto, umstellbar; beim Löschen rückt das älteste übrige nach),
  Bildunterschrift bis 120 Zeichen. Hinweis am Upload: keine Personen, keine Aushänge mit Namen. Pflege unter
  `/raeume/[id]/fotos` („Fotos bearbeiten“), Auslieferung `/api/raeume/foto/[id]` (`?klein=1` Vorschau, `nosniff`, CSP
  `sandbox`, kein Modul-Schalter).
- **Sichtbarkeit Fotos:** das Titelbild sehen alle Angemeldeten (Kopf „Überblick“, Raumliste `/raeume`, Druck), die Galerie
  (Karte „Fotos“) nur Beschäftigte; die Route liefert Schüler:innen/Eltern für andere Fotos 404 (`photoFile`).
- **Ausstattung (RS-05):** schulweiter Katalog `room_equipment_types`, der beim Eintragen wächst: im Steckbrief
  „Ausstattung bearbeiten“ → `/raeume/[id]/ausstattung`, Typeahead über den Katalog (`datalist`); ein unbekannter Name wird beim
  ersten Eintrag aufgenommen (Groß-/Kleinschreibung und Leerraum zählen nicht, eindeutiger Index auf `lower(name)`), danach
  ist er für alle Räume wählbar. Menge je Raum 1–9999 (`room_equipment_items`), Menge 0 entfernt. Grenzen: 500 Katalogeinträge,
  100 je Raum. Grobe Ausstattung (Name, Menge) sehen alle.
- **Katalog aufräumen** (`/verwaltung/stammdaten/raeume/ausstattung`, `verwaltung.school`): umbenennen (gilt überall; ein
  vorhandener Name verlangt Zusammenführen), Dubletten zusammenführen (Räume bekommen den Zieleintrag, hat ein Raum beide,
  gilt die größere Menge), Unbenutztes löschen. Keine getrennte Katalogpflege.
- **Datenübernahme:** die acht festen Einträge werden Katalogeinträge mit ihrem Schlüssel als ID (`beamer`, `tafel_digital`,
  `dokukamera`, `lehrer_pc`, `schueler_pcs`, `audio`, `waschbecken`, `abzug`), jede Zuordnung aus `rooms.equipment` wird eine
  Zeile mit Menge 1 (auch stillgelegte Räume); unbekannte Schlüssel gehen nicht verloren (Schlüssel wird Name). Danach entfallen
  `rooms.equipment` und die feste Liste `ROOM_EQUIPMENT`/`ROOM_EQUIPMENT_LABELS`.
- **Umgestellte Verwendungen von `rooms.equipment`:** Raumsuche `/stundenplan/raeume` (Filter aus den Katalogeinträgen, die
  ein aktiver Raum hat; Treffer mit Menge, `searchRooms` filtert nach Katalog-ID), Stammdaten-Raumformular (Checkboxen weg,
  Hinweis auf den Steckbrief) und -liste (Spalte aus dem Katalog), Steckbrief und Druck, Demo-Seed (Vorgaben per
  `ensureDefaultEquipmentTypes`, Mengen je Raum). Stundenplan-Solver, Setzhilfe, Diagnose und Buchungen lasen die Ausstattung nie
  (nur Art/Plätze) – der Migrationstest prüft, dass Raumsuche und Solver-Eingabe vorher und nachher dasselbe liefern. Exporte
  (Schulprofil, Auskunft) enthielten keine Raumausstattung.
- **Rechte:** Fotos und Ausstattung pflegt bis RS-06, wer `canEditRoomInfo` erfüllt (`verwaltung.school`); den Katalog räumt
  `verwaltung.school` auf (`canManageInfoFields`). Rechte und Sicht liegen jetzt in `raum-rechte.ts` (Raumsuche, Fotos,
  Ausstattung und Steckbrief ohne Ringabhängigkeit; `raumsteckbrief.ts` exportiert sie weiter).
- **Dateispeicher und Backup:** `room_photos.storage_key` und `thumb_key` stehen in `STORAGE_KEY_COLUMNS` (Aufräumlauf löscht
  sie nicht, Abdeckungstest) und in der Auskunft-Liste ohne Personenbezug (nie Teil einer Auskunft). Die Dateien liegen in
  `files/` und gehen damit in jeden Backup-Snapshot (Dump + `files/` + `config/`, INSTALLATION.md §4.1) und in die
  Wiederherstellung; gelöschte Fotos entfernt der Dienst sofort, Reste der Aufräumlauf.
- **Audit:** `verwaltung.room.photo.add/caption/cover/delete` (Foto-ID, keine Bilddaten), `verwaltung.room.equipment`
  (Name, Menge vorher/nachher), `verwaltung.room.equipment_type.create/rename/merge/delete`.
- **Datenschutz:** alle drei Tabellen ohne Personenbezug (`NO_PERSONAL_DATA`, DATENSCHUTZ.md §3.4) – wer hochgeladen oder
  eingetragen hat, steht nur im Audit-Log.

**Andockpunkte RS-06:** `canEditRoomInfo(viewer, roomId)` in `raum-rechte.ts` um das neue Recht „Raumdaten pflegen“ und
`room_responsibles` erweitern – Infofelder, Fotos und Ausstattung folgen dann automatisch (Services und Seiten prüfen nur
diese Funktion); Karte „Verantwortliche“ im unteren Raster der Seite (Platzhalter-Kommentar in `/raeume/[id]/page.tsx`);
Historie aus dem Audit über die Aktionen `verwaltung.room.*` mit Ziel = Raumkürzel (Fotos, Ausstattung, Infofelder).

## Umgesetzt (RS-06/07)

Stand 2026-10-29, Migration 0120 (`room_responsibles`).

- **Recht „Raumdaten pflegen“** (`verwaltung.rooms_info`, Modul Verwaltung): Infofelder, Fotos, Ausstattung und Verantwortliche
  **aller** Räume, keine Stammdaten. Vorgabe (`defaultGrants`) für die Rolle Verwaltung (Sekretariat; kommt bei bestehenden
  Instanzen beim nächsten Start dazu), im Demo-Seed zusätzlich für die Gruppe Hausmeisterei. Es zählt wie alles unter
  `verwaltung.*` als Verwaltungsrecht: Zwei-Faktor-Pflicht sofort, Vergabe wird gemeldet und nur von Personen mit dem Recht
  vergeben. `verwaltung.school` umfasst die Raumdaten weiterhin. Infofelder-Definitionen und das Aufräumen des
  Ausstattungskatalogs bleiben bei `verwaltung.school`.
- **Raumverantwortliche** (`room_responsibles`): je Zeile eine Person **oder** eine Gruppe, optional „Aufgabe oder Kontakt“
  (höchstens 120 Zeichen, Hinweis „keine privaten Telefonnummern“), höchstens 10 je Raum. Personen nur Beschäftigte
  (`STAFF_ROLES`), Gruppen nur Fachschaft, Gremium oder frei (keine Klassen/Kurse/AGs). Pflege unter
  `/raeume/[id]/verantwortliche` mit „Raumdaten pflegen“ bzw. `verwaltung.school`; Verantwortliche selbst tragen niemanden ein.
- **Rechteprüfung** `canEditRoomInfo(db, viewer, roomId)` (jetzt asynchron): Recht bzw. `verwaltung.school` → alle Räume; sonst nur
  Beschäftigte ohne Sperre (gesperrt, Startpasswort, 2FA offen), die selbst oder über eine ihrer Gruppen für **diesen** Raum
  eingetragen sind. Infofelder, Fotos und Ausstattung (Services und Seiten) hängen nur an dieser Funktion; Stammdaten (Name, Art,
  Plätze, Stilllegen) und Raumsperren prüfen weiter ihre eigenen Rechte. Eine Zuordnung an Schüler:innen (an der Prüfung vorbei)
  gibt kein Pflegerecht.
- **Steckbrief:** Karte „Verantwortliche“ nur für Beschäftigte (aktive Konten bzw. nicht archivierte Gruppen; Name verlinkt ins
  Adressbuch, wenn das Modul an ist), Link „Verantwortliche bearbeiten“ nur mit dem Recht. Karte **„Änderungen“** nur für Pflegende
  des Raums: die letzten 30 Vorgänge aus dem Audit-Log (`verwaltung.room.create/update/activate/deactivate/info/photo.*/equipment/
  responsible.*` mit Ziel = Raumkürzel) mit Vorgang, Zeitpunkt, handelnder Person und Feldnamen bzw. Ausstattung/Menge bzw.
  eingetragener Person/Gruppe – nie die Texte der Infofelder (stehen nicht im Audit). Katalog- und Infofeld-Verwaltung (Ziel
  ist nicht der Raum) erscheinen nicht. Nach einem Raum-Umbenennen beginnt die Historie unter dem neuen Kürzel (ältere Einträge
  tragen das alte Kürzel, „Raum geändert · Kürzel vorher …“).
- **Audit:** `verwaltung.room.responsible.add/remove` (Ziel Raum, `userId` bzw. `groupId`; bei der Kontolöschung pseudonymisiert).
- **Datenschutz (RS-07):** `room_responsibles` in `CORE_RETENTION` mit `LK-KONTO` (Start `user_id`, Kaskade bei der Kontolöschung;
  Gruppenzeilen gehen mit Gruppe bzw. Raum), Zeile in DATENSCHUTZ.md §3.4, Zweck/Kategorien für VVT und Datenschutzhinweise aus
  der Deklaration; die eigene Zuordnung steht in der Auskunft (generisch über den Fremdschlüssel). Neues DSB-Thema 22
  „Raumsteckbrief“ (DSB-FRAGEN.md, Einrichtung); die Belegung für Schüler:innen/Eltern bleibt bei Thema 13.
- **Demo-Daten:** NW2 → Demo-Lehrkraft ALB („Fachraumleitung Chemie“), IF1 → Fachschaft Informatik.
- **Tests:** `raumverantwortliche.test` (Rechte-Matrix Recht/Hausmeisterei/Person/Gruppe/Lehrkraft/Schülerin, fremder Raum,
  Stammdaten-Recht, Sperre, Eintragen und Prüfungen, Sichtbarkeit, Historie ohne Texte, Auskunft, Kontolöschung; Gegenprobe:
  ohne Rechteprüfung bzw. ohne Raumfilter rot), `raumdaten.test`; E2E `raumverantwortliche.spec.ts` (Sekretariat trägt Lehrkraft
  für KU1 ein → Lehrkraft pflegt Foto, Ausstattung, Infofelder, sieht die Historie, darf MU1 nicht; Schülerin sieht nur
  Öffentliches; Lehrkraft und Schülerin 360 px dunkel mit axe; räumt auf).

## Umgesetzt (RS-08/09)

Stand 2026-10-29, Migration 0121 (`room_layouts`; `sitzplan_plans.layout_id`, `layout_copied_at`).

- **Raster wie der Sitzplan** (bis 12 × 12, Reihe 1 vorn, keine freie Zeichnung): Größe, Zellschlüssel, Vorlagen und
  Pfeiltasten liegen jetzt gemeinsam in `src/core/raster.ts` (aus `sitzplan/layout.ts` ausgegliedert, der Sitzplan nutzt sie
  unverändert); die Layout-Logik (Elemente, Varianten, Platzzahl, Prüfungsplätze, Hinweise) rein in `src/core/raumlayout-raster.ts`.
- **Elemente je Feld:** Platz, Tisch ohne Platz, Lehrkraftpult, Tafel/Display, Tür, Fenster, Schrank, Waschbecken, Abzug; leere
  Felder sind Gang/frei. **Platz-Felder zählen als Sitzplätze.** Varianten: Reihen, U-Form, Gruppentische, Prüfung, frei – je
  Variante eine Vorlage (Plätze wie im Sitzplan, vorn Tafel und Pult; Prüfung im Schachbrett).
- **Vorgabe (RS-08): ein Standard-Layout + optional weitere benannte** (z. B. „Klausur“), höchstens 8 je Raum, Name eindeutig je
  Raum (Schreibweise egal). Das erste Layout wird Standard; umstellbar; beim Löschen des Standards rückt das älteste übrige nach.
- **Kapazität:** Abgleich mit `rooms.capacity` nur als Hinweis („Vorschlag: n“) im Editor, im Steckbrief und auf der Layout-Seite –
  die Platzzahl in den Stammdaten ändert sich nie automatisch (bleibt bei `verwaltung.school`).
- **Seiten:** Karte „Raumlayout“ im Steckbrief (nur Beschäftigte: Standard-Layout als Raster, Platz-/Prüfungsplätze, weitere
  Layouts), `/raeume/[id]/layout` (Auswahl der Layouts, Editor für Pflegende, sonst nur Ansicht), Druck
  `/druck/raum/[id]/layout?l=…` (A4 quer, mit Legende der Elemente).
- **Bedienung:** Element wählen (Radiogruppe), dann Feld anklicken bzw. Enter/Leertaste – dasselbe Element noch einmal leert;
  Pfeiltasten bewegen im Raster (ein Tabstopp, „roving tabindex“), Entf leert; Ansagen per `aria-live`. Jedes Feld ist beschriftet
  („Reihe 2, Spalte 3: Platz“), die Ansicht ist eine Tabelle mit Beschriftung je Zelle. 360 px: das Raster scrollt im Kasten, die
  Seite nicht; Hinweis „Bearbeiten am besten auf einem großen Bildschirm“.
- **Rechte:** sehen nur Beschäftigte (`canViewLayouts`, Sicht „personal“; Schüler:innen/Eltern 404 bzw. keine Karte); pflegen nur,
  wer `canEditRoomInfo` erfüllt (Recht „Raumdaten pflegen“, `verwaltung.school`, Raumverantwortliche für den eigenen Raum).
- **Audit/Historie:** `verwaltung.room.layout.create/update/default/delete` (Ziel Raumkürzel, Layoutname, Platzzahl) – erscheinen
  in der Karte „Änderungen“.
- **Sitzplan (RS-09):** „Tischanordnung“ beim Anlegen bietet „Aus Raumlayout (Kopie)“ (Layouts aktiver Räume). Raster und
  Platz-Felder werden als Tische **kopiert**, der Raum wird eingetragen, falls keiner gewählt ist; der Plan gehört der Lehrkraft.
  Spätere Änderungen oder das Löschen des Layouts ändern bestehende Sitzpläne nicht – der Plan zeigt nur „Tische als Kopie aus
  dem Raumlayout …“ bzw. „Das Raumlayout wurde seitdem geändert – dieser Sitzplan bleibt, wie er ist.“ (Vergleich
  `layout_copied_at` mit dem Änderungszeitpunkt des Layouts). Objekte (Tafel, Tür …) übernimmt der Sitzplan nicht.
- **Klausurplan (RS-09):** Andockstelle war `exams.room_id` (gab es schon, im Formular aber nicht wählbar). Jetzt optional „Raum“
  im Formular (für Beschäftigte, nur aktive Räume, Prüfung auf Existenz). **Prüfungsplätze** je Raum (`examSeatsByRoom`): ein
  Layout der Variante „Prüfung“ zählt mit allen Plätzen (Standard bevorzugt), sonst aus dem Standard-Layout **jeder zweite
  Platz** (links und davor frei). Mehr Schüler:innen als Prüfungsplätze → **Warnung** nach dem Eintragen und in der Liste, nur
  für Beschäftigte, nie blockierend. Räume ohne Layout: keine Warnung.
- **Datenschutz:** `room_layouts` ohne Personenbezug (`NO_PERSONAL_DATA`, DATENSCHUTZ.md §3.4) – Plätze sind leer; die neuen
  Spalten am Sitzplan sind nur Verweis und Zeitpunkt.
- **Tests:** `raumlayout.test` (rein: Platzzahl, Prüfungsplätze, Vorlagen, Prüfung, Kapazitätshinweis; Rechte inkl.
  Verantwortliche und fremder Raum, Sicht Schülerin, Name/Variante/Raster/Grenze, Standard/Löschen, Historie; Sitzplan aus
  Vorlage = Kopie, Layoutänderung und -löschung lassen ihn unverändert; Prüfungsplätze und Warnung; Gegenprobe: ohne
  Rechte-/Sichtprüfung rot); E2E `raumlayout.spec.ts` (Layout per Tastatur anlegen, Sitzplan aus Layout, Änderung → Hinweis,
  Lehrkraft 360 px dunkel mit axe, Druck, Schülerin 404, räumt auf). Bestehende Sitzplan-Specs unverändert grün.

## Abschluss Stufe 1–2

Stufe 1–2 (RS-02…RS-07) ist mit RS-06/07 vollständig: Steckbrief mit Belegung, Banner, Infofeldern, Fotos, Ausstattungskatalog,
Raumverantwortlichen und Historie; Pflege über „Raumdaten pflegen“ bzw. Verantwortung für den eigenen Raum, Stammdaten weiter
bei `verwaltung.school`. Offen und bewusst später: Mengenfilter in der Raumsuche (optional, RS-05), Layout (Stufe 3, RS-08/RS-09),
Gebäude/Etagen und Tür-QR (Stufe 4, RS-10…RS-12). Die rechtliche Einordnung bleibt Aufgabe der Schule (DSB-FRAGEN §22).
