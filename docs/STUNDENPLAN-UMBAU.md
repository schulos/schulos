# SchulOS – Umbau der Stundenplanung: eigener Bereich, Funktionsrolle, Solver-Läufe

> Stand: 2026-10-19 · Status: **Plan, zur Umsetzung freigegeben durch den Auftrag der Projektleitung** („Bereich Stundenpläne
> managen komplett überarbeiten, eigene Rolle für die Stundenplaner, aus der Verwaltung herauslösen, selbstständig planen und
> umsetzen; neue Funktionen nur die Solver-Läufe“). Aufgaben: `BACKLOG.md` SP-01 … SP-11. Entscheidungen: `QUESTIONS.md` Q-SP-1 … Q-SP-12.
> Grundlage: `STUNDENPLAN.md` (Konzept Phase 2b), `FEINSCHLIFF.md` §7 (Stundenplaner:in), Code unter `src/modules/stundenplan/`.
> `QUESTIONS.md`, `FEINSCHLIFF.md` und `LOG.md` sind Arbeitsdokumente und nicht im Repo veröffentlicht (VEROEFFENTLICHUNG.md); alle
> Entscheidungen stehen deshalb auch hier in §2 und §3.

---

## 1. Ist-Analyse

### 1.1 Was heute zur Stundenplanung gehört – und wo es liegt

| Bereich | Seite(n) heute | Service | Recht (Seite) | Recht (Actions) |
|---|---|---|---|---|
| Stundenplan pflegen (Raster, Kopplungen, Setzhilfe, Verschieben/Tauschen, Fixieren, Periode kopieren) | `/verwaltung/stundenplan` | `manage.ts`, `setzhilfe.ts`, `periode.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Automatisch planen (Solver) | `/verwaltung/stundenplan/solver` | `solverlauf.ts`, `solver.ts`, `solver-input.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Unterrichtsverteilung (Lehraufträge, Soll/verplant), Lehrkräfte/Deputate, Diagnose | `/verwaltung/unterricht` (Ansichten per `?ansicht=`) | `verteilung.ts`, `deputate.ts`, `diagnose.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Zeitwünsche (Planungsseite, Eingabefenster) | `/verwaltung/unterricht/zeitwuensche` | `zeitwuensche.ts`, `zeitwunsch-fenster.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Eigene Zeitwünsche (Lehrkraft) | `/stundenplan/zeitwuensche` | dito | Rolle `lehrkraft` | `requireUser` + Fenster offen |
| Vertretungen, Abwesenheiten (Lehrkraft/Klasse), Vertretungsbedarf, Vorschläge, Veröffentlichen, Ausweichraum | `/verwaltung/vertretungen` | `vertretung.ts`, `abwesenheit.ts`, `vorschlaege.ts`, `freigabe.ts`, `vertretung-gong.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Vertretungsstatistik | `/verwaltung/vertretungen/statistik` | `vertretung.ts` | `stundenplan.manage` | – |
| Pausenaufsichten (Bereiche, Plan, Tagesansicht, Vertretung) | `/verwaltung/aufsichten` | `aufsichten.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Räume: Suche, Belegung, **Sperrungen** | `/stundenplan/raeume` (Reiter) | `raeume.ts`, `raumsperren.ts` | Rollenliste `STAFF` **oder** `gebaeude.manage`; Sperren nur mit `stundenplan.manage` | `stundenplan.manage` |
| Abwesenheit selbst melden / genehmigen | `/stundenplan/abwesenheit` | `selbstmeldung.ts` | Rolle `lehrkraft` oder `stundenplan.absence_approve` | eigene Prüfung |
| Mein Deputat | `/stundenplan/deputat` | `mein-deputat.ts` | Rolle `lehrkraft` | – |
| Stundenplan ansehen, Vertretungsplan, Druck | `/stundenplan`, `/stundenplan/vertretungen`, `/druck/stundenplan`, `/druck/vertretungsplan` | `service.ts`, `display.ts`, `today.ts` | alle (Planwahl nach `canViewPlan`) | – |
| Stammdaten (Fächer, Räume, Zeitraster, Schuljahre, Ferien, Stundentafel) | `/verwaltung/stammdaten` | `src/modules/verwaltung` | `verwaltung.school` | `verwaltung.school` |
| Kurswahl → Lehraufträge übernehmen | `/kurswahl/[id]` (Abschnitt) | `kurswahl/uebernahme.ts` | `stundenplan.manage` | `stundenplan.manage` |
| Raumsperre aus Gebäude & Technik | `/gebaeude/[id]` (Knopf) | `gebaeude` ruft `raumsperren.ts` | `stundenplan.manage` (Knopf) / `gebaeude.manage` (Service) | – |
| „Offen für dich“ (Vertretungsbedarf, unbesetzte Aufsichten, Entwürfe, Raumsperren) | Widget Heute | `open.ts` | `stundenplan.manage` | – |

**Ergebnis:** Sechs Planungsseiten liegen als Reiter im Verwaltungsbereich (`verwaltung/layout.tsx`: Stundenplan, Unterrichtsverteilung,
Vertretungen, Aufsichten; Solver und Zeitwünsche als Unterseiten), gemischt mit Benutzern, Gruppen, Backup und System.
`Verwaltung → Unterricht` **ist** die Unterrichtsverteilung samt Deputaten, Diagnose und Zeitwünschen – also vollständig Stundenplanung.

