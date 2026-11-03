# Inventar – Ausbau der Anlagen zum Inventar mit QR-Etiketten (Modul `gebaeude`)

Freigegeben von der Projektleitung am 2026-11-01 (Fragebogen Runde 12). Aufgaben: `docs/BACKLOG.md`, Block „Inventar“
(INV-01 ff.). Baut auf dem gemeinsamen Etiketten-Unterbau des Raumsteckbriefs auf (`docs/RAUMSTECKBRIEF.md`, „Gemeinsamer Unterbau“,
Andockpunkt „inventar“).

## Problem und Nutzen

- **Hausmeisterei:** Geräte und Möbel sind nicht auffindbar oder doppelt geführt; Etiketten fehlen. Mit QR-Etiketten führt das Handy
  direkt zum Gerät (Standort, Zustand, Prüfung, Mangel melden), die Inventur geht per Scan statt mit Listen.
- **IT-Verantwortliche/Sammlungsleitung:** eigener Zuständigkeitsbereich je Kategorie (IT, Fachsammlungen, Musik, Sport); Leihe von
  Tablets/Instrumenten nachvollziehbar.
- **Lehrkraft:** Defektes Gerät melden ohne Raum, Art und Seriennummer zu tippen: QR scannen, der Mangel ist vorbelegt (Anknüpfung an
  `gebaeude_tickets`).
- **Schulleitung/Sekretariat:** Inventurprotokoll und Bestandsliste für den Schulträger, Garantie-/Zweckbindungsfristen im Blick.
- **Admin:** keine eigene Geräteliste neben der Gebäude-Technik; kein weiteres Modul.
- **Schüler:innen/Eltern:** nur mittelbar (Leihgeräte); keine eigene Sicht in den ersten Stufen.

## Umfang

**Ausgangslage im Code:** `gebaeude_assets` (`src/modules/gebaeude/schema.ts`) hat Name, Art als Enum `ASSET_KINDS` (`labels.ts`), Raum,
Gebäude (Text), Inventarnummer, Hersteller, Seriennummer, Anschaffungsdatum, Notiz und hängt an `gebaeude_inspections.asset_id`. Seit dem
Raumsteckbrief gibt es den generischen Unterbau `src/core/etiketten/` (`codes.ts`, `service.ts`, `qr.ts`), die Tabelle `label_codes`
(heute nur Art „raum“, `/r/<code>`), Stammdaten `buildings`/`building_floors`, die Raum-Ausstattung `room_equipment_types`/
`room_equipment_items` (RS-05) und den Druck `qr-schild.tsx`.

- **Stufe 1 – Inventar-Grundlage:** Kategorien als Tabelle statt Enum (Vorlagen s. u., je Kategorie Präfix, Prüfpflicht-Eigenschaft,
  verantwortliche Gruppe), automatische Inventarnummer, erweiterte Felder (Modell, Zustand, Preis, Lieferant, Finanzierung/
  Zweckbindung, Garantie bis, Ausmusterung, Menge für Sammelposten), Standort über Raum (und damit Gebäude/Etage), Listen/Filter, Foto
  je Asset. Bestehende Anlagen bleiben erhalten.
- **Stufe 2 – Etiketten und Asset-Seite:** Art „inventar“ in `LABEL_KINDS`, Kurz-URL `/i/<code>`, Druck auf A4-Etikettenbögen und
  Endlosrolle, mobile Asset-Seite mit Aktionen (Zustand, Standort, Foto, Prüfung, Mangel melden, Historie).
- **Stufe 3 – Inventur:** Inventur je Raum mit Soll/Ist, Scan über die Handykamera (der Link öffnet das Asset, „vorhanden“ per Knopf)
  oder In-App-Scan, Protokoll CSV/Druckansicht.
- **Stufe 4 – Ausleihe:** Ausleihe an Lehrkräfte und Schüler:innen (Leihgeräte) mit Rückgabedatum, Erinnerung, Leihvertrag als Druckansicht.
- **Stufe 5 – Auswertungen/Import:** CSV-Export/Import im Format des Schulträgers, Hinweise zu Garantie-/Bindefristen im Bereich
  „Offenes“ (`src/modules/open-items.ts`), Karte „Inventar dieses Raums“ im Raumsteckbrief.
- **Inventarisiert wird,** was Hausmeisterei, IT oder Sammlungen führen möchten; Pflicht nur für prüfpflichtige Anlagen; Möbel und
  Kleinteile als Sammelposten je Raum; keine feste Wertgrenze. Ausgemusterte Assets bleiben dauerhaft als Nachweis (in der Liste
  ausgeblendet, auf Wunsch löschbar).
- **Ausdrücklich nicht:** Bücher/Schulbücher (Modul `buecherei`), Laptopwagen-Reservierung (bleibt `buchungen`), Anlagenbuchhaltung/
  Abschreibung, Förderabrechnung, Schlüssel- und Transponderausgabe (eigene Idee „Schlüsselbuch“), Gefahrstoffkataster (eigene Idee;
  das Inventar bietet nur die Kategorie „Chemikalienschrank“ bzw. einen Verweis), Ortung per Funk, Software-/Lizenzverwaltung,
  Wartungsverträge.

**Kategorien-Vorlagen (Stufe 1):** IT (Laptops, Tablets/Koffer/Wagen, Lehrkraft-/Schüler-PCs, Drucker/Kopierer, Server, Switches,
WLAN-Zugangspunkte, Firewall, USV), Präsentation/AV (Beamer, interaktive Displays, Dokumentenkameras, Lautsprecher, Mikrofone,
Aula-Technik), Fachsammlungen (Mikroskope, Physik-/Chemie-/Bio-Geräte, Messgeräte), Werken/Technik/Kunst (Maschinen, Brennofen), Sport
(Großgeräte, Zeitmessanlage; Kleingeräte als Sammelposten), Musik (Instrumente, Verstärker), Hauswirtschaft/Mensa, Sicherheit
(Feuerlöscher, Erste-Hilfe, AED, Notbeleuchtung, Rauchmelder, Leitern), Hausmeisterei/Außen, Möbel (Tafeln, Schränke, Tische/Stühle als
Sammelposten). Die vorhandenen Prüfarten (`pruefarten.ts`) hängen an den Kategorien mit Prüfpflicht.

