# Handbuch (Modul `hilfe`)

Freigegeben von der Projektleitung am 2026-10-28 (Fragebogen Runde 11). Aufgaben: `docs/BACKLOG.md`, Block „Handbuch“
(HB-01 ff.). Dieses Dokument hält Umfang, Datenmodell grob, Rechte, Datenschutz und Entscheidungen fest.

## Ziel

Ein schulinternes, durchsuchbares Nachschlagewerk „So läuft es bei uns“: Abläufe und Anleitungen für Personal, Schüler:innen
und Eltern an einer Stelle. Das Modul `hilfe` erscheint im Menü als „Handbuch“; ein „?“ in der Kopfzeile öffnet es.

Warum ein eigenes Modul: Beiträge der Neuigkeiten werden nach spätestens einem Jahr gelöscht und haben keine Gliederung;
Dateien sind an Mitglieder oder Eigentümer gebunden. Das Modul verwendet nur Bausteine der Neuigkeiten wieder
(Zielgruppen-Auflösung, Markdown, Suchanbieter- und Widget-Muster).

## Umfang

- **Stufe 1 (HB-01 bis HB-04):** Bereiche und Seiten (zwei Ebenen), Markdown-Editor, Zielgruppen je Seite (Rollen oder Gruppen,
  keine = alle), Reihenfolge, Entwurf/veröffentlicht, Verlinkung, Druckansicht, Volltextsuche und globale Suche, „?“ in der
  Kopfzeile, Ansprechperson je Seite, „Überprüfung fällig“ mit Gong (Vorgabe 12 Monate, abschaltbar).
- **Anhänge und Verlauf (HB-05, HB-06, freigegeben 2026-10-28):** Anhänge (PDF/Bilder/Office, Typ-/Größenprüfung, Virenscan) und Seitenverlauf (letzte 20 Fassungen je Seite, siehe „Vorgaben (HB-05…HB-08)“).
- **Starter-Seiten (HB-07):** wenige neutrale Vorlagen (Erste Schritte je Rolle, Zwei-Faktor, Krankmeldung, Kurswahl, Passwort
  vergessen), die die Schule kopiert und anpasst; keine automatische Aktualisierung, keine Fremdinhalte. Kontexthilfe: „?“ führt
  zur Seite des jeweiligen Moduls.

**Ausdrücklich nicht:** freies Wiki für alle, Kommentare/Diskussion (dafür Foren), Mehrsprachigkeit, Freigabe-Workflows mit
mehreren Stufen, Helpdesk/Tickets, Zugriff ohne Anmeldung.

## Datenmodell (grob)

Präfix `hilfe_`: `hilfe_sections` (Titel, Reihenfolge), `hilfe_pages` (Bereich, Titel, Text, Reihenfolge, Status,
Ansprechperson, Überprüfung fällig am, zuletzt geändert von/am), `hilfe_targets` (Seite, Rolle oder Gruppe), `hilfe_attachments` (HB-05) und `hilfe_revisions` (HB-06). Volltextindex auf Titel und Text.

## Rechte

Lesen: jede angemeldete Person, Sichtbarkeit ausschließlich über die Zielgruppen der Seite; der Service filtert selbst.
`hilfe.edit` (Seiten und Bereiche anlegen, ändern, veröffentlichen; Vorgabe Verwaltung) und `hilfe.manage` (alle Seiten,
Verlauf, Starter-Vorlagen). Die Ansprechperson darf ihre eigene Seite bearbeiten. Funktionsgruppen (IT, Hausmeisterei,
Fachschaften) erhalten die Rechte über Gruppenrechte. Entwürfe sehen nur Pflegende.

## Datenschutz

Der Inhalt ist organisatorisch; Personenbezug entsteht nur durch Ansprechperson und Bearbeiter:in. Diese Verweise folgen dem
Konto (Löschklasse `LK-KONTO`, beim Löschen leer gesetzt); die Seiten selbst unterliegen keiner automatischen Löschfrist.
Der Editor weist darauf hin, dass keine Schülerdaten sowie keine Gesundheits- oder Notendaten in Seiten gehören. Anhänge
werden vor dem Speichern geprüft. Kein Zugriff ohne Anmeldung. Verarbeitungszweck für das Verzeichnis: interne Hilfe und
Anleitungen. Rechtliche Einordnung: zu prüfen.

## Entscheidungen (Projektleitung 2026-10-28)

