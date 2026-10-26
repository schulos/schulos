# SchulOS – Umbau der Stundenplanung: eigener Bereich, Funktionsrolle, Solver-Läufe

> Stand: 2026-10-19 · Status: **Plan, zur Umsetzung freigegeben durch den Auftrag der Projektleitung** („Bereich Stundenpläne
> managen komplett überarbeiten, eigene Rolle für die Stundenplaner, aus der Verwaltung herauslösen, selbstständig planen und
> umsetzen; neue Funktionen nur die Solver-Läufe“). Aufgaben: `BACKLOG.md` SP-01 … SP-12 und Folgeblock SP2. Entscheidungen: `QUESTIONS.md` Q-SP-1 … Q-SP-17.
> Ergänzt 2026-10-19 um die Gap-Analyse gegen verbreitete Stundenplan-Software (§6) und den Folgeblock „SP2 – Planungstiefe“ (§7).
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

**Umsetzungsstand SP-03 (2026-10-19):** Bereich `/planung` (Layout mit `requireModulePage` + einem der beiden Rechte, sonst 404;
Reiter nach Recht: Übersicht · Stundenplan · Unterrichtsverteilung · Zeitwünsche · Automatisch planen (`manage`) · Vertretungen (`substitute`) ·
Aufsichten (beide)), `SubNav` liegt in `@schulos/ui/sub-nav` (Verwaltung nutzt ihn mit), Nav-Eintrag „Stundenplanung“ (`CalendarCog`).
Weiterleitungen in `next.config.ts` (307, Query bleibt): `/verwaltung/stundenplan/solver` → `/planung/solver`, `/verwaltung/stundenplan` →
`/planung/stundenplan`, `/verwaltung/unterricht/zeitwuensche` → `/planung/zeitwuensche`, `/verwaltung/unterricht` → `/planung/unterricht`,
`/verwaltung/vertretungen` → `/planung/vertretungen`, `/verwaltung/aufsichten` → `/planung/aufsichten` (jeweils mit Unterpfaden). Demo ohne
Rollen-Grants `verwaltung → manage/substitute`; E2E planen als `frank.schulte`. `/planung` ist bis SP-04 ein Wegweiser mit dem Hinweis zur
Gruppe (Mitglieder trägt nur ein, wer beide Rechte hat – auf neuen Installationen der Admin). **(Entschieden in SP-05, siehe unten.)** Lehraufträge
aus der Kurswahl anlegen braucht `kurswahl.manage` **und** `stundenplan.manage` – in der Demo hat beides nur der Admin (Sekretariat wählt,
Stundenplanung sieht die Kurswahl nicht); das Sekretariat sieht dort jetzt den Hinweis „legt die Stundenplanung an“.

**Umsetzungsstand SP-04 (2026-10-19):** `/planung` zeigt Kennzahlen aus `src/modules/stundenplan/uebersicht.ts` (nur Lesen, Teile ohne Recht
werden gar nicht berechnet): Kopfzeile Schuljahr (Link Stammdaten nur mit `verwaltung.school`); **Jahresplanung** (`manage`): offene
Lehraufträge (offene Wochenstunden, zu viel verplant, Stunden ohne Auftrag), Diagnose (Fehler/Warnungen), Zeitwunsch-Fenster (Zustand,
abgegeben x von y), letzter Solver-Lauf des Planungsjahres (Bewertung, nicht gesetzt – direkt aus dem JSON, ohne das ganze Ergebnis zu laden);
**Tagesgeschäft** (`substitute`): Vertretungsbedarf heute/nächster Schultag, unveröffentlichte Entwürfe, unbesetzte Aufsichten, Raumsperren
heute. Jede Kachel verlinkt auf den Reiter, Leerzustände je Kachel. Verwaltungs-Übersicht: Kachel „Stundenplanung öffnen“ bei einem der beiden
Rechte. Mobiler Durchgang (`shot.mjs --mobile`) ohne nötige Korrekturen; a11y-Durchgang prüft jetzt auch Stundenplan, Unterrichtsverteilung,
Zeitwünsche, Solver und Aufsichten (L-12 teilweise vorgezogen).

**Umsetzungsstand SP-05 (2026-10-19):** Rollen-Gates im Stundenplan-Umfeld zentral in `src/core/roles.ts`: `isStaffRole()` /
`STAFF_ROLES` (Lehrkraft, Personal, Beratung, Verwaltung, Admin – alle außer Schüler:innen und Eltern) und `isTeachingRole()` /
`TEACHING_ROLES` (Lehrkraft, Verwaltung, Admin). Wochenpläne aller Klassen/Lehrkräfte/Räume (`seesAllPlans` in `service.ts`: Beschäftigte
**oder** `stundenplan.manage`/`.substitute`), Planauswahl, Druck und Räume (Seite + Navigation) hängen daran – Personal und Beratung bekommen
keine 404 mehr, Planer:innen mit Rolle `personal` erreichen `/stundenplan/raeume`; die Sonderregel „`gebaeude.manage` + Gebäude-Modul“
für die Räume entfällt (Hausmeisterei ist Personal). Sperren-Reiter/-Anlegen blieb an `substitute` (seit SP-02). Das **Klassenbuch** bleibt
bewusst bei `isTeachingRole` (Schülerdaten – Fehlzeiten, Bemerkungen; Personal/Beratung nicht), nur ohne eigene Rollenkopie.
**Kurswahl lesen (Q-SP-17 – entschieden durch Projektleitung 19.10.2026):** neues Recht `kurswahl.view` – Verfahren, Angebote, Teilnehmerzahlen,
Nachfrage und Zugeteilte je Angebot, übernommene Gruppen; **keine** Wunschlisten, Zuteilungen, Begründungen oder Übernahme-Vorschau einzelner
Schüler:innen (für Lehraufträge – Gruppe, Fach, Stunden, Lehrkraft – nicht nötig; DATENSCHUTZ §Kurswahlen), keine Schreibaktion.
`kurswahl.manage` schließt Lesen ein (`canViewKurswahl`). „Vorgeschlagene Lehraufträge anlegen“ = `stundenplan.manage` + (`kurswahl.view` oder
`.manage`). Migration 0092 gibt `kurswahl.view` der Funktionsgruppe (`g-stundenplanung`, nur mit Slug `stundenplanung` – wie 0088 keine stille
Ausweitung auf eine fremde Gruppe gleichen Namens), idempotent, sonst keine Grants; Seed ebenso. Navigation „Kurswahlen“ für Beschäftigte mit
`view` oder `manage`. Das Sekretariat (nur `kurswahl.manage`) sieht weiter „legt die Stundenplanung an“.

**Umsetzungsstand SP-06 (2026-10-19, Migration 0094 – 0093 hat BU-04 belegt):** `timetable_solver_runs` um `label`, `params` (`{ effort, seed, weights, preset }`),
`metrics`, `log` (≤ 50 Einträge), `cancel_requested`, `heartbeat_at`, `applied_by`/`applied_at`, `undo` (Spalte für SP-09) erweitert, Status-Enum
um `queued`/`cancelled` (hinten angefügt, Vorgabe bleibt `running`); `timetable_lessons.solver_run_id` (`on delete set null`, Index) wird bei der
Übernahme gesetzt. **Ausführung** (`solverlauf.ts`): `createRun` prüft die Eingabe (L-02: Zeitraster, Lehraufträge mit Gruppe, aktive Räume →
Hinweis statt Lauf) und legt den Lauf als `queued` an; `executeQueued` rechnet unter der Job-Sperre `solver` (TTL 2 min, je Heartbeat verlängert –
`runExclusive` reicht dafür `lock.extend()` durch) den ältesten wartenden Lauf, dann den nächsten (eine Sperrlogik, L-03). Zeitscheiben ~25 ms +
`setImmediate`, auch die Konstruktion (Schwierigkeit und Platzierung in Scheiben); Heartbeat jede Sekunde schreibt Fortschritt/`heartbeat_at`, verlängert
die Sperre und liest `cancel_requested`. Abbruch: wartend → `cancelled` sofort; während der Konstruktion → `cancelled` ohne Ergebnis; danach → `done`
mit Vermerk „vorzeitig beendet bei x %“ (`metrics.cancelledAt`). Serverstart: `running` → `failed` („Server neu gestartet“), danach `executeQueued`;
Takt `startSolverQueue` (30 s, nur mit Jobs) sammelt verwaiste Läufe ohne Lebenszeichen seit 5 min ein (`reapStaleRuns`) und startet Wartende, wenn
die Sperre eines anderen Prozesses frei wird. Nachtjob `solver-aufraeumen` (03:00): `failed`/`cancelled` ohne Ergebnis nach 7 Tagen weg, je Schuljahr
nur die neuesten 20 `done` mit `result`, ältere nur `metrics`/`log` („Ergebnis entfernt“, `applyRun` lehnt sie ab); `deleteRun`/`cancelRun` mit Audit
`stundenplan.solver.delete`/`.cancel`. Gewichtungs-Voreinstellungen `WEIGHT_PRESETS` (ausgewogen, lehrkräfteschonend, klassenkompakt, raumtreu) +
„eigene“ (alle acht Felder inkl. `lateFrom`, geprüft in `parseParams`). Die Solver-Seite zeigt vorerst nur Status `wartet`/`abgebrochen`, den Abbruch-Knopf
und den Vermerk – alles Weitere ist SP-07.
**Kern-Ergänzungen (§6.3):** `units[].parts[]` (Q-SP-13: je Teil Lehrauftrag, Gruppen, Lehrkräfte, Fach, Raumwunsch/-art, Stammraum, Größe; heute genau ein
Teil je Einheit, `unitParts()` ergänzt alte Läufe ohne Teile, `proposedLessons` erzeugt die Zeilen je Teil); **SP-G-04a** `SolverInput.breakAfter`
(große Pausen ≥ 20 min aus dem Zeitraster, `longBreaksAfter()` in `solver-check.ts`) – `span()` lässt keine Doppelstunde darüber zu (hart, auch in
`validate`); Diagnose meldet eine Doppelstunde über die große Pause als Hinweis (`info`), nur wenn der Lehrauftrag Doppelstunden vorsieht; die Setzhilfe
setzt Einzelstunden und braucht nichts; **SP-G-03** `precheck()` (Bedarf je Lehrkraft/Gruppe gegen Slots minus Sperrzeiten minus fixierte Stunden, je
Raumart gegen Räume × Slots, Doppelstunden-Paare) als Protokolleintrag `precheck` mit Fehlern/Warnungen, und je nicht gesetzter Einheit `causes[]`
(Beteiligter: frei/belegt/gesperrt von n Slots) + lesbarer Grund („kein Slot frei – Lehrkraft LIN: 0 von 30 Slots frei (25 belegt, 5 gesperrt) · …“);
**SP-G-13** Warnung „n Kurse mit Lehrauftrag ohne Mitglieder“ und **A/B-Warnung** (nicht fixierte A/B-Stunden mit Lehrauftrag) aus `checkInput()` im
Protokoll (`warning`); **SP-G-15** Benchmark `solver.benchmark.test.ts` (7-zügig 5–10 + 120 Oberstufenkurse in Schienen, 1 323 Einheiten/1 653 Stunden,
70 Lehrkräfte): Konstruktion 0,3 s, gesamt 0,9 s bei 40 000 Schritten, 9 Einheiten (0,7 %) nicht gesetzt – alle Oberstufenkurse mit dichten
Konfliktmengen über Schienen hinweg (das löst erst die Blockung, SP-G-24), Hohlstunden Klassen 13 (max. 3), Lehrkräfte 169 (max. 10). Die Konstruktion
bewertet die Schwierigkeit jetzt einmal je Einheit statt im Sortier-Vergleich (gleiche Reihenfolge, ~10× schneller). Messwerte Zeitscheiben: `LASTTEST.md`
„Solver-Lauf im App-Prozess“; Q-SP-9 bleibt bei „im Prozess“ (kein Worker-Thread nötig).