## Umsetzung

- **Modul:** bestehend `gebaeude` (Ausbau; der Navigationspunkt „Anlagen“ unter `src/app/(shell)/gebaeude/anlagen/` wird zu „Inventar“);
  Kern-Etiketten nutzen. Kein neues Modul, damit Prüfungen, Mängel und Raumbezug nicht gespiegelt werden.
- **Stufe 1 (Tabellen mit Präfix `gebaeude_`):**
  - neu `gebaeude_asset_categories` (id, key, name, prefix, inspection_required, responsible_group_id, sort, active); Vorlagen wie `pruefarten.ts`.
  - `gebaeude_assets` erweitern: `category_id`, `model`, `condition` (Enum neu/gut/gebraucht/defekt), `quantity` (Standard 1, Sammelposten),
    `price_cents`, `supplier` (Firma), `financing`, `bound_until`, `warranty_until`, `retired_on`, `retired_reason`, `building_id`/`floor_id` aus den
    Stammdaten statt Text `building`. Mehrstufige Migration wie beim Raumsteckbrief: erst anlegen und befüllen (Enum-Werte werden Kategorien
    mit gleichem Schlüssel), nach Umstellung aller Verbraucher (`pruefungen.ts`, `pruefarten.ts`, CSV-Import) die Enum-Spalte entfernen.
    `gebaeude_inspection_types.asset_kind` wird `category_id`.
  - neu `gebaeude_inventory_counters` (Präfix je Kategorie → nächste Nummer) für lückenlose Inventarnummern ohne Kollision; Nummernformat als Moduleinstellung.
  - Fotos je Asset wie `room_photos` (Verkleinerung auf 1600 px, ohne Metadaten) über `src/core/images.ts`.
- **Stufe 2:** `LABEL_KINDS` um `"inventar"` und `LABEL_KIND_INFO` (`path: "/i/"`) erweitern; in `label_codes` Spalte `asset_id` (FK
  `gebaeude_assets`, cascade), Prüfung `label_codes_kind`/`label_codes_target` und Unique-Index ergänzen; `TARGET`/`targetValues` in
  `src/core/etiketten/service.ts`. Seite `src/app/(shell)/i/[code]/page.tsx` nach dem Muster von `/r/[code]` (ohne Anmeldung nur die
  Anmeldeseite, gültig = ungültig, SICHERHEIT.md S89). Mangel melden: `gebaeude_tickets` bekommt `asset_id` (nullable), vorbelegt aus der
  Asset-Seite (Raum, Kategorie, Gerät). Druck: neue Formatliste neben `SIGN_FORMATS` (A4-Etikettenbögen, ein bis zwei gängige Raster, z. B.
  3×8 und 4×13, und Endlosrolle 62 mm; 12/24-mm-Streifen später) und Etikettenkomponente neben `src/ui/qr-schild.tsx`; Inhalt QR,
  Inventarnummer, Kurzname, Schulname/Logo; Sammeldruck wie `/raeume/tuerschilder` (Raum, Kategorie, „ohne Etikett“). Aktionen mit Audit
  `gebaeude.asset.*` (ohne Personennamen im Text); Historie aus dem Audit wie die Raumhistorie.
- **Rechte:** vorhanden `gebaeude.configure` für Kategorien und Stammdaten; neu `gebaeude.inventory` („Inventar pflegen, Etiketten drucken,
  Inventur durchführen“) – Vorgabe über die Gruppe Hausmeisterei/IT, nicht über die Rolle; verantwortliche Gruppen einer Kategorie
  pflegen ihre Kategorie. Lesen mit `gebaeude.view_all`. Wer `/i/<code>` nach der Anmeldung ohne Pflegerecht öffnet, sieht nur
  Bezeichnung, Kategorie und Standort sowie „Mangel melden“ (mit `gebaeude.report`), keine Seriennummer, Preise, Finanzierung. Jede
  Server Action prüft über `moduleActions("gebaeude")` und Service.
- **Moduleinstellungen** (`src/modules/gebaeude/settings.ts`): Nummernformat, Standard-Etikettenformat, Leihfrist-Standard (Stufe 4).
- **Live-Kanal:** nur optional in Stufe 3 (Zähler „x von y“ bei mehreren Scannenden, `src/core/notifications/bus.ts`). **Mail/Jobs:**
  Stufe 4 Erinnerungen über `src/core/scheduler.ts`/`jobs.ts` und `notify`; Stufe 5 Frist-Hinweise (Garantie/Zweckbindung) über den
  Fristen-Job der Prüfungen.
- **Kamera-Scan:** im Browser nur über HTTPS mit vertrauenswürdigem Zertifikat (im Schulnetz mit importierter Schul-CA, siehe
  `docs/ZERTIFIKATE.md`); die Kamera-App des Handys öffnet `/i/<code>` direkt – das funktioniert schon ab Stufe 2 und genügt für die
  Inventur-Stufe 3; In-App-Scan nur, wenn nötig.
- **Anknüpfung Raumsteckbrief:** Karte „Inventar“ am Steckbrief (Anzahl je Kategorie, Link zur gefilterten Liste). Die grobe Ausstattung
  (`room_equipment_*`, RS-05) bleibt als Selbstauskunft des Raums bestehen und wird nicht automatisch aus dem Inventar befüllt;
  Sammelposten sind eine Verfeinerung, keine Doppelpflege.

## Datenschutz

- Assets, Kategorien, Etiketten-Codes: **kein Personenbezug** (Manifest/`NO_PERSONAL_DATA`, DATENSCHUTZ.md §3.4; `gebaeude_assets` steht
  schon dort); Lieferanten sind Firmen. Fotos ohne Personen, Hinweis am Upload.
