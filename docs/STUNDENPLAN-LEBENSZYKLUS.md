# SP3-00: Lebenszyklus des Stundenplans und Vertretung mit mehr Infos – Architekturkonzept

> Stand: 2026-10-28 (SP3-06 umgesetzt) · Status: **abgenommen** (Projektleitung 2026-10-26: Fragebogen Runde 10 in §11, alle Empfehlungen angenommen) · Auftrag der Projektleitung 25.10.2026
> (Arbeitsplan ab 26.10., Phase B1; Vorgaben „Nachtrag 25.10.“, „Sicht eines Stundenplaners“ und „Antworten 25.10.“).
> Hebt die Entscheidung Q-SP-12/Q-SP-16 („keine Plan-Versionen“) auf – ausdrücklich durch die Projektleitung 25.10.2026.
> Aufgaben nach Abnahme: `BACKLOG.md`, Blöcke **VT** (Vertretung) und **SP3** (Lebenszyklus). Dieses Dokument ändert keinen Code
> und legt keine Migration an; Migrationsnummern stehen als „0106 ff.“ – endgültig erst beim jeweiligen PR auf aktuellem `main`
> (parallel entsteht 0105 in SP2-12).

---

## 0. Kurzfassung

**Befund.** Der Stundenplan ist heute eine Menge von Zeilen `timetable_lessons` mit `valid_from`/`valid_until`. Es gibt keine
Plan-Entität, keinen Entwurf und keine Freigabe: Setzhilfe, Stundenpflege und Kopplungen schreiben sofort in den gültigen Plan;
der einzige „Veröffentlichen“-Schritt ist die Übernahme eines Solver-Laufs ab Stichtag (SP-09) mit Zurücknehmen bis zum Stichtag.
Eine Vertretung ist eine Zeile je Stunde und Tag mit einem einzigen Hinweis, ohne Grund-Kategorie, ohne Historie, ohne Kenntnisnahme.

**Kernentscheidung A – Entwurfsbereich in eigener Tabelle, Versions-Hülle, Veröffentlichen über die bestehende Übernahme-Mechanik.**
Neue Tabellen `timetable_plan_versions` (Hülle: Schuljahr, Nummer, Status, gültig ab, Freigabe, Rücknahme-Daten) und
`timetable_draft_lessons` (Spalten wie `timetable_lessons` + `version_id` + `origin_lesson_id`). Der gültige Plan bleibt
`timetable_lessons`; **Veröffentlichen** schreibt die Entwurfsstunden ab „gültig ab“ in `timetable_lessons`, beendet ersetzte
Stunden am Vortag und sichert Rücknahme-Daten – exakt die Mechanik, die SP-09/SP-13 schon für Solver-Läufe nutzen. Dadurch bleiben
**alle 25 Leser des gültigen Plans unverändert** (Wochenplan, Klassenbuch, Notenbuch, Sitzplan, Sprechtag, Klausurplan, Buchungen,
Monitor, Druck, Stammdaten-Sperren, Auskunft). Die verworfene Alternative „`plan_version_id` an jeder Stunde + Statusfilter überall“
hätte sieben Leser getroffen, die heute **gar nicht** nach Gültigkeit filtern (Klausurplan-Rechte, Raumbuchungs-Kollision,
Löschsperren für Räume/Fächer/Zeitraster) – Entwurfszeilen wären dort durchgeschlagen.

**Kernentscheidung B – eine „Planquelle“ für Setzhilfe, Diagnose, Vorprüfung und Solver.** `diagnose()`, `placementGrid()`,
der Solver und die Vorprüfung sind heute schon reine Funktionen über Zeilenlisten; nur ihre Lader lesen `timetable_lessons`
am Stichtag. Ein Parameter `PlanSource = { kind: "live", refYmd } | { kind: "draft", versionId }` an den Ladern und Schreibern
(`gridLessons`, `planLessonsOn`, `diagnoseYear`, `solverInputFromDb`, `createLesson`/`saveCoupling`/`placeAssignment`/`moveLesson`,
`applyRun`) reicht; die Prüflogik bleibt unangetastet.

**Kernentscheidung C – Veröffentlichen ist ein Diff, kein Austausch.** Entwurfsstunden tragen `origin_lesson_id`. Unveränderte
Stunden behalten beim Veröffentlichen ihre Live-Zeile (und damit Klassenbuch-Einträge, Vertretungen, Material); nur geänderte
Stunden werden beendet/neu angelegt. Vertretungen und Material ab Stichtag ziehen auf die Nachfolgestunde um, wenn es eine gibt;
sonst stehen sie in der Vorschau als Konflikt. Das macht Folgeversionen während der Laufzeit (1.1, Halbjahr) klein und sicher.

**Kernentscheidung D – Planungsfahrplan statt Assistent.** Der Fahrplan ist eine Checkliste mit acht Schritten, deren Status aus den
Daten berechnet wird (offene Punkte als Zahl, Ampel, Sprungziel). Er ersetzt die Sektion „Jahresplanung“ der Übersicht `/planung`,
sobald ein Entwurf existiert, und ist der Einstieg für „Neues Halbjahr“, „Neues Schuljahr“ und „Änderung im laufenden Plan“.

**Kernentscheidung E – Vertretung erweitert statt neu gebaut.** `timetable_substitutions` bekommt Grund-Kategorie (öffentlich,
grob), internen Hinweis, Änderungszeitpunkt, Kenntnisnahme und eine Änderungshistorie (`timetable_substitution_changes`); Material löst
sich von der Abwesenheit; Tagesmitteilungen kommen als eigene Tabelle; Benachrichtigungen bekommen eine Sendewarteschlange mit
Ruhezeit. Die Freigabe je Tag (`timetable_substitution_days`) bleibt, wie sie ist.

**Paketschnitt (Reihenfolge, Empfehlung – Frage F-10-14):** SP3-DEP + SP3-LA (unabhängig, Priorität 2 der Projektleitung) →
VT-01 → VT-02 → VT-04 ‖ VT-03a → VT-03b → VT-05/GATE VT → Release → SP3-01 → SP3-02 → SP3-03 → SP3-04 → SP3-05 → SP3-06 →
SP3-07 → SP3-08/GATE SP3 → Release.

---

## 1. Ist-Analyse gegen den Code (Stand `main` = `bb8932e`)

### 1.1 Wie der Plan heute gelesen wird

| Leser | Datei (Funktion) | Filter | Was passiert, wenn Entwurfszeilen in `timetable_lessons` lägen |
|---|---|---|---|
| Wochenplan, Heute, Widgets, Kursraum „nächste Stunden“, Klassenbuch (Woche, meine Stunden, Hausaufgaben-Fälligkeit), Hausmeister-Wartung | `service.ts` `listSlots()` – SQL-Überlappung mit `[from, to)` + `lessonActiveOn()` je Tag | **Gültigkeit** | Entwurf sichtbar, sobald sein `valid_from` erreicht ist |
| Plandruck, Regelplan „Plan am Tag X“ | `service.ts` `regularSlots()` | Gültigkeit am Stichtag | wie oben |
| Setzhilfe (Freiraster, Verschieben) | `setzhilfe.ts` `gridLessons()`, `movePlacement()` | Überlappung mit der Gültigkeit der Einheit | Entwurf blockiert Live-Slots |
| Diagnose | `diagnose.ts` `diagnoseYear()` – Stunden am `refYmd` der Verteilung | Gültigkeit am Stichtag | Entwurf zählt mit |
| Solver-Eingabe (fixierte Stunden, ersetzbare Stunden) | `solver-input.ts` `solverInputFromDb()` → `planLessonsOn()`, `gridLessons(ref, ref)` | Gültigkeit am Stichtag | Entwurf gilt als fixiert/ersetzbar |
| Vertretung (Tagesstunden, Kopplungsteile) | `vertretung.ts` `dayLessons()` – **nur Wochentag** in SQL, dann `lessonActiveOn()` | Gültigkeit (JS) | – |
| Vertretungsplan, Monitor, Druck | `vertretung.ts` `substitutionsOn()` – Join über `lesson_id` | **keiner** (die Vertretung zeigt auf die Zeile) | – |
| Klassenbuch-Eintrag | `klassenbuch/service.ts` `lessonContext()` – Stunde per id + `lessonActiveOn(date)` | Gültigkeit (JS) | – |
| Notenbuch (Bücher anlegen) | `notenbuch/service.ts` `bookOptions()` | Gültigkeit heute | Entwurf erzeugt Bücher |
| Sitzplan (Gruppen der Lehrkraft) | `sitzplan/service.ts` `teachingGroupIds()` | Gültigkeit heute | – |
| Sprechtag (Lehrkräfte je Kind, Einladungen) | `sprechtag/service.ts`, `einladung.ts` | Gültigkeit am Termin | – |
| **Klausurplan (Rechte: planbare/sichtbare Gruppen)** | `klausurplan/service.ts` `plannableExamGroups()`, `visibleGroupIds()` | **keiner** | Entwurf vergibt Rechte |
| **Raumbuchung (Kollision mit Unterricht)** | `buchungen/service.ts` → `roomLessonAt()` → `dayLessons()` | Gültigkeit (JS) | – |
| **Löschsperren Stammdaten** | `verwaltung/rooms.ts` `roomUsage()`, `stammdaten.ts` `subjectUsage()`, `periodUsage()` | **keiner** | Entwurf blockiert das Löschen |
| Solver-Seite (Zahl fixierter Stunden), Vorschau „behaltene Stunden“ | `planung/solver/page.tsx`, `preview.tsx` | keiner / per id | Entwurf zählt mit |
| Raumsperren (betroffene Stunden) | `raumsperren.ts` `affectedLessons()`, `teachersInRooms()` | alle Zeilen / `listSlots` | Entwurf zählt mit |
| Auskunft (Art. 15), Löschlauf | `core/privacy`, `retention` (LK-SJ-1J ab `valid_until`, Rückfall `created_at`) | – | Entwurf wäre auskunftspflichtig |

**Fremdschlüssel auf `timetable_lessons.id`:** `classbook_entries.lesson_id` (**set null**, keine Rückfallsuche über
Gruppe/Stunde – ein gelöschter Satz verwaist den Eintrag, `hasEntry` wird falsch, ein zweiter Eintrag am selben Tag ist möglich),
`timetable_substitutions.lesson_id` und `merge_lesson_id` (cascade), `timetable_absence_materials.lesson_id` (cascade).

**Folgerung 1:** Entwurfszeilen dürfen **nicht** in `timetable_lessons` liegen. **Folgerung 2:** Jede Planänderung, die Live-Zeilen
löscht oder in place verschiebt, zerreißt Klassenbuch/Vertretung/Material der Vergangenheit – die Setzhilfe (`moveLesson`: `UPDATE
weekday/period`) und die Stundenpflege (`updateLesson`) tun das heute. Das Konzept führt deshalb für Änderungen am gültigen Plan die
Regel **„immer Split, nie in place“** ein (alte Zeile endet am Vortag, neue Zeile ab Stichtag – wie `copyPeriod()` und `applyRun()`).

### 1.2 Wie der Plan heute geschrieben wird

| Schreiber | Datei | Wirkung | Rücknahme |
|---|---|---|---|
| Stunde/Kopplung anlegen, ändern, löschen | `manage.ts` `createLesson`/`updateLesson`/`deleteLesson`/`saveCoupling`/`deleteCoupling` | sofort live, Kollisionsprüfung | keine (nur Audit ohne Vorher/Nachher) |
| Setzhilfe setzen/verschieben/tauschen | `setzhilfe.ts` `placeAssignment`/`moveLesson` | sofort live (über `manage.ts`), `UPDATE` in place | keine |
| Solver-Übernahme ab Stichtag | `solverlauf.ts` `applyRun()`: ersetzbare = nicht fixierte, nicht „behaltene“ Stunden; `valid_from ≥ Stichtag` → gelöscht, sonst `valid_until = Stichtag − 1`; neue Zeilen `valid_from = Stichtag`, `valid_until = min(Jahresende, Lehrauftrag)`, `solver_run_id`; Vertretungen ab Stichtag gelöscht und in `undo` gesichert; Material **still per cascade gelöscht**, Klassenbuch-Einträge verwaist (`set null`) | `undoApply()` bis zum Stichtag: eigene Stunden löschen, beendete verlängern (nur wenn `valid_until` noch exakt Stichtag − 1), gelöschte wieder anlegen, Vertretungen wiederherstellen (SP-13), Konflikte zählen (veränderte/fremde Stunden, Vertretungen, Klassenbuch, Material, Buchungen, Klausuren) |
| Periode kopieren (Halbjahr) | `periode.ts` `copyPeriod()`: Stunden über den Stichtag teilen, Kopie mit neuer `coupling_id`, Vertretungen/Klassenbuch ab Stichtag auf die Kopie | keine; keine Schultag-Prüfung, kein Jahresbezug |
| Fixieren | `solverlauf.ts` `setFixed()` (ganze Kopplung) | – | – |

Nachtjob `solver-aufraeumen` (03:00): leert `undo` ab dem Stichtag, löscht gescheiterte Läufe nach 7 Tagen, behält je Schuljahr die
neuesten 20 Ergebnisse.

### 1.3 Was für den Lebenszyklus fehlt

| Lücke | Heute | Nötig |
|---|---|---|
| Plan-Entität (Name, Nummer, Status, gültig ab, wer hat freigegeben) | keine; `timetable_solver_runs.applied_from` ist der einzige „Veröffentlichungs“-Zeitpunkt | `timetable_plan_versions` |
| Entwurfs-Arbeitsbereich ohne Wirkung auf den Live-Plan | nur Solver-Ergebnis als JSON-Vorschau; Handarbeit sofort live | `timetable_draft_lessons` + `PlanSource` in Setzhilfe/Pflege/Diagnose/Solver |
| Prüfung/Freigabe durch die Schulleitung | nur für Vertretungstage (`timetable_substitution_days`) | Status `pruefung` → `freigegeben`, Recht `stundenplan.review`, Kommentare |
| Vorschau „Mein Plan ab …“ für Lehrkräfte | keine | Schalter je Version, Lesen nur eigener Plan |
| Veröffentlichen mit Änderungsliste je Person | Übernahme ohne Gong | Diff je Lehrkraft/Klasse, gebündelter Gong |
| Änderungen während der Laufzeit nachvollziehbar | in place, nur Audit | Folgeversion 1.1 oder Sofort-Korrektur mit Protokoll (`timetable_plan_changes`) |
| Halbjahreswechsel geführt | „Periode kopieren“ + Lehrauftrags-Gültigkeit (SP2-09), zwei getrennte Handgriffe | Fahrplan-Vorlage „Neues Halbjahr“ (Entwurf aus gültigem Plan ab `term2_starts_on`) |
| Archiv („Plan am Tag X“, Versionsliste) | `regularSlots(refYmd)` kann jeden Tag zeigen, hat aber keine UI dafür | Datumswähler im Plan + Versionsliste; **kein neues Datenmodell nötig** |
| Varianten A/B | Solver-Läufe vergleichbar, Handarbeit nicht | mehrere Entwürfe je Schuljahr, Vergleich in Schritt 7, nur einer veröffentlichbar |
| Diff-Engine Entwurf ↔ gültig / Version ↔ Version | nur `undoState()` (Lauf ↔ Plan) | `origin_lesson_id` + Vergleich je Lehrkraft/Klasse |
| Planungsfahrplan | Übersicht `/planung` mit Kennzahlen (`uebersicht.ts`), keine Reihenfolge, keine Quittierung | 8 Schritte mit Statusfunktionen, Quittierungen in der Version |
| Deputatsmodell | Pflicht (0–40, Vorgabe Schulform), Anrechnungen/Ermäßigungen ohne Gültigkeit, Tagesregeln; `balance = Lehraufträge − Soll` in der Deputats-Karte | Teilzeit-Anteil als Rechenhilfe, Anrechnungen mit „gültig ab/bis“, Bilanz am Stichtag, Live-Bilanz in der Matrix |
| Stundentafel als Soll-Quelle | `curriculum_hours` (Jahrgang × Fach, ohne Schuljahr) wird in Verteilung/Diagnose verglichen, aber nirgends zum **Anlegen** benutzt | Matrix vorbefüllt |
| Lehrervorschläge nur mit Fach | Lehrauftrags-Formular listet **alle** Lehrkräfte, keine Sortierung | Lehrfächer (SP2-12, 0105) + Restdeputat + Kontinuität |
| Hochstufung mit Kontinuität | `promote()` legt neue Klassen an und übernimmt Klassenleitungen, **speichert aber keine Zuordnung alt → neu**; nichts überträgt Lehraufträge | `class_map` im Schuljahreswechsel, Vorschlag „Lehrkraft folgt der Klasse“ |
| Lehrerwünsche | Zeitwunsch-Fenster mit Frist, Erinnerung, Abgabestand – **ohne Mengenbegrenzung** (−3…+3/gesperrt je Slot) | bleibt (Vorgabe Projektleitung), Rücklauf im Fahrplan |
| Solver-Erklärbarkeit | Grund je „nicht gesetzt“ aus `explain()` (Lehrkraft/Gruppe/Raum/Tagesgrenze/Tagesregel) vorhanden | reicht für SP3; „warum nicht besser“ bleibt außen vor |

### 1.4 Was für die Vertretung fehlt

| Lücke | Heute (`timetable_substitutions`, `vertretung.ts`, `freigabe.ts`, `vertretung-gong.ts`) | Nötig |
|---|---|---|
| Grund-Kategorie der Änderung | nur der Grund der **Abwesenheit** (nur Planung sieht ihn); bei Gruppenabwesenheit landet er im Schüler-Hinweis | `reason` (öffentlich, grob) |
| Öffentlicher vs. interner Hinweis | ein Feld `note` „für Schüler:innen“; Eltern bekommen `note: null` | `internal_note` (nie Schüler:innen/Eltern/Monitor) |
| Material ohne Abwesenheit | `timetable_absence_materials.absence_id` **not null**, `follows` Abwesenheit | `absence_id` nullable, Material an (Stunde, Tag) |
| Historie/Änderungsmarker | Upsert auf `(lesson_id, date)` überschreibt alles inkl. `created_by/created_at`; kein `updated_at`; Vorschau zeigt nicht „neu/geändert seit …“ | `updated_at/by`, `timetable_substitution_changes` (vorher → nachher) |
| Raum „alt → neu“ | `SlotChange.roomId` = neuer Raum; der alte steht im Slot – Anzeige uneinheitlich (prüfen: Monitor, Druck, Vertretungsplan) | Anzeige-Regel in `display.ts` |
| Tagesmitteilungen | keine | `timetable_day_notes` |
| Kenntnisnahme | keine | `acknowledged_at` auf der Vertretung; Liste Unbestätigter |
| Betreuung/EVA | nur `substitute` (= Unterricht) | Häkchen „nur Betreuung“ (Frage F-10-9) |
| Sendezeitpunkt | Gong sofort beim Speichern bzw. Veröffentlichen (`notifySubstitutionDay`, Bündel `stundenplan:<date>`); Ruhezeit gibt es nicht; kein verzögerter Versand im Gong-Kern | Sendewarteschlange (`timetable_notification_queue`) + Einstellungen |
| Arbeitsplatz-Layout | Seite `/planung/vertretungen` (Liste + Formular), Wochenblick | VT-03a/b (Board-Idee „Vertretung als Arbeitsplatz“) |

Vorhanden und wiederverwendbar: Tagesfreigabe (`timetable_substitution_days`), Vorschlags-Bewertung (`vorschlaege.ts`, Bereitschaft +40,
kennt Gruppe +20 …), Tagesregeln bei Vertretungen, Dauervertretung, Wochenblick, Zähler/Statistik, Gong-Bündelung je Person und Tag mit
`pg_advisory_xact_lock`, Eltern-Information bis Jahrgang (Einstellung), Jobsperre `runExclusive()` (`core/jobs.ts`), Audit.

---

## 2. Zielbild

### 2.1 Lebenszyklus einer Planversion

```
                 ┌──────────┐  zur Prüfung   ┌──────────┐  Freigabe (SL)  ┌─────────────┐  veröffentlichen  ┌─────────┐  nächste Version  ┌────────────┐
 anlegen ──────► │ entwurf  │ ─────────────► │ pruefung │ ──────────────► │ freigegeben │ ────────────────► │ gueltig │ ────────────────► │ archiviert │
                 └──────────┘ ◄───────────── └──────────┘ ◄────────────── └─────────────┘   (gültig ab,     └─────────┘   (gültig bis =   └────────────┘
                      │        zurück an die       │       Freigabe zurück        │           Stichtag)          ▲          Vortag)
                      │        Planung             │                              │                              │
                      ▼                            ▼                              ▼                              │ Übernahme zurücknehmen
                 ┌───────────┐                verworfen (Variante, die nicht veröffentlicht wird)               │ (bis zum Stichtag, SP-09-Mechanik)
                 │ verworfen │ ◄──────────────────────────────────────────────────────────────────────────────────┘
                 └───────────┘
```

- **entwurf** – nur `stundenplan.manage` sieht und bearbeitet; der Live-Plan ist unberührt. Beliebig viele Entwürfe je Schuljahr
  (Varianten); Standard ist **einer**.
- **pruefung** – zusätzlich lesen `stundenplan.review` (Schulleitung) und – wenn der Planer die Vorschau einschaltet – jede Lehrkraft
  **ihren eigenen** Plan ab Stichtag („Mein Plan ab 01.02.“). Kommentare je Version, optional an Lehrkraft/Klasse/Slot.
- **freigegeben** – Schulleitung hat freigegeben (`approved_by/at`); Planung kann noch veröffentlichen oder die Freigabe zurückgeben.
  Inhaltliche Änderungen setzen den Status auf `entwurf` zurück (Freigabe verfällt; Prüfkommentare bleiben).
- **gueltig** – veröffentlicht mit `valid_from` (Stichtag = Schultag, wie SP-09). Genau **eine** Version je Schuljahr und Tag; die
  Vorgängerversion erhält `valid_until = Stichtag − 1` und wird `archiviert`. Bis zum Stichtag ist die Veröffentlichung zurücknehmbar
  (`undo`, Nachtjob leert es danach – wie heute).
- **archiviert** – lesbar (Versionsliste, „Plan am Tag X“ über `regularSlots(refYmd)`: der Live-Plan ist durch `valid_from/valid_until`
  bereits seine eigene Historie). **verworfen** – Varianten, die nicht veröffentlicht wurden, und abgebrochene Entwürfe; Entwurfsstunden
  werden mit der Version gelöscht (Löschklasse §5).

Versionsnummer: `major.minor` automatisch – neue Planung (Schuljahr/Halbjahr) zählt `major` hoch, Folgeversion während der Laufzeit
`minor`; dazu ein freier Name („2. Halbjahr“, „Variante Mo frei“ – keine Personen). Varianten tragen `parent_version_id` und zählen
bis zur Veröffentlichung nicht.

### 2.2 Ausgangsbasis eines Entwurfs (`source`)