### 1.2 Rechte heute

- Ein einziges Fachrecht **`stundenplan.manage`** deckt alles ab – Jahresplanung (Pflege, Verteilung, Solver) **und** Tagesgeschäft
  (Vertretungen, Abwesenheiten, Aufsichtsvertretung, Veröffentlichen). An vielen Schulen sind das verschiedene Personen
  (Stundenplaner:in vs. Vertretungsplanung/Sekretariat).
- `defaultGrants: { verwaltung: ["stundenplan.manage"] }` – die Rolle **Verwaltung (Sekretariat)** plant per Vorgabe. Die Schulleitung
  (Gruppe mit `verwaltung.*`) hat das Recht **nicht** (kein Wildcard auf `stundenplan.*`) – sie sieht in der Demo weder
  Vertretungsbedarf noch „Offen für dich“-Planungspunkte; das war nie Absicht (FEINSCHLIFF I-10/I-27).
- `stundenplan.absence_approve` (Schulleitung, Gruppe) ist sauber getrennt und bleibt.
- Der Zugang zum Verwaltungsbereich braucht zusätzlich `verwaltung.access` – eine Lehrkraft, die plant, müsste heute **Verwaltungsrechte**
  bekommen (und damit 2FA sofort, Außen-Sperre wie Verwaltung, Sichtbarkeit aller Verwaltungs-Reiter, die sie hat).

### 1.3 Brüche, Lücken, Fehler

| Nr. | Befund | Wo | Art |
|---|---|---|---|
| L-01 | **Rollen- statt Rechte-Gates**: `const STAFF = ["lehrkraft","verwaltung","admin"]` – `personal`/`beratung` bekommen am Wochenplan 404, Räume nur über die `gebaeude.manage`-Ausnahme | `stundenplan/page.tsx:22`, `stundenplan/raeume/page.tsx:26` | Rechte/UX |
| L-02 | Solver startet auch ohne Lehraufträge oder ohne Zeitraster → leerer Lauf „fertig“ mit 0 Einheiten statt Hinweis | `solverlauf.ts createRun` | Validierung |
| L-03 | Doppelte Sperrlogik: `createRun` prüft „läuft schon“ per 10-Minuten-Heuristik, `executeRunExclusive` zusätzlich über die Job-Sperre (TTL 30 min); ein gründlicher Lauf einer großen Schule kann die TTL reißen | `solverlauf.ts` | Robustheit |
| L-04 | Solver rechnet im Request-Prozess in festen Blöcken von 2000 Schritten – blockiert dabei die Ereignisschleife (Lasttest B-50a: Stundenplan-Seiten sind ohnehin CPU-lastig) | `solverlauf.ts executeRun` | Leistung |
| L-05 | Gründlichkeit (`effort`) und Gewichte werden **nicht gespeichert** – ein Lauf ist später nicht reproduzierbar/erklärbar; nur Startwert bleibt | `timetable_solver_runs` | Daten |
| L-06 | Nur die letzten 5 Läufe sichtbar, kein Abbruch, kein Vergleich, kein Löschen, keine Dauer, keine Kennzahlen in der Liste (Bewertung nur, wenn das ganze `result`-JSON geladen wird) | `solver/page.tsx` | Funktion (→ §3) |
| L-07 | Übernahme ist endgültig: alter Plan endet am Vortag, Vertretungen ab Stichtag werden gelöscht, kein Rückweg; Stunden tragen keine Herkunft (welcher Lauf) | `solverlauf.ts applyRun` | Funktion (→ §3) |
| L-08 | Stichtag der Übernahme muss nur „in der Zukunft, im Schuljahr“ liegen – kein Hinweis, wenn er auf Wochenende/Ferien fällt | `applyRun` | Validierung |
| L-09 | Tests: `solverlauf.test.ts` hat 2 Fälle; E2E nur ein Solver-Test; `applyRun` ohne Tests für Kopplungen in bleibenden Stunden, A/B-Wochen, Vertretungen am Stichtag | Tests | Qualität |
| L-10 | „Offen für dich“, Gebäude-Raumsperre, Vertretungsplan-Entwürfe hängen an `stundenplan.manage` – mit der Trennung Planung/Vertretung müssen sie am Tagesgeschäft-Recht hängen | `open.ts`, `gebaeude/[id]`, `freigabe.ts`, `service.ts:122`, `vertretung.ts:300` | Rechte |
| L-11 | Fehlermeldungen wandern als `?fehler=` durch die URL (Solver, Vertretungen, Aufsichten) – funktional, aber nach Neuladen bleibt die Meldung stehen; gleiches Muster schulweit, hier nur dokumentiert | mehrere Seiten | UX |
| L-12 | A11Y-Durchgang (`e2e/a11y.spec.ts`) prüft für das Sekretariat nur `/verwaltung/vertretungen`; Pflege, Unterrichtsverteilung, Solver, Aufsichten, Zeitwünsche fehlen | `e2e/a11y.spec.ts` | A11Y |
| L-13 | Mobile: Planungsseiten sind Desktop-Seiten (breite Raster in `Table` mit `overflow-x-auto`); nie mit `shot.mjs --mobile` abgenommen | Pflege, Verteilung, Solver | mobil (Prüfpunkt) |
| L-14 | Doku: `STUNDENPLAN.md` §1 beschreibt den Stand „Ende Phase 2“; README/CLAUDE.md kennen keinen Planungs-Login | docs | Doku |
| L-15 | `verwaltung/page.tsx` (Übersicht) zeigt keine Planungszahlen; der Verwaltungs-Einstieg hat keinen Bezug zur Planung | Verwaltung | UX (entfällt mit dem Umzug) |
| L-16 | Ohne Vertretungsstatistik-Export (CSV/Druck), ohne Aufsichtsstatistik, ohne Druck der Unterrichtsverteilung/Deputate/Aufsichtsplan | – | neue Funktionen → **nicht** in diesem Umbau (Ideen-Board) |

