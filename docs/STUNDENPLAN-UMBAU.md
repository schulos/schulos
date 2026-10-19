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
| **SP-06** (**Kern**) | Solver-Läufe Datenmodell + Ausführung: Migration 0089 bzw. nächste freie Nummer (`label`, `params`, `metrics`, `log`, `cancel_requested`, `heartbeat_at`, `applied_by`/`applied_at`, `undo`, Status `queued`/`cancelled`, `timetable_lessons.solver_run_id`), Zeitscheiben statt fester Blöcke, Heartbeat-Sperre, Warteschlange, Abbruch, Startup (queued weiter, running → failed), Validierung vor dem Start, Nachtjob `solver-aufraeumen`, Messung der Antwortzeiten während eines Laufs. **Aus der Gap-Analyse (§6.3):** Einheiten-/`result`-Format bandfähig (`units[].parts[]`, Q-SP-13), Machbarkeits-Vorprüfung + konkrete Gründe „nicht gesetzt“ (SP-G-03), Doppelstunde nicht über große Pause/Mittag (SP-G-04a), Warnung „Kurse mit Lehrauftrag ohne Mitglieder“ (SP-G-13), Warnung vor A/B-Stunden mit Lehrauftrag, synthetischer Groß-Benchmark (SP-G-15) | M | **Fable** | SP-03 | **0089** (oder nächste freie) | `solverlauf.test` (Warteschlange, Abbruch vor/nach Konstruktion, Heartbeat, Aufräumen, Validierung, Vorprüfung), `solver.test` (Doppelstunde über Pause, Gründe je Einheit, `parts`), Benchmark-Test, `retention.test` |
| **SP-07** | Solver-Läufe UI: Liste aller Läufe (Filter), Start-Formular mit Bezeichnung/Gründlichkeit/Startwert/Gewichtungs-Voreinstellung + „eigene“ (alle Felder von `SolverWeights` **plus `lateFrom`**, SP-G-16), Detailseite `/planung/solver/[id]` (Fortschritt, Protokoll, Konflikte vollständig **mit Grund je Einheit** aus SP-G-03, Ergebnis der Vorprüfung, Kostenposten mit Filter, Vorschau Klasse **und** Lehrkraft), Abbrechen, Löschen | M | Opus | SP-06 | – | `npm run verify`; E2E Lauf starten → abbrechen → zweiter Lauf |
| **SP-08** | Vergleich `/planung/solver/vergleich?laeufe=…` (2–3 Läufe, bester Wert markiert, Delta, Vorschau nebeneinander) | S | Opus | SP-07 | – | Service-Test der Delta-Berechnung, E2E Vergleich |
| **SP-09** (**Kern**) | Übernahme: `solver_run_id` an Stunden, `undo` schreiben, „Übernahme zurücknehmen“ bis zum Stichtag, Stichtag = Schultag, Hinweis mit Zahl der entfallenden Vertretungen; Randfälle Kopplungen/A-B-Woche/Vertretungen am Stichtag; **Raum je Kopplungsteil** (SP-G-02: `chooseRoom` je Teil, gleiche Lehrkraft → gleicher Raum) | M | **Fable** | SP-06 | – (Spalten aus SP-06) | `solverlauf.test` (Übernahme/Zurücknehmen mit Kopplungen, bleibenden Stunden, Vertretungen), `solver.test` (geteilte Klasse mit zwei Lehrkräften → zwei Räume, bis zur Übernahme), E2E Übernahme → zurücknehmen |
| **SP-10** | Datenschutz + Doku: DATENSCHUTZ §3.4 Zeile, Manifest `retention`/`processing`, SICHERHEIT S-xx, STUNDENPLAN.md „Stand 2026-10“, VVT-/Auskunftstest | S | Opus | SP-09 | – | `retention.test`, VVT-Snapshot, Auskunftstest |
| **SP-12** | **Vertretung mit abweichendem Fach** („Fachtausch“, SP-G-Fachtausch, §6.4): `timetable_substitutions.subject_id` (nullable, nur bei `substitute`, Check-Constraint), Formularfeld „Fach“, Vorschlag „kennt die Klasse → eigenes Fach“ (+10, Knopf übernimmt Lehrkraft **und** Fach), Anzeige „Mathe statt Sport“ in allen Plänen/Tagesleiste/Vertretungsplan/Druck/Monitor, Gong-Text, Klassenbuch-Eintrag mit tatsächlichem Fach, Statistik-Zähler „davon mit eigenem Fach“, Klausur-Hinweis im Formular, DATENSCHUTZ §3.4/STUNDENPLAN §2.3 | M | Opus | SP-03 (Recht `substitute` aus SP-02, Seiten unter `/planung/vertretungen`) | nächste freie Nummer (Spalte + Check) | `vertretung.test`, `vorschlaege.test`, `display.test`, `vertretung-gong.test`, Klassenbuch-Test, E2E `vertretungsbedarf.spec.ts` erweitert |
| **SP-11** | E2E-Szenario „Stundenplaner:in“ (Login `frank.schulte` → Übersicht → Lauf mit Parametern → Abbruch → zweiter Lauf → Vergleich → Übernahme ab Stichtag → zurücknehmen; **Vertretung mit Fachtausch**; Sekretariat 404 auf `/planung`; alte URLs leiten weiter) + **Review-PR GATE SP** (erledigte IDs, Tests, Fragen) | S | Opus | SP-10, SP-12 | – | `e2e/zx-gate-sp.spec.ts` |
| **GATE SP** | Review mit der Projektleitung (Review-PR aus SP-11; `/code-review ultra` nach Wunsch) – merged nur die Projektleitung | – | – | SP-11 | – | – |

