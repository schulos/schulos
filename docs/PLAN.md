# SchulOS – Projektplan

> **SchulOS** – das Betriebssystem für die Schule. Verwaltung als Kern, Module als „Apps".
> Lern- und Homelab-Projekt: eine quelloffene Schulplattform. Stand: 2026-10-03.

---

## 0. Aktueller Stand (2026-10-19) – hier einsteigen

| | |
|---|---|
| **Phase** | Phase 0–5a ✅ (alle Gates bis einschließlich GATE 4e abgenommen) · **Releases v0.5.0 (2026-10-15) … v0.5.3 (2026-10-16, erstes Release im öffentlichen Repo), v0.5.4 (2026-10-17: „Problem melden“, Komponenten aktualisiert) und v0.5.5 (2026-10-19: Konferenzlink, Konsole/Bootmenü-Passwort, ISO automatisch am Release)** · Repo am 2026-10-16 öffentlich geschaltet (REPO-01/02 ✅, SEC-10 damit wirksam) |
| **Nächster Schritt** | Neue Ideen laufen über das private Ideen-Board; Freigegebenes landet in BACKLOG „Verbesserungen aus dem Ideen-Board“ (V-01 Konferenzlink ✅, V-02 ISO nach Release). Dependabot-PRs ohne Major-Sprung merged GitHub selbst (CI-02). INST-08 (Startmenü der ISO unter Secure Boot) ✅ 2026-10-19, erster QEMU-Lauf mit Secure-Boot-Backupserver steht noch aus (nächster ISO-Lauf auf `main`). Sonst offen: P4-40c (Gerätezertifikate über ein MDM, braucht echte Geräte), TD-03 (TypeScript 7 / eslint 10, wartet auf typescript-eslint); bewusst zuletzt B-50b (Lasttest auf Zielhardware) und B-52 (mehrere App-Instanzen, nur bei Bedarf); vor einem Pilot B-05 (Art. 9), Fragen gesammelt in `docs/DSB-FRAGEN.md` |
| **Repo** | öffentlich auf GitHub `schulos/schulos` (Organisation, frisches Repo seit 2026-10-16 – die Historie davor blieb privat, das frühere Repo ist archiviert), Branch `main` (= `origin/main`); jede Änderung über PR, gemerged nur mit `scripts/pr-merge.sh` (CI-01), Rulesets mit Pflicht-Checks auf `main` und Tags `v*`. Fehler melden per Issue-Formular (REPO-04). `SCHULOS_RUNNER=oeffentlich`: PRs und Release auf GitHub-Runnern, Push auf `main`, Zeitpläne, ISO/QEMU und Lasttest auf der Build-VM (Org-Runner schwer/leicht) |
| **Tests** | auf `main` (CI 2026-10-16): 2025 Vitest (PGlite **und** PostgreSQL 18) + 262 Playwright (1 übersprungen) + 4 Backupserver, dazu Stack-Tests Backup und Update sowie ISO/QEMU §7 – alle grün |
| **Betrieb** | Dockerfile (Node 24, standalone), `compose.yaml` (Caddy + App + Postgres 18), ISO/qcow2 (Release-ISO aus signierten Images); Release v0.5.4 signiert, mit SBOMs, ISO + signierter Prüfsumme als Anhang (ohne Token abrufbar) |
| **Module** | **Notenbuch** (Block 5a: Teilnoten, Halbjahresabschluss, Übergabeliste/CSV, Offline auf Dienstgeräten), **Sitzplan**, Heute, Messenger, News, Elternbriefe, **Foren**, **Umfragen** (inkl. Schnellumfrage), **Kursraum**, Aufgaben, **Pinnwände**, **Texte** (gemeinsam, Tiptap + Yjs über POST + SSE), **Tafeln** (Excalidraw, Datei im Gruppenordner, Element-Abgleich über POST + SSE), Stundenplan (Pflege, Unterrichtsverteilung, Diagnose, Solver, Räume, Vertretungen, Aufsichten, Druck), Klassenbuch, Abwesenheiten, Buchungen, Klausurplan, Kalender, Dateien, Adressbuch, Monitore (auch mit Pinnwand), Verwaltung (inkl. Datenschutz, Schuljahreswechsel, System) |
| **Live-Kanal** | ein SSE-Strom je Tab (`/api/gong/stream`): Gong, Chat, Schnellumfrage (`poll`), Pinnwand (`board`), Text (`text`: Yjs-Update nur an Anwesende der Gruppe), Tafel (`tafel`: geänderte Elemente nur an Anwesende der Gruppe) |
| **Migrationen** | `drizzle/0000_init` … `0086_kurse_konferenzlink` (darunter 0078 2FA-Pflicht/Stichtag, 0079 Code-Listen, 0080 `sessions.last_active_at`; Zweig `q5-4e-r2`: 0081 `passkeys`, 0082 `kurswahl_verfahren.auto_reminded_on`, 0083 Kurswahl-Mehrfachwahl, 0084 Selbstmeldung + `timetable_absence_materials`; 0048 `mail_outbox`, 0049 `rate_limits`, 0050 Schulanmeldung, 0051 Elternkonto am Antrag, 0052 Schritt „Neuaufnahmen“, 0053 `device_certs`, 0054 Rolle `beratung`, 0055 `notifications.bundle_key`, 0056 `school_year_transitions.admitted_users`, 0057 `anmeldung_antraege.parent2_email`, 0058 `classbook_entries.homework_due`, 0059 `timetable_time_pref_submissions`, 0060 `timetable_substitution_days`, 0061 `absence_leave_requests`, 0062 `calendar_feed_tokens`, 0063 `timetable_time_prefs.source`, 0064 `texte_docs`, 0065 `users.self_responsible`, 0066 `anmeldung_antraege.rejected_as_spam`, 0067 Elternsprechtag, 0068 Monitor-Profil `sprechtag`, 0069 Kurswahlen, 0070 Spam-Verdacht, 0071 Sitzplan, 0072 Abwesenheiten-Archiv, 0073 Notenbuch, 0074 Notenbuch-Sitzung, 0075 Notenbuch-Hinweis, 0076 Notenbuch offline) |
| **Offene Schuld** | TD-03 TypeScript 7 / eslint 10 (wartet auf typescript-eslint) |

