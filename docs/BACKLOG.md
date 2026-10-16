# SchulOS – Backlog

Legende: `[ ]` offen · `[x]` erledigt (Commit über die ID im Log auffindbar) · ❓ wartet auf Entscheidung (→ QUESTIONS.md) · 🧱 blockiert
Größe: **S** ≈ < 1 h · **M** ≈ 1–3 h. Was größer ist, wird geteilt.

---

## Phase 0 – Fundament

- [x] **P0-01** (S) Projektgerüst: Next.js 16 + TS strict, Tailwind v4, ESLint, Vitest, Skripte `dev`/`build` mit `--webpack`, `check` (tsc + lint + test)
  - AK: `npm run check` und `npm run build` sind grün, die Startseite rendert
- [x] **P0-02** (M) DB-Schicht: Drizzle + PGlite (`.data/pglite`), Postgres-Treiber über `DATABASE_URL`, Migrations-Skript, Test-Helfer mit In-Memory-PGlite
  - AK: ein Integrationstest legt in einer frischen In-Memory-DB eine Tabelle an und liest daraus
- [x] **P0-03** (M) Core-Schema: users, parent_child, groups, group_members, grants, group_features, modules_enabled, school_years, subjects (Farbe), rooms, periods, notifications, audit_log
  - AK: die Migration läuft, und die Typen werden exportiert
- [x] **P0-04** (M) Rechte-Engine `can()` + `requirePermission()` für Server Actions (Rolle → Gruppen-Grants → Gruppenleitung)
  - AK: ≥ 15 Unit-Tests, alle Pfade inkl. Admin-Override sind abgedeckt
- [x] **P0-05** (M) Modul-Registry: `defineModule()`, Manifeste einsammeln, Nav/Rechte/Widgets ableiten, an/aus über `modules_enabled`
  - AK: ein Dummy-Modul erscheint in der Nav und verschwindet, wenn es abgeschaltet ist (getestet)
- [x] **P0-06** (M) Auth: Better-Auth (Benutzername + Passwort), Login-Seite, Session-Helper, Middleware-Schutz der Shell
  - AK: ohne Login → Redirect; Login/Logout funktionieren (E2E folgt mit P0-12)
- [x] **P0-07** (M) Seed „Gesamtschule am Lindenhof": Schulleitung, ~25 Lehrkräfte, ~300 Schüler:innen in 12 Klassen, Eltern, Fächer mit Farben, Räume, Zeitraster, Fachschaften; deterministisch (fester Seed)
  - AK: `npm run db:reset` erzeugt die Schule reproduzierbar
- [x] **P0-08** (M) Design-System: Tokens (hell/dunkel, Schulfarbe als Akzent, Fachfarben), shadcn-Basiskomponenten, Typografie
  - AK: eine `/dev/ui`-Seite zeigt alle Komponenten in beiden Themes
- [x] **P0-09** (M) App-Shell: Sidebar (aus der Registry), Topbar mit Suche, Gong-Glocke, Profilmenü, Theme-Toggle; mobile Bottom-Bar
  - AK: Screenshot Desktop + Mobile
- [x] **P0-10** (S) Strg+K-Kommandopalette (Module, Aktionen, später Suchtreffer)
- [x] **P0-11** (S) Dev-Schnell-Login „Ansicht als …" (nur `NODE_ENV=development`)
- [x] **P0-12** (S) Playwright einrichten + Smoke-Test (Login je Rolle, Shell sichtbar, Screenshot)
- [x] **GATE 0** – Review mit der Projektleitung (2026-10-03: UI passt, Phase 1 in geplanter Reihenfolge)

## Phase 1 – Kern-Module

### Verwaltung
- [x] **P1-01** (M) Benutzerliste: Suche, Filter (Rolle/Klasse), Anlegen/Bearbeiten/Sperren, Passwort zurücksetzen
- [x] **P1-02** (M) Gruppenverwaltung: Gruppen anlegen, Mitglieder/Leitung, Gruppenmerkmale umschalten
- [x] **P1-03** (M) Rechteverwaltung: Matrix Rechte × Rollen/Gruppen, Module an/aus
- [x] **P1-04** (M) CSV-Import Schüler:innen (Vorschau, Fehlerliste, Klassenzuordnung)
- [x] **P1-05** (S) Audit-Log-Ansicht

### Heute & Querschnitt
- [x] **P1-06** (M) „Heute"-Seite: Widget-Raster aus der Registry, rollenabhängig, Begrüßung, Tagesleiste (Platzhalter bis P2)
- [x] **P1-07** (M) Gong: Benachrichtigungen (DB + SSE-Stream), Glocke mit Zähler, gelesen markieren
- [x] **P1-08** (M) Globale Suche: Postgres-Volltext, Module liefern Treffer, Anbindung an die Palette
- [x] **P1-09** (S) Adressbuch: Personen & Gruppen, Profil-Popover

### News
- [x] **P1-10** (M) Beiträge mit Zielgruppen (Rollen/Gruppen), Anheften, Ablaufdatum, Markdown, Widget „Neuigkeiten"

### Kalender
- [x] **P1-11** (M) Termine (persönlich/Gruppe/Schule), Monats-/Wochen-/Agendaansicht
- [x] **P1-12** (S) Serientermine (einfach: wöchentlich) + ICS-Export je Kalender

### Dateien
- [x] **P1-13** (M) Speicher-Abstraktion + eigene Dateien: Ordner, Upload (Drag & Drop), Download, Umbenennen, Löschen
- [x] **P1-14** (M) Gruppenordner (Gruppenmerkmal), Vorschau für Bild/PDF, Speicherkontingent

### Aufgaben
- [x] **P1-15** (M) Aufgabe stellen: Titel, Beschreibung, Anhänge, Gruppe(n), Start/Frist, Abgabetyp (Datei/Text/Bestätigung)
- [x] **P1-16** (M) Abgabe durch Schüler:innen, Status (offen/abgegeben/verspätet), Widget „Fällig"
- [x] **P1-17** (M) Lehrkraft-Übersicht: Abgabe-Matrix, Feedback + Bewertung, Rückgabe, Gong-Events

### Messenger
- [x] **P1-18** (M) Räume (direkt/Gruppe), Nachrichten, Echtzeit über SSE
- [x] **P1-19** (S) Ungelesen-Zähler, Lesestatus, Gruppenraum per Gruppenmerkmal

- [x] **P1-20** (S) E2E-Szenario Gate 1: Aufgabe → Abgabe → Feedback inkl. Gong
- [x] **GATE 1** – Review mit der Projektleitung (2026-10-03: abgenommen, Phase 2 wie vorgeschlagen, P2-00 vorweg)

## Phase 2 – Schulorganisation (bestätigt beim Gate 1) ✅ fertig

Entscheidung steht: Stundenplan wird **von Hand gepflegt** (kein Import aus fremder Stundenplan-Software).
Vorgeschlagene Reihenfolge: Stundenplan → Vertretung + Tagesleiste → Klassenbuch → Abwesenheiten
→ Elternbriefe → Buchungen → Klausurplan. Stammdaten (Fächer mit Farben, Räume, Zeitraster `periods`)
liegen schon im Core-Schema und im Seed.

### Datenschutz-Grundlage (aus docs/DATENSCHUTZ.md §4 – vor den neuen Modulen)
- [x] **P2-00** (M) Löschklassen zentral (DATENSCHUTZ.md §3.3) + `retention` im Modul-Manifest (Tabelle, Zweck, Datenkategorien, Löschklasse, Startspalte) für alle bestehenden Module nachtragen + Test „jede Tabelle mit Personenbezug ist deklariert“ (DS-01). Neue Phase-2-Module deklarieren ab dann von Anfang an. Abwesenheiten: nur „krank“/„sonstiger Grund“, keine Diagnose (Art. 9)

### Stundenplan & Vertretung
- [x] **P2-01** (M) Modul `stundenplan`: Tabelle `timetable_lessons` (Gruppe, Wochentag, Stunde, Fach, Lehrkraft, Raum, gültig von/bis, optional A/B-Woche) + Service „Plan für Person/Klasse/Raum/Lehrkraft an Tag X“ (Schüler:innen über Gruppen, Lehrkräfte über eigene Stunden, Eltern über Kinder)
- [x] **P2-02** (M) Pflege-UI für die Verwaltung: Raster (Mo–Fr × Stunden) je Klasse/Kurs, Stunde anlegen/ändern/löschen, Kollisionsprüfung (Lehrkraft/Raum doppelt belegt)
- [x] **P2-03** (M) Seed: realistischer Stundenplan für alle Klassen/Kurse der Demo-Schule (kollisionsfrei, Fachfarben)
- [x] **P2-04** (M) Ansicht „Mein Stundenplan“ (Wochenraster, Fachfarben, mobil als Tagesliste) + Widget **Tagesleiste** auf „Heute“ wie im Mockup (laufende Stunde hervorgehoben, „noch 23 Min.“)
- [x] **P2-05** (M) Vertretungen: Tabelle `substitutions` (Datum, Stunde, Ausfall | Vertretung durch | Raumänderung, Hinweis), Pflege-UI für Verwaltung, Anzeige in Plan + Tagesleiste (orange/durchgestrichen), Gong an Betroffene
- [x] **P2-06** (S) Vertretungsplan-Seite „Heute/Morgen“ für alle (nach Klasse gruppiert) – Basis für späteren Infobildschirm

### Klassenbuch & Abwesenheiten
- [x] **P2-07** (M) Modul `klassenbuch`: je gehaltener Stunde Thema/Hausaufgabe eintragen (Lehrkraft der Stunde), Fehlzeiten-Checkliste der Klasse, Verspätung
- [x] **P2-08** (M) Klassenbuch-Ansicht für Klassenleitung: Woche/Monat, fehlende Einträge markiert, Fehlzeiten-Summen je Schüler:in
- [x] **P2-09** (M) Modul `abwesenheiten`: Eltern melden Krankheit (Zeitraum, Grund) für ihr Kind → Klassenleitung bestätigt/entschuldigt, Gong; Verknüpfung mit Klassenbuch-Fehlzeiten (unentschuldigt ↔ entschuldigt)

### Elternbriefe, Buchungen, Klausuren
- [x] **P2-10** (M) Modul `elternbriefe`: Brief an Klassen/Jahrgänge (Markdown + Anhang), Empfänger = Eltern der Schüler:innen, Lesebestätigung, optional Rückmeldefelder (Ja/Nein, Text), Übersicht „19 von 27 bestätigt“ + „Erinnern“-Knopf (Mockup)
- [x] **P2-11** (M) Modul `buchungen`: buchbare Ressourcen (Räume aus Stammdaten + Geräte wie Laptopwagen), Buchung je Datum/Stunde, Konfliktprüfung inkl. Stundenplan-Belegung
- [x] **P2-12** (M) Modul `klausurplan`: Klausuren/Klassenarbeiten je Gruppe eintragen, Regeln prüfen (max. 1 pro Tag, max. 3 pro Woche je Gruppe), Anzeige im Kalender + Stundenplan

- [x] **P2-13** (S) E2E-Szenario Gate 2: Vertretung eintragen → Schülerin sieht sie in der Tagesleiste + Gong; Elternteil meldet Krankheit → Klassenleitung entschuldigt → Klassenbuch zeigt „entschuldigt“
- [x] **GATE 2** – Review mit der Projektleitung (2026-10-03: abgenommen, Phase 2b vor Track B)

## Phase 2b – Stunden- und Raumplanung, Statusmonitor, Schulformen (bestätigt 2026-10-03) ✅ (Gate 2b abgenommen 2026-10-04)

Konzept: [`STUNDENPLAN.md`](STUNDENPLAN.md). Entscheidungen: vor Track B · **echter Solver in 2b** · alle
weiterführenden Schulformen ohne Berufskolleg · alle 16 Länder, NRW als ausgearbeitete Vorlage.

### S1 Fundament
- [x] **P2b-01** (M) Schulprofil: Bundesland + Schulform in den Einstellungen, Verwaltung → Schule; Katalog der Schulformen (Jahrgänge, Gruppenarten, Begriffe) als Daten
- [x] **P2b-02** (M) Jahrgangsstufen als Stammdaten (Kürzel, Name, Stufe Sek I/Oberstufe, Reihenfolge) + Gruppen: Niveau (E/G, GK/LK …) und weitere Arten (Wahlpflicht, Förderkurs), Leitungsbezeichnung je Art
- [x] **P2b-03** (M) Stammdaten-UI Fächer (Kürzel, Name, Fachfarbe, Raumart-Wunsch) und Zeitraster (Stunden bearbeiten)
- [x] **P2b-04** (M) Stammdaten-UI Räume (Art, Kapazität, Gebäude/Etage, Ausstattung, barrierefrei, aktiv) und Schuljahre/Halbjahre
- [x] **P2b-05** (M) Ferien + Feiertage je Bundesland (Feiertage berechnet, Ferien als pflegbarer Datensatz, unterrichtsfreie Tage); Stundenplan, Tagesleiste, Vertretung, Klassenbuch, Buchung berücksichtigen sie
- [x] **P2b-06** (S) Vorlagen je Schulform (Stundentafel, Zeitraster) als Daten; Demo-Seed nutzt sie

### S6 Statusmonitor (vorgezogen – Pflicht)
- [x] **P2b-07** (M) Monitore in der Verwaltung (Name, Ort, Profil Foyer/Lehrerzimmer, Token erneuern/widerrufen, „zuletzt gesehen“) + Kiosk-Seite `/monitor/<token>` ohne Login: Vertretungsplan heute/nächster Schultag, Uhr, Seitenblättern, Laufband aus News („auf dem Monitor“), Termine des Tages, Offline-Toleranz

### S2 Planungsgrundlagen
- [x] **P2b-08** (M) Unterrichtsverteilung: Lehraufträge (Gruppe(n), Fach, Wochenstunden, Lehrkraft(en), Doppelstunden-Wunsch, Raumwunsch) mit Soll/verplant je Klasse und je Lehrkraft
- [x] **P2b-09** (M) Deputate: Pflichtstunden, Ermäßigungen/Anrechnungen mit Grund, Konto Soll/Ist je Lehrkraft
- [x] **P2b-10** (L, 2 Commits) Kopplungen: eine Stunde mit mehreren Gruppen, Lehrkräften und Räumen (Religion/Philosophie, WP, E-/G-Kurse, Teamteaching); Umbau von Plan, Kollisionen, Vertretung, Klassenbuch
- [x] **P2b-11** (S) Stammräume je Klasse + Raumwünsche je Fach

### S3 Planen
- [x] **P2b-12** (M) Setzhilfe: offene Stunden aus der Unterrichtsverteilung, Raster zeigt frei/belegt für Lehrkraft, Klasse und Raum mit Grund; Verschieben/Tauschen
- [x] **P2b-13** (M) Diagnose: offene Stunden, Hohlstunden, Fach mehrfach am Tag, Stundentafel, Raum ungeeignet, Deputat über/unter
- [x] **P2b-14** (S) Periode kopieren (Halbjahreswechsel ab Stichtag)
- [x] **P2b-15** (S) Druck/PDF: Klassen-, Lehrkraft-, Raum- und Vertretungsplan als Druckansicht

### S4 Raumplanung
- [x] **P2b-16** (M) Raumsuche (frei zu Zeitpunkt, Filter Kapazität/Art/Ausstattung) + Belegungsraster aller Räume + Auslastung
- [x] **P2b-17** (M) Raumsperrungen (Zeitraum, Grund → Vertretungsbedarf) + Raumvorschläge nach Passung

### S5 Vertretung Pro
- [x] **P2b-18** (M) Abwesenheiten von Lehrkräften (ganz-/stundenweise) und Klassen → offene Stunden + Freisetzungen, Übersicht „Vertretungsbedarf heute“
- [x] **P2b-19** (M) Vertretungsvorschläge mit Punkten und Begründung + Zähler/Statistik je Lehrkraft und Klasse
- [x] **P2b-20** (M) Pausenaufsichten: Bereiche, Aufsichtsplan, offene Aufsichten bei Abwesenheit, Anzeige im Lehrerzimmer-Monitor

### S3b Automatische Planung (Solver)
- [x] **P2b-21** (M) Zeitwünsche je Lehrkraft, Klasse, Raum, Fach (-3 … +3, gesperrt) mit UI
- [x] **P2b-22** (L, 2 Commits) Solver-Kern (reines TypeScript, deterministisch): harte Regeln (Kollisionen, Kopplungen, Sperrzeiten, fixierte Stunden, Räume), weiche Regeln mit Gewichten (Zeitwünsche, Hohlstunden, Doppelstunden, Fach je Tag, Raumwunsch, Randstunden); Bewertung erklärbar
- [x] **P2b-23** (M) Solver-Bedienung: als Hintergrundjob starten, Fortschritt, Vorschau mit Bewertung/Diagnose, Stunden fixieren, übernehmen ab Stichtag

