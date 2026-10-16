# SchulOS

Das Betriebssystem für die Schule: Verwaltung als Kern, Module als „Apps“. Eine quelloffene Schulplattform für
Kommunikation, Organisation und Unterricht – selbst betrieben auf einem Server der Schule, mit eigenem Backupserver.

> **Status: Vorschau (Versionen 0.x) – ohne Gewähr, ohne Support.**
> SchulOS ist als Lern- und Homelab-Projekt entstanden und bisher **an keiner Schule im Echtbetrieb**. Es wird ohne
> Gewährleistung und Haftung bereitgestellt (AGPL-3.0, §§ 15–16). Es gibt keinen Support, keine Hotline und keine
> zugesagten Reaktionszeiten; Issues und Diskussionen sind ausgeschaltet.
>
> **Verantwortlich für die Daten ist die Schule**, die SchulOS betreibt (Verantwortliche nach DSGVO). SchulOS liefert
> Vorgaben (z. B. Löschfristen, Voreinstellungen) und Vorlagen (Datenschutzhinweise, Verzeichnis der
> Verarbeitungstätigkeiten, Erklärung zur Barrierefreiheit), die die Schule prüft und anpasst. Vor dem Betrieb mit
> echten Daten die bzw. den Datenschutzbeauftragten der Schule einbinden.
>
> Der Installer verlangt vor der Plattenauswahl ein eingetipptes „VERSTANDEN“; in der Web-Oberfläche bestätigt ein
> Admin den Vorschau-Hinweis einmal (dauerhaft unter Verwaltung → System). Der Hinweis entfällt erst mit Version 1.0
> nach einem Pilotbetrieb.

> **Vorschau-Software (REPO-03):** ohne Gewähr und **ohne Support**. Verantwortlich für die Daten ist die Schule, die
> SchulOS betreibt. Vor einem Echteinsatz fehlen noch: ein externer Penetrationstest, die Klärung mit der bzw. dem
> Datenschutzbeauftragten der Schule und ein Pilotbetrieb. Der Installer verlangt dazu vor der Plattenauswahl ein
> eingetipptes „VERSTANDEN“; in der Web-Oberfläche bestätigt ein Admin den Hinweis einmal (dauerhaft unter Verwaltung →
> System). Der Hinweis entfällt mit Version 1.0 nach dem Pilot.

> **Freigabe:** derzeit nur für Schulen in **Nordrhein-Westfalen**. Rechtsgrundlagen, Datenschutzhinweise und VVT
> sind als Vorlage nur für NRW ausgearbeitet; andere Bundesländer sind wählbar (Ferien, Schulformen), werden aber als nicht
> ausgearbeitet markiert.

## Was vor einem Echteinsatz noch fehlt

Ehrlich aufgeschrieben – diese Punkte sind offen, bevor eine Schule SchulOS mit echten Daten betreiben sollte:

- **Externer Penetrationstest.** Alle bisherigen Sicherheitsprüfungen (Code-Reviews, Security-Reviews, OWASP-ZAP-Baseline,
  gitleaks, Trivy) sind automatisiert bzw. KI-gestützt. Ein Pentest durch Fachleute ist Pflicht vor einem Pilot mit
  Außenzugang (SEC-16, `docs/SICHERHEIT.md`).
- **Klärung mit Datenschutzbeauftragten.** Offene Fragen sind gesammelt in `docs/DSB-FRAGEN.md` – u. a. Krankmeldungen als
  Gesundheitsdaten (Art. 9 DSGVO), die Anlagen der VO-DV I im Wortlaut, Fristen der Schulanmeldung, Notenbuch auf
  Dienstgeräten. Die Rechtstexte sind Vorlagen, keine geprüften Zusagen.
- **Pilotbetrieb** an einer Schule über mindestens ein Halbjahr, mit Rückweg. Bisher gibt es nur die Demo-Schule und
  einen simulierten Lasttest (`docs/LASTTEST.md`, ~300 gleichzeitige Anmeldungen auf einer kleinen VM).
- **Startmenü der ISO unter Secure Boot (INST-08):** Mit eingelegtem Installationsmedium startet unter Secure Boot wieder
  der Installer statt der installierten Platte. Bis zur Behebung: Medium nach der Installation entfernen.