Wiedereinstieg mit leerem Kontext: `CLAUDE.md` (Arbeitsregeln + Werkzeuge) → dieser Plan →
`docs/BACKLOG.md` (erste offene Aufgabe) → `docs/LOG.md` (was zuletzt passiert ist).

---

## 1. Ziel & Rahmen

| Entscheidung | Wert | Begründung |
|---|---|---|
| Zweck | Lern-/Homelab-Projekt mit Demo-Schule + Seed-Daten | Fokus auf Features & UI; Produktivbetrieb als Track B vorbereitet (`DATENSCHUTZ.md`) |
| Betrieb | **vorerst nur lokal** (Windows-Dev-Rechner) | Homelab-Deployment später, siehe §6 |
| Stack | Next.js 16 (App Router, **Webpack**) + TypeScript + Drizzle + PostgreSQL | bewährter Stack, ein Deployable |
| Lokale DB | **PGlite** (Postgres als WASM, Datei unter `.data/`) | weder Docker noch Postgres-Installation nötig, gleiches Schema wie später echtes Postgres |
| Produktiv-DB | **PostgreSQL 18** im Container | quelloffen (PostgreSQL License); Umschalten über `DATABASE_URL` |
| Lizenz | ganzer Stack quelloffen; SchulOS selbst später **AGPL-3.0** | Repo bleibt privat, bis das Projekt Form hat |
| Sprache | UI deutsch, Code/Identifier englisch | durchgängig |