| Quelle | Inhalt | ersetzt |
|---|---|---|
| `live_copy` (gültiger Plan ab Stichtag) | Kopie aller Stunden, die am Stichtag gelten, mit `origin_lesson_id` | „Periode kopieren“ (`copyPeriod`) – wird zum Fahrplan-Schritt 1 „Neues Halbjahr“ |
| `solver_run` | Übernahme eines Laufs **in den Entwurf** (ersetzt dort die nicht fixierten Stunden) | direkte Übernahme in den Live-Plan (Frage F-10-1) |
| `previous_version` | Kopie einer archivierten/verworfenen Version | – |
| `variant_of` | Duplikat eines anderen Entwurfs („Variante anlegen“) | – |
| `empty` | leer (nur fixierte Stunden optional übernehmen) | – |

### 2.3 Veröffentlichen als Diff (SP3-04)

`publishVersion(db, actorId, versionId, validFrom, todayYmd)` in **einer** Transaktion, Prüfungen wie `applyRun()` (Status
`freigegeben`, Stichtag Schultag nach heute im Schuljahr, Diagnose ohne Fehler bzw. quittierte Warnungen – §4 Schritt 7):

1. **Diff** je Entwurfsstunde gegen ihre `origin_lesson_id`: `unverändert` (gleiche Gruppe/Fach/Lehrkraft/Raum/Wochentag/Stunde/Woche,
   Kopplung gleich) → Live-Zeile bleibt **unangetastet** (id, Klassenbuch, Vertretungen, Material bleiben); `geändert` → Live-Zeile
   endet Stichtag − 1, neue Zeile ab Stichtag; `neu` (ohne origin) → neue Zeile; Live-Stunden am Stichtag ohne Entwurfs-Gegenstück →
   `entfallen` (enden Stichtag − 1; Zeilen mit `valid_from ≥ Stichtag` werden gelöscht und in `undo` gesichert).
2. **Übertrag**: Vertretungen, Material und Klassenbuch-Einträge mit `date ≥ Stichtag` an geänderten/entfallenen Stunden ziehen auf die
   Nachfolgezeile um, wenn der Nachfolger derselben `origin` am selben Tag noch stattfindet (gleicher Wochentag, Woche, aktiv); sonst
   werden sie in `undo` gesichert, gelöscht (Vertretung, Material) bzw. mit `lesson_id = null` belassen (Klassenbuch) **und in der
   Vorschau gezählt** – heute verschwindet Material still (cascade), das ist ein Befund dieses Konzepts.
3. Neue Zeilen: `valid_from = max(Entwurf.valid_from, Stichtag)`, `valid_until = min(Entwurf.valid_until, Jahresende)` (Lehrauftrags-
   Gültigkeit kommt aus dem Entwurf), `plan_version_id = Version`, `solver_run_id` aus dem Entwurf (Herkunft bleibt), `coupling_id` je
   Kopplung neu (`withCouplingIds`).
4. Version → `gueltig` mit `valid_from`, `published_by/at`, `undo` (Struktur wie `timetable_solver_runs.undo`: `ended`, `deleted`,
   `substitutions`, neu `materials`, `classbookDetached`, `moved`); Vorgängerversion → `archiviert`, `valid_until`; übrige Entwürfe
   desselben Zeitraums bleiben `entwurf` (Hinweis „gültige Version ist jetzt 2.0“) – Verwerfen entscheidet der Planer.
5. **Änderungsliste je Person**: aus dem Diff je Lehrkraft (eigene Stunden) und je Klasse/Kurs (Gruppen) ein gebündelter Gong
   `stundenplan:plan:<version>` mit Link auf „Mein Plan ab <Stichtag>“ (Lehrkräfte sofort, Schüler:innen/Eltern nach Einstellung wie bei
   Vertretungen – Frage F-10-4). Kein Gong für Unveränderte.
6. Audit `stundenplan.plan.publish` mit Zahlen, keine Personen.

`undoPublish()` = `undoApply()` auf Versionsebene (Konfliktzählung übernehmen); die Solver-eigene Übernahme entfällt (F-10-1) bzw.
wird eine Zwei-Schritt-Abkürzung („Lauf übernehmen“ = Entwurf füllen + direkt Schritt 8).

**Umgesetzt mit SP3-04** (Abweichungen und Vorgaben zu Detailfragen in §3.1 „Umgesetzt (SP3-04)“): Diff mit Zeitraum und Kopplung als
Einheit, Übertrag nur bei gleichem Wochentag, Varianten derselben Nummer werden verworfen (statt stehen zu bleiben), Schritt 7 (Diagnose ohne
Fehler/quittierte Warnungen) prüft erst der Fahrplan (SP3-06).

### 2.4 Änderungen während der Laufzeit (SP3-05)

- **Folgeversion 1.1**: Fahrplan-Vorlage „Änderung im laufenden Plan“ → Entwurf `live_copy` ab Stichtag, bearbeiten, Schritt 7 zeigt nur
  den Diff, Freigabe durch SL (Frage F-10-3: bei Kleinänderungen entbehrlich?), veröffentlichen. Betroffene bekommen nur ihre Änderungen.
- **Sofort-Korrektur** (Frage F-10-2): `manage` darf weiter direkt im gültigen Plan arbeiten (Raumtausch, Lehrkraft nach Erkrankung über
  Wochen, Stunde verschieben) – aber **als Split** ab einem Stichtag (Vorgabe nächster Schultag): alte Zeile endet am Vortag, neue Zeile ab
  Stichtag, Vertretungen/Material ab Stichtag ziehen um (dieselbe Übertrag-Funktion wie 2.3), Protokoll in `timetable_plan_changes`
  (Version `gueltig`, `lesson_before`/`lesson_after` als JSON ohne Namen, Aktor, Zeitpunkt, optionale Begründung), Gong an betroffene
  Lehrkraft und Gruppe. Die Setzhilfe im Live-Plan (`moveLesson`, heute `UPDATE` in place) wird darauf umgestellt; `updateLesson` ebenso.
  Reine Korrekturen **ohne** Zeitbezug (Tippfehler im Raum vor Schuljahresbeginn, Stunde liegt noch in der Zukunft) bleiben in place.
- **Halbjahr**: Fahrplan-Vorlage „Neues Halbjahr“ = `live_copy` ab `school_years.term2_starts_on`, Lehraufträge am Stichtag
  (SP2-09), Solver-Lauf mit „Lehraufträge am 01.02.“ in den Entwurf, Veröffentlichen ab 01.02. – ersetzt „Periode kopieren“ im Ablauf
  (die Funktion bleibt intern als `live_copy`).

**Umgesetzt mit SP3-05** (Vorgaben zu Detailfragen in §3.1 „Umgesetzt (SP3-05)“): Sofort-Korrektur in Pflege und Setzhilfe als Split ab dem nächsten Schultag mit
Protokoll und Gong, in place nur ohne Vergangenheitsbezug (beginnt nach heute oder heute neu angelegt ohne Einträge), Hinweis ab 10 geänderten Stunden; offene
Entwürfe ziehen Korrekturen nach (R3); Vorlagen „Änderung im laufenden Plan“ und „Neues Halbjahr“ auf der Versionsliste; „Periode kopieren“ ist entfernt.

### 2.5 Varianten

- „Variante anlegen“ dupliziert den Entwurf (`variant_of`, gleiche `origin_lesson_id`s) – Standard bleibt ein Entwurf.
- Vergleich in Schritt 7: Kennzahlen je Version (Hohlstunden L/K, Randstunden, erfüllte Wünsche %, Raumauslastung, Diagnose-Zähler) in
  der Tabelle des Solver-Vergleichs (`solververgleich.ts` bekommt eine zweite Quelle „Version“), dazu Vorschau Klasse/Lehrkraft nebeneinander.
- **Lehraufträge, Zeitwünsche, Bänder, Deputate sind nicht versioniert** (Frage F-10-5): Varianten unterscheiden sich in der Setzung.
  „Was-wäre-wenn“ in der Unterrichtsverteilung läuft über die Lehrauftrags-Gültigkeit oder nacheinander.
- **Veröffentlichen einer Variante verwirft die Varianten derselben Nummer** (Projektleitung 2026-10-28, SP3-04; ursprünglich „die anderen bleiben
  stehen“): veröffentlicht wird genau eine, ihre Nummer ist danach vergeben, die übrigen Varianten dieser Nummer werden verworfen (bei der
  Rücknahme wieder offen). Andere Entwürfe (andere Nummer) bleiben stehen, die Vorschau weist darauf hin; Verwerfen
  ist ein Klick. Nach Schuljahresende verwirft der Nachtjob offene Entwürfe des Vorjahrs (Löschklasse).

---

## 3. Datenmodell-Skizze

Spalten nur, soweit entscheidungsrelevant; Namen englisch, Tabellen-Präfix `timetable_` (Modul `stundenplan`). Neue Enum-Werte nur
hinten anfügen. **Migrationsnummern 0106 ff., endgültig bei der Umsetzung** (0105 = SP2-12 Lehrfächer/Prognose).

### 3.1 Lebenszyklus (SP3)

**`timetable_plan_versions`** (SP3-01)
`id` · `school_year_id` FK cascade · `major int` · `minor int` · `name text` (keine Personen) · `status plan_version_status`
(`entwurf`, `pruefung`, `freigegeben`, `gueltig`, `archiviert`, `verworfen`) · `source plan_version_source` (`live_copy`, `solver_run`,
`previous_version`, `variant_of`, `empty`, `bestand`) · `parent_version_id` FK set null (Variante von / Folgeversion von) ·
`source_run_id` FK `timetable_solver_runs` set null · `valid_from date` · `valid_until date` · `teacher_preview bool default false` ·
`checklist jsonb` (Fahrplan: manuelle Häkchen, Termine, Quittierungen – SP3-06) · `created_by/created_at` · `submitted_by/at` ·
`approved_by/at` · `published_by/at` · `undo jsonb` · Check: `valid_until is null or valid_until >= valid_from`; Unique
`(school_year_id, major, minor)`; partieller Unique-Index „höchstens eine Version `gueltig` je Schuljahr“ (Zeitraum-Eindeutigkeit prüft
der Service über `valid_from/valid_until`).
*Daten-Migration:* je Schuljahr mit Stunden eine Version `1.0` „Bestand“ (`source = bestand`, `status = gueltig` für das laufende Jahr,
`archiviert` für ältere, `valid_from = starts_on`); Stunden bekommen `plan_version_id` nur, wenn sie am Migrationstag gelten.

**`timetable_draft_lessons`** (SP3-01)
Spalten **identisch** zu `timetable_lessons` (`group_id`, `weekday`, `period_nr`, `subject_id`, `teacher_id` set null, `room_id`, `week`,
`valid_from`, `valid_until`, `coupling_id`, `fixed`, `solver_run_id`) + `version_id` FK cascade + `origin_lesson_id` FK
`timetable_lessons` set null + `assignment_id` FK set null (Herkunft für Diff/Deputat). Gleiche Checks/Indizes. Im Code über eine
gemeinsame Spaltenfabrik `lessonColumns()` definiert, damit `typeof timetableLessons` und `typeof timetableDraftLessons` dieselbe Form
haben und `findCollisions`, `gridLessons`, `planLessonsOn` generisch über `lessonTable(source)` laufen.

**`timetable_lessons.plan_version_id`** (SP3-01, additiv) FK set null – nur Herkunft/Archiv-Anzeige; kein Leser filtert danach.

**`timetable_plan_comments`** (SP3-03)
`id` · `version_id` cascade · `author_id` FK set null · `target jsonb` (`{kind: "teacher"|"group"|"slot"|"version", id?, weekday?, period?}`)
· `body text` (≤ 500 Zeichen, Hinweis „keine Gesundheitsangaben“) · `created_at` · `resolved_by/at`. Sichtbar für `manage` und `review`;
eine Lehrkraft sieht nur eigene Kommentare.

**`timetable_plan_changes`** (SP3-05)
`id` · `version_id` cascade (die gültige Version) · `kind` (`split`, `inplace`, `delete`, `create`) · `lesson_id` set null ·
`successor_id` set null · `before jsonb` · `after jsonb` (Stunden-Felder, ids statt Namen) · `reason text` (optional, ≤ 120, keine
Personen) · `actor_id` set null · `created_at` · `notified_at`.

**`school_year_transitions.class_map jsonb`** (SP3-LA/SP3-07): `{ "<alte Gruppen-id>": "<neue Gruppen-id>" }` aus `promote()` – heute geht
die Zuordnung verloren; „Übernahme Vorjahr mit Kontinuität“ braucht sie.

**Deputat (SP3-DEP):** `timetable_deputies.employment_percent numeric(5,1)` (optional, nur Rechenhilfe: Pflicht = Vorgabe × Anteil,
gespeichert bleibt `obligation`) · `timetable_deputies.obligation_term2 numeric(4,1)` (optional: Pflicht ab `term2_starts_on`) ·
`timetable_reductions.valid_from/valid_until date` (optional, im Schuljahr). `deputyAccounts()` rechnet am Stichtag der Verteilung
(`refYmd`), die Deputats-Karte zeigt beide Halbjahre, wenn sie sich unterscheiden.

**Umgesetzt (SP3-DEP, 2026-10-27, Migration 0107)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- `timetable_deputies.obligation` ist jetzt **nullable** (leer = Vorgabe der Schulform), damit „nur das 2. Halbjahr weicht ab“ die Vorgabe des
  1. Halbjahrs nicht einfriert. Bestandszeilen behalten ihren Wert (Test `deputate.migration.test`).
- **Rechenhilfe Teilzeit:** Pflicht = Vorgabe × Anteil, **auf halbe Stunden gerundet** (25,5 × 50 % = 12,75 → 13). Der Anteil allein (Pflicht leer)
  speichert die berechnete Stundenzahl; eine eingetragene Pflicht geht vor, der Anteil bleibt nur als Angabe. Im Formular rechnet die Hilfe live
  und kann den Wert übernehmen. Anteil über 0 bis 100 % mit höchstens einer Nachkommastelle. Die Vorgabe wirkt nicht auf `obligation_term2`.
- **Pflicht 2. Halbjahr** gilt ab `school_years.term2_starts_on`; ohne diesen Tag lässt sie sich nicht setzen, und ein vorhandener Wert zählt nicht.
- **Gültigkeit:** „gültig ab/bis“ einschließlich, beide optional, nur innerhalb des Schuljahres; leer = ganzes Schuljahr. Am Stichtag nicht
  geltende Einträge stehen in der Karte grau mit „gilt am Stichtag nicht“ (löschbar), in „Mein Deputat“ als „gilt heute nicht“.
- **Halbjahrs-Tabelle** zeigt Pflicht und Soll **am ersten Tag** jedes Halbjahres; sie erscheint, wenn sich Pflicht oder Soll unterscheiden. Die
  Lehrkräfte-Übersicht nennt das Soll des anderen Halbjahrs klein unter dem Soll.
- **Stichtag** ist überall der der Unterrichtsverteilung (`distribution().refYmd`, auf das Schuljahr begrenzt): Karte/Übersicht/Diagnose mit
  `?stichtag=`, Export „Deputate“, Lehrervorschläge (Restdeputat = Soll − Lehraufträge) und Fachbedarf mit heute, „Mein Deputat“ mit heute.
  Die Prognose fürs Folgejahr nutzt weiter das Soll am Stichtag (keine Halbjahres-Mittelung).
- Export „Deputate“ behält seine Spalten (Pflicht und Ermäßigungen am Stichtag); Teilzeit-Anteil/Pflicht 2. Hj stehen nur in Karte und „Mein Deputat“.
- Datenschutz: neue Spalten in den bestehenden Löschklassen (LK-SJ-1J ab Schuljahr), Kategorien im Manifest ergänzt; Kontolöschung löscht die
  Zeilen wie bisher per Fremdschlüssel. Pflege nur mit `stundenplan.manage`; das Audit-Ereignis `stundenplan.deputy.obligation` nennt alle drei Werte.

**Umgesetzt (SP3-LA, 2026-10-27, Migration 0108)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Matrix je Jahrgang** (`?ansicht=matrix&jahrgang=7`, Vorgabe der kleinste Jahrgang): Zeilen = Klassen des Schuljahrs (keine Kurse/AGs),
  Spalten = Fächer der Stundentafel des Jahrgangs plus Fächer mit Lehraufträgen in diesen Klassen. Stichtag wie in der Verteilung.
- **Bearbeitbar** ist eine Zelle, wenn sie leer ist oder genau einen eigenständigen Lehrauftrag mit höchstens einer Lehrkraft hat; Bänder
  und Teamteaching zeigt die Zelle mit Link ins Formular. Doppelstunden, Band und Raum stehen nicht in der Zelle (Formular); beim Ändern
  bleiben Raum, Hinweis, Gültigkeit und Doppelstunden (höchstens Stunden/2) erhalten, neue Lehraufträge haben 0 Doppelstunden.
- **Stunden:** leer = Stundentafel-Soll (sobald eine Lehrkraft eingetragen ist), **0 = Lehrauftrag löschen** (die Zelle zeigt „wird gelöscht“).
  Eine Zelle ohne Lehrkraft mit Stunden legt einen offenen Lehrauftrag an.
- **Gültigkeit neuer Lehraufträge:** sie füllen die Lücke am Stichtag zwischen Lehraufträgen derselben Zelle aus anderen Zeiträumen
  (`gapAround`; z. B. nach einem Lehrauftrag „bis Ende 1. Halbjahr“ → „ab Beginn 2. Halbjahr“), sonst ganzes Schuljahr.
- **Typeahead** ist ein Textfeld mit Vorschlagsliste je Fach (Kürzel; Name und Restdeputat live mit den ungespeicherten Änderungen).
  Vorgeschlagen: aktive Lehrkräfte mit dem Lehrfach; „alle Lehrkräfte vorschlagen“ ergänzt die übrigen (fachfremd / Lehrfächer fehlen).
  Fachfremd speichern nur mit dem Häkchen „trotzdem“ (Regel P7, prüft auch der Server, Audit `off_subject`). Pfeiltasten zwischen Zellen
  gibt es nicht (Pfeile bedienen die Vorschlagsliste); Tab, Enter (Zelle speichern), Esc (Zelle zurücksetzen).
- **Speichern** je Zelle einzeln: eine fehlerhafte Zelle hält die anderen nicht auf und behält ihre Eingabe mit Hinweis. Audit je Lehrauftrag
  wie im Formular, dazu `stundenplan.assignment.matrix` mit Anzahlen (angelegt/geändert/gelöscht/abgelehnt, Quelle).
- **Live-Bilanz:** Seitenleiste mit den betroffenen Lehrkräften (bisherige und neue Lehrkraft geänderter Zellen): Soll am Stichtag,
  Lehraufträge inkl. Änderungen, Rest. Gerechnet im Browser (`liveBalance`), nach dem Speichern vom Server neu.
- **Übernahme** (F-10-7) füllt nur **leere** Zellen mit Vorschlägen (blau markiert, mit Herkunft), gespeichert wird erst mit „Änderungen
  speichern“; einzeln änderbar oder mit Esc verwerfbar. Stunden = Stundentafel-Soll der Zelle, sonst die bisherigen. Nicht übernommen werden
  Kurse, Bänder, Teamteaching, nicht aktive Lehrkräfte (Zelle bleibt mit Stunden, Lehrkraft offen) und Zellen mit mehreren Quell-Lehraufträgen.
  „Aus dem 1. Halbjahr“ (nur bei Stichtag im 2. Halbjahr): Lehraufträge, die am letzten Tag des 1. Halbjahrs galten und am Stichtag nicht
  mehr, gleiche Klasse. „Aus dem Vorjahr“: Lehraufträge am letzten Tag des Vorjahrs, Klassen über `class_map`.
- **`class_map`:** `promote()` speichert alle Quellen je neuer Klasse; „Lehrkraft folgt der Klasse“ nutzt nur 1:1-Paare (zusammengelegte
  Klassen wie 10a + 10b → EF folgen nicht). Für Übergänge ohne `class_map` (vor SP3-LA) rekonstruiert die Übernahme die Zuordnung **zur
  Laufzeit** über `promotedName()` (nur eindeutige Namen) statt per Daten-Migration – die Migration fügt nur die Spalte hinzu. Ohne
  Zuordnung kein Vorschlag (kein „nur nach Fach“, R13).
- Keine Personendaten in `class_map` (nur Gruppen-ids); Löschklasse der Tabelle unverändert.

**Umgesetzt (SP3-01, 2026-10-27, Migration 0111)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Bestand 1.0** bekommen nur **begonnene** Schuljahre mit Stunden: das laufende `gueltig` ab Schuljahresbeginn, abgelaufene `archiviert` bis
  Schuljahresende. Künftige Schuljahre bekommen keine (unbefristete Stunden reichen zwar hinein, dort wird aber neu geplant – der erste Entwurf
  ist 1.0). `plan_version_id` tragen nur die Stunden, die am Migrationstag gelten. Dieselbe Regel läuft zur Laufzeit als `ensureBaseVersions()`
  (neue Installationen, deren Migration auf einer leeren Datenbank lief, Demo-Seed, Versionsliste, Entwurf anlegen, Nachtjob); idempotent über
  den Teilindex „höchstens ein Bestand je Schuljahr“. Test `planversionen.migration.test` (Stunden Zeile für Zeile und Regelplan unverändert).
- **Nummern:** ein Entwurf trägt die Nummer, die er beim Veröffentlichen bekäme; eindeutig ist sie nur unter `gueltig`/`archiviert` (Teilindex),
  Varianten teilen die Nummer ihres Entwurfs. „Neue Planung“ = höchste nicht verworfene Hauptnummer + 1 (`x.0`), „Folgeversion“ = Hauptnummer
  der gültigen Version, höchste Unternummer + 1 – nur, wenn es eine gültige Version gibt. Die endgültige Nummer prüft SP3-04 beim Veröffentlichen.
- **Stichtag** („gültig ab“, vorgemerkt) wie bei der Solver-Übernahme: Schultag, nach heute, im Schuljahr. Vorschlag: Beginn des 2. Halbjahrs,
  wenn er noch kommt, sonst der nächste Schultag.
- **Aus dem gültigen Plan (`live_copy`):** alle Stunden, die ab dem Stichtag im Schuljahr gelten – auch solche, die erst später beginnen; Beginn =
  später von Stundenbeginn und Stichtag, Ende unverändert. `origin_lesson_id` = Live-Stunde, `parent_version_id` = gültige Version. Die
  Kopplungs-id bleibt (der Diff vergleicht „Kopplung gleich“; neue ids vergibt erst das Veröffentlichen). `assignment_id` bleibt leer, bis die
  Setzhilfe im Entwurf setzt (SP3-02). Der gültige Plan wird **nicht** angefasst – anders als „Periode kopieren“.
- **„Periode kopieren“ bleibt** bis SP3-04/SP3-05 auf `/planung/stundenplan` (sonst gäbe es vor dem Veröffentlichen keinen Weg in den gültigen
  Plan); fachlich ersetzt es `live_copy`, die Oberfläche entfällt mit SP3-05 (§7.2).