Gut und unverändert: Setzhilfe, Diagnose, Kopplungen, Freigabe des Vertretungsplans, Vertretungsvorschläge, Selbstmeldung, Monitor –
FEINSCHLIFF §7 bewertet die Jahresplanung als „sehr vollständig“.

---

## 2. Ziel-Struktur

### 2.1 Funktionsrolle „Stundenplanung“ (Entscheidung Q-SP-1 – **entschieden durch Projektleitung 19.10.2026**: Funktionsgruppe)

**Keine neue Enum-Rolle** (`users.role`), sondern eine **Funktionsgruppe `Stundenplanung`** mit Rechte-Bündel – nach dem Muster
Schulleitung (`verwaltung.*`) und Hausmeisterei (`gebaeude.manage`). Gründe:

1. Stundenplaner:innen **sind Lehrkräfte** (mit Entlastungsstunden). Ein Konto hat genau eine Rolle; eine Enum-Rolle „Stundenplanung“
   würde die Person aus allem herauslösen, was an `role === "lehrkraft"` hängt (eigener Stundenplan, Klassenbuch, Notenbuch, Mein Deputat,
   Abwesenheit melden, Zeitwünsche, Kursraum als Lehrkraft, Deputatskonto, Adressbuch-Sichtbarkeit, Gerätezertifikate …).
2. Keine Migration am Postgres-Enum, keine Anpassung an ~15 Stellen, die Rollen aufzählen (Rechte-Matrix, Benutzerformular, News-/Umfrage-
   Ziele, Adressbuch, Messenger-Policy, Gerätezertifikate, Rollenzähler, Schulprofil-Export, DSB-Checkliste).
3. Die Schule kann mehrere Personen eintragen, Stellvertretungen regeln und Vertretungsplanung getrennt vergeben – alles über
   Verwaltung → Gruppen/Rechte, ohne Code.

In der Oberfläche heißt die Gruppe „Stundenplanung“; die Rechte-Seite nennt sie unter den Gruppen mit eigenen Rechten. Für eine Schule, die
eine externe Person **nur** planen lässt, reicht die Rolle `personal` + Mitgliedschaft in der Gruppe.

### 2.2 Rechte-Bündel (Entscheidung Q-SP-2)

| Recht | Bedeutung | Deckt ab |
|---|---|---|
| `stundenplan.manage` (bestehend, Text „Stundenplan planen“) | Jahres-/Halbjahresplanung | Pflege, Setzhilfe, Kopplungen, Fixieren, Periode kopieren, Unterrichtsverteilung, Deputate, Zeitwünsche + Eingabefenster, Aufsichtsplan (Bereiche, Wochenplan), Solver-Läufe, Kurswahl-Übernahme |
| **`stundenplan.substitute`** (neu, „Vertretungen planen“) | Tagesgeschäft | Vertretungen/Entfall/Raumänderung, Abwesenheiten eintragen/aufheben, Vertretungsbedarf und Vorschläge, Veröffentlichen, Raumsperren + Ausweichraum, Aufsichtsvertretung, Statistik, Entwürfe mitlesen, „Offen für dich“, Raumsperre aus Gebäude & Technik |
| `stundenplan.absence_approve` (bestehend) | Schulleitung | unverändert |

Gruppe **Stundenplanung** bekommt `stundenplan.manage` + `stundenplan.substitute`. Wer nur Vertretung macht (Sekretariat, Schulleitung
morgens), bekommt `stundenplan.substitute` per Gruppe oder Rolle.

**Rolle Verwaltung verliert die Vorgabe** (Entscheidung Q-SP-3): `defaultGrants` des Moduls enthalten künftig **keinen** Rollen-Grant mehr.
Begründung: Der Auftrag lautet „aus dem Verwaltungsbereich entfernen“; das Sekretariat pflegt Stammdaten (`verwaltung.school`), aber
nicht den Plan. Für bestehende Installationen gilt der Grundsatz von `syncDefaultGrants` („vom Admin entzogene Paare kommen nicht wieder,
vorhandene bleiben“) spiegelbildlich: **niemand verliert ein Recht** – siehe Migration.