- **Barrierefreiheit:** automatische Prüfung (axe, Tastatur) für die Kernseiten; ein Durchgang mit Screenreader
  (NVDA/VoiceOver) und die restlichen Seiten fehlen (A11Y-01j). Die Erklärung zur Barrierefreiheit ist eine Vorlage.
- **Langzeitbetrieb:** Updates über mehrere Versionen, Schuljahreswechsel und Wiederherstellung sind automatisch getestet
  (QEMU, Update-Test N−1 → N), aber nicht über Jahre im echten Betrieb erprobt.
- **Namensprüfung** der Bezeichnung „SchulOS“ (Marken) ist nicht erfolgt.

Der vollständige Stand steht in `docs/BACKLOG.md` (offene Aufgaben) und `docs/PLAN.md` §0.

## Was SchulOS kann

- **Fundament:** Benutzer, Gruppen, Rollen und Rechte; Anmeldung mit Passwortregeln, Zwei-Faktor (TOTP, Sicherheitsschlüssel),
  Anmeldesperre; Module einzeln ein- und ausschaltbar; Audit-Log; Datenschutz-Werkzeuge (Löschfristen je Tabelle, Auskunft,
  Eigenexport, Schuljahreswechsel).
- **Kommunikation:** Heute-Seite, News, Messenger, Elternbriefe mit Rücklauf, Foren, Umfragen und Schnellumfragen, Gong
  (Benachrichtigungen, live per SSE), Mails über eine Warteschlange.
- **Organisation:** Stundenplan mit Unterrichtsverteilung, Solver, Räumen, Vertretungen und Aufsichten; Klassenbuch;
  Abwesenheiten und Krankmeldungen; Buchungen; Klausurplan; Kalender; Elternsprechtag; Kurswahl; Schulanmeldung;
  Gebäude & Technik; Statusmonitore für Foyer und Lehrerzimmer.
- **Unterricht:** Aufgaben, Dateien, Kursraum, Pinnwände, gemeinsame Texte und Tafeln, Sitzplan, Notenbuch (auch offline
  auf Dienstgeräten).
- **Betrieb:** eine ISO für Hauptsystem und Backupserver (Debian 13, verschlüsselte Platten mit TPM2, Spiegel), Backups mit
  restic (append-only, Offsite-Kopie, Test-Restore), signierte Releases mit automatischen Patch-Updates, `schulosctl` für
  den Server, Vorschau-Instanz und Probelauf vor Updates, Außenzugang wahlweise mit Gerätezertifikaten.

Bewusst **nicht** enthalten: die Netzwerk- und Geräteseite klassischer Schulserver (Firewall, MDM, Druckserver,
Netzlaufwerke, WLAN-Verwaltung) sowie Verlags- und Behörden-Integrationen (`docs/PLAN.md` §1).

## Installation

Für einen Testserver: Release-ISO herunterladen, **prüfen** und installieren – Schritt für Schritt in
[`docs/INSTALLATION.md`](docs/INSTALLATION.md), Abschnitt „ISO herunterladen und prüfen“. Es gibt zwei Rollen
(Hauptsystem und Backupserver) und zwei Arten (Demo mit Beispielschule oder leere Produktivinstanz). Ohne ISO läuft
derselbe Stack mit Docker Compose (`compose.yaml`, `compose.backup.yaml`).

Releases, Signaturen und Prüfung von Hand: [`release/README.md`](release/README.md).

## Entwicklung

Voraussetzungen: Node.js 24 (`.nvmrc`), npm. Für die Entwicklung ist weder Docker noch ein Datenbankserver nötig – die
App nutzt lokal PGlite (PostgreSQL als WASM, Daten unter `.data/`).

```bash
npm ci
npm run db:reset   # lokale Datenbank mit der Demo-Schule „Gesamtschule am Lindenhof“
npm run dev        # http://localhost:3000
```

Demo-Logins (Passwort überall `schulos`): `admin`, `sabine.kowalski` (Sekretariat), `petra.lindner` (Schulleitung),
`jana.brandt` (Lehrkraft), `lea.schaefer` (Schülerin). Alle Personen der Demo-Schule sind erfunden.