Reihenfolge: SP-02 ✅ → SP-03 ✅ → SP-04 ✅ → SP-05 ✅ → SP-06 ‖ SP-12 → SP-07 → SP-08 ‖ SP-09 → SP-10 → SP-11 → **GATE SP**.
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
| Vorschläge | je Kandidat `suggestedSubjectId` = Fach, das die Lehrkraft regulär in dieser Gruppe gibt (bei mehreren das mit den meisten Wochenstunden); Grund „kann eigenes Fach geben: Mathe“ (+10) nur, wenn sie die Gruppe kennt, aber nicht das ausgefallene Fach unterrichtet. Rangfolge bleibt: frei durch Freisetzung > kennt Klasse > kennt Fach > Hohlstunde. Knopf „→ Mathe“ übernimmt Lehrkraft **und** Fach |
| Anzeige | Slot zeigt das abweichende Fach (Name/Farbe) mit „statt Sport“: Mein Stundenplan, Tagesleiste, Klassen-/Lehrkraft-/Raumplan, Druck, Vertretungsplan, Druck Vertretungsplan, Monitor („Mathe (statt Sport)“) |
| Gong | „Vertretung Di, 3. Std: Mathe statt Sport (7b) …“, Eltern-Bündelung unverändert |
| Klassenbuch | Eintrag der Vertretungsstunde trägt das tatsächliche Fach |
| Statistik | Zähler „davon mit eigenem Fach“ in Vertretungsstatistik und Mein Deputat (rein informativ) |
| Ohne Wirkung | Notenbuch (hängt an Lehraufträgen), Unterrichtsverteilung, Solver |
| Bewusst nicht | eigener `kind` „Fachtausch“, Fachwechsel bei Entfall/Raumänderung, Verrechnung im Deputat, automatische Übernahme des Vorschlags |

---

## 7. Folgeblock „SP2 – Planungstiefe“ (nach GATE SP, eigener GATE)

Entscheidungen der Projektleitung 2026-10-19 (Q-SP-13 … Q-SP-16): Zielschule ist **jetzt Sek I sauber**; Bänder (heterogene
Kopplung, E/G, WP, Reli/Philo, Oberstufen-Schienen) und Tagesgrenzen/Ganztag kommen im Folgeblock SP2. Dazu der CSV-Import der
Unterrichtsverteilung (nur Lehraufträge – kein Import von Plänen oder fremden Austauschformaten) und die Vertretung Stufe 2.
Reihenfolge nach Abhängigkeit, Feinplanung (Migrationen, Tests) beim Start des Blocks. **Kern** = Solver-Kernlogik.