- **Ausleihe (Stufe 4):** Personenbezug (wer hat was, Zeitraum). Tabelle `gebaeude_loans` mit Löschklasse **LK-ENDE-1J** (Start
  `returned_at`), offene Ausleihen bleiben; Eintrag unter `retention` im Manifest, `processing` ergänzen, Auskunft über
  `src/modules/auskunft.ts` (Leihen der eigenen Person); der Leihvertrag ist nur Druck, nicht gespeichert.
- QR ohne Anmeldung gibt nichts preis (Code 80 Bit Zufall, nicht ratbar; Abfotografieren ohne Konto bringt nur die Anmeldeseite).
  Schüler:innen/Eltern sehen nur ihre eigenen Leihen (Stufe 4).
- Art. 9: keine Gesundheitsangaben; Freitext Notiz/Zustand ohne Personenbezug (Hinweis am Feld). Die Historie im Audit nennt Handelnde
  nur für Berechtigte (wie die Raumhistorie).
- Ausmusterung: kein Personenbezug, daher keine Löschpflicht; Aufbewahrung als Nachweis für den Schulträger.

## Aufgaben (Größe)

| Nr. | Aufgabe | Größe | Abhängigkeit |
|---|---|---|---|
| INV-01 | Kategorien-Tabelle + Vorlagen, Migration Enum → Kategorie (mehrstufig), erweiterte Felder, Sammelposten, automatische Nummern, Recht `gebaeude.inventory`, Liste/Filter, CSV-Import angepasst | M | – |
| INV-02 | Art „inventar“ in `label_codes`, `/i/<code>`, Druckformate (Bögen, Endlos), Sammeldruck | M | INV-01 |
| INV-03 | Mobile Asset-Seite, Aktionen, Tickets mit `asset_id`, Historie, Fotos | M | INV-02 |
| INV-04 | Inventur-Modus (`gebaeude_inventories`/`_scans`, Soll/Ist, Protokoll CSV/Druck, optional In-App-Scan) | M | INV-03 |
| INV-05 | Ausleihe (Tabelle, Rückgabe, Erinnerungen, Leihvertrag, Löschklasse, Auskunft) | M | INV-03 |
| INV-06 | Export/Import im Schulträgerformat, Frist-Hinweise (Garantie/Zweckbindung) in „Offenes“, Karte „Inventar“ im Raumsteckbrief | S–M | INV-01, INV-03 |
| INV-07 | Doku (Handbuch, BETRIEBSHANDBUCH, DATENSCHUTZ §3.4), E2E für Etikettendruck, Scan-Weg und Rechte (laufend) | S | laufend |

Gesamt **XL**, in fünf einzeln auslieferbaren Stufen (INV-01 + INV-02 sind schon ein nutzbares Produkt: gedruckte Etiketten, die zur
Asset-Seite führen).

## Entscheidungen (Projektleitung 2026-11-01)

- **inv-1** `gebaeude_assets` wird zum Inventar ausgebaut; Prüfpflicht wird Eigenschaft der Kategorie. – wie vorgeschlagen
- **inv-2** Inventarisiert wird, was Hausmeisterei, IT oder Sammlungen führen möchten; Pflicht nur für prüfpflichtige Anlagen; Möbel und Kleinteile als Sammelposten je Raum; keine feste Wertgrenze. – wie vorgeschlagen
- **inv-3** Ausstattung am Raum bleibt grobe Selbstauskunft; Sammelposten optional und nicht automatisch aus der Ausstattung befüllt; der Steckbrief zeigt zusätzlich die Karte „Inventar“. – wie vorgeschlagen
- **inv-4** Neues Recht `gebaeude.inventory` (Vorgabe über Gruppen Hausmeisterei/IT) plus verantwortliche Gruppe je Kategorie. – wie vorgeschlagen
- **inv-5** Nach Anmeldung: Bezeichnung, Kategorie, Standort und „Mangel melden“ (bei `gebaeude.report`); ohne Anmeldung nur die Anmeldeseite. – wie vorgeschlagen
- **inv-6** Ausleihe als eigene Stufe 4 für Lehrkräfte und Schüler:innen (Leihgeräte), mit Rückgabedatum, Erinnerung und Leihvertrag als Druck; Löschklasse LK-ENDE-1J ab Rückgabe. – wie vorgeschlagen
- **inv-7** Etikettenformate: A4-Bögen (ein bis zwei gängige Raster, z. B. 3×8 und 4×13) und Endlosrolle 62 mm; 12/24-mm-Streifen später. – wie vorgeschlagen
- **inv-8** Ausgemusterte Assets bleiben dauerhaft als Nachweis (kein Personenbezug), in der Liste ausgeblendet, auf Wunsch löschbar. – wie vorgeschlagen
- **inv-9** Zweckbindung/Förderung: nur Felder (Finanzierung, Bindefrist) und ein Hinweis in „Offenes“ kurz vor Fristende; keine Förderabrechnung. – wie vorgeschlagen
- **inv-10** Schlüsselbuch und Gefahrstoff-Prüfkatalog sind getrennte, eigene Ideen; das Inventar bietet nur die Kategorie „Chemikalienschrank“ bzw. einen Verweis. – wie vorgeschlagen
- **rf-1** Reihenfolge der Runde 12: CA-01 → Betriebsmonitoring → CA Teil A → Klassenbildung 1–2 → Inventar INV-01/02 → CA Teil B → Inventar Rest (INV-03…07). – wie vorgeschlagen

## Umgesetzt (INV-01/INV-02, 2026-11-02)

- **Kategorien statt Enum:** `gebaeude_asset_categories` (Schlüssel, Name, Präfix, Prüfpflicht, verantwortliche Gruppe, Reihenfolge, aktiv) mit
  20 Vorlagen in `src/modules/gebaeude/kategorien.ts` – die zehn früheren Enum-Werte behalten ihren Schlüssel, dazu IT, Präsentation/AV,
  Fachsammlungen, Werken, Musik, Hauswirtschaft, Sicherheit, Hausmeisterei, Chemikalienschrank (nur Verweis, inv-10), Möbel; seit GS-01
  zusätzlich Laborabzug, Augen-/Körpernotdusche und Sicherheitsschrank für Gefahrstoffe (Prüfpflicht, `docs/FACHRAUM-PRUEFUNGEN.md`). Eigene
  Kategorien unter `/gebaeude/inventar/kategorien` (`gebaeude.configure`); Vorlagen lassen sich nur ausschalten. Die Prüfarten hängen über
  `gebaeude_inspection_types.category_id` an den Kategorien (`INSPECTION_TEMPLATE.categoryKey`).