- **Leer (`empty`):** optional mit den fixierten Stunden des gültigen Plans ab dem Stichtag (mit Herkunft).
- **Aus Vorversion (`previous_version`):** nur archivierte oder verworfene Versionen **desselben** Schuljahrs (gültige → „aus dem gültigen
  Plan“, offene Entwürfe → „Variante“, Vorjahr hochgestuft → SP3-07). Verworfen: deren Entwurfsstunden ohne die, die vor dem Stichtag enden;
  archiviert: der gültige Plan an ihrem ersten Tag, ab dem Stichtag, ein Ende nur, wenn es danach liegt.
- **Variante:** von offenen Entwürfen (`entwurf`, `pruefung`, `freigegeben`); neue Version im Status `entwurf` mit gleicher Nummer, gleichem
  Stichtag und denselben Stunden (neue ids, gleiche Herkunft), Name „<Name> – Variante“.
- **Verwerfen:** nur offene Entwürfe; ergänzt um `discarded_by/discarded_at`. Die Stunden bleiben (für „aus Vorversion“) und gehen mit der
  Version (Löschklasse LK-SJ-1J ab Schuljahr). Gültige und archivierte Versionen lassen sich nicht verwerfen.
- **Nachtjob** `solver-aufraeumen`: leert `undo` veröffentlichter Versionen ab ihrem Stichtag, verwirft offene Entwürfe abgelaufener
  Schuljahre und zieht „Bestand 1.0“ nach. Die gültige Version eines abgelaufenen Schuljahrs bleibt `gueltig` (Archivieren: SP3-07 – **umgesetzt**, von Hand
  auf der Versionsliste, siehe „Umgesetzt (SP3-07)“).
- **Versionsliste** `/planung/versionen` (Reiter „Versionen“, nur `stundenplan.manage`; `substitute` sieht erst mit SP3-04 „ab wann welche
  Version gilt“): Schuljahr wählbar, Karte je Version mit Nummer, Name, Status, Stichtag, Quelle, Zahlen (Wochenstunden, Lerngruppen,
  Lehrkräfte, Räume, ohne Lehrkraft – veröffentlichte Versionen am Stichtag heute bzw. ihrem letzten Tag, Entwürfe alle Stunden), „Variante
  anlegen“ und „Verwerfen“ (mit Rückfrage); offene und gültige Versionen oben, verworfene unten. Audit `stundenplan.plan.create/variant/discard`
  mit Nummer und Zahlen, ohne Personen.
- **Planquelle** (`plan-quelle.ts`): `PlanSource`, `lessonTable()` (einziger Zugang für die Wahl gültig/Entwurf), `sourceWhere()`,
  `planLessons()` (gemeinsame Zeilenform), `lessonFields()`. Die Spalten beider Tabellen kommen aus `lessonColumns()` in `schema.ts`. Die Lader
  von Setzhilfe, Diagnose, Verteilung und Solver-Eingabe stellt SP3-02 um; bis dahin lesen alle Leser unverändert den gültigen Plan.
- **Datenschutz:** Löschklassen im Manifest (Versionen LK-SJ-1J ab Schuljahr, Entwurfsstunden folgen der Version), DATENSCHUTZ §3.4. Die Auskunft
  sucht eine Lehrkraft nicht in Entwurfsstunden (`EXPORT_SKIP_REFS`, Entwurf ohne Außenwirkung wie Solver-Vorschläge); Planende erscheinen bei
  Versionen nur als Handelnde. Kontolöschung leert die Lehrkraft der Entwurfsstunden (Fremdschlüssel). Querschnittstest (b) „kein fremder
  Leser“ in `planversionen.test.ts`.

**Umgesetzt (SP3-02, 2026-10-27, ohne Migration)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Planquelle in der ganzen Planung:** Lader `gridLessons`, `planLessonsOn`, `distribution(…, { source })`, `diagnoseYear(…, { source })`,
  `groupPlanFindings`, `solverInputFromDb(…, { source })`, `lessonsOfGroup`, `couplingParts`, `findCollisions` und die Schreiber
  `createLesson`/`updateLesson`/`deleteLesson`/`saveCoupling`/`deleteCoupling`, `placeAssignment`, `moveLesson` (Verschieben/Tauschen),
  `setFixed` nehmen eine `PlanSource` (Vorgabe: gültiger Plan, alle bisherigen Aufrufe unverändert). Gemeinsame Spalten über `lessonCols()`,
  Bedingungen `versionWhere`/`activeOnWhere`/`overlapWhere`/`idWhere`, Anlegen über `insertLessonRows()`. Die Prüflogik (`placementCell`,
  `diagnose()`, Solver, Vorprüfung) ist unverändert; `solver.benchmark.test` liefert dieselbe Lösung.
- **Schreiben nur im Status `entwurf`** (`requireWritable`): Entwürfe in `pruefung`/`freigegeben` sind wählbar, aber nur lesbar – ob eine
  Änderung dort den Status zurücksetzt, entscheidet SP3-03. Verworfene und veröffentlichte Versionen lehnen jede Änderung ab.
- **Im Entwurf ändert sich „in place“:** keine Vertretungen, Zusammenlegungen, Historie und kein Gong; Kollisionen zählen nur innerhalb der
  Version. Audit mit eigenen Aktionen `stundenplan.draft.lesson.*`/`stundenplan.draft.coupling.*` (Version-id, keine Personen).
- **Setzhilfe im Entwurf:** Planungsstand = Stichtag des Entwurfs (neue Stunden gelten ab dann bis Schuljahres- bzw. Lehrauftragsende), offene
  Stunden zählen gegen den Entwurf, gesetzte Stunden tragen ihren Lehrauftrag (`assignment_id`), ohne Herkunft (sie sind neu).
- **Quellen-Wähler „Plan“** (`quelle.ts`, URL `?quelle=<Version>`): „Gültiger Plan“ und die offenen Entwürfe des Planungsjahrs (neueste zuerst,
  `pruefung`/`freigegeben` mit Status); Unbekanntes fällt still auf den gültigen Plan zurück. In der Stundenplan-Pflege (Hinweisband mit Link
  „Änderungen zum gültigen Plan“; „Neue Periode“ und die Stand-Links nur im gültigen Plan), in Unterrichtsverteilung und Diagnose (Vorgabe-Stichtag
  = Stichtag des Entwurfs; „Aus Stundenplan übernehmen“ nur im gültigen Plan) und unter „Automatisch planen“ („Planen im“). Die Versionskarte
  verlinkt „Im Entwurf arbeiten“ und „Änderungen zum gültigen Plan“. Seiten reichen nur den URL-Wert weiter (Querschnittstest).
- **Solver-Lauf im Entwurf:** `params.versionId`, Planungsstand = Stichtag des Entwurfs (ein früherer wird abgelehnt), behaltene Stunden sind
  Entwurfsstunden (`stored.versionId`); Vorschau und Diagnose des Laufs lesen sie aus dem Entwurf. Ist der Entwurf beim Rechnen nicht mehr offen,
  scheitert der Lauf mit Hinweis. Ein Entwurfs-Lauf geht nie direkt in den gültigen Plan.
- **Übernahme in den Entwurf (F-10-1)** `applyRunToDraft()`: Ziel ist ein offener Entwurf oder ein neuer (Kopie des gültigen Plans ab Stichtag,
  Quelle `solver_run`, `source_run_id`, Name „Aus Solver-Lauf …“). Ersetzt werden im Planungszeitraum des Laufs die Entwurfsstunden, die nicht
  fixiert sind, die der Lauf nicht behalten hat (gleicher Entwurf: die Stunde, sonst über die Herkunft) und die einem Lehrauftrag entsprechen –
  Stunden ohne Lehrauftrag bleiben wie im gültigen Plan; Stunden über den Zeitraum hinaus werden gekürzt. Neue Stunden gelten ab dem Stichtag bis
  Lehrauftrags- bzw. Zeitraumende, tragen Lauf, Lehrauftrag und – wo möglich – die Herkunft der ersetzten Stunde (gleicher Slot → gleiche Lehrkraft
  → gleiches Fach, `carryOrigins`), damit das Veröffentlichen „geändert“ statt „entfallen + neu“ erkennt. Prüfungen wie bei der Übernahme (fertig,
  alles gesetzt, Lehraufträge, Planungszeitraum). Keine Rücknahme-Daten – der Entwurf wirkt nicht; den alten Stand sichert vorher eine Variante.
  Der Lauf bleibt „fertig“ (in weitere Entwürfe übernehmbar), Protokoll-Eintrag und Audit `stundenplan.solver.apply_draft`; `source_run_id` der
  Version = zuletzt übernommener Lauf.
- **Übergangsregel bis SP3-04:** Die direkte Übernahme in den gültigen Plan (`applyRun`) mit Rücknahme (`undoApply`, SP-09/SP-13) bleibt, bis
  „Veröffentlichen“ sie ersetzt – sonst gäbe es auf `main` keinen Weg vom Solver in den gültigen Plan (wie „Periode kopieren“ nach SP3-01). Auf
  der Lauf-Seite nachrangig und eingeklappt („Übergang bis zum Veröffentlichen: direkt in den gültigen Plan“), nur für Läufe gegen den gültigen
  Plan. SP3-04 entfernt den Weg, übernimmt den Code in `publishVersion`/`undoPublish` (Konfliktzählung) und stellt die E2E-Specs um; die
  Rücknahme schon übernommener Läufe bleibt bis zu ihrem Stichtag. Bis dahin prüfen `solver-uebernahme`, `zx-gate-sp`, `zx-gate-sp2` und
  `stundenplan.spec` den Übergangsweg (aufgeklappt, Helfer `openDirectApply`). **Erledigt mit SP3-04** (siehe dort).
- **Diff-Engine** `planDiff()` (rein, `plan-diff.ts`): vergleicht zwei Wochenpläne an ihrem Stichtag. Paare über die Herkunft (Entwurfsstunde →
  Stunde des gültigen Plans, zwei Entwurfsstunden derselben Herkunft), bei mehreren Kandidaten mit gleichem Inhalt zuerst, sonst über gleichen
  Inhalt. „Unverändert“ = Gruppe, Fach, Lehrkraft, Raum, Tag, Stunde, Woche und Kopplungspartner gleich (die Kopplungs-id zählt nicht), sonst
  „geändert“ mit den Feldern; der Rest ist „entfällt“/„neu“ – kein Raten über ähnliche Stunden. Gültigkeiten zählen nicht (Zeitbezug und Übertrag
  ergänzt SP3-04). Gruppiert je Lehrkraft (alte und neue Lehrkraft sehen die Änderung) und je Klasse/Kurs. Seite
  `/planung/versionen/aenderungen?version=…[&mit=…]`: gegen den gültigen Plan am Stichtag der Version oder gegen eine andere, nicht verworfene
  Version desselben Schuljahrs.
- **Variantenvergleich** (Quelle „Version“ in `solververgleich.ts`, Seite `/planung/solver/vergleich?versionen=a,b[,c]`, Link „Varianten
  vergleichen“ ab zwei offenen Entwürfen): Wochenstunden (nur Information), ohne Lehrkraft, Diagnose-Fehler/-Warnungen, Hohlstunden
  Lehrkräfte/Klassen (gesamt, höchstens), Diagnose Hohlstunden/Fach mehrfach/Räume – Bestwert und Unterschied zur ersten Version. Erfüllte Wünsche
  und Raumauslastung kommen mit dem Fahrplan (SP3-06, Schritt 7).
- **Datenschutz:** keine neue Tabelle, keine Migration; Auskunft und Löschklassen unverändert. Der Querschnittstest „kein fremder Leser“ prüft
  zusätzlich, dass nur Planungs-Dateien die Planquelle benutzen (Vertretung, Wochenplan, Heute, Anzeige, Freigabe, Gong, Exporte, Periode nicht).

**Umgesetzt (SP3-03, 2026-10-27, Migration 0112)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Bearbeiten nur im Entwurf** (offene Frage aus SP3-02): in `pruefung`/`freigegeben` ist ein Entwurf nur lesbar; eine Änderung setzt den Status
  **nicht** still zurück (`requireWritable` lehnt ab mit dem Hinweis, erst „Zurück an die Planung“ zu wählen). „Zurück an die Planung“ setzt `entwurf`,
  die Freigabe (`approved_by/at`) verfällt bei **jeder** Rückkehr; Kommentare bleiben, `submitted_by/at` bleibt als „zuletzt zur Prüfung gegeben“.
  Variante und Verwerfen gehen weiter aus allen offenen Status (die Variante ist ein neuer Entwurf).
- **Wer darf was:** „Zur Prüfung geben“ nur `manage` und nur mit mindestens einer Stunde; „Freigeben“ nur `review` aus `pruefung`; „Zurück an die
  Planung“ aus `pruefung` (Prüfung gibt zurück, Planung holt zurück) und aus `freigegeben` („Freigabe zurücknehmen“) – beide Rechte, optional mit
  Begründung (wird Kommentar an die ganze Version). Statuswechsel mit Vorbedingung im UPDATE (gleichzeitige Klicks: einer gewinnt). Ohne
  Vier-Augen-Zwang (F-10-3): wer beide Rechte hat, gibt selbst frei; „selbst“ = Freigebende:r hat eingereicht **oder** angelegt – Audit
  `stundenplan.plan.approve` mit `self` und Zahl offener Kommentare, Karte/Prüfseite „selbst freigegeben“. Offene Kommentare blockieren die Freigabe
  nicht (Hinweis). Audit `stundenplan.plan.submit/approve/return/preview/comment/comment_resolve/comment_reopen/preview_comment`, ohne Personen.
- **Sicht der Prüfung:** Versionsliste (Reiter „Versionen“), Prüfseite `/planung/versionen/pruefung?version=…` und „Änderungen“ nur für Versionen ab
  `pruefung` (auch `gueltig`/`archiviert`), sonst 404; ohne Anlegen/Variante/Verwerfen und ohne „Im Entwurf arbeiten“. Übersicht `/planung`: Kachel
  „Planentwürfe zur Prüfung“. Eine Benachrichtigung der Schulleitung beim Einreichen gibt es nicht (Kachel und Liste reichen).
- **Kommentare** (`timetable_plan_comments`): Bezug in eigenen Spalten statt `target jsonb` (`target_kind` `version`/`teacher`/`group`/`slot`,
  `teacher_id`, `group_id`, `weekday`, `period_nr`) – Kontolöschung und gelöschte Gruppen leeren ihn per Fremdschlüssel. Lehrkraft/Gruppe müssen im
  Entwurf vorkommen; eine Stunde = Wochentag + Stunde, optional mit Klasse/Kurs. Schreiben: Planung in offenen Entwürfen, Prüfung in
  `pruefung`/`freigegeben`; erledigen/wieder öffnen nur `manage`. Kein Bearbeiten/Löschen einzelner Kommentare (sie gehen mit der Version).
  Offene zuerst, je älteste zuerst; die Versionskarte zählt offene.
- **Lehrkräfte-Vorschau „Mein Plan ab …“** (F-10-4): Schalter je Version (Vorgabe aus) auf der Prüfseite, schaltbar in allen offenen Status, wirkt
  aber nur in `pruefung`/`freigegeben` (im Entwurf sieht niemand außer der Planung etwas). Seite `/stundenplan/vorschau` (nur Rolle Lehrkraft, sonst
  404; Hinweis mit Link über dem eigenen Stundenplan): Wochenraster nur der Entwurfsstunden mit eigener `teacher_id` (Fach, Klasse/Kurs, Raum,
  A/B-Woche, abweichender Beginn/Ende) – keine anderen Lehrkräfte, keine Herkunft, keine Diagnose, kein Diff. Banner „Entwurf – kann sich noch
  ändern“. Rückmeldung als Kommentar an die Planung (Bezug: ganzer eigener Plan oder eine eigene Stunde; `from_preview`); die Lehrkraft sieht nur
  eigene Kommentare (mit „erledigt“). Mehrere Versionen mit Vorschau: Auswahl nach Stichtag. Ein Gong beim Einschalten kommt nicht (F-10-4 nennt
  nur den Gong beim Veröffentlichen, SP3-04).
- **Recht und 2FA:** `stundenplan.review` im Manifest, Migration 0112 (Grant `g-schulleitung` nur mit fester ID und Slug, idempotent; Demo-Seed
  ebenso), in `PLANNING_PERMISSIONS` (2FA sofort, kein Verwaltungsrecht i. S. S28). Bereich `/planung` und Menüpunkt „Stundenplanung“ auch mit
  `review`.
- **Datenschutz:** Löschklasse „folgt der Version“ (Manifest), DATENSCHUTZ §3.4, SICHERHEIT S86. Auskunft: eigene Kommentare (Verfasserschaft)
  mit Text; `timetable_plan_comments.teacher_id` steht in `EXPORT_SKIP_REFS` (Prüfnotiz zum Entwurf ohne Außenwirkung, wie die Entwurfsstunden).
  Querschnitt (Grep): Kommentare liest nur das Modul (Schema, Manifest, `planpruefung.ts`); die Prüf-Services nutzen nur Planungsseiten, der eigene
  Stundenplan (nur die Liste freigeschalteter Versionen, nur für Lehrkräfte) und die Vorschau-Seite.
- **Nicht in SP3-03:** Veröffentlichen (SP3-04) – eine freigegebene Version bleibt bis dahin freigegeben; Hinweis im Vertretungs-Arbeitsplatz ab
  `freigegeben` (R2) und Quittierungen (SP3-06).

**Umgesetzt (SP3-04, 2026-10-27, Migration 0113)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Regeln rein** in `plan-uebertrag.ts` (`transferPlan`, `transferRefs`, `changeLine`/`changeLists`), Tabellen-Tests auf dem Demo-Plan (R1);
  Lesen/Schreiben, Rücknahme-Daten und Gong in `veroeffentlichen.ts` (`publishVersion`, `undoPublish`, Vorschauen), „Plan am Tag X“ und der
  Hinweis für die Vertretungsplanung in `plan-archiv.ts` (liest nur die Hülle der Versionen).
- **Umfang des Diffs:** alle Stunden des gültigen Plans, die ab dem Stichtag im Schuljahr gelten (auch später beginnende), gegen **alle**
  Entwurfsstunden der Version (nicht nur den Wochenplan am Stichtag). Paare wie `planDiff()` (Herkunft, sonst gleicher Inhalt). **Unverändert**
  heißt: Inhalt, Kopplungspartner **und** Zeitraum ab dem Stichtag gleich (Ende bis höchstens Schuljahresende verglichen – „unbefristet“ =
  „bis Schuljahresende“); nur der Zeitraum anders zählt als „geändert“ (die Vorschau nennt die Zahl).
- **Kopplung als Einheit:** ändert sich ein Teil einer Kopplung (oder kommt einer dazu bzw. fällt weg), bekommen **alle** Teile neue Zeilen mit
  einer neuen gemeinsamen Kopplungs-id – sonst teilten sich beendete und neue Zeilen dieselbe id. Vertretungen ziehen je Teil auf die Nachfolgerin.
- **Neue Zeilen:** gelten ab Stichtag (bzw. späterem Beginn im Entwurf) bis Entwurfsende, **höchstens Schuljahresende**; tragen
  `plan_version_id` = Version und den Solver-Lauf aus dem Entwurf. Unveränderte Zeilen behalten ihre Herkunft und ihr Ende. Geänderte und
  entfallende enden am Vortag; begannen sie erst ab dem Stichtag, werden sie gelöscht (vollständig in `undo`).
- **Übertrag ab dem Stichtag** (Vertretungen, Material – auch ohne Abwesenheit –, Klassenbuch): auf die Nachfolgerin, wenn sie **an dem Tag**
  stattfindet (gleicher Wochentag, im Zeitraum, passende A/B-Woche) – eine auf einen anderen Tag verschobene Stunde nimmt nichts mit. Verlegung nur,
  wenn ihre Zielstunde nicht die neue Stunde selbst ist; Zusammenlegung nur, wenn abgebende und aufnehmende Stunde an dem Tag in derselben Stunde
  liegen. Was nicht umziehen kann: Vertretungen und Material gesichert und gelöscht (Historie `plan_publish`), Klassenbuch-Einträge bleiben ohne
  Stundenbezug – alles in der Vorschau gezählt. Einträge **vor** dem Stichtag bleiben an der alten Zeile (sie endet, wird nicht gelöscht).
- **Prüfungen:** Status `freigegeben`; Stichtag Schultag nach heute im Schuljahr, **frühestens am vorgemerkten Stichtag** des Entwurfs und **nach
  dem Beginn der gültigen Version** (je Tag genau eine Version; die Vorgängerin behält mindestens einen Tag). „Diagnose ohne Fehler bzw. quittierte
  Warnungen“ prüft erst der Fahrplan (SP3-06, Schritt 7). Unter einer Sperre je Schuljahr (`pg_advisory_xact_lock`) und mit Statusbedingung im
  UPDATE – gleichzeitige Klicks: einer gewinnt.
- **Versionen:** Version → `gueltig` (`valid_from` = Stichtag, `published_by/at`); Vorgängerin → `archiviert` mit `valid_until` = Vortag (der
  Teilindex „eine gültige je Schuljahr“ bleibt; „gültig“ heißt „zuletzt veröffentlicht“, welche Version an einem Tag gilt, sagt der Zeitraum).
  **Varianten derselben Nummer werden verworfen** (Vorgabe statt „bleiben stehen“, §2.5: veröffentlichbar ist genau eine, ihre Nummer ist danach
  vergeben); andere offene Entwürfe bleiben (Hinweis in der Vorschau: sie beziehen sich noch auf den bisherigen Plan). Ist die Nummer schon
  vergeben, gibt es die nächste freie (Folgeversion: nächste Unternummer, sonst nächste Hauptnummer).
- **Rücknahme** (`undoPublish`, nur die gültige Version, bis zum Vortag des Stichtags): gelöschte Stunden zurück (alte id), beendete wieder
  verlängert (nur, wenn sie noch am Vortag enden), Vertretungen/Material/Klassenbuch an neuen Stunden zurück an die bisherige Stunde (wenn sie an
  dem Tag stattfindet), neue Stunden entfernt (auch von Hand veränderte; danach von Hand angelegte bleiben – gezählt), gesicherte Vertretungen und
  Material wieder angelegt (wenn ihre Stunde an dem Tag gilt), Klassenbuch-Bezüge zurück; Version wieder `freigegeben` (vorgemerkter Stichtag,
  Nummer zurück), Vorgängerin wieder `gueltig`, verworfene Varianten wieder offen. Konfliktzählung wie beim Solver (veränderte, fremde, nicht
  wiederherstellbare Stunden, verlorene Vertretungen/Material/Bezüge, Raumbuchungen/Klausuren). Der Nachtjob leert `undo` ab dem Stichtag.