1. Eigenes kleines Modul `hilfe` statt Erweiterung von Neuigkeiten oder Dateien.
2. Pflege über `hilfe.edit` plus Ansprechperson für die eigene Seite.
3. Neutrale Starter-Seiten werden mitgeliefert.
4. Überprüfungs-Erinnerung mit Vorgabe 12 Monate, Gong, abschaltbar.
5. Zwei Gliederungsebenen (Bereich → Seite).
6. Sichtbarkeit über Zielgruppen; Starter-Seiten für Eltern und Schüler:innen vorbelegt sichtbar, eigene Seiten nur Personal.
7. Anhänge und Verlauf zunächst später, Stufe 1 nur Text – mit HB-05/HB-06 freigegeben (Projektleitung 2026-10-28), Verlauf letzte 20 Fassungen.
8. Menüname „Handbuch“, „?“ in der Kopfzeile.

## Umgesetzt (HB-01…HB-04)

Stand 2026-10-28, Migration 0116 (`hilfe_sections`, `hilfe_pages`, `hilfe_targets`, Enum `hilfe_page_status`).

- **Modul `hilfe`** (Menü „Handbuch“, Bereich Organisation; neue Installationen eingeschaltet, nach einem Update wie jedes neue
  Modul zunächst aus). Rechte `hilfe.edit` (Bereiche und Seiten anlegen, ändern, veröffentlichen, Reihenfolge) und `hilfe.manage`
  (zusätzlich Seiten und leere Bereiche löschen); Vorgabe beides für die Verwaltung, Funktionsgruppen über Gruppenrechte.
- **Sichtbarkeit** filtert der Service (`pageVisibility`): Pflegende sehen alles, die Ansprechperson ihre Seite (auch als Entwurf),
  alle anderen nur veröffentlichte Seiten ihrer Zielgruppen. Die Zielgruppen-Regel (keine Zeile = alle, Rolle oder Gruppe, Eltern über
  die Gruppen ihrer Kinder) teilt sich das Handbuch mit News über `src/core/school/audience.ts`; die Auswahl „Für wen?“ ist die
  gemeinsame Komponente `src/ui/target-picker.tsx`. Neue Seiten sind vorbelegt mit Lehrkräften, Personal, Beratung und Verwaltung.
- **Seiten** unter `/hilfe/<adresse>` (Adresse einmalig aus dem Titel, bleibt bei Umbenennung stabil – Ziel für Links
  `[Titel](/hilfe/adresse)`), Markdown wie News (`@schulos/ui/markdown`, ohne Roh-HTML), Entwurf/veröffentlicht, Reihenfolge per
  Pfeilen, Druckansicht `/druck/hilfe/<adresse>` (PDF über den Browser). Der Editor weist darauf hin, keine Schüler-, Gesundheits- oder
  Notendaten einzutragen.
- **Ansprechperson** (aktives Konto des Personals) darf ihre Seite bearbeiten – nur Titel und Text; Bereich, Status, Zielgruppen und
  Ansprechperson ändern Pflegende. Speichern oder „Geprüft, unverändert“ setzt „zuletzt geprüft“.
- **Suche:** Volltext (deutsch, GIN-Index auf Titel + Text) plus Teilwort im Titel auf `/hilfe?q=…`, Suchanbieter „Handbuch“ in der
  globalen Suche (Strg+K) – jeweils nur sichtbare Seiten.
- **„?“ in der Kopfzeile** (nur bei eingeschaltetem Modul) führt ins Handbuch; das Ziel liefert `helpHref()` in
  `src/modules/hilfe/context.ts`.
- **Überprüfung** (HB-04): Moduleinstellung „Erinnerung zur Überprüfung“ (aus / 6 / 12 / 24 Monate, Vorgabe 12). Tagesjob
  `hilfe-ueberpruefung` (07:15) schickt je fälliger, veröffentlichter Seite mit Ansprechperson genau einmal einen Gong an sie (bedingtes
  UPDATE in einer Transaktion); Prüfen setzt die Frist neu. Widget „Handbuch: Überprüfung fällig“: Pflegende sehen alle fälligen Seiten
  (auch ohne Ansprechperson), Ansprechpersonen ihre eigenen.
- **Datenschutz:** Verweise auf Personen mit `on delete set null` (Kontolöschung leert sie, die Seite bleibt), `LK-KONTO` im Manifest,
  `hilfe_sections` ohne Personenbezug, Auskunft (Ansprechperson: ganze Seite; Bearbeiter:in: Handlung mit Titel), DSB-FRAGEN §20, Zeile in
  DATENSCHUTZ.md §3.4. Demo: Bereich „Schulalltag“ mit „Fundsachen“ (alle) und „Kopierer im Lehrerzimmer“ (Personal, Überprüfung fällig).

## Umgesetzt (HB-05…HB-08)

Stand 2026-10-29, Migration 0119 (`hilfe_attachments`, `hilfe_revisions`). Damit ist das Modul fertig.