**Umsetzungsstand SP-09 (2026-10-20, ohne Migration – Spalte `undo` kam mit 0094):** **Übernahme** (`applyRun`): Stichtag muss ein Schultag sein
(`SchoolCalendar.isSchoolDay`; Wochenende/Feiertag/Ferien → Fehler „kein Schultag (…) – nächster Schultag: JJJJ-MM-TT“, L-08); vor dem Übernehmen zeigt
die Detailseite für den vorgeschlagenen Stichtag (`applyPreview`), wie viele Stunden am Vortag enden, wie viele später beginnende entfallen, wie viele
Vertretungen ab dem Stichtag entfallen (sie kommen beim Zurücknehmen nicht zurück) und ob der Vorschlag Räume belegt, in denen ab dem Stichtag
Raumbuchungen oder Klausuren liegen. In **einer Transaktion** werden ersetzbare Stunden (nicht fixiert, mit Lehrauftrag) am Vortag beendet bzw.
gelöscht (wenn sie erst ab dem Stichtag beginnen), Vertretungen ab dem Stichtag daran entfernt, die Vorschlagsstunden mit `solver_run_id` angelegt und am
Lauf `undo` (`ended[]` mit altem `valid_until`, `deleted[]` vollständig, `removedSubstitutions`), `applied_by`/`applied_at` und ein Protokolleintrag
`apply` geschrieben; der Statuswechsel ist bedingt (`done → applied`, sonst „inzwischen verändert“). **Zurücknehmen** (`undoApply`, Audit
`stundenplan.solver.undo`), nur solange der Stichtag in der Zukunft liegt und `undo` vorhanden ist (`isUndoable`): alle Stunden des Laufs weg (nur die
eigenen – auch wenn sie seit der Übernahme verschoben, fixiert oder umbesetzt wurden; Vertretungen und Vertretungsmaterial daran gehen per Cascade mit,
Klassenbucheinträge verlieren nur den Bezug), beendete Stunden wieder bis zu ihrem früheren Ende verlängert – **nur**, wenn sie noch so enden, wie die
Übernahme sie hinterlassen hat (inzwischen gelöschte oder von Hand veränderte bleiben, wie sie sind), entfernte Stunden mit alter ID wieder angelegt
(fehlt inzwischen Gruppe oder Fach, entfällt die Stunde; gelöschte Lehrkraft/Raum wird leer); nach der Übernahme von Hand angelegte Stunden bleiben. Der
Lauf ist danach wieder `done` (erneut übernehmbar), `appliedFrom/By/At` und `undo` leer, Protokolleintrag `undo`. `undoPreview` zählt all das vorher
(veränderte, fremde, nicht wiederherstellbare Stunden, Vertretungen, Klassenbuch, Material, Raumbuchungen/Klausuren in Räumen des alten Plans) und die
Detailseite erklärt es vor der Rückfrage. **Löschsperre:** `canDeleteRun(run, heute)` – übernommene Läufe sind nicht löschbar, solange sie zurücknehmbar
sind (Löschen nähme die Rücknahme-Daten mit); Nachtjob `solver-aufraeumen` leert `undo` ab dem Stichtag (`undoCleared`, Personenbezug: Lehrkraft-IDs an
entfernten Stunden; DATENSCHUTZ §3.4, SICHERHEIT S79). Läufe, die vor SP-09 übernommen wurden, haben kein `undo` → nicht zurücknehmbar, löschbar wie
bisher. ~~Nicht zurückgeholt werden bewusst die bei der Übernahme entfernten Vertretungen~~ → seit **SP-13** (Q-SP-9-1, Projektleitung 2026-10-20) stehen sie vollständig in `undo.substitutions` und kommen beim Zurücknehmen mit alter ID zurück, sofern ihre Stunde an dem Tag wieder gilt (wieder verlängert, wieder angelegt oder von Hand noch gültig); `undoPreview`/Rückfrage nennen `restoredSubstitutions` und `lostSubstitutions`. Bänder/Kopplungen: jede Vertretung hängt an einem Teil, die Teile kommen mit alter `coupling_id` zurück. Übernahmen vor SP-13 haben die Liste nicht – dort kommt keine zurück.
**SP-G-02 Raum je Kopplungsteil:** `unitsFrom` erzeugt bei einem Lehrauftrag mit mehreren Lehrkräften **einen Teil je Lehrkraft** (geteilte Klasse:
eigener Raum, Größe anteilig; die Gruppen bleiben in jedem Teil dieselben, die Einheit wird weiter als eine Kopplung gesetzt); `chooseRooms` vergibt
je Teil einen eigenen freien Raum (Wunschraum → Raumart → Stammraum → Klassenraum, nie einen Raum, den ein anderer Teil derselben Einheit schon hat),
Teile mit gemeinsamer Lehrkraft teilen sich den Raum; `Placement.roomIds[]` je Teil (`roomId` bleibt der Raum des ersten Teils – Läufe vor SP-09 haben
nur ihn, `placementRooms()` ergänzt), Raumbelegung/`validate`/Kosten (`noRoom`/`roomWish` je Teil, Posten nennen die Lehrkraft) je Raum, Vorprüfung
zählt den Raumbedarf je Teil; `proposedLessons` gibt jeder Zeile den Raum ihres Teils, die Übernahme legt sie als Kopplung mit zwei Räumen an. Ein Teil
je Einheit (Demo, Benchmark) ergibt dieselben Lösungen wie vorher (Determinismus und Benchmark-Zahlen unverändert, LASTTEST.md). Bekannt: `matchLessons`
zählt bei zwei Lehrkräften beide Zeilen auf die Gruppe („zu viel verplant“) – das ist das bestehende Zählmodell für Teamteaching/geteilte Klassen und
Thema für SP2-01/02 (Bänder), ebenso die Diagnose-Kapazität je Raum (nimmt die ganze Klasse je Raum).

**Umsetzungsstand SP-10 (2026-10-20, nur Doku/Test, keine Migration):** SICHERHEIT **S80 „Planungsrechte“** (zwei Rechte, Gruppe statt Rolle, `kurswahl.view`, 2FA sofort,
SEC-04, kein S28, ein Lauf gleichzeitig, Auskunft); `docs/STUNDENPLAN.md` neuer Abschnitt „0. Stand 2026-10“ (Bereich, Reiter, Läufe, Übernahme, Fachtausch,
Grenzen → SP2; §1 als „Ausgangslage“ gekennzeichnet); DATENSCHUTZ-Zeile Solver-Läufe um **Auskunft** und **Kontolöschung** ergänzt; `processing.note` nennt Läufe und
Fachtausch. **Auskunfts-Test** (`auskunft.test.ts` „SP-10 …“): die planende Person bekommt zu Läufen nur die Handlung (nie `result`/`params`/`metrics`/`log`/`undo`/`label`),
die vertretende Lehrkraft die Vertretung samt Fach, kein Entwurf wird einer Lehrkraft zugeordnet. Bewusst hingenommene Lücke: Lehrkraft-IDs in den JSON-Feldern der
Läufe haben keinen Fremdschlüssel und werden bei Kontolöschung nicht bereinigt (LK-90, `undo` bis zum Stichtag; nach der Löschung nicht auflösbar) – **seit SP-14** (Q-SP-9-2) ersetzt die Kontolöschung (auf Antrag `deleteAccounts` wie im Löschlauf, je in der Transaktion vor dem Löschen) jede Kennung des Kontos in `params`/`result`/`undo`/`log` (als Wert oder Schlüssel) durch den Platzhalter „gelöschte Lehrkraft“ (`solverlauf-konto.ts`); die Vorschau zeigt ihn, Diagnose-Texte nennen ihn, die Übernahme legt diese Stunden ohne Lehrkraft an, das Zurücknehmen behandelt ihn wie eine gelöschte Lehrkraft (leer). Kürzel in Texten (Kostenposten, Gründe, Vorprüfung) bleiben stehen. README/CLAUDE.md
(Demo-Login `frank.schulte`) waren seit SP-03 aktuell; INSTALLATION.md kennt keinen Stundenplan-Abschnitt (kein Handbuch im Repo) – Release-Hinweise zur Gruppe/2FA
gehören in die Notes zu v0.6.0 (GATE SP).

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
| **Übernahme als Entwurf / aktiver Plan** | wie heute **ab Stichtag** – ein Stichtag in der Zukunft **ist** der Entwurf (bis dahin gilt der alte Plan). Neu: `timetable_lessons.solver_run_id` (Herkunft, `on delete set null`), `undo` JSONB am Lauf (beendete Stunden mit altem `valid_until`, Anzahl gelöschter Vertretungen), Status `applied` mit `applied_by`/`applied_at`. **„Übernahme zurücknehmen“** solange der Stichtag in der Zukunft liegt: gesetzte Stunden des Laufs löschen, `valid_until` der beendeten wiederherstellen → Status `done`; gelöschte Vertretungen kommen ~~nicht~~ seit SP-13 zurück, sofern ihre Stunde wieder gilt (Hinweis vor der Übernahme nennt die Zahl). Stichtag muss ein Schultag sein (Ferien/Wochenende → Fehler mit Vorschlag `nextSchoolDay`) |
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
| – | Exporte/Drucke/Statistiken (L-16) → Folgeblock SP2 (SP-G-14, §7); Warmstart des Solvers vom aktuellen Plan, Vorschau je Raum, Lauf-Favoriten | **nicht hier** → Ideen-Board |

---

## 5. Umsetzungsrunden (je ein mergebarer PR)

Reihenfolge und Abhängigkeiten; jede Runde `npm run check` grün, UI-Runden zusätzlich `npm run verify` (Build + E2E).
**Kern** = Solver-Kernlogik (stärkeres Modell erlaubt). Größen wie im BACKLOG (S/M/L).