**Migration für bestehende Installationen (Q-SP-4):** Eine Daten-Migration (`drizzle/0088_stundenplanung.sql`, idempotent)
1. legt zu **jedem** Grant `stundenplan.manage` (Rolle oder Gruppe) den passenden Grant `stundenplan.substitute` an (bisher konnte, wer plante,
   auch vertreten – das bleibt so);
2. legt die Gruppe `stundenplanung` (Art `gremium`, Name „Stundenplanung“) an, falls es keine Gruppe mit diesem Slug gibt, und gibt ihr beide
   Rechte – **ohne Mitglieder**; Admin/Verwaltung tragen die Personen ein (Hinweis auf der Rechte-Seite und in den Release-Notes);
3. lässt den bestehenden Rollen-Grant `verwaltung → stundenplan.manage` stehen (Admin entscheidet, ob er ihn entzieht; die Rechte-Seite zeigt
   den Hinweis „Empfehlung: Planung über die Gruppe Stundenplanung“).
   `grants.synced.stundenplan` wird um das Paar `verwaltung:stundenplan.manage` **nicht** bereinigt, damit `syncDefaultGrants` es nie wieder anlegt.

**2FA (Q-SP-5 – entschieden durch Projektleitung 19.10.2026: sofort Pflicht):** `requiresTwoFactor` zählt `stundenplan.manage` und `stundenplan.substitute` wie Verwaltungsrechte → **sofort Pflicht**
(Deputate aller Lehrkräfte, Abwesenheiten mit Grund „krank“). Demo-Instanzen bleiben wie bisher ausgenommen. Betroffene Lehrkräfte auf
bestehenden Servern richten 2FA beim nächsten Anmelden im Schulnetz ein (bestehender Ablauf `twoFactorPending`).

**Anrechnungsstunden „Stundenplanung“ (Ergänzung der Projektleitung 19.10.2026, umgesetzt in SP-02):** Deputats-Grund
`stundenplanung` („Stundenplanung“, Art Anrechnung) hinten an `REDUCTION_REASONS` angefügt; der Enum-Wert kommt mit Migration 0088
(`ALTER TYPE … ADD VALUE` – in derselben Migration nicht benutzt, daher in der Migrations-Transaktion zulässig, wie 0054/0068).
Anzeigen (Deputat-Pflege, Mein Deputat) laufen über `REDUCTION_LABELS`; eigene Druck-/Exportansichten der Deputate gibt es noch nicht (L-16).

**Umsetzungsstand SP-02 (2026-10-19):** Migrationsnummer **0088** statt 0087 (0087 hat BU-01 Schulbücherei belegt; SP-06 rückt auf 0089). Rechte, Migration 0088, 2FA, Seed (Gruppe mit `frank.schulte`, Schulleitung `substitute`),
Rechte-Hinweis und Aufteilung der Actions/Seiten (`open.ts`, Gebäude-Raumsperre, Vertretungen/Statistik, Raumsperren, Material
zur Selbstmeldung und Gong an die Planung → `substitute`; Aufsichten: Plan/Bereiche `manage`, Tagesansicht `substitute`) sind fertig.
**Übergang bis SP-03:** Die Planungsseiten liegen noch unter `/verwaltung` (braucht `verwaltung.access`), deshalb behält die
**Demo** die Rollen-Grants `verwaltung → stundenplan.manage/.substitute` (wie eine aktualisierte Bestandsinstallation) und die E2E-Tests
planen weiter als Sekretariat. SP-03 entfernt diese Demo-Grants mit dem Umzug nach `/planung` und stellt die Tests auf `frank.schulte` um.
Die Funktionsgruppe hat die feste ID `g-stundenplanung`; eine schon vorhandene Gruppe mit Slug `stundenplanung` bekommt keine Rechte
(keine stille Rechteausweitung). Mitglieder nimmt nur auf, wer beide Rechte selbst hat (SEC-04) – auf neuen Installationen also der Admin.

**Außenzugang:** bleibt wie für Lehrkräfte (Gerätezertifikat nach Schuleinstellung); die Planung ist **kein** Verwaltungsrecht im Sinne von
S28 (keine Außen-Sperre). Begründung: Vertretungsplanung findet morgens um 7 Uhr auch von zu Hause statt.

### 2.3 Eigener Bereich `/planung` (Entscheidung Q-SP-6)

Navigation: Modul `stundenplan`, Sektion **Organisation**, Eintrag **„Stundenplanung“** (Icon `CalendarCog`), sichtbar mit `stundenplan.manage`
**oder** `stundenplan.substitute`. Eigenes `layout.tsx` mit `requireModulePage("stundenplan")` + Rechteprüfung (sonst 404) und einer
Unternavigation (der `SubNav` der Verwaltung wandert nach `@schulos/ui/sub-nav` und wird von beiden Bereichen genutzt).