- **Änderungsliste (F-10-4):** sichtbare Änderungen (ohne „nur Zeitraum“/„nur Kopplungs-id“) je Lehrkraft (alte und neue) und je Klasse/Kurs als
  Zeilen („Mo 3. Std Mathematik (7b): Raum 106 → 105“, Lehrkräfte als Kürzel). Gong `stundenplan:plan:<Version>` an **Lehrkräfte sofort** (nicht an
  die veröffentlichende Person), an **Schüler:innen und Eltern** (Eltern nach der Einstellung wie bei Vertretungen; ohne Kommentare und Entwürfe)
  zur Vortags-Uhrzeit vor dem Stichtag nach den Sendezeiten „Lernende“ (Ruhezeit beachtet; nach der Uhrzeit sofort) über den Minutentakt
  `vertretung-gong` – genau einmal, danach wird die Liste (`notify`) geleert. Geänderte Sendezeiten planen offene Listen neu. Die Rücknahme ersetzt
  den Gong bei allen, die ihn bekommen haben („… zurückgenommen“); eine noch nicht versandte Liste entfällt. **Migration 0113:** `notify jsonb`,
  `notify_at`, `notified_at` an `timetable_plan_versions` (Löschklasse der Version).
- **Übergangsweg entfernt (F-10-1):** die direkte Übernahme eines Laufs in den gültigen Plan (`applyRun`/`applyPreview`, Formular „Vorschlag
  übernehmen“) ist weg; ein Lauf geht in einen Entwurf und von dort über Prüfung/Freigabe und „Veröffentlichen ab …“. Die Rücknahme schon
  übernommener Läufe (`undoApply`) bleibt bis zu ihrem Stichtag; die alte Übernahme liegt nur noch als Testhilfe in `solverlauf.testing.ts` (für die
  Tests dieser Rücknahme). E2E `solver-uebernahme`, `zx-gate-sp`, `zx-gate-sp2`, `stundenplan.spec` gehen über den Versionsweg (Helfer `publishRun`,
  `approveVersion`, `undoAndDiscardVersion`).
- **Oberfläche:** Seite `/planung/versionen/veroeffentlichen?version=…` (nur `manage`): Stichtag wählen, Vorschau mit Zahlen (unverändert/geändert/
  neu/entfallen, Vertretungen/Material/Klassenbuch, Räume, Vorgängerin, Varianten, Empfänger der Änderungsliste), „Ab … veröffentlichen“; für die
  gültige Version die Rücknahme mit Konfliktliste. Versionskarte und Prüfseite: „Veröffentlichen …“ (freigegeben), „Veröffentlichung ansehen /
  zurücknehmen“ (gültig); Versionsliste mit **Zeitstrahl** der veröffentlichten Versionen. Vertretungs-Arbeitsplatz: Hinweis je freigegebener
  Version mit Stichtag in der Zukunft (R2). Die Lauf-Seite verweist auf das Veröffentlichen.
- **Plan am Tag X:** Datumswähler „Plan am“ im Stundenplan (Woche des Tages) und im Druck (`?tag=`: Woche bzw. Stand des Regelplans); beide nennen
  die an dem Tag gültige Version (`versionOn`, im Schuljahr des Tages; wechselt sie in der Woche, beide). Der Plan selbst kommt wie bisher aus
  `timetable_lessons` am Tag (seine eigene Historie) – auch für vergangene Tage.
- **Datenschutz:** Kontolöschung ersetzt Lehrkraft-Kennungen und -Kürzel in `undo` und `notify` (`scrubPlanVersions`, Muster DS-21); das
  Zurücknehmen behandelt den Platzhalter wie eine gelöschte Lehrkraft. Audit `stundenplan.plan.publish`/`unpublish` nur mit Zahlen.
- **„Periode kopieren“ bleibt** bis SP3-05 (Halbjahres-Vorlage). **Erledigt mit SP3-05** (siehe dort).

**Umgesetzt (SP3-05, 2026-10-28, Migration 0114)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Regeln rein** in `sofortkorrektur.ts` (`planUnit`, Tabellen-Tests), Lesen/Schreiben, Übertrag, Entwürfe nachziehen, Protokoll und Gong in `applyLiveUnits`;
  die Pflege (`manage.ts`: Stunde anlegen/ändern/löschen, Kopplung speichern/löschen) und die Setzhilfe (`setzhilfe.ts`: Setzen, Verschieben, Tauschen) rufen
  sie im gültigen Plan auf, im Entwurf bleibt alles wie in SP3-02.
- **Einheit** ist die Einzelstunde bzw. die ganze Kopplung (wie beim Veröffentlichen); beim Tauschen beide Einheiten in **einer** Aktion (ein Protokoll-Bündel, ein Gong); läuft eine der beiden, werden beide ab dem Stichtag geteilt (sonst lägen bis dahin zwei Stunden im Slot).
- **Vergangenheitsbezug:** keiner, wenn die Stunde erst nach heute beginnt oder heute in der Pflege **neu angelegt** wurde (Protokoll „neu“ von heute) und noch keine
  Klassenbuch-Einträge, Vertretungen oder Materialien bis heute hat (Tippfehler gleich nach dem Anlegen) – dann in place (ändern bzw. ganz löschen). Eingespielte
  oder veröffentlichte Stunden zählen immer als laufend. Eine **neue** Stunde gilt wie eingegeben (sie zerreißt nichts) und steht als „neu“ im Protokoll.
- **Laufende Stunde:** Inhalt (Gruppe, Fach, Lehrkraft, Raum, Tag, Stunde, Woche) oder Teile geändert → **Split** ab dem Stichtag: alle Teile enden am Vortag, alle
  Teile nachher gelten ab dem Stichtag (Kopplung mit neuer gemeinsamer Kopplungs-id, ein einzelner verbleibender Teil ohne Kopplung), Fixierung und Solver-Herkunft
  bleiben, `plan_version_id` = gültige Version. Nur das **Ende** verschoben → in place (frühestens bis heute); der **Beginn** einer laufenden Stunde lässt sich nicht
  ändern. **Löschen** → endet am Vortag; ein Teil einer laufenden Kopplung beendet die Kopplung, die übrigen gelten ab dem Stichtag neu gekoppelt.
- **Stichtag:** der nächste Schultag nach heute (Schulkalender); ein späterer Beginn im Formular verschiebt ihn. Endet die Stunde vor dem Stichtag, wird die Änderung
  abgelehnt. Kollisionen zählen ab dem Stichtag (nicht gegen Stunden, die vorher enden).
- **Übertrag** wie beim Veröffentlichen (`transferRefs`): Vertretungen, Material und Klassenbuch-Einträge **ab dem Stichtag** ziehen auf die Nachfolgerin, wenn sie an dem
  Tag stattfindet; sonst werden Vertretungen und Material gelöscht (Vertretungen mit Eintrag `delete` im Verlauf) und Klassenbuch-Einträge verlieren den Stundenbezug –
  eine Sofort-Korrektur hat **keine Rücknahme** (dafür gibt es die Folgeversion). Einträge davor bleiben an der alten Stunde. In place gilt dasselbe ab heute.
- **Protokoll** `timetable_plan_changes`: je Stunde eine Zeile (`split`, `inplace`, `delete`, `create`), Aktion = `batch_id`, Version = gültige Version des Schuljahrs am
  Stichtag, Vorher/Nachher mit Kennungen, `valid_from` = Stichtag, Begründung optional (≤ 120 Zeichen, Hinweis „keine Personen, keine Gesundheitsangaben“). Audit
  `stundenplan.plan.correction` mit Zahlen (ohne Personen, Begründung nur als „vorhanden“).
- **Gong** (F-10-2): sichtbare Änderungen (wie die Änderungsliste beim Veröffentlichen, ohne „nur Kopplungs-id“) an die Lehrkräfte vorher und nachher **sofort**
  (nicht an die handelnde Person), an Schüler:innen und Eltern der Gruppen zur **Vortags-Uhrzeit** vor dem Stichtag (Sendezeiten „Lernende“, danach sofort) über den
  Minutentakt `vertretung-gong` – genau einmal je Aktion (Zeilen unter der Zeilensperre beansprucht). Bündel `stundenplan:korrektur:<Aktion>`; die Begründung steht nie
  im Gong. Geänderte Sendezeiten planen offene Listen neu.
- **Hinweis „besser als Folgeversion“** ab **10** geänderten Stunden – in der Aktion **oder** seit die gültige Version gilt (Protokoll-Zeilen der Version) – auf der
  Pflege-Seite mit Link auf die Vorlage. Die Pflege nennt im gültigen Plan immer den Stichtag; das Formular einer laufenden Stunde zeigt ihn mit dem Feld „Begründung“.
  Nach dem Speichern zeigt die Seite den Plan ab dem Stichtag (`stand=`) mit dem Ergebnis der Aktion (`korrektur=`).
- **R3 (Vorgabe):** offene Entwürfe (Entwurf, in Prüfung, freigegeben) ziehen jede Sofort-Korrektur nach, damit der Diff nicht abreißt und das Veröffentlichen die
  Korrektur nicht zurückdreht: beginnt der Entwurf am Stichtag der Korrektur oder später, zeigt die Herkunft auf die Nachfolgerin; war die Entwurfsstunde wie die alte
  Stunde, übernimmt sie auch den neuen Inhalt (nicht bei einer Kollision im Entwurf), eine entfallene Stunde entfällt auch im Entwurf, eine neue kommt dazu (Beginn
  frühestens am Stichtag des Entwurfs). Was der Entwurf schon anders plant, bleibt – „Änderungen“ zeigt es als „geändert“ und nennt die Zahl der Sofort-Korrekturen seit
  Anlage des Entwurfs. Weil nur Gleiches nachgezogen wird, wächst der Unterschied zum gültigen Plan nie; eine Freigabe bleibt deshalb bestehen. Ein Entwurf, der vor dem
  Stichtag der Korrektur beginnt (nur bei einem späteren Beginn im Formular möglich), behält die bisherige Stunde.
- **Vorlagen** (`laufzeit.ts`, Versionsliste „Vorlagen“): **„Änderung im laufenden Plan“** = Folgeversion (`x.(y+1)`, F-10-3: auch sie braucht die Freigabe) aus dem
  gültigen Plan ab dem nächsten Schultag; **„Neues Halbjahr“** = neue Planung (`(x+1).0`) ab `term2_starts_on` (bzw. dem ersten Schultag ab dann), nur solange er
  bevorsteht und es einen gültigen Plan gibt. Beide sind `live_copy`; Lehraufträge (SP2-09), Setzhilfe, Diagnose und der Solver-Lauf („Lehraufträge am …“) rechnen im
  Entwurf an seinem Stichtag. Nach dem Anlegen nennt die Seite die nächsten Schritte (Unterrichtsverteilung, im Entwurf arbeiten, automatisch planen, Änderungen).
- **„Periode kopieren“ entfernt** (`periode.ts`, Formular, Action, Audit `stundenplan.period.copy` nur noch in alten Protokollen): der Halbjahreswechsel läuft über die
  Vorlage; das Veröffentlichen teilt nur geänderte Stunden. Die Pflege behält den Planungsstand `stand=` für Stunden, die später beginnen.
- **Datenschutz:** Löschklasse LK-SJ-1J ab Anlage (Manifest), DATENSCHUTZ §3.4; Kontolöschung ersetzt Lehrkraft-Kennungen in Vorher/Nachher (`scrubPlanChanges`,
  DS-21-Muster), „geändert von“ leert der Fremdschlüssel. Nur die Planung sieht das Protokoll.

**Umgesetzt (SP3-07, 2026-10-28, ohne Migration)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Vorlage „Neues Schuljahr“** (`neues-schuljahr.ts`, Versionsliste „Vorlagen“; für den Fahrplan exportiert: `newYearTemplate()` mit Schritten/Angebot/Vorschau
  und `createNewYearDraft()`): Schritte **Schuljahr angelegt → Schuljahreswechsel Vorjahr → dieses Jahr → Versetzung → Entwurf**, je mit Stand und Sprungziel
  (Verwaltung → Schuljahreswechsel, Versionsliste). Vorgabe (SP3-07): Die Versetzung gilt als erledigt, wenn der Schuljahreswechsel sie durchgeführt hat; ohne
  Schuljahreswechsel reichen von Hand angelegte Klassen im neuen Jahr (Zuordnung dann über die Namensregel). Angeboten, solange im Schuljahr kein Plan gilt;
  Nummer `x.0`, Stichtag = erster Schultag nach heute im Schuljahr, Name „Schuljahr 2027/28“.
- **Hochstufen** (rein `promoteLessons`): Plan am **letzten Schultag des Vorjahrs** (`timetable_lessons` an dem Tag), nur ungekoppelte Stunden von Klassen des
  Vorjahrs mit eindeutiger Nachfolgeklasse – dieselbe Zuordnung wie die Matrix (`classMapFor`: `class_map` nur 1:1, sonst `promotedName()`). Vorgabe (SP3-07):
  **gekoppelte Stunden kommen nicht mit** (Bänder, auch reine Klassen-Kopplungen wie Religion/Ethik – sie werden neu geplant), ebenso Kurse/AGs und Klassen ohne
  eindeutige Nachfolgerin (Abschlussjahrgang, 10a + 10b → EF). Tag, Stunde, Woche, Fach, Raum und Fixierung bleiben; die Lehrkraft folgt der Klasse, wenn sie
  noch aktiv ist (sonst offen). Die Stunden gelten ab dem Stichtag unbefristet, **ohne** `origin_lesson_id` (der gültige Plan des neuen Jahres ist ein anderer)
  und ohne Lehrauftrag. Quelle `previous_version`, `parent_version_id` = die Version des Vorjahrs, die am letzten Schultag galt (Karte: „Plan des Schuljahrs
  2026/27 hochgestuft (Version 1.0)“). Alternativ **leer** (`empty`). Die Karte zeigt vorher die Zahlen (übernommen, je Grund ausgelassen, ohne Lehrkraft).
- **Lehraufträge des Vorjahrs als Vorschlag:** nicht im Entwurf (unversioniert, F-10-5), sondern über SP3-LA „Aus dem Vorjahr übernehmen“ – die Karte nennt die Zahl
  möglicher Vorschläge, nach dem Anlegen verlinkt sie die Matrix mit `vorschlag=vorjahr` und dem Entwurf als Quelle.
- **Planungsjahr:** ~~bekannte Grenze (SP3-08)~~ – seit **SP3-09a** gibt es die Jahreswahl (unten); die Grenze gilt nur noch für die Teile von SP3-09b.
- **Veröffentlichen** wie jede Version (SP3-04): unbefristete Stunden des Vorjahrs, die ins neue Schuljahr reichen, enden am Vortag des Stichtags („entfällt“).
- **Schuljahr archivieren** (`schuljahresabschluss.ts`, nur `manage`, erst **nach** dem Schuljahresende): die gültige Version wird `archiviert` (gültig bis höchstens
  Schuljahresende, `undo` geleert), offene Entwürfe werden verworfen (wie der Nachtjob); unter der Sperre des Veröffentlichens. „Archiviert“ ist kein eigenes Feld,
  sondern abgeleitet (vorbei, keine gültige, keine offene, mindestens eine archivierte Version). Der Plan (`timetable_lessons`) bleibt unverändert lesbar
  (Versionsliste, Zeitstrahl, „Plan am Tag X“, Druck). Audit `stundenplan.plan.archive_year` (Schuljahr, Nummer, Zahl verworfener Entwürfe).
- **Kurzstatistik** je Schuljahr (Versionsliste, Abschnitt „Schuljahresabschluss“, `manage` **und** `review`): Stunden laut Plan an Schultagen (je Lerngruppe),
  Entfall/Vertretung mit Anteil, davon nur Betreuung, Zusammenlegung, Verlegung, Raumänderung, je Grund-Kategorie und je Monat – vom Schuljahresbeginn **bis heute**
  (abgelaufene Jahre bis zum Ende). **Keine Namen** – weder Lehrkräfte noch Klassen, für alle Rollen gleich; die Statistik je Lehrkraft/Klasse bleibt die
  Vertretungsstatistik (`substitute`, verlinkt nur im aktuellen Schuljahr). Wird bei jedem Aufruf gerechnet, nichts gespeichert.
- **Datenschutz:** keine neue Tabelle, keine Migration. Archivieren ändert keine Löschfrist (Versionen LK-SJ-1J ab Schuljahr, Entwurfsstunden folgen der Version);
  die Statistik verschwindet mit den Vertretungen (LK-SJ-1J ab Datum). DATENSCHUTZ §3.4.

**Umgesetzt (SP3-09a, 2026-10-28, ohne Migration)** – Planen im Folgejahr, Teil a (freigegeben von der Projektleitung 2026-10-28). Vorgaben für Detailfragen:
- **Jahreswahl im Kopf des Planungsbereichs** (Layout, für `manage` und `review`): „Du planst das Schuljahr 2027/28 · Folgejahr“ mit Auswahl und „Wechseln“.
  Vorgabe ist das laufende Schuljahr (`planningYear`); jedes angelegte künftige Schuljahr ist wählbar (Rolle „Folgejahr“, orange mit Hinweis „das laufende
  Schuljahr bleibt unverändert“), vergangene Schuljahre sind wählbar, aber **nur lesbar** (`planungsjahr.ts`: `resolvePlanningYear`, `yearRole`).
- **Cookie statt URL-Parameter** (weniger Brüche: die Planungsseiten verlinken sich vielfach ohne Jahr – Reiter, Ansichten, Rücksprünge der Actions):
  Sitzungs-Cookie `schulos-planungsjahr` (Pfad `/planung`, ohne Ablauf – nach dem Schließen des Browsers gilt wieder das laufende Jahr; nicht `httpOnly`, damit
  der Kopf die Wahl nach Seitenwechseln im Browser liest, das Layout rendert bei Navigation nicht neu). Gesetzt nur über die Route
  `/planung/planungsjahr?jahr=<id>&weiter=<pfad>` (angemeldet mit Planungsrecht; nur bekannte Schuljahre; Rücksprung nur unter `/planung`). **Deeplinks:**
  `jahr=<id>` bzw. ein Entwurf in der URL (`quelle=` in Pflege und Unterrichtsverteilung, `version=` im Fahrplan – der Entwurf kennt sein Jahr) stellen das
  Jahr über diese Route um und kehren ohne `jahr` zurück (`planningYearForPage`); die Jahres-Links der Versionsliste und des Korrektur-Protokolls tun das ebenso.
- **Schreiben nur ins Jahr der Seite:** Die Actions bekommen das Planungsjahr ausdrücklich (gebunden: `saveAssignmentAction`, `saveBandAction`,
  `saveMatrixAction`, CSV-Import, `saveObligationAction`, `saveTeacherDayRuleAction`, `addReductionAction`) – nicht aus dem Cookie, damit zwei Tabs mit
  verschiedenen Jahren nichts verwechseln – und prüfen es mit `requireWritableYear` (abgeschlossen → Fehler „… ist abgeschlossen und nur noch lesbar“);
  Aktionen über eine id (Lehrauftrag/Band/Anrechnung löschen, Band-Mitglieder) prüfen das Jahr des Datensatzes (`requireWritableRecordYear`), Entwürfe das
  Jahr ihrer Version (`writableSource`). Rechte unverändert (`stundenplan.manage`). Zusätzlich im Service: ein Lehrauftrag nimmt nur Gruppen seines Schuljahrs
  (oder ohne Schuljahr) und wechselt beim Ändern nie das Schuljahr.
- **Umgestellt auf das gewählte Jahr:** Unterrichtsverteilung (Klassen & Kurse, Lehraufträge, Bänder, Lehrkräfte/Deputate/Anrechnungen/Tagesregeln, Matrix inkl.
  „Aus dem Vorjahr übernehmen“, CSV-Import, Diagnose-Ansicht), Übersicht `/planung` (Jahresplanung bzw. Fahrplan-Status; der Fachbedarf bleibt die Prognose aus
  dem laufenden Jahr), Versionsliste, Korrektur-Protokoll, Fahrplan (Vorgabe-Jahr) und die **Stundenplan-Pflege**: im laufenden Jahr wie bisher (gültiger
  Plan oder Entwurf), in anderen Jahren **nur im Entwurf** (Vorgabe: der neueste offene), Gruppen nur des gewählten Jahrs (`plannableGroups(db, jahr)`), Setzhilfe
  mit den Lehraufträgen und Tagesregeln des Entwurfsjahrs (`yearOfSource`), Gültigkeit neuer Stunden bis zum Ende des Entwurfsjahrs (`defaultValidity`),
  Restdeputate des Jahrs (`loadPickList(…, jahr)`), Plan-Hinweise der Gruppe im Entwurfsjahr. „Aus Stundenplan übernehmen“ nur im laufenden Jahr.
- **Leerzustände:** Folgejahr ohne Klassen (vor der Versetzung) → Hinweis und Matrix-Leerzustand mit Link zum Schuljahreswechsel; Pflege ohne Entwurf im
  Folgejahr → Weg zur Vorlage „Neues Schuljahr“; abgeschlossenes Jahr → nur lesbar (Formulare, Matrix-Editor, Import und Anlegen ausgeblendet, Pflege verweist
  auf die Versionsliste). Seiten, die noch im laufenden Jahr arbeiten, sagen es im Kopf („Diese Seite arbeitet immer im laufenden Schuljahr …“).
- **Audit mit Jahr:** `stundenplan.assignment.create/update/delete/matrix/import/csv_import`, `stundenplan.band.*`, `stundenplan.deputy.obligation/day_rule/
  reduction_add/reduction_delete` tragen `year` (Schuljahres-id).
- **Grenze (SP3-09b, offen):** „Automatisch planen“ (Lauf, Übernahme in den Entwurf, Warmstart), Zeitwünsche und Zeitwunsch-Fenster, Diagnose/Fahrplan-Schritte
  im Folgejahr prüfen (Diagnose-Ansicht folgt der Wahl schon, ungetestet im Folgejahr), Exporte (Verteilung/Deputate/Aufsichten) und das E2E-Gesamtszenario
  „Folgejahr planen“. Weiter im laufenden Jahr (bewusst): Vertretungen, Bereitschaft, Vertretungsstatistik, Aufsichten, Fachbedarf, „Mein Deputat“, Kurswahl-Übernahme.

**Recht `stundenplan.review`** („Planentwurf prüfen und freigeben“, SP3-03): Daten-Migration gibt es der Gruppe `g-schulleitung` (wie
0088 `substitute`); 2FA-Pflicht wie die anderen Planungsrechte (Deputate/Namen im Entwurf). Keine Rollen-Vorgabe.

### 3.2 Vertretung (VT)

**`timetable_substitutions`** (VT-01): `reason substitution_reason` (`lehrkraft_abwesend`, `klassenfahrt`, `exkursion`, `praktikum`,
`pruefung`, `veranstaltung`, `raum_gesperrt`, `organisatorisch`, `sonstiges`; Vorgabe aus dem Abwesenheitsgrund: krank/fortbildung/
dienstlich → `lehrkraft_abwesend`, Gruppengründe 1:1, Raumsperre → `raum_gesperrt`) · `internal_note text` (≤ 300) · `supervision_only
bool default false` (nur bei `substitute`, Frage F-10-9) · `updated_by/updated_at` · `acknowledged_at timestamptz` (von `substitute_id`;
wird beim Wechsel der Vertretungslehrkraft oder der Art geleert). `note` bleibt und heißt in der UI „Hinweis für Schüler:innen“.