- **Migration zweistufig:** `0124_inv_01_inventar.sql` legt Tabellen und Spalten an, macht aus jedem Enum-Wert eine Kategorie gleichen
  Schlüssels, trägt `category_id` an Anlagen und Prüfarten ein, übernimmt Freitext-Gebäude in `buildings` (wie RS-10) und setzt
  `retired_on` für bisher „außer Betrieb“; `0125_inv_01_enum_entfernen.sql` entfernt `kind`, `building`, `asset_kind` und den Enum.
  Kein Datenverlust; der CSV-Import nimmt die alte Kopfzeile „Art“ weiter an.
- **Felder:** Modell, Zustand (neu/gut/gebraucht/defekt), Menge (Sammelposten), Preis (Cent), Lieferant (Firma), Finanzierung,
  Zweckbindung bis, Garantie bis, Ausmusterung (Datum, Grund), Gebäude/Etage aus den Stammdaten (`building_id`/`floor_id`) oder über den
  Raum. Ausgemusterte bleiben als Nachweis, Liste nur mit „auch ausgemusterte“, endgültig löschen nur `configure` (inv-8).
- **Inventarnummern:** `gebaeude_inventory_counters` je Präfix (bzw. Präfix:Jahr), atomar per `insert … on conflict … returning`,
  von Hand oder per Import vergebene Nummern werden übersprungen; Format als Moduleinstellung `gebaeude.inventory_no_format`
  (Präfix-0001, Präfix-2026-0001, Präfix-000001). Leere Nummer beim Ändern lässt die bisherige stehen.
- **Rechte:** neu `gebaeude.inventory` (alle Kategorien; Demo über die Gruppe Hausmeisterei, nicht über die Rolle), `configure` schließt
  es ein; Mitglieder der verantwortlichen Gruppe pflegen nur ihre Kategorie (`maintainableCategories`/`requireMaintain` in
  `inventar.ts`, jede Server Action geht über den Service). Lesen mit `view_all`; die Liste zeigt verantwortlichen Gruppen nur ihre
  Kategorien. Asset-Seite ohne Pflegerecht: Bezeichnung, Kategorie, Standort, „Mangel melden“ (inv-5).
- **Etiketten (`/i/<code>`):** `label_codes.asset_id` (Tabelle jetzt in `src/core/etiketten/schema.ts`, weil sie Kern und Modul
  verbindet), Art „inventar“ in `LABEL_KINDS`, Seite `src/app/i/[code]` nach dem Muster von `/r/<code>` (SICHERHEIT S95). Formate
  `LABEL_FORMATS`: A4-Bogen 3×8 (70 × 36 mm), A4-Bogen 4×13 (48,5 × 21,2 mm), Endlosrolle 62 mm (62 × 29 mm, ein Etikett je Abschnitt);
  Vorgabe als Moduleinstellung `gebaeude.label_format`; „ab Etikett Nr.“ für angefangene Bögen. Inhalt: QR, Inventarnummer, Kurzname,
  Schulname, Standort (auf dem kleinsten Raster nur Nummer und Name). Sammeldruck `/gebaeude/inventar/etiketten` (Kategorie, Raum,
  „nur ohne Etikett“, alle gefilterten) → `/druck/inventar-etiketten`; Neuerzeugen auf der Asset-Seite entwertet den alten Code.
- **Audit:** `gebaeude.asset.create/update/activate/deactivate/delete/import`, `gebaeude.asset.qr.create/renew`,
  `gebaeude.asset_category.create/update/delete` – ohne Code und ohne Personennamen im Text.
- **Noch offen (INV-06 ff.):** Export im Schulträgerformat, Karte im Raumsteckbrief (Inventur: INV-04, Ausleihe: INV-05, s. u.).

## Umgesetzt (INV-03, 2026-11-02)

- **Asset-Seite mobil zuerst** (`/gebaeude/inventar/<id>`, Ziel von `/i/<code>`): oben „Mangel melden“ (volle Breite am Handy), für
  Pflegende die Karte „Vor Ort erfassen“ mit Zustand per Knopf (neu/gut/gebraucht/defekt, `aria-pressed`) und Umzug in einen Raum;
  darunter Stammdaten, Fotos, Meldungen und Prüfungen zum Gerät, Historie, Etikett, das volle Formular und Ausmustern. Geprüft bei 360 px
  im dunklen Modus mit axe (inkl. Zielgröße).
- **Meldungen mit Gerätebezug:** `gebaeude_tickets.asset_id` (Migration `0126_inv_03_asset_seite.sql`, beim Löschen des Guts `set null`).
  `/gebaeude/melden?asset=<id>` belegt Raum (aus dem Gerät), Meldungskategorie (`ticketCategoryForAsset`: IT/AV → IT/Medien, Haustechnik-
  Anlagen → Haustechnik, Sicherheitsausstattung → Sicherheit, sonst Gebäude) und den Anfang der Bezeichnung vor und zeigt die Anzahl
  offener Meldungen zum Gerät. Ohne Raum/Ort übernimmt der Service den Standort des Geräts. Mängel aus Prüfungen tragen den Bezug
  ebenfalls; die Meldung verlinkt das Gerät.
- **Fotos** (`gebaeude_asset_photos`) wie Raumfotos: höchstens 6 je Gerät, 1600 px + Vorschau 480 px, ohne Metadaten, Virenscan; Route
  `/api/gebaeude/inventar-foto/<id>`; Dateien gehen mit dem Gerät (SICHERHEIT S99).
- **Historie** aus dem Audit (`gebaeude.asset.*` mit Ziel = Inventar-ID): angelegt, geändert, Zustand (vorher → nachher), Standort
  (Raum → Raum), Fotos, Etikett, aus-/wieder in Betrieb. Neue Audit-Aktionen `gebaeude.asset.condition`, `.move`, `.photo.add`,
  `.photo.delete` – Raumkürzel und Zustände, keine Namen im Text.