| Reiter | URL (neu) | kommt von | sichtbar mit |
|---|---|---|---|
| Übersicht | `/planung` | neu (nur vorhandene Services) | manage **oder** substitute |
| Stundenplan | `/planung/stundenplan` | `/verwaltung/stundenplan` | manage |
| Unterrichtsverteilung | `/planung/unterricht` (Ansichten Lehraufträge · Lehrkräfte/Deputate · Diagnose) | `/verwaltung/unterricht` | manage |
| Zeitwünsche | `/planung/zeitwuensche` | `/verwaltung/unterricht/zeitwuensche` | manage |
| Automatisch planen | `/planung/solver`, `/planung/solver/[id]`, `/planung/solver/vergleich` | `/verwaltung/stundenplan/solver` | manage |
| Vertretungen | `/planung/vertretungen`, `/planung/vertretungen/statistik` | `/verwaltung/vertretungen` | substitute |
| Aufsichten | `/planung/aufsichten` | `/verwaltung/aufsichten` | manage (Plan) · substitute (Tagesansicht/Vertretung) |
| Räume | `/stundenplan/raeume` (bleibt, da mit Hausmeisterei und Lehrkräften geteilt) | – | Link im Reiter; Sperren anlegen: substitute |

**Übersicht `/planung`** (eine Seite, nur Lesen, aus vorhandenen Funktionen): Schuljahr/Planungszeitraum, offene Lehraufträge (Soll − verplant),
Diagnose-Zähler, Zeitwunsch-Fenster (offen bis/abgegeben x von y), letzter Solver-Lauf (Status/Bewertung), Vertretungsbedarf heute/nächster
Schultag, unveröffentlichte Entwürfe, unbesetzte Aufsichten, aktive Raumsperren – jede Kachel verlinkt auf den Reiter. Das ersetzt den
„Schulleitungs-Blick“ aus FEINSCHLIFF I-10/I-27 für die Planung.

**Weiterleitungen (Q-SP-7):** `next.config.ts` `redirects()` (307, Query bleibt erhalten) für alle sechs alten Pfade inkl. Unterpfaden;
sie bleiben dauerhaft (Lesezeichen, Monitore, alte Links in Gongs). Interne Links, `revalidatePath`, `redirect()` in Actions, E2E-Tests und
Doku werden umgestellt. Der Verwaltungsbereich verliert die vier Reiter; die Verwaltungs-Übersicht bekommt bei passendem Recht eine Kachel
„Stundenplanung öffnen“. `PageHeader eyebrow` der Seiten: „Stundenplanung“ statt „Verwaltung“.

**Demo (Q-SP-8):** Gruppe „Stundenplanung“ mit **Frank Schulte (SLT, Login `frank.schulte`)** als Leitung – eine Lehrkraft (PH/IF), die weder
Schulleitung noch Klassenleitung der 7b ist; die Demo-Logins in README/CLAUDE.md bekommen die Zeile „`frank.schulte` (Stundenplanung)“.
Das Sekretariat (`sabine.kowalski`) plant in der Demo **nicht** mehr; E2E-Tests, die bisher als Verwaltung planen, laufen als `frank.schulte`.
Die Gruppe Schulleitung bekommt in der Demo `stundenplan.substitute` (sie sieht damit Vertretungsbedarf, Entwürfe und „Offen für dich“ –
I-27), aber nicht `manage`.

### 2.4 Was bewusst bleibt

- Stammdaten (Fächer, Räume, Zeitraster, Schuljahre, Ferien, Stundentafel) bleiben in **Verwaltung → Stammdaten** (`verwaltung.school`):
  sie gehören der Schule, nicht der Planung; die Planungs-Übersicht verlinkt dorthin, wenn das Recht vorhanden ist, sonst steht dort
  „Stammdaten pflegt die Verwaltung“.
- Lehrkraft-Seiten (`/stundenplan/zeitwuensche`, `/stundenplan/deputat`, `/stundenplan/abwesenheit`) bleiben, wo sie sind.
- Monitore bleiben in der Verwaltung (`monitor.manage`).
- Keine Trennung des Moduls: Tabellen, Manifest, Services, Löschregeln bleiben `stundenplan`; nur Seiten, Rechte und Navigation ändern sich.

---

## 3. Solver-Läufe (einzige neue Funktion)

### 3.1 Heute

`timetable_solver_runs` (Status `running|done|failed|applied`, `progress`, `seed`, `iterations`, `result` JSONB mit Ergebnis + Einheiten +
`keptLessonIds`, `error`, `appliedFrom`, `createdBy`, `createdAt`, `finishedAt`). `startSolverAction` legt den Lauf an und startet ihn
**ohne Abwarten** im Serverprozess unter der Job-Sperre `solver` (B-17); Fortschritt in 2000er-Blöcken mit `setImmediate`; die Seite lädt alle
2 s neu. Beim Serverstart werden rechnende Läufe als „abgebrochen“ markiert. Vorschau je Klasse, Bewertung mit Kostenposten, Diagnose
(Hohlstunden, Fach mehrfach, Räume), Übernahme ab Stichtag (ersetzt alle nicht fixierten Stunden mit Lehrauftrag). Löschklasse **LK-90**.
Der Solver selbst (`solver.ts`) ist rein, deterministisch, schrittweise (`construct() → improve(n) → result()`) – gute Basis.

### 3.2 Was für „Läufe“ fehlt und wie es gebaut wird