- **Anhänge (HB-05):** Unter dem Text jeder Seite; anhängen und löschen dürfen Pflegende und die Ansprechperson der Seite, sehen darf sie,
  wer die Seite sieht (`attachmentFile`, sonst einheitlich 404; Entwürfe nur Pflegende und Ansprechperson). Erlaubt: PDF, JPEG/PNG/WebP
  (Metadaten werden entfernt), Word/Excel/PowerPoint (doc/docx/xls/xlsx/ppt/pptx) und OpenDocument (odt/ods/odp) – Typ an den ersten Bytes
  geprüft, die Endung muss dazu passen, Makro-Formate, HTML, SVG und Programme sind nicht erlaubt. Auslieferung über
  `/api/hilfe/anhang/<id>`: Download; PDF und Bilder mit `?inline=1` im Browser; Typ fest aus der Datenbank, `nosniff`, CSP `sandbox`.
  Virenscan über `scanUpload` (wie die anderen Uploads), `hilfe_attachments.storage_key` steht in `STORAGE_KEY_COLUMNS`; die Datei
  verschwindet mit dem Anhang bzw. der Seite (sonst räumt der Dateispeicher-Lauf auf). Der Upload weist darauf hin, keine Personen-,
  Gesundheits- oder Notendaten anzuhängen.
- **Seitenverlauf (HB-06):** `updatePage` legt in derselben Transaktion den bisherigen Stand (Titel, Text, Verfasser:in, Zeitpunkt) in
  `hilfe_revisions` ab, sobald sich Titel oder Text ändern (Prüfen, Zielgruppen, Status allein nicht) und kappt auf die letzten 20.
  `/hilfe/<adresse>/verlauf`: Fassungen ansehen und wiederherstellen – nur Pflegende (`hilfe.edit`/`hilfe.manage`), auch die Ansprechperson
  nicht. Wiederherstellen setzt Titel und Text, der Stand davor wandert selbst in den Verlauf; Adresse, Status, Zielgruppen bleiben.
  Die Verfasser:in folgt dem Konto (`set null`).
- **Starter-Seiten (HB-07):** Bereich „Erste Schritte“ mit sieben neutralen Vorlagen, angelegt per Klick („Starter-Seiten anlegen“ auf
  `/hilfe`, nur Pflegende) über `createPage` – idempotent über die Adresse (vorhandene, auch umbenannte Seiten bleiben, nichts wird
  überschrieben oder doppelt angelegt). Sichtbarkeit laut Entscheidung 6: die Starter-Seiten sind für ihre Gruppen freigegeben (Eltern,
  Schüler:innen, Personal bzw. alle), eigene Seiten bleiben Vorgabe „nur Personal“. Danach gehören sie der Schule, keine automatische
  Aktualisierung. Die Demo-Schule enthält sie bereits. Titel: Erste Schritte für Eltern · Erste Schritte für Schülerinnen und Schüler ·
  Erste Schritte für Lehrkräfte und Personal · Zwei-Faktor-Anmeldung einrichten · Passwort vergessen · Krankmeldung · Kurswahl. Die Texte
  folgen den Menüpunkten und Schaltflächen der Oberfläche (Menü oben rechts, Abwesenheiten, Kurswahl …); schulspezifische Angaben fehlen
  bewusst.
- **Kontexthilfe:** `CONTEXT_PAGES` in `context.ts`: `/abwesenheiten` → Krankmeldung, `/kurswahl` → Kurswahl, `/konto/…` →
  Zwei-Faktor-Anmeldung einrichten; dazu je Rolle „Erste Schritte“ auf News, Kalender, Stundenplan, Messenger, Elternbriefe
  und Elternsprechtag (`contextPagesFor`). Die Shell reicht dem „?“ nur Zuordnungen, deren Seite die Person sehen darf
  (`visibleSlugs`); sonst führt „?“ ins Handbuch.
- **Datenschutz (HB-08):** `hilfe_attachments` (Verweis `uploaded_by`) und `hilfe_revisions` (`author_id`) in Manifest/Retention
  (`LK-KONTO`, `set null`), Auskunft (Upload nur als Handlung mit Seite und Dateiname, die Datei gehört zur Seite; eigene Fassungen ganz),
  DATENSCHUTZ.md §3.4, DSB-FRAGEN §20 neu erzeugt.

### Vorgaben (HB-05…HB-08)

- Anhänge: höchstens **10 je Seite**, **20 MB** je Datei (HB-05).
- Verlauf: die letzten **20 Fassungen je Seite** (HB-06, Projektleitung 2026-10-28; zuvor im Konzept 10). Ältere fallen beim Speichern weg.
- Starter-Seiten: sieben Vorlagen, Anlegen nur per Klick der Pflegenden.