**`timetable_substitution_changes`** (VT-01): `id` · `lesson_id` set null · `date` · `substitution_id` set null · `action` (`create`,
`update`, `delete`, `plan_publish`, `plan_undo`) · `before jsonb` · `after jsonb` (Felder der Vertretung mit ids) · `actor_id` set null ·
`created_at`. Löschklasse LK-SJ-1J ab `date`; Kontolöschung ersetzt Lehrkraft-ids in `before/after` (Muster `scrubSolverRuns`, DS-21).
Sichtbar nur für `substitute`; speist den Marker „neu/geändert seit <Zeitpunkt>“ (Vergleich mit dem letzten Gong-Versand bzw. „gestern
18:00“) in Vertretungsplan/Monitor.

**`timetable_absence_materials`** (VT-01): `absence_id` **nullable** (`follows` entfällt → eigene Klasse LK-SJ-1J ab `date`);
Eindeutigkeit `(lesson_id, date, coalesce(absence_id, ''))`; anlegen dürfen die Lehrkraft der Stunde, die Vertretung, `substitute`.
Häkchen „für Schüler:innen“ bleibt.

**`timetable_day_notes`** (VT-01): `id` · `date` · `body text` (≤ 300, Hinweis „keine Personen nennen“) · `audience` (`alle`,
`beschaeftigte`) · `sort_order` · `created_by/at` · `updated_at`. Folgt der Tagesfreigabe (Entwurfstag → nur Planung). LK-SJ-1J ab `date`.

**Umgesetzt mit VT-01 (2026-10-27, Migration 0109) – Vorgaben zu Detailfragen:**
- `reason` ist nullable: Bestand vor VT-01 bleibt „ohne Angabe“ (keine Rückrechnung). Beim Speichern gilt: Feld leer („automatisch“) →
  `defaultReason()` (fehlende Lehrkraft → `lehrkraft_abwesend`, fehlende Gruppe → Grund 1:1 bzw. `sonstiges`, gesperrter Raum →
  `raum_gesperrt`; bei Raumänderung/Verlegung zuerst die Raumsperre; sonst leer). Feld fehlt ganz (z. B. „Vorschlag übernehmen“,
  Ausweichraum, Entfall bei Freisetzung) → eine schon gewählte Kategorie bleibt, sonst Vorgabe. Ebenso bleiben interner Hinweis und
  „nur Betreuung“, wenn ein Weg sie nicht mitschickt; „nur Betreuung“ fällt bei anderer Art weg (Check-Constraint).
- `updated_*` ist beim Anlegen leer; `created_*` bleibt beim Überschreiben. Ein Tauschpartner (Stufe 2) bekommt dieselbe Kategorie, keinen
  internen Hinweis.
- Kenntnisnahme: Moduleinstellung `stundenplan.substitution_ack` (an/aus, Vorgabe an, F-10-10), Service `acknowledgeSubstitution()` +
  Action (nur die Vertretungslehrkraft, nur veröffentlichte Tage, Kopplungsteile mit); ändert weder `updated_*` noch die Historie. Die
  Bedienung („Gesehen“ in „Meine Vertretungen“/Gong) und die Liste Unbestätigter kommen mit VT-02.
- Historie: Einträge ohne geänderte Felder (erneutes Speichern) entfallen; `substitution_id` ist bei `delete`-Einträgen leer (die Zeile gibt es
  nicht mehr, ältere Einträge leert der Fremdschlüssel) – die Zuordnung läuft über (Stunde, Tag). Solver-Übernahme schreibt `plan_publish`
  (Vorher), Rücknahme `plan_undo` (wiederhergestellt: Nachher; mit der Übernahme-Stunde gelöscht: Vorher). Löschen einer Stunde/Kopplung
  schreibt `delete` vor der Kaskade. Umhängen auf eine neue Stunde (Periode kopieren, Teilung am Zeitraumende) nimmt die Historie mit.
  Nicht in der Historie: die Markierung „Abwesenheit beendet – prüfen“ und „Behalten“ (nur Zeitpunkt, kein Inhalt).
- Scrub: Kennung der Vertretungslehrkraft in `before/after` sowie Kürzel **und** Name als ganzes Wort in `note`/`internal_note`.
- Rücknahme-Daten des Solvers (`undo.substitutions`) tragen die neuen Felder mit, damit „Zurücknehmen“ sie wiederherstellt.
- Material ohne Abwesenheit: Unique als Ausdrucksindex `(lesson_id, date, coalesce(absence_id, ''))`; gibt es zu einer Stunde Material mit und
  ohne Abwesenheit, zeigt die Planung das der Abwesenheit. Die Pflege-Oberfläche kommt mit VT-03b („Material“ im kompakten Formular).
- Tagesmitteilungen: Speichern startet keinen Entwurf; sichtbar außerhalb der Planung nur an veröffentlichten Tagen (`draftDays`).
  Pflege als kleine Liste auf `/planung/vertretungen`; Anzeige in Plan/Monitor/Druck mit VT-02.

**Umgesetzt mit VT-02 (2026-10-27, ohne Migration) – Vorgaben zu Detailfragen:**
- **Marker „neu/geändert“:** Stichzeitpunkt ist der letzte Vortags-Versand um 18:00 (Berliner Zeit) vor dem Abruf – bis 17:59 der Vortag 18:00, ab 18:00 derselbe Tag (`markerSince`). „neu“ = Vertretung seit dem Stichzeitpunkt angelegt (`created_at`), „geändert“ = ein Historien-Eintrag seither, der ein sichtbares Feld ändert (`changedSince`; nur interner Hinweis zählt nicht, Aufheben verschwindet einfach). Bis VT-04 war 18:00 fest; seit VT-04 gilt die Einstellung `notify_eve_time` bzw. der tatsächliche Versand (siehe unten). Freigabe-Tage: maßgeblich ist das Anlegen, nicht das Veröffentlichen. Marker in Vertretungsplan, Monitor und Planung, nicht im Druck.
- **Raum „alt → neu“:** eine Regel `roomShift(alt, neu)` in `display.ts` für Vertretungsplan, Monitor, Druck, Planung, Wochenplan/Tagesleiste (`R 106 → 105`), Kursseite und Klassenbuch; gleicher Raum oder keiner → nur der Raum; Entfall → kein Raum; Zusammenlegung → Raum der anderen Stunde. Die Raumsicht des Wochenplans bleibt bei „→ R 105“ bzw. dem eigenen Raum.
- **„Betreuung“:** Art heißt „Betreuung“ statt „Vertretung“ (Vertretungsplan, Monitor, Druck, Klassenbuch), im Plan der abgebenden Lehrkraft „Betreut“. Der Grund steht als „Grund: …“ (Vertretungsplan, Klassenbuch), als eigene Spalte (Druck) bzw. vor dem Hinweis (Monitor, Wochenplan, Tagesleiste, Kursseite).
- **Tagesmitteilungen:** oben je Tag; „nur Beschäftigte“ sehen Beschäftigte (`isStaffRole`) im Vertretungsplan, Druck und in der Tagesleiste sowie der Monitor „Lehrerzimmer“; Foyer, Schüler:innen und Eltern nur „an alle“. Entwurfstage wie bisher nur Planung.
- **Interner Hinweis:** außer in der Planung nur in „Meine Vertretungen“ (Vertretungsplan der Lehrkraft, `ownSubstitutions`) und im Klassenbuch-Hinweis der Stunde (`lessonSubstitution`: Vertretungslehrkraft oder `stundenplan.substitute`). Die Tagesleiste zeigt ihn nicht (nur „bitte bestätigen“ mit Link). Grep-Test um `internal.note` erweitert.
- **Kenntnisnahme:** Knopf „Gesehen“ je Vertretung in „Meine Vertretungen“ (nur bei eingeschalteter Einstellung, nur veröffentlichte Tage); Planung: Spalte „Gesehen“ (offen/gesehen) in „Alle Änderungen“ und Liste „Noch nicht bestätigt“ für die Tage des Vertretungsplans und den gewählten Tag. Keine Erinnerung/Eskalation (Erinnerung mit dem Vortags-Gong folgt mit VT-04).
- **Material-Link:** im Vertretungsplan für die eigenen Klassen (Sichtbarkeit wie bisher: Schüler:innen nur mit Häkchen) und in „Meine Vertretungen“; Kursseite ohne Material (Tagesleiste/Klassenbuch hatten es schon).
- **Verlauf je Stunde:** in „Alle Änderungen“ der Planung aufklappbar (Zeitpunkt, „angelegt“/„geändert: Vertretung, Raum“/„aufgehoben“, Kürzel der Person); gelöschte Vertretungen erscheinen dort nicht mehr (die Zeile fehlt) – Ansicht dafür mit VT-03a.
- **Gong-Text** (Kategorie/Raum im Nachrichtentext) bleibt bei VT-04.

**`timetable_notification_queue`** (VT-04): `id` · `date` (Vertretungstag) · `audience` (`lehrkraefte`, `lernende`) · `due_at` ·
`sent_at` · `recipients int` · `created_at`; Unique `(date, audience, sent_at is null)` (partiell). Beim Senden wird die Nachricht aus
dem **aktuellen** Stand gebaut (`dayMessage`) → immer Endstand, nie Zwischenstände. Minutentakt-Job mit `runExclusive("vertretung-gong")`
(wie `startMailOutbox`), B-52-fest. Einstellungen (Moduleinstellungen, VT-04): `stundenplan.notify_eve_time` (18:00),
`stundenplan.quiet_from`/`quiet_until` (20:00/06:30), `stundenplan.notify_students_separately` (an/aus). Regeln: heute → sofort (nur vor
Stundenbeginn, sonst nur Lehrkräfte); morgen → zur Vortags-Uhrzeit, nach der Uhrzeit sofort, in der Ruhezeit → Ende der Ruhezeit;
weiter voraus → am Vortag. Veröffentlichen eines Entwurfstags reiht ein statt zu senden; „jetzt senden“ je Eintrag. Web-Push kann später
an die Queue andocken (DSB-Votum offen).

**Umgesetzt mit VT-04 (2026-10-27, Migration 0110) – Vorgaben zu Detailfragen (Projektleitung kann sie ändern):**
- **Eine Zeile je Person und Tag** statt je (Tag, Zielgruppe): `timetable_notification_queue` = `date` · `user_id` (cascade) · `audience`
  (`lehrkraefte`, `lernende`) · `queued_at` · `due_at` · `sent_at` · `created_at`; partieller Unique `(user_id, date) where sent_at is null`.
  Nur so bekommt auch eine bisherige Vertretungslehrkraft, die im Endstand nicht mehr vorkommt, ihr „keine Änderungen mehr“. Inhalt steht
  nicht in der Tabelle, Eltern auch nicht (sie folgen beim Senden den eingereihten Lernenden). Gesendete Zeilen bleiben (LK-90 ab Anlage) –
  daraus kommt der tatsächliche Versandzeitpunkt für die Marker.
- **Endstand:** erneutes Einreihen behält den ersten offenen Eintrag (`plannedSendAt` ist monoton im Einreihezeitpunkt). Beim Senden wird
  die Nachricht aus dem aktuellen Stand gebaut; wer „keine Änderungen mehr“ bekäme, ohne je eine Nachricht zu dem Tag bekommen zu haben
  (Änderung und Rücknahme vor dem Versand), bekommt nichts; eine unveränderte Nachricht wird nicht erneut zugestellt.
- **Zeitregeln** (`sendezeit.ts`, Europe/Berlin): morgen und später → Vortag (Kalendertag davor, auch Sonntag für Montag) zur Uhrzeit; ist
  die vorbei → sofort; in der Ruhezeit → Ende der Ruhezeit. **Heute → sofort für alle Zielgruppen** (Abweichung von „nur vor Stundenbeginn,
  sonst nur Lehrkräfte“: sonst erführen Lernende eine Änderung an der 6. Stunde gar nicht; Ruhezeit gilt trotzdem). **Rückwirkend** (Tag
  vorbei) → sofort, auch in der Ruhezeit (Korrektur, niemand muss handeln).
- **Einstellungen** (Moduleinstellungen, DSB-Checkliste §13): Lehrkräfte `stundenplan.notify_eve_time` (14:00–21:00, Vorgabe 18:00),
  `stundenplan.quiet_from` („keine Ruhezeit“ oder 18:00–23:00, Vorgabe 20:00), `stundenplan.quiet_until` (05:00–08:00, Vorgabe 06:30);
  Schüler:innen/Eltern dieselben drei mit `_students`, Vorgabe „wie bei Lehrkräften“ (statt eines Schalters `notify_students_separately`).
  Werte ohne Doppelpunkt („1800“), weil der Schulprofil-Export nur Bezeichner zulässt. Geänderte Zeiten planen offene Einträge neu
  (`reschedulePending`). Wer Lehrkraft und Elternteil zugleich ist, wird als Lehrkraft eingereiht.
- **Senden:** sofort Fälliges geht in derselben Transaktion wie das Speichern raus (wie bisher, also ohne Minutenverzug); sonst Job
  `vertretung-gong` jede Minute (`startSubstitutionGong`, `runExclusive`, nur bei eingeschaltetem Modul). Doppelversand verhindert die
  Tagessperre (`pg_advisory_xact_lock` wie GATE-031 C-07): gesendet wird nur, was unter der Sperre noch offen ist. Entwurfstage warten.
- **„jetzt senden“** je Tag und Zielgruppe auf `/planung/vertretungen` (Liste „Nachrichten“, nur bei offenen Einträgen: Tag · Zielgruppe ·
  Personen · „geplant für …“), auch in der Ruhezeit; Recht `stundenplan.substitute`, Audit `stundenplan.substitution.notify_now` (Zahlen).
  Die Anzeige in der Kopfleiste des Arbeitsplatzes („Gong geplant 18:00 (34)“) bleibt VT-03a.
- **Nachrichtentext:** Raum „alt → neu“ (`roomShift`, Zusammenlegung: Raum der anderen Stunde), „Grund: …“ (Kategorie, auch für Eltern),
  „Betreuung“ statt „Vertretung“. **Erinnerung an die Kenntnisnahme:** die Nachricht an die Vertretungslehrkraft endet mit „Bitte bestätigen:
  n Vertretung(en) …“ und verlinkt auf „Meine Vertretungen“, solange sie offen sind und die Kenntnisnahme eingeschaltet ist – mit jeder
  Nachricht dieses Tages (in der Regel der Vortags-Nachricht), ohne eigene Erinnerung und ohne Eskalation.
- **Marker „neu/geändert“:** Stichzeit = letzter Vortags-Termin nach der Einstellung der Lehrkräfte; ging die zu diesem Termin geplante
  Nachricht tatsächlich später raus (Takt verzögert), gilt der Versandzeitpunkt (`markerSinceDb`).

**Umgesetzt mit VT-03a (2026-10-27, ohne Migration) – Vorgaben zu Detailfragen (Projektleitung kann sie ändern):**
- **Aufteilung:** Kopfleiste und Wochenblick oben, darunter (1) Vertretungsbedarf + „Anzeigen“ + „Abwesenheit eintragen“, (2) „Stunden am …“
  (gewählte Stunde), (3) „Kontext“, unten „Alle Änderungen“. Ab 1536 px drei Spalten, ab 1280 px zwei (Kontext unter der Stunde), schmaler
  untereinander (mobil: Liste → Detail über den Sprung `#lessons-title`). Formulare richten sich nach der Spaltenbreite (Container-Query).
- **Auswahl per URL:** `?stunde=<Stunde>` (dazu `datum`, `lehrkraft`/`gruppe`), `?vorschlag=<Lehrkraft>` für den Kontext. Ohne Lehrkraft/Gruppe
  gilt die Gruppe der Stunde; gehört die Stunde nicht zur Lehrkraft im Link, ebenfalls. Ohne `stunde` zeigt „Anzeigen“ wie bisher alle Stunden
  der Lehrkraft/Gruppe (je mit „Wählen“). „Vorschlag übernehmen“ und „jetzt senden“ bleiben in der gewählten Stunde; „Tag veröffentlichen“
  kehrt zum Tag zurück.
- **Ampel:** offen und Beginn in ≤ 2 Stunden oder läuft → „dringend“ (rot); offen später am selben Tag → „heute“, an einem kommenden Tag →
  „noch Zeit“ (gelb); geregelt (grün); offen, aber vorbei (grau). Sortierung dringend → heute → noch Zeit → geregelt → vorbei, dann Stunde.
  Die Schwelle (`SOON_MINUTES` = 120) ist fest, keine Einstellung.
- **Kontext:** markiert ist `vorschlag`, sonst die eingetragene Vertretung, sonst der beste Vorschlag; Auswahl unter den drei besten
  Vorschlägen (+ eingetragene Vertretung). Angezeigt: gehaltene Stunden des Tages (+1 mit Vertretung), Lage (Hohl-/Randstunde, „hat sonst
  frei“; „hat zu der Zeit Unterricht“ bzw. „abwesend“), Bereitschaft (in dieser Stunde bzw. welche), Tagesregel mit Hinweis „mit Vertretung
  darüber“, Aufsichten des Tages (eigene, nicht abwesend, plus übernommene), dazu der Tagesablauf. Entwurfstage zählen mit (nur Planung).
- **„Gesehen“ und Verlauf** stehen in der Stunde (Spalte und Aufklapper in „Alle Änderungen“ entfallen; dort neu „Öffnen“). Aufgehobene
  Vertretungen (letzter Verlaufseintrag „aufgehoben“, keine Änderung mehr) stehen unter „Alle Änderungen“ als „Aufgehoben“ mit „Verlauf ansehen“.
- **Kopfleiste:** Tag mit „Vortag“/„Nächster Tag“ (Schultage nach dem Schulkalender) und „Heute“, Freigabe-Stand, Zähler (Abwesenheiten,
  offen/dringend, unbestätigt, Tagesmitteilungen) als Sprungmarken, „Gong geplant 18:00 (34)“ = nächster Termin der Warteschlange (heute nur
  Uhrzeit, sonst mit Wochentag) und alle eingeplanten Personen bzw. „Gong fällig (n)“; darunter die Liste „Nachrichten“ mit „jetzt senden“,
  „Noch nicht bestätigt“ (Links öffnen die Stunde) und die Tagesmitteilungen. Ein eigener Datumswähler entfällt in der Kopfleiste (Datum
  bleibt unter „Anzeigen“).
- **Nicht in VT-03a (→ VT-03b, umgesetzt):** Vorschlagskarten mit Hauptknopf, kompaktes Formular/Segment-Schalter, Material ohne
  Abwesenheit, Speichern → nächste offene Stunde, Tastatur.

**Umgesetzt mit VT-03b (2026-10-27, ohne Migration, Rechte unverändert) – Vorgaben zu Detailfragen (Projektleitung kann sie ändern):**
- **Vorschlagskarten:** die drei besten Vorschläge als Karten (nebeneinander, mobil untereinander) mit Rang, Name/Kürzel, Badges
  „Bereitschaft“, „Fachtausch: <Fach>“ und Punkten; Gründe stehen in einem Aufklapper („Gründe (n)“), „Tag von …“ markiert die Lehrkraft im
  Kontext. Hauptknopf „<Kürzel> übernehmen“ nimmt bei Fachtausch das eigene Fach der Lehrkraft mit („<Kürzel> mit <Fach> übernehmen“),
  daneben „nur Lehrkraft“ (Fach bleibt). Ohne Fachtausch gibt es nur den Hauptknopf.
- **Segment-Schalter „Art“:** Vertretung · Nur Betreuung · Entfall · Raumänderung · Verlegung · Zusammenlegung. „Nur Betreuung“ ist keine
  neue Art im Datenmodell, sondern Vertretung mit dem Merkmal „nur Betreuung“ (F-10-9); der Schalter setzt beides. Es erscheinen nur die
  Felder der Art (Vertretung: Lehrkraft, Fach, Raum · Betreuung: Lehrkraft, Raum · Entfall: keine · Raumänderung: Raum · Verlegung:
  Zielstunde, Tauschen, Raum · Zusammenlegung: Stunde); immer sichtbar: Grund (öffentlich), Hinweis für Schüler:innen, interne Notiz;
  „Dauervertretung“ bei Vertretung/Betreuung mit mehrtägiger Abwesenheit. Wechselt man die Art, gehen Eingaben in Feldern, die dabei
  verschwinden, verloren.
- **Material:** eigener Aufklapper „Material für die Vertretung“ unter dem Formular (Dateien brauchen ein eigenes Formular; offen, wenn schon
  Material vorliegt). Gehört die Stunde zur Abwesenheit ihrer Lehrkraft, hängt das Material an der Abwesenheit, sonst wird es „ohne
  Abwesenheit“ an (Stunde, Tag) gespeichert (F-10-12, Recht `substitute`). Leer speichern löscht es, wie auf „Abwesenheit melden“.
- **Nächste offene Stunde:** Reihenfolge der Ampel (dringend zuerst). Nach „Speichern“ und nach „übernehmen“ (Knopf oder Taste) geht es zur
  folgenden offenen Stunde, sonst zur ersten anderen; ohne weitere offene Stunde bleibt die Stunde stehen. Die Zielseite meldet „Gespeichert –
  das ist die nächste offene Stunde.“ (`?gespeichert=1`). „Aufheben“ und Material speichern bleiben in der Stunde. Ohne gewählte Stunde
  (Ansicht „alle Stunden der Lehrkraft/Klasse“) bleibt „übernehmen“ wie bisher auf der Seite.
- **Tastatur:** ↑/↓ = vorherige/nächste offene Stunde (ohne Umbruch; ist die Stunde nicht offen, springt ↓ zur ersten offenen), 1–3 = Vorschlag
  1–3 übernehmen, Esc = Stunde schließen. Nur wenn kein Eingabefeld (Textfeld, Auswahl, Radio-Gruppe, Textbereich) den Fokus hat und ohne
  Strg/Alt/Meta/Umschalt. Sichtbar erklärt im Aufklapper „Tastenkürzel“; der Schalter „Tastenkürzel verwenden“ (Vorgabe an, im Browser
  gemerkt) erfüllt WCAG 2.1.4. Ziele tragen `aria-keyshortcuts` (Knöpfe `1`–`3`, Links `ArrowUp`/`ArrowDown`/`Escape`). Screenreader-Tasten im
  Lesemodus (Pfeile, Ziffern) erreichen die Seite nicht, im Formularmodus gehören sie dem Feld; es gibt dieselben Links und Knöpfe zum Anklicken.

### 3.3 Migrationsfolge (Vorschlag, Nummern endgültig beim PR)