| Thema | Entscheidung |
|---|---|
| **Parameter je Lauf** | neue Spalten `label` (frei, z. B. „Variante Mo frei LIN“), `params` JSONB `{ effort, seed, weights, note }`. Gewichte über **Voreinstellungen** (ausgewogen = `DEFAULT_WEIGHTS`, lehrkräfteschonend, klassenkompakt, raumtreu) plus „eigene“ (7 Zahlenfelder); alles wird gespeichert → reproduzierbar |
| **Historie** | alle Läufe des Planungs-Schuljahres mit Filter (Status), Spalten: gestartet, Dauer, Bezeichnung, Gründlichkeit, Startwert, Bewertung, nicht gesetzt, Hohlstunden L/K, Status. Kennzahlen aus `metrics` JSONB (klein), nicht aus `result` |
| **Status/Fortschritt** | Status-Enum um `queued` und `cancelled` erweitert; `progress` bleibt; zusätzlich `heartbeat_at` (für Sperre und Anzeige „rechnet seit…“) und Zwischenbewertung alle 10 % im Protokoll. Nur **ein** Lauf rechnet; weitere warten als `queued` und starten automatisch, wenn der vorige endet (oder beim Serverstart) |
| **Hintergrund ohne Request-Timeout** | bleibt im App-Prozess (keine Worker-Threads: Next-Standalone-Bundling, ISO-Image, ein Deployable), aber **zeitgeschnitten**: rechnen ≈ 25 ms, dann `setImmediate` – statt fester 2000er-Blöcke; Sperre per Heartbeat verlängern (TTL 2 min statt 30 min, Verlängerung je Scheibe); Lauf überlebt die Anfrage (wie heute), Serverneustart → `failed` („Server neu gestartet“) bzw. `queued` startet neu. Die Kern-Runde misst den Einfluss auf Antwortzeiten (Lasttest-Regressionslauf) und entscheidet mit Zahlen; Worker-Thread bleibt Rückfalloption (Q-SP-9) |
| **Abbruch** | `cancel_requested` Flag, geprüft je Zeitscheibe. Nach abgeschlossener Konstruktion: Lauf endet als **`done`** mit dem bisherigen Stand und Vermerk „vorzeitig beendet bei x %“ (ein gültiger Plan – gerade bei „gründlich“ nützlich); vorher: `cancelled` ohne Ergebnis |
| **Ergebnis-Kennzahlen** | `metrics` JSONB beim Abschluss: `score`, `breakdown`, `unplaced`, `units`, `steps`, `improved`, `durationMs`, Diagnose-Zähler (`gaps`/`subjectDay`/`room`), Hohlstunden je Lehrkraft/Klasse (Summe und Maximum) |
| **Vergleich** | `/planung/solver/vergleich?laeufe=a,b[,c]`: Kennzahlen nebeneinander, bester Wert je Zeile markiert, Delta zum ersten; darunter die Vorschau einer wählbaren Klasse **oder Lehrkraft** nebeneinander |
| **Protokoll / Konflikte** | `log` JSONB (≤ 50 Einträge): Eingabe (Einheiten, fixiert, Räume, gesperrte Zeiten), Konstruktion fertig (nicht gesetzt mit Gründen), Verbesserung alle 10 % (Bewertung), Abbruch/Ende; Detailseite zeigt Protokoll, „nicht gesetzt“ vollständig (heute nur 10), Kostenposten vollständig mit Filter nach Kategorie |
| **Übernahme als Entwurf / aktiver Plan** | wie heute **ab Stichtag** – ein Stichtag in der Zukunft **ist** der Entwurf (bis dahin gilt der alte Plan). Neu: `timetable_lessons.solver_run_id` (Herkunft, `on delete set null`), `undo` JSONB am Lauf (beendete Stunden mit altem `valid_until`, Anzahl gelöschter Vertretungen), Status `applied` mit `applied_by`/`applied_at`. **„Übernahme zurücknehmen“** solange der Stichtag in der Zukunft liegt: gesetzte Stunden des Laufs löschen, `valid_until` der beendeten wiederherstellen → Status `done`; gelöschte Vertretungen kommen **nicht** zurück (Hinweis vor der Übernahme nennt die Zahl). Stichtag muss ein Schultag sein (Ferien/Wochenende → Fehler mit Vorschlag `nextSchoolDay`) |
| **Aufräumen** | Löschklasse bleibt **LK-90** (90 Tage ab Anlage, DATENSCHUTZ §3.3). Zusätzlich Nachtjob `solver-aufraeumen`: `failed`/`cancelled` ohne Ergebnis nach 7 Tagen löschen; von `done`-Läufen je Schuljahr nur die **neuesten 20** mit vollem `result` behalten, ältere behalten nur `metrics`/`log` („Ergebnis entfernt“, nicht mehr übernehmbar). Manuelles Löschen je Lauf (`stundenplan.manage`, Audit `stundenplan.solver.delete`) |
| **Validierung vor dem Start** | ohne Zeitraster, ohne Lehraufträge oder ohne aktive Räume: Hinweis statt leerer Lauf (L-02) |

### 3.3 Datenschutz-Folgen

- Keine neuen Datenarten mit Personenbezug: `params`/`metrics`/`log` enthalten Zahlen, Gewichte, Bezeichnung (Freitext der Planung – Hinweis im
  Formular „keine Personen nennen“) und dieselben Kürzel/IDs wie das Ergebnis selbst. `applied_by` ist ein weiterer Bezug auf das Konto der
  Planung (wie `created_by`).