- **Prüfung vom Gerät aus:** mit `view_all` die Prüfungen des Geräts (offen nach Fälligkeit, dann erledigte); mit `gebaeude.manage` das
  Ergebnis direkt erfassen (ein Mangel wird zur Meldung mit Gerätebezug).
- **Entscheidungen bei offenen Punkten (konservativ, INV-03):**
  - Fotos und Historie nur in der vollen Sicht (`view_all`/Pflegende) – die eingeschränkte Sicht bleibt bei inv-5 (Bezeichnung,
    Kategorie, Standort, „Mangel melden“); zusätzlich sieht sie dort ihre **eigenen** Meldungen zum Gerät und die **Anzahl** offener
    Meldungen (gegen Doppelmeldungen, ohne Inhalte und Namen).
  - Inventarnummer im Meldeformular nur für die volle Sicht, in der Meldung nur für Bearbeitende.
  - Standort per Knopf nur als Umzug in einen **Raum** (Gebäude/Etage ergeben sich daraus); Orte ohne Raum bleiben im Formular „Angaben ändern“.
  - Ausgemustertes Inventar: keine Schnellaktionen und keine neuen Meldungen; Fotos bleiben als Nachweis.
  - Eine Meldung setzt den Zustand **nicht** automatisch auf „defekt“ – das entscheiden die Pflegenden per Knopf.
  - Ergebnis einer Prüfung erfassen nur mit `gebaeude.manage` (wie auf der Prüfungsseite); verantwortliche Gruppen ohne `view_all`
    sehen die Prüfungsliste am Gerät nicht.

## Umgesetzt (INV-04, 2026-11-02)

- **Inventur je Raum** (`/gebaeude/inventur`, Knopf „Inventur“ in der Inventarliste): Raum wählen, starten. Soll = Inventar in Betrieb,
  das beim Start im Raum steht (Nummer, Bezeichnung, Kategorie, Menge werden mitgeschrieben). Je Raum läuft höchstens eine Inventur;
  ein zweiter Start öffnet die laufende. Tabellen `gebaeude_inventories`/`gebaeude_inventory_items` (Migration
  `0127_inv_04_inventur.sql`), ohne Personenbezug.
- **Erfassen, drei Wege:** (1) Etikett mit der **Kamera-App** des Handys scannen → `/i/<code>` → Geräteseite mit der Karte „Inventur
  läuft“ und dem Knopf „Gefunden in <Raum>“ (die Inventur im Raum des Geräts zuerst, bei mehreren laufenden je ein Knopf);
  (2) auf der Inventurseite die Zeile „Code oder Inventarnummer“ – nimmt Kurz-URLs, Codes und Inventarnummern (ohne Groß-/Kleinschreibung),
  passt auch für Handscanner, die wie eine Tastatur tippen; (3) Knöpfe „Gefunden“/„Fehlt“ in der Liste (Sammelposten mit gezählter Menge,
  0 = fehlt). Ein Gerät aus einem anderen Raum wird „falscher Raum“ (mit dem Raum laut Inventar) und lässt sich per „Hierher umziehen“
  übernehmen (Umzug wie auf der Geräteseite, „umgezogen“); ein nach dem Start hierher gezogenes Gerät zählt als gefunden, „nicht im Soll“.
- **In-App-Scan (optional):** nur wenn der Browser die eingebaute Barcode-Erkennung (`BarcodeDetector`) hat – dann erscheint „Mit der
  Kamera scannen“ (Rückkamera, QR, derselbe Code wird 4 s lang nicht doppelt gemeldet). Keine neue Abhängigkeit; ohne Unterstützung
  (z. B. viele iOS-/Desktop-Browser) bleibt der Weg über die Kamera-App. Die Kamera ist per `Permissions-Policy` nur auf
  `/gebaeude/inventur/<id>` freigegeben (SICHERHEIT S100) und braucht HTTPS mit vertrauenswürdigem Zertifikat.
- **Abschluss:** alles Offene wird „fehlt“; danach nimmt die Inventur nichts mehr an, im Raum kann eine neue beginnen.
- **Protokoll:** CSV (`/api/gebaeude/inventur/<id>`, Semikolon, UTF-8, Formeln entschärft) und Druckansicht `/druck/inventur/<id>`
  (Soll/Ist je Posten, Zählung, Unterschriftszeilen) – ohne Namen.
- **Audit:** `gebaeude.inventory.start/close/delete` (Ziel = Inventur), `gebaeude.asset.inventur` (Ziel = Gerät, Stand und Raum) – die
  Historie der Geräteseite zeigt „Inventur: Gerät erfasst · gefunden · Inventur Raum 112“.
- **Entscheidungen bei offenen Punkten (konservativ, INV-04):**
  - Durchführen nur mit `gebaeude.inventory`/`configure` – eine Raum-Inventur umfasst alle Kategorien, verantwortliche Gruppen einer
    einzelnen Kategorie erfassen (noch) nicht; lesen auch mit `view_all`.
  - **Kein automatisches Erfassen beim Öffnen des Etiketts** – „gefunden“ ist immer ein Knopf (GET ohne Nebenwirkung, kein Erfassen durch
    Vorladen oder versehentliches Scannen), wie im Konzept („vorhanden“ per Knopf).
  - Welche Inventur ein Scan trifft, wird nicht im Browser gemerkt: die Geräteseite zeigt einen Knopf je laufender Inventur (die im Raum
    des Geräts zuerst, höchstens 6).
  - Die Inventur ändert das Inventar **nicht** von selbst: „fehlt“ mustert nicht aus, „falscher Raum“ zieht nur per Knopf um.
  - Wer erfasst hat, steht nur im Audit-Log, nicht in den Tabellen, im CSV oder im Druck (kein Personenbezug, keine Auswertung je Person).
  - Laufende Inventur abbrechen darf, wer durchführt; abgeschlossene Protokolle bleiben als Nachweis und sind nur mit `configure` löschbar.
  - Ausgemustertes Inventar wird nicht erfasst (Hinweis „bitte im Inventar prüfen“).
  - Live-Zähler bei mehreren Scannenden (Konzept „optional“) ist nicht gebaut: eigene Scans aktualisieren die Seite, sonst Neuladen.

