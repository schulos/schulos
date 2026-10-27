# SP3-00: Lebenszyklus des Stundenplans und Vertretung mit mehr Infos – Architekturkonzept

> Stand: 2026-10-26 · Status: **abgenommen** (Projektleitung 2026-10-26: Fragebogen Runde 10 in §11, alle Empfehlungen angenommen) · Auftrag der Projektleitung 25.10.2026
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

### 2.5 Varianten

- „Variante anlegen“ dupliziert den Entwurf (`variant_of`, gleiche `origin_lesson_id`s) – Standard bleibt ein Entwurf.
- Vergleich in Schritt 7: Kennzahlen je Version (Hohlstunden L/K, Randstunden, erfüllte Wünsche %, Raumauslastung, Diagnose-Zähler) in
  der Tabelle des Solver-Vergleichs (`solververgleich.ts` bekommt eine zweite Quelle „Version“), dazu Vorschau Klasse/Lehrkraft nebeneinander.
- **Lehraufträge, Zeitwünsche, Bänder, Deputate sind nicht versioniert** (Frage F-10-5): Varianten unterscheiden sich in der Setzung.
  „Was-wäre-wenn“ in der Unterrichtsverteilung läuft über die Lehrauftrags-Gültigkeit oder nacheinander.
- Veröffentlichen einer Variante lässt die anderen stehen (Hinweis), Verwerfen ist ein Klick; nach Schuljahresende verwirft der Nachtjob
  offene Entwürfe des Vorjahrs (Löschklasse).

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

**`timetable_notification_queue`** (VT-04): `id` · `date` (Vertretungstag) · `audience` (`lehrkraefte`, `lernende`) · `due_at` ·
`sent_at` · `recipients int` · `created_at`; Unique `(date, audience, sent_at is null)` (partiell). Beim Senden wird die Nachricht aus
dem **aktuellen** Stand gebaut (`dayMessage`) → immer Endstand, nie Zwischenstände. Minutentakt-Job mit `runExclusive("vertretung-gong")`
(wie `startMailOutbox`), B-52-fest. Einstellungen (Moduleinstellungen, VT-04): `stundenplan.notify_eve_time` (18:00),
`stundenplan.quiet_from`/`quiet_until` (20:00/06:30), `stundenplan.notify_students_separately` (an/aus). Regeln: heute → sofort (nur vor
Stundenbeginn, sonst nur Lehrkräfte); morgen → zur Vortags-Uhrzeit, nach der Uhrzeit sofort, in der Ruhezeit → Ende der Ruhezeit;
weiter voraus → am Vortag. Veröffentlichen eines Entwurfstags reiht ein statt zu senden; „jetzt senden“ je Eintrag. Web-Push kann später
an die Queue andocken (DSB-Votum offen).

### 3.3 Migrationsfolge (Vorschlag, Nummern endgültig beim PR)

| # | Paket | Inhalt |
|---|---|---|
| 0106 | VT-01 | `substitution_reason`, Spalten an `timetable_substitutions`, `timetable_substitution_changes`, `timetable_absence_materials.absence_id` nullable + neuer Unique, `timetable_day_notes` |
| 0107 | VT-04 | `timetable_notification_queue` |
| 0107 ✅ | SP3-DEP | `employment_percent`, `obligation_term2`, `obligation` nullable, `timetable_reductions.valid_from/valid_until` (tatsächlich 0107, vor VT-01) |
| 0108 ✅ | SP3-LA | `school_year_transitions.class_map` (tatsächlich 0108; nur die Spalte – Übergänge ohne Zuordnung rekonstruiert die Übernahme zur Laufzeit per Namensregel `promotedName()`, soweit eindeutig) |
| 0110 | SP3-01 | `plan_version_status`, `plan_version_source`, `timetable_plan_versions`, `timetable_draft_lessons`, `timetable_lessons.plan_version_id`, Daten-Migration „Bestand 1.0“ |
| 0111 | SP3-03 | Recht `stundenplan.review` (Grant an `g-schulleitung`, `grants.synced`), `timetable_plan_comments` |
| 0112 | SP3-05 | `timetable_plan_changes` |
| – | SP3-02/04/06/07/08, VT-02/03/05 | ohne Migration (SP3-06 nutzt `checklist jsonb`; SP3-07 nutzt `class_map`) |

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
| R3 | **`origin_lesson_id` reißt** (Live-Stunde wird während des Entwurfs durch Sofort-Korrektur gesplittet) | Diff meldet „neu/entfallen“ statt „geändert“ | Sofort-Korrektur trägt `successor_id` in `plan_changes`; `planDiff()` folgt der Kette; Fahrplan Schritt 7 zeigt „seit Entwurfsbeginn 3 Live-Änderungen“ |
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

## 9. Prüfliste GATE VT / GATE SP3 (Entwurf)

- [ ] Kein Leser außerhalb `src/modules/stundenplan` liest `timetable_draft_lessons`; `timetable_lessons`-Leser unverändert (Grep-Test)
- [ ] Schülersicht/Eltern-Gong/Monitor/Druck ohne `internal_note`, Abwesenheitsgrund, Kommentare, Entwurfsstunden (Querschnittstest)
- [ ] Veröffentlichen: unveränderte Stunden behalten ihre id; Klassenbuch-Einträge vor und nach dem Stichtag bleiben zugeordnet; Vertretungen/Material ziehen um oder werden gezählt
- [ ] Zurücknehmen bis Stichtag stellt Stunden, Vertretungen und Material wieder her (SP-13-Niveau)
- [ ] Nur eine Version `gueltig` je Tag; Varianten veröffentlichbar genau eine
- [ ] Freigabe nur mit `stundenplan.review`; 2FA-Pflicht; Lehrkräfte-Vorschau nur eigener Plan
- [ ] Kontolöschung bereinigt `undo`, `plan_changes`, `substitution_changes`
- [ ] Sendewarteschlange: Ruhezeit, Endstand, genau ein Versand je Tag und Zielgruppe, zwei Instanzen senden nicht doppelt
- [ ] Benchmark/Solver-Kern unverändert (dieselbe Lösung)
- [ ] Fahrplan: jeder Schritt-Status aus Demo-Daten nachvollziehbar; Warnung ohne Quittierung blockiert Schritt 8
- [ ] Doku: STUNDENPLAN.md, DATENSCHUTZ §3.4, SICHERHEIT S8x, DSB-FRAGEN §13-Hinweis, Release-Notes

---

## 10. Bewusst nicht in SP3/VT

Versionierte Lehraufträge/Zeitwünsche (F-10-5), Mehrarbeits-Abrechnung aus der Historie, Import/Export fremder Formate, Web-Push (Queue
ist vorbereitet, DSB-Votum offen), ICS-Abo des eigenen Plans (SP-G-21, passt später an „Plan am Tag X“), Oberstufen-Blockung, Solver-
Warmstart aus dem Entwurf (Kann: Lauf „ab aktuellem Entwurf verbessern“), Personalrats-Schritt (Entscheidung Projektleitung 25.10.),
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