- Löschklasse LK-90 bleibt; `DATENSCHUTZ.md` §3.4 bekommt eine eigene Zeile „Solver-Läufe (Planvorschlag, Parameter, Kennzahlen,
  Protokoll) – LK-90 – Planung: Entwürfe ohne Außenwirkung; Herkunft `solver_run_id` an Stunden fällt mit dem Lauf weg“. Das Manifest
  (`retention`) wird um die Kategorien „Parameter“, „Kennzahlen“, „Protokoll“, „Übernommen von“ ergänzt; `processing.note` nennt die Läufe.
- Die Auskunft (DS-Export) der planenden Person listet weiterhin „Gestartet von“/neu „Übernommen von“ ohne das Ergebnis-JSON.
- SICHERHEIT.md: neue Zeile S-xx „Planungsrechte“ (zwei Rechte, Gruppe statt Rolle, 2FA sofort, kein Verwaltungsrecht im Sinne S28, Solver
  nur ein Lauf gleichzeitig, Abbruch/Löschen nur `stundenplan.manage`, Audit).

---

## 4. Lückenliste (ohne neue Großfunktionen), priorisiert

| Prio | Lücke | Runde |
|---|---|---|
| 1 | Trennung Planung/Vertretung als Rechte, Gruppe statt Rolle, Verwaltung ohne Vorgabe, Migration ohne Rechteverlust (§2.1–2.2) | SP-02 |
| 1 | Eigener Bereich mit Übersicht, Umzug der sechs Seiten, Weiterleitungen, Verwaltung aufgeräumt (§2.3) | SP-03, SP-04 |
| 1 | Rechte- statt Rollen-Gates (L-01) mit Helfer `isStaffRole()` in `core/roles.ts`; Räume-Seite ohne `gebaeude`-Sonderfall-Verrenkung | SP-05 |
| 1 | Solver: Validierung vor dem Start (L-02), eine Sperrlogik (L-03), Zeitscheiben + Heartbeat (L-04), Parameter gespeichert (L-05) | SP-06 |
| 1 | Solver-Läufe als Funktion (L-06): Historie, Abbruch, Kennzahlen, Protokoll, Vergleich, Aufräumen | SP-06…SP-08 |
| 2 | Übernahme nachvollziehbar und zurücknehmbar, Stichtag = Schultag (L-07, L-08) | SP-09 |
| 2 | Tests: Service-Tests für Lauf-Warteschlange/Abbruch/Undo, E2E-Szenario Stundenplaner:in, A11Y-Durchgang der Planungsseiten (L-09, L-12) | SP-06, SP-09, SP-11 |
| 2 | Mobil: Planungsseiten einmal mit `shot.mjs --mobile` durchsehen, offensichtliche Umbrüche beheben (L-13) | SP-04 |
| 3 | Doku: STUNDENPLAN.md „Stand 2026-10“, README/CLAUDE.md Demo-Login, DATENSCHUTZ/SICHERHEIT (L-14) | SP-03, SP-10 |
| – | Exporte/Drucke/Statistiken (L-16), Warmstart des Solvers vom aktuellen Plan, Vorschau je Raum, Lauf-Favoriten | **nicht hier** → Ideen-Board |

---

## 5. Umsetzungsrunden (je ein mergebarer PR)

Reihenfolge und Abhängigkeiten; jede Runde `npm run check` grün, UI-Runden zusätzlich `npm run verify` (Build + E2E).
**Kern** = Solver-Kernlogik (stärkeres Modell erlaubt). Größen wie im BACKLOG (S/M/L).