## Umgesetzt (INV-05, 2026-11-02)

- **Ausleihe auf der Geräteseite** (Karte „Ausleihe“, Ziel des Etiketts): Person suchen (Name oder Klasse, wie an der Bücherei-Theke),
  wählen, Rückgabedatum (Vorgabe aus der Moduleinstellung `gebaeude.loan_days`, 1 Woche bis 6 Monate, auf den nächsten Schultag
  verschoben, frei änderbar bis höchstens zwei Jahre) und Zubehör eintragen, „Verleihen“. Danach: Leihvertrag drucken, Rückgabe buchen
  (optional mit Befund zur Sache), Rückgabedatum ändern, versehentliche Ausleihe stornieren; frühere Ausleihen klappbar. Kopfzeile der
  Geräteseite zeigt „verliehen bis …“ bzw. „überfällig“. Tabelle `gebaeude_loans` (Migration `0128_inv_05_ausleihe.sql`), je Gerät
  höchstens eine offene Ausleihe (Sperre + Teilindex).
- **Übersicht** `/gebaeude/leihen` (Knopf „Leihgeräte“ in der Inventarliste): offene Ausleihen der eigenen Kategorien, überfällige zuerst,
  mit Person, Klasse, Rückgabedatum und Erinnerungsstand. **„Meine Leihgeräte“** `/gebaeude/leihen/meine` für alle Angemeldeten (eigene,
  bei Eltern die der Kinder lesend) plus Widget auf der Startseite, nur wenn etwas ausgeliehen ist.
- **Erinnerungen** (Job `gebaeude-leihe`, 06:50, Muster der Bücherei-Mahnungen BU-04, `nextDunningLevel` wiederverwendet): vor dem
  Rückgabedatum ein Gong an die Person (`gebaeude.loan_remind_days`, Vorgabe 3 Tage, abschaltbar, einmal je Rückgabedatum); danach nur an
  Schultagen bis zu drei Erinnerungen im Abstand von 7 Tagen, ab der zweiten auch an die Eltern Minderjähriger („handelt für“), bei der
  ersten ein gebündelter Hinweis an die Pflegenden (ohne Namen). Mail optional (`gebaeude.loan_mail`, Vorgabe aus, nur bestätigte
  Adressen). Gong und Mail nennen kein Gerät, nur „Meine Leihgeräte“. Frist ändern setzt die Erinnerungen zurück.
- **Leihvertrag** `/druck/leihvertrag/<id>`: Schule, Person, Klasse, Gerät (Hersteller/Modell, Inventar-/Seriennummer), Zubehör,
  Ausgabe- und Rückgabedatum, allgemeine Bedingungen (Vorlage), Feld „Besondere Vereinbarungen“, Unterschriften (bei Minderjährigen auch
  Erziehungsberechtigte), Rückgabeabschnitt. Nur Druck, nicht gespeichert.
- **Inventur:** Geräte mit offener Ausleihe stehen beim Start als „verliehen“ im Soll; beim Abschluss wird Offenes, das inzwischen
  verliehen ist, ebenfalls „verliehen“ statt „fehlt“ (Zählung, Protokoll, CSV). Wird ein verliehenes Gerät doch im Raum gescannt (oder
  „Doch hier“), gilt es als gefunden. Neuer Enum-Wert `verliehen`.
- **Datenschutz:** LK-ENDE-1J ab `returned_at` (offene bleiben), Eintrag im Manifest und im VVT-Eintrag „Gebäude & Technik“
  (Zweck, Betroffene Schüler:innen/Eltern, Empfänger), Auskunft: Rohdaten über den Kontoverweis plus lesbarer Teil „leihgeraete“,
  Eigenexport `Leihgeräte.txt`. Kontolöschung leert die Person (`set null`): die offene Ausleihe bleibt als „gelöschtes Konto“ stehen,
  bis die Rückgabe gebucht ist. Beim Abgang zeigt die Benutzerseite „Ausgeliehen: n Leihgeräte“ (blockiert nichts).
- **Audit:** `gebaeude.asset.loan`, `.loan.extend`, `.loan.cancel`, `gebaeude.asset.return` (Ziel = Gerät, Rückgabedatum bzw. „nach
  Fristende“/„mit Befund“, **ohne** Person) – erscheinen in der Historie der Geräteseite.
- **Entscheidungen bei offenen Punkten (konservativ, INV-05):**
  - Entleihende nur **Personen mit Konto** in den Bücherei-Rollen (Schüler:innen, Lehrkräfte, Personal, Beratung, Verwaltung) – keine
    Eltern, keine Admin-Konten, **keine Externen** ohne Konto (kein Freitext-Name, damit Löschfrist, Auskunft und Kontolöschung greifen).
  - Verleihen darf, wer die **Kategorie pflegt** (`gebaeude.inventory`/`configure` oder verantwortliche Gruppe, inv-4) – kein neues Recht.
  - Sicht auf die Person nur für diese Pflegenden und die Person selbst (Eltern lesend); `view_all` sieht nur „verliehen bis …“, alle
    anderen nichts. Wer verliehen hat, steht nur im Audit-Log.
  - Nur **Einzelstücke** in Betrieb sind verleihbar (keine Sammelposten); ein verliehenes Gerät lässt sich erst nach der Rückgabe ausmustern.
  - Zurückgegebene Ausleihen bleiben bis zum Löschlauf als Verlauf (Pflegende, Person) – anders als in der Bücherei, weil Schäden an
    Leihgeräten oft erst später auffallen (Konzept: LK-ENDE-1J ab Rückgabe).
  - Kein Gerät in Benachrichtigungen und Mails (wie Bücherei); Abstand der Erinnerungen fest 7 Tage, höchstens drei.
  - Leihvertrag mit allgemeinen Bedingungen und Freifeld; Haftung/Ersatz regelt die Schule bzw. der Schulträger (kein eigener Text in
    den Einstellungen, keine Ersatzforderung wie in der Bücherei).
  - Kein Gong beim Verleihen selbst (die Person bekommt den unterschriebenen Vertrag); kein Selbstverlängern durch die Person.