| # | Paket | Inhalt |
|---|---|---|
| 0109 ✅ | VT-01 | `substitution_reason`, `substitution_change_action`, `day_note_audience`, Spalten an `timetable_substitutions`, `timetable_substitution_changes`, `timetable_absence_materials.absence_id` nullable + neuer Unique, `timetable_day_notes` (tatsächlich 0109, nach SP3-DEP/SP3-LA) |
| 0110 ✅ | VT-04 | `timetable_notify_audience`, `timetable_notification_queue` (eine offene Zeile je Person und Tag; tatsächlich 0110) |
| 0107 ✅ | SP3-DEP | `employment_percent`, `obligation_term2`, `obligation` nullable, `timetable_reductions.valid_from/valid_until` (tatsächlich 0107, vor VT-01) |
| 0108 ✅ | SP3-LA | `school_year_transitions.class_map` (tatsächlich 0108; nur die Spalte – Übergänge ohne Zuordnung rekonstruiert die Übernahme zur Laufzeit per Namensregel `promotedName()`, soweit eindeutig) |
| 0111 ✅ | SP3-01 | `plan_version_status`, `plan_version_source`, `timetable_plan_versions` (inkl. `discarded_by/at`), `timetable_draft_lessons`, `timetable_lessons.plan_version_id`, Daten-Migration „Bestand 1.0“ |
| 0112 ✅ | SP3-03 | `plan_comment_target`, `timetable_plan_comments` (Bezug in Spalten), Recht `stundenplan.review` (Grant an `g-schulleitung` nur mit fester ID und Slug; keine Rollen-Vorgabe, `grants.synced` nicht nötig) |
| 0113 ✅ | SP3-04 | `timetable_plan_versions.notify`, `notify_at`, `notified_at` (Änderungsliste an Schüler:innen/Eltern zur Vortags-Uhrzeit) |
| 0114 ✅ | SP3-05 | `plan_change_kind`, `timetable_plan_changes` (mit `batch_id`, `valid_from`, `notify_at`; `version_id` nullable, cascade) |
| – | SP3-02/06/07/08, VT-02/03/05 | ohne Migration (SP3-06 nutzt `checklist jsonb`; SP3-07 nutzt `class_map`) |

Reihenfolge VT vor SP3 ist nur eine Nummern-Reihenfolge; fachlich hängt SP3-04 (Übertrag von Vertretungen beim Veröffentlichen) an den
VT-01-Spalten (`changes`-Eintrag `plan_publish`), daher VT-01 vor SP3-04.

---

## 4. UI-Fluss: Planungsfahrplan (SP3-06)

Einstieg `/planung` → Kachel „Planungsfahrplan“ (ersetzt die Sektion „Jahresplanung“, sobald ein Entwurf existiert; ohne Entwurf:
Vorlagen „Neues Halbjahr“, „Neues Schuljahr“, „Änderung im laufenden Plan“, „Leerer Entwurf“). Checkliste, kein Wizard: jeder Schritt hat
Ampel + Zahl offener Punkte + Deeplink; Rücksprung jederzeit; Status wird **aus den Daten berechnet** (reine Funktion
`fahrplanStatus(db, version, today)` in `fahrplan.ts`, getestet); manuelle Häkchen/Termine/Quittierungen liegen in
`timetable_plan_versions.checklist`. Mobil als Liste, 360 px.

| # | Schritt | Status aus … | grün wenn … | Sprungziel |
|---|---|---|---|---|
| 1 | **Rahmen** | Version (Schuljahr/Zeitraum, Quelle), Zeitraster (`periods`), Ferien | Version angelegt, Zeitraster ≥ 1 Stunde, Ausgangsbasis gewählt, „gültig ab“ vorgemerkt (Schultag) | Versionskarte, Stammdaten (`verwaltung.school`) |
| 2 | **Personal** | Lehrkräfte aktiv, Deputate (`deputyAccounts` am Stichtag), Lehrfächer (SP2-12), lange Abwesenheiten (Elternzeit, Abordnung = `timetable_absences` über den Stichtag) | keine Lehrkraft ohne Lehrfach, keine Pflicht „Vorgabe“ bei Teilzeit (Hinweis), Abgänge/Zugänge der Prognose (SP2-12) gepflegt | Deputats-Karte `/planung/unterricht?ansicht=lehrkraefte`, Bedarf `/planung/bedarf` |
| 3 | **Lerngruppen** | Klassen/Kurse des Schuljahrs (`groups.school_year_id`), Hochstufung (`school_year_transitions.promotedAt`), Bänder | Klassen des Zieljahrs vorhanden (bei „Neues Schuljahr“: Schritt „Versetzung“ des Schuljahreswechsels erledigt), keine Klasse ohne Stundentafel-Jahrgang, Bänder ohne leere Mitglieder | Gruppen, Schuljahreswechsel, Bänder |
| 4 | **Unterrichtsverteilung** | `distribution()` am Stichtag: Stundentafel-Abgleich je Klasse (`curriculum`), Lehraufträge ohne Lehrkraft, Deputat über/unter Soll | jede Klasse erreicht die Stundentafel, kein Lehrauftrag ohne Lehrkraft, kein Deputat außerhalb ±0,5 (Warnung) | Matrix (SP3-LA) `/planung/unterricht?ansicht=matrix` |
| 5 | **Wünsche & Sperrzeiten** | Zeitwunsch-Fenster (`windowState`), Abgaben x/y, Raumsperren über den Zeitraum, Fixtermine (fixierte Stunden) | Fenster geschlossen **oder** Frist vorbei, Rücklauf ≥ Schwelle (Vorgabe 100 %, fehlende als Liste), Sperren geprüft (Häkchen) | `/planung/zeitwuensche`, Räume |
| 6 | **Setzen** | offene Wochenstunden im Entwurf (`openAssignments` gegen Entwurf), letzter Solver-Lauf (Status, nicht gesetzt mit Grund) | 0 offene Stunden | Setzhilfe im Entwurf, Solver (Übernahme in den Entwurf) |
| 7 | **Prüfen** | Diagnose gegen den Entwurf (Fehler/Warnungen je Kategorie), Kennzahlen (Hohlstunden L/K, Randstunden, erfüllte Wünsche %, Raumauslastung), **Diff zum gültigen Plan je Lehrkraft/Klasse**, Variantenvergleich | 0 Fehler, jede Warnung quittiert (Begründung ≤ 120 Zeichen, in `checklist`) | Diagnose `?quelle=entwurf`, Vergleich |
| 8 | **Vorschau & Veröffentlichen** | Status der Version, Vorschau-Schalter, Kommentare (offen/erledigt), Freigabe, „gültig ab“ | `freigegeben` + Stichtag + Vorschau der Veröffentlichung (Zahlen: geändert/neu/entfallen, umziehende/verlorene Vertretungen und Materialien, verwaiste Klassenbuch-Einträge, Raumbuchungen/Klausuren) | Versionskarte: „Zur Prüfung geben“ → „Freigeben“ (review) → „Veröffentlichen ab …“ |

Nach Schritt 8: Kachel „Gültig ab 01.02. – Version 2.0; Rücknahme bis 31.01. möglich“, Übergabe an das Tagesgeschäft (Vertretungsplanung
sieht ab dem Stichtag die neue Version; Vertretungen für Tage ab Stichtag werden beim Veröffentlichen übertragen – Hinweis im Wochenblick).

Vorlagen setzen Schritt 1 vor: **Neues Halbjahr** (`live_copy` ab `term2_starts_on`, Lehraufträge am Stichtag), **Neues Schuljahr** (Jahr
anlegen/aktiv? → Schuljahreswechsel bis „Versetzung“, dann Entwurf `empty` oder `previous_version` hochgestuft mit `class_map`, Lehraufträge
aus dem Vorjahr als Vorschlag – SP3-07), **Änderung im laufenden Plan** (`live_copy` ab nächstem Schultag, Schritte 2–5 eingeklappt).
**Umgesetzt (SP3-07):** „Neues Schuljahr“ auf der Versionsliste mit eigenen Schritten (`newYearTemplate()`/`createNewYearDraft()` in `neues-schuljahr.ts`, zum
Einhängen in den Fahrplan); Details §3.1 „Umgesetzt (SP3-07)“.


**Umgesetzt (SP3-06, 2026-10-28, ohne Migration)** – Vorgaben für offene Detailfragen (Projektleitung kann sie ändern):
- **Aufbau:** rein `fahrplanStatus(facts, checklist, today)` und `gateOf()`/`warningKey()`/`planKennzahlen()` in `fahrplan.ts`, Lader `loadFahrplan()`
  (gegen den Entwurf der Version an ihrem vorgemerkten Stichtag; veröffentlichte Versionen gegen den gültigen Plan), Schreiben der Checkliste unter
  Zeilensperre. Seite `/planung/fahrplan` (Reiter „Fahrplan“, `?version=`; ohne Angabe der neueste offene Entwurf, Auswahl bei mehreren), Actions in
  `fahrplan-actions.ts`. Die Signatur weicht von §4 ab (`fahrplanStatus(db, …)`): Zahlen sammelt der Lader, die Statusfunktion bleibt rein.
- **Ampel:** grün = erledigt, gelb = nur Hinweise, rot = offene Punkte (Zahl). **Schritt 8 wird erst nach dem Veröffentlichen grün** (Vorgabe statt
  „grün, wenn freigegeben + Stichtag“: sonst stünde der Fahrplan bei 8/8, ohne dass etwas gilt); „freigegeben und Schritt 7 erfüllt“ ist gelb
  („bereit“). Bei veröffentlichten Versionen sind 7 und 8 grün.
- **Schritte im Einzelnen (Vorgaben):** 1 – Zeitraster ≥ 1 Stunde, Stichtag vorgemerkt und Schultag (die Quelle ist mit der Version immer
  gewählt; Ferien nur als Sprungziel). 2 – rot bei aktiven Lehrkräften ohne Lehrfach und solange das **Häkchen „Abgänge und Zugänge (Prognose)
  gepflegt“** fehlt (aus den Daten nicht ablesbar); lange Abwesenheiten = aktive Lehrkraft-Abwesenheiten über den Stichtag ab **14 Tagen**, nur
  Hinweis; „Pflicht ‚Vorgabe‘ bei Teilzeit“ entfällt (seit SP3-DEP speichert der Anteil die Pflicht). 3 – Klassen des Schuljahrs, Klassen ohne
  Stundentafel des Jahrgangs, Bänder ohne Lehraufträge; bei der Vorlage „Neues Schuljahr“ zusätzlich die Versetzung des Schuljahreswechsels
  (`promoted`). 4 – Klassen unter der Stundentafel (Lehraufträge), Lehraufträge ohne Lehrkraft; Deputate mehr als 0,5 Std. neben dem Soll nur
  Hinweis (gelb). 5 – Fenster geschlossen oder Frist vorbei (ohne Fenster: in Ordnung), Rücklauf **100 %** (Konstante `PREF_RETURN_THRESHOLD`), Häkchen
  „Raumsperren und Fixtermine geprüft“ (immer, Zahl der Sperren im Zeitraum und fixierten Stunden als Hinweis). 6 – offene Wochenstunden der
  Lehraufträge im Entwurf; der letzte Lauf **dieses Entwurfs** (`params.versionId`) als Hinweis.
- **Schritt 7 = Bedingung fürs Veröffentlichen:** `publishVersion()` prüft vor der Transaktion die Diagnose des Entwurfs an seinem vorgemerkten
  Stichtag (nicht am gewählten Veröffentlichungstag – der liegt nie davor): **keine Fehler, jede Warnung quittiert**, sonst Abbruch mit Verweis auf den
  Fahrplan; die Seite „Veröffentlichen“ zeigt dann statt des Knopfs den Hinweis mit Sprung zu Schritt 7. Hinweise (`info`) zählen nicht.
- **Quittierungen:** je Warnung ein Schlüssel aus Kategorie, Bezug und Text (Hash, der Text selbst wird nicht gespeichert – er nennt Namen). Ändert
  sich die Warnung (andere Zahl, andere Stunden), braucht sie eine neue Quittierung; alte stehen als „gehören zu Warnungen, die es nicht mehr gibt“ und
  lassen sich aufräumen. Begründung Pflicht, ≤ 120 Zeichen (Hinweis „keine Gesundheitsangaben“). Im Formular je Kategorie alle offenen Warnungen
  vorgewählt, **eine Begründung für die gewählten** (Sammel-Quittierung, z. B. „Teilzeit, mit SL abgestimmt“); einzeln zurücknehmen. Fehler sind nicht
  quittierbar. Quittieren, Häkchen und Termine gehen in **allen offenen Status** (auch in Prüfung/freigegeben) – sie ändern den Inhalt nicht, eine
  Freigabe bleibt; nach dem Veröffentlichen ist die Checkliste abgeschlossen. Nur `stundenplan.manage` schreibt; die Prüfung (`review`) liest den
  Fahrplan ab „in Prüfung“ samt Begründungen.
- **Termine:** optional je Schritt, bis Schuljahresende (frühestens ein Jahr vor Schuljahresbeginn); „überfällig“, solange der Schritt nicht grün ist.
  Kein Gong, keine Erinnerung.
- **Kennzahlen (Schritt 7):** Hohlstunden wie im Variantenvergleich; **Randstunden** = Stunden in der ersten oder letzten Stunde des Zeitrasters;
  **erfüllte Wünsche** = Anteil der Lehrkraft-Slots mit „lieber nicht“/„gesperrt“, die frei bleiben (positive Wünsche zählen nicht); **Raumauslastung**
  = belegte Raum-Slots je Woche / (aktive Räume × 5 Tage × Zeitraster). Dazu Diff zum gültigen Plan (geändert/neu/entfällt, betroffene Lehrkräfte und
  Klassen) und **Sofort-Korrekturen seit Entwurfsbeginn** (`correctionsSince`, offener Punkt aus SP3-05) mit Link aufs Korrektur-Protokoll. Den
  Variantenvergleich verlinkt der Schritt nur (Kennzahlen dort unverändert).
- **Vorlagen:** „Neues Halbjahr“ und „Änderung im laufenden Plan“ (SP3-05) vermerken die Vorlage in `checklist.template` (auch von der Versionsliste
  aus); „Leerer Entwurf“ = neue Planung ab dem vorgeschlagenen Stichtag mit den fixierten Stunden. **„Neues Schuljahr“** nutzt die Vorlage aus
  SP3-07 (`schuljahrOffer()` → `newYearTemplate()`/`createNewYearDraft()` für das Schuljahr nach dem Planungsjahr, Plan des Vorjahrs hochgestuft;
  ohne Folgejahr der Hinweis auf Stammdaten); Schritt 3 prüft bei dieser Vorlage die Versetzung. Ohne gespeicherte Vorlage gilt eine Folgeversion (`minor > 0`) als „Änderung im laufenden Plan“ (Schritte 2–5 eingeklappt).
- **Übersicht `/planung`:** solange ein offener Entwurf existiert, ersetzt die Sektion „Planungsfahrplan“ (neuester Entwurf: Schritte mit Ampel,
  „weiter mit …“, Zahl weiterer Entwürfe) die Jahresplanung; der Fachbedarf steht dann eigenständig. Ohne Entwurf bleibt die Jahresplanung mit
  einer Kachel „Planungsfahrplan“ zu den Vorlagen.
- **Korrektur-Protokoll** (offener Punkt aus SP3-05): `/planung/versionen/korrekturen?jahr=` (nur `manage`, `korrekturprotokoll.ts`) – je Aktion Zeitpunkt,
  handelnde Person, Stichtag, Version, Begründung, Art und die Zeilen wie in der Änderungsliste, Versand an Schüler:innen/Eltern; die neuesten 1 000
  geänderten Stunden.
- **Datenschutz:** keine neue Tabelle; die Checkliste gehört zur Version (Löschklasse der Version). Kontolöschung ersetzt Kennungen der handelnden
  Person (`createdBy`), der Lehrkraft einer Quittierung (`teacherId`) und Kürzel/Namen in Begründungen (`scrubPlanVersions`). Auskunft (Art. 15):
  Quittierungen erscheinen nicht – Prüfnotizen über eine Lehrkraft wie die Kommentare (Projektleitung: ohne SL-Kommentare über die Lehrkraft).
  Audit `stundenplan.plan.acknowledge`/`acknowledge_revoke`/`checklist` mit Zahlen und Kategorien, nie mit der Begründung.

---

## 5. Rechte und Datenschutz

| Wer | Entwurf (Stunden mit Lehrkraft) | Kommentare | Freigabe | Veröffentlichen | Vertretung: `internal_note`, Historie, Kenntnisnahme-Liste |
|---|---|---|---|---|---|
| `stundenplan.manage` | lesen/schreiben alle Versionen | lesen/schreiben/erledigen | nein (außer mit `review`) | ja | – |
| `stundenplan.review` (Gruppe Schulleitung) | lesen ab Status `pruefung` | schreiben | **ja** | nein | – |
| `stundenplan.substitute` | nein (sieht nur, ab wann welche Version gilt) | nein | nein | nein | ja |
| Lehrkraft | nur **eigener** Plan ab Stichtag, nur wenn `teacher_preview` an und Status ≥ `pruefung` | eigene Kommentare an die Planung | nein | nein | eigene Vertretungen: Kenntnisnahme setzen; `internal_note` nur als Vertretungslehrkraft dieser Stunde |
| Schüler:innen/Eltern/Monitor | nie | nie | – | – | nie (`reason`-Kategorie ja, `note` ja, `internal_note` nie) |

- **Löschklassen (Manifest `retention`):** `timetable_plan_versions` LK-SJ-1J ab `school_year_id` (Kategorien: Name, Status, Zeitpunkte,
  Ersteller/Prüfer/Veröffentlicher, Rücknahme-Daten mit Lehrkraft-ids – wie Solver-`undo` nur bis zum Stichtag, Nachtjob leert);
  `timetable_draft_lessons` `follows` Version; `timetable_plan_comments` `follows` Version (Autor set null bei Kontolöschung);
  `timetable_plan_changes` LK-SJ-1J ab `created_at`, Kontolöschung ersetzt ids in `before/after`; `timetable_substitution_changes`
  LK-SJ-1J ab `date` mit Scrub; `timetable_day_notes` LK-SJ-1J ab `date` (Freitext – Hinweis „keine Personen“);
  `timetable_notification_queue` LK-90 (nur Zahlen); `timetable_absence_materials` eigene Klasse LK-SJ-1J ab `date` statt `follows`.
- **Auskunft (Art. 15):** Entwurfsstunden sind wie Solver-Vorschläge „Entwurf ohne Außenwirkung“ (SICHERHEIT S80): Lehrkräfte erscheinen
  dort nicht; Kommentare mit eigener Autorenschaft erscheinen (Text), Kenntnisnahme-Zeitpunkte der eigenen Vertretungen erscheinen.
  `auskunft.test.ts` erweitern.
- **Gesundheitsbezug:** `reason` ist bewusst grob (`lehrkraft_abwesend` deckt krank/fortbildung/dienstlich); `internal_note` und
  Kommentare mit Hinweis „keine Gesundheitsangaben“; Abwesenheitsgrund bleibt wie heute nur bei der Planung.
- **Umgesetzt (SP3-03):** Rechte wie in der Tabelle; Kommentare in `timetable_plan_comments` (Bezug in Spalten), Freigabe auch bei offenen
  Kommentaren, Schulleitung sieht Versionen ab „in Prüfung“ (Details §3.1 „Umgesetzt (SP3-03)“). Auskunft: eigene Kommentare ja, Prüfnotizen über
  eine Lehrkraft nein (`EXPORT_SKIP_REFS`); SICHERHEIT S86.
- **Querschnittstests:** (a) Schülersicht/Monitor/Eltern-Gong enthalten nie `internal_note`, nie Abwesenheitsgrund, nie Kommentare;
  (b) kein Leser außerhalb der Planung liest `timetable_draft_lessons` (Grep-Test wie `retention.test`); (c) Lehrkraft-Vorschau liefert nur
  eigene Stunden; (d) nach Kontolöschung keine Lehrkraft-id in `changes.before/after` und `undo`.
- **SICHERHEIT.md:** neue Zeile S8x „Planversionen und Freigabe“ (Recht `review`, 2FA, kein Verwaltungsrecht i. S. S28, Vier-Augen nicht
  erzwungen – Frage F-10-3), DATENSCHUTZ §3.4 um die neuen Tabellen, DSB-FRAGEN §13 um Sendezeiten/Kenntnisnahme (keine neue DSB-Frage
  nötig, nur Hinweis), VVT-Druck automatisch aus dem Manifest.

---

## 6. Auswirkungen auf bestehende Leser und Schreiber

| Baustein | Änderung | Umfang |
|---|---|---|
| **Solver** (`solver.ts`) | keine – reine Funktion | 0 |
| **Solver-Eingabe** (`solver-input.ts`) | `solverInputFromDb(db, year, today, { source })`: fixierte/ersetzbare Stunden aus `lessonTable(source)`; Lauf merkt sich `params.versionId` | klein |
| **Solver-Übernahme** (`solverlauf.ts`) | `applyRun` schreibt in den Entwurf der Version (ersetzt nicht fixierte Entwurfsstunden, `origin` bleibt, `solver_run_id` gesetzt); Live-Übernahme + `undoApply` wandern in `publishVersion`/`undoPublish` (Code wiederverwenden, Konfliktzählung bleibt) | mittel |
| **Setzhilfe** (`setzhilfe.ts`) | `gridLessons`, `openAssignments`, `assignmentPlacement`, `placeAssignment`, `movePlacement`, `moveLesson` mit `source`; im Live-Plan `moveLesson` als Split (SP3-05) | mittel |
| **Stundenpflege** (`manage.ts`) | `findCollisions`, `create/update/deleteLesson`, `saveCoupling`, `couplingParts`, `lessonsOfGroup` mit `source`; Live-Update als Split (SP3-05) | mittel |
| **Diagnose** (`diagnose.ts`) | `diagnoseYear(db, year, today, fallback, pre, { source })`; `groupPlanFindings` ebenso; `diagnose()` unverändert | klein |
| **Vorprüfung** (`solver-check.ts`) | über die Eingabe, keine eigene Änderung | 0 |
| **Verteilung** (`verteilung.ts`) | `planLessonsOn(db, ref, source)` für „verplant“ im Entwurf; `distribution()` bekommt optional `source` (nur `planned`/`unmatched` hängen am Plan) | klein |
| **Deputate** (`deputate.ts`) | Stichtag ✅ (SP3-DEP, `deputyAccounts(…, refYmd)`), `planned` aus der Quelle | klein |
| **Übersicht** (`uebersicht.ts`) | Jahresplanung → Fahrplan-Status (SP3-06) | mittel |
| **Vertretung** (`vertretung.ts`) | VT-01-Felder in `SubstitutionInput`, Historie schreiben, Upsert behält `created_*` und setzt `updated_*`; `substitutionsOn` liefert `reason`, `internal_note` (nur mit `substitute`), `acknowledged`, `changedSince`; Kenntnisnahme-Action; Versionsgrenze: Vertretungen für Tage ≥ `valid_from` einer `freigegeben`-Version mit Hinweis, Übertrag in `publishVersion` | mittel |
| **Vertretungs-Gong** (`vertretung-gong.ts`) | `notifySubstitutionDay` reiht ein statt zu senden (VT-04); Nachrichtentext um Grund-Kategorie/Raum alt → neu; Eltern weiter ohne `note`/`internal_note` | mittel |
| **Freigabe je Tag** (`freigabe.ts`) | unverändert; Tagesmitteilungen folgen `draftDays` | klein |
| **Anzeige** (`display.ts`, `today.ts`, `widgets.tsx`, Vertretungsplan, Druck, Monitor, Kursseite) | Raum „alt → neu“, Grund-Kategorie, Marker „neu/geändert“, Tagesmitteilungen oben, `internal_note` nur für Planung/Vertretungslehrkraft | mittel–groß (VT-02) |
| **Klassenbuch** | keine Code-Änderung; profitiert von „Split statt in place“ und vom Übertrag beim Veröffentlichen (`lesson_id` bleibt bei unveränderten Stunden) | 0 (Test: Einträge vor/nach Stichtag bleiben zugeordnet) |
| **Notenbuch, Sitzplan, Sprechtag, Klausurplan, Buchungen, Monitor, Räume/Stammdaten-Sperren, Auskunft** | keine Änderung (lesen weiter nur `timetable_lessons`) | 0 |
| **Drucke/Exporte** (SP2-10) | Plandruck bekommt Datumswähler „Plan am …“ (Archiv) und optional „Entwurf Version x“ nur für `manage`/`review`; CSV der Verteilung unverändert | klein |
| **Schuljahreswechsel** (`schuljahreswechsel.ts`) | `promote()` schreibt `class_map`; Fahrplan-Vorlage „Neues Schuljahr“ verlinkt die Schritte | klein |
| **Zeitwünsche** | unverändert; Rücklauf im Fahrplan Schritt 5 | 0 |
| **Nachtjobs** | `solver-aufraeumen` leert zusätzlich `plan_versions.undo` ab Stichtag und verwirft offene Entwürfe abgelaufener Schuljahre; neuer Minutenjob `vertretung-gong` (VT-04) | klein |
| **E2E** | `zx-gate-sp.spec.ts` (Übernahme → Zurücknehmen) auf den Versionsweg umstellen; neue `zx-gate-sp3.spec.ts`, `zx-gate-vt.spec.ts` | mittel |