### S7 Abschluss
- [x] **P2b-24** (M) Demo-Seed auf die neuen Strukturen (Unterrichtsverteilung → Solver erzeugt den Demo-Plan) + zweites Schulprofil (Gymnasium) in Tests
- [x] **P2b-25** (S) E2E-Szenario Gate 2b: Lehrkraft krank → offene Stunden → Vorschlag übernehmen → Monitor zeigt die Vertretung; Raumsperrung → Raumvorschlag
- [x] **GATE 2b** – Review mit der Projektleitung (2026-10-04: abgenommen, weiter mit Track B)

## Track B – Betriebsreife (gestartet 2026-10-04, nach Gate 2b)

Konzepte: [`DATENSCHUTZ.md`](DATENSCHUTZ.md) (DSGVO, Löschkonzept) · [`INSTALLATION.md`](INSTALLATION.md) (ISO, §5a Updates).
Reihenfolge mit Absicht: Datenschutz und Sicherheit laufen komplett lokal (PGlite, Playwright); Container und
ISO brauchen Docker bzw. QEMU und damit eine CI (auf diesem Rechner gibt es kein Docker).

### S1 Datenschutz-Kern (DATENSCHUTZ.md §3.7, §4)
- [x] **B-01** (M) DS-02 Löschlauf: Fristen je Löschklasse aus den Manifesten auswerten, **Vorschau** („heute Nacht würden … gelöscht“), Lauf mit **Löschprotokoll** (Anzahlen je Tabelle/Lauf, keine Inhalte), **Löschsperre** (Person/Gruppe, Grund, befristet, Audit); Verwaltung → Datenschutz → Löschlauf
- [x] **B-02** (M) DS-03 Konto-Lebenszyklus: aktiv → gesperrt (Abgang mit Datum) → gelöscht nach Frist (über den Löschlauf), Elternkonten folgen den Kindern; Löschung auf Antrag (Art. 17) mit Anzeige, was wegen Aktenpflicht bleibt
- [x] **B-03** (L, 2 Commits) DS-04 Auskunft auf Knopfdruck: `exportForUser()` je Modul im Manifest, ZIP (JSON + Dateien), ausgelöst durch die Verwaltung, protokolliert; Test „jedes Modul mit Personenbezug liefert einen Export“
- [x] **B-04** (S) DS-05 Eigenexport „Meine Dateien und Abgaben herunterladen“ (Schüler:innen, Lehrkräfte)
- [x] **B-05** (M) DS-06 + DS-07 Datenschutzhinweise und VVT aus den Manifesten (Zwecke, Kategorien, Fristen, Empfänger) als druckbare Seiten, ergänzt um Freitext der Schule
- [x] **B-06** (M) DS-08 Audit-Log mit Frist und Pseudonymisierung alter Einträge; Lesezugriffe auf sensible Daten (Fehlzeiten, Klassenbuch, Auskunft) protokollieren
- [x] **B-07** (S) DS-09 Profilbilder nur mit Einwilligung (Schalter + Nachweis), sonst Initialen
- [x] **B-08** (L, 2 Commits) DS-10 Schuljahreswechsel-Assistent: neues Schuljahr, Versetzung, Abgänger markieren, Gruppen archivieren, Archivexport, Löschlauf-Vorschau, Pflichtschritt „Löschprotokoll und Sperren geprüft“

### S2 Sicherheit + CI
- [x] **B-09** (M) 2FA (TOTP) mit Wiederherstellungscodes; Pflicht für Verwaltung, Schulleitung, Admin (Einrichtung beim ersten Login)
- [x] **B-10** (S) Rate-Limit und vorübergehende Sperre bei Fehlversuchen (Login, Passwort-Reset), Hinweis in der Verwaltung
- [x] **B-11** (S) Passwortregeln (Länge, bekannte Passwörter), Pflicht-Wechsel bei Erstanmeldung bzw. nach Reset
- [x] **B-12** (S) Security-Header + CSP (Nonce), Next-Telemetrie aus, Cookies `Secure`/`SameSite`, Test der Header
- [x] **B-13** (M) CI-Grundgerüst (GitHub Actions, freigegeben 2026-10-04): `check` + `build` + E2E bei Push, Dependabot, Lizenzprüfung der Abhängigkeiten

### S3 Container (OPS-1, INSTALLATION.md §8)
- [x] **B-14** (M) Postgres-Pfad: Integrationstests in der CI zusätzlich gegen echtes PostgreSQL 18
- [x] **B-15** (M) `output: "standalone"`, Dockerfile (Nicht-Root, Node 24 LTS statt 22), Migrationen beim Start, Konfiguration aus `/srv/schulos/config` bzw. Umgebung
- [x] **B-16** (M) Erststart: `instance.type = demo | production` – Demo-Seed oder leere Instanz mit Admin aus der Konfiguration; Demo-Band; Demo → Produktiv technisch ausgeschlossen
- [x] **B-17** (S) Hintergrundjobs im App-Prozess (Löschlauf nachts, Solver-Läufe, später Backup-Status) mit Sperre gegen Doppelläufe
- [x] **B-18** (M) `compose.yaml` Hauptsystem (Caddy mit SSE, App, Postgres 18), Smoketest in der CI (Stack starten, `/api/health`, Login)
- [x] **B-19** (S) „Nur für NRW freigegeben“ (Entscheidung 2026-10-04): Erststart/Installer-Konfiguration lehnt `SCHULOS_SCHOOL_STATE` ≠ NW nicht ab, weist aber deutlich darauf hin; dauerhafter Hinweis in Verwaltung → Schule und in den Datenschutzhinweisen/VVT (Warnung gibt es schon), README/INSTALLATION.md ergänzen
- [x] **B-20** (M) Ferien automatisch je Land (Entscheidung 2026-10-04): Quelle wählen und Lizenz/Verlässlichkeit prüfen (Kultusministerien/KMK-Tabelle, ICS-Feeds, ferien-api o. ä.), Hintergrundjob (B-17) lädt Ferien des eingestellten Bundeslandes für aktuelles + nächstes Schuljahr, Vorschau/Änderungen in der Verwaltung sichtbar, Handpflege bleibt möglich und hat Vorrang; ohne Internet still weiter mit Handpflege
- [x] **GATE B1** – Review mit der Projektleitung (2026-10-04: abgenommen) (Datenschutz-Kern, Sicherheit, Container); danach OPS-2…4 in Einzelaufgaben zerlegt (S4–S6)

### S4 Backup (OPS-2, INSTALLATION.md §4) – zerlegt bei Gate B1 (2026-10-04), Gate B2 abgenommen (2026-10-05)
Ziel: zwei Compose-Stacks (Hauptsystem + Backupserver), die sich gegenseitig sichern – noch ohne ISO.
- [x] **B-21** (M) npm-Workspaces: SchulOS bleibt im Repo-Root (Entscheidung 2026-10-04), neu `packages/ui` (UI-Bausteine + Tokens aus `src/ui`, SchulOS importiert daraus) und `apps/backup` (leere Next-App, webpack); `check`/Lizenzprüfung/CI über alle Workspaces
- [x] **B-22** (M) Backup-App Grundgerüst: eigene DB (PGlite/Postgres, Drizzle), Konten über Better-Auth mit 2FA-Pflicht, Admin beim Erststart aus der Konfiguration, Audit-Log, Layout aus `packages/ui`, Dockerfile
- [x] **B-23** (M) Kopplung: Kopplungscode (24 h, einmalig), TLS mit Fingerabdruck-Pinning, rest-server `--append-only --private-repos` mit eigenem Zugang je Instanz; Repo-Schlüssel entsteht auf dem Hauptsystem (Kopie an den Backupserver), Wiederherstellungsschlüssel einmal anzeigen + bestätigen; Hauptsystem: Verwaltung → Backup → „Backupserver koppeln“
- [x] **B-24** (M) Backup-Agent (eigenes Image: Node + restic + Postgres-18-Client): holt Zeitplan/Regeln per API, sichert `pg_dump` + `files/` + `config/` (inkl. `secret.env`), meldet Ergebnis (Dauer, Größe, Snapshot); Hauptsystem: Statuskarte, rote Warnung ohne Kopplung bzw. > 26 h, „Jetzt sichern“
- [x] **B-25** (M) Backupserver-Web-UI: Übersicht (Ampel je Instanz), Zeitplan, Aufbewahrung 14/4/3 mit Vorschau und Warnung > 3 Monate, Snapshot-Liste; Prune nach Zeitplan nur auf dem Backupserver; Konten (weitere Admins anlegen, sperren, 2FA zurücksetzen, Passwort ändern)
- [x] **B-26** (M) Prüfungen: wöchentlich `restic check`; monatlich Test-Restore auf DB-Ebene (Test-Postgres-Sidecar, Migrationsstand, Tabellenzählung, Datei-Prüfsummen), ohne Docker-Socket (Entscheidung 2026-10-04) – Start des App-Images dagegen kommt mit OPS-3 über den Host
- [x] **B-27** (L, 3 Commits) Restore auf das Hauptsystem (ganz / nur Dateien): Auftrag vom Backupserver, **Bestätigung per Code auf dem Hauptsystem**, Wartungsmodus der App, Agent spielt `pg_restore` + Dateien zurück, App-Neustart (kein Docker-Socket); Erststart-Modus „aus Backup wiederherstellen“
- [x] **B-28** (M) `compose.backup.yaml` (Caddy, Backup-App, rest-server, Test-Postgres) + Agent im Haupt-Stack; CI-Job `backup` (koppeln, sichern, Test-Restore, Restore); INSTALLATION.md/DATENSCHUTZ.md nachziehen
- [x] **GATE B2** – Review Backup mit der Projektleitung (2026-10-05: abgenommen)

### S5 Betrieb und Updates (OPS-3, INSTALLATION.md §5a)
- [x] **B-29** (M) Releases: SemVer, Release-Manifest (Version, Kanal, Mindestversion, Änderungen in Alltagssprache, sicherheitsrelevant), Release-Workflow → GHCR (App, Backup, Agent), Signatur mit **cosign-Schlüsselpaar** (Secret in GitHub, öffentlicher Schlüssel in `schulosctl`; Entscheidung 2026-10-04), Kanäle beta → stabil nach 2 Wochen
- [x] **B-30** (S) Wöchentlicher Image-Neubau → automatisches Patch-Release bei geänderten Basis-Images
- [x] **B-31** (M) `schulosctl` Grundgerüst (TS, läuft direkt mit Node 24): `status`, `backup now`, `reset-admin`, `demo-reset`, `support-bundle` (ohne Personendaten)
- [x] **B-32** (L, 2 Commits) `schulosctl update`: Signatur prüfen, Backup, **Probelauf** auf Kopie (Migrationen, Healthcheck, Rauchtest mit technischem Konto, Löschnachweis), Update, Healthcheck, Rückweg; Zwischenversionen; Update-Protokoll; Test-Restore mit App-Start (Ergänzung zu B-26)
- [x] **B-33** (M) Verwaltung → System: Version, Kanal, verfügbare Updates, Freigabe, Protokoll, Backup-Status, Debian-Supportende; App ↔ Host über Auftragstabelle/-datei + systemd-Timer (kein Docker-Socket in der App)
- [x] **B-34** (S) Wartungsfenster: Patch-Updates automatisch per Timer, neue Module kommen ausgeschaltet
- [x] **B-35** (M) Vorschau-Instanz: Compose-Projekt `schulos-vorschau` (Demo, Band „VORSCHAU“, nächtlicher Reset, eigene Subdomain, abschaltbar)
- [x] **B-36** (S) Offline-Bundle: `schulosctl bundle create|import` (Images + Manifest + Signatur)
- [x] **B-37** (M) Offsite-Kopie vom Backupserver (SFTP/S3, `restic copy`, gleiche Aufbewahrung, Stand in der Übersicht)
- [x] **B-38** (M) E-Mail (SMTP gibt es bisher nicht): Konfiguration + Testmail auf beiden Seiten; Alarme (Backup überfällig, Prüfung fehlgeschlagen, Platz knapp, Update fehlgeschlagen)
- [x] **B-39** (M) CI-Update-Test N−1 → N inkl. Probelauf und Rückweg (ohne ISO)
- [x] **GATE B3** – Review Betrieb mit der Projektleitung (abgenommen 2026-10-05)