## Umgesetzt (INV-06, 2026-11-03)

- **„Schulträgerformat“ war nicht näher bestimmt** (kein vorgegebenes Format eines Schulträgers im Konzept) – konservativ ein
  **dokumentiertes CSV-Format** mit Spaltenzuordnung beim Import. Export und Import nutzen dieselbe Kopfzeile, ein Export lässt sich
  unverändert wieder importieren (alles „unverändert“). Code: `src/modules/gebaeude/inventar-csv.ts` (löst den CSV-Import aus INV-01 ab).

  | Spalte | Inhalt | Import |
  |---|---|---|
  | Inventarnummer | Schlüssel für „ändern“; leer = neu, Nummer vom Zähler | ja |
  | Bezeichnung | 2–120 Zeichen | Pflicht |
  | Kategorie | Name, Kurzname, Schlüssel oder Präfix (`matchCategory`) | Pflicht |
  | Hersteller, Modell, Seriennummer | Text (je 80) | ja |
  | Menge | 1–9999 (Sammelposten) | ja |
  | Zustand | neu, gut, gebraucht, defekt | ja |
  | Gebäude, Etage | Namen aus den Stammdaten | nur für Zeilen **ohne** Raum |
  | Raum | Raumkürzel | ja |
  | Anschaffungsdatum, Zweckbindung bis, Garantie bis | TT.MM.JJJJ (auch JJJJ-MM-TT) | ja |
  | Preis (EUR) | „1234,56“ (auch „1.234,56“) | ja |
  | Lieferant, Finanzierung | Text (je 120) | ja |
  | Letzte Prüfung | Datum; wird als übernommener Nachweis eingetragen (wie INV-01) | ja |
  | Nächste Prüfung | rechnet SchulOS | nur Export |
  | Ausgemustert am | Datum | nur zum Überspringen (s. u.) |

  Datei: Semikolon (Import auch Komma), UTF-8 mit BOM; Export mit `?kodierung=cp1252` für ältere Tabellenprogramme, Import erkennt
  Windows-1252 selbst. Weitere Schreibweisen der Köpfe (z. B. „Inv.-Nr.“, „Gegenstand“, „Gruppe“, „Gewährleistung bis“) werden
  erkannt; ohne Kopfzeile gilt die alte Spaltenfolge aus INV-01.
- **Export** „Als CSV exportieren“ in der Inventarliste (`/api/gebaeude/export/inventar`, Filter der Liste in der Adresse): lesen wie die
  Liste (`view_all`, `inventory`/`configure`, verantwortliche Gruppen nur ihre Kategorien), sonst 404. Zellen gegen Formeln entschärft
  (`toCsv`); das Hochkomma vor `=`/`+`/`-`/`@` fällt beim Import wieder weg. Audit `gebaeude.asset.export` nur mit der Anzahl.
- **Import in zwei Schritten:** (1) „Prüfen (Vorschau)“ – Trockenlauf, nichts wird gespeichert: je Zeile „neu“, „ändern“ (mit den
  geänderten Feldern), „unverändert“, „übersprungen“ oder „Fehler“; darunter die **Spaltenzuordnung** (Kopfzeile ja/nein, Feld je
  Spalte), „Mit dieser Zuordnung neu prüfen“. (2) „n Einträge übernehmen“ – der Server prüft Datei, Zuordnung und Rechte erneut und
  schreibt nur ohne Fehler, ganz oder gar nicht (Transaktion). Höchstens 512 KB und 2000 Zeilen. Audit `gebaeude.asset.import` mit
  Zahlen (angelegt, aktualisiert, übersprungen).
- **Frist-Hinweise in „Offen für dich“** (`src/modules/gebaeude/open.ts`): „Garantie läuft ab“ (warn) und „Zweckbindung endet“ (info)
  mit Anzahl, den ersten zwei Geräten und dem frühesten Datum, Link auf die Liste mit Filter „Frist“. Vorlauf als Moduleinstellung
  `gebaeude.deadline_days` (aus/30/60/90 Tage, Vorgabe 60); abgelaufene Fristen zählen nicht mehr.
- **Karte „Inventar“ im Raumsteckbrief** (`roomInventory`): Einträge und Stück je Kategorie, Link auf die nach Raum und Kategorie gefilterte
  Liste (neuer Filter „Raum“), „Inventar des Raums“. Nur bei eingeschaltetem Modul und Sicht aufs Inventar; verantwortliche Gruppen sehen
  nur ihre Kategorien. Die Ausstattung des Raums (RS-05) bleibt unberührt (inv-3).
- **Entscheidungen bei offenen Punkten (konservativ, INV-06):**
  - **Leere Zellen lassen den bisherigen Wert stehen** (auch „Raum“) – ein Import löscht nie Angaben; Leeren geht nur im Formular.
    (Der INV-01-Import setzte bei leerem Raum den Raum zurück.)
  - **Ausgemustertes ändert der Import nicht** („übersprungen“); Zeilen mit „Ausgemustert am“ ohne bekannte Nummer werden **nicht**
    angelegt; aus- und wieder in Betrieb nehmen nur auf der Geräteseite.
  - **Notiz und Ausmusterungsgrund** gehen nicht in den Export und kommen nicht aus dem Import (Freitext kann Namen enthalten – wie bei
    den übrigen Gebäude-Exporten). Ausleihen (Personen) sind nie Teil der Liste.
  - Gebäude/Etage gelten nur für Zeilen ohne Raum (sonst ergibt sich der Ort aus dem Raum; der Export schreibt sie zur Information mit).
  - Inventar **ohne Nummer** (Altbestand): eine Zeile ohne Nummer mit gleicher Bezeichnung, Kategorie und gleichem Raum gilt als derselbe
    Eintrag (nur wenn eindeutig) – sonst würde ein Re-Import doppeln.
  - Kategorien werden auch erkannt, wenn sie ausgeschaltet sind (der Export passt wieder); neu anlegen oder in eine ausgeschaltete Kategorie
    verschieben ist ein Zeilenfehler.
  - Eine Zeile mit fremder Kategorie (verantwortliche Gruppe) ist ein **Zeilenfehler** in der Vorschau, keine Sperre der ganzen Seite.
  - Frist-Hinweise nur für die **Pflegenden** der Kategorie (nicht für `view_all` allein), **kein Gong und keine Mail** – nur der Hinweis im
    Widget (inv-9). Der im Konzept genannte Fristen-Job der Prüfungen bleibt unverändert.
  - Den Frist-Filter gibt es auch ohne eingestellten Vorlauf (dann die nächsten 90 Tage).

