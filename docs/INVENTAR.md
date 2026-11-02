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
  Fachsammlungen, Werken, Musik, Hauswirtschaft, Sicherheit, Hausmeisterei, Chemikalienschrank (nur Verweis, inv-10), Möbel. Eigene
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
- **Noch offen (INV-04 ff.):** Inventur, Ausleihe, Export im Schulträgerformat, Karte im Raumsteckbrief.

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