| ID | Titel | Größe | Modell | hängt ab von | Migration | Tests |
|---|---|---|---|---|---|---|
| **SP-01** | Plan-Dokument, BACKLOG-Block, QUESTIONS, PLAN §0 (dieser PR) | S | Opus | – | – | – |
| **SP-02** ✅ | Rechte: `stundenplan.substitute`, Gruppe „Stundenplanung“, Verwaltung ohne Vorgabe, Migration 0088, 2FA, Actions/Seiten/`open.ts`/Gebäude auf das passende Recht, Seed (Gruppe + `frank.schulte`, Schulleitung `substitute`), Rechte-Hinweis; Anrechnungsgrund „Stundenplanung“ | M | Opus | SP-01 | **0088** (Enum `reduction_reason` + Daten: Grants + Gruppe) | `permissions.test`, `registry.test`, `escalation.test`, `open-items.test`, `seed.test`, Migrationstest Grants |
| **SP-03** | Bereich `/planung`: Layout, `@schulos/ui/sub-nav`, Umzug der sechs Seiten (`git mv`), Nav-Eintrag, Eyebrow, `revalidatePath`/`redirect`-Pfade, `redirects()` in `next.config.ts`, Verwaltung ohne die vier Reiter, E2E/a11y/Unit-Tests auf neue URLs, CLAUDE.md/README Demo-Login | L | Opus | SP-02 | – | `npm run verify`; E2E „alte URL leitet weiter“, „Sekretariat sieht `/planung` nicht“ |
| **SP-04** | Übersicht `/planung` (Kacheln aus vorhandenen Services, Links, Leerzustände), Kachel in der Verwaltungs-Übersicht, mobiler Durchgang der Planungsseiten mit `shot.mjs --mobile` | S | Opus | SP-03 | – | Service-Test der Kachel-Zahlen, E2E Übersicht, a11y-Pfade |
| **SP-05** | Rechte- statt Rollen-Gates: `isStaffRole()` in `core/roles.ts`, `stundenplan/page.tsx` und `raeume/page.tsx` ohne `STAFF`-Liste, Sperren-Reiter an `substitute` | S | Opus | SP-02 | – | `registry.test` (Navigation), E2E „Personal sieht Wochenplan/Räume“ |
| **SP-06** (**Kern**) | Solver-Läufe Datenmodell + Ausführung: Migration 0089 (`label`, `params`, `metrics`, `log`, `cancel_requested`, `heartbeat_at`, `applied_by`/`applied_at`, `undo`, Status `queued`/`cancelled`, `timetable_lessons.solver_run_id`), Zeitscheiben statt fester Blöcke, Heartbeat-Sperre, Warteschlange, Abbruch, Startup (queued weiter, running → failed), Validierung vor dem Start, Nachtjob `solver-aufraeumen`, Messung der Antwortzeiten während eines Laufs | M | **Fable** | SP-03 | **0089** | `solverlauf.test` (Warteschlange, Abbruch vor/nach Konstruktion, Heartbeat, Aufräumen, Validierung), `solver.test` unverändert grün, `retention.test` |
| **SP-07** | Solver-Läufe UI: Liste aller Läufe (Filter), Start-Formular mit Bezeichnung/Gründlichkeit/Startwert/Gewichtungs-Voreinstellung + „eigene“, Detailseite `/planung/solver/[id]` (Fortschritt, Protokoll, Konflikte vollständig, Kostenposten mit Filter, Vorschau Klasse **und** Lehrkraft), Abbrechen, Löschen | M | Opus | SP-06 | – | `npm run verify`; E2E Lauf starten → abbrechen → zweiter Lauf |
| **SP-08** | Vergleich `/planung/solver/vergleich?laeufe=…` (2–3 Läufe, bester Wert markiert, Delta, Vorschau nebeneinander) | S | Opus | SP-07 | – | Service-Test der Delta-Berechnung, E2E Vergleich |
| **SP-09** (**Kern**) | Übernahme: `solver_run_id` an Stunden, `undo` schreiben, „Übernahme zurücknehmen“ bis zum Stichtag, Stichtag = Schultag, Hinweis mit Zahl der entfallenden Vertretungen; Randfälle Kopplungen/A-B-Woche/Vertretungen am Stichtag | M | **Fable** | SP-06 | – (Spalten aus 0089) | `solverlauf.test` (Übernahme/Zurücknehmen mit Kopplungen, bleibenden Stunden, Vertretungen), E2E Übernahme → zurücknehmen |
| **SP-10** | Datenschutz + Doku: DATENSCHUTZ §3.4 Zeile, Manifest `retention`/`processing`, SICHERHEIT S-xx, STUNDENPLAN.md „Stand 2026-10“, VVT-/Auskunftstest | S | Opus | SP-09 | – | `retention.test`, VVT-Snapshot, Auskunftstest |
| **SP-11** | E2E-Szenario „Stundenplaner:in“ (Login `frank.schulte` → Übersicht → Lauf mit Parametern → Abbruch → zweiter Lauf → Vergleich → Übernahme ab Stichtag → zurücknehmen; Sekretariat 404 auf `/planung`; alte URLs leiten weiter) + **Review-PR GATE SP** (erledigte IDs, Tests, Fragen) | S | Opus | SP-10 | – | `e2e/zx-gate-sp.spec.ts` |
| **GATE SP** | Review mit der Projektleitung (Review-PR aus SP-11; `/code-review ultra` nach Wunsch) – merged nur die Projektleitung | – | – | SP-11 | – | – |

Parallelisierbar: SP-05 neben SP-03; SP-08 neben SP-09. Zwischenstand zum Melden nach SP-04 (Bereich steht, Verwaltung aufgeräumt) und
nach SP-07 (Läufe bedienbar). Release-Vorschlag nach GATE SP: **v0.6.0** (Rechteänderung + Migrationen → Minor, Release-Notes mit dem
Hinweis zur Gruppe „Stundenplanung“ und zur 2FA-Pflicht für Planende).

### 5.1 Prüfliste je Runde

- Manifest-Rechte deklariert, `defaultGrants` nur deklarierte Rechte (`registry.test`), neue Tabellenspalten mit Personenbezug im
  `retention`-Eintrag (Kategorien), `npm run veroeffentlichen:pruefen` grün.
- Server Actions prüfen das **passende** Recht (`manage` vs. `substitute`), Seiten dasselbe wie die Actions.
- `revalidatePath`/`redirect` auf neue Pfade; alte Pfade nur noch in `redirects()` und Tests.
- E2E-Tests mit dem Planungs-Login, nicht mit dem Sekretariat.
- Doku-Nachträge (LOG, Abhaken) im selben PR.