**Nicht-Ziele:** Die Netzwerk- und Geräteseite klassischer Schulserver (Firewall, MDM, BYOD, Druckserver,
Netzlaufwerke, WLAN-Gästeverwaltung) baut SchulOS nicht nach. Dafür braucht es echte
Schul-Infrastruktur; eine Web-App kann das nicht sinnvoll abbilden. Ebenfalls draußen bleiben
Verlags- und Behörden-Integrationen (Westermann, Brockhaus, BILDUNGSLOGIN, moin.schule).

---

## 2. Funktionsumfang von Schulplattformen

- Schulplattformen in Deutschland bündeln Kommunikation, Organisation und Unterricht in einer Weboberfläche; Betrieb
  wahlweise gehostet, als Server in der Schule oder beim Schulträger.
- Das Fundament sind **Accounts, Gruppen und Rechte**: Fast jedes Modul hängt daran („wer darf was in welcher Gruppe").
- **Namensgebung:** SchulOS ist eigenständig entwickelt (eigener Code, eigenes Design, eigene Texte). Andere Produkte
  werden in Repo, Oberfläche und Werbung nicht namentlich genannt – Produktnamen sind Marken; Funktionen und
  allgemeine Begriffe („Aufgaben", „Gruppenordner") sind frei. Keine fremden Screenshots, Icons oder Hilfetexte als Vorlage.

### Modullandkarte (übliche Bereiche → SchulOS-Priorität)

| Bereich | übliche Module | SchulOS-Phase |
|---|---|---|
| **Fundament** | Benutzer-/Gruppen-/Rechteverwaltung, Adressbuch, Startseite | **P0/P1** |
| Kommunikation | News (schwarzes Brett), Messenger, E-Mail, Foren, Elternbriefe, Verteilerlisten, Videokonferenz | News + Messenger **P1** · Elternbriefe **P2** · Foren **P3** · E-Mail/Video **P4** |
| Organisation | Kalender, Stunden-/Vertretungsplan, Klassenbuch, Abwesenheiten, Buchungen, Klausurplan, Pläne | Kalender **P1** · Rest **P2** |
| Unterricht | Aufgaben, Dateien, Kurse, Texte, Tafeln, Umfragen, Schnellumfragen, Pinnwände, Office, Curriculum | Aufgaben + Dateien **P1** · Kurse/Umfragen/Pinnwände **P3** · Texte/Tafeln **P3+** |
| Verwaltung | Elternsprechtage, Kurswahlen, Klassengeld, Ganztag, Störungsmeldung, Infobildschirm, Knowledge-Base, To-do, Listen | **P4** (Backlog, nach Lust) |
| Infrastruktur | Gerätesteuerung, MDM, BYOD, Drucken, Netzlaufwerke | ✗ Nicht-Ziel |

---

## 3. Architektur

### 3.1 Modularer Monolith

Eine einzige Next.js-App. Jedes Modul ist ein abgeschlossener Ordner mit einem **Manifest**.
So bleibt der Plugin-Charakter erhalten, ohne die Komplexität verteilter Dienste.

```
schulos/
├─ src/
│  ├─ app/                    # Next.js-Routen
│  │  ├─ (auth)/login
│  │  └─ (shell)/             # App-Shell (Sidebar, Topbar, Palette)
│  │     ├─ page.tsx          # „Heute"
│  │     ├─ news/ kalender/ aufgaben/ dateien/ messenger/ …
│  │     └─ verwaltung/       # Admin: Benutzer, Gruppen, Rechte, Stammdaten
│  ├─ core/                   # Fundament, von allen Modulen genutzt
│  │  ├─ db/                  # Drizzle-Client (PGlite | Postgres), Core-Schema
│  │  ├─ auth/                # Better-Auth, Session, Rollen
│  │  ├─ permissions/         # Rechte-Engine: can(user, "aufgaben.create", group?)
│  │  ├─ modules/             # Registry: Manifeste einsammeln, Navigation, Widgets
│  │  ├─ notifications/       # „Gong": In-App-Benachrichtigungen + SSE
│  │  ├─ files/               # Speicher-Abstraktion (lokales FS → später Volume/S3)
│  │  ├─ audit/               # Audit-Log
│  │  └─ search/              # globale Suche (Postgres-Volltext)
│  ├─ modules/<id>/
│  │  ├─ manifest.ts          # id, Name, Icon, Navigation, Rechte, Widgets, Gruppen-Features
│  │  ├─ schema.ts            # eigene Tabellen (Präfix <id>_)
│  │  ├─ service.ts           # Geschäftslogik (rein, testbar)
│  │  ├─ actions.ts           # Server Actions (prüfen Rechte, rufen service)
│  │  └─ components/
│  └─ ui/                     # Design-System (shadcn/ui-basiert)
├─ drizzle/                   # Migrationen
├─ scripts/seed.ts            # Demo-Schule „Gesamtschule am Lindenhof"
└─ docs/                      # PLAN, BACKLOG, LOG, QUESTIONS, UI-KONZEPT
```

**Modul-Manifest** (Kernidee):

```ts
export default defineModule({
  id: "aufgaben",
  name: "Aufgaben",
  icon: "ClipboardCheck",
  phase: 1,
  permissions: {
    "aufgaben.create": "Aufgaben stellen",
    "aufgaben.view_all": "Alle Aufgaben sehen",
  },
  defaultGrants: { lehrkraft: ["aufgaben.create"] },
  groupFeatures: [],                  // z. B. Kalender: "Gruppenkalender"
  nav: [{ href: "/aufgaben", label: "Aufgaben" }],
  widgets: [{ id: "faellig", component: () => import("./widgets/faellig"), roles: ["schueler"] }],
  search: searchAufgaben,             // optionaler Beitrag zur globalen Suche
});
```

Module lassen sich in der Verwaltung **an- und abschalten**. Jede Schule nutzt nur, was sie braucht.

### 3.2 Fundament-Datenmodell (Kern)

| Tabelle | Inhalt |
|---|---|
| `users` | Konto, Name, Kürzel (Lehrkräfte), Rolle(n), Status, Avatar |
| `roles` | `schueler`, `lehrkraft`, `eltern`, `verwaltung`, `admin` (fest) |
| `parent_child` | Eltern ↔ Kinder |
| `groups` | Typ: `klasse` · `kurs` · `ag` · `fachschaft` · `gremium` · `frei`; Eigentümer, Schuljahr |
| `group_members` | Mitglied/Leitung |
| `grants` | Recht → Rolle **oder** Gruppe (Prinzip „Rechte über Gruppen") |
| `group_features` | aktivierte Gruppenmerkmale (Gruppenordner, Gruppenkalender, Chatraum …) |
| `modules_enabled` | Modul an/aus |
| Stammdaten | `school_years`, `terms`, `subjects` (mit **Fachfarbe**), `rooms`, `periods` (Zeitraster) |
| `notifications`, `audit_log` | Querschnitt |

**Rechte-Engine:** `can(user, permission, ctx?)` wertet Rolle → Gruppen → Gruppenleitung aus.
Ein einziger Einstiegspunkt, voll unit-getestet. Jede Server Action ruft ihn auf.

### 3.3 Technische Bausteine

| Thema | Wahl | Bemerkung |
|---|---|---|
| Framework | Next.js 16, App Router, Server Actions | `next dev --webpack` / `next build --webpack`, weil Turbopack/natives SWC hier per Richtlinie blockiert ist (Build mit Webpack ist verifiziert) |
| DB | Drizzle ORM · PGlite lokal · Postgres 18 im Homelab | `DATABASE_URL` entscheidet über den Treiber |
| Auth | Better-Auth (Benutzername + Passwort) | dazu im Dev-Modus ein **Demo-Schnell-Login** „Ansicht als …" |
| UI | Tailwind v4 + shadcn/ui + lucide-icons + `cmdk` (Palette) | |
| Echtzeit | Server-Sent Events + In-Process-Eventbus | für Messenger und Gong; später Postgres LISTEN/NOTIFY |
| Dateien | lokales Dateisystem unter `.data/files` | später Volume |
| Kollaboration (P3+) | Tiptap + Yjs (Texte), tldraw/Excalidraw (Tafeln) | |
| Tests | Vitest (Unit + Integration gegen In-Memory-PGlite) · Playwright (E2E-Smoke) | Integrationstests ohne jede Infrastruktur |

---

## 4. Roadmap

Jede Phase endet mit einem **Gate**: kurzer Review mit der Projektleitung (Live-Demo und Screenshots) und
danach die Q&A-Runde für die nächste Phase. Die einzelnen Aufgaben stehen in
[`BACKLOG.md`](BACKLOG.md).

### Phase 0 – Fundament ✅ (Gate 0 abgenommen 2026-10-03)
Projektgerüst, DB-Schicht (PGlite), Auth, App-Shell mit Sidebar, Topbar und Strg+K-Palette,
Modul-Registry, Rechte-Engine, Seed der Demo-Schule (≈ 1 Schulleitung, 25 Lehrkräfte,
300 Schüler:innen in 12 Klassen, Eltern, Fächer, Räume, Zeitraster), Design-System mit
Hell/Dunkel. **Gate 0:** einloggen als jede Rolle, leere „Heute"-Seite, Verwaltung erreichbar.

### Phase 1 – Kern-Module (MVP) ✅ (fertig 2026-10-03, Gate-1-Review offen)
Zusätzlich entstanden: **Adressbuch** mit zentralen Sichtbarkeitsregeln (wer wen sieht) und
**globale Suche** über Suchanbieter je Modul; ein gemeinsamer Live-Kanal (SSE) für Gong und Chat.

1. **Verwaltung**: Benutzer, Gruppen, Rechte, Module an/aus, CSV-Import für Schüler:innen
2. **Heute** (Dashboard): rollenabhängige Widgets
3. **News**: schwarzes Brett mit Zielgruppen und Anheften
4. **Kalender**: persönlicher, Gruppen- und Schulkalender, ICS-Export
5. **Dateien**: eigene Dateien plus Gruppenordner, Upload, Vorschau
6. **Aufgaben**: stellen → abgeben → Feedback/Bewertung, Fristen, Status je Schüler:in
7. **Messenger**: Direkt- und Gruppenchats in Echtzeit, Lesestatus

**Gate 1:** Eine Lehrkraft stellt einer Klasse eine Aufgabe, ein Schüler gibt ab, die
Lehrkraft gibt Feedback, und der Gong meldet jeden Schritt.

### Phase 2 – Schulorganisation ✅ (fertig 2026-10-03, Gate-2-Review offen)
Vorgeschlagene Reihenfolge (in `BACKLOG.md` als P2-01 … P2-13 zerlegt, beim Gate-1-Review
bestätigen): Stundenplan → Vertretung + **Tagesleiste** auf „Heute“ → Klassenbuch →
Abwesenheiten → Elternbriefe → Buchungen → Klausurplan.

Stundenplan + **Vertretungsplan** (manuell gepflegt – entschieden, kein Import aus fremder Stundenplan-Software), **Klassenbuch**
(Stundeninhalte, Fehlzeiten), **Abwesenheiten** (Eltern melden digital, die Klassenleitung
bestätigt), **Elternbriefe** mit Lesebestätigung und Rückmeldefeldern, **Buchungen**
(Räume/Geräte), **Klausurplan** mit Kollisionsprüfung.

### Phase 3 – Unterricht & Zusammenarbeit ✅ (Gate 3 abgenommen 2026-10-10, Release v0.2.0)
Kurse (bündeln Aufgaben, Termine, Dateien und Chat je Kurs), Umfragen + Schnellumfragen
(anonym), Foren, Pinnwände, Texte (kollaborativ), Tafeln. Gebaut: Kursraum, Umfragen/Schnellumfrage, Foren, Pinnwände; Texte/Tafeln als 3b nach 4c.

### Phase 2b – Stunden- und Raumplanung, Statusmonitor, Schulformen ✅ (Gate 2b abgenommen 2026-10-04)
Planung wie in verbreiteter Stundenplan-Software (Unterrichtsverteilung, Deputate, Kopplungen, Setzhilfe, Diagnose, **Solver**), Raumplanung
(Raumsuche, Belegung, Sperrungen, Vorschläge), Vertretung Pro (Abwesenheiten, Vorschläge, Pausenaufsichten,
Statistik), **Statusmonitor**, Schulprofil für alle weiterführenden Schulformen und 16 Länder. Details: [`STUNDENPLAN.md`](STUNDENPLAN.md).

### Track B – Betriebsreife (läuft seit 2026-10-04)
Weg vom Demo- zum Produktivbetrieb in Stufen (Demo → Pilot → Schulbetrieb). Datenschutz-Kern
(Aufbewahrung im Manifest, Löschlauf, Auskunft, VVT-Generator, Schuljahreswechsel), Härtung
(2FA, Rate-Limit, CSP) und Installation als **ISO-Komplettpaket** (Debian 13 + Compose-Stack;
ein Installer mit den Rollen Hauptsystem und Backupserver, Demo- oder leere Produktivinstanz;
Backupserver mit eigener Web-UI, append-only, Test-Restore; Updates mit Rollback). Details: [`DATENSCHUTZ.md`](DATENSCHUTZ.md),
[`INSTALLATION.md`](INSTALLATION.md).

**Risiko und Pflicht vor einem Pilot (SEC-16, REPO-03):** SchulOS ist Vorschau-Software ohne Gewähr und ohne Support (Hinweis im
Installer und in der Web-Oberfläche). Vor einem Pilot mit echten Daten **und** Außenzugang ist ein **externer Penetrationstest
Pflicht** – Prüfumfang: Außenzugang (Caddy-Zonen, Allowlist, IPv6, gefälschte Kennzeichen), Gerätezertifikate (Schul-CA,
Sperrliste, mTLS), Anmeldung (2FA, Sperren, Sitzungen, Passwort-Reset) und Backup-Pfad (Kopplung, Agent-API, Wiederherstellung,
Offsite/unveränderliche Kopie). Befunde werden als SEC-Folgeaufgaben im Backlog geführt und vor dem Pilot geschlossen. Ebenso
vor dem Pilot: Klärung mit der bzw. dem Datenschutzbeauftragten (B-05, [`DSB-FRAGEN.md`](DSB-FRAGEN.md)). Checkliste für den
Schulträger: INSTALLATION.md §5b Punkt 10.

### Phase 4 – Erweiterungen (zerlegt 2026-10-10, Details `docs/PHASE4.md`)
- **4a Erscheinungsbild:** Schullogo, Dunkel-Variante, Symbol/Favicon, gemeinsamer Druckkopf, Monitor
- **4b Gebäude & Technik:** Mängel-/Störungs-/IT-Meldungen mit Fotos, Raumsperre aus der Meldung, Anlagen mit Prüffristen
  (u. a. DGUV V3, Feuerlöscher, Spielgeräte), Wartungstermine; neue Rolle `personal` – die frühere Idee „Störungsmeldung“ geht darin auf
- **4c Schulanmeldung:** öffentliches Formular mit E-Mail-Bestätigung und Terminwahl, Bearbeitung im Sekretariat, Übernahme beim
  Schuljahreswechsel, Außenzugang nur für öffentliche Seiten → Release v0.3.0
- **4f Feinschliff** (Rollen-Durchgang: Hausaufgaben, Eltern-Info bei Vertretung, „Offen für dich“, Beurlaubung, Rolle `beratung` u. a.,
  `docs/FEINSCHLIFF.md`) nach 4c, kleines Gate
- **3b Texte/Tafeln** danach, dann **4d Elternsprechtag + Kurswahlen** → v0.4.0
- **4e Betriebsreife:** 2FA-Pflicht für alle (Schüler:innen nur von außerhalb, Code-Liste, Passkeys), Passwort-Reset per Mail,
  Sitzungen, Virenscan, Barrierefreiheit, installierbare App ohne Push → v0.5.0
- Erledigt: Infobildschirm (Statusmonitore, P2b-07). **Nicht geplant:** Klassengeld, To-do, Wissensdatenbank, internes Postfach,
  Videokonferenz-Einbettung, Push ohne Votum der/des DSB.

---

## 5. Loop-Coding-Strategie

Ziel: so viel wie möglich autonom in Schleifen bauen. Projektleitung wird nur an echten
Entscheidungspunkten gebraucht.

**Wahrheitsquelle:** `docs/BACKLOG.md`. Jede Aufgabe hat eine ID (`P1-06`), Akzeptanzkriterien,
Abhängigkeiten und eine Größe (S/M). Keine Aufgabe ist größer als ein Commit.

**Ein Schleifendurchlauf** (Protokoll steht in `CLAUDE.md`):
1. Die erste offene Aufgabe der aktuellen Phase nehmen, deren Abhängigkeiten erledigt sind.
2. Umsetzen, mit Tests für die Service-Logik.
3. `npm run check` ausführen (tsc + eslint + vitest), bei UI-Aufgaben zusätzlich
   `npm run build` und einen Playwright-Smoke-Test mit Screenshot.
4. Lokal committen (`P1-06: …`), die Aufgabe abhaken und eine Zeile in `docs/LOG.md` ergänzen.
5. Weiter mit der nächsten Aufgabe.

**Die Schleife hält an,** wenn:
- eine Phase fertig ist → Gate-Review mit der Projektleitung,
- eine Aufgabe eine Entscheidung braucht → Eintrag in `docs/QUESTIONS.md`, Aufgabe als ❓
  markieren und mit der nächsten unabhängigen Aufgabe weitermachen,
- zwei Anläufe an derselben Aufgabe gescheitert sind → als 🧱 markieren und melden.

Gestartet wird mit `/loop` ohne Intervall (selbstgetaktet). Zwischenstände kommen konkret
(welche IDs erledigt sind, wie viele Tests grün sind).

---

## 6. Betrieb: lokal vs. Proxmox

**Jetzt:** nur lokal. `npm run dev` braucht weder Docker noch Datenbankserver.

**Homelab-Server (Mini-PC mit Proxmox) als späteres Ziel (geprüft am 2026-10-03):**

**Einschätzung:** Ein kleiner Homelab-Server reicht für SchulOS dicke. Der Grundbedarf liegt bei ≈ 1 GB RAM
(Next.js ~400 MB + Postgres ~200 MB + Puffer). **Empfehlung für später:** als weiterer
Compose-Stack auf einer bestehenden Docker-VM, keine neue VM. Schwergewichte wie Jitsi und
Collabora/OnlyOffice (P4) bräuchten jeweils 2–4 GB; das wäre dann neu zu bewerten.
Messwerte unter Last: `docs/LASTTEST.md`.

⚠️ Vor jedem Homelab-Deployment muss die Sicherung stehen (Backupserver, §5a). Neue Daten nicht auf eine ungesicherte
Platte legen.

---

## 7. Offene Entscheidungen (nächste Q&A-Runden)

- [x] UI-Richtung → A „Klar" + Dark-Mode
- [x] Demo-Schule → Gesamtschule NRW, 5–10 + EF/Q1/Q2
- [x] GitHub → zuerst privat, seit Oktober 2026 öffentlich `schulos/schulos` (AGPL-3.0-or-later)
- [x] Phase 2: Stundenplan wird von Hand gepflegt (kein Import aus fremder Stundenplan-Software)
- [x] Gate 0: UI passt, Phase 1 in geplanter Reihenfolge (2026-10-03)
- [x] Gate 1: Phase 1 abgenommen, Phase 2 wie vorgeschlagen (2026-10-03)
- [x] P2-00 Datenschutz-Grundlage vor Phase 2 · Track B nach Gate 2 · Debian 13 + Compose + PostgreSQL 18 ·
      quelloffen, Repo privat bis es Form hat, dann AGPL-3.0 · ISO mit Rollen Hauptsystem/Backupserver (2026-10-03)
- [x] Gate 2b: Phase 2b abgenommen, weiter mit Track B (2026-10-04)
- [x] Track B: Pilot/Betreiber → keiner, bleibt Lern-/Homelab-Projekt; AV-Vertrag/DSB erst bei konkretem Pilot (2026-10-04)
- [x] Track B: Update-Konzept (INSTALLATION.md §5a) bestätigt · GitHub Actions + Dependabot freigegeben (2026-10-04)
- [x] Gate 3 abgenommen, Fahrplan Phase 4 freigegeben (2026-10-10); Einzelentscheidungen in `docs/QUESTIONS.md`
- [ ] Offen: SEC-08…10 und B-05 (Art. 9, `docs/DSB-FRAGEN.md`) – siehe `docs/QUESTIONS.md` „Offen“
- [ ] TD-01: Deutsche Sortierung – ICU-Collation in PGlite prüfen oder Sortierschlüssel-Spalte?

## 8. Gelernte Arbeitsregeln (aus Phase 0/1)

- **Commit nur nach `npm run verify` mit echtem Exit-Code 0.** Nie anhand gegrepter Ausgabe
  entscheiden – `cmd | grep` maskiert Fehlschläge (so ist einmal ein roter Stand gepusht worden).
- Postgres sortiert **Enums nach Deklarationsreihenfolge**, nicht alphabetisch (zweimal reingefallen).
- `instanceof` über Server-Action-Grenzen ist unzuverlässig (Bundle-Schichten) → strukturell prüfen;
  prozessweite Singletons (DB, Event-Bus, Speicher) über `globalThis`.
- E2E: Labels/Namen mit `{ exact: true }` (Teiltreffer wie „Art“ in „Startseite“); Next.js hat einen
  unsichtbaren Routen-Ansager mit `role=alert` → Alerts im `form` suchen; erst nach Navigation agieren.
- `browser.newContext()` erbt im Mobil-Projekt die Pixel-7-Emulation (`isMobile`) – Chrome zoomt dann
  Überlauf weg. Überlauf-Tests mit `isMobile: false` auf 360 px.
- Neue Prüfungen gegen den Fehler gegentesten (Fix kurz zurücknehmen → Test muss rot werden).
- Neue Module: Manifest in `src/modules/index.ts`, Schema in `src/core/db/schema.ts` exportieren
  (relative Imports!), `npm run db:generate`, Seed-Funktion in `seedDemoSchool`, Widgets in
  `src/modules/widgets.ts`, Suche in `src/modules/search.ts`. Default-Rechte neuer Module legt
  `ensureModuleDefaults` beim Serverstart auch in bestehenden DBs an.
- Neue Tabellen: im Manifest `retention` deklarieren (Löschklasse + Startspalte oder `follows`);
  der Test `src/core/retention.test.ts` prüft das gegen das echte Schema.

## Quellen

- Öffentlich zugängliche Funktionsbeschreibungen gängiger Schulplattformen (Stand 2026-10-03)