### S6 ISO (OPS-4, INSTALLATION.md §2, §3, §7)
- [x] **B-40** (M) Installer-Logik (rein, Vitest): Fragen aus §3 als Schema, Prüfungen, `schulos-install.yaml` lesen/schreiben (Export ohne Passwörter), `schulos.env`/`.env`/Stack je Rolle erzeugen
- [x] **B-41** (M) TUI (Ink): alle Fragen vorab, Plattenwahl, Erreichbarkeit Backupserver + Kopplungscode, Zusammenfassung
- [x] **B-42** (L, 2 Commits) Systemschritte: GPT/UEFI, LUKS (TPM2/Passphrase), btrfs `@`/`@srv`/`@snapshots`, mdadm-Spiegel, debootstrap offline, Docker (containerd-Image-Speicher, B-36) + Images, systemd-Units (`deploy/systemd`), Konsolenstatus mit QR; Modi „aus Backup“/„aus Offsite“
- [x] **B-43** (M) OS-Updates: `unattended-upgrades`/`needrestart`, Neustart im Wartungsfenster mit Backup, snapper + grub-btrfs, `schulosctl os-upgrade` mit automatischem Rückweg
- [x] **B-44** (M) ISO-Bau mit live-build in GitHub Actions (Offline-Paketquelle, Images als tar)
- [x] **B-45** (L) QEMU-Tests in der CI (§7 Schritte 1–6), nur bei Tag bzw. von Hand – Schritt 5 vorerst über `scripts/update-test.sh` (Projektleitung 2026-10-06), in den QEMU-Test mit der ersten Release-ISO
- [x] **B-46** (S→M) qcow2 je Rolle mit cloud-init (`schulos-install.yaml`) – Entwurf freigegeben (2026-10-06): ohne LUKS, growpart + btrfs resize, eigener Dienst statt `cloud-init`, siehe QUESTIONS.md
- [x] **B-53** (S, vorgezogen aus S7 – Projektleitung 2026-10-05) Sicherheitsprüfungen in der CI: Secret-Scan (gitleaks, auch als pre-commit), Abhängigkeiten (`npm audit` bzw. osv-scanner), Images (Trivy, nur kritische/hohe brechen ab), Workflows (zizmor)
- [x] **GATE B4** (abgenommen 2026-10-06, PR #2 – B-46 folgt mit freigegebenem Entwurf) – Review ISO mit der Projektleitung; vorher Review-PR für S6 (B-40…B-46) anlegen, Projektleitung startet `/code-review ultra <PR>` (Freiläufe vorhanden), Ergebnis in die Gate-Besprechung

### S7 Härtung vor echtem Einsatz (Vorschläge 2026-10-05) – Reihenfolge: B-55, B-54, B-48, B-47, B-49, B-50a, B-51; Lasttest auf Zielhardware B-50b und B-52 ganz zuletzt (Projektleitung, 2026-10-06)
Reproduzierbarkeit
- [x] **B-47** (M) Reproduzierbare ISO: Debian über `snapshot.debian.org` mit festem Datum (`SCHULOS_DEBIAN_MIRROR`, Datum im Repo, Updates bewusst per neuem Datum), Fremd-Images (`caddy`, `postgres`, `node:24-trixie`) per Digest statt Tag (Dependabot hält sie aktuell), `SOURCE_DATE_EPOCH`; Prüfung: zwei Builds desselben Commits vergleichen (`diffoscope`)
- [x] **B-48** (S) Stückliste in jeder ISO und jedem Release: Debian-Pakete mit Version, Image-Digests, Node-Version, Git-Commit (SBOM, z. B. syft) – „was genau liefern wir aus“ auch ohne bitgleichen Build
- [x] **B-49** (M) Release-ISO aus den signierten GHCR-Images (cosign prüfen) statt Neubau aus dem Repo-Stand
Last und Datenbank
- [x] **B-50a** (M) Lasttest simuliert auf der Build-VM (k6): Demo-Hauptsystem aus ISO/qcow2 als VM mit begrenzter CPU/RAM (z. B. 2/4/8 Kerne), Ablauf Montag 7:40 – ~300 gleichzeitige Anmeldungen, Vertretungsplan, Stundenplan, Dateiablage, Elternzugriffe; Antwortzeiten (p95), Engpass (Node-CPU vs. Postgres vs. Platte), langsame Abfragen/N+1 → Grundlage für B-51/B-52 und grobe Mindesthardware in INSTALLATION.md; kleine Variante als Regressionswächter in der CI prüfen. Grenzen: geteilter Host, keine echte Platte/Netz – nur relative Aussagen
- [ ] **B-50b** (S, ganz zuletzt – vor einem echten Einsatz) Lasttest auf Zielhardware: Szenario aus B-50a auf dem echten Server im Schulnetz, Mindesthardware in INSTALLATION.md bestätigen
- [x] **B-51** (S) Postgres für den Server einstellen (RAM-abhängig `shared_buffers`, `effective_cache_size`, `work_mem`; Pool-Größe der App passend), `pg_stat_statements` an, langsame Abfragen in Verwaltung → System
- [x] **B-56** (S, Vorschlag aus B-50a; erledigt 2026-10-08: +11,5 % Durchsatz, p95 Heute −30 % – docs/LASTTEST.md) Einstellungen (`app_settings`, ~3× je Anfrage) und Rechte/Sitzung je Anfrage zwischenspeichern (React `cache`), danach Lasttest 2 Kerne/1000 Nutzer vergleichen; außerdem prüfen, warum Heute und Stundenplan doppelt so viel CPU brauchen
- [ ] **B-52** (M, nur wenn B-50a/B-50b es verlangen – B-50a: für ~600 Konten nicht nötig, erst ab ~400–500 gleichzeitig Aktiven) Mehrere App-Instanzen hinter Caddy: vorher klären, dass Hintergrundjobs nur einmal laufen (Sperre in der DB), Sitzungen/Rate-Limit nicht prozesslokal
Sicherheit
- B-53 → vorgezogen in S6 (vor GATE B4)
- [x] **B-54** (M) Dynamischer Test: OWASP ZAP (Baseline + angemeldet) gegen den Stack in der CI; Bedrohungsmodell (Rollen Schüler/Eltern/Lehrkraft gegen fremde Daten, IDOR je Modul) als `docs/SICHERHEIT.md` mit Tests für jede Annahme
- [x] **B-55** (S) Code-Review vor dem ersten echten Einsatz: `/security-review` je Block, tiefes Review (`/code-review ultra`, von der Projektleitung ausgelöst) über Installer-Systemschritte, Anmeldung/2FA, Rechteprüfung, Backup-Kopplung
  - Befunde aus `/code-review ultra` auf PR #10 (alle schon vor dem PR vorhanden, 2026-10-06):
  - [x] **B-55a** (S) Sperrzähler atomar: Fehlversuch per Upsert in SQL hochzählen statt Lesen → in JS rechnen → Schreiben (gleichzeitige Fehlversuche gingen verloren) – Hauptsystem und Backupserver
  - [x] **B-55b** (S) Kopplung wiederholbar: bricht die Verbindung nach dem „claim“ ab, liefert ein erneuter Versuch mit demselben Code dasselbe Ergebnis (statt 404 und verwaister Instanz)
  - [x] **B-55c** (S) `requestJson()` begrenzt die Antwortgröße (ungeprüftes TLS beim „hello“ der Kopplung)

## Phase 3 – Unterricht & Zusammenarbeit (zerlegt und von der Projektleitung freigegeben 2026-10-08)

Grundlage: PLAN.md §4 (Kurse, Umfragen + Schnellumfragen, Foren, Pinnwände; Texte/Tafeln als 3b). Vorgeschlagene Reihenfolge:
Kursraum → Umfragen → Foren → Pinnwände → Gate 3; danach 3b (Texte, Tafeln) nach eigener Entscheidung. Jede neue Tabelle mit
Personenbezug bekommt von Anfang an `retention` (Löschklasse), VVT-Eintrag und Auskunft (Track B S1). Gruppenbezogene Bereiche hängen
als `groupFeatures` an Gruppen wie Gruppenchat/-ordner/-kalender – keine neue Gruppenart „Kurs“, die vorhandenen Arten (Klasse, Kurs,
AG, Wahlpflicht, Förderkurs …) reichen.

### S0 Vorab: schnellere CI mit einem Runner (Projektleitung, 2026-10-08)
- [x] **CI-01** (S) CI beschleunigen und Merge absichern – Anlass: Branch-Protection/Pflicht-Prüfungen gibt es im privaten Repo ohne GitHub Pro nicht, `gh pr merge --auto` merged dann sofort (Gate-PR #28 vor Ende der CI gemergt); eine CI-Runde belegt den einzigen Runner ~14 min (verify 7, stack 3–4, backup 3, postgres 1), Doku-PRs genauso, Sicherheitsjobs (Sekunden) warten bis zu 25 min. Umsetzen:
  1. `scripts/pr-merge.sh <nr>`: wartet, bis alle Checks fertig sind, merged nur ohne fail/cancel (`--merge --delete-branch`, nie `--auto`); Loop-Protokoll in CLAUDE.md darauf umstellen
  2. Doku-PRs erkennen: erster kleiner Job prüft per `git diff`, ob nur `docs/**`/`*.md` geändert sind → `verify`/`stack`/`backup`/`postgres` überspringen (Ergebnis „übersprungen“ zählt im Merge-Skript als grün)
  3. Zweiter Runner-Dienst auf der Build-VM (eigenes Arbeitsverzeichnis, Label `leicht`) für Jobs ohne Docker (Sicherheit: secrets, dependencies, workflows); `platz` dort nicht aufrufen, damit kein `docker prune` einen laufenden Job trifft
  4. Next-Build-Cache (`.next/cache`) und npm-Cache auf dem self-hosted Runner behalten → verify kürzer
  5. Danach: CI auf `main` nach einem Merge auf eine Kurzprüfung reduzieren, wenn die PR-CI genau diesen Baum geprüft hat (sonst voll)
  Messen: Laufzeit Doku-PR und Feature-PR vorher/nachher in docs/LOG.md. Arbeitsweise: Doku-Nachträge in den nächsten fachlichen PR statt eigener PRs

### S1 Kursraum
- [x] **P3-01** (M) Kursraum `/kurse` + `/kurse/[id]`: „Meine Gruppen“ (Mitglied oder Leitung) und je Gruppe ein Hub mit den vorhandenen Bausteinen – nächste Stunden aus dem Stundenplan, offene Aufgaben, Termine, Gruppenordner, Gruppenchat, Mitglieder. Nur aus vorhandenen Services, keine neuen Tabellen; sichtbar für Mitglieder, Leitung und Verwaltung (Recht `kurse.view`). Abschnitte erscheinen nur, wenn das Modul an und das Gruppen-Feature aktiv ist
- [x] **P3-02** (S) Leitung schaltet die Bereiche ihres Kurses selbst an/aus (Gruppen-Features, bisher nur Verwaltung), Widget „Meine Kurse“ auf Heute, Suchanbieter, E2E „Lehrkraft öffnet Kurs, sieht Aufgabe + Chat“

### S2 Umfragen
- [x] **P3-03** (M) Modul `umfragen`: Umfrage mit Fragen (Einfach-/Mehrfachauswahl, Skala 1–5, Freitext), Zielgruppe wie bei News (Gruppen/Rollen, Eltern einer Klasse), Zeitraum, **anonym** oder namentlich; Tabellen `umfragen_*` mit `retention`. Anonym heißt technisch: Antworten ohne Benutzerbezug, getrennte Tabelle „hat teilgenommen“ (gegen doppelte Teilnahme), keine Zeitstempel feiner als der Tag
- [x] **P3-04** (M) Teilnehmen + Auswertung: Balken je Frage, Freitexte als Liste, CSV-Export; anonyme Umfragen zeigen Ergebnisse erst ab 5 Antworten (sonst „noch zu wenige Antworten“), Erinnerung per Gong an Nicht-Teilnehmende (nur namentlich bzw. über die Teilnahme-Tabelle)
- [x] **P3-05** (S) Schnellumfrage: eine Frage, Antwortknöpfe, Live-Ergebnis über den SSE-Kanal – im Kursraum und im Gruppenchat startbar, endet nach Zeit oder von Hand, immer anonym

### S3 Foren
- [x] **P3-06** (M) Modul `foren`: Forum je Gruppe (Gruppen-Feature `foren.forum`) plus ein Forum fürs Kollegium; Themen und Antworten (Markdown wie News), Abo/Gong bei neuen Antworten, Suchanbieter
- [x] **P3-07** (S) Moderation: Leitung/Verwaltung blendet Beiträge aus (mit Grund, Audit), sperrt Themen, Meldeknopf für alle; Löschfrist der Beiträge nach Löschklasse

### S4 Pinnwände
- [x] **P3-08** (M) Modul `pinnwaende`: Pinnwand je Gruppe (Gruppen-Feature) oder frei mit Mitgliedern; Spalten, Karten (Text, Link, Bild/Datei aus Dateien), Modus „nur Leitung“ / „alle posten“ / „moderiert (Freigabe)“; Live-Aktualisierung über SSE
- [x] **P3-09** (S) Karten verschieben/sortieren (auch per Tastatur), Pinnwand als Statusmonitor-Seite anzeigbar, Export als PDF/Druckansicht

### Abschluss
- [x] **P3-10** (S) Datenschutz + E2E Gate 3: `retention`, VVT und Auskunft für alle neuen Tabellen geprüft; Szenario: Lehrkraft startet im Kurs eine Schnellumfrage → Schüler:innen antworten → Ergebnis live; anonyme Umfrage zeigt unter 5 Antworten nichts; Forenbeitrag ausblenden; Pinnwand-Karte erscheint live
- [x] **GATE 3** – Review mit der Projektleitung (abgenommen 2026-10-10, PR #43) (Review-PR mit erledigten IDs, Tests, offenen Fragen)

## Release v0.2.0 (nach Gate 3, Projektleitung 2026-10-10) ← **HIER GEHT ES WEITER**
- [x] **P3-FIX** (M) Befunde aus dem Code-Review von Phase 3 (statt Ultra-Review, Projektleitung 2026-10-10): anonyme Ergebnisse in
  Fünferschritten (Spalte `umfragen_responses.seq`, Migration 0045), Schnellumfragen nicht bearbeitbar, Zielgruppen anonymer
  Umfragen nach der ersten Antwort fest, Bearbeiten/Antworten unter Zeilensperre, CSV gegen Formeln entschärft; Foren-Moderation
  liest überall, schreibt nur als Mitglied, gesperrte Themen auch beim Bearbeiten fest; Pinnwand-Verschieben zählt in der
  sichtbaren Liste; **Modulsperre** (`src/core/modules/guard.ts`: Aktionen, Seiten, Druck, API) – ausgeschaltete Module waren
  bisher per Direktaufruf erreichbar
- [x] **R-02-01** (S) Release-Notizen in Alltagssprache (Kursraum, Umfragen/Schnellumfrage, Foren, Pinnwände, Monitor-Pinnwand, CI-01 unsichtbar) mit Hinweis „neue Module kommen ausgeschaltet – unter Verwaltung → Rechte & Module einschalten“ (B-34); `release.json`-Mindestversion 0.1.0
- [x] **SEC-04** (M) Befunde des Security-Reviews Anmeldung/Rechte: Rechteausweitung gesperrt (Admin-Rolle und Admin-Konten nur
  durch Admins; Rollen/Konten/Gruppen nur mit eigenen Verwaltungsrechten; eigene Rolle/eigene Gruppenrechte nur durch andere;
  `src/modules/verwaltung/escalation.ts`), E-Mail-Anmeldung und Self-Service-Endpunkte (`/update-user`, `/two-factor/disable` …) über
  HTTP aus (`@schulos/server/auth-paths`, beide Apps), `safeNext` streng (`@schulos/server/safe-next`, beide Apps), Live-Strom endet
  bei Sperre/Reset/Abmeldung, IP-Sperre nur für unbekannte Namen und Konten mit Fehlversuchen (kein Aussperren hinter NAT)
- [x] **SEC-05** (M) Befunde des Security-Reviews Dateien/Inhalte: Auskunft ohne Daten Dritter (Zeilen, in denen die Person nur
  handelt – `*_by`, `actor_id` – nur als Handlung ohne Inhalte, Dateien nur eigene; `auskunft.ts`), Exporte (Eigenexport, Auskunft,
  Klassenbuch-Archiv) nur per POST, je Konto einer, global 2, Eigenexport 10 s Abstand, höchstens 500 MB, Deflate im Thread-Pool
  (`src/core/export-limit.ts`); Aufräumlauf kennt alle Datei-Spalten (`STORAGE_KEY_COLUMNS`, Elternbrief-Anhänge wurden nachts
  gelöscht); Dateien-API mit Modulsperre (Download für Pinnwand-Dateikarten bleibt); Kontingent unter Sperre; Monitor-Pinnwand nur
  „Nur Leitung“/„moderiert“; `proxyClientMaxBodySize` 30 MB, Upload je Datei eine Anfrage
- [x] **SEC-06** (M) Befunde des Security-Reviews Betrieb (Backup, Updates, Installer, Release): Wiederherstellung auf dem
  Hauptsystem verankert – die App schreibt bei der Code-Eingabe eine Freigabe (`restore-approval.json`, Auftrag/Stand/Umfang, 30 min,
  einmal), der Agent führt „bestätigt“ nur damit aus; Aufträge nur mit voller Snapshot-ID (64 Hex) und bekanntem Umfang, restic-IDs
  und -Pfade nach `--` (vorher `--password-command=…` als ID möglich); vor jedem `pg_restore` Prüfung des Inhaltsverzeichnisses
  (`@schulos/server/dump-toc`: nur Arten des Schemas, Wächter-Test über `drizzle/`); Test-Restore (`schulosctl test-restore`,
  `os-upgrade`) und monatlicher Test-Restore des Backupservers mit Wegwerf-Rolle ohne Superuser-Recht statt als Superuser;
  Offline-Bundle: `images.tar` vor `docker load` geprüft (nur signierte Digests, keine fremden Namen); Release: cosign-Schlüssel nur in
  den beiden Signierschritten, tsx aus dem Lockfile statt `npx -y tsx@4`, `npm ci --ignore-scripts` in Release und CI; Kopplung:
  Wiederholungsfenster endet mit der ersten Meldung des Agenten. Offen als SEC-07…SEC-10 (brauchen Hardware/ISO/QEMU bzw. Migration)
- [x] **SEC-07** (M) App-Datenbankrolle ohne Superuser – **entschieden (Projektleitung 2026-10-11): ja, vor dem nächsten Release** (SEC-06 Befund 3): `POSTGRES_USER` wird zur Wartungsrolle (`postgres`,
  eigenes Passwort), ein Init-Skript legt `schulos` als `NOSUPERUSER NOCREATEROLE` Eigentümerin der DB an und richtet
  `pg_stat_statements` (Erweiterung braucht Superuser) als Wartungsrolle ein; App/Agent/`schulosctl psql` (`-U`), Healthcheck,
  `lasttest.sh`, Installer/ISO (`.env`) nachziehen. Bestehende Installationen: einmalige Migration in `schulosctl update`
  (Wartungsrolle anlegen, `ALTER ROLE schulos NOSUPERUSER`, Eigentümer prüfen) mit Rückweg. Danach spielt auch die bestätigte
  Wiederherstellung nicht mehr als Superuser ein. Test: Stack-Test, Update-Test N−1 → N, QEMU (frische ISO + Update einer 0.2.0)
- [x] **SEC-08** (S) **→ Block 4e (Q-R5-3, Projektleitung 2026-10-13)** Digest-Referenzen – **entschieden (Projektleitung 2026-10-11): ja**, statt Tags nach der ISO-Installation (SEC-06 Befund 4, Rest): `isoImages`
  (`packages/server/src/release.ts`) und `iso/build-docker.sh` schreiben `name@sha256:…` in `images.env`/`.env`, dann sind Tags
  (Rückweg nach Update, `demo-reset`, `compose up` von Hand) nirgends sicherheitsrelevant. Test: ISO-Build + QEMU (offline, ohne
  Registry), Update-Test – umgesetzt: `archiveDigest`/`pinImagesEnv` (`release.ts`), `iso/build-docker.sh` sammelt je Archiv den Digest der `index.json` und stellt `images.env` per `release-manifest.ts --pin-images` auf `name:tag@sha256:…` um (Release- und Neubau-Weg, `SCHULOS_REST_IMAGE` neu), `compose.backup.yaml` nimmt alle Images aus Variablen; QEMU-Schritt 2 prüft beide `.env` (nur CI); SICHERHEIT S66
- [x] **SEC-09** (M) **→ Block 4e (Q-R5-3, Projektleitung 2026-10-13; bestehende Server: geführter Nachrüst-Schritt in `schulosctl` – GRUB-Passwort setzen, TPM2 neu binden)** TPM2/GRUB gegen physischen Zugriff – **entschieden (Projektleitung 2026-10-11): wie vorgeschlagen** (GRUB-Superuser mit Wartungspasswort, PCR 7+8+9 bzw. TPM2+PIN als Installer-Wahl, TPM2 nur mit Secure Boot) (SEC-06 Befund 5): GRUB-Superuser mit Passwort (`password_pbkdf2`,
  Standardeintrag `--unrestricted`), TPM2 zusätzlich an PCR 8/9 (oder UKI + PCR 11 / `systemd-pcrlock`) bzw. `--tpm2-with-pin`,
  TPM2 nur bei aktivem Secure Boot anbieten (`mokutil --sb-state`); Kernel-Update darf die Entsperrung nicht brechen (Neu-Binden
  im Update-Pfad). Test: QEMU mit swtpm + OVMF Secure Boot (iso.yml), `installer-system-test.sh` – umgesetzt: `@schulos/server/boot-hardening` (GRUB-PBKDF2, `01_schulos-passwort`, Standardeintrag `09_schulos-standard` `--unrestricted`, `tpm-binden.sh` start/pruefen, Dienst `schulos-tpm`, dpkg-Hook); Installer: TPM2/TPM2+PIN nur mit Secure Boot, PCR 7 im Live-System + Bindung an 7+8+9 beim ersten Start; `schulosctl sicherheit-nachruesten`; QEMU mit OVMF Secure Boot + Schritt 2b (nur CI); INSTALLATION §2.3, SICHERHEIT S67, Q-4E-52
- [ ] **SEC-10** (M) **vorbereitet mit REPO-02 (4e-R4) – wirksam mit `SCHULOS_RUNNER=oeffentlich` nach dem Umschalten (Zustimmung Projektleitung)**: `release.yml` und das Signieren der ISO-Prüfsumme (`iso.yml` Job `release-anhang`) laufen dann auf frischen GitHub-Runnern, die Dependabot-/PR-CI ebenfalls auf GitHub – der Schlüssel kommt nicht mehr auf die Build-VM; Kopfkommentar in `ci.yml` korrigiert; keyless/KMS bleibt offen. Ursprünglich: Release-Job getrennt von CI – **entschieden (Projektleitung 2026-10-11): Release auf GitHub-hosted Runner**, CI bleibt auf der Build-VM (SEC-06 Befund 6, Rest): Release auf einem frischen Runner (GitHub-hosted;
  ephemerer Self-hosted-Runner `--ephemeral` entfällt), CI der Dependabot-PRs nicht auf dem Release-Runner; mittelfristig Schlüssel im
  KMS/HSM oder keyless mit festgelegter Identität. Nebenbei: Kopfkommentar in `ci.yml` („Dependabot-PRs immer auf GitHub-Runnern“)
  stimmt seit 2026-10-08 nicht mehr
- [x] **INST-01** (M) Abschluss der Installation (Befund Projektleitung, Hyper-V Gen2 mit vTPM): Wiederherstellungsschlüssel ohne
  Zeitlimit in 8 Blöcken + QR-Code (`qrencode`), weiter erst nach Eintippen von Block 8; kein „Startmedium entfernen“ mehr,
  solange das Live-System davon läuft – UEFI-Eintrag „SchulOS“ je Platte vorn in BootOrder (`efibootmgr`), sonst Hinweis +
  Ausschalten; Rückweg `schulosctl wiederherstellungsschluessel` (neuer Schlüssel per TPM2, alter danach gelöscht);
  INSTALLATION.md §2.1 mit Hyper-V-Hinweis
- [x] **INST-02** (M) Installer-Oberfläche aufpolieren (Projektleitung: „grafisch cooler“, Textmodus bleibt): Rahmen mit Logo und Version,
  Schrittleiste der Abschnitte (✔/▶/·), Tasten in der Fußzeile, lange Listen als Ausschnitt; Zusammenfassung als Tabelle nach
  Abschnitten; Installation mit Fortschrittsbalken (Schritt x/y, Titel, Zeit, letzte Protokollzeilen) und klarem Abbruch-
  Bildschirm (Protokoll, Alt+F2); Abschluss (INST-01) mit Titelleiste/Rahmen, Logik unverändert. Farben nach theme.css,
  Linux-Konsole (`TERM=linux`) mit 8 Farben und CP437-tauglichen Zeichen, ohne UTF-8 nur ASCII. Befund: die Schriften von
  console-setup haben keine Halbblöcke ▀▄ (QR-Code aus INST-01 unleserlich) → Live-System bekommt beim Bau eine
  Terminus-Bold-Schrift mit ▀▄▌▐▓ (`--konsolenschrift`), der Installer lädt die passende Größe (≥ 100×30, sonst 80×25)
- [x] **INST-03** (S) Konsole im installierten System (Befund Projektleitung, Hyper-V mit Release-ISO 0.3.0): Zeichensalat auf tty1 (`Â·`, `lÃ€uft`, QR
  unleserlich) – `/etc/default/console-setup` fehlte (ISO-8859-15) und die Halbblock-Schrift war nur im Live-System; jetzt UTF-8-Datei,
  SchulOS-Schrift ins Zielsystem kopiert, `konsole.sh` lädt Schrift + UTF-8-Modus (ohne Schrift: kein QR statt Salat), ebenso
  `schulosctl wiederherstellungsschluessel`. Anmelden einfacher: Enter auf tty1 startet agetty (Alt+F2 geht in Hyper-V nicht),
  `getty@tty2` ausdrücklich aktiviert; INSTALLATION.md
- [x] **R-02-02** (S) Tag `v0.2.0` → `release.yml` (Update-Test v0.1.0 → v0.2.0 inkl. Probelauf und Rückweg – erster Minor von einem echten Release; `scripts/update-test.sh` nimmt den neuesten Release-Tag als N−1, geprüft), Signaturen, SBOMs
- [x] **R-02-03** (S) Release-ISO + qcow2 (`iso.yml -f release=v0.2.0 -f qemu=beide`), Lasttest-Regressionswächter (2 Kerne/300 Nutzer) gegen das 0.2.0-Abbild – Vergleich mit v0.1.0 in LASTTEST.md (Phase 3 hat Heute um das Widget „Meine Kurse“ erweitert)
- [x] **R-02-04** (S) Doku: PLAN §0 (Stand, Release), §4 (Infobildschirm erledigt, Phase 4 zerlegt), §7 abgleichen; QUESTIONS „Offen“ aufräumen (DOC-01); DATENSCHUTZ §6 TOM-Tabelle nachziehen (Abhängigkeiten/Speicherung/Updates = erledigt)
- [x] **DOC-01** (S) PLAN §7 auf QUESTIONS abgleichen (drei Kästchen längst entschieden), DATENSCHUTZ §6 TOM-Stände, PLAN §4 „Infobildschirm“ → erledigt (P2b-07), Phase-4-Liste ersetzen durch die Blöcke dieses Fahrplans
- [x] **DS-11** (S) Fragenliste an die DSB als `docs/DSB-FRAGEN.md`: B-05 (Art. 9 Krankmeldungen), VO-DV-I-Anlagen im Wortlaut, Anmeldung (Empfehlung, Anschrift, Fristen für abgelehnte Anträge, Elterndaten vor Aufnahme), Hausmeister-Konten (Beschäftigte des Schulträgers), Web-Push (Drittanbieter), Barrierefreiheitserklärung – vor einem Pilot abarbeiten

## Phase 4 – Erweiterungen (zerlegt von Fable, entschieden von der Projektleitung 2026-10-10 – Details in `docs/PHASE4.md`)

Reihenfolge: 4a → 4b (gemeinsames Gate) → 4c → Release v0.3.0 → **4f Feinschliff** (Projektleitung 2026-10-10, `docs/FEINSCHLIFF.md`) → 3b → 4d → Release v0.4.0 → 4e → Release v0.5.0.
Umsetzung mit Opus; P3-11 nur mit Fable nach Freigabe durch die Projektleitung.

### 4a Erscheinungsbild (Schullogo)
- [x] **P4-01** (S) Bild-Baustein `src/core/images.ts`: `sniffImage()` aus `profilbild.ts` hierher ziehen und um WebP erweitern; Maße lesen (PNG/JPEG/WebP/SVG); Tests mit Fixtures. `profilbild.ts` nutzt den Baustein (keine Verhaltensänderung)
- [x] **P4-02** (M) SVG-Annahmefilter `src/core/images-svg.ts` (Negativ-Liste oben, Positivtests mit 5 echten Logo-SVGs, Größen-/Tiefenlimit, Entities verboten) + Auslieferungsroute `GET /api/schule/logo` mit Sandbox-CSP/nosniff/Cache (öffentlich, `PUBLIC` im Proxy) – `/security-review` nach dem PR
- [x] **P4-03** (M) Verwaltung → Schule: Abschnitt „Erscheinungsbild“ (Logo, Variante dunkel, Symbol; hochladen/ersetzen/entfernen; Vorschau hell/dunkel; Fehlertexte in Alltagssprache), Server Actions mit `requirePermission("verwaltung.school")`, Audit `verwaltung.school.logo`, Speicherung in `app_settings` + Dateispeicher; alte Datei beim Ersetzen löschen
- [x] **P4-04** (S) Logo in Login, Shell (Topbar/Sidebar-Kopf) und als Favicon (`metadata.icons` dynamisch, PNG-Fallback), Dark-Mode-Verhalten (Platte bzw. Variante); `getSchoolSettings()` liefert `logo` mit (Request-Cache B-56 beachten)
- [x] **P4-05** (S) Gemeinsamer Druckkopf (Logo + Schulname + Datum) für alle `/druck/*`-Seiten und den Monitor; Demo-Seed mit Lindenhof-SVG
- [x] **P4-06** (S) E2E „Erscheinungsbild“: SVG mit Skript wird abgelehnt (Meldung), PNG wird angenommen, erscheint auf Login/Shell/Druck/Monitor, Entfernen → Fallback; Header-Test der Logo-Route (`sandbox`, `nosniff`)

### 4b Gebäude & Technik (Hausmeister, Mängel, Prüffristen, Wartung)
- [x] **P4-10** (M) Rolle `personal`: Enum + Migration, `requiresTwoFactor()` (Pflicht wie alle Erwachsenen, Q-70), Adressbuch-Sichtbarkeit (sieht Personal, kein Schüler-/Elternverzeichnis), Benutzerverwaltung/Import (Rolle wählbar), Seed (Hausmeister „Klaus Berger“, Gruppe „Hausmeisterei“), Rechte-Matrix zeigt die Rolle; Tests: Rechte-Engine, Adressbuch, E2E Login als Hausmeister sieht keine Schülerdaten
- [x] **P4-11** (M) Modul `gebaeude` Grundgerüst: Manifest (Rechte, `retention`, `processing`), Schema `gebaeude_tickets/_events/_photos/_responsibilities`, Migration, Service (anlegen, Status-Maschine mit erlaubten Übergängen, Sichtbarkeit Melder/Manage, Zuständigkeitsgruppe je Kategorie, laufende Nummer), Tests
- [x] **P4-12** (M) Melden + Ticketseite: `/gebaeude/melden` (Raum-Auswahl aus `rooms`, Vorbelegung per `?raum=`), Foto-Upload (Bild-Baustein 4a, EXIF-Strip, Grenzen), `/gebaeude/[id]` mit Verlauf/Kommentaren, Gong an Zuständige bzw. Melder:in, Alarm-Mail bei `gefahr`
- [x] **P4-13** (M) Board `/gebaeude` (Spalten nach Status, Filter, Zuweisung, Prioritätsmarker), Widgets (Melder: „Meine Meldungen“; Manage: „Offen“, „Überfällig“), Suchanbieter, Links „Mangel melden“ aus Raumbelegung (`/stundenplan/raeume`) und Kursraum
- [x] **P4-14** (M) Raumsperre aus dem Ticket (Zeitraum, Stunden) über `raumsperren.ts`, Rückverweis, Sperre beenden bei „erledigt“; Ticket-Hinweis auf bestehende Buchungen des Raums (prüfen, ob `buchungen` Sperren kennt – sonst Hinweis statt Blockade); E2E „Beamer defekt → Raum gesperrt → Vertretungsbedarf sichtbar“
- [x] **P4-15** (M) Anlagen/Geräte + Prüfarten: Schema `gebaeude_assets/_inspection_types/_inspections`, Vorlagenkatalog (Tabelle oben, Quellen als „zu prüfen“ im Text), Verwaltung `/verwaltung/gebaeude` (Prüfarten aktivieren/anpassen, Zuständigkeiten), Anlagenliste `/gebaeude/anlagen` mit CSV-Import (Name;Art;Raum;Inventarnummer)
- [x] **P4-16** (M) Prüfungen erfassen + Fälligkeiten: `due_on`-Berechnung, `/gebaeude/pruefungen` (fällig/überfällig/erledigt, Filter), Erfassen mit Ergebnis/Firma/Protokoll-PDF, „Mangel“ → Ticket; Job `gebaeude-fristen` (Gong wöchentlich bei ≤ warn_days, täglich + Alarm-Mail bei überfällig), Tests der Fristenlogik inkl. Schaltjahr/Monatsende
- [x] **P4-17** (S) Wartungstermine: Schema, Seite `/gebaeude/wartung`, optional Raumsperre + Schulkalender-Termin, Gong an Lehrkräfte der betroffenen Räume (über Stundenplan-Service „wer unterrichtet in Raum X im Zeitraum“)
- [x] **P4-18** (S) Druck `/druck/pruefliste` (je Gebäude/Prüfart, Nachweis für den Schulträger), CSV-Export Tickets/Prüfungen (ohne Personennamen), kleine Statistik je Kategorie/Monat
- [x] **P4-19** (S) Datenschutz + E2E Gate 4b: `retention`/VVT/Auskunft (Melder-Tickets im Export), SICHERHEIT.md-Annahme „Melder sieht nur eigene Tickets, Hausmeister keine Schülerdaten“ mit Test; Szenario: Lehrkraft meldet mit Foto → Hausmeister (Gong) nimmt an → sperrt Raum → erledigt → Lehrkraft Gong; Prüfung in 14 Tagen fällig → Erinnerung; Prüfung mit Mangel → Ticket
- [x] **Q5-01** (S) Nachtrag 4b (F-01): Telefonische Krankmeldung durch das Sekretariat – `abwesenheiten.manage` als Vorgabe für `verwaltung`, Pfad „im Namen der Eltern (Telefon)“ mit Status `gemeldet` statt sofort `entschuldigt`, Gong an Klassenleitung, Kind per Name/Klasse suchen; Test: Sekretariat meldet → KL entscheidet → Klassenbuch (I-32)
- [x] **Q5-08** (S) Nachtrag 4b (F-01): Hausmeisterei sieht Raumbelegung – `/stundenplan/raeume` für `gebaeude.manage` statt Rollenliste (Belegung mit Gruppe + Kürzel, keine Mitgliederlisten), SICHERHEIT-Test; Buchungen lesen und Widget „Heute im Haus“ bleiben offen (→ 4f, Q5-08b) (I-49, I-50; ergänzt P4-75)
- [x] **Q5-14a** (S) Messenger-`processing.note` auf den Ist-Stand korrigiert (kein Schalter für Direktchats vorhanden; VVT/Datenschutzhinweise), F-09
- [ ] **GATE 4a+4b** – Review-PR für beide Blöcke (Q-02)

### 4c Schulanmeldung (öffentlich, ohne Konto)
- [x] **P4-30** (M) Transaktionsmails: `src/core/mail.ts` (Outbox-Tabelle, Versand-Job, Vorlagen, Text-only), Core-`retention`, `/dev/mail` (Dev/E2E), Testmail-Knopf nutzt denselben Weg; Tests Outbox/Wiederholung
- [x] **Q5-04** (S–M) Echte E-Mail-Adressen (Projektleitung 2026-10-10, F-01): Feld in Benutzer anlegen/bearbeiten und im Import (optional, bei Schüler:innen per Vorgabe leer), Selbstbedienung „E-Mail ändern“ mit Bestätigungslink über P4-30 (Better-Auth-Self-Service bleibt aus, SEC-04); `email_verified` wird damit erstmals wahr – **direkt nach P4-30, vor P4-39/P4-70** (I-14)
- [x] **P4-31** (S) Core-Rate-Limit `src/core/rate-limit.ts` + Tabelle `rate_limits` (IP gehasht, Fenster, Sperre), Regeln aus `@schulos/server/throttle`, `clientIp()` wiederverwenden; Tests
- [x] **P4-32** (M) Modul `anmeldung`: Manifest (Rechte, `retention` mit `retention_from`, `processing` mit NRW-Rechtsgrundlage), Schema `anmeldung_verfahren/_slots/_antraege/_ereignisse`, Migration, Service: Verfahren, Slot-Generator, Statusmaschine (erlaubte Übergänge, `retention_from`), Kapazitäten; Tests
- [x] **P4-33** (M) Verwaltung: `/verwaltung/anmeldung` (Liste, neu, bearbeiten, Slots, Vorschau, veröffentlichen/schließen), Modul-Einschalten nur mit SMTP (Hinweis), Impressum-/Kontakt-Freitext in Verwaltung → Schule + öffentliche Seite `/impressum`
- [x] **P4-34** (L, 2 Commits) Öffentliches Formular: `publicAction()`-Wrapper, `/anmeldung`, `/anmeldung/[verfahren]` (mehrschrittig, Validierung, Slot-Wahl live, Honeypot/Zeitstempel, Rate-Limits, Datenschutzhinweis Art. 13), Double-Opt-In (`/anmeldung/bestaetigen/[token]`), Bestätigungsmail mit Vorgangsnummer + ICS; Proxy `PUBLIC` erweitern; Tests: Token-Hashing, Ablauf, konstante Antworten
- [x] **P4-34b** (M) Anmeldung für Familien mit Konto (Q-32): eingeloggte Eltern melden ein weiteres Kind im geschützten Bereich
  an (Antrag hängt am Elternkonto, keine Mailbestätigung nötig, Daten aus dem Konto vorbelegt) – setzt P4-34 voraus
- [x] **P4-35** (M) Vorgangsseite für Eltern `/anmeldung/vorgang/[token]`: Stand, Termin ändern (freie Slots), zurückziehen, Unterlagenliste; Mails bei Terminänderung; Job: unbestätigte Anträge nach 48 h löschen (eigener Job, nicht erst Löschlauf)
- [x] **P4-36** (M) Sekretariat: `/verwaltung/anmeldung/[id]` Antragsliste (Filter/Suche/Sortierung `de()`), Antrag (Lesezugriff `auditRead`), Checkliste „vorgelegt“, Notizen, Termin verschieben, Druck Anmeldebogen + Tagesliste; Widget „Neue Anmeldungen“ auf Heute; Gong gesammelt
- [x] **P4-37** (M) Entscheidung + Export: `anmeldung.decide` (einzeln/Liste, Kapazität, Hinweise Geschwister/Schulweg nur informativ), Verfahren abschließen, CSV-Export „Schulverwaltungssoftware“ (Spaltenwahl, Kodierung) und Serienbrief-CSV, beides protokolliert; keine Automatik
- [x] **P4-38** (M) Elternkonten in der Benutzerverwaltung: Elternteil anlegen/verknüpfen (`parent_child`), E-Mail als Kontakt, Startpasswort wie Import – Grundlage für die Übernahme (Mechanik heute prüfen; entfällt, wenn schon vorhanden)
- [x] **P4-39** (L, 2 Commits) Übernahme im Schuljahreswechsel: Schritt „Neuaufnahmen“ (Klassen des Zieljahrgangs anlegen, Kinder zuordnen, Konten Kind + Elternteil 1 erzeugen, Zugangsdaten-CSV/Druck, Antrag → `uebernommen`), Abhängigkeit zum Schritt „Versetzung“ (Zieljahrgang existiert im neuen Schuljahr); Tests mit Demo-Verfahren
- [x] **P4-40** (M) Außenzugang: `SCHULOS_PUBLIC_ACCESS` in Installer (`questions.ts`, Warnung bei `proxy` ohne `trusted_proxies`), `.env`, Caddy-Konfiguration (Allowlist/`remote_ip`), App-Guard in `src/proxy.ts` für `X-SchulOS-Extern`; Stack-Test prüft: von „außen“ (simuliert per Header/zweitem Netz) nur öffentliche Pfade; INSTALLATION.md Abschnitt „Außenzugang“ (Checkliste Schulträger) – `/security-review`
- [x] **P4-40b** (M) Gerätezertifikate für den Personal-Außenzugang (Projektleitung 2026-10-10, Härtung gegen Ransomware, Q: Außenzugang) – **nach P4-40**: eigene kleine CA (`step-ca` als Compose-Profil, ACME-Device-Attest bzw. SCEP), Export für MDM (Apple `.mobileconfig`, Hinweise für Intune/Relution), Sperrliste + Übersicht ausgestellter Zertifikate in Verwaltung → System; Caddy `client_auth` Modus `verify_if_given` mit der Schul-CA, Weitergabe des verifizierten Zertifikats an die App per vertrauenswürdigem Header (nur von Caddy gesetzt; in `src/proxy.ts` gleichnamige Header von außen verwerfen); App-Guard je Rolle bei externem Zugriff: Personal/Lehrkräfte nur mit gültigem Gerätezertifikat (Schuleinstellung, Vorgabe „an“ sobald die CA eingerichtet ist), Eltern Passkey/2FA (SEC-01/SEC-03), öffentliche Seiten ohne; Rollen Verwaltung/Admin von außen grundsätzlich gesperrt (Vorgabe, änderbar); Stack-Test mit Test-CA (gültig/abgelaufen/gesperrt/fremde CA/gefälschter Header); INSTALLATION.md „Außenzugang“ um Abschnitt Gerätezertifikate/MDM ergänzen; SICHERHEIT S27/S28 – `/security-review`
  – umgesetzt mit Ausstellung durch den Admin (Schlüssel + CSR in SchulOS, Signatur über den JWK-Provisioner von step-ca, Export .p12/.mobileconfig), Freigabe-/Sperrliste in der App; SICHERHEIT S27/S28, INSTALLATION §5c
- [ ] **P4-40c** (M) Gerätezertifikate Folgeaufgaben (aus P4-40b, braucht echte Geräte/MDM – Fragen in docs/QUESTIONS.md): Ausstellung durch das MDM selbst – **entschieden (Projektleitung 2026-10-11): erstmal kein bestimmtes MDM, aber gängige Schulträger-Lösungen vorbereiten**: Anbindung generisch halten (step-ca SCEP als Standard, ACME Device Attestation, CSR-Upload, Export `.p12`/`.mobileconfig`/PEM), Anleitungen/Profilvorlagen für Intune (SCEP bzw. PKCS über Intune Certificate Connector, SCEP gegen step-ca), Relution, Jamf School/Mosyle und Apple School Manager; step-ca dafür von außen bzw. für das MDM erreichbar machen (nur optional, Vorgabe bleibt intern); CSR-Upload für Geräte mit eigenem Schlüssel, Sperre zusätzlich in step-ca (passive Revocation), Volume `step_ca` ins Backup-Snapshot aufnehmen (**Projektleitung 2026-10-11: ja**; Schlüssel mit `SCHULOS_DEVICE_CA_PASSWORD` verschlüsselt, Passwort nur in `.env`/Notfallordner), Installer-Frage „Gerätezertifikate“ (Passwörter erzeugen, Profil starten), Erinnerung vor Ablauf (Gong/Mail an `verwaltung.system`), step-ca-Image auf der ISO
- [x] **P4-41** (S) Demo-Seed: offenes Verfahren „Klasse 5 – 2027/28“ mit Slots und ~30 Anträgen in allen Status (fiktiv), Vorschau-Instanz zeigt es
- [x] **P4-42** (S) Datenschutz + SICHERHEIT.md: `retention`/VVT/Datenschutzhinweis öffentlich, Auskunft (Anträge sind nicht an Konten gebunden → Auskunft per Vorgangsnummer/E-Mail durch das Sekretariat: Export eines Antrags als JSON), Annahmen S15–S18 (öffentliche Pfade, Token, Rate-Limit, Außenzugang) mit Tests; DS-11-Fragen ergänzen (Empfehlung, Anschrift, Fristen)
- [x] **P4-43** (S) E2E Gate 4c: Sekretariat legt Verfahren an → ohne Login Antrag → Link aus `/dev/mail` → bestätigt mit Termin → Sekretariat hakt Unterlagen ab → Schulleitung nimmt auf → Schuljahreswechsel „Neuaufnahmen“ → neue Schülerin meldet sich mit Startpasswort an; abgelehnter Antrag erscheint in der Löschvorschau; 11. Einreichung von einer IP in einer Stunde → Hinweis „zu viele Anfragen“; SVG/HTML im Freitext bleibt Text
- [x] **GATE 4c** (#59, 2026-10-11: Code- + Security-Review per Opus statt Ultra, autonom gemerged) – Review-PR; Projektleitung startet `/code-review ultra` (Schwerpunkt: öffentliche Endpunkte, Token, Außenzugang, Löschfristen); danach **Release v0.3.0**

### 4d Eltern & Wahlen
- [x] **Q5-05** (S) **vor P4-50/P4-52/P4-62** (F-01): Kennzeichen „eigenständig (volljährig)“ am Konto (`users.self_responsible`, in der Benutzerverwaltung, Import-Spalte optional) – Elternbriefe/Umfragen gehen an die Person selbst, Abwesenheiten meldet sie selbst, Elternsicht erlischt (Option „Eltern weiter informieren“ nur mit Einwilligung der Person); Tests Sichtbarkeit; § 123 SchulG NRW zu prüfen (DSB-FRAGEN §10) (I-05)
- [x] **P4-50** (M) Modul `sprechtag`: Schema (`sprechtag_events/_availability/_appointments`), Service (Slots, Kollisionen, Sichtbarkeit), Manifest
- [x] **P4-51** (M) Verwaltung + Lehrkraft-Seite (`/sprechtag`, Verfügbarkeit, Gesprächswunsch)
- [x] **P4-52** (M) Eltern-Buchung (`/sprechtag/buchen`, je Kind, Vorschlag hintereinander, Absage), Gong/Mail, Erinnerung (Job)
- [x] **P4-53** (S) Druck/Monitor-Profil, Widget „Mein Sprechtag“, Suchanbieter
- [x] **P4-54** (S) Datenschutz + E2E: Eltern buchen zwei Termine hintereinander, Lehrkraft sieht Plan, Absage → Gong
- [x] **P4-60** (M) Modul `kurswahl`: Schema (`kurswahl_verfahren/_angebote/_wahlen`), Service, Manifest
- [x] **P4-61** (M) Verwaltung: Verfahren/Angebote, Zielgruppe (Jahrgang/Klassen), Zeitraum, Vorschau
- [x] **P4-62** (M) Wählen (`/kurswahl`): Schüler:in/Eltern, Prioritäten, Bestätigung, Druck Wahlbogen, Erinnerung an Nichtwähler (Gong)
- [x] **P4-63** (M) Zuteilung (rein, getestet, erklärbar) + Korrektur-UI, Statistik (Nachfrage je Angebot)
- [x] **P4-64** (M) Übernahme in Gruppen + Lehraufträge-Vorschlag; Konflikt mit bestehenden Gruppen prüfen
- [x] **P4-65** (S) Datenschutz + E2E Gate 4d: WP-I-Wahl 7. Jahrgang → Zuteilung → Gruppen entstehen → Kursraum zeigt sie
- [x] **P4-78** (S) Sammel-Ablehnung „Spam“ in der Antragsliste der Schulanmeldung (GATE-4c Security M1, Projektleitung 2026-10-11): mehrere Anträge ankreuzen und mit einem Schritt ablehnen (Grund „Spam“, keine Mail an die Adresse, Audit); keine Domain-Obergrenze, kein Captcha (erst bei echtem Missbrauch); Test
- [x] **P4-78b** (S) Spam-Ablehnung zweistufig (Q-4D-6, Projektleitung 2026-10-13): Sekretariat (eigenes Recht `anmeldung.spam`, Vorgabe Rolle Verwaltung) markiert offene Anträge als „Spam-Verdacht“ (Stand bleibt, keine Mail, Verlauf + Audit ohne Namen), nimmt die Markierung bei Irrtum zurück; Schulleitung (`anmeldung.decide`) sieht einen Hinweis, wählt alle Markierten und bestätigt gesammelt → abgelehnt wie P4-78; Filter „Spam-Verdacht“; Migration 0070; Tests + E2E
- [x] **P5-01** (M) Sitzplan (mit 4d, F5-02 – Details `docs/PHASE5-NOTENBUCH.md` §4): Modul `sitzplan` Grundgerüst – Manifest, Schema `sitzplan_plans/_seats`, Migration 0071, Service mit Sichtbarkeit (nur Lehrkräfte der Gruppe + Klassenleitung), Tests
- [x] **P5-02…P5-04** (M/S/S) Sitzplan-Editor (Raster, Tische, Drag & Drop + Tastaturweg, Profilbild nur mit Einwilligung, alphabetisch/zufällig, Kopie, Druck ohne Fotos), Einbindung (Klassenbuch-Eintrag mit Fehlzeit per Klick, Kursraum, Tagesleiste, Suche), Datenschutz + E2E + SICHERHEIT S42
- [x] **GATE 4d** (#92, 2026-10-13; Reviews G4D-C01…C12/S01…S04 behoben) → **Release v0.4.0** (2026-10-13)

### 5a Notenbuch (vor 4e, Teil von v0.5.0 – Details docs/PHASE5-NOTENBUCH.md)
Was 5a aus 4e braucht, baut 5a modulbezogen selbst (Projektleitung 2026-10-12, §0): 2FA-Pflicht nur fürs Notenbuch, kurzer
Inaktivitätsablauf für Notenbuch-Seiten, `no-store`, PWA-Ausschluss – 4e verallgemeinert das später. Modell: Opus; Fable für P5-20
(und ggf. P5-11).
- [x] **P5-00** (S) Datenschutz-Vorlauf: DSB-FRAGEN §15 Notenbuch / §16 Sitzplan, DSB-Checkliste, DATENSCHUTZ §3.4/§5, Fahrplan (dieser Abschnitt)
- [x] **P5-10** (M) `notenbuch` Grundgerüst (Manifest, Schema `notenbuch_books/_book_teachers/_columns/_entries/_term_grades`, Migration) + reine Rechenlogik `berechnung.ts` (Gewichtung, Notenschlüssel, Rundung, Tendenz, 15 Punkte), Tabellentests
- [x] **P5-11** (M) Rechte/Sichtbarkeit im Service, `auditRead`, `transfer`, **2FA-Pflicht fürs Modul**, kein Admin-Override; SICHERHEIT
- [x] **P5-12** (M) Notentabelle: Tastatureingabe, Spalten (auch aus Klausurplan), Kommentar mit Hinweis, Live-Berechnung, Fehlstunden-Zähler aus eigenen Stunden (ohne Grund), Notenspiegel ohne Namen; `no-store`, kein SW-Cache, kurzer Inaktivitätsablauf
- [x] **P5-13** (M) Halbjahresabschluss: Vorschlag → Festlegen → Sperren; Übergabeliste je Klasse (Lesen protokolliert, „Entwurf – amtlich ist die Schulverwaltungssoftware“); CSV-Export (POST, Audit) – kein Zeugnisdruck
- [x] **P5-14** (S) Schüler-/Elternsicht als Einstellung (Vorgabe aus)
- [x] **P5-15** (S) Lebenszyklus: Schuljahreswechsel, Abgang einer Lehrkraft, Löschlauf, Auskunft
- [x] **P5-16** (S) Widgets/Verknüpfungen (nur für die Person selbst, keine Lehrkräfte-Statistik)
- [x] **P5-17** (S) Datenschutz-Doku, Nutzungsordnungs-Baustein, Hinweis beim ersten Öffnen
- [x] **P5-18** (M) E2E Gate 5a (`e2e/zx-gate5a.spec.ts`; `/security-review` am GATE 5a durch die Projektleitung)
- [x] **P5-20** (L) Offline-Eingabe auf Dienstgeräten (verschlüsselter IndexedDB-Cache, Sync mit Versionsvektor je Zelle, Konflikte) – in V1 (F5-15), Fable (F5-16)
- [ ] **GATE 5a** – Review-PR (`/code-review ultra` + `/security-review`); danach weiter mit 4e, Release v0.5.0 nach 4e

### 4e Betriebsreife, Sicherheit & Barrierefreiheit
- [x] **SEC-01** (M) 2FA-Pflicht für alle (Q-70) – umgesetzt 4e-R1 (Stichtag Migration 0078 heute + 28 Tage, Verwaltung → System → Anmeldung, Ersteinrichtung nur im Schulnetz/mit Freigabe + Hinweis-Mail, Q-5A-30; Fragen Q-4E-1…3): Lehrkräfte, Personal, Eltern, Verwaltung, Admin immer; Schüler:innen nur bei
  Anmeldung von außerhalb des Schulnetzes. Schulnetz-Bereiche (CIDR) in Verwaltung → System + Installer-Vorgabe, Client-IP
  hinter Caddy nur über vertrauenswürdige Proxys; Stichtag je Schule (Übergangsfrist mit Hinweis statt Sofortsperre);
  Demo-Instanzen weiterhin ohne Pflicht. Tests: Pflicht je Rolle, Schulnetz innen/außen, gefälschtes `X-Forwarded-For`
- [x] **SEC-02** (M) Code-Liste für Kinder ohne Handy – umgesetzt 4e-R1 (Migration 0079, Recht `verwaltung.zwei_faktor`, `e2e/codeliste.spec.ts`, Q-4E-4): Sekretariat erzeugt gedruckte Einmalcodes (nur gehasht gespeichert, Druck
  mit Name/Klasse, neue Liste macht die alte ungültig); 2FA zurücksetzen durch das Sekretariat (eigenes Recht, Protokoll, Gong
  an das Konto bzw. die Eltern); E2E: Schülerin meldet sich von „außen“ mit Code von der Liste an
- [x] **SEC-03** (M) Passkeys / Sicherheitsschlüssel (WebAuthn) als zweiter Faktor neben der Code-App (Q-71); Lizenz des
  Better-Auth-Passkey-Plugins prüfen; Verwaltung der eigenen Schlüssel unter Profil → Sicherheit – umgesetzt 4e-R2 (Migration 0081 `passkeys`, @simplewebauthn/server+browser MIT; Plugin MIT geprüft, nicht eingebunden – Q-4E-9; `/zwei-faktor`, `e2e/passkey.spec.ts`; Q-4E-9…13)
- [x] **P4-70** (M) Passwort zurücksetzen per E-Mail **nur für Konten mit eingerichteter 2FA** (Q-52; der zweite Faktor bleibt nach dem Reset Pflicht) – Lehrkräfte, Personal, Eltern; Token wie 4c, 1 h, nur Konten mit bestätigter E-Mail, Rate-Limit, Sitzungen anderer Geräte beenden, Audit) – umgesetzt 4e-R1 (`/passwort-vergessen`, Q-4E-5)
- [x] **P4-71** (S) Sitzungsübersicht + „überall abmelden“ + Inaktivitätsablauf (Einstellung je Schule) – umgesetzt 4e-R1 (`/konto/sitzungen`, Migration 0080 `sessions.last_active_at`, Vorgabe aus, Stufen ab 15 min; Q-4E-6)
- [x] **P4-72** (M) Virenscan optional (ClamAV-Profil in `compose.yaml`, `SCHULOS_CLAMAV=clamav:3310`, Upload-Pfade: Dateien, Aufgaben, Gebäude-Fotos, Prüfprotokolle; Status in Verwaltung → System; Stack-Test mit EICAR) – umgesetzt: `src/core/files/virus-scan.ts` (clamd INSTREAM über TCP, Version), `scanUpload` vor `storage.put` in Dateien, Aufgaben, Gebäude-Fotos, Prüfprotokollen (streng bei nicht erreichbarem Scanner), Profil `clamav` (gepinnt, Härtung mit begründeter Ausnahme), Karte „Virenscan“ unter Verwaltung → System, `node cli.mjs virenscan-pruefen` mit EICAR im CI-Job `stack` (nur CI); SICHERHEIT S71, Q-4E-57
- [x] **SEC-11** (M) Unveränderliche Offsite-Kopie (Ransomware, Projektleitung 2026-10-10): Kopie der Backups, auf die das Hauptsystem **und** der Backupserver keinen Schreib-/Löschzugriff haben (z. B. Storage-Box-Snapshots oder zweiter Pull vom Backupserver mit eigenem Schlüssel); ergänzt die bestehende optionale Offsite-Kopie (restic copy, INSTALLATION §4), kein zweiter Mechanismus daneben; Doku + Prüfung „letzte unveränderliche Kopie“ in Verwaltung → System (Alarm über SEC-14); SICHERHEIT S29 – umgesetzt: Schnappschüsse des Offsite-Ziels (Storage Box `.zfs/snapshot`, nur Anbieterkonto löscht), Prüfung als Wartungslauf „Unveränderliche Kopie“ (`apps/backup/src/maintenance/immutable.ts`, `SCHULOS_OFFSITE_SNAPSHOTS`, ≤ 48 h, Alarm), Ergebnis im Plan an den Agenten → Verwaltung → System; S3 Object Lock dokumentiert (nicht prüfbar); INSTALLATION §4.3a, SICHERHEIT S29, DATENSCHUTZ §3.5, Q-4E-55
- [x] **SEC-12** (M) Admin-Ebene (SSH, `schulosctl`, Hypervisor-Oberfläche) nur über WireGuard/Schulnetz: Installer-Option (Vorgabe an, SSH lauscht nur auf WireGuard-/Schulnetz-Adresse), INSTALLATION-Checkliste (Hypervisor nie im Internet), Stack-Test: SSH von „außen“ nicht erreichbar – umgesetzt: Frage `access.ssh_from` (Vorgabe private Netze), nftables-Tabelle `schulos_ssh` + Dienst `schulos-ssh-netz`, `AllowUsers schulos-admin@<netz>` (statt ListenAddress – funktioniert auch mit DHCP); Checkliste INSTALLATION §5b Punkt 9; QEMU-Schritt 2c (nur CI); SICHERHEIT S69, Q-4E-54
- [x] **SEC-13** (M) Container-Härtung: alle Dienste non-root, `read_only` wo möglich, `cap_drop: [ALL]`, `no-new-privileges`, kein `docker.sock` in der App (Ausnahmen mit Begründung in `compose.yaml` kommentiert); Stack-Test prüft die Einstellungen am laufenden Stack; baut auf SEC-07 (Datenbankrolle ohne Superuser) auf – umgesetzt: Anker `x-haertung` in `compose.yaml`/`compose.backup.yaml` (+ `compose.vorschau.yaml`), PostgreSQL/Test-Postgres als `postgres`, Agent/Backup-App `/tmp` als Volume + `XDG_CACHE_HOME`, Ausnahmen Caddy (root, `NET_BIND_SERVICE`) und `geraete-ca-init` (root, `CHOWN`) kommentiert; `scripts/haertung-pruefen.sh` in den CI-Jobs `stack` und `backup` (nur CI), `compose-haertung.test.ts`; SICHERHEIT S68, Q-4E-53
- [x] **SEC-14** (M) Sicherheitsalarme per Mail über den vorhandenen SMTP-Weg (B-38; Alarmarten dort: Backup überfällig, Prüfung fehlgeschlagen, Platz knapp, Update fehlgeschlagen – **nur ergänzen**): Häufung Fehl-Anmeldungen (Schwelle je Schule), neue Admin-/Verwaltungsrechte (Rolle/Recht vergeben, S15), Backup-Ausfall > 24 h bzw. fehlende unveränderliche Kopie (SEC-11); Entprellung, Empfänger in Verwaltung → System; Tests – dazu (Q5-18, Projektleitung 2026-10-11): Backupserver-Oberfläche zeigt „Neustart nötig – Passphrase erforderlich“ als Statuskarte + Alarm-Mail über dessen SMTP-Weg – umgesetzt: `src/core/system/security-alarms.ts` (Fehl-Anmeldungen aus `auth_throttle`, Rechte-Ereignisse aus dem Audit-Log, Einstellungen Empfänger/Schwelle unter Verwaltung → System), Ereignis-Alarme in `@schulos/server/mail` (`event`), unveränderliche Kopie in `alarms.ts`; Backupserver: `@schulos/server/host-status` + `schulos-hoststatus.timer` (Installer, Nachrüsten), Statuskarte + Alarm; SICHERHEIT S70, Q-4E-56
- [x] **SEC-15** (S) Optional: CrowdSec vor Caddy als Compose-Profil (`SCHULOS_CROWDSEC=1`, Bouncer für Caddy, Status in Verwaltung → System); Lizenz und Datenschutz (Weitergabe von IPs an die Community-Liste) vorher prüfen – Vorgabe „aus“. ClamAV (P4-72) ist ein anderes Thema (Uploads) und bleibt dort – umgesetzt: Profil `crowdsec` (gepinnt, Online-API aus), Caddy-Zugriffsprotokoll nur mit `SCHULOS_CROWDSEC=1` (48 h), Bouncer in der App (`src/core/crowdsec.ts` + `src/proxy.ts`, kein eigenes Caddy-Image), Karte „Angriffserkennung“ unter Verwaltung → System; Lizenz (MIT) und Datenschutz (keine Weitergabe, DSB vor dem Einschalten der Online-API) in INSTALLATION §5 und DATENSCHUTZ §6; CI-Test mit `cscli decisions add` (nur CI); SICHERHEIT S72, Q-4E-58
- [x] **SEC-16** (S) Externer Pentest als Pflicht vor einem Pilot mit Außenzugang: Hinweis in INSTALLATION.md („Außenzugang“, Checkliste Schulträger) und PLAN.md (Risiken/Pilot), Prüfumfang (Außenzugang, Gerätezertifikate, Anmeldung, Backup-Pfad); Befunde als SEC-Folgeaufgaben – umgesetzt: INSTALLATION §5b Checkliste Punkt 10 (Prüfumfang, Pilot erst ohne hohe/kritische Befunde), PLAN.md Track B „Risiko und Pflicht vor einem Pilot“, SICHERHEIT §7
- [x] **A11Y-01** (M) axe + Tastatur-E2E auf Kernseiten je Rolle, Befunde beheben (eigene Folge-IDs A11Y-01a…) – umgesetzt 4e-R3 (`e2e/a11y.spec.ts`: axe-core über `@axe-core/playwright` 4.13, **MPL-2.0, nur Dev** – Datei-Copyleft, AGPL-verträglich, nicht im Image; WCAG 2.0/2.1/2.2 A+AA + Best Practices auf 34 Kernseiten von Schülerin, Lehrkraft, Eltern, Sekretariat, Admin + öffentlichen Seiten, hell/dunkel/mobil, mit offenem Benutzermenü/Gong/Palette; Tastatur: Anmeldung, Sprungmarke, Seitenleiste, Menü, Gong, Palette, sichtbarer Fokus auf den ersten 25 Tab-Stopps)
  - [x] **A11Y-01a** Demo-/Vorschau-Band außerhalb aller Landmarken (`region`) → eigenes `<aside>` mit Namen
  - [x] **A11Y-01b** Messenger ohne `<main>` (`landmark-one-main`) → Layout als `<main>`
  - [x] **A11Y-01c** Tagesleiste: vergangene Stunden mit `opacity-55` unter 4,5 : 1 (`color-contrast`, **serious**) → gedämpfte Fläche statt Deckkraft
  - [x] **A11Y-01d** Kalender-Monatsansicht: Termine 20 px hoch (`target-size`, **serious**, WCAG 2.5.8) → mindestens 24 px
  - [x] **A11Y-01e** Benutzermenü: Hell/Dunkel/System als `radiogroup` im `menu` (`aria-required-children`, **critical**; per Pfeiltaste nicht erreichbar) → Menü-Radioeinträge (`ThemeMenuRadio`); Menü nicht modal (`aria-hidden-focus`, **serious**)
  - [x] **A11Y-01f** Gong-Dialog ohne Namen (`aria-dialog-name`, **serious**) und zweites `banner` (`<header>` im Portal) → `aria-labelledby`, Kopf als `div`
  - [x] **A11Y-01g** Sprungmarke „Zum Inhalt springen“ in der Shell (erster Tab-Stopp, WCAG 2.4.1)
  - [ ] **A11Y-01h** (offen, moderate) `region`: Radix legt offene Menüs als Portal ans Ende von `<body>` – außerhalb der Landmarken; hängt per `aria-controls` am Auslöser. Ausnahme in `e2e/a11y.spec.ts`
  - [ ] **A11Y-01i** (offen, Fehlalarm) `scrollable-region-focusable` am langen Benutzermenü (Demo-Konten): Einträge sind per Pfeiltaste erreichbar (roving tabindex), axe zählt `tabindex=-1` nicht. Ausnahme in `e2e/a11y.spec.ts`
  - [ ] **A11Y-01j** (offen) Rest der Seiten (Fachseiten der Verwaltung, Druckansichten, Tafeln/Texte-Editoren, Monitore) in `e2e/a11y.spec.ts` aufnehmen; Screenreader-Durchgang (NVDA/VoiceOver) von Hand vor einem Pilot
- [x] **A11Y-02** (S) Seite „Erklärung zur Barrierefreiheit“ (öffentlich) + Link im Footer/Login – umgesetzt 4e-R3 (`/barrierefreiheit` öffentlich, Aufbau nach EU-Muster 2018/1523: Stand, nicht barrierefreie Inhalte [SchulOS-Liste im Code + Ergänzungen der Schule], Erstellung, Feedback/Kontakt [Rückfall Impressum], Durchsetzungsverfahren [Vorgabe NRW: Ombudsstelle, §§ 10d/10e BGG NRW, §§ 9 ff. BITV NRW; andere Länder Platzhalter]; Pflege unter Verwaltung → Schule, Schlüssel `school.barrierefreiheit`; Links: Anmeldeseite, Impressum, Datenschutzhinweise, Benutzermenü; `e2e/barrierefreiheit.spec.ts`; Q-4E-23/24 – Außen-Allowlist + Fußzeile der Schulanmeldung im Ops-Zweig)
- [x] **P4-73** (M) PWA ohne Push (Manifest, Service Worker Offline-Shell, Installationshinweis) – umgesetzt 4e-R3 (`/manifest.webmanifest` mit Schulname/-farbe und Schulsymbol bzw. SchulOS-Symbol, `/sw.js` aus `src/core/pwa/service-worker.ts`: nur `/_next/static/` + Symbol im Cache, no-store-Liste/API/RSC/Actions/Nicht-GET nie angefasst, Seiten nur Netz + fester Offline-Hinweis; Update: Build-ID im Cache-Namen, skipWaiting + alte Caches weg; Abmelden/Anmeldeseite leeren die Caches; Installationshinweis `/konto/app` im Benutzermenü; Vitest führt den ausgelieferten SW-Text mit Attrappen aus, `e2e/pwa.spec.ts`; Q-4E-25/26, SICHERHEIT S63)
- [x] **P4-74** (S) Lehrkräfte melden eigene Abwesenheit – umgesetzt 4e-R2 (`/stundenplan/abwesenheit`, Migration 0084, Recht `stundenplan.absence_approve`, `e2e/abwesenheit-selbst.spec.ts`; Q-4E-17…20)
- [x] **Q5-12** (M) Vertretungsmaterial zusammen mit P4-74 (F-01): beim Selbstmelden Text/Datei je betroffener Stunde, sichtbar für Vertretungslehrkraft (Tagesleiste, Eintragsseite) und Planung („Material liegt vor“), optional für Schüler:innen; `follows` Vertretung; dazu (S) Genehmigung durch die Schulleitung bei `fortbildung`/`dienstlich` (I-18, I-26) – umgesetzt 4e-R2 (`timetable_absence_materials` follows `timetable_absences`; Q-4E-21…22)
- [x] **P4-77** (M) Vorschau mit Schulprofil (Projektleitung 2026-10-10, nur notiert) – App-Seite umgesetzt 4e-R3 (`src/modules/verwaltung/schulprofil.ts`: JSON „schulos-schulprofil“ v1 mit Schuldaten, Logos [Base64, beim Einspielen wie ein Upload geprüft], Modulen, Moduleinstellungen, Rollenrechten, Inaktivitätsablauf; striktes Schema – nur Aufzählungen/Bezeichner/Schulname/Bilder, unbekannte Schlüssel abgelehnt; Export unter Verwaltung → Schule [POST `/api/verwaltung/schulprofil`, `verwaltung.school` + `verwaltung.rights`, Protokoll], Einspielen nur in Demo-/Vorschau-Instanzen [UI + `node cli.mjs schulprofil-import`], `demo-reset` spielt `schulprofil.json` aus dem Konfigurationsordner nach jedem Zurücksetzen wieder ein; Tests: Export der Demo-Schule ohne Namen/Benutzernamen/Adressen, Schema lehnt Personen-/Noten-/Freitextfelder ab, Import ersetzt Zuschnitt und lässt Personen stehen, nie in Produktiv-Instanz; `e2e/schulprofil.spec.ts`; Q-4E-27/28. **Offen im Ops-Zweig:** `schulosctl vorschau profil` – siehe Q-4E-28): die Vorschau übernimmt Logo, Schulname, eingeschaltete
  Module, Rechte-/Rollen-Zuschnitt und Einstellungen der echten Schule, aber mit **Demo-Personen** (keine Personendaten kopieren).
  Begründung: keine Testkopie mit Echtdaten (Datenminimierung); Updates sind über Kanal beta + Probelauf + Test-Restore abgesichert
- [x] **DS-20** (S) Gründe von Krankmeldungen für Admin-Konten ausblenden (Q-4D-5, Projektleitung 2026-10-13): Vollrecht `*` schließt die Gründe nicht mehr ein (wie Notenbuch F5-05), Hinweis DS-18 + DSB-Checkliste anpassen; Test
- [x] **INST-07** (S) Unbeaufsichtigte Installation nur als CI-Testmodus (Projektleitung 2026-10-13): greift nur mit Stick `SCHULOSCFG` **und** Kernel-Parameter `schulos.testmodus` (setzen nur `qemu-test.sh`/`iso.yml`); Stick allein → Hinweis, keine Installation; Abschluss zeigt „TESTINSTALLATION“; aus der Schul-Anleitung entfernen, eigener Entwickler-Abschnitt in INSTALLATION.md; QEMU-Tests laufen unverändert – umgesetzt: Test-Kopie der ISO per `iso/testmodus-iso.sh` (xorriso, nur Bootmenü; Aufrufer `qemu-test.sh`, `build-qcow2.sh`), `start-installer.sh` setzt Test-Schalter nur im Testmodus, Installer verweigert `--unbeaufsichtigt --installieren`/`--abbild`/`--ohne-bestaetigung` ohne `--testmodus`, `iso/build.sh` lehnt eine ISO mit dem Parameter ab; QEMU-Schritt 0 (Stick ohne Testmodus installiert nicht), INSTALLATION §7.1
- [ ] **INST-08** (M) Startmenü der ISO unter Secure Boot (Q-4E-60): Installation auf der Platte auch mit signierter GRUB erkennen (nur eingebaute Module bzw. Start über UEFI-Startreihenfolge/`chainloader` auf den shim der Platte); QEMU-Backupserver dann wieder mit Secure Boot
- [x] **INST-09** (S) Abfrage am Schlüssel-Bildschirm klarer formulieren (Befund Projektleitung, Hyper-V-Backupserver 0.5.0, 2026-10-15): „Zur Bestätigung Block 8 eintippen …“ wurde nicht als Aufforderung erkannt → neu: „Tippe Block 8 des Wiederherstellungsschlüssels ein (Enter ohne Eingabe = erneut anzeigen):“ (`packages/server/src/recovery-key.ts` `confirmRecoveryKey`, Fehlertext passend; Tests in `abschluss-konsole.test.ts` u. a. warten auf den alten Wortlaut)
- [x] **INST-10** (S) Backupserver per IP liefert leere Seite (Befund Projektleitung, Hyper-V-Backupserver 0.5.0, 2026-10-15): INST-04 hat nur TLS ohne SNI repariert (`default_sni`), die Anfrage mit `Host: <IP>` passt aber auf keinen Site-Block → Caddy antwortet `200` mit `Content-Length: 0` (weiße Seite), obwohl die Konsole „https://<IP> (per IP, Zertifikatswarnung bestätigen)“ anzeigt. Fix in `compose.backup.yaml`: Anfragen über die IP ebenfalls an `backup:3100`/`rest-server` (z. B. Site-Adresse `{$SCHULOS_BACKUP_DOMAIN}, https://` bzw. Catch-all `:443`, `tls internal`/`on_demand` prüfen) + Test mit echtem `Host: <IP>` (nicht nur Handshake), Erwartung Weiterleitung auf `/login`. Hauptsystem (`compose.yaml`, nur Block `{$SCHULOS_DOMAIN}`) auf dasselbe Muster prüfen – dort zusätzlich Außenzugang/Schulnetz-Regeln (P4-40) nicht umgehen. Workaround bis dahin: Hosts-Eintrag `<IP> backup.schulos.local`
- [x] **REPO-03** (S) Vorschau-/Haftungshinweis (Projektleitung 2026-10-13): Installer-Bildschirm vor der Plattenauswahl („Vorschau-Software, ohne Gewähr, kein Support; verantwortlich für die Daten ist die Schule; vor Echteinsatz fehlen Pentest, DSB-Klärung, Pilot“), weiter nur mit „VERSTANDEN“ (Testmodus: Datei); Web-UI-Erststart für Admins mit Bestätigung, dauerhaft „Vorschau-Version“ unter Verwaltung → System (kommt so auch per Update); entfällt mit v1.0 nach Pilot – umgesetzt: Text in `@schulos/server/disclaimer`; Installer-Bildschirm vor allen Fragen (`tui/App.tsx`, Phase `disclaimer`), unbeaufsichtigt nur mit `--vorschau-verstanden`; Web: Band für Admins (`_shell/disclaimer.tsx`) bis zur Bestätigung, Karte „Vorschau-Hinweis“ unter Verwaltung → System (`src/core/disclaimer.ts`, Audit `system.disclaimer.ack`); README/INSTALLATION; Q-4E-51
- [ ] **REPO-02** (M) **Umschalten freigegeben (Projektleitung 2026-10-16), Entscheidungen Q-4E-30…36**: Repo-Variable `SCHULOS_RUNNER` mit neuem Wert `oeffentlich` (Release + alle PRs auf GitHub-Runnern, Push/Zeitpläne/ISO/QEMU/Lasttest auf der Build-VM; Vorgabe ohne Variable = heutiges Verhalten), Fork-PRs nie self-hosted (`head.repo.full_name`); `iso.yml` hängt ISO + `.sha256` + cosign-Signatur `.sha256.sig` + Stückliste ans Release; INSTALLATION §1.1 „ISO herunterladen und prüfen“; `schulosctl` lädt Release-Anhänge ohne Token über die öffentlichen Download-Links (kein API-Limit), Repo nur noch an einer Stelle (`RELEASE_REPO`); Fragen Q-4E-36…40. Ursprünglicher Auftrag: Runner/Release bei öffentlichem Repo (Q-R5-2): Release und PR-CI auf GitHub-Runner (erledigt SEC-10), ISO/QEMU + Lasttest bleiben auf der Build-VM (self-hosted nur für eigene Branches, Fork-PRs nur nach Freigabe); ISO als Release-Anhang mit cosign-signierter Prüfsumme; INSTALLATION.md „ISO herunterladen und prüfen“; `schulosctl update` ohne Token testen
- [ ] **REPO-01** (M) **Umschalten freigegeben (Projektleitung 2026-10-16), Entscheidungen Q-4E-30…36**: LICENSE (AGPL-3.0, Volltext), NOTICE (Copyright „SchulOS-Mitwirkende“, AGPL-3.0-or-later, Q-4E-30), README (Vorschau, ohne Gewähr, kein Support, was vor Echteinsatz fehlt, Entwicklung mit Claude), SECURITY.md, CONTRIBUTING.md; Homelab-Details/Namen/Marken aus Doku und Code entfernt, wiederholbar mit `npm run veroeffentlichen:pruefen` (Muster-Liste, `--ersetzen`, `--umschalttag`); Checkliste `docs/VEROEFFENTLICHUNG.md`; Fragen Q-4E-30…35. Ursprünglicher Auftrag: Veröffentlichung vorbereiten (Q-R5-1, Projektleitung 2026-10-13): **frisches Repo** in GitHub-Organisation (nur aktueller Stand, Noreply-Autor), LICENSE AGPL-3.0, Copyright „SchulOS-Mitwirkende“, README ehrlich und ausführlich (Status Vorschau, ohne Gewähr, kein Support, Liste was vor Echteinsatz fehlt, Abschnitt Entwicklung mit Claude), SECURITY.md (private Meldungen), Issues/Discussions aus, Rulesets mit Pflicht-Checks, GHCR-Pakete öffentlich; vorher gitleaks über den Stand, Homelab-Details/IPs und Fremdproduktnamen aus Doku/Code; Namensprüfung „SchulOS“ (DPMA/EUIPO). Umschalten erst nach v0.5.0 **und** erneuter Zustimmung von der Projektleitung
- [x] **P4-66** (S) Kurswahl: automatische Erinnerung zwei Tage vor Wahlende an alle, die noch nicht gewählt haben (Q-4D-23, Projektleitung 2026-10-13) – Job wie die Sprechtag-Erinnerung (einmal je Verfahren, Gong an Wählende bzw. Eltern ohne Bestätigung, keine Mail), die Erinnerung von Hand bleibt; Test – umgesetzt 4e-R2 (Job `kurswahl-erinnerung` 16–20 Uhr, Migration 0082; Q-4E-14)
- [x] **P4-67** (M) Kurswahl: Mehrfachwahl (Q-4D-20, Projektleitung 2026-10-13) – je Verfahren „Anzahl Kurse je Person“ (Mindest-/Höchstzahl, z. B. zwei AGs oder EF-Fachwahl), Wünsche je Platz, Zuteilung über mehrere Plätze ohne doppelten Kurs, Übernahme in mehrere Gruppen; Belegungsvorschriften der Oberstufe bleiben außen vor (nur Anzahl); Tests + E2E – umgesetzt 4e-R2 (Migration 0083, Plätze je Person, Zuteilung Platz für Platz; Q-4E-15…16)
- [ ] **GATE 4e**, danach **Release v0.5.0**

### 4f Feinschliff (Rollen-Durchgang, Projektleitung 2026-10-10 – zwischen 4c und 3b, Begründung in `docs/FEINSCHLIFF.md`)
Eigener Block mit kleinem Gate; fast alles S/M. Entscheidungen F-01…F-09 in `docs/QUESTIONS.md`. Opus.
- [x] **Q5-14** (M) Moduleinstellungen im Manifest + erste Schalter (Direktchats unter Schüler:innen aus/Klasse/alle; Eltern-Info Vertretung bis Jahrgang; Hausaufgaben für Eltern bis Jahrgang) unter Verwaltung → Rechte & Module; Messenger-Note ist bereits korrigiert (Q5-14a) (I-60) – **zuerst, vor Q5-02/Q5-03**
- [x] **Q5-02** (S–M) Hausaufgaben für Schüler:innen: Widget „Hausaufgaben“ auf Heute (nächste Schultage, Fachfarbe) + Abschnitt im Kursraum aus `classbook_entries.homework` der eigenen Gruppen; Hinweis „keine Namen“ im Eintragsformular; Eltern sehen sie als Moduleinstellung „bis Jahrgang 6“, Vorgabe aus (F-04; I-01)
- [x] **Q5-03** (S) Vertretungs-Gong gebündelt und an Eltern: eine Nachricht je Person und Tag; Eltern minderjähriger Schüler:innen als Empfänger, Einstellung „bis Jahrgang“ mit Vorgabe ganze Sek I, Oberstufe nie (F-02); Test: Entfall → Elternteil bekommt genau einen Gong (I-03, I-09)
- [x] **Q5-06** (S–M) Klassenbuch-Lücken für die eigene Lehrkraft + Tagesleisten-Link: Karte → `/klassenbuch/eintrag` (Lehrkraft) bzw. Kursraum (Schüler:in), Abschnitt „n Stunden ohne Eintrag“ nur für die Person selbst, Gong freitags (I-02, I-16)
- [x] **Q5-07** (M) Widget „Offen für dich“ (Rahmen + Lieferanten): Eltern (Elternbriefe je Kind, Umfragen, Krankmeldung offen), Lehrkraft/KL (Krankmeldungen zu entscheiden, Elternbrief-Rücklauf mit „Erinnern“, Umfragen), Schulleitung (Vertretungsbedarf offen, Aufsichten unbesetzt, Raumsperren, Backup-Ampel) – nur Zähler, keine Lehrkräfte-Statistik (I-10, I-27)
- [x] **Q5-08b** (S) Rest von Q5-08: `/buchungen` lesend für `gebaeude.manage`, Widget „Heute im Haus“ (Buchungen Aula/Sporthalle, Wartung, Sperren) (I-50)
- [x] **Q5-09** (S) Meine Aufsichten + Mein Deputat: Pausen-Chip in der Tagesleiste, Aufsichten im Stundenplan-Druck, Gong bei Aufsichtsvertretung (`setDutyChange`), Seite „Mein Deputat/meine Vertretungsstunden“ nur eigene Werte (I-19, I-20)
- [x] **Q5-10** (S–M) Zeitwünsche durch Lehrkräfte selbst: Eingabefenster (Zeitraum) in Verwaltung → Unterricht, Lehrkraft pflegt eigene `timetable_time_prefs`, Planung sieht/überschreibt, Gong zur Frist (I-47)
- [x] **Q5-11** (M) Vertretungsplan Entwurf/Freigabe: Tagesstatus je Datum, Modus „sofort“ als Vorgabe (heutiges Verhalten), „Freigabe“ als Option, **Demo-Schule steht auf „Freigabe“** (F-06); Schüler:innen/Eltern/Monitor sehen den veröffentlichten Stand, Veröffentlichen bündelt die Gongs, Einzeländerungen danach sofort; E2E: Monitor zeigt keinen Entwurf (I-25)
- [x] **Q5-13** (M) Eigene Fehlzeiten + Gong an Eltern: Abschnitt in `/abwesenheiten` (Fehlstunden/Verspätungen, Status) für Schüler:in und Eltern minderjähriger Kinder; Gong an Eltern **erst nach Entscheidung „nicht entschuldigt“ durch die Klassenleitung** (F-03; vorher nur „Fehlstunde ohne Meldung“ in der Elternsicht); Hinweis an KL ab N unentschuldigten Tagen (einstellbar), keine Automatik Richtung Schulleitung/Behörde; Lesezugriff protokolliert; Rechtsfrage DSB-FRAGEN §10 (I-08, I-21, I-22)
- [x] **Q5-16** (M–L) Beurlaubung vorab (F-08): Antrag in SchulOS (Eltern, volljährige Schüler:innen), Art `beurlaubung` mit Gründen ohne Art.-9-Bezug (familiär, Wettkampf/Veranstaltung, sonstiges – keine Religion), Status beantragt/genehmigt/abgelehnt, **Klassenleitung entscheidet bis 2 Tage, Schulleitung darüber** (Grenze einstellbar), Gong an Entscheider:in und Antragsteller:in, Ergebnis ins Klassenbuch („beurlaubt“); § 43 SchulG NRW „zu prüfen“ (DSB-FRAGEN §9) (I-06)
- [x] **Q5-17** (M) Rolle `beratung` für Schulsozialarbeit (F-05): Enum + Migration, 2FA-Pflicht wie alle Erwachsenen, im Adressbuch für Schüler:innen/Eltern mit Sprechzeiten/Raum sichtbar, Direktchat nur auf deren Initiative, sieht nur Personen mit bestehendem Chat oder gemeinsamer Gruppe; Seed-Persona „Schulsozialarbeit“; **Chat-Funktion erst nach DSB-Votum** (DSB-FRAGEN §8; Löschfrist-Scope, Hinweis „nur Terminabsprache“); keine Fallakte (I-55, I-56)
- [x] **Q5-15** (M) Kalender-Abo per widerrufbarem Token (nur Lesen, nur sichtbare Kalender, Rate-Limit P4-31, Audit, SICHERHEIT-Annahme) – **nach P4-40** (Außenzugang, F-07) (I-12)
- [x] **G4-01** (S) Aufbewahrung der Prüfprotokoll-PDFs und Prüfungs-Bemerkungen (Security-Review Gate 4a, Hinweis 1): reale Protokolle (DGUV V3, Feuerlöscher) tragen Namen/Unterschrift der prüfenden Person, `note` kann Namen enthalten – bisher `NO_PERSONAL_DATA`, nie gelöscht. Frist mit DSB klären (Vorschlag: bis zur übernächsten Prüfung bzw. Nachweispflicht des Schulträgers), dann Löschklasse + Löschlauf für `report_key`/`note`; DSB-FRAGEN ergänzen
- [x] **Q5-18** (S–M) Neustart im Wartungsfenster nur mit TPM2 (Projektleitung 2026-10-11): bei LUKS-Passphrase (kein TPM2 in `/etc/crypttab`) startet `schulosctl wartungsfenster` nicht neu (sonst hängt der Server nachts an der Passphrase), sondern protokolliert „Neustart nötig – Passphrase erforderlich“; Hinweis in Verwaltung → System mit „Jetzt neu starten“, Mail an die Admins, nach 14 Tagen rot; Installer-Hinweis bei Wahl Passphrase (Neustarts von Hand, TPM2 empfohlen). Entsperren per SSH (dropbear-initramfs) offen → QUESTIONS
- [x] **INST-04** (S) Backupserver per IP aufrufbar (Befund Projektleitung, Hyper-V 0.3.1): Caddyfile in `compose.backup.yaml` ohne `default_sni` → Aufruf über die IP (kein SNI) endet im TLS-Fehler; wie beim Hauptsystem `default_sni {$SCHULOS_BACKUP_DOMAIN}` + Test
- [x] **INST-05** (M) Abschluss der Installation repariert (Befunde Projektleitung, Hyper-V 0.3.2, Haupt- und Backupserver): Bestätigung von Block 8 wurde ohne Eingabe übersprungen, „Neustart in 30 Sekunden“, Startreihenfolge nie gesetzt → Neustart wieder im Installer; QR aus ◆ statt ▀ ▄. Ursache: Ink gibt stdin beim Verlassen der Oberfläche per `unref()` frei, die offene readline-Frage hielt den Prozess nicht, Exit 0. Fix: `closableAsk` (ref + EOF = `InputClosedError`, nie Bestätigung), Startreihenfolge vor der Bestätigung, interaktiv kein Neustart per Zeitablauf, ISO-Bootmenü startet eine vorhandene Installation von der Platte (Vorgabe); Schlüssel nur als Text (Entscheidung Projektleitung, `qrencode` raus); Konsolenstatus mit Web-Oberfläche per Domain/IP, Backupserver mit Hinweis „Instanzen → Kopplungscode erzeugen“ (auch am Abschluss); Strg+C beendet die Bestätigung nicht mehr
- [x] **INST-06** (M) Kein Neuinstallations-Kreislauf mit eingelegtem Medium/Stick (Q-INST05-1, Projektleitung 2026-10-12 „Gerne so umsetzen“): Abschlussbildschirm (interaktiv und unbeaufsichtigt) vor dem Neustart-Tastendruck: eigener Konfigurations-Stick SCHULOSCFG wird ausgehängt, „JETZT abziehen“; Installationsmedium „kann nach dem Neustart entfernt werden – bleibt es drin, startet SchulOS automatisch von der Festplatte“ (nie im laufenden Live-System entfernen, INST-01; SCHULOSCFG auf dem Live-Datenträger selbst wird wie das Medium behandelt); **Überschreibschutz:** Zielplatte mit Markierung `/grub/schulos-installiert` (Boot-Partition nur lesend `ro,noload` eingehängt, beim Spiegel über den Daten-Offset des Mitglieds) wird interaktiv nur nach eingetipptem „ÜBERSCHREIBEN“ gelöscht (Rolle/Version/Datum aus der Markierung), unbeaufsichtigt nur mit Datei `ueberschreiben` bzw. `schulos.ueberschreiben` (`--ueberschreiben`) – sonst Code 5, Meldung auf tty1, kein Neustart; QEMU-Test 4b (Demo mit Medium + Stick neu gestartet → rc=5)
- [x] **Q5-19** (S) Nachrücken von der Warteliste nach Verfahrensabschluss (GATE-4c Code U1, Projektleitung 2026-10-11): `warteliste → aufgenommen` auch nach „abgeschlossen“ bis zum Schuljahresbeginn (nur Schulleitung), Fristbeginn der Löschfrist neu rechnen, Kind landet im nächsten Schuljahreswechsel „Neuaufnahmen“; Test Service + Löschvorschau
- [x] **Q5-20** (S) Unbestätigte Elternkonto-Treffer als Vorschlag zum Ankreuzen (GATE-4c Security „prüfen“ 4, Projektleitung 2026-10-11): Zuordnungstabelle im Schritt „Neuaufnahmen“ zeigt Konten mit unbestätigter E-Mail als Vorschlag (Kästchen, Vorgabe aus), Verknüpfung nur nach Ankreuzen; Test; **vor dem nächsten Schuljahreswechsel**
- [x] **Q5-21** (S) Sammelknopf „Startpasswörter für die gerade angelegten Konten neu erzeugen“ im Schritt „Neuaufnahmen“ (GATE-4c Code L6, Projektleitung 2026-10-11), zusammen mit Q5-20; Audit-Eintrag, Anzeige einmalig + CSV/Druck, Test
- [x] **Q5-22** (S–M) Impressum als einzelne Pflichtfelder nach § 5 DDG (P4-33, Projektleitung 2026-10-11): Verwaltung → Schule mit Feldern Name/Rechtsform, Anschrift, Vertretungsberechtigte, Kontakt (E-Mail, Telefon), ggf. Register/USt-IdNr., Schulträger; Vollständigkeitsprüfung (Hinweis in der Verwaltung, Modul Schulanmeldung lässt sich ohne vollständiges Impressum nicht veröffentlichen), `/impressum` rendert aus den Feldern, bisheriger Freitext wird übernommen (Migration); Test
- [x] **Q5-23** (M) Elternteil 2 in der Schulanmeldung (P4-39b, Projektleitung 2026-10-11): Anmeldeformular fragt Elternteil 2 optional mit E-Mail ab (Bestätigung/Datensparsamkeit wie Elternteil 1, DSB-FRAGEN §3c ergänzen), bei der Übernahme wird auch Elternteil 2 als Elternkonto angelegt bzw. verknüpft (gleiche Zuordnungslogik und Vorschlagstabelle wie Elternteil 1, Q5-20), Zugangsdaten-CSV/Druck und Auskunft (P4-42) mitziehen; Migration + Test
- [x] **Q5-24** (S) Knopf „Bestätigungslink senden“ in der Benutzerverwaltung (Q5-04b, Projektleitung 2026-10-11): löst für die eingetragene, unbestätigte Adresse den Link aus (Rate-Limit, Audit, nur mit SMTP), Anzeige „unbestätigt/bestätigt“ in der Liste; Test
- [x] **Q5-25** (S) Schulsozialarbeit pflegt Sprechzeiten/Raum selbst im Profil (Q5-17b, Projektleitung 2026-10-11): Rolle `beratung` darf `users.office_hours`/Raum der eigenen Person ändern (Profilseite), Verwaltung weiterhin überall; Test Rechte (nur eigene Zeile)
- [x] **Q5-26** (S) Aufbewahrung der Prüfprotokolle als Moduleinstellung wählbar (G4-01, Projektleitung 2026-10-11): Einstellung im Modul Gebäude (z. B. „letzte 2 / 3 / 5 Protokolle“, jeweils mindestens 1 Jahr), Vorgabe bleibt „bis zur übernächsten Prüfung, mindestens 1 Jahr“; Löschlauf liest die Einstellung (Settings-Mechanismus Q5-14), DSB-FRAGEN §11 angepasst; Test
- [x] **DS-12** (M) Datenschutz-Einrichtung durch die Schule (Projektleitung 2026-10-11 – Verantwortung liegt bei der Schule, SchulOS liefert sichere Vorgaben und Werkzeuge): neuer Pflichtschritt „Datenschutz“ in der Ersteinrichtung bzw. Verwaltung → Datenschutz, solange nicht erledigt mit Hinweis auf Heute (Admin): (1) Bestätigung „Die Schule ist Verantwortliche nach Art. 4 Nr. 7 DSGVO, DSB benannt (Name/Kontakt)“, (2) Übersicht aller datenschutzrelevanten Schalter und Fristen aus den Manifesten (`retention`, Moduleinstellungen, DSB-abhängige Funktionen wie Chat Schulsozialarbeit) mit vorsichtiger Vorgabe, je Punkt Status „Vorgabe übernommen / geändert / mit DSB geklärt“ + Bemerkung, (3) Nachweis als Druck/PDF/JSON („Datenschutz-Konfiguration Stand …“) für die DSB, Änderungen im Audit-Log; Test: Ersteinrichtung ohne Bestätigung → Hinweis bleibt, Export enthält alle Manifest-Fristen
- [x] **DS-13** (S–M) DSB-Checkliste für die Schule (Projektleitung 2026-10-11): `docs/DSB-FRAGEN.md` umbauen von „Fragen an unsere DSB“ zu einer Arbeitsliste, die die/der DSB der Schule vor dem Start durchgeht (je Thema: was SchulOS tut, Vorgabe, was die Schule entscheiden/dokumentieren muss, Verweis auf Einstellung); dieselbe Liste in DS-12 als abhakbare Punkte (aus einer gemeinsamen Datenquelle, z. B. `packages/core/src/datenschutz/checkliste.ts`), damit Doku und Oberfläche nicht auseinanderlaufen
- [x] **DS-14** (S) Vorlagen statt Zusagen + Verantwortungshinweis (Projektleitung 2026-10-11): README, INSTALLATION.md und Installer-Abschluss mit Hinweis „Lern-/Demoprojekt ohne Gewähr (AGPL §§ 15–16), Betrieb in eigener Verantwortung der Schule, vor Echtbetrieb DSB einbinden“; VVT- und Datenschutzhinweis-Seiten (B-05/P4-42) als „Vorlage – von der Schule zu prüfen und anzupassen“ kennzeichnen; Doku und Oberfläche nach Formulierungen wie „DSGVO-konform“/„rechtssicher“ durchsuchen und neutral fassen
- [x] **DS-15** (S–M) Feste Datenschutz-Vorgaben einstellbar machen (Projektleitung 2026-10-11): Bestandsaufnahme aller fest eingebauten Fristen/Schalter mit DSB-Bezug (Manifeste, Konstanten wie `UNCONFIRMED_HOLD_MINUTES`, Löschklassen); wo eine Schule berechtigt anders entscheiden kann, als Modul- bzw. Schuleinstellung mit Unter-/Obergrenze und der heutigen Vorgabe (Muster wie Q5-26); Rest begründet fest lassen (Liste in DATENSCHUTZ.md); Ergebnis fließt in DS-12/DS-13
- [x] **Q5-27** (S) Hausaufgaben optional mit „fällig am“ (Q5-02, Projektleitung 2026-10-11 abends): neue nullable Spalte `classbook_entries.homework_due` (Migration), Datumsfeld im Eintragsformular (nur Schultage ab morgen, Vorgabe leer = nächste Stunde derselben Gruppe im Fach wie bisher), Widget/Kursraum/Eltern nutzen das Datum, wenn gesetzt; Tests für beide Wege
- [ ] **GATE 4f** (klein) – Review-PR; danach Phase 3b (Patch-Release nach Bedarf)

### Datenschutz-Nachzug B-05 (Vorprüfung `docs/B05-KRANKMELDUNG.md`, 12.10.2026 – mit Block 4d, vor v0.4.0)
- [x] **DS-16** (M) Entschuldigungen archivieren: `absence_reports` (Zeitraum, Grund, meldende Person, Zeitpunkt, Entscheidung) als eigener Teil „Entschuldigungen“ im Archivexport (nicht im Klassenbuch-PDF für alle), Frist 5 Jahre nach § 9 Abs. 1 Nr. 4 VO-DV I / BASS 12-51 Nr. 5 Nr. 3 (Beginn frühestens Ende der Schulpflicht); im laufenden System weiter LK-SJ. Schuleinstellung „Digitale Meldung gilt als schriftliche Entschuldigung“ (Vorgabe: ja → Archiv; nein → Hinweis „bitte zusätzlich schriftlich“). Tests.
- [x] **DS-17** (S) Rechtsgrundlagen korrigieren: `legalBasis` der Manifeste Abwesenheiten/Klassenbuch + DATENSCHUTZ.md §1/§3 – § 122 Abs. 1 Satz 2 SchulG (Art. 9 Abs. 2 lit. g), VO-DV I Anlage 1 Abschn. A Nr. II Ziff. 18/19.1, Anlage 2 I Nr. 1 und II Nr. 1; Beurlaubung = § 43 **Abs. 4**; Satz „§ 122 ist nur Verordnungsermächtigung“ und „Anlagen zu digitalen Systemen prüfen“ ersetzen (§ 120 Abs. 5 SchulG, § 2 VO-DV I).
- [x] **DS-18** (S) Eltern-Hinweis nach Art. 13 im Melde- und Beurlaubungsformular (Rechtsgrundlage, Aufbewahrung, wer den Grund sieht, „Atteste nicht über Messenger oder Dateien schicken“); Sichtbarkeitsliste in DATENSCHUTZ.md und DSB-Checkliste vollständig (Klassenleitung, `abwesenheiten.manage`, meldende/alle Eltern Minderjähriger, `admin`, Sekretariat bei Telefonmeldung).
- [x] **DS-19** (S) Volljährige (§ 123 Abs. 2 SchulG): Selbstmeldung in `reportAbsence`, `parentView` blendet Volljährige aus – zusammen mit bzw. nach Q5-05.

### Phase 3b – Texte und Tafeln (nach Blöcken 4c und 4f, Projektleitung 2026-10-10)
- [x] **P3-11** (L, 2 Commits) Texte (Tiptap + Yjs): Yjs-Dokument in Tabelle `texte_docs` (Gruppen-Feature `texte.doc`), Updates per POST (`/api/texte/[id]/update`, Base64-Update, Server wendet an und speichert periodisch den Stand), Verteilung über den SSE-Kanal (Ereignis `text`), Wiederverbindung holt den vollen Stand; Export Markdown/PDF (Druckansicht); `retention` LK-ENDE-1J; Grenze ~30 gleichzeitig – darüber melden. **Fable – nur nach Freigabe durch die Projektleitung** (Begründung: Konfliktfreiheit/Reihenfolge über einen Einwegkanal + POST ist Architekturarbeit mit Fehlerbildern, die erst unter Last sichtbar werden; Yjs-Awareness ohne WebSocket ist ungewöhnlich)
- [x] **P3-12** (M) Tafeln (Excalidraw, MIT): Bundle nur auf der Tafelseite laden (`next/dynamic`), Szene als JSON im Gruppenordner (`file_nodes`, Datei „*.excalidraw“), gemeinsames Bearbeiten über denselben Kanal (Element-Updates), Export PNG/SVG clientseitig; CSP prüfen (`worker-src blob:` vorhanden, Schriften lokal einbetten – Excalidraw lädt Schriften sonst aus dem Netz → TD-04-Regel)
- [x] **P3-13** (S) E2E Gate 3b: zwei Browser bearbeiten denselben Text, Änderungen erscheinen beim anderen; Tafel speichern/öffnen; Lizenzprüfung grün; Lasttest 30 Personen gleichzeitig in Text/Tafel (`lasttest.yml -f szenario=gemeinsam`, docs/LASTTEST.md)
- [ ] **GATE 3b**

### Release v0.5.1 – Befunde aus der Testinstallation (Projektleitung 2026-10-15)
INST-09 und INST-10 (oben bei 4e) plus:
- [x] **Q5-28** (S) Stundenplan: Wechsel Klasse → Lehrkraft (bzw. Lehrkraft → Raum) zeigte weiter den alten Plan – das Formular schickte alle drei Felder, die Klasse hatte Vorrang. Jede Wahl leert jetzt die anderen Felder (`stundenplan/plan-picker.tsx`), E2E „Planwahl“
- [x] **Q5-29** (S) Prüfarten: Hinweis am Intervall, dass es ab der nächsten erfassten Prüfung gilt (offene behalten ihren Termin); Hinweis für die Hausmeisterei unter „Prüfung planen“, wo Intervalle gepflegt werden
- [x] **R-0.5.1** Release v0.5.1 (Notizen `release/notes/0.5.1.json`)

### Nach der Veröffentlichung (Projektleitung 2026-10-16)
- [x] **REPO-04** (S) Fehler melden: Issues an, nur per Formular (`.github/ISSUE_TEMPLATE/fehler.yml`, keine leeren Issues,
  Sicherheitslücken weiter vertraulich), Labels und privates Board (GitHub Project der Organisation); in SchulOS „Problem
  melden“ im Benutzermenü für Verwaltung/Admin – vorausgefülltes Formular mit Version und Bereich (Seitenpfad ohne IDs/Namen),
  nichts wird automatisch gesendet, kein Token/keine Mailadresse im Code; eigener Tracker per `SCHULOS_ISSUE_URL`

## Technische Schulden / Folgepunkte
- [x] **TD-01** Deutsche Sortierung in DB-Listen (Benutzer, Adressbuch, Gruppen): PGlite sortiert per C-Collation (ä hinter z). Entweder ICU-Collation prüfen oder Sortierschlüssel-Spalte (umlaut-normalisiert). In der Aufgaben-Matrix bereits per Intl.Collator gelöst.
- [x] **TD-02** Formulare verlieren nach einem Validierungsfehler die Eingaben (React 19 setzt Formulare nach einer Action zurück). In der Stundenplan-Pflege per `FormState.values` + `key` gelöst; Kalender-, Benutzer-, Gruppen- und News-Formulare prüfen und ggf. gleich lösen.
- [ ] **TD-03** Umstieg auf TypeScript 7 und eslint 10 (Dependabot-PR #1 am 2026-10-04 geschlossen: `typescript-eslint does not support TS 7.0`). Sobald typescript-eslint TS 7 unterstützt: beide anheben, Major-Ignore in `.github/dependabot.yml` entfernen, `npm run verify` + `npm run test:pg`. – Stand 2026-10-08: typescript-eslint 8.71 verlangt TypeScript < 6.1, unterstützt aber schon eslint 10 (eslint 10 könnte vorab allein kommen).
- [x] **TD-04** Schriften lokal mitliefern (`next/font/local` statt `next/font/google`): der Docker-Build lädt sie sonst von Google und scheitert ohne Netz (CI-Lauf B-27 einmal rot; Offline-Bundle/ISO in OPS-3/4 braucht das ohnehin).