**Umgesetzt (SP3-02):** Solver-Eingabe, Setzhilfe (`gridLessons`, `openAssignments`, `assignmentPlacement`, `placeAssignment`, `movePlacement`,
`moveLesson`), Stundenpflege (`findCollisions`, `create/update/deleteLesson`, `saveCoupling`, `deleteCoupling`, `couplingParts`, `lessonsOfGroup`),
Fixieren, Diagnose (`diagnoseYear`, `groupPlanFindings`), Vorprüfung (über die Eingabe) und Verteilung/Deputat-Ist (`planLessonsOn`,
`distribution`) laufen mit `source`; Solver und `diagnose()` unverändert. Die Solver-Übernahme schreibt in den Entwurf (`applyRunToDraft`); die
Live-Übernahme mit `undoApply` bleibt bis SP3-04 als Übergangsweg (Vorgabe §3.1) und wandert dann in `publishVersion`/`undoPublish`. Der Split im
gültigen Plan (`moveLesson`/`updateLesson`) bleibt SP3-05. E2E: `zx-gate-sp.spec.ts` prüft bis SP3-04 den eingeklappten Übergangsweg; neu
`planung-entwurf.spec.ts`. Alle Leser außerhalb der Planung unverändert.

**Umgesetzt (SP3-04):** Solver-Übernahme in den gültigen Plan entfernt (nur noch über den Entwurf und `publishVersion`; `undoApply` bleibt für schon
übernommene Läufe bis zu ihrem Stichtag). Nachtjob unverändert (leert `undo` veröffentlichter Versionen ab dem Stichtag), der Minutentakt
`vertretung-gong` sendet zusätzlich fällige Änderungslisten. Plan-Leser (Stundenplan, Druck) lesen weiter `timetable_lessons` am Tag und nennen die
Version über `plan-archiv.ts`; Vertretungs-Arbeitsplatz mit Hinweis auf freigegebene Versionen. Klassenbuch ohne Code-Änderung (Test: Einträge vor
dem Stichtag bleiben an der alten Zeile, danach ziehen sie um). E2E umgestellt: `solver-uebernahme`, `zx-gate-sp`, `zx-gate-sp2`,
`stundenplan.spec`; neu `planung-veroeffentlichen.spec.ts`.

**Umgesetzt (SP3-05):** Setzhilfe (`placeAssignment`, `moveLesson` inkl. Tausch) und Stundenpflege (`createLesson`/`updateLesson`/`deleteLesson`, `saveCoupling`/
`deleteCoupling`) schreiben im gültigen Plan über die Sofort-Korrektur (Split ab dem nächsten Schultag, in place nur ohne Vergangenheitsbezug, Protokoll, Gong,
Entwürfe nachziehen); im Entwurf unverändert. Minutentakt `vertretung-gong` sendet zusätzlich fällige Änderungslisten der Sofort-Korrekturen. Klassenbuch ohne
Code-Änderung (Test: Einträge vor dem Stichtag an der alten, danach an der neuen Stunde bzw. ohne Bezug, wenn sie an dem Tag nicht stattfindet). „Periode kopieren“
(`periode.ts`) entfernt; E2E `stundenplan.spec` auf die Halbjahres-Vorlage umgestellt, neu `planung-laufzeit.spec.ts`.

**Umgesetzt (SP3-07):** Schuljahreswechsel unverändert (`promote()` schreibt `class_map` seit SP3-LA); die Vorlage „Neues Schuljahr“ liest Durchlauf, Versetzung und
`class_map` und verlinkt die Schritte. Versionsliste zeigt Kurzstatistik und „Schuljahr archivieren“; alle Plan-Leser unverändert. E2E neu `planung-schuljahr.spec.ts`
(nur lesend – Hochstufen und Archivieren in `neues-schuljahr.test.ts`/`schuljahresabschluss.test.ts`, weil sie die gemeinsame E2E-DB verändern würden).

---

## 7. Paketschnitt

Größen: S < 1 Tag, M 1–2 Tage, L 2–4 Tage (ein Agent, ein PR). Modell: **Opus** für Kern-/Rechte-/Datenschutz-Logik, **Sonnet** für klar
umrissene UI/E2E über vorhandene Bausteine, **Haiku** nur Statuschecks. „Kern“ = berührt Solver-Übernahme/Setzhilfe/Diagnose-Lader.

### 7.1 Block VT – Vertretung mit mehr Infos + Arbeitsplatz

| ID | Titel | Umfang / Akzeptanz | Mig. | Modell | Abh. | Größe |
|---|---|---|---|---|---|---|
| **VT-01** | Datenmodell „mehr Infos“ | §3.2 ohne Queue: `reason` mit Vorgabe aus Abwesenheit/Raumsperre, `internal_note`, `supervision_only`, `updated_*`, `acknowledged_at`; `timetable_substitution_changes` (create/update/delete, Scrub bei Kontolöschung); Material ohne Abwesenheit (nullable, Unique, Rechte); `timetable_day_notes` mit Tagesfreigabe. Server-Logik, Audit, Manifest `retention`, DATENSCHUTZ §3.4, Migrationstest, Querschnittstest „intern nie außen“ | ja | **Opus** | B1 | M |
| **VT-02** | Anzeige überall | Vertretungsplan (Schüler/Eltern/Lehrkräfte), Monitor, Druck, Kursseite, Heute/Widgets, Klassenbuch-Hinweis: Grund-Kategorie, Raum „alt → neu“ einheitlich, öffentlicher vs. interner Hinweis, Material-Link, Marker „neu/geändert seit …“ (aus `changes` gegen letzten Versand), Tagesmitteilungen oben, Änderungsverlauf je Stunde (Planung), Kenntnisnahme (Lehrkraft setzt, Planung sieht Unbestätigte, Spalte im Arbeitsplatz). A11Y hell/dunkel/360 px | nein | **Opus** | VT-01 | M–L |
| **VT-03a** | Arbeitsplatz-Layout + Kontext | `/planung/vertretungen` dreiteilig (offene Stunden mit Ampel · gewählte Stunde · Tagesplan Klasse + vorgeschlagene Lehrkraft mit Hohl-/Randstunde, Stundenzahl, Aufsicht, Tagesregel, Bereitschaft), Kopfleiste (Datum, Wochenblick, Abwesende, Zähler, Tagesmitteilungen, „Tag veröffentlichen“, „Gong geplant 18:00 (34)“); mobil Liste → Detail | nein | **Opus** | VT-02 | L |
| **VT-03b** | Vorschlagskarten, kompaktes Formular, Tastatur | Karten mit Hauptknopf (+ „nur Lehrkraft“), Gründe aufklappbar; Art als Segment-Schalter mit passenden Feldern (inkl. „nur Betreuung“, interner Hinweis, Material); Speichern → nächste offene Stunde; ↑/↓, 1–3, Esc | nein | **Sonnet** | VT-03a | S–M |
| **VT-04** | Benachrichtigung zur sinnvollen Zeit | §3.2 Queue + Einstellungen + Minutenjob (`runExclusive`); `notifySubstitutionDay` reiht ein; Lehrkräfte/Lernende getrennt; nur Endstand; Anzeige „geplant für …“ + „jetzt senden“; Veröffentlichen eines Entwurfstags reiht ein; Tests Ruhezeit/Vortag/heute/B-52 | ja | **Opus** | VT-01 (unabhängig von VT-03) | M |
| **VT-05** | E2E + GATE VT | Szenario Morgen: Abwesenheit → Arbeitsplatz → Vorschlag per Tastatur → Grund/Hinweise/Material → Tag veröffentlichen → Gong geplant → Schülersicht ohne interne Infos → Kenntnisnahme; Review-PR mit Prüfliste | nein | **Sonnet** (Opus bei Shard-Flakes) | VT-01…04 | S |

### 7.2 Block SP3 – Lebenszyklus, Fahrplan, Lehraufträge, Deputat

| ID | Titel | Umfang / Akzeptanz | Mig. | Modell | Abh. | Größe |
|---|---|---|---|---|---|---|
| **SP3-DEP** | Deputatsmodell | §3.1 Deputat: Teilzeit-Anteil (Rechenhilfe → Pflicht), Pflicht 2. Halbjahr, Anrechnungen mit Gültigkeit; `deputyAccounts()` am Stichtag; Deputats-Karte mit beiden Halbjahren; Diagnose „Deputat“ am Stichtag; „Mein Deputat“ zeigt die eigene Rechnung; Bedarf/Prognose (SP2-12) nutzt die Werte. Tests Rechnung/Stichtag/Löschklasse | ja | **Opus** (Personaldaten, Stichtag-Logik) | – (parallel zu SP2-12 möglich, aber nach dessen Merge wegen Deputats-Karte) | S–M |
| **SP3-LA** | Lehraufträge schnell anlegen | Ansicht `/planung/unterricht?ansicht=matrix`: Klasse × Fach, Zelle vorbefüllt mit Stundentafel-Soll (`curriculum_hours`) und bestehendem Lehrauftrag; Zelle = Lehrkraft per Typeahead **nur Lehrkräfte mit dem Lehrfach** (SP2-12), sortiert nach Restdeputat und Kontinuität (Vorjahr über `class_map`), „alle anzeigen“ mit Warnhinweis; Stunden/Doppelstunden/Band in der Zelle; Massenaktion („Lehrkraft übernimmt Fach in Klassen …“); „Aus dem Vorjahr übernehmen“ (Vorschlag je Zelle, hochgestuft, Lehrkraft folgt der Klasse, abwählbar, Deputatsprüfung); Seitenleiste Live-Bilanz je Lehrkraft (Soll/Ist/Rest, Server-Action-Rundlauf) und Stundentafel-Abgleich je Klasse; Tastatur (Tab/Enter/Esc, Pfeile); `class_map` in `promote()`; Audit mit Anzahlen; E2E Matrix | ja (`class_map`) | **Opus** | SP2-12 (0105) | L |
| **SP3-01** | Planversionen + Entwurfsbereich | §3.1 Versionen, Entwurfsstunden, `plan_version_id`, Daten-Migration „Bestand 1.0“; `PlanSource` + `lessonTable()`; Entwurf anlegen aus gültigem Plan ab Stichtag (ersetzt `copyPeriod`), leer, Vorversion; Variante anlegen; verwerfen; Versionsliste `/planung/versionen` mit Karte; Nachtjob-Erweiterung; Manifest/DATENSCHUTZ; Migrationstest, Test „kein fremder Leser“ | ja | **Opus** | B1 | L |
| **SP3-02** | Arbeiten im Entwurf (**Kern**) | Setzhilfe, Stunden-/Kopplungspflege, Fixieren, Diagnose, Vorprüfung, Solver-Lauf (`versionId` im Lauf) und Solver-Übernahme **in den Entwurf**; Stichtag-/Quellen-Wähler in Stundenplan/Unterrichtsverteilung/Diagnose („Gültiger Plan“ · „Entwurf 2.0“); Diff-Engine `planDiff()` (Entwurf ↔ gültig je Lehrkraft/Klasse; Version ↔ Version); Variantenvergleich über `solververgleich` mit Quelle „Version“; Benchmark unverändert | nein | **Opus** | SP3-01 | L |
| **SP3-03** | Prüfung & Freigabe | Recht `stundenplan.review` (Migration, Grant Schulleitung, 2FA), Status `pruefung`/`freigegeben`/zurück, Kommentare (Version/Lehrkraft/Klasse/Slot, erledigen), Lehrkräfte-Vorschau „Mein Plan ab …“ (Schalter, nur eigener Plan, Kommentar an die Planung), SICHERHEIT S8x, Auskunft; Rechte-Tests, Querschnittstest Vorschau | ja | **Opus** | SP3-01 | M |
| **SP3-04** | Veröffentlichen + Archiv (**Kern**) | §2.3 `publishVersion()`/`undoPublish()` (Diff, Übertrag von Vertretungen/Material/Klassenbuch, `undo`, Konfliktzählung aus `undoState` übernommen), Vorschau der Veröffentlichung mit Zahlen, Änderungsliste je Person als gebündelter Gong (Lehrkräfte sofort, Lernende/Eltern nach Einstellung), Versionsliste mit Zeitstrahl, „Plan am Tag X“ (Datumswähler in Plan und Druck), Vorgängerversion archiviert; `zx-gate-sp.spec` umgestellt; Nachtjob leert `undo` | nein | **Opus** | SP3-02, SP3-03, VT-01 | M–L |
| **SP3-05** | Änderungen während der Laufzeit + Halbjahr | Folgeversion 1.1 (Vorlage „Änderung im laufenden Plan“, Diff-Ansicht), Sofort-Korrektur als Split mit `timetable_plan_changes` + Gong an Betroffene (Setzhilfe/Pflege im Live-Plan umgestellt, in place nur ohne Vergangenheitsbezug), Halbjahres-Vorlage (`term2_starts_on`, Lehraufträge am Stichtag, Lauf „Lehraufträge am“), `copyPeriod` UI entfällt; Tests Klassenbuch/Vertretung bleiben zugeordnet | ja | **Opus** | SP3-04 | M |
| **SP3-06** | Planungsfahrplan | §4: `fahrplan.ts` (`fahrplanStatus()` rein + Lader), Kachel/Seite `/planung/fahrplan`, Vorlagen, Quittierungen mit Begründung, Termine optional, Deeplinks, Übersicht `/planung` umgebaut; mobil; E2E Fahrplan-Durchlauf; Doku STUNDENPLAN.md „Planen in acht Schritten“ | nein (`checklist jsonb`) | **Opus** (Vorgabe Projektleitung 25.10.) | SP3-04, SP3-LA, SP3-DEP | M |
| **SP3-07** | Schuljahresabschluss + Übertrag | Vorlage „Neues Schuljahr“ (Schuljahreswechsel → Versetzung → Entwurf aus Vorjahr hochgestuft: Klassen über `class_map`, Kurse/Bänder nicht), Lehraufträge des Vorjahrs als Vorschlag (fließt in SP3-LA „Übernehmen“), Schuljahr archivieren (lesbar, Versionen `archiviert`), Kurzstatistik Ausfall/Vertretung je Schuljahr (ohne Namen für `review`) | nein | **Opus** | SP3-04, SP3-LA | M |
| **SP3-08** | E2E + GATE SP3 | `zx-gate-sp3.spec.ts`: Fahrplan „Neues Halbjahr“ → Matrix → Setzen/Lauf in den Entwurf → Prüfen (Warnung quittieren) → Vorschau Lehrkraft → Freigabe (Schulleitung `petra.lindner`) → Veröffentlichen ab Stichtag → Vertretung übertragen → Folgeversion 1.1 → Zurücknehmen → Archiv „Plan am Tag X“; A11Y hell/dunkel/360 px; Review-PR mit Prüfliste (§9) | nein | **Sonnet** | SP3-01…07 | S |

### 7.3 Reihenfolge und Abhängigkeiten

```
SP2-12 (0105) ──► SP3-LA ──┐
SP3-DEP ───────────────────┤
VT-01 ──► VT-02 ──► VT-03a ──► VT-03b ──► VT-05 / GATE VT ──► Release (v0.10)
   └────► VT-04 ──────────────────────────┘                     │
                                                                ▼
SP3-01 ──► SP3-02 ──► SP3-03 ──► SP3-04 ──► SP3-05 ──► SP3-06 ──► SP3-07 ──► SP3-08 / GATE SP3 ──► Release (v0.11)
                                  ▲
                                  └── VT-01 (Historie-Eintrag `plan_publish`)
```

Empfehlung (Frage F-10-14): nach v0.9.0 zuerst **SP3-DEP + SP3-LA** (unabhängig, Priorität 2 der Projektleitung, je ein Strang), dann
**Block VT** (Tagesgeschäft, Daten fast komplett da, Release v0.10), dann **Block SP3** (Release v0.11). Alternative: SP3-01…04 vor VT, wenn Versionen früher gebraucht werden; dann rutscht VT nach hinten.
Entschieden (F-10-14): Empfehlung. Je Paket ein PR, Merge per `scripts/pr-merge.sh`, Gate-PRs nach Regel F3.

### 7.4 Pflege nach Abnahme (B2)

BACKLOG: Blöcke „VT – Vertretung mit mehr Infos“ und „SP3 – Lebenszyklus Stundenplan“ mit obigen IDs; PLAN §0 Verweis; QUESTIONS Runde 10
eintragen; Board 2: „Geführter Lebenszyklus/Planungsfahrplan“ und „Vertretung als Arbeitsplatz + Benachrichtigung“ auf „Im Backlog“;
STUNDENPLAN-UMBAU §6.2/§7: „Plan-Versionen: bewusst nein (Q-SP-16)“ → „aufgehoben 25.10.2026, siehe STUNDENPLAN-LEBENSZYKLUS.md“.

---

## 8. Risiken

| # | Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|---|
| R1 | **Diff/Übertrag beim Veröffentlichen** ist der komplexeste Teil (Kopplungen mit neuer `coupling_id`, A/B-Wochen, Lehrauftrags-Gültigkeit, Verlegung/Zusammenlegung über `merge_lesson_id`) | falsch umgehängte Vertretungen, verwaiste Klassenbuch-Einträge | reine Funktion `planDiff()` + `transferPlan()` mit Tabellen-Tests aus dem Demo-Plan; Vorschau zählt alles vorher; Rücknahme bis Stichtag; SP3-04 ist „Kern“ mit Opus |
| R2 | **Zwei Wahrheiten um den Stichtag**: Vertretungsplanung arbeitet im gültigen Plan, die Planung in einer freigegebenen Version für dieselben Tage | Vertretung für den 03.02. an einer Stunde, die ab 01.02. nicht mehr existiert | Hinweis im Vertretungs-Arbeitsplatz ab Status `freigegeben` („ab 01.02. gilt Version 2.0“), Übertrag beim Veröffentlichen, Konfliktliste; Wochenblick zeigt Versionsgrenze |
| R3 | **`origin_lesson_id` reißt** (Live-Stunde wird während des Entwurfs durch Sofort-Korrektur gesplittet) | Diff meldet „neu/entfallen“ statt „geändert“ | Sofort-Korrektur trägt `successor_id` in `plan_changes`; `planDiff()` folgt der Kette; Fahrplan Schritt 7 zeigt „seit Entwurfsbeginn 3 Live-Änderungen“. **Gelöst mit SP3-05:** die Korrektur zieht offene Entwürfe direkt nach (Herkunft → Nachfolgerin, unverändert übernommene Stunden übernehmen den Inhalt, §3.1) – `planDiff()` braucht keine Kette; die Diff-Seite nennt die Zahl seit Anlage des Entwurfs (Fahrplan-Anzeige SP3-06) |
| R4 | **Lesson-id-Wechsel** bleibt bei geänderten Stunden unvermeidbar; Klassenbuch hat keine Rückfallsuche | Alt-Einträge „ohne Stunde“ | nur geänderte Stunden wechseln die id (Diff); Einträge mit `date < Stichtag` bleiben an der alten Zeile (die endet, wird nicht gelöscht); kleine Folgeaufgabe: Klassenbuch-Rückfall über (Gruppe, Datum, Stunde) |
| R5 | **Generische Tabellen in Drizzle** (`lessonTable(source)`) – Typen von zwei `pgTable`-Definitionen sind nicht identisch | Typ-Verrenkungen, Duplikate | gemeinsame Spaltenfabrik `lessonColumns()`, Lader liefern eine gemeinsame Zeilenform (`PlanLessonRow`); Schreiber verzweigen explizit (zwei kleine Funktionen statt generischem SQL) |
| R6 | **Umfang SP3-02/04** (je L) überschreitet einen Agentenlauf | halbe PRs | Zuschnitt: SP3-02 ohne Variantenvergleich (→ SP3-06), SP3-04 ohne Druck-Datumswähler (→ SP2-10-Nachzug), wenn nötig |
| R7 | **Migrationsnummern** parallel zu SP2-12 (0105) und laufenden Bücherei-Paketen | Konflikt beim Merge | Nummer erst direkt vor dem PR auf aktuellem `main`; Daten-Migration „Bestand 1.0“ idempotent |
| R8 | **Reihenfolge**: SP3 kommt nach VT – ein Halbjahreswechsel vor GATE SP3 läuft noch ohne Fahrplan | Planung wie heute (Periode kopieren, Solver-Übernahme) | „Entwurf aus gültigem Plan“ (SP3-01) + Setzhilfe ohne Fahrplan als Zwischenlösung |
| R9 | **Datenschutz**: Entwürfe und Historien enthalten Lehrkraft-ids in JSON (`undo`, `before/after`) | Kontolöschung unvollständig (wie Q-SP-9-4) | Scrub-Muster DS-21 von Anfang an, Querschnittstest in SP3-01/VT-01 |
| R10 | **Lehrkräfte-Vorschau** zeigt Entwürfe, die sich noch ändern | Unruhe im Kollegium, „mein Plan war anders“ | Schalter je Version (Vorgabe aus), Banner „Entwurf – kann sich ändern“, Kommentare statt Mail; Veröffentlichung schickt den Diff |
| R11 | **Gong-Flut** bei Veröffentlichung und Sendewarteschlange | viele Nachrichten, Ruhezeit verletzt | eine gebündelte Nachricht je Person (bestehendes Muster), Queue hält Ruhezeit auch für Plan-Diffs |
| R12 | **Vorschlagsfilter „nur Fach-Lehrkräfte“** ohne gepflegte Lehrfächer | leere Vorschlagslisten | Fahrplan Schritt 2 zählt Lehrkräfte ohne Lehrfach; „alle anzeigen“ immer erreichbar; Vorbelegung der Lehrfächer aus den Lehraufträgen des Vorjahrs (SP2-12 prüfen) |
| R13 | **`class_map` fehlt für alte Übergänge** | Vorjahres-Übernahme ohne Kontinuität im ersten Jahr | Rekonstruktion per `promotedName()`-Regel, sonst Vorschlag nach Fach ohne Kontinuität |
| R14 | **Monitor/Druck-Caches** zeigen interne Hinweise, wenn ein Pfad vergessen wird | Datenschutzvorfall | Querschnittstest (a) in VT-01, nicht erst in VT-02 |