| ID | Titel | Größe | Kern | hängt ab von | Quelle |
|---|---|---|---|---|---|
| **SP2-01** | Bänder – Datenmodell und Unterrichtsverteilung: `timetable_bands` (Schuljahr, Name, Wochenstunden, Doppelstunden) mit n Lehraufträgen als Mitglieder; Lehraufträge bleiben 1 Fach, 1 Gruppe, 1–2 Lehrkräfte; „Gekoppelt mit“ wird zum Band; Pflege-UI, Soll/verplant je Band | M | – | GATE SP | SP-G-01 |
| **SP2-02** | Bänder im Solver, in Setzhilfe und Übernahme: Einheit = Band mit `parts[]` (eigene Lehrkraft/Fach/Raum je Teil), `chooseRoom` je Teil, eine `coupling_id` je Band-Stunde, Setzhilfe setzt/verschiebt das Band als Einheit; Kursband zählt für Klassen-Hohlstunden | L | **ja** | SP2-01 | SP-G-01 |
| **SP2-03** | Tagesgrenzen und Ganztag je Jahrgangsstufe: `maxPerDay`, `afternoonsPerWeek`, `lunchAfterPeriod` (Mittagspause Pflicht bei Unterricht danach), Vorgaben aus dem Schulform-Katalog; hart im Solver, Diagnose-Kategorie | M | **ja** | GATE SP | SP-G-04b |
| **SP2-04** | Lehrkraft-Tagesregeln und Fachverteilung: optional `maxPerDay`/`maxDays` je Lehrkraft (Deputats-Seite), weiche Kosten Anwesenheitstage; Kosten `subjectSpread` (nicht an Folgetagen geballt), Gewichte in den Voreinstellungen | S–M | **ja** | SP2-03 | SP-G-05, SP-G-06 |
| **SP2-05** | Hohlstunden Oberstufe/Kursband im Solver (Jahrgang ohne Klasse) + Diagnose-Kategorie Zeitwünsche (gesperrt belegt = Fehler, −3/−2 = Warnung; Tausch in der Setzhilfe prüft Sperren) | S–M | **ja** | SP2-02 | SP-G-11, SP-G-12 |
| **SP2-06** | CSV-Import der Unterrichtsverteilung (Klasse/Kurs; Fach; Stunden; Lehrkraft[; Doppelstunden; Raumwunsch]) mit Vorschau, Zuordnung über Kürzel, Fehlerliste und Trockenlauf; nur Lehraufträge, kein Plan | S | – | GATE SP | Q-SP-14 |
| **SP2-07** | Vertretung Stufe 2: Verlegung (Stunde auf einen Entfall-Slot vorziehen/tauschen), Zusammenlegung/Mitbetreuung (Gruppe geht zu Gruppe Y), Bereitschaft (Reserve je Slot, oben in den Vorschlägen); Anzeige/Gong/Monitor/Druck mitziehen | M | – | GATE SP | SP-G-08, Q-SP-15 |
| **SP2-08** | Dauervertretung für den Zeitraum einer Abwesenheit (erzeugt Vertretungen für alle Tage) + Vertretungsbedarf im Wochenblick (nächste 5 Schultage) | S–M | – | SP2-07 | SP-G-09, SP-G-10 |
| **SP2-09** | Lehrauftrag mit Gültigkeit (`valid_from/until`, Vorgabe Schuljahr; Verteilung und Solver am Stichtag, Übernahme bis `valid_until`) | M | teilw. | SP2-02 | SP-G-07 |
| **SP2-10** | Drucke/Exporte: Gesamtübersicht alle Klassen/alle Lehrkräfte, Unterrichtsverteilung, Deputate, Aufsichtsplan, Vertretungsstatistik (Druck + CSV) | S–M | – | GATE SP | SP-G-14 |
| **SP2-11** | E2E-Szenario „Gesamtschule“ (Band E/G Mathe 7 + WP + Tagesgrenze → Lauf → Übernahme; Verlegung/Bereitschaft; CSV-Import) + Review-PR **GATE SP2** | S | – | SP2-01 … SP2-10 | – |
| **GATE SP2** | Review mit der Projektleitung – merged nur die Projektleitung | – | – | SP2-11 | – |

Nur auf Nachfrage von Schulen (Kann): A/B-Wochen im Solver (SP-G-17), Lehrbefähigung (SP-G-18), Wertrechnung/Faktoren (SP-G-19),
faire Aufsichtsverteilung (SP-G-20), ICS-Abo des Stundenplans (SP-G-21), Matrix Lehrkraft × Fach (SP-G-22). Oberstufen-Blockung
aus Kurswahlen (SP-G-24) wird eine eigene Phase nach SP2 (braucht Bänder).

**Bewusst nicht (Q-SP-16):** mehrere Zeitraster je Jahrgang, Minutenstundenplan, Samstag · Standorte/Wegezeiten/Abteilungen ·
Mehrarbeits-Abrechnung (Zähler bleiben) · Import/Export von Plänen im Austauschformat fremder Software · Plan-Versionen (Q-SP-12).