| ID | Titel | Größe | Modell | hängt ab von | Migration | Tests |
|---|---|---|---|---|---|---|
| **SP-01** | Plan-Dokument, BACKLOG-Block, QUESTIONS, PLAN §0 (dieser PR) | S | Opus | – | – | – |
| **SP-02** ✅ | Rechte: `stundenplan.substitute`, Gruppe „Stundenplanung“, Verwaltung ohne Vorgabe, Migration 0088, 2FA, Actions/Seiten/`open.ts`/Gebäude auf das passende Recht, Seed (Gruppe + `frank.schulte`, Schulleitung `substitute`), Rechte-Hinweis; Anrechnungsgrund „Stundenplanung“ | M | Opus | SP-01 | **0088** (Enum `reduction_reason` + Daten: Grants + Gruppe) | `permissions.test`, `registry.test`, `escalation.test`, `open-items.test`, `seed.test`, Migrationstest Grants |
| **SP-03** ✅ | Bereich `/planung`: Layout, `@schulos/ui/sub-nav`, Umzug der sechs Seiten (`git mv`), Nav-Eintrag, Eyebrow, `revalidatePath`/`redirect`-Pfade, `redirects()` in `next.config.ts`, Verwaltung ohne die vier Reiter, E2E/a11y/Unit-Tests auf neue URLs, CLAUDE.md/README Demo-Login | L | Opus | SP-02 | – | `npm run verify`; E2E „alte URL leitet weiter“, „Sekretariat sieht `/planung` nicht“ |
| **SP-04** ✅ | Übersicht `/planung` (Kacheln aus vorhandenen Services, Links, Leerzustände), Kachel in der Verwaltungs-Übersicht, mobiler Durchgang der Planungsseiten mit `shot.mjs --mobile` | S | Opus | SP-03 | – | Service-Test der Kachel-Zahlen, E2E Übersicht, a11y-Pfade |
| **SP-05** ✅ | Rechte- statt Rollen-Gates: `isStaffRole()` in `core/roles.ts`, `stundenplan/page.tsx` und `raeume/page.tsx` ohne `STAFF`-Liste, Sperren-Reiter an `substitute` | S | Opus | SP-02 | – | `registry.test` (Navigation), E2E „Personal sieht Wochenplan/Räume“ |
| **SP-06** ✅ (**Kern**) | Solver-Läufe Datenmodell + Ausführung: Migration 0089 bzw. nächste freie Nummer (`label`, `params`, `metrics`, `log`, `cancel_requested`, `heartbeat_at`, `applied_by`/`applied_at`, `undo`, Status `queued`/`cancelled`, `timetable_lessons.solver_run_id`), Zeitscheiben statt fester Blöcke, Heartbeat-Sperre, Warteschlange, Abbruch, Startup (queued weiter, running → failed), Validierung vor dem Start, Nachtjob `solver-aufraeumen`, Messung der Antwortzeiten während eines Laufs. **Aus der Gap-Analyse (§6.3):** Einheiten-/`result`-Format bandfähig (`units[].parts[]`, Q-SP-13), Machbarkeits-Vorprüfung + konkrete Gründe „nicht gesetzt“ (SP-G-03), Doppelstunde nicht über große Pause/Mittag (SP-G-04a), Warnung „Kurse mit Lehrauftrag ohne Mitglieder“ (SP-G-13), Warnung vor A/B-Stunden mit Lehrauftrag, synthetischer Groß-Benchmark (SP-G-15) | M | **Fable** | SP-03 | **0089** (oder nächste freie) | `solverlauf.test` (Warteschlange, Abbruch vor/nach Konstruktion, Heartbeat, Aufräumen, Validierung, Vorprüfung), `solver.test` (Doppelstunde über Pause, Gründe je Einheit, `parts`), Benchmark-Test, `retention.test` |
| **SP-07** ✅ | Solver-Läufe UI: Liste aller Läufe (Filter), Start-Formular mit Bezeichnung/Gründlichkeit/Startwert/Gewichtungs-Voreinstellung + „eigene“ (alle Felder von `SolverWeights` **plus `lateFrom`**, SP-G-16), Detailseite `/planung/solver/[id]` (Fortschritt, Protokoll, Konflikte vollständig **mit Grund je Einheit** aus SP-G-03, Ergebnis der Vorprüfung, Kostenposten mit Filter, Vorschau Klasse **und** Lehrkraft), Abbrechen, Löschen | M | Opus | SP-06 | – | `npm run verify`; E2E Lauf starten → abbrechen → zweiter Lauf |
| **SP-08** ✅ | Vergleich `/planung/solver/vergleich?laeufe=…` (2–3 Läufe, bester Wert markiert, Delta, Vorschau nebeneinander) | S | Opus | SP-07 | – | Service-Test der Delta-Berechnung, E2E Vergleich |
| **SP-09** ✅ (**Kern**) | Übernahme: `solver_run_id` an Stunden, `undo` schreiben, „Übernahme zurücknehmen“ bis zum Stichtag, Stichtag = Schultag, Hinweis mit Zahl der entfallenden Vertretungen; Randfälle Kopplungen/A-B-Woche/Vertretungen am Stichtag; **Raum je Kopplungsteil** (SP-G-02: `chooseRoom` je Teil, gleiche Lehrkraft → gleicher Raum) | M | **Fable** | SP-06 | – (Spalten aus SP-06) | `solverlauf.test` (Übernahme/Zurücknehmen mit Kopplungen, bleibenden Stunden, Vertretungen), `solver.test` (geteilte Klasse mit zwei Lehrkräften → zwei Räume, bis zur Übernahme), E2E Übernahme → zurücknehmen |
| **SP-10** ✅ | Datenschutz + Doku: DATENSCHUTZ §3.4 Zeile, Manifest `retention`/`processing`, SICHERHEIT S-xx, STUNDENPLAN.md „Stand 2026-10“, VVT-/Auskunftstest | S | Opus | SP-09 | – | `retention.test`, VVT-Snapshot, Auskunftstest |
| **SP-12** ✅ | **Vertretung mit abweichendem Fach** („Fachtausch“, SP-G-Fachtausch, §6.4): `timetable_substitutions.subject_id` (nullable, nur bei `substitute`, Check-Constraint), Formularfeld „Fach“, Vorschlag „kennt die Klasse → eigenes Fach“ (+10, Knopf übernimmt Lehrkraft **und** Fach), Anzeige „Mathe statt Sport“ in allen Plänen/Tagesleiste/Vertretungsplan/Druck/Monitor, Gong-Text, Klassenbuch-Eintrag mit tatsächlichem Fach, Statistik-Zähler „davon mit eigenem Fach“, Klausur-Hinweis im Formular, DATENSCHUTZ §3.4/STUNDENPLAN §2.3 | M | Opus | SP-03 (Recht `substitute` aus SP-02, Seiten unter `/planung/vertretungen`) | nächste freie Nummer (Spalte + Check) | `vertretung.test`, `vorschlaege.test`, `display.test`, `vertretung-gong.test`, Klassenbuch-Test, E2E `vertretungsbedarf.spec.ts` erweitert |
| **SP-11** ✅ | E2E-Szenario „Stundenplaner:in“ (Login `frank.schulte` → Übersicht → Lauf mit Parametern → Abbruch → zweiter Lauf → Vergleich → Übernahme ab Stichtag → zurücknehmen; **Vertretung mit Fachtausch**; Sekretariat 404 auf `/planung`; alte URLs leiten weiter) + **Review-PR GATE SP** (erledigte IDs, Tests, Fragen) | S | Opus | SP-10, SP-12 | – | `e2e/zx-gate-sp.spec.ts` |
| **GATE SP** | Review mit der Projektleitung (Review-PR aus SP-11; `/code-review ultra` nach Wunsch) – merged nur die Projektleitung | – | – | SP-11 | – | – |

Reihenfolge: SP-02 ✅ → SP-03 ✅ → SP-04 ✅ → SP-05 ✅ → SP-06 ✅ ‖ SP-12 ✅ → SP-07 ✅ → SP-08 ✅ ‖ SP-09 ✅ → SP-10 ✅ → SP-11 ✅ → **GATE SP** (Prüfliste §5.2).
Parallelisierbar: SP-05 neben SP-03; SP-12 neben SP-06/SP-07 (kein Solver-Kern, berührt nur das Tagesgeschäft); SP-08 neben SP-09.
Migrationsnummern werden in der Reihenfolge des Mergens vergeben (SP-06 und SP-12 nehmen jeweils die nächste freie Nummer).
Zwischenstand zum Melden nach SP-04 (Bereich steht, Verwaltung aufgeräumt) und nach SP-07 (Läufe bedienbar). Release-Vorschlag nach
GATE SP: **v0.6.0** (Rechteänderung + Migrationen → Minor, Release-Notes mit dem Hinweis zur Gruppe „Stundenplanung“, zur 2FA-Pflicht
für Planende und zur „Vertretung mit abweichendem Fach“).

### 5.1 Prüfliste je Runde

- Manifest-Rechte deklariert, `defaultGrants` nur deklarierte Rechte (`registry.test`), neue Tabellenspalten mit Personenbezug im
  `retention`-Eintrag (Kategorien), `npm run veroeffentlichen:pruefen` grün.
- Server Actions prüfen das **passende** Recht (`manage` vs. `substitute`), Seiten dasselbe wie die Actions.
- `revalidatePath`/`redirect` auf neue Pfade; alte Pfade nur noch in `redirects()` und Tests.
- E2E-Tests mit dem Planungs-Login, nicht mit dem Sekretariat.
- Doku-Nachträge (LOG, Abhaken) im selben PR.

### 5.2 GATE SP – Prüfliste (2026-10-20)