| Befehl | Zweck |
|---|---|
| `npm run check` | TypeScript, ESLint, Lizenzprüfung, Vitest (alle Workspaces) |
| `npm run build` | Produktions-Build (Next.js mit Webpack) von SchulOS und Backupserver |
| `npm run e2e` | Playwright gegen eine frisch geseedete Datenbank (vorher `npm run build`) |
| `npm run verify` | alles zusammen |
| `npm run veroeffentlichen:pruefen` | Prüfung auf Geheimnisse, interne Adressen und Namen (`docs/VEROEFFENTLICHUNG.md`) |

Stack: Next.js 16 (Webpack) · TypeScript · Drizzle · PGlite/PostgreSQL 18 · Tailwind · Radix · Docker Compose · Debian 13.
Aufbau (modularer Monolith, Module mit Manifest): [`docs/PLAN.md`](docs/PLAN.md) §3.

## Entwicklung mit Claude

Der größte Teil von SchulOS – Code, Tests, Doku – ist mit **Claude** (Anthropic) entstanden, über Claude Code als
Programmier-Agent. Das Projekt ist auch ein Versuch, wie weit man damit eine ernsthafte Anwendung bauen kann.

So ist die Arbeit organisiert:

- Ein Mensch (die Projektleitung) gibt Ziele vor, beantwortet Fragen und entscheidet; die Entscheidungen stehen mit
  Datum bei den Aufgaben in `docs/BACKLOG.md`. Arbeitsanweisungen, Arbeitsprotokoll und Fragenkatalog der Agenten
  bleiben intern und sind nicht Teil dieses Repositorys.
- Die Agenten arbeiten nach festen Regeln: Aufgaben aus `docs/BACKLOG.md`, jede Änderung als Pull Request, Commit nur
  bei grüner Prüfung, Merge nur nach grüner CI.
- Am Ende jedes Blocks steht ein **Gate**: ein Review-PR mit Code- und Security-Review (ebenfalls KI-gestützt), den nur
  die Projektleitung abnimmt und merged.
- Abgesichert wird über Tests (rund 1 900 Unit-/Integrationstests, über 250 E2E-Tests, Stack-, Update- und QEMU-Tests der
  ISO) statt über eine Zeile-für-Zeile-Durchsicht durch Menschen.

Was das bedeutet: Nicht jede Zeile wurde von einem Menschen gelesen. Gerade deshalb sind ein externer Pentest und ein
begleiteter Pilot Voraussetzung für einen Echteinsatz (oben).

## Mitwirken und Sicherheit

- Beiträge: [`CONTRIBUTING.md`](CONTRIBUTING.md) – Pull Requests aus Forks nur nach Freigabe.
- Sicherheitslücken: **vertraulich** über GitHub Security Advisories, siehe [`SECURITY.md`](SECURITY.md).

## Dokumentation

| Datei | Inhalt |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Ziel, Architektur, Phasen, aktueller Stand (§0) |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Aufgaben, erledigt und offen |
| [`docs/INSTALLATION.md`](docs/INSTALLATION.md) | ISO, Installer, Backupserver, Updates, Außenzugang |
| [`docs/SICHERHEIT.md`](docs/SICHERHEIT.md) | Bedrohungsmodell und Schutzmaßnahmen |
| [`docs/DATENSCHUTZ.md`](docs/DATENSCHUTZ.md) | Datenschutzkonzept, Löschfristen, TOM |
| [`docs/UI-KONZEPT.md`](docs/UI-KONZEPT.md) | Gestaltung der Oberfläche |

## Lizenz

Copyright © 2026 SchulOS-Mitwirkende. SchulOS ist freie Software unter der **GNU Affero General Public License,
Version 3 oder später** ([`LICENSE`](LICENSE), Hinweise in [`NOTICE`](NOTICE)). Wer eine veränderte Fassung als Netzdienst
betreibt, muss den Nutzenden den Quellcode dieser Fassung anbieten (AGPL § 13).

SchulOS ist eigenständig entwickelt und steht in keiner Verbindung zu Anbietern anderer Schulplattformen.