---

## 9. Prüfliste GATE VT / GATE SP3

**Stand: GATE VT erledigt (VT-05), GATE SP3 erledigt (SP3-08, Belege je Punkt; Review-PR wartet auf die Projektleitung).** Ein Punkt ist erst abgehakt, wenn sein Test existiert und grün läuft. Das Gesamtszenario für GATE SP3 ist `e2e/zx-gate-sp3.spec.ts` (Fahrplan „Neues Halbjahr“ → Matrix → Setzen im Entwurf → Warnungen quittieren → Vorschau Lehrkraft → Freigabe → Veröffentlichen → Vertretung zieht um → Folgeversion → Zurücknehmen → „Plan am Tag X“; axe hell/dunkel, 360 px).

**Entscheidungen der Projektleitung vom 2026-10-28 (bei der Abnahme der Pakete, gelten für die Punkte unten):**
(a) **VT-04:** Änderungen für *heute* gehen sofort an alle, auch an Lernende und Eltern (außerhalb der Ruhezeit); nur Änderungen für spätere Tage werden gebündelt zur eingestellten Zeit gesendet (F-10-11 präzisiert). (b) **SP3-03:** Die Auskunft nach Art. 15 enthält keine Kommentare der Schulleitung/Prüfung *über* eine Lehrkraft (Entwurf ohne Außenwirkung); eigene Kommentare erscheinen mit Text. Das gilt seit SP3-06 auch für Quittierungen und Prüfnotizen im Fahrplan. (c) **SP3-04:** Beim Veröffentlichen werden Varianten derselben Nummer verworfen (Abweichung von §2.5 „die anderen bleiben stehen“, dort angepasst); bei der Rücknahme sind sie wieder offen.

- [x] **SP3-01** Kein Leser außerhalb `src/modules/stundenplan` liest `timetable_draft_lessons`; `timetable_lessons`-Leser unverändert (Grep-Test) – Belege: `planversionen.test.ts` „Querschnitt: kein fremder Leser des Entwurfs“ (außerhalb nur die Auskunft, die sie auslässt; im Modul nur Schema, Manifest, Planquelle, Versionen; keine Seite; `timetable_lessons`-Leser ohne Planquelle), „Entwurf aus dem gültigen Plan …“ (gültiger Plan und Regelplan unverändert), `planversionen.migration.test.ts`; **SP3-02:** Querschnitt „nur die Planung arbeitet mit der Planquelle“ (`planversionen.test.ts`), `entwurf.test.ts` (gültiger Plan Zeile für Zeile unverändert); **GATE SP3:** `zx-gate-sp3.spec.ts` (nach dem Setzen im Entwurf ist der gültige Plan der Lehrkraft bis zum Veröffentlichen unverändert)
- [x] **GATE VT** Schülersicht/Eltern-Gong/Monitor/Druck ohne `internal_note` und Abwesenheitsgrund – Belege: `vertretung-infos.test.ts` „Querschnitt: interner Hinweis nie im Vertretungsplan, Schüler-/Lehrkraftplan, Monitor oder Gong“ und „Querschnitt (GATE VT): Grund und Notiz der Abwesenheit …“, Grep-Test „nur erlaubte Dateien lesen …“ (Druck/Exporte lesen die Felder nicht), `vertretung-gong.test.ts` „GATE-031 S-05“ (Eltern ohne Hinweis), `e2e/zx-gate-vt.spec.ts` (Schülerin, Gong, Monitor); **SP3-03:** `planpruefung.test.ts` „Querschnitt: Kommentare, Vorschau und Entwurfsstunden nie außerhalb der Planung“ (Kommentare nur im Modul, Prüf-Services nur auf Planungsseiten und der Vorschau), `e2e/planung-freigabe.spec.ts` (Schülerin: Vorschau 404); **GATE SP3:** `zx-gate-sp3.spec.ts` (Gesamtdurchlauf: die Schülerin bekommt für die Vorschau 404, die Lehrkraft sieht nur den eigenen Plan ohne fremde Kürzel)
- [x] Veröffentlichen: unveränderte Stunden behalten ihre id; Klassenbuch-Einträge vor und nach dem Stichtag bleiben zugeordnet; Vertretungen/Material ziehen um oder werden gezählt – **SP3-04 Belege:** `veroeffentlichen.test.ts` „Vorschau, Veröffentlichen, Übertrag, Archiv, Gong und Zurücknehmen“ (unveränderte Zeilen Feld für Feld gleich, Klassenbuch vor dem Stichtag an der alten, danach an der neuen Zeile bzw. ohne Bezug, Vertretungen inkl. Kopplung/A-B-Woche/Verlegung/Zusammenlegung und Material ohne Abwesenheit umgezogen oder gezählt), `plan-uebertrag.test.ts` (Tabellen-Tests `transferPlan`/`transferRefs` auf dem Demo-Plan), `e2e/planung-veroeffentlichen.spec.ts` (Entfall zieht mit); **SP3-05 (Sofort-Korrektur):** `sofortkorrektur.test.ts` „Split ab dem nächsten Schultag …“ (Klassenbuch, Vertretung und Material vor dem Stichtag an der alten, danach an der neuen Stunde), „anderer Tag …“ (Vertretung entfällt mit Verlauf, Klassenbuch ohne Bezug), `laufzeit.test.ts` (Halbjahres-Vorlage → Veröffentlichen), `e2e/planung-laufzeit.spec.ts`; **GATE SP3:** `zx-gate-sp3.spec.ts` (Entfall der geänderten Stunde zieht beim Veröffentlichen mit: „1 zieht um“ in der Vorschau, „Aufheben“ an der neuen Stunde)
- [x] Zurücknehmen bis Stichtag stellt Stunden, Vertretungen und Material wieder her (SP-13-Niveau) – **SP3-04 Belege:** `veroeffentlichen.test.ts` (gültiger Plan Zeile für Zeile, Vertretungen, Material und Klassenbuch wie vorher; Konfliktzählung; ab dem Stichtag gesperrt, Nachtjob leert `undo`), `e2e/planung-veroeffentlichen.spec.ts`, `e2e/solver-uebernahme.spec.ts`; **GATE SP3:** `zx-gate-sp3.spec.ts` (Plan der Lehrkraft nach der Rücknahme wie vorher, Entfall wieder an der alten Stunde, Gong „zurückgenommen“)
- [x] Nur eine Version `gueltig` je Tag; Varianten veröffentlichbar genau eine – **SP3-04 Belege:** `veroeffentlichen.test.ts` (Vorgängerin archiviert bis zum Vortag, zweite Version ab demselben Stichtag abgelehnt, Zeitstrahl und „Plan am Tag X“, Variante derselben Nummer verworfen und bei der Rücknahme wieder offen; Entscheidung (c)); **GATE SP3:** `zx-gate-sp3.spec.ts` (Zeitstrahl „1.0 … – Vortag“ und „Neue Version ab Stichtag – offen“, „Plan am Tag X“ vor dem Stichtag alter, danach neuer Plan inkl. Druck)
- [x] **SP3-03** Freigabe nur mit `stundenplan.review`; 2FA-Pflicht; Lehrkräfte-Vorschau nur eigener Plan – Belege: `planpruefung.test.ts` „Statuswege …“, „ohne Vier-Augen-Zwang …“, „Lehrkräfte-Vorschau …“ (nur Stunden mit eigener Kennung, keine Kennungen anderer), „Recht `stundenplan.review` …“ (2FA), `permissions.test.ts` „SP3-03 …“, `planpruefung.migration.test.ts`, `e2e/planung-freigabe.spec.ts`; **GATE SP3:** `zx-gate-sp3.spec.ts` (Freigabe durch die Schulleitung `petra.lindner`)
- [x] **GATE VT** Kontolöschung bereinigt `substitution_changes` – Belege: `vertretung-infos.test.ts` „Kontolöschung ersetzt die Vertretungslehrkraft in der Historie …“, `loeschlauf-konto.test.ts` (DS-21-Muster), `benachrichtigung.test.ts` „Kontolöschung nimmt die Einträge der Person mit“ (Warteschlange); **SP3-04:** `veroeffentlichen.test.ts` „… Kontolöschung ersetzt Lehrkraft-Kennungen darin“ (`undo`/`notify` der Planversionen). **SP3-05:** `sofortkorrektur.test.ts` „Kontolöschung ersetzt die Lehrkraft in Vorher/Nachher des Protokolls“ (`scrubPlanChanges` in `deleteAccounts`). **SP3-06:** `fahrplan.test.ts` „Kontolöschung: Quittierungen und Häkchen verlieren die Kennung …“ (Checkliste/Quittierungen, `scrubPlanVersions`). **Gesamtdurchlauf SP3-08:** die Bereinigung ist in diesen Tests an allen Stellen mit Lehrkraft-Kennungen belegt (Historie, Warteschlange, `undo`/`notify`, Protokoll, Checkliste); `zx-gate-sp3.spec.ts` erzeugt sie im Durchlauf ohne Konsolenfehler
- [x] **GATE VT** Sendewarteschlange: Ruhezeit, Endstand, genau ein Versand je Tag und Zielgruppe, zwei Instanzen senden nicht doppelt – Belege: `sendezeit.test.ts` (Zeitlogik, Ruhezeit, Sommerzeit), `benachrichtigung.test.ts` „morgen: eingereiht für den Vortag 18:00, gesendet wird nur der Endstand …, genau einmal“, „nach der Vortags-Uhrzeit sofort; in der Ruhezeit wartet die Nachricht …“, „zwei Takte gleichzeitig (zwei App-Prozesse) senden nicht doppelt“, `e2e/vertretung-benachrichtigung.spec.ts`, `e2e/zx-gate-vt.spec.ts`; Entscheidung (a): heutige Änderungen gehen sofort an alle
- [x] Benchmark/Solver-Kern durch die SP3-Pakete unverändert (dieselbe Lösung wie der jeweils gültige Benchmark-Stand; neue Stände nur durch SQ-01…03) – **SP3-02:** `solver.ts` unverändert, `solver.benchmark.test.ts` grün (gleiche Lösung), Solver-Eingabe für den gültigen Plan unverändert (Vorgabe `source`), `entwurf.test.ts` (Lauf im Entwurf); **GATE SP3:** SP3-03 … SP3-08 berühren `solver.ts` nicht (Diff dieses Blocks: nur SQ-01…03 ändern den Kern, mit eigener Benchmark-Messung), `solver.benchmark.test.ts` läuft grün in `npm run check`
- [x] Fahrplan: jeder Schritt-Status aus Demo-Daten nachvollziehbar; Warnung ohne Quittierung blockiert Schritt 8 – **SP3-06 Belege:** `fahrplan.test.ts` (jeder Schritt rot aus seinen Daten, Lader auf der Demo, „Veröffentlichen scheitert an Schritt 7“, Zurücknehmen einer Quittierung sperrt wieder), Gegentest (Sperre in `publishVersion` ausgeschaltet → Test rot), E2E `planung-fahrplan.spec.ts`; **SP3-07:** `neues-schuljahr.test.ts` (Vorlage „Neues Schuljahr“ und ihre Schritte aus den Daten); **SP3-08:** Versionsliste und Fahrplan setzen für „Neues Schuljahr“ denselben Vorlagen-Vermerk (`neues-schuljahr.test.ts`, Gegentest ohne Vermerk rot), sodass Schritt 3 des Fahrplans die Versetzung prüft; `zx-gate-sp3.spec.ts` (Fahrplan führt durch acht Schritte, Quittieren in Schritt 7 vor Freigabe/Veröffentlichen, Ampeln)
- [x] Doku: STUNDENPLAN.md, DATENSCHUTZ §3.4, SICHERHEIT S8x, DSB-FRAGEN §13-Hinweis, Release-Notes – **VT-Teil:** `STUNDENPLAN.md` §0 „Vertretung als Arbeitsplatz“, `DATENSCHUTZ.md` §3.4 (VT-01, VT-04) und DSB-Checkliste Thema 13, `SICHERHEIT.md` S85, Release-Notes `release/notes/0.10.0.json`. **SP3-Teil:** `STUNDENPLAN.md` (Planen in acht Schritten, Versionen, Veröffentlichen, Schuljahresabschluss), `DATENSCHUTZ.md` §3.4 (Versionen, Entwurfsstunden, Protokoll, Checkliste), `SICHERHEIT.md` S86 (SP3-01…04), **S87** (SP3-05 … SP3-07: Sofort-Korrektur, Protokoll, Quittierungen, Schuljahresabschluss), Release-Notes-Entwurf `release/notes/0.11.0.json` (Version und Tag erst im Release-PR)

**Offene Fragen an die Projektleitung (nicht Teil der Prüfliste):**
1. ~~**Planungsjahr:** Stundenplan, Unterrichtsverteilung, Matrix und Solver arbeiten nur im *aktuellen* Schuljahr (`planningYear`, ~86 Stellen). … Backlog-Kandidat „Planen im Folgejahr“ – Entscheidung, ob und wann.~~ **Entschieden 2026-10-28 (Projektleitung): freigegeben, „asap umsetzen“** – SP3-09a (Jahreswahl, Verteilung/Matrix/Deputate/Pflege im Entwurf) umgesetzt, §3.1 „Umgesetzt (SP3-09a)“; SP3-09b (Solver, Zeitwünsche, Diagnose/Fahrplan im Folgejahr, E2E-Gesamtszenario) offen.
2. **Release v0.11.0** mit dem Notizen-Entwurf; vorab `/code-review ultra` auf den Block?

---

## 10. Bewusst nicht in SP3/VT

Versionierte Lehraufträge/Zeitwünsche (F-10-5), Mehrarbeits-Abrechnung aus der Historie, Import/Export fremder Formate, Web-Push (Queue
ist vorbereitet, DSB-Votum offen), ICS-Abo des eigenen Plans (SP-G-21, passt später an „Plan am Tag X“), Oberstufen-Blockung, Solver-
Warmstart aus dem Entwurf (jetzt eigener Block SQ im BACKLOG, Projektleitung 2026-10-27 – umgesetzt mit SQ-02: „ab aktuellem Entwurf verbessern“,
docs/STUNDENPLAN.md), Personalrats-Schritt (Entscheidung Projektleitung 25.10.),
große Sperrzeiten-Erfassung (nur die bestehenden Zeitwünsche + Raumsperren), Lehrkräfte-Kommentare untereinander.

---

## 11. Fragebogen Runde 10 (Entscheidungen der Projektleitung)

**Entschieden 2026-10-26 (Projektleitung): alle Empfehlungen angenommen** (F-10-1 … F-10-14). Die Alternativen bleiben zur
Nachvollziehbarkeit stehen.

Nur echte Entscheidungen; alles andere gilt wie oben beschrieben als Vorgabe. Antwortformat wie bisher („wie vorgeschlagen“ oder Abweichung).

- [x] **F-10-1 (SP3-02/04) – Direkte Solver-Übernahme in den gültigen Plan abschaffen?** Heute schreibt „Lauf übernehmen ab Stichtag“ sofort
  live. Mit Versionen gäbe es zwei Wege (Lauf → live, Entwurf → live) mit doppelter Rücknahme-Logik. **Empfehlung: ja, nur noch über den
  Entwurf** – „Übernehmen“ füllt den Entwurf der Version und springt zu Fahrplan-Schritt 8; wer wie heute direkt veröffentlichen will,
  klickt dort „Veröffentlichen ab …“ (zwei Klicks statt einem). Alternative: beide Wege behalten (mehr Code, zwei `undo`-Pfade).
- [x] **F-10-2 (SP3-05) – Sofort-Korrekturen am gültigen Plan weiter erlauben?** **Empfehlung: ja für `manage`**, aber immer als Split ab
  dem nächsten Schultag mit Protokoll (`timetable_plan_changes`) und Gong an betroffene Lehrkraft/Gruppe; ab 10 geänderten Stunden Hinweis
  „besser als Folgeversion“. Alternative: jede Änderung nur als Folgeversion mit Freigabe (sauberer, im Alltag zu schwerfällig – Raumtausch
  am Montagmorgen).
- [x] **F-10-3 (SP3-03) – Freigabe durch die Schulleitung: Recht `stundenplan.review` für die Gruppe Schulleitung; darf eine Person mit
  `manage` + `review` den eigenen Entwurf freigeben?** **Empfehlung: ja** (kleine Schulen, Schulleitung plant selbst), Audit zeigt es, kein
  technischer Vier-Augen-Zwang; Folgeversionen (1.x) brauchen **auch** die Freigabe (sonst wäre der Weg um die Freigabe herum offen).
  Alternative: Vier-Augen erzwingen (Freigabe nur durch eine andere Person) und/oder Folgeversionen ohne Freigabe.
- [x] **F-10-4 (SP3-03/04) – Lehrkräfte-Vorschau „Mein Plan ab …“ und Änderungsliste an Schüler:innen/Eltern?** **Empfehlung:** Vorschau als
  Schalter je Version (Vorgabe aus), nur eigener Plan, Rückmeldung als Kommentar an die Planung; bei der Veröffentlichung Gong mit
  persönlichem Diff an Lehrkräfte **sofort**, an Schüler:innen (und Eltern bis Jahrgang wie Vertretungen) **zum Stichtag − 1 um die
  Vortags-Uhrzeit** über die Sendewarteschlange (VT-04). Alternative: Schüler:innen/Eltern gar nicht benachrichtigen (Plan ist ohnehin sichtbar).
- [x] **F-10-5 (SP3-01) – Lehraufträge, Zeitwünsche, Bänder und Deputate bleiben unversioniert; Varianten unterscheiden sich nur in der
  Setzung?** **Empfehlung: ja** (hält SP3-01/02 beherrschbar; „Was-wäre-wenn“ in der Verteilung läuft nacheinander oder über Gültigkeit).
  Alternative: Verteilung je Version kopieren (verdoppelt Datenmodell und Matrix-Logik).
- [x] **F-10-6 (SP3-DEP) – Deputatsmodell:** Teilzeit als Anteil in Prozent (Rechenhilfe: Pflicht = Vorgabe × Anteil, gespeichert bleibt die
  Pflichtstundenzahl), Pflicht fürs 2. Halbjahr getrennt, Anrechnungen mit „gültig ab/bis“? **Empfehlung: alle drei, minimal** (keine
  Faktoren/Wertrechnung, keine Mehrarbeitsabrechnung). Alternative: nur Anrechnungen mit Gültigkeit.
- [x] **F-10-7 (SP3-LA) – Übernahme aus dem Vorjahr: Klassen-Zuordnung (`class_map`) im Schuljahreswechsel speichern, „Lehrkraft folgt der
  Klasse“ als Vorschlag je Zelle; Kurse und Bänder werden nicht übernommen?** **Empfehlung: ja**; für Übergänge vor SP3-LA Rekonstruktion
  über die Namensregel, sonst Vorschlag nur nach Fach. Alternative: Übernahme nur „gleicher Jahrgang, gleiches Fach, gleiche Lehrkraft“ ohne
  Hochstufung (einfacher, trifft Kontinuität nicht).
- [x] **F-10-8 (VT-01/02) – Öffentlicher Grund als grobe Kategorie für Schüler:innen und Monitor sichtbar?** **Empfehlung: ja**, Liste in
  §3.2; bei Lehrkraft-Abwesenheit immer „Lehrkraft abwesend“ (nie krank/Fortbildung/dienstlich unterscheidbar); Gruppengründe wie heute;
  Eltern-Gong nennt die Kategorie ebenfalls. Alternative: Kategorie nur intern (dann entfällt der Nutzen für Schüler:innen – „warum fällt
  aus?“ bleibt unbeantwortet).
- [x] **F-10-9 (VT-01) – Art „Betreuung/EVA“?** **Empfehlung: ja, als Häkchen „nur Betreuung“ an `substitute`** (Anzeige „Betreuung“, eigener
  Zähler in der Statistik, zählt im Deputat der Vertretungslehrkraft wie Vertretung) statt neuer `kind`. Alternative: weglassen, Hinweis im
  Freitext.
- [x] **F-10-10 (VT-02) – Kenntnisnahme durch die Vertretungslehrkraft: Pflicht oder optional?** **Empfehlung: optional, Vorgabe an**
  (Lehrkraft bestätigt mit einem Klick im Gong/„Meine Vertretungen“, Planung sieht Unbestätigte, Erinnerung mit dem Vortags-Gong, keine
  Eskalation an die Schulleitung). Alternative: Pflicht mit Eskalation.
- [x] **F-10-11 (VT-04) – Sendezeiten:** Vortags-Uhrzeit 18:00, Ruhezeit 20:00–06:30, heute sofort (vor Stundenbeginn), getrennte
  Einstellungen für Lehrkräfte und Lernende/Eltern (Vorgabe gleich); die Plananzeige ist sofort sichtbar, nur der Gong wartet.
  **Empfehlung: so.** Alternative: eine Einstellung für alle; oder auch die Anzeige bis zur Sendezeit zurückhalten (widerspricht „Plan
  veröffentlichen“ je Tag).
- [x] **F-10-12 (VT-01) – Material/Aufgaben ohne Abwesenheit: anlegen dürfen Lehrkraft der Stunde, Vertretungslehrkraft und Planung
  (`substitute`); Löschklasse LK-SJ-1J ab Datum statt „folgt der Abwesenheit“?** **Empfehlung: ja.** Alternative: nur Lehrkraft der Stunde.
- [x] **F-10-13 (VT-01/SP3-05) – Historien (`substitution_changes`, `plan_changes`) mit Vorher/Nachher als JSON, LK-SJ-1J, Lehrkraft-ids bei
  Kontolöschung ersetzt; sichtbar nur für die Planung?** **Empfehlung: ja** (ohne Historie gibt es keinen „neu/geändert“-Marker).
  Alternative: nur `updated_at` ohne Vorher-Stand (Marker möglich, Verlauf nicht).
- [x] **F-10-14 (Reihenfolge nach v0.9.0, ersetzt F2):** **Empfehlung:** SP3-DEP + SP3-LA → Block VT (Release v0.10) → Block SP3 (Release
  v0.11). Alternative: SP3-01…04 vor VT, wenn Versionen früher gebraucht werden.