Umfang: SP-01 … SP-12 (PRs #21, #23, #29, #31, #33, #35, #37, #40, #43, #45, #46, SP-11 #48; dazu die Fixes #42 2FA-Stichtag
mit Berliner Datum und #44 `next dev` in instrumentation.ts), Migrationen **0088** (Planungsrechte, Gruppe, Anrechnungsgrund), **0092**
(`kurswahl.view`), **0094** (Solver-Läufe), **0096** (Fachtausch); SICHERHEIT S79/S80; DATENSCHUTZ §3.4. Abnahme: Review-PR, merged die
Projektleitung.

| # | Prüfpunkt | Ergebnis |
|---|---|---|
| 1 | Rechte: Actions und Seiten prüfen das **passende** Recht | ✅ Durchsicht `stundenplan/actions.ts`: alle Jahresplanungs-Actions (Pflege, Verteilung, Deputate, Zeitwünsche der Planung, Aufsichtsplan, Solver starten/abbrechen/löschen/übernehmen/zurücknehmen) mit `stundenplan.manage`, alle Tages-Actions (Vertretungen, Abwesenheiten, Vorschläge, Veröffentlichen, Raumsperren, Aufsichtsvertretung) mit `stundenplan.substitute`; Seiten unter `/planung` dieselben Rechte (sonst 404), Status-API `/api/stundenplan/solver/status` nur `manage` (403). Tests `permissions`, `registry`, `escalation`, E2E `planung.spec.ts`, `zx-gate-sp.spec.ts` |
| 2 | Gruppe statt Rolle, Verwaltung ohne Vorgabe, Migration ohne Rechteverlust | ✅ Migration 0088 (zu jedem `manage`-Grant ein `substitute`-Grant, Gruppe „Stundenplanung“ ohne Mitglieder, Rollen-Grant bleibt mit Hinweis), Migrationstest; Demo: Sekretariat plant nicht mehr, `frank.schulte` in der Gruppe |
| 3 | 2FA sofort für beide Planungsrechte | ✅ `requiresTwoFactor` (permissions.test „SP-02 …“), S80; Demo-Instanzen ausgenommen (wie alle 2FA-Pflichten) – E2E prüft den Hinweis „in einer echten Schule Pflicht“ für das Planungskonto |
| 4 | Bereich `/planung`, alte Pfade, Sekretariat | ✅ E2E: Navigation, Reiter je Recht, Übersicht mit Kacheln, 307-Weiterleitungen alter `/verwaltung/…`-Pfade (Query bleibt), Sekretariat 404 auf `/planung`, Solver-Detail, Vergleich und alte Lesezeichen |
| 5 | Solver-Läufe: ein Lauf gleichzeitig, Warteschlange, Abbruch, Heartbeat, Aufräumen, Antwortzeiten | ✅ `solverlauf.test.ts` (Warteschlange, Abbruch vor/nach Konstruktion, Heartbeat, Startup, Nachtjob, Validierung, Vorprüfung), `solverlauf.latenz.test.ts` (Ereignisschleife frei, Zeitscheiben ~25 ms; kein Worker-Thread nötig, Q-SP-9), Groß-Benchmark (LASTTEST.md) |
| 6 | Übernahme ab Stichtag und Zurücknehmen | ✅ `solverlauf.test.ts` (Kopplungen, bleibende Stunden, Vertretungen, Konflikte), E2E SP-09 und Gesamtszenario: Sonntag abgelehnt mit nächstem Schultag, Plan ab Stichtag neu, Kachel „übernommen · gilt ab“, Löschsperre, Zurücknehmen → Plan wie vorher |
| 7 | Vertretung mit abweichendem Fach | ✅ `fachtausch.test.ts`, `vertretung`/`vorschlaege`/`display`/`vertretung-gong`, E2E SP-12 und Gesamtszenario „Mathematik statt Sport“ (Klasse, Druck, Monitor, Schülerin) |
| 8 | Datenschutz/Veröffentlichung | ✅ `retention.test.ts`, Auskunftstest SP-10, VVT, `npm run veroeffentlichen:pruefen` 0 Fehler |
| 9 | A11Y und Mobil | ✅ `a11y.spec.ts` (Planungsseiten je Rolle) und **neu** im Gesamtszenario: 12 Planungsseiten inkl. Läufe-Detail, Vergleich, Vertretungsstatistik, Diagnose hell **und** dunkel ohne axe-Befund; Vergleich auf 360 px ohne Seitenüberlauf (Tabellen scrollen im Rahmen); Vergleichsseite mobil hell/dunkel per `shot.mjs` gesichtet, ohne Umbruchfehler |
| 10 | Volle Tests | ✅ `npm run check`: 2192 Vitest in 298 Dateien grün (2 bekannte Last-Flakes `solverlauf.latenz`, `boot-hardening` einzeln wiederholt grün; neuer Last-Fehler `disclaimer.test.ts` behoben, #48); Build grün; volle E2E (Port 3140): 294 bestanden, 1 übersprungen, ohne Ausfall; Backupserver-E2E 4; CI des SP-11-PRs grün |
| 11 | Bekannte, bewusst hingenommene Lücken | ⏳ blockieren das Gate nicht: bei der Übernahme entfernte Vertretungen kommen beim Zurücknehmen nicht zurück (Hinweis nennt die Zahl) – **behoben mit SP-13**; Lehrkraft-IDs in den JSON-Feldern der Läufe werden bei Kontolöschung nicht bereinigt (LK-90) – **behoben mit SP-14**; `matchLessons` zählt geteilte Klassen mit zwei Lehrkräften doppelt („zu viel verplant“) → SP2-01/02 (Bänder) |
| 12 | Release | ⏳ Vorschlag **v0.6.0** nach dem Merge (Rechteänderung + Migrationen). Release-Notes: neue Funktionsgruppe **„Stundenplanung“** (Rechte `stundenplan.manage` + neu `stundenplan.substitute`; bestehende Rollen-Grants bleiben, Empfehlung: Planende in die Gruppe aufnehmen, Rollen-Grant entfernen); **2FA-Pflicht sofort** für alle mit Planungsrecht (vor dem Update Betroffene informieren, sonst sperrt die Pflicht sie bis zur Einrichtung); neuer Bereich `/planung` (alte Lesezeichen leiten weiter); Solver-Läufe (Parameter, Abbruch, Vergleich, Zurücknehmen); Vertretung mit abweichendem Fach |

---

## 6. Gap-Analyse gegen verbreitete Stundenplan-Software (2026-10-19)

Abgleich des Stundenplanmoduls samt Solver mit dem Funktionsumfang verbreiteter kommerzieller und quelloffener
Stundenplan-Software (Marktführer im deutschsprachigen Raum, gegengeprüft an drei weiteren Programmen). Leitlinie der
Projektleitung: „so einfach wie möglich, aber einen großen Teil abdecken“. Entscheidungen: Q-SP-13 … Q-SP-16 (Projektleitung 2026-10-19).

### 6.1 Ergebnis in Kürze

Der **Kern** für eine typische Sek-I-Schule ist heute schon gut und durchgängig abgedeckt: Stammdaten, Unterrichtsverteilung mit
Soll/verplant, Deputate mit Anrechnungen, Zeitwünsche −3…+3/gesperrt (Lehrkraft, Klasse, Raum, Fach), Kopplungen, Setzhilfe,
Diagnose, Solver mit erklärbarer Bewertung, Übernahme ab Stichtag, Vertretungsplanung mit Vorschlägen/Statistik/Freigabe,
Aufsichten, Räume, Drucke, Monitor, Gong (auch an Eltern). Echte Lücken liegen an drei Stellen: **Bänder/heterogene Kopplungen
im Solver** (E-/G-Kurse, WP, Religion/Philosophie, Oberstufen-Schienen), **Tagesregeln** (max. Stunden/Tag, Nachmittage,
Mittagspause, Doppelstunde über die große Pause) und **Vertretung Stufe 2** (Verlegung, Zusammenlegung, Bereitschaft,
Dauervertretung). Dazu der Zusatzwunsch **Vertretung mit abweichendem Fach**.

### 6.2 Abgleichstabelle (kompakt)

Lücke: **ja** = fehlt · **teilw.** = vorhanden mit Einschränkung · **nein** = abgedeckt · **bewusst** = Entscheidung gegen die Funktion.

| Bereich / Funktion | SchulOS heute | Lücke | Einordnung |
|---|---|---|---|
| Stammdaten, Stundentafel, Unterrichtsverteilung Soll/verplant, Deputat mit Anrechnungen, Zeitwünsche (inkl. Selbsteingabe) | ja | nein | – |
| Perioden/Halbjahreswechsel | Periode kopieren, Übernahme ab Stichtag | nein | SP-09 zurücknehmbar |
| Lehrauftrag mit Gültigkeit (Halbjahr, Epoche) | nein (nur Notiz) | ja | SP2 (SP-G-07) |
| A/B-Wochen | manuell ja, Solver nur `all` | teilw. | Warnung in SP-06; Solver-Unterstützung Kann (SP-G-17) |
| Kopplung heterogen (manuell) | ja | nein | – |
| **Bänder im Lehrauftrag und Solver** (E/G, WP, Reli/Philo, Oberstufen-Schienen) | nein: 1 Fach, Gruppen × Lehrkräfte kartesisch | **ja (größte Lücke)** | SP2 (SP-G-01); Format in SP-06 bandfähig |
| Raum je Kopplungsteil (geteilte Klasse) | Solver: ein Raum für alle Teile | teilw. | SP-09 (SP-G-02) |
| Kollisionen, Fixieren, Fach-/Raumwünsche, Fach mehrfach am Tag | ja | nein | – |
| Doppelstunde nicht über große Pause/Mittag | nein | teilw. | SP-06 (SP-G-04a) |
| Hohlstunden Lehrkraft/Klasse | Gewicht fest | teilw. | SP-07 Gewichte |
| Hohlstunden bei Kursband/Oberstufe im Solver | nein (Diagnose ja) | ja | SP2 (SP-G-11) |
| Tagesgrenzen Klasse/Jahrgang, Nachmittage, Mittagspause (Ganztag) | nein (nur „späte Stunden“) | **ja** | SP2 (SP-G-04b) |
| Lehrkraft max. Stunden/Tag, Anwesenheitstage (Teilzeit) | nein | ja | SP2 (SP-G-05) |
| Fachverteilung über die Woche | nein | ja | SP2 (SP-G-06) |
| Gewichte einstellbar inkl. „späte Stunden ab“ | fest | nein nach SP | SP-07 (+ SP-G-16 `lateFrom`) |
| Machbarkeits-Vorprüfung, Grund je „nicht gesetzt“ | generischer Text | ja | SP-06/SP-07 (SP-G-03) |
| Warnung „Kurse ohne Mitglieder“, Groß-Benchmark | nein | ja | SP-06 (SP-G-13, SP-G-15) |
| Varianten vergleichen, Abbruch, Historie | teilw. | nein nach SP | SP-06 … SP-08 |
| Diagnose kennt Zeitwunsch-Verletzungen | nein | ja | SP2 (SP-G-12) |
| Vertretung: Abwesenheit, Vorschläge, Entfall/Vertretung/Raum, Statistik, Freigabe, Gong | ja | nein | – |
| **Vertretung mit abweichendem Fach** | nein (`subject_id` fehlt) | **ja (Zusatzwunsch)** | **SP-12 vor GATE SP** |
| Verlegung, Zusammenlegung, Bereitschaft | nein | ja | SP2 (SP-G-08) |
| Dauervertretung, Wochenblick Vertretungsbedarf | nein | ja | SP2 (SP-G-09, SP-G-10) |
| Gesamtübersichten, Druck Verteilung/Deputate/Aufsichtsplan, CSV | nein | ja | SP2 (SP-G-14) |
| Einstieg für Umsteiger | Lehraufträge aus Handplan | teilw. | SP2: CSV-Import der Unterrichtsverteilung (Q-SP-14) |
| Lehrbefähigung, Wertrechnung/Faktoren, faire Aufsichtsverteilung, ICS-Abo, Matrix-Ansicht, Epochen | nein | Kann | nur auf Nachfrage (SP-G-17 … SP-G-23) |
| Oberstufen-Blockung aus Kurswahlen | Kurswahl → Gruppen + Lehraufträge | ja | eigene Phase nach SP2 (SP-G-24, braucht Bänder) |
| Mehrere Zeitraster/Minutenplan/Samstag · Standorte/Wegezeiten/Abteilungen · Mehrarbeits-Abrechnung · Import/Export im Austauschformat fremder Software · Plan-Versionen | nein | **bewusst** | nicht geplant (Q-SP-16) |

### 6.3 Ergänzungen vor GATE SP (in bestehende Runden, je klein)

| ID | Ergänzung | Runde |
|---|---|---|
| SP-G-03 | Machbarkeits-Vorprüfung vor dem Lauf (je Lehrkraft/Gruppe Bedarf vs. freie, ungesperrte Slots inkl. fixierter Stunden; je Raumart Bedarf vs. Räume × Slots) als Hinweis bzw. Protokoll-Warnung; konkreter Grund je nicht gesetzter Einheit aus der `feasible()`-Zählung („Lehrkraft in 0 von 45 Slots frei“, „Sperrzeit Klasse“) | SP-06 (Logik), SP-07 (Anzeige) |
| SP-G-04a | Doppelstunde nicht über große Pause/Mittag: `doublePairs` aus dem Zeitraster (Pause ≥ 20 Min trennt), `span()` prüft das Paar; Setzhilfe/Diagnose gleich mit | SP-06 |
| SP-G-13 | Warnung „n Kurse mit Lehrauftrag ohne Mitglieder – Konflikte unbekannt“ | SP-06 |
| SP-G-15 | Synthetischer Benchmark (große Schule, ~1 500 Einheiten) mit Laufzeit, nicht gesetzt, Hohlstunden; Grenzwert dokumentieren | SP-06 |
| Qualität A/B | Warnung vor dem Lauf, wenn A/B-Stunden mit Lehrauftrag nicht fixiert sind (die Übernahme würde sie ersetzen) | SP-06 |
| Q-SP-13 | Einheiten-/`result`-Format bandfähig: `units[].parts[]` (je Teil Gruppe(n), Lehrkraft, Fach, Raum) statt flacher `groupIds × teacherIds` – Bänder selbst erst in SP2 | SP-06 |
| SP-G-16 | `lateFrom` als zusätzliches Feld der „eigenen“ Gewichte | SP-07 |
| SP-G-02 | Raum je Kopplungsteil (gleiche Lehrkraft → gleicher Raum), Test bis zur Übernahme | SP-09 |
| SP-G-Fachtausch | Vertretung mit abweichendem Fach (§6.4) | **SP-12** (neu) |

### 6.4 SP-12 – Vertretung mit abweichendem Fach (Zusatzwunsch Projektleitung 2026-10-19)

Wunsch: „Bei den Vertretungen soll auch ein abweichendes Fach möglich sein, nicht nur eine Arbeitsaufgabe. Aus Sport darf also auch
mal Mathe werden, gerade wenn es eine Lehrkraft gibt, die frei ist und die Klasse schon kennt.“ Heute hat `timetable_substitutions`
kein Fach; alle Anzeigen nehmen das Fach der regulären Stunde.

| Baustein | Umsetzung (so einfach wie möglich – ein Feld, kein neuer `kind`) |
|---|---|
| Datenmodell | `timetable_substitutions.subject_id` nullable, FK `subjects.id`; leer = reguläres Fach; Check `subject_id is null or kind = 'substitute'` (bei Entfall/Raumänderung serverseitig `null`). Migration: nächste freie Nummer. Löschklasse folgt der Vertretung |
| Speichern | `SubstitutionInput.subjectId`; Fach muss existieren, gleiches Fach wie die Stunde → `null`; bei Kopplungen für alle Teile derselben Lehrkraft; Audit nennt das Fach |
| Formular | Feld „Fach“ (Vorgabe reguläres Fach) neben „Vertretung durch“, nur bei Vertretung aktiv; Hinweis, wenn die Gruppe an dem Tag eine Klausur im gewählten Fach hat |
| Vorschläge | je Kandidat `suggestedSubjectId` = Fach, das die Lehrkraft regulär in dieser Gruppe gibt (bei mehreren das mit den meisten Wochenstunden); Grund „kann eigenes Fach geben: Mathe“ (+10) nur, wenn sie die Gruppe kennt, aber nicht das ausgefallene Fach unterrichtet – und (**SP-15**, Q-SP-9-3, 2026-10-21) nur, wenn keine freie Lehrkraft das ausgefallene Fach unterrichtet (`scoreCandidates`: `sameSubjectFree`; das Formularfeld „Fach“ bleibt frei wählbar). Rangfolge bleibt: frei durch Freisetzung > kennt Klasse > kennt Fach > Hohlstunde. Knopf „→ Mathe“ übernimmt Lehrkraft **und** Fach |
| Anzeige | Slot zeigt das abweichende Fach (Name/Farbe) mit „statt Sport“: Mein Stundenplan, Tagesleiste, Klassen-/Lehrkraft-/Raumplan, Druck, Vertretungsplan, Druck Vertretungsplan, Monitor („Mathe (statt Sport)“) |
| Gong | „Vertretung Di, 3. Std: Mathe statt Sport (7b) …“, Eltern-Bündelung unverändert |
| Klassenbuch | Eintrag der Vertretungsstunde trägt das tatsächliche Fach |
| Statistik | Zähler „davon mit eigenem Fach“ in Vertretungsstatistik und Mein Deputat (rein informativ) |
| Ohne Wirkung | Notenbuch (hängt an Lehraufträgen), Unterrichtsverteilung, Solver |
| Bewusst nicht | eigener `kind` „Fachtausch“, Fachwechsel bei Entfall/Raumänderung, Verrechnung im Deputat, automatische Übernahme des Vorschlags |

**Umgesetzt (SP-12, Migration 0096):** Spalte `subject_id` + Check `timetable_substitutions_subject`; `listSlots` setzt bei Fachtausch Fach/Farbe des Slots auf das tatsächliche Fach (außer in der Sicht „away“ der abgebenden Lehrkraft) und trägt `change.insteadOf`; `slotDisplay` zeigt darunter „statt Sport“, `substitutionsOn`/Vertretungsplan/Druck „Mathe statt Sport“, Monitor „Mathe (statt Sport)“, Gong „Vertretung Mo., 3. Std: Mathe statt Sport (7b)“. Vorschlag: `suggestedSubject` = Fach mit den meisten Wochenstunden der Lehrkraft in der Gruppe (A/B halb), zweiter Knopf „→ Mathe“ neben „übernehmen“. Klassenbuch-Eintrag mit tatsächlichem Fach (auch Kopplungsteile; Fehlzeiten je Fach folgen). Zähler „davon mit eigenem Fach“ in Statistik (Lehrkräfte + Klassen) und Mein Deputat. Klausur-Hinweis: `examSubjectsOn()` (nur Fach + Art, keine Titel). Notenbuch/Verteilung/Solver unberührt.

---

## 7. Folgeblock „SP2 – Planungstiefe“ (nach GATE SP, eigener GATE)

Entscheidungen der Projektleitung 2026-10-19 (Q-SP-13 … Q-SP-16): Zielschule ist **jetzt Sek I sauber**; Bänder (heterogene
Kopplung, E/G, WP, Reli/Philo, Oberstufen-Schienen) und Tagesgrenzen/Ganztag kommen im Folgeblock SP2. Dazu der CSV-Import der
Unterrichtsverteilung (nur Lehraufträge – kein Import von Plänen oder fremden Austauschformaten) und die Vertretung Stufe 2.
Reihenfolge nach Abhängigkeit, Feinplanung (Migrationen, Tests) beim Start des Blocks. **Kern** = Solver-Kernlogik.

| ID | Titel | Größe | Kern | hängt ab von | Quelle |
|---|---|---|---|---|---|
| **SP2-01** ✅ | Bänder – Datenmodell und Unterrichtsverteilung: `timetable_bands` (Schuljahr, Name, Wochenstunden, Doppelstunden) mit n Lehraufträgen als Mitglieder; Lehraufträge bleiben 1 Fach, 1 Gruppe, 1–2 Lehrkräfte; „Gekoppelt mit“ wird zum Band; Pflege-UI, Soll/verplant je Band | M | – | GATE SP | SP-G-01 |
| **SP2-02** ✅ | Bänder im Solver, in Setzhilfe und Übernahme: Einheit = Band mit `parts[]` (eigene Lehrkraft/Fach/Raum je Teil), `chooseRoom` je Teil, eine `coupling_id` je Band-Stunde, Setzhilfe setzt/verschiebt das Band als Einheit; Kursband zählt für Klassen-Hohlstunden | L | **ja** | SP2-01 | SP-G-01 |
| **SP2-03** ✅ | Tagesgrenzen und Ganztag je Jahrgangsstufe: `maxPerDay`, `afternoonsPerWeek`, `lunchAfterPeriod` (Mittagspause Pflicht bei Unterricht danach), Vorgaben aus dem Schulform-Katalog; hart im Solver, Diagnose-Kategorie | M | **ja** | GATE SP | SP-G-04b |
| **SP2-04** ✅ | Lehrkraft-Tagesregeln und Fachverteilung: optional `maxPerDay`/`maxDays` je Lehrkraft (Deputats-Seite), weiche Kosten Anwesenheitstage; Kosten `subjectSpread` (nicht an Folgetagen geballt), Gewichte in den Voreinstellungen | S–M | **ja** | SP2-03 | SP-G-05, SP-G-06 |
| **SP2-05** ✅ | Hohlstunden Oberstufe/Kursband im Solver (Jahrgang ohne Klasse) + Diagnose-Kategorie Zeitwünsche (gesperrt belegt = Fehler, −3/−2 = Warnung; Tausch in der Setzhilfe prüft Sperren) | S–M | **ja** | SP2-02 | SP-G-11, SP-G-12 |
| **SP2-06** ✅ | CSV-Import der Unterrichtsverteilung (Klasse/Kurs; Fach; Stunden; Lehrkraft[; Doppelstunden; Raumwunsch]) mit Vorschau, Zuordnung über Kürzel, Fehlerliste und Trockenlauf; nur Lehraufträge, kein Plan | S | – | GATE SP | Q-SP-14 |
| **SP2-07** | Vertretung Stufe 2: Verlegung (Stunde auf einen Entfall-Slot vorziehen/tauschen), Zusammenlegung/Mitbetreuung (Gruppe geht zu Gruppe Y), Bereitschaft (Reserve je Slot, oben in den Vorschlägen); Anzeige/Gong/Monitor/Druck mitziehen | M | – | GATE SP | SP-G-08, Q-SP-15 |
| **SP2-08** | Dauervertretung für den Zeitraum einer Abwesenheit (erzeugt Vertretungen für alle Tage) + Vertretungsbedarf im Wochenblick (nächste 5 Schultage) | S–M | – | SP2-07 | SP-G-09, SP-G-10 |
| **SP2-09** ✅ | Lehrauftrag mit Gültigkeit (`valid_from/until`, Vorgabe Schuljahr; Verteilung und Solver am Stichtag, Übernahme bis `valid_until`) | M | teilw. | SP2-02 | SP-G-07 |
| **SP2-10** | Drucke/Exporte: Gesamtübersicht alle Klassen/alle Lehrkräfte, Unterrichtsverteilung, Deputate, Aufsichtsplan, Vertretungsstatistik (Druck + CSV) | S–M | – | GATE SP | SP-G-14 |
| **SP2-12** | **Fachbedarf & Vorsorge** (entschieden durch Projektleitung 19.10.2026): Reiter `/planung/bedarf` (Recht `stundenplan.manage`) + Kachel in der Übersicht `/planung`. Je Fach Bedarf (Wochenstunden aus Lehraufträgen/Stundentafel) gegen Versorgung (Deputatsstunden der Lehrkräfte mit diesem Lehrfach, abzüglich Anrechnungen) mit Ampel; Prognose nächstes Schuljahr (Jahrgänge rücken auf, Klassenzahl anpassbar, bekannte Abgänge/Zugänge – Ruhestand, Elternzeit, Befristung, Abordnung – nur als Datum + Stunden, **ohne Begründung**); Empfehlungstexte („Physik: −6 Std. … Einstellung/Abordnung prüfen“) + Hinweis auf Fächer, die nur eine Lehrkraft abdeckt. Neu: Lehrfächer (Fakultas) je Lehrkraft als Stammdatum; neues Leserecht „Fachbedarf einsehen“ (z. B. `stundenplan.forecast_view`) für die Schulleitung – nur aggregierte Zahlen je Fach, keine Personen/Namen; die Planung sieht Details. Datenschutz: Abgänge sind personenbezogen → Löschklasse/Löschfrist, nur mit `manage` sichtbar | M | – | GATE SP | Projektleitung 2026-10-19 |
| **SP2-11** ✅ | E2E-Szenario „Gesamtschule“ (Band E/G Mathe 7 + WP + Tagesgrenze → Lauf → Übernahme; Verlegung/Bereitschaft; CSV-Import; Fachbedarf) + Review-PR **GATE SP2** | S | – | SP2-01 … SP2-10, SP2-12 | – |
| **GATE SP2** | Review mit der Projektleitung – merged nur die Projektleitung | – | – | SP2-11 | – |

**Review-Fixes R2 (2026-10-26, ohne Migration):** **Regel Fachfilter (R2-P7):** der Fachfilter (nur passende Lehrkräfte, „alle anzeigen“, Warnhinweis, „Trotzdem zuweisen“) greift nur, wenn das Stundenplanmodul an ist **und** für die aktiven Lehrkräfte überhaupt Lehrfächer gepflegt sind (`subjectFilterOn`); sonst sind alle Lehrkräfte normal wählbar, ohne Hinweis und ohne Bestätigung (Kurswahl bei ausgeschaltetem Stundenplan: Liste ohne Restdeputat, der Server prüft keine Passung). „Trotzdem zuweisen“ gilt je Lehrkraft-Feld und gewählter Lehrkraft (`offSubjectOk:<feld>` = Lehrkraft-ID, R2-P3). Vorgeschlagen werden nur aktive Lehrkräfte, eine schon gewählte nicht aktive steht unter „nicht mehr aktiv“ mit Hinweis; gespeichert wird keine nicht aktive (Lehrauftrag, Stunde, Kopplung, Kurswahl, Abgang im Fachbedarf, R2-P2). Das Kurswahl-Angebot prüft die Passung nur bei geändertem Fach bzw. geänderter Lehrkraft (R2-P8). Fachbedarf: Versorgung nur aus aktiven Lehrkräften, Abgänge/Zugänge zählen erst nach dem Stichtag der heutigen Daten (R2-P10); Fach-Umbenennung/-Löschung zieht `timetable_staff_changes.subject_ids` mit (R2-P9).

**Umgesetzt (SP2-01, Migration 0100, 2026-10-20; Solver/Setzhilfe/Übernahme in SP2-02, s. u.):** Tabelle `timetable_bands` (Schuljahr, Name – eindeutig je Schuljahr –, Wochen-
und Doppelstunden), Mitglieder = Lehraufträge mit `timetable_assignments.band_id` (`on delete set null`). Lehrauftrag: genau eine Gruppe
(`AssignmentInput.groupId`), höchstens zwei Lehrkräfte, im Band übernimmt er Wochen-/Doppelstunden des Bands (`updateBand` schreibt sie an alle
Mitglieder; Herausnehmen/Löschen lässt sie stehen). „Gekoppelt mit“ ist entfallen; Migration 0100 macht aus jedem Lehrauftrag mit mehreren
Gruppen ein Band (id = alter Lehrauftrag, Name „Fach Gruppe/Gruppe“), einen Lehrauftrag je Gruppe (id `md5(alt|Gruppe)`) und biegt
Notenbücher auf den Lehrauftrag ihrer Gruppe um. `distribution()` liefert `bands: BandStatus[]` (`planned` = schwächstes Mitglied,
`together` = Slots, in denen alle Mitglieder liegen, `uniform` = gleiches Fach, gleiche Lehrkräfte, gleicher Raumwunsch); Lehrkräfte zählen
ein Band einmal (`teacherAssigned`), „verplant“ zählt gekoppelte Stunden im selben Slot einmal (`teacherPlanned`). Pflege-UI: Ansicht
„Bänder“ unter `/planung/unterricht?ansicht=baender` (Liste mit Soll/verplant, anlegen/ändern/löschen, Lehrauftrag aufnehmen/herausnehmen),
Feld „Band“ im Lehrauftrag. Demo: Band „Q1 GK-Schiene A“ (Englisch/Deutsch/Biologie GK1). Audit `stundenplan.band.*`.
Vorgaben (Q-SP2-1 … Q-SP2-6): Stunden gehören dem Band; Lehrauftrag ohne Lehrkraft bleibt erlaubt; Mitglieder mit gemeinsamen
Schüler:innen dürfen parallel liegen (Diagnose warnt). Der Übergang über `collapseBands()` galt nur bis SP2-02.

**Umgesetzt (SP2-02, ohne Migration, 2026-10-20) – Bänder in Solver, Setzhilfe und Übernahme:**
- **Solver-Eingabe** (`solver-input.ts`): `unitsFrom()` baut je Band **eine Einheit je Wochenstunde** (Doppelstunden als Zweier-Block, ids
  `<band-id>#d0/#e0`) mit einem `parts[]`-Eintrag je Mitglied – bei Teamteaching je Lehrkraft (SP-G-02). Jeder Teil hat eigenes Fach,
  eigene Lehrkraft, eigenen Raumwunsch (Wunschraum, Raumart des Fachs, Stammraum der Klasse). Gruppen/Lehrkräfte der Einheit = alle Teile;
  Mitglieder nach Gruppenname sortiert, `assignmentId` = erstes Mitglied, `label` = „Bandname: 7a Religion (RIC) + 7b Philosophie (NEU)“.
  Fixierte Stunden zählen **je Mitglied**: geplant wird `band.hours − max(fixiert je Mitglied)` (kein Mitglied über Soll; weniger fixierte
  Mitglieder bleiben offen und erscheinen in der Verteilung – Vorschlag Q-SP2-7). Band mit einem Mitglied = wie ein Lehrauftrag mit Band-id;
  leeres Band/Mitglied ohne Gruppe → keine Einheit. `collapseBands()` ist entfallen, ebenso die Warnung „noch einzeln“.
- **Solver-Kern** (`solver.ts`): Fachsperren (`blocked("subject")`), Zeitwünsche des Fachs und „Fach mehrfach am Tag“ gelten **je Teil**
  (`unitSubjects()`, Paare Gruppe × Fach je Einheit einmal berechnet – `feasible` bleibt die heiße Schleife). `chooseRooms()` zählt Teile, die
  sich eine Lehrkraft (und damit den Raum) teilen, zur Raumgröße zusammen. Gruppen derselben Einheit gelten nicht als Konflikt (Q-SP2-6).
  Einheiten mit einem Teil verhalten sich exakt wie vorher – der Groß-Benchmark liefert dieselbe Lösung (LASTTEST.md).
- **Setzhilfe** (`setzhilfe.ts`): `openAssignments()` meldet ein Band-Mitglied offen, solange das **Band** offen ist (schwächstes Mitglied), mit
  `band: { id, name, members }`; `assignmentPlacement()` baut je Mitglied Zeilen (`UnitRow.subjectId` neu) mit Raumvorschlag je Teil und
  sperrt bei Sperrzeiten aller Beteiligten; `placementCell()` vergibt Räume je Teil (gleiche Lehrkraft → gleicher Raum, sonst verschieden);
  `placeAssignment()` legt eine Kopplung mit allen Teilen an (Fach je Teil). Verschieben/Tauschen bewegt die ganze Kopplung (wie bisher).
- **Übernahme/Seed:** `withCouplingIds()` (rein) vergibt **eine `coupling_id` je Band-Stunde**; `applyRun` und der Demo-Seed nutzen es, der
  Demo-Plan zeigt das Band „Q1 GK-Schiene A“ als Kopplung. `undo`/Zurücknehmen, Vergleich und Vorschau arbeiten über `proposedLessons()` je
  Teil und bleiben unverändert korrekt (Tests in `solverlauf.test.ts`).
- **Diagnose:** neue Kategorie **„Bänder“** (`band`, Ziel `kind: "band"` mit Link zur Band-Seite): „nur x von y Stunden zur selben Zeit“
  (`together < planned`, warn), „A und B haben gemeinsame Schüler:innen“ (Q-SP2-6, warn; `bandsWithSharedStudents()` – dieselbe Prüfung
  warnt in der Vorprüfung eines Laufs), „Band ohne Lehraufträge“ (info). Die Liste „Bänder“ zeigt weiter „nur x Std. zur selben Zeit“.
- **Demo:** die drei Q1-Grundkurse der Schiene bekommen **getrennte Schüler:innen** (je Schüler:in genau einer, Q-SP2-6); der Zufallswurf
  bleibt gezogen, damit die übrige Demo unverändert ist. `listAssignments()` sortiert zuletzt nach id (deterministisch bei gleichem Fach und
  Anlagezeitpunkt). Der Demo-Plan hat sich dadurch geändert (Band gemeinsam, Kopplungen) – E2E-Tests nachgezogen (`seed.test`,
  `klausurplan/service.test` prüft Überschneidung jetzt gegen den Mathe-LK, `unterricht.spec`, `zx-gate-sp.spec` mit Band-Schritt).

**Umgesetzt (SP2-03, Migration 0101, 2026-10-21) – Tagesgrenzen und Ganztag je Jahrgangsstufe:**
- **Daten:** `timetable_grade_rules` (Jahrgang als Schlüssel, `max_per_day`, `afternoons_per_week`, `lunch_after_period`; `null` = keine Grenze; gilt über
  Schuljahre hinweg, ohne Personenbezug → `NO_PERSONAL_DATA`). Pflege und Laden in `jahrgangsregeln.ts` (`saveGradeRules` prüft gegen das Zeitraster,
  Nachmittage brauchen „Mittag nach …“; `applyGradeRuleDefaults` aus `gradeRulesTemplate()` in `core/school/templates.ts`: Sek I 5/6 höchstens 7, sonst 8
  Stunden, Mittag nach der 6. bei mehr als 6 Stunden im Raster, Nachmittage 3 an Gesamt-/Sekundarschulen, sonst 2; Oberstufe ohne Vorgabe – Q-SP2-9).
  Audit `stundenplan.tagesgrenzen.save`. Demo: Katalog-Vorgaben der Gesamtschule; die Demo-Sperren im Seed halten sie ohnehin ein – Demo-Plan unverändert.
- **Regeln** (rein, `tagesgrenzen.ts`): `dayRuleFor()` macht aus „Mittag nach N“ die wirksame Regel – liegt zwischen N und N+1 im Zeitraster schon eine Pause
  ≥ 30 min (`LUNCH_MIN_MINUTES`), ist dort Mittag (keine Mittagsstunde, Nachmittag ab N+1); sonst ist N+1 die Mittagsstunde, die frei bleibt, sobald danach
  Unterricht liegt (Nachmittag ab N+2). Gilt für die **Klassen** des Jahrgangs; Stunden der Kurse/Wahlpflicht-/Förderkurse desselben Jahrgangs zählen für die
  Klasse mit (gleiche Sicht wie Hohlstunden, SP2-02). Alle Regeln sind monoton (wegnehmen verletzt nie) – Tauschen/Verschieben bleiben einfach.
- **Solver:** `SolverInput.dayRules` (Klasse → Regel, aus `solverInputFromDb`); `feasible()` prüft zuletzt `dayBlocked()` für die betroffenen Klassen der Einheit
  (`meta.dayClasses`: eigene Klassen + Klassen des Kurs-Jahrgangs, bei Bändern über alle Teile); Klassentage sind zwischengespeichert (`dayCache`, verworfen in
  `addGroupDay`/`removeGroupDay`). `blockersAt()` gibt bei verletzter Tagesgrenze `null` (Verdrängen im selben Slot hilft nicht), `explain()` liefert je Klasse die
  Ursache `kind: "day"` mit Label „Tagesgrenzen 7a (höchstens 7 Std./Tag · höchstens 3 Nachmittage …)“ – steht so im Grund „nicht gesetzt“. Vorprüfung:
  Wochenstunden der Klasse gegen `weeklyCapacity()`. Das Protokoll nennt „Tagesgrenzen für n Klassen“.
- **Setzhilfe:** `GridInput.dayLimits` (aus `loadDayLimits`) – ein Slot über einer Grenze ist gesperrt mit Grund „7a: höchstens 7 Stunden am Tag“; beim Tausch
  wird auch der Partner-Tag geprüft („Tausch: …“).
- **Diagnose:** neue Kategorie **„Tagesgrenzen“** (`day`): je Klasse und Tag zu viele Stunden bzw. Unterricht in der Mittagsstunde und danach (Fehler), zu viele
  Nachmittage (Fehler), Wochenstunden laut Verteilung über dem Erlaubten (Warnung; ein Band zählt einmal). Auch in den Plan-Hinweisen der Klasse.
- **Pflege-UI:** `/planung/unterricht?ansicht=tagesgrenzen` (Recht `stundenplan.manage`): Tabelle je Jahrgang mit Klassen, Wirkung im Zeitraster, „Vorgaben der
  Schulform übernehmen“; E2E in `unterricht.spec.ts`.
- **Benchmark:** ohne Regeln dieselbe Lösung; Variante „Tagesgrenzen“ (alle Klassen 7/3) 0,7 s allein, Grenzen eingehalten (LASTTEST.md).

**Umgesetzt (SP2-04, Migration 0102, 2026-10-21) – Lehrkraft-Tagesregeln und Fachverteilung:**
- **Daten:** `timetable_teacher_day_rules` (Schuljahr × Lehrkraft, `max_per_day` 1–20, `max_days` 1–7, `null` = keine Grenze; ohne Grenze entfällt die Zeile).
  Personaldaten wie das Deputat: LK-SJ-1J ab Schuljahr, Fremdschlüssel aufs Konto (`deleteAccounts`/Löschlauf löschen mit, kein weicher Verweis), Pflege nur mit
  `stundenplan.manage` (`saveTeacherDayRuleAction` → `saveTeacherRule` in `deputate.ts`, prüft 1 … Stunden im Raster bzw. 1–5 Tage, Audit
  `stundenplan.deputy.day_rule`), sichtbar für die Lehrkraft selbst unter „Mein Deputat“. `DeputyAccount.dayRule`; Laden für die Setzhilfe `loadTeacherLimits()`.
- **Regeln** (rein, `lehrkraftregeln.ts`): `teacherViolationsWith()` (Stunden am Tag – gekoppelte Stunden einer Lehrkraft zählen einmal –, neuer Anwesenheitstag über
  `maxDays`), `teacherWeeklyCapacity()`, `teacherLimitReasons()`; monoton wie SP2-03.
- **Solver:** `SolverInput.teacherRules` (aus `solverInputFromDb`, Schuljahr des Laufs); `feasible()` prüft nach den Tagesgrenzen `teacherBlocked()` für die Lehrkräfte
  der Einheit mit Regel (`meta.ruleTeachers`, bei Bändern jede Teil-Lehrkraft) direkt auf `teacherDay` (kein eigener Zwischenspeicher nötig – Tage sind kurz).
  `blockersAt()` gibt bei verletzter Regel `null`, `explain()` liefert `kind: "teacherDay"` mit Label „Tagesregel LIN (höchstens 3 Std./Tag · höchstens 2 Tage)“;
  Vorprüfung: Bedarf der Lehrkraft gegen `teacherWeeklyCapacity()`. Protokoll „Tagesregeln für n Lehrkräfte“.
- **Weiche Kosten:** `SolverWeights.teacherDays` (je Anwesenheitstag, in `teacherDayCost()`; Posten je Lehrkraft und Woche in `total()`) und `subjectSpread`
  (`spreadCost(g, s)`: Paare benachbarter Schultage mit demselben Fach je Gruppe minus unvermeidbare `max(0, 2n − D − 1)`; in `localCost()` je berührtem Paar
  Gruppe × Fach über `groupSubjectsOf()`, also bei Bändern je Teil-Fach). Beide **Vorgabe 0** (`DEFAULT_WEIGHTS`, „ausgewogen“, Demo-Seed) → Pläne ohne Regeln
  bleiben gleich; „lehrkräfteschonend“ `teacherDays: 4`, „klassenkompakt“ `subjectSpread: 6`; Formularfelder „Anwesenheitstag Lehrkraft“/„Fach an Folgetagen“,
  `COST_LABELS` „Anwesenheitstage Lehrkräfte“/„Fach an Folgetagen“ (Läufe vor SP2-04 zeigen 0).
- **Setzhilfe:** `GridInput.teacherLimits` – Slot gesperrt mit „LIN: höchstens 5 Stunden am Tag“ bzw. „… Anwesenheitstage je Woche“, beim Tausch auch für den Partner.
- **Diagnose:** Kategorie **„Tagesregeln Lehrkräfte“** (`teacherDay`, Ziel Lehrkraft): Tag über `maxPerDay` (Fehler), mehr Tage als `maxDays` (Fehler), Lehraufträge
  über der Wochenkapazität (Warnung).
- **Benchmark:** ohne Regeln dieselbe Lösung (Bewertung 2 163, 9 nicht gesetzt, 0,69 s); Variante „Lehrkraft-Tagesregeln“ (24 Lehrkräfte bis 22 Std. höchstens 6 am
  Tag, 3 bis 20 Std. zusätzlich höchstens 4 Tage, `subjectSpread` 6) 14 nicht gesetzt (Grenzwert 1 %), Regeln eingehalten, 0,8 s allein (LASTTEST.md).
  Befund: die synthetische Schule ist voll ausgelastet (~22–24 Std. je Lehrkraft) – „höchstens 4 Tage“ für alle Lehrkräfte bis 22 Std. ließ 27–32 Einheiten liegen;
  ein Konstruktions-Aufschlag für neue Anwesenheitstage machte es schlechter (38) und ist verworfen.

**Umgesetzt (SP2-05, ohne Migration, 2026-10-21) – Hohlstunden Oberstufe/Kursband, Diagnose Zeitwünsche:**
- **Solver** (`solver.ts`): Jahrgänge, die nur aus Kursen bestehen (`gradeOf` ohne Klasse – Oberstufe), bekommen einen eigenen Kostenschlüssel
  `@${grade}|${wd}`: Lücken zwischen den Kurs-Stunden des Jahrgangs am Tag (Vereinigung über alle Kurse, `gradeDay`) kosten wie Klassen-Hohlstunden
  (`classGap`). `touchedDays()` nimmt den Jahrgangs-Tag mit (lokale Suche), `total()` weist den Posten als „Jahrgang 12 Mo: 1 Hohlstunde“ aus,
  `gapStats()` zählt den Jahrgang wie eine Klasse. Hat der Jahrgang Klassen, zählen wie bisher die Klassen (SP2-02). Ohne `gradeOf` bzw. ohne
  Kurs-Jahrgänge ändert sich nichts – der Groß-Benchmark liefert dieselbe Lösung (LASTTEST.md). Die Vereinigung ist die untere Schranke je
  Schüler:in; Hohlstunden einzelner Schüler:innen kennt erst die Blockung aus Kurswahlen (SP-G-24).
- **Tagesgrenzen für Kurs-Jahrgänge (Q-SP2-10, Vorschlag):** greifen **nicht** – die Vereinigung aller Kurse eines Oberstufen-Jahrgangs ist kein
  Schülertag (höchstens 8 Stunden über alle Kurse würde zu viel sperren, die Mittagsstunde ebenso); die Pflege listet ohnehin nur Jahrgänge mit
  Klassen, die Katalog-Vorgaben haben für die Oberstufe keine Werte (Q-SP2-9).
- **Diagnose:** neue Kategorie **„Zeitwünsche“** (`prefs`): Stunden am Stichtag gegen `allPrefs()` – Lehrkraft (Ziel Lehrkraft), Gruppe, Raum und
  Fach (Ziel Gruppe); gesperrt belegt = Fehler, −3/−2 = Warnung, −1 nichts; je Wunsch-Ziel und Schwere ein Hinweis mit Slots und Stunden, gekoppelte
  Stunden und A/B-Wochen einmal je Slot. Auch in den Plan-Hinweisen der Gruppe.
- **Setzhilfe:** `GridInput.blockedFor`/`MoveUnit.blockedFor` (Wunsch-Ziele beliebiger Stunden, `lessonPrefTargets()`); beim Tausch werden die
  Sperrzeiten der Partner-Stunden am bisherigen Slot geprüft („Tausch: AAA: Zeit gesperrt“).
- **Benchmark:** neue Variante „Oberstufe mit Jahrgang“ (Schienen als Bänder, Kurse mit Jahrgang 11–13): Jahrgangs-Hohlstunden 6 → 4, 0 nicht
  gesetzt. Variante „Lehrkraft-Tagesregeln“ läuft jetzt auf der Schule mit Schienen als Bändern (ohne Bänder lagen schon ohne Regeln 9–12 Kurse
  wegen Konfliktmengen offen, das Ergebnis schwankte je nach Gewicht zwischen 12 und 19 um die 1-%-Grenze) und ist dabei **strenger**: 17 statt 3
  Lehrkräfte mit höchstens 4 Tagen – 1 nicht gesetzt (Grenze 12).

**Umgesetzt (SP2-06, ohne Migration, 2026-10-21) – CSV-Import der Unterrichtsverteilung (Q-SP-14):**
- **Seite** `/planung/unterricht/import` (Knopf „CSV-Import“ in der Unterrichtsverteilung, Recht `stundenplan.manage`), Vorlage unter
  `/api/stundenplan/verteilung-vorlage` (Kopfzeile + zwei Beispielzeilen mit Kürzeln der Schule, ohne Personennamen).
- **Format** (`verteilung-import.ts`, `parseAssignmentCsv`): Klasse/Kurs; Fach; Stunden; Lehrkraft[; Doppelstunden; Raumwunsch; Band] – Kopfzeile
  optional (Spaltennamen in beliebiger Reihenfolge, ohne Kopfzeile die Reihenfolge der Vorlage), Semikolon oder Komma, höchstens 512 KB/5 000 Zeilen.
  Kodierung: gültiges UTF-8 (mit/ohne BOM), sonst Windows-1252 – neuer Helfer `decodeCsvBytes()` in `core/csv.ts` (die anderen Importe lesen bisher nur
  UTF-8 und können ihn übernehmen).
- **Zuordnung** (`planAssignmentImport`): Gruppe über Name/Slug (Klassen/Kurse/AG/WP/Förderkurse des Schuljahrs, nicht archiviert), Fach über Kürzel/Name,
  Lehrkraft über Kürzel/Namen (aktive Lehrkräfte, zwei mit „/“ oder „+“), Raum über Kürzel/Name (aktiv); mehrdeutige Namen sind ein Fehler.
  Gleiche Prüfregeln wie beim Anlegen von Hand (1–12 Std., Doppelstunden ≤ Hälfte, ≤ 2 Lehrkräfte); doppelte Zeilen in der Datei sind ein Fehler.
- **Vorhandene Lehraufträge**: passt Gruppe + Fach + eine Lehrkraft (bzw. beide ohne), wird der Auftrag geändert (Stunden, Lehrkräfte; Doppelstunden/Raum
  nur, wenn die Spalte gefüllt ist) – Vorschau zeigt „ändern“ mit den Änderungen bzw. „unverändert“. Nichts wird gelöscht.
- **Bänder**: Spalte „Band“ = Name eines vorhandenen Bands (Stunden/Doppelstunden müssen zum Band passen) oder eines neuen (alle Zeilen mit denselben
  Stunden; wird angelegt). Ein Lehrauftrag im Band bleibt darin – ohne Band-Spalte müssen die Stunden zum Band passen, ein anderes Band ist ein Fehler.
- **Übernehmen** plant serverseitig neu und schreibt nur ohne Fehler, alles in einer Transaktion; Audit `stundenplan.assignment.csv_import` mit Anzahlen.
- Tests: `verteilung-import.test.ts`, `csv.test.ts`, E2E `unterricht-import.spec.ts` mit Beispieldatei `e2e/fixtures/unterrichtsverteilung.csv` (Windows-1252).

**Umgesetzt (SP2-09, Migration 0103, 2026-10-21) – Lehrauftrag mit Gültigkeit (SP-G-07):**
- **Daten:** `timetable_assignments.valid_from/valid_until` (`date`, `null` = Beginn/Ende des Schuljahrs, Prüfregel ab ≤ bis). Pflege im Lehrauftrag
  („Gültig ab/bis“, im Schuljahr); „doppelt erfasst“ gilt nur bei sich überschneidender Gültigkeit (`validityOverlaps`), Physik bei derselben
  Lehrkraft im 1. und im 2. Halbjahr darf getrennt stehen. Ohne Personenbezug über den Lehrauftrag hinaus – keine neue Löschklasse.
- **Verteilung am Stichtag:** `distribution()` filtert mit `activeOn()` am Stichtag (`referenceDate`) – damit gilt der Stichtag für alles, was darauf
  aufbaut (Soll/verplant, Bänder, Deputate, Diagnose, Setzhilfe, Solver-Eingabe); was dann nicht gilt, steht in `otherTime` und zählt nirgends. Die
  Seite hat einen Stichtag-Wähler (`?stichtag=`), die Gruppe zeigt „Zu anderer Zeit gültig“ mit Sprung auf deren Stichtag, die Tabelle einen Hinweis
  „ab …/bis …“.
- **Solver-Läufe:** neuer Parameter „Lehraufträge am“ (`RunParams.refYmd`, optional – Läufe ohne rechnen wie bisher am Tag der Berechnung;
  `StoredResult.refYmd` = Planungsstand); Detailseite und Vergleich zeigen ihn, das Protokoll nennt ihn.
- **Übernahme:** jede Stunde trägt ihren Lehrauftrag (`ProposedLesson.assignmentId`, je Teil – Band-Mitglieder je eigene Gültigkeit) und gilt
  bis `min(Schuljahresende, valid_until)`; endet der Lehrauftrag vor dem Stichtag, entfällt die Stunde (`expired`, im Protokoll). Beginnt ein
  Lehrauftrag des Laufs erst nach dem Stichtag, lehnt die Übernahme ab („frühestens ab …“) – die Stunden beginnen so immer am Stichtag, das
  Zurücknehmen bleibt unverändert. Ablauf Halbjahr: Lauf mit Stand 1. Hj. übernehmen (Halbjahres-Aufträge enden am 31.01.), Lauf mit
  „Lehraufträge am 01.02.“ ab dem 01.02. übernehmen (ersetzt ab dann). Seit R1a (unten) in beliebiger Reihenfolge – jeder Lauf ersetzt nur seinen
  Planungszeitraum.
- **Regel Planungszeitraum (Review-Fix R1a/A2, 2026-10-26, ohne Migration):** Ein Lauf mit Planungsstand `refYmd` gilt für den längsten Zeitraum
  um `refYmd`, in dem kein Lehrauftrag gilt, den der Lauf nicht kennt (`planningPeriod`): er **endet am Vortag, an dem der nächste ihm unbekannte
  Lehrauftrag beginnt** (sonst Schuljahresende), und **beginnt am Tag nach dem Ende des letzten ihm unbekannten** (sonst Schuljahresbeginn).
  Lehraufträge, die er kennt, begrenzen ihn nicht (ihre Stunden enden mit ihnen; ein späterer Beginn lehnt wie bisher ab). Gerechnet wird mit den
  Lehraufträgen zum Zeitpunkt der Übernahme. Die Übernahme ab `fromYmd` ersetzt **nur Stunden in `[fromYmd, Zeitraumende]`**: Stichtag vor dem
  Zeitraum oder danach → Ablehnung („gilt erst ab …“ / „gilt nur bis …“); Stunden, die erst nach dem Zeitraum beginnen, bleiben unberührt;
  ersetzbare Stunden, die über das Zeitraumende hinaus gelten, werden dort geteilt (wie „Periode kopieren“: Kopie ab dem Folgetag mit neuer
  Kopplungs-id, gleicher Herkunft und Anlagezeit; Vertretungen – auch als aufnehmende Stunde –, Klassenbuch und Material ab dann ziehen mit;
  `undo.split`); neue Stunden gelten höchstens bis zum Zeitraumende. Das Zurücknehmen fügt geteilte Stunden wieder zusammen (nur wenn der Teil
  im Zeitraum wieder bis zum Zeitraumende gilt). Ohne Gültigkeitsangaben ist der Zeitraum das ganze Schuljahr – alles wie vorher. Die
  Detailseite nennt das Zeitraumende im Hinweis vor dem Übernehmen, das Protokoll ebenso. Beispiel: Lauf 2. Hj. ab 01.02. übernommen, danach
  Lauf 1. Hj. ab 02.11. → der Februar-Plan bleibt, die neuen Stunden enden am 31.01. Wird ersetzt durch den Entwurf aus
  `STUNDENPLAN-LEBENSZYKLUS.md` (SP3), bis dahin gilt diese Regel.
- **Verlegung/Zusammenlegung in der Übernahme (R1a/A1):** `undo.substitutions` trägt `targetPeriod` und `mergeLessonId`; Zusammenlegungen
  anderer Gruppen **in** ersetzte Stunden werden ab dem Stichtag ausdrücklich entfernt, gezählt (Hinweis, `removedSubstitutions`) und gesichert,
  statt still per Fremdschlüssel zu verschwinden bzw. an einer nicht mehr geltenden Stunde zu hängen. Zurück kommt eine Zusammenlegung nur, wenn
  am Tag auch die aufnehmende Stunde wieder gilt; eine inzwischen aufgehobene Zusammenlegung (`merge_lesson_id` leer, Migration 0106) am selben
  Tag weicht der alten Vertretung. Übernahmen vor R1a haben die Felder nicht (Verlegung kommt dann ohne Zielstunde zurück).
- **Kalenderdaten (R1a/A12):** Gültigkeit der Lehraufträge, Planungsstand und Stichtag der Übernahme werden mit `isCalendarDate` geprüft
  (2027-02-30 → Feldfehler statt Datenbankfehler). **Sortierung (R1a/A15):** `listAssignments` sortiert Fachname und id mit `collate "C"`
  – PGlite und PostgreSQL liefern dieselbe Reihenfolge und damit denselben Solver-Lauf.
- Tests R1a: `solverlauf.uebernahme.test.ts` (Zeitraum rein, Halbjahre in umgekehrter Reihenfolge, Teilen + Zurücknehmen, Verlegung/Zusammenlegung),
  `verteilung.test.ts` (A12, A15 – die Collation-Probe greift im CI-Job `postgres`), `gueltigkeit.test.ts` angepasst.
- **Setzhilfe:** Stunden gelten höchstens so lange wie ihr Lehrauftrag (`clipValidity`); weichen Band-Mitglieder ab, bekommt die Kopplung den
  Zeitraum der Setzhilfe (einfache Vorgabe; der Solver-Weg setzt je Teil).
- **CSV-Import (SP2-06)** kennt keine Gültigkeit: neue Lehraufträge gelten das ganze Schuljahr, ein vorhandener mit Gültigkeit kann als „ändern“ zugeordnet werden.
- **Benchmark:** der Solver-Kern ist unverändert – vor und nach der Änderung dieselbe Lösung (9 nicht gesetzt, Bewertung 2 163, 82 Verbesserungen,
  Hohlstunden 169/13, gesamt 0,75 → 0,69 s; Varianten mit denselben Ergebnissen – geteilter Sport 10, Bänder 0, Oberstufe 0, Tagesgrenzen 9, Lehrkraft-Tagesregeln 1 nicht gesetzt). Ohne Gültigkeitsangaben ist die Solver-Eingabe unabhängig vom Stichtag (Test).
- Tests: `gueltigkeit.test.ts` (rein + Demo: Pflege, Verteilung, Solver-Eingabe, Übernahme bis `valid_until`, Ablehnung, abgelaufene), E2E
  `unterricht-gueltigkeit.spec.ts`.

**Umgesetzt (SP2-07, Migration 0104, 2026-10-21) – Vertretung Stufe 2 (SP-G-08, Q-SP-15):**
- **Daten:** `substitution_kind` + `move`/`merge`; `timetable_substitutions.target_period` (Verlegung: Stunde desselben Tages) und
  `merge_lesson_id` (Zusammenlegung: aufnehmende Stunde, Fremdschlüssel mit `cascade`); neue Tabelle `timetable_standby` (Schuljahr × Wochentag ×
  Stunde × Lehrkraft, LK-SJ-1J ab Schuljahr, Fremdschlüssel aufs Konto – `deleteAccounts` braucht nichts Eigenes).
- **Belegung** (rein, `belegung.ts`): `ownTeacherPeriod`/`groupPeriod`/`roomUse` – Verlegung zählt in der neuen Stunde, Zusammenlegung gibt
  Lehrkraft und Raum frei (die Gruppe ist bei der anderen Stunde beschäftigt). Genutzt von Vertretung (`busyTeachers/busyRooms/busyGroups`,
  `roomLessonAt`), Vorschlägen, Raumbelegung, Raumsperren und Aufsichtsvertretung.
- **Verlegung** (`saveSubstitution`, Art `move`): ganze Kopplung (bei Band-Stunden alle Teile, `couplingParts`), Zielstunde ≠ eigene; Gruppe,
  Lehrkräfte, Räume (optional anderer Raum) frei, Raumsperre. „Tauschen“ (`swap`) legt den Unterricht der Gruppe aus der Zielstunde (mit seinen
  Kopplungsteilen) in die bisherige Stunde – geprüft in beide Richtungen; Aufheben nimmt den Tauschpartner mit. Solange etwas in eine Stunde
  verlegt ist, kann die dortige Stunde weder stattfinden (Vertretung/Raumänderung) noch ihr Entfall aufgehoben werden.
- **Zusammenlegung** (Art `merge`): aufnehmende Stunde zur selben Zeit, andere Gruppe, findet wie geplant statt, Lehrkraft (bzw. deren Vertretung)
  nicht abwesend; Auswahl `mergeOptions()`. Die aufnehmende Stunde kann nicht entfallen/verlegt/zusammengelegt werden, solange Gruppen dort sind.
- **Bereitschaft** (`bereitschaft.ts`, Seite `/planung/vertretungen/bereitschaft`, Recht `stundenplan.substitute`): nicht zur eigenen Unterrichtszeit,
  Audit `stundenplan.standby.*`; `suggestSubstitutes()` setzt Lehrkräfte mit Bereitschaft immer oben (Grund „Bereitschaft“ +40, keine Rand-/Frei-Abzüge).
- **Tagesregeln (SP2-04) bei Vertretungen** (`vertretung-regeln.ts`): wer mit der zusätzlichen Stunde über „höchstens n Stunden am Tag“ bzw. einen
  weiteren Anwesenheitstag käme, wird nicht vorgeschlagen; Speichern lehnt ab („Tagesregel: …“). Verlegung/Zusammenlegung ändern die Tageslast nicht.
- **Anzeige:** `listSlots()` liefert die verlegte Stunde zweimal (`moved: "from"` in der bisherigen Stunde, „away“; `moved: "to"` mit neuen Zeiten),
  `change.mergeWith` bzw. `joined` (Mitbetreuung bei der aufnehmenden Stunde); `substitutionsOn()` zwei Einträge je Verlegung (`movedFrom/movedTo`)
  und `mergeWith`; Texte über `changeLabel/changeTeacher/changeRoom` in `display.ts` (Vertretungsplan, Planung, Druck, Monitor, Kursseite). Gong:
  „Verlegung … – in der 1. Std“, „Zusammenlegung … – mit 7a · bei …“; die mitbetreuende Lehrkraft bekommt die Tagesnachricht.
- **Zähler:** Verlegung zählt weder als Vertretung noch als Entfall; Zusammenlegung zählt als „vertreten“ der Gruppe und „abgegeben“ der Lehrkraft.
- Solver nicht betroffen. Tests: `vertretung-stufe2.test.ts`, E2E `vertretung-stufe2.spec.ts` (Planungs-Login, A11Y hell/dunkel/360 px).

**Umgesetzt (SP2-08, ohne Migration, 2026-10-21) – Dauervertretung und Wochenblick (SP-G-09, SP-G-10):**
- **Dauervertretung** (`dauervertretung.ts`, `savePermanentSubstitution`): Option im Vertretungsformular, sobald die Lehrkraft der Stunde eine Abwesenheit
  über den Tag hinaus hat. Legt für jeden Tag der Abwesenheit ab dem gewählten, an dem die Stunde stattfindet (Ferien/Feiertage, A/B-Woche, Gültigkeit,
  stundenweise Abwesenheit beachtet), eine gewöhnliche Vertretung über `saveSubstitution` an – mit allen Prüfungen (frei, nicht abwesend, Tagesregel,
  Raum) und je Tag dem Gong. Schon geregelte Tage bleiben unverändert; Tage, an denen es nicht geht, nennt die Rückmeldung („nicht am 07.10. (…)“).
  Kein eigener Datensatz: einzeln überschreiben/aufheben wie jede Vertretung (einfache Vorgabe, Q-SP2-16).
- **Wochenblick** (`weekNeeds`): oben auf `/planung/vertretungen` die nächsten fünf Schultage mit „n offen“/„m geregelt“, Link auf den Tag.
- Tests: `dauervertretung.test.ts`, E2E `vertretung-dauer.spec.ts` (Planungs-Login, A11Y, dunkel/360 px).

**Umgesetzt (SP2-11, ohne Migration, 2026-10-26) – E2E-Gesamtszenario „Gesamtschule“:** `e2e/zx-gate-sp2.spec.ts` (seriell, legt alles selbst an
und räumt es weg – TD-07): Kurse Jahrgang 7 (Mathe E/G, zwei WP) → CSV-Import mit zwei Bändern → Bänder, Fachbedarf, CSV-Export ↔ Import →
Tagesgrenze → Lauf → Übernahme ab Stichtag (Band-Stunden als Kopplung, Diagnose Tagesgrenzen/Bänder am Stichtag ohne Befund) → zurücknehmen;
Bereitschaft oben in den Vorschlägen, Verlegung in eine freie Stunde, Vertretungsseite der 7b auf 360 px ohne seitliches Scrollen; A11Y der
SP2-Seiten hell/dunkel. Fund: `Table` aus `@schulos/ui` ist jetzt `relative` (sonst ragten `sr-only`-Spaltenköpfe aus dem Scroll-Rahmen).

**Übergabe für den Rest des Blocks (nach SP2-05):**
- **SP2-09 (Lehrauftrag mit Gültigkeit):** `unitsFrom()`/`solverInputFromDb()` filtern Lehraufträge am Stichtag; `gradeOf` bleibt aus
  `groups.gradeLevel` – Kurs-Jahrgänge (Oberstufe) zählen ohne weitere Eingabe.
- **SP2-11 (E2E „Gesamtschule“):** Diagnose-Kategorie „Zeitwünsche“ per `?ansicht=diagnose&kategorie=prefs` erreichbar; Demo-Plan hält die
  Demo-Sperren ein (keine Fehler in der Kategorie).
- Offen/Vorschlag: Q-SP2-7 (fixierte Stunden im Band: `max` je Mitglied) und Q-SP2-8 (Band-Mitglied allein nachsetzen: die Setzhilfe
  setzt immer das ganze Band; ein Mitglied mit mehr fixierten/eigenen Stunden lässt sich nur über die Stundenpflege einzeln ergänzen).

Nur auf Nachfrage von Schulen (Kann): A/B-Wochen im Solver (SP-G-17), Lehrbefähigung (SP-G-18), Wertrechnung/Faktoren (SP-G-19),
faire Aufsichtsverteilung (SP-G-20), ICS-Abo des Stundenplans (SP-G-21), Matrix Lehrkraft × Fach (SP-G-22). Oberstufen-Blockung
aus Kurswahlen (SP-G-24) wird eine eigene Phase nach SP2 (braucht Bänder).

**Bewusst nicht (Q-SP-16):** mehrere Zeitraster je Jahrgang, Minutenstundenplan, Samstag · Standorte/Wegezeiten/Abteilungen ·
Mehrarbeits-Abrechnung (Zähler bleiben) · Import/Export von Plänen im Austauschformat fremder Software · Plan-Versionen (Q-SP-12).