## Umgesetzt (INV-07, 2026-11-03) – Block „Inventar“ abgeschlossen

- **Handbuch:** Starter-Seite „Gebäude und Technik: Inventar“ im neuen Bereich „Gebäude & Technik“ (`src/modules/hilfe/starter.ts`,
  sichtbar für das Personal): Mangel melden, Inventar pflegen, Etiketten drucken (Formate, „ab Etikett Nr.“, 100 % drucken), Geräteseite
  per Scan, Inventur, Ausleihe, Liste für den Schulträger, „Wer darf was?“. Das „?“ auf allen Seiten unter `/gebaeude` führt dorthin
  (`CONTEXT_PAGES`); Schüler:innen/Eltern sehen die Seite nicht und landen im Handbuch.
- **BETRIEBSHANDBUCH:** Verweis im Inhalt, Sofortmaßnahmen „Etikett abfotografiert/verloren“ und „Leihgerät mit Schuldaten verloren“.
- **DATENSCHUTZ §3.4** mit dem Stand INV-01…06 abgeglichen (Export/Import ohne Freitext und Personen, Frist-Hinweis, Etiketten-Zeile).
- **E2E** `e2e/inventar-abschluss.spec.ts`: INV-06 am Handy (Export-Kopfzeile, Import mit fremden Spaltennamen → Zuordnung → Übernahme,
  „Offen für dich“ → Frist-Filter, Karte im Raumsteckbrief → gefilterte Liste; 360 px, dunkel, axe) und INV-07 Rechte-Matrix mit
  Scan-Weg (Etikett abgemeldet → Anmeldung → direkt die Geräteseite). Etikettendruck (Bogen, Rolle, Sammeldruck, „ab Etikett Nr.“,
  Neuerzeugen) prüft weiter `e2e/inventar.spec.ts` „INV-01/02“.
- **Rechte-Matrix (Stand nach INV-06):**

  | Wer | Liste/Export | Geräteseite | Pflegen, Etiketten, Import, Ausleihe | Inventur | Kategorien, endgültig löschen | Karte im Steckbrief | Frist-Hinweis |
  |---|---|---|---|---|---|---|---|
  | `gebaeude.configure` (Verwaltung) | alle | voll | alle Kategorien | ja | ja | alle Kategorien | ja |
  | `gebaeude.inventory` (Vorgabe Gruppe Hausmeisterei) | alle | voll | alle Kategorien | ja | – | alle Kategorien | ja |
  | verantwortliche Gruppe einer Kategorie | nur eigene Kategorien | voll (eigene), sonst eingeschränkt | eigene Kategorien | – | – | eigene Kategorien | eigene |
  | `gebaeude.view_all` allein | alle (lesen) | voll (lesen) | – | lesen | – | alle Kategorien | – |
  | Beschäftigte mit `gebaeude.report` | – (404) | eingeschränkt + „Mangel melden“ | – | – | – | – | – |
  | Schüler:innen/Eltern (angemeldet) | – (404) | eingeschränkt, ohne „Mangel melden“ | – | – | – | – | – |
  | ohne Anmeldung | – | nur Anmeldeseite (gültig = ungültig) | – | – | – | – | – |

  „Eingeschränkt“ = Bezeichnung, Kategorie, Standort (inv-5); „voll“ = zusätzlich Seriennummer, Preis, Finanzierung, Fotos, Prüfungen,
  Historie, Etikett. Leihgeräte sehen Entleihende zusätzlich unter „Meine Leihgeräte“ (INV-05).
  Prüfungen: seit GS-02 kann jede Prüfart eine **zuständige Gruppe** haben (z. B. Fachschaft Chemie); deren Beschäftigte sehen, planen
  und erfassen nur Prüfungen dieser Art – unabhängig von der verantwortlichen Gruppe der Inventar-Kategorie (`docs/FACHRAUM-PRUEFUNGEN.md`).

## Folgeideen (Runde 14, freigegeben von der Projektleitung 2026-11-03)

Fragebogen inf-1…inf-6, alle wie vorgeschlagen. Aufgaben: BACKLOG, Block „Inventar“, Folge INV-08…INV-12 (Reihenfolge: nach VA-04,
vor RS-13).

- **inf-1 Zuschnitt:** Vertragsfelder + Ersatzbedarf-Auswertung; keine Beschaffung.
- **inf-2 Verträge:** Felder am Gerät (Partner, Ende, Kündigungsfrist, Notiz) mit Frist-Hinweis in „Offen für dich“; keine eigene
  Vertragstabelle (Sammelverträge bei Bedarf später). Kein Feld für Ansprechpersonen (Personenbezug vermeiden).
- **inf-3 Abschreibung:** nicht bauen, kein Restwert; Nutzungsdauer je Kategorie nur als Richtwert für den Ersatzbedarf.
- **inf-4 Beschaffung:** kein Bestellwesen, keine Wunschliste; die Ersatzbedarf-Auswertung dient als Grundlage fürs Gespräch mit dem
  Schulträger.
- **inf-5 Sicht:** Auswertung mit Preisen/Werten nur `gebaeude.configure` und `view_all`; verantwortliche Gruppen sehen nur ihre
  Kategorien.
- **inf-6 Etikettenstreifen 12/24 mm:** (inv-7 „später“) bleiben zurückgestellt bis zu einem konkreten Gerätewunsch.
