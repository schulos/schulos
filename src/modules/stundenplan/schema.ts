// Stundenplan – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, periods, rooms, schoolYears, subjects } from "../../core/db/schema-core";

/** A/B-Wochen: A = ungerade Kalenderwoche (ISO), B = gerade */
export const LESSON_WEEKS = ["all", "A", "B"] as const;
export const lessonWeekEnum = pgEnum("lesson_week", LESSON_WEEKS);

/**
 * SP3-01: gemeinsame Spalten von `timetable_lessons` (gültiger Plan) und `timetable_draft_lessons` (Entwurf einer Planversion) –
 * beide Tabellen haben so dieselbe Zeilenform, und Lader/Prüfungen laufen über `lessonTable(source)` (plan-quelle.ts).
 * Jeder Aufruf erzeugt neue Spalten-Builder (eine Spalte gehört genau einer Tabelle).
 */
function lessonColumns() {
  return {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    /** 0 = Montag … 4 = Freitag */
    weekday: integer("weekday").notNull(),
    periodNr: integer("period_nr")
      .notNull()
      .references(() => periods.nr),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onUpdate: "cascade" }),
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "set null" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    week: lessonWeekEnum("week").notNull().default("all"),
    validFrom: date("valid_from").notNull(),
    /** einschließlich; leer = unbefristet */
    validUntil: date("valid_until"),
    /**
     * Kopplung: Zeilen mit derselben id liegen gemeinsam im selben Slot (Religion/Philosophie, WP, E-/G-Kurse,
     * Teamteaching). Jede Zeile bleibt 1 Gruppe × 1 Lehrkraft × 1 Raum; Kollisionen innerhalb einer Kopplung sind erlaubt.
     */
    couplingId: text("coupling_id"),
    /** fixiert: die automatische Planung (Solver) lässt die Stunde, wo sie ist */
    fixed: boolean("fixed").notNull().default(false),
    /** SP-06: Herkunft – aus welchem Solver-Lauf die Stunde übernommen wurde (fällt mit dem Lauf weg, die Stunde bleibt) */
    solverRunId: text("solver_run_id").references((): AnyPgColumn => timetableSolverRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  };
}

/** Eine regelmäßige Unterrichtsstunde: Gruppe × Wochentag × Stunde, gültig in einem Zeitraum. */
export const timetableLessons = pgTable(
  "timetable_lessons",
  {
    ...lessonColumns(),
    /**
     * SP3-01: Herkunft – mit welcher Planversion die Stunde gültig wurde („Bestand 1.0“ bzw. Veröffentlichung ab SP3-04). Nur für
     * Archiv-Anzeige und Diff; **kein Leser filtert danach** (der gültige Plan bleibt `valid_from`/`valid_until`).
     */
    planVersionId: text("plan_version_id").references((): AnyPgColumn => timetablePlanVersions.id, { onDelete: "set null" }),
  },
  (t) => [
    index("timetable_lessons_coupling_idx").on(t.couplingId),
    index("timetable_lessons_solver_run_idx").on(t.solverRunId),
    check("timetable_lessons_weekday", sql`${t.weekday} between 0 and 4`),
    check("timetable_lessons_valid", sql`${t.validUntil} is null or ${t.validUntil} >= ${t.validFrom}`),
    index("timetable_lessons_group_idx").on(t.groupId, t.weekday),
    index("timetable_lessons_teacher_idx").on(t.teacherId, t.weekday),
    index("timetable_lessons_room_idx").on(t.roomId, t.weekday),
    index("timetable_lessons_plan_version_idx").on(t.planVersionId),
  ],
);

export type TimetableLesson = typeof timetableLessons.$inferSelect;

/** cancel = Entfall · substitute = Vertretung (andere Lehrkraft, ggf. anderer Raum) · room = nur Raumänderung */
/** SP2-07: `move` = Verlegung auf eine andere Stunde desselben Tages, `merge` = Zusammenlegung/Mitbetreuung bei einer anderen Stunde. Neue Arten nur hinten anfügen. */
export const SUBSTITUTION_KINDS = ["cancel", "substitute", "room", "move", "merge"] as const;
export type SubstitutionKind = (typeof SUBSTITUTION_KINDS)[number];
export const substitutionKindEnum = pgEnum("substitution_kind", SUBSTITUTION_KINDS);

/**
 * VT-01 (F-10-8): öffentliche Grund-Kategorie einer Änderung – bewusst grob. Eine Lehrkraft-Abwesenheit heißt immer
 * `lehrkraft_abwesend` (nie krank/Fortbildung/dienstlich unterscheidbar). Neue Kategorien nur hinten anfügen.
 */
export const SUBSTITUTION_REASONS = [
  "lehrkraft_abwesend",
  "klassenfahrt",
  "exkursion",
  "praktikum",
  "pruefung",
  "veranstaltung",
  "raum_gesperrt",
  "organisatorisch",
  "sonstiges",
] as const;
export type SubstitutionReason = (typeof SUBSTITUTION_REASONS)[number];
export const substitutionReasonEnum = pgEnum("substitution_reason", SUBSTITUTION_REASONS);

/** VT-01: höchstens so viele Zeichen im internen Hinweis (nur Planung und Vertretungslehrkraft) und in Tagesmitteilungen */
export const INTERNAL_NOTE_MAX = 300;

/** Abweichung von einer regulären Stunde an einem bestimmten Tag. */
export const timetableSubstitutions = pgTable(
  "timetable_substitutions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => timetableLessons.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    kind: substitutionKindEnum("kind").notNull(),
    substituteId: text("substitute_id").references(() => users.id, { onDelete: "set null" }),
    /** neuer Raum; leer = Raum der regulären Stunde */
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Hinweis für Schüler:innen, z. B. „Arbeitsheft S. 24“ */
    note: text("note"),
    /** SP-12 (Fachtausch): abweichendes Fach der Vertretung („Mathe statt Sport“); leer = Fach der regulären Stunde. Nur bei `substitute`. */
    subjectId: text("subject_id").references(() => subjects.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** SP2-07 (Verlegung): Stunde desselben Tages, in der die Stunde stattdessen liegt; nur bei `move` */
    targetPeriod: integer("target_period"),
    /**
     * SP2-07 (Zusammenlegung): Stunde zur selben Zeit, zu der die Gruppe geht (deren Lehrkraft betreut mit); nur bei `merge`.
     * R1b/A10: wird die aufnehmende Stunde gelöscht, bleibt die Zusammenlegung ohne Ziel stehen („aufgehoben“, Bedarf wieder offen)
     * statt still mitgelöscht zu werden.
     */
    mergeLessonId: text("merge_lesson_id").references((): AnyPgColumn => timetableLessons.id, { onDelete: "set null" }),
    /**
     * SP2-16b: die Abwesenheit, wegen der die Änderung eingetragen wurde, wurde verkürzt oder aufgehoben – die Änderung bleibt
     * stehen, die Vertretungsplanung prüft sie („Abwesenheit beendet – prüfen“). Erneutes Speichern oder „behalten“ leert es.
     */
    absenceEndedAt: timestamp("absence_ended_at", { withTimezone: true }),
    /** VT-01 (F-10-8): öffentliche Grund-Kategorie (Schüler:innen, Eltern, Monitor); leer = ohne Angabe (Bestand vor VT-01) */
    reason: substitutionReasonEnum("reason"),
    /** VT-01: interner Hinweis – nur Planung (`stundenplan.substitute`) und die Vertretungslehrkraft, nie Schüler:innen/Eltern/Monitor */
    internalNote: text("internal_note"),
    /** VT-01 (F-10-9): Vertretung nur als Betreuung (Aufgaben/EVA, kein Fachunterricht); nur bei `substitute` */
    supervisionOnly: boolean("supervision_only").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** VT-01: zuletzt geändert von/am (leer = seit dem Anlegen unverändert); das Anlegen bleibt in `created_*` */
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    /**
     * VT-01 (F-10-10): Kenntnisnahme durch die Vertretungslehrkraft (optional). Wird leer, sobald die Vertretungslehrkraft oder die
     * Art wechselt.
     */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => [
    index("timetable_substitutions_merge_idx").on(t.mergeLessonId),
    uniqueIndex("timetable_substitutions_lesson_date_uq").on(t.lessonId, t.date),
    check("timetable_substitutions_subject", sql`${t.subjectId} is null or ${t.kind} = 'substitute'`),
    check("timetable_substitutions_supervision", sql`not ${t.supervisionOnly} or ${t.kind} = 'substitute'`),
    check("timetable_substitutions_internal_note", sql`${t.internalNote} is null or char_length(${t.internalNote}) <= 300`),
    index("timetable_substitutions_date_idx").on(t.date),
    index("timetable_substitutions_substitute_idx").on(t.substituteId, t.date),
  ],
);

export type TimetableSubstitution = typeof timetableSubstitutions.$inferSelect;

/** VT-01: Art eines Historien-Eintrags. `plan_publish`/`plan_undo` = Übernahme bzw. Rücknahme eines Plans (Solver, später SP3-04). */
export const SUBSTITUTION_CHANGE_ACTIONS = ["create", "update", "delete", "plan_publish", "plan_undo"] as const;
export type SubstitutionChangeAction = (typeof SUBSTITUTION_CHANGE_ACTIONS)[number];
export const substitutionChangeActionEnum = pgEnum("substitution_change_action", SUBSTITUTION_CHANGE_ACTIONS);

/**
 * VT-01 (F-10-13): Historie der Vertretungen – je Schreibvorgang Vorher/Nachher als JSON (Felder der Vertretung mit Kennungen,
 * `SubstitutionSnapshot`). Nur für die Planung sichtbar; speist später den Marker „neu/geändert seit …“ (VT-02). Die Kennung der
 * Vertretungslehrkraft in `before/after` ersetzt die Kontolöschung durch einen Platzhalter (`scrubSubstitutionChanges`).
 */
export const timetableSubstitutionChanges = pgTable(
  "timetable_substitution_changes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    lessonId: text("lesson_id").references(() => timetableLessons.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    substitutionId: text("substitution_id").references(() => timetableSubstitutions.id, { onDelete: "set null" }),
    action: substitutionChangeActionEnum("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("timetable_substitution_changes_date_idx").on(t.date, t.createdAt),
    index("timetable_substitution_changes_lesson_idx").on(t.lessonId, t.date),
    index("timetable_substitution_changes_substitution_idx").on(t.substitutionId),
  ],
);

export type TimetableSubstitutionChange = typeof timetableSubstitutionChanges.$inferSelect;

/** VT-01: Tagesmitteilung an alle bzw. nur an Beschäftigte */
export const DAY_NOTE_AUDIENCES = ["alle", "beschaeftigte"] as const;
export type DayNoteAudience = (typeof DAY_NOTE_AUDIENCES)[number];
export const dayNoteAudienceEnum = pgEnum("day_note_audience", DAY_NOTE_AUDIENCES);

/**
 * VT-01: Tagesmitteilung im Vertretungsplan („Heute 6. Stunde Schulversammlung in der Aula“) – kurzer Text ohne Personen. Folgt der
 * Tagesfreigabe: an einem Entwurfstag nur für die Planung sichtbar.
 */
export const timetableDayNotes = pgTable(
  "timetable_day_notes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: date("date").notNull(),
    body: text("body").notNull(),
    audience: dayNoteAudienceEnum("audience").notNull().default("alle"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("timetable_day_notes_date_idx").on(t.date), check("timetable_day_notes_body", sql`char_length(${t.body}) between 1 and 300`)],
);

export type TimetableDayNote = typeof timetableDayNotes.$inferSelect;

/**
 * SP2-01: Band – Lehraufträge, die zur selben Zeit liegen (Religion/Philosophie, WP, E-/G-Kurse, Oberstufen-Schiene, eine
 * Lehrkraft für mehrere Gruppen). Wochen- und Doppelstunden gelten für alle Mitglieder (die Lehraufträge übernehmen sie).
 * Die Mitglieder sind die Lehraufträge mit `band_id`; jeder bleibt 1 Fach, 1 Gruppe, 1–2 Lehrkräfte.
 */
export const timetableBands = pgTable(
  "timetable_bands",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    /** z. B. „Religion/Philosophie 7“, „Q1 GK-Schiene A“ – keine Personen nennen */
    name: text("name").notNull(),
    /** Wochenstunden (Soll) aller Mitglieder */
    hours: integer("hours").notNull(),
    /** gewünschte Doppelstunden je Woche */
    doubleLessons: integer("double_lessons").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_bands_hours", sql`${t.hours} between 1 and 12`),
    check("timetable_bands_double", sql`${t.doubleLessons} >= 0 and ${t.doubleLessons} * 2 <= ${t.hours}`),
    uniqueIndex("timetable_bands_name_uq").on(t.schoolYearId, t.name),
  ],
);

/**
 * SP2-03 (SP-G-04b): Tagesgrenzen und Ganztag je Jahrgangsstufe – gelten für die Klassen des Jahrgangs (Kurse des Jahrgangs zählen mit),
 * hart im Solver und in der Setzhilfe, geprüft in der Diagnose. `null` = keine Grenze. Ohne Personenbezug, gilt über Schuljahre hinweg.
 */
export const timetableGradeRules = pgTable(
  "timetable_grade_rules",
  {
    gradeLevel: integer("grade_level").primaryKey(),
    /** höchstens so viele belegte Stunden am Tag */
    maxPerDay: integer("max_per_day"),
    /** höchstens so viele Tage mit Unterricht nach der Mittagspause */
    afternoonsPerWeek: integer("afternoons_per_week"),
    /** Mittag nach dieser Stunde: ohne lange Pause im Zeitraster bleibt die nächste Stunde frei, wenn danach Unterricht liegt */
    lunchAfterPeriod: integer("lunch_after_period"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_grade_rules_max", sql`${t.maxPerDay} is null or ${t.maxPerDay} between 1 and 20`),
    check("timetable_grade_rules_pm", sql`${t.afternoonsPerWeek} is null or ${t.afternoonsPerWeek} between 0 and 7`),
    check("timetable_grade_rules_lunch", sql`${t.lunchAfterPeriod} is null or ${t.lunchAfterPeriod} between 1 and 20`),
  ],
);

export type TimetableBand = typeof timetableBands.$inferSelect;

/**
 * Lehrauftrag (Unterrichtsverteilung): „7b, Deutsch, 4 Wochenstunden, BRA“ – Planungsauftrag vor dem Stundenplan.
 * Eine Gruppe, ein Fach, 1–2 Lehrkräfte (Teamteaching); was zur selben Zeit liegen soll, bündelt ein Band (SP2-01).
 */
export const timetableAssignments = pgTable(
  "timetable_assignments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onUpdate: "cascade" }),
    /** Wochenstunden (Soll) */
    hours: integer("hours").notNull(),
    /** gewünschte Doppelstunden je Woche */
    doubleLessons: integer("double_lessons").notNull().default(0),
    /** Raumwunsch; leer = Stammraum bzw. Raumwunsch des Fachs */
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    note: text("note"),
    /** SP2-01: Band, in dem der Lehrauftrag liegt (Wochen-/Doppelstunden kommen dann vom Band); leer = eigenständig */
    bandId: text("band_id").references(() => timetableBands.id, { onDelete: "set null" }),
    /** SP2-09 (SP-G-07): gültig ab/bis (Halbjahr, Epoche); leer = Beginn bzw. Ende des Schuljahrs */
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_assignments_hours", sql`${t.hours} between 1 and 12`),
    check("timetable_assignments_double", sql`${t.doubleLessons} >= 0 and ${t.doubleLessons} * 2 <= ${t.hours}`),
    check("timetable_assignments_validity", sql`${t.validFrom} is null or ${t.validUntil} is null or ${t.validFrom} <= ${t.validUntil}`),
    index("timetable_assignments_year_idx").on(t.schoolYearId),
    index("timetable_assignments_band_idx").on(t.bandId),
  ],
);

export type TimetableAssignment = typeof timetableAssignments.$inferSelect;

export const timetableAssignmentGroups = pgTable(
  "timetable_assignment_groups",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => timetableAssignments.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.assignmentId, t.groupId] }), index("timetable_assignment_groups_group_idx").on(t.groupId)],
);

export const timetableAssignmentTeachers = pgTable(
  "timetable_assignment_teachers",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => timetableAssignments.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.assignmentId, t.teacherId] }), index("timetable_assignment_teachers_teacher_idx").on(t.teacherId)],
);

/**
 * Pflichtstunden je Lehrkraft und Schuljahr (fehlt die Zeile, gilt die Vorgabe der Schulform).
 * SP3-DEP: `obligation` leer = Vorgabe der Schulform (z. B. wenn nur das 2. Halbjahr abweicht); `employment_percent` ist nur die
 * Rechenhilfe (Pflicht = Vorgabe × Anteil, gespeichert bleibt die Pflichtstundenzahl); `obligation_term2` gilt ab Beginn des 2. Halbjahrs.
 */
export const timetableDeputies = pgTable(
  "timetable_deputies",
  {
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    obligation: numeric("obligation", { precision: 4, scale: 1, mode: "number" }),
    employmentPercent: numeric("employment_percent", { precision: 5, scale: 1, mode: "number" }),
    obligationTerm2: numeric("obligation_term2", { precision: 4, scale: 1, mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.schoolYearId, t.teacherId] }),
    check("timetable_deputies_range", sql`${t.obligation} between 0 and 40`),
    check("timetable_deputies_percent", sql`${t.employmentPercent} > 0 and ${t.employmentPercent} <= 100`),
    check("timetable_deputies_term2", sql`${t.obligationTerm2} between 0 and 40`),
  ],
);

/**
 * SP2-04 (SP-G-05): Tagesregeln je Lehrkraft und Schuljahr – höchstens n Stunden am Tag, höchstens n Anwesenheitstage in der Woche
 * (Teilzeit). Hart im Solver und in der Setzhilfe, geprüft in der Diagnose. `null` = keine Grenze; ohne Grenze entfällt die Zeile.
 * Personaldaten wie das Deputat (sieht/pflegt die Planung, die Lehrkraft sieht ihre eigene Regel).
 */
export const timetableTeacherDayRules = pgTable(
  "timetable_teacher_day_rules",
  {
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    maxPerDay: integer("max_per_day"),
    maxDays: integer("max_days"),
  },
  (t) => [
    primaryKey({ columns: [t.schoolYearId, t.teacherId] }),
    check("timetable_teacher_day_rules_max", sql`${t.maxPerDay} is null or ${t.maxPerDay} between 1 and 20`),
    check("timetable_teacher_day_rules_days", sql`${t.maxDays} is null or ${t.maxDays} between 1 and 7`),
  ],
);

/**
 * SP2-12: Lehrfächer (Fakultas) je Lehrkraft – Stammdatum ohne Schuljahr. Grundlage für den Fachbedarf (Versorgung je Fach) und die
 * Lehrervorschläge bei der Zuweisung (nur Lehrkräfte mit dem Fach, andere über „alle anzeigen“ mit Warnhinweis). Pflegt die Planung.
 */
export const timetableTeacherSubjects = pgTable(
  "timetable_teacher_subjects",
  {
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teacherId, t.subjectId] }), index("timetable_teacher_subjects_subject_idx").on(t.subjectId)],
);

/** SP2-12: bekannte Personalveränderungen für die Prognose – Abgang einer Lehrkraft bzw. Zugang (ohne Person) */
export const STAFF_CHANGE_KINDS = ["abgang", "zugang"] as const;
export type StaffChangeKind = (typeof STAFF_CHANGE_KINDS)[number];
export const staffChangeKindEnum = pgEnum("staff_change_kind", STAFF_CHANGE_KINDS);

/**
 * SP2-12: Abgänge (Lehrkraft, ab Datum, wegfallende Stunden) und Zugänge (Fächer, ab Datum, Stunden) für die Prognose des nächsten
 * Schuljahres – bewusst **ohne Begründung** (kein Ruhestand/Elternzeit/Befristung im Datensatz). Abgänge sind personenbezogen: nur
 * `stundenplan.manage` sieht sie, die Schulleitung (`stundenplan.forecast_view`) nur Summen je Fach. Ein Zugang hat keine Person.
 */
export const timetableStaffChanges = pgTable(
  "timetable_staff_changes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: staffChangeKindEnum("kind").notNull(),
    /** nur beim Abgang */
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "cascade" }),
    /** nur beim Zugang: Fächer der neuen Lehrkraft (Kurzzeichen); beim Abgang gelten die Lehrfächer der Lehrkraft */
    subjectIds: text("subject_ids").array().notNull().default(sql`'{}'::text[]`),
    effectiveOn: date("effective_on").notNull(),
    hours: numeric("hours", { precision: 4, scale: 1, mode: "number" }).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_staff_changes_hours", sql`${t.hours} > 0 and ${t.hours} <= 40`),
    check("timetable_staff_changes_teacher", sql`(${t.kind} = 'abgang') = (${t.teacherId} is not null)`),
  ],
);

/** SP2-12: Klassenzahl je Jahrgang im nächsten Schuljahr (Prognose, Abweichung von „Klassen rücken auf“) – ohne Personenbezug */
export const timetableForecastGrades = pgTable(
  "timetable_forecast_grades",
  {
    /** Schuljahr, von dem aus prognostiziert wird (das Planungsjahr) */
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    grade: integer("grade").notNull(),
    classes: integer("classes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.schoolYearId, t.grade] }), check("timetable_forecast_grades_classes", sql`${t.classes} between 0 and 30`)],
);

/**
 * Gründe für Ermäßigungen/Anrechnungen – bewusst ohne Gesundheitsbezug (keine Schwerbehinderung o. Ä. als Grund,
 * dafür „sonstige Ermäßigung“). Neue Gründe nur hinten anfügen.
 */
export const REDUCTION_REASONS = [
  "alter",
  "schulleitung",
  "koordination",
  "klassenleitung",
  "fachleitung",
  "ausbildung",
  "personalrat",
  "sonstige_aufgabe",
  "sonstige_ermaessigung",
  // SP-02: Anrechnungsstunden für die Stundenplanung (Projektleitung 2026-10-19)
  "stundenplanung",
] as const;
export type ReductionReason = (typeof REDUCTION_REASONS)[number];
export const reductionReasonEnum = pgEnum("reduction_reason", REDUCTION_REASONS);

export const timetableReductions = pgTable(
  "timetable_reductions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: reductionReasonEnum("reason").notNull(),
    hours: numeric("hours", { precision: 4, scale: 1, mode: "number" }).notNull(),
    /** kurze Ergänzung, z. B. „Stufenkoordination 8“ – keine Gesundheitsangaben */
    note: text("note"),
    /** SP3-DEP: gilt ab/bis (einschließlich); leer = ab Schuljahresbeginn bzw. bis Schuljahresende */
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_reductions_hours", sql`${t.hours} > 0 and ${t.hours} <= 30`),
    check("timetable_reductions_validity", sql`${t.validFrom} is null or ${t.validUntil} is null or ${t.validFrom} <= ${t.validUntil}`),
    index("timetable_reductions_teacher_idx").on(t.schoolYearId, t.teacherId),
  ],
);

/** Gründe für Raumsperrungen. Neue Gründe nur hinten anfügen. */
export const ROOM_BLOCK_REASONS = ["renovierung", "pruefung", "veranstaltung", "defekt", "sonstiges"] as const;
export type RoomBlockReason = (typeof ROOM_BLOCK_REASONS)[number];
export const roomBlockReasonEnum = pgEnum("room_block_reason", ROOM_BLOCK_REASONS);

/** Raumsperrung: Raum in einem Zeitraum (ganztägig oder nur einzelne Stunden) nicht nutzbar → Stunden brauchen Ausweichraum. */
export const timetableRoomBlocks = pgTable(
  "timetable_room_blocks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    startsOn: date("starts_on").notNull(),
    /** einschließlich */
    endsOn: date("ends_on").notNull(),
    /** leer = ganzer Tag */
    fromPeriod: integer("from_period"),
    toPeriod: integer("to_period"),
    reason: roomBlockReasonEnum("reason").notNull(),
    /** kurze Ergänzung, z. B. „Abiturklausur Mathe“ */
    note: text("note"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_room_blocks_range", sql`${t.endsOn} >= ${t.startsOn}`),
    check("timetable_room_blocks_periods", sql`(${t.fromPeriod} is null and ${t.toPeriod} is null) or (${t.fromPeriod} is not null and ${t.toPeriod} is not null and ${t.toPeriod} >= ${t.fromPeriod})`),
    index("timetable_room_blocks_room_idx").on(t.roomId, t.startsOn),
  ],
);

export type TimetableRoomBlock = typeof timetableRoomBlocks.$inferSelect;

/**
 * Gründe für Abwesenheiten von Lehrkräften und Gruppen – feste Liste ohne Freitext zur Gesundheit
 * (bei Lehrkräften nur „krank“, nie eine Diagnose). Neue Gründe nur hinten anfügen.
 */
export const TIMETABLE_ABSENCE_REASONS = ["krank", "fortbildung", "dienstlich", "klassenfahrt", "exkursion", "praktikum", "pruefung", "sonstiges"] as const;
export type TimetableAbsenceReason = (typeof TIMETABLE_ABSENCE_REASONS)[number];
export const timetableAbsenceReasonEnum = pgEnum("timetable_absence_reason", TIMETABLE_ABSENCE_REASONS);

/**
 * P4-74/I-26: Stand einer Abwesenheit. „aktiv“ zählt für den Vertretungsbedarf; „beantragt“ (Lehrkraft meldet Fortbildung oder
 * dienstliche Abwesenheit selbst) wartet auf die Schulleitung; „abgelehnt“ zählt nicht.
 */
export const TIMETABLE_ABSENCE_STATES = ["aktiv", "beantragt", "abgelehnt"] as const;
export type TimetableAbsenceState = (typeof TIMETABLE_ABSENCE_STATES)[number];

/** Abwesenheit einer Lehrkraft (→ offene Stunden) oder einer Gruppe (→ Entfall, Lehrkraft frei), ganztägig oder stundenweise. */
export const timetableAbsences = pgTable(
  "timetable_absences",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    startsOn: date("starts_on").notNull(),
    /** einschließlich */
    endsOn: date("ends_on").notNull(),
    /** leer = ganzer Tag (bei mehrtägigen Abwesenheiten für jeden Tag) */
    fromPeriod: integer("from_period"),
    toPeriod: integer("to_period"),
    reason: timetableAbsenceReasonEnum("reason").notNull(),
    /** kurze Ergänzung ohne Gesundheitsangaben, z. B. „Fortbildung Digitalisierung“ */
    note: text("note"),
    /** P4-74: Stand (Vorgabe „aktiv“ – alles, was die Planung einträgt) */
    status: text("status").$type<TimetableAbsenceState>().notNull().default("aktiv"),
    /** P4-74: von der Lehrkraft selbst gemeldet */
    selfReported: boolean("self_reported").notNull().default(false),
    /** I-26: genehmigt bzw. abgelehnt von/am (Schulleitung) */
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_absences_target", sql`(${t.teacherId} is null) <> (${t.groupId} is null)`),
    check("timetable_absences_status", sql`${t.status} in ('aktiv', 'beantragt', 'abgelehnt')`),
    check("timetable_absences_range", sql`${t.endsOn} >= ${t.startsOn}`),
    check("timetable_absences_periods", sql`(${t.fromPeriod} is null and ${t.toPeriod} is null) or (${t.fromPeriod} is not null and ${t.toPeriod} is not null and ${t.toPeriod} >= ${t.fromPeriod})`),
    index("timetable_absences_dates_idx").on(t.startsOn, t.endsOn),
  ],
);

export type TimetableAbsence = typeof timetableAbsences.$inferSelect;

/**
 * Q5-12 (I-18): Vertretungsmaterial der abwesenden Lehrkraft je betroffener Stunde (Text und/oder Datei). Sichtbar für die
 * Lehrkraft selbst, die Vertretung dieser Stunde, die Planung und – nur mit Häkchen – die Schüler:innen der Gruppe. Geht mit der
 * Abwesenheit. VT-01 (F-10-12): auch ohne Abwesenheit (`absence_id` leer) an (Stunde, Tag) – anlegen dürfen die Lehrkraft der
 * Stunde, die Vertretungslehrkraft und die Planung; Löschklasse LK-SJ-1J ab `date`.
 */
export const timetableAbsenceMaterials = pgTable(
  "timetable_absence_materials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    absenceId: text("absence_id").references(() => timetableAbsences.id, { onDelete: "cascade" }),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => timetableLessons.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** Arbeitsauftrag, z. B. „Buch S. 34, Nr. 1–4; Lösungen im Ordner“ */
    text: text("text"),
    /** Datei im Dateispeicher (optional) */
    fileKey: text("file_key"),
    fileName: text("file_name"),
    fileMime: text("file_mime"),
    fileSize: integer("file_size"),
    /** Schüler:innen der Gruppe dürfen es sehen (Vorgabe nein) */
    forStudents: boolean("for_students").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // VT-01: je (Stunde, Tag) ein Material je Abwesenheit und eines ohne Abwesenheit
    uniqueIndex("timetable_absence_materials_uq").on(t.lessonId, t.date, sql`coalesce(${t.absenceId}, '')`),
    index("timetable_absence_materials_lesson_idx").on(t.lessonId, t.date),
  ],
);

export type TimetableAbsenceMaterial = typeof timetableAbsenceMaterials.$inferSelect;

/** Aufsichtsbereiche, z. B. „Schulhof Nord“, „Mensa“, „Bushaltestelle“ (P2b-20). */
export const timetableDutyAreas = pgTable("timetable_duty_areas", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** Aufsichtsplan: Lehrkraft beaufsichtigt Bereich am Wochentag in der Pause nach Stunde `after_period`. */
export const timetableDuties = pgTable(
  "timetable_duties",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    areaId: text("area_id")
      .notNull()
      .references(() => timetableDutyAreas.id, { onDelete: "cascade" }),
    /** 0 = Montag … 4 = Freitag */
    weekday: integer("weekday").notNull(),
    /** Pause nach dieser Stunde (0 = vor der 1. Stunde) */
    afterPeriod: integer("after_period").notNull(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_duties_weekday", sql`${t.weekday} between 0 and 4`),
    uniqueIndex("timetable_duties_uq").on(t.schoolYearId, t.areaId, t.weekday, t.afterPeriod, t.teacherId),
    index("timetable_duties_teacher_idx").on(t.teacherId, t.weekday),
  ],
);

/**
 * SP2-07: Bereitschaft (Vertretungsreserve) – Lehrkraft steht am Wochentag in Stunde `period_nr` für Vertretungen bereit.
 * Personaldienst wie der Aufsichtsplan: sichtbar nur für die Vertretungsplanung (`stundenplan.substitute`).
 */
export const timetableStandby = pgTable(
  "timetable_standby",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    /** 0 = Montag … 4 = Freitag */
    weekday: integer("weekday").notNull(),
    periodNr: integer("period_nr").notNull(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_standby_weekday", sql`${t.weekday} between 0 and 4`),
    uniqueIndex("timetable_standby_uq").on(t.schoolYearId, t.weekday, t.periodNr, t.teacherId),
    index("timetable_standby_teacher_idx").on(t.teacherId),
  ],
);

/** Vertretung einer Aufsicht an einem Tag (Lehrkraft abwesend); leere Vertretung = Aufsicht entfällt bewusst. */
export const timetableDutyChanges = pgTable(
  "timetable_duty_changes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    dutyId: text("duty_id")
      .notNull()
      .references(() => timetableDuties.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    substituteId: text("substitute_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("timetable_duty_changes_uq").on(t.dutyId, t.date)],
);

/** Wofür ein Zeitwunsch gilt (P2b-21). Neue Arten nur hinten anfügen. */
export const TIME_PREF_KINDS = ["teacher", "group", "room", "subject"] as const;
export type TimePrefKind = (typeof TIME_PREF_KINDS)[number];
export const timePrefKindEnum = pgEnum("time_pref_kind", TIME_PREF_KINDS);

/** Wer einen Zeitwunsch gesetzt hat (Q5-10, GATE-4f C-07): Vorgaben der Planung überschreibt die Lehrkraft nicht. */
export const TIME_PREF_SOURCES = ["planung", "lehrkraft"] as const;
export type TimePrefSource = (typeof TIME_PREF_SOURCES)[number];

/**
 * Zeitwunsch je Lehrkraft/Gruppe/Raum/Fach und Slot: −3 (sehr ungünstig) … +3 (sehr erwünscht) oder gesperrt.
 * Nicht gespeichert = neutral (0). Gesperrt ist für Setzhilfe und Solver eine harte Regel. `source`: von der Planung
 * (Vorgabe, auch ausdrücklich „egal“ = 0) oder von der Lehrkraft selbst (Q5-10) – Zeilen der Planung bleiben beim
 * Speichern der Lehrkraft erhalten.
 */
export const timetableTimePrefs = pgTable(
  "timetable_time_prefs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    kind: timePrefKindEnum("kind").notNull(),
    /** Lehrkraft-, Gruppen-, Raum- oder Fach-id (je nach `kind`) */
    targetId: text("target_id").notNull(),
    weekday: integer("weekday").notNull(),
    periodNr: integer("period_nr").notNull(),
    value: integer("value").notNull().default(0),
    blocked: boolean("blocked").notNull().default(false),
    source: text("source").$type<TimePrefSource>().notNull().default("planung"),
  },
  (t) => [
    check("timetable_time_prefs_value", sql`${t.value} between -3 and 3`),
    check("timetable_time_prefs_source", sql`${t.source} in ('planung', 'lehrkraft')`),
    check("timetable_time_prefs_weekday", sql`${t.weekday} between 0 and 4`),
    uniqueIndex("timetable_time_prefs_uq").on(t.schoolYearId, t.kind, t.targetId, t.weekday, t.periodNr),
  ],
);

/**
 * queued = wartet (nur ein Lauf rechnet) · running = rechnet · done = fertig (auch vorzeitig beendet) · failed = Fehler ·
 * cancelled = vor der Konstruktion abgebrochen (kein Ergebnis) · applied = übernommen. Neue Werte (SP-06) hinten angefügt;
 * die Vorgabe bleibt `running`, weil ein neuer Enum-Wert in der Migration, die ihn anlegt, nicht benutzt werden darf.
 */
export const SOLVER_RUN_STATUS = ["running", "done", "failed", "applied", "queued", "cancelled"] as const;
export const solverRunStatusEnum = pgEnum("solver_run_status", SOLVER_RUN_STATUS);

/**
 * Ein Lauf der automatischen Planung (P2b-23, SP-06): Parameter (reproduzierbar), Fortschritt mit Heartbeat, Abbruchwunsch,
 * Ergebnis (Vorschlag) als JSON, Kennzahlen und Protokoll klein daneben (die Historie liest nur diese), Übernahme mit Herkunft.
 */
export const timetableSolverRuns = pgTable("timetable_solver_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  schoolYearId: text("school_year_id")
    .notNull()
    .references(() => schoolYears.id, { onDelete: "cascade" }),
  status: solverRunStatusEnum("status").notNull().default("running"),
  /** 0 … 100 */
  progress: integer("progress").notNull().default(0),
  seed: integer("seed").notNull().default(1),
  iterations: integer("iterations").notNull().default(0),
  /** SolverResult + Einheiten-Metadaten für Vorschau und Übernahme; `null`, wenn das Aufräumen das Ergebnis entfernt hat */
  result: jsonb("result"),
  error: text("error"),
  appliedFrom: date("applied_from"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** freie Bezeichnung der Planung („Variante Mo frei“) – keine Personen nennen */
  label: text("label"),
  /** `{ effort, seed, weights, preset }` – alles, was den Lauf reproduzierbar macht */
  params: jsonb("params"),
  /** Kennzahlen beim Abschluss (Bewertung, Kostenposten, nicht gesetzt, Hohlstunden, Dauer …) */
  metrics: jsonb("metrics"),
  /** Protokoll (≤ 50 Einträge): Eingabe, Vorprüfung, Konstruktion, alle 10 %, Abbruch/Ende */
  log: jsonb("log"),
  /** Abbruch gewünscht – der Lauf prüft das je Zeitscheibe */
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  /** letzte Lebenszeichen des rechnenden Laufs (Sperre, Anzeige „rechnet seit …“, verwaiste Läufe) */
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  appliedBy: text("applied_by").references(() => users.id, { onDelete: "set null" }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  /** SP-09: was die Übernahme geändert hat (beendete Stunden mit altem `valid_until`, Zahl gelöschter Vertretungen) */
  undo: jsonb("undo"),
});

/**
 * Q5-10 (I-47): Lehrkraft hat ihre Zeitwünsche im Eingabefenster selbst abgegeben (auch „alles egal“ – dann gibt es keine
 * Zeilen in `timetable_time_prefs`). Die Planung sieht so den Stand; eine Zeile je Lehrkraft und Planungsjahr.
 */
export const timetableTimePrefSubmissions = pgTable(
  "timetable_time_pref_submissions",
  {
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.schoolYearId, t.teacherId] })],
);

/**
 * Q5-11 (I-25): Tagesstatus des Vertretungsplans im Modus „Freigabe“. Zeile ohne `published_at` = Entwurf: Schüler:innen,
 * Eltern, Lehrkräfte und Monitore sehen die Änderungen dieses Tages nicht, Gongs warten aufs Veröffentlichen. Tage ohne
 * Zeile gelten als veröffentlicht (Modus „sofort“ und alles von vorher).
 */
export const timetableSubstitutionDays = pgTable("timetable_substitution_days", {
  date: date("date").primaryKey(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

/** VT-04 (F-10-11): Zielgruppe der Vertretungsnachricht – Lehrkräfte bzw. Lernende (mit ihren Eltern). */
export const NOTIFY_AUDIENCES = ["lehrkraefte", "lernende"] as const;
export type NotifyAudience = (typeof NOTIFY_AUDIENCES)[number];
export const notifyAudienceEnum = pgEnum("timetable_notify_audience", NOTIFY_AUDIENCES);

/**
 * VT-04: Sendewarteschlange der Vertretungsnachricht – eine offene Zeile je Person und Vertretungstag. Die Nachricht selbst steht
 * nicht hier: beim Senden wird sie aus dem **aktuellen** Stand des Tages gebaut (immer Endstand, nie Zwischenstände). `queued_at`
 * ist das erste Einreihen seit dem letzten Versand (daraus folgt `due_at`, auch nach einer Änderung der Einstellungen);
 * `sent_at` gesetzt = verschickt. Eltern stehen nicht in der Warteschlange – sie folgen beim Senden den Lernenden.
 */
export const timetableNotificationQueue = pgTable(
  "timetable_notification_queue",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: date("date").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    audience: notifyAudienceEnum("audience").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("timetable_notification_queue_pending_idx").on(t.userId, t.date).where(sql`${t.sentAt} is null`),
    index("timetable_notification_queue_due_idx").on(t.dueAt).where(sql`${t.sentAt} is null`),
    index("timetable_notification_queue_date_idx").on(t.date, t.sentAt),
  ],
);

export type TimetableNotificationQueueRow = typeof timetableNotificationQueue.$inferSelect;

// ---------------------------------------------------------------- SP3-01: Planversionen + Entwurfsbereich

/**
 * Lebenszyklus einer Planversion (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1): entwurf → pruefung → freigegeben → gueltig → archiviert;
 * verworfen = Variante/Entwurf, der nicht veröffentlicht wird. Neue Werte nur hinten anfügen.
 */
export const PLAN_VERSION_STATUS = ["entwurf", "pruefung", "freigegeben", "gueltig", "archiviert", "verworfen"] as const;
export type PlanVersionStatus = (typeof PLAN_VERSION_STATUS)[number];
export const planVersionStatusEnum = pgEnum("plan_version_status", PLAN_VERSION_STATUS);

/** Ausgangsbasis eines Entwurfs (§2.2); `bestand` = der Plan vor SP3-01 („Bestand 1.0“, Daten-Migration). Neue Werte nur hinten anfügen. */
export const PLAN_VERSION_SOURCES = ["live_copy", "solver_run", "previous_version", "variant_of", "empty", "bestand"] as const;
export type PlanVersionSource = (typeof PLAN_VERSION_SOURCES)[number];
export const planVersionSourceEnum = pgEnum("plan_version_source", PLAN_VERSION_SOURCES);

/**
 * SP3-01: Hülle einer Planversion je Schuljahr. Der gültige Plan bleibt `timetable_lessons`; Entwürfe liegen in
 * `timetable_draft_lessons` und wirken erst mit dem Veröffentlichen (SP3-04). Nummer `major.minor`: neue Planung zählt `major`,
 * Folgeversion `minor` hoch; Entwürfe tragen die Nummer, die sie beim Veröffentlichen bekämen (Varianten dieselbe) – eindeutig
 * ist sie nur unter veröffentlichten Versionen (`gueltig`/`archiviert`).
 */
export const timetablePlanVersions = pgTable(
  "timetable_plan_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    major: integer("major").notNull(),
    minor: integer("minor").notNull().default(0),
    /** freie Bezeichnung („2. Halbjahr“, „Variante Mo frei“) – keine Personen nennen */
    name: text("name").notNull(),
    status: planVersionStatusEnum("status").notNull().default("entwurf"),
    source: planVersionSourceEnum("source").notNull(),
    /** Variante von / Folgeversion von / Kopie von */
    parentVersionId: text("parent_version_id").references((): AnyPgColumn => timetablePlanVersions.id, { onDelete: "set null" }),
    sourceRunId: text("source_run_id").references(() => timetableSolverRuns.id, { onDelete: "set null" }),
    /** gültig ab (Stichtag) – bei Entwürfen vorgemerkt, bei `gueltig`/`archiviert` tatsächlich */
    validFrom: date("valid_from"),
    /** einschließlich; bei archivierten Versionen der letzte Tag */
    validUntil: date("valid_until"),
    /** Lehrkräfte-Vorschau „Mein Plan ab …“ (SP3-03) */
    teacherPreview: boolean("teacher_preview").notNull().default(false),
    /** Planungsfahrplan: manuelle Häkchen, Termine, Quittierungen (SP3-06) */
    checklist: jsonb("checklist"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: text("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** verworfen von/am */
    discardedBy: text("discarded_by").references(() => users.id, { onDelete: "set null" }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    /** Rücknahme-Daten der Veröffentlichung (SP3-04) – nur bis zum Stichtag, der Nachtjob leert sie */
    undo: jsonb("undo"),
    /**
     * SP3-04 (F-10-4): Änderungsliste an Schüler:innen/Eltern – Zeilen je Klasse/Kurs (`{ groups: { <Gruppen-id>: string[] } }`, Kürzel
     * statt Namen), versendet zur Vortags-Uhrzeit vor dem Stichtag (`notify_at`, Einstellung „Lernende“); nach dem Versand geleert.
     */
    notify: jsonb("notify"),
    notifyAt: timestamp("notify_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    check("timetable_plan_versions_valid", sql`${t.validUntil} is null or ${t.validFrom} is null or ${t.validUntil} >= ${t.validFrom}`),
    check("timetable_plan_versions_number", sql`${t.major} >= 1 and ${t.minor} >= 0`),
    check("timetable_plan_versions_name", sql`char_length(${t.name}) between 1 and 80`),
    index("timetable_plan_versions_year_idx").on(t.schoolYearId, t.status),
    // Nummern sind eindeutig unter veröffentlichten Versionen (Entwürfe tragen die vorgesehene Nummer, Varianten dieselbe)
    uniqueIndex("timetable_plan_versions_number_uq")
      .on(t.schoolYearId, t.major, t.minor)
      .where(sql`${t.status} in ('gueltig', 'archiviert')`),
    // höchstens eine gültige Version je Schuljahr (Zeitraum-Eindeutigkeit prüft der Service über valid_from/valid_until)
    uniqueIndex("timetable_plan_versions_valid_uq").on(t.schoolYearId).where(sql`${t.status} = 'gueltig'`),
    // „Bestand 1.0“ höchstens einmal je Schuljahr (Daten-Migration und `ensureBaseVersions` sind idempotent)
    uniqueIndex("timetable_plan_versions_bestand_uq").on(t.schoolYearId).where(sql`${t.source} = 'bestand'`),
  ],
);

export type TimetablePlanVersion = typeof timetablePlanVersions.$inferSelect;

/**
 * SP3-01: Stunden eines Entwurfs – Spalten wie `timetable_lessons` (gemeinsame Spaltenfabrik) plus Version, Herkunft im gültigen Plan
 * (`origin_lesson_id`, für den Diff beim Veröffentlichen) und Lehrauftrag. **Nur das Modul Stundenplan liest diese Tabelle**
 * (Test `planversionen.test.ts` „kein fremder Leser“) – kein Plan-Leser außerhalb der Planung sieht Entwürfe.
 */
export const timetableDraftLessons = pgTable(
  "timetable_draft_lessons",
  {
    ...lessonColumns(),
    versionId: text("version_id")
      .notNull()
      .references(() => timetablePlanVersions.id, { onDelete: "cascade" }),
    originLessonId: text("origin_lesson_id").references(() => timetableLessons.id, { onDelete: "set null" }),
    assignmentId: text("assignment_id").references(() => timetableAssignments.id, { onDelete: "set null" }),
  },
  (t) => [
    index("timetable_draft_lessons_version_idx").on(t.versionId, t.groupId, t.weekday),
    index("timetable_draft_lessons_teacher_idx").on(t.versionId, t.teacherId, t.weekday),
    index("timetable_draft_lessons_room_idx").on(t.versionId, t.roomId, t.weekday),
    index("timetable_draft_lessons_coupling_idx").on(t.versionId, t.couplingId),
    index("timetable_draft_lessons_origin_idx").on(t.originLessonId),
    check("timetable_draft_lessons_weekday", sql`${t.weekday} between 0 and 4`),
    check("timetable_draft_lessons_valid", sql`${t.validUntil} is null or ${t.validUntil} >= ${t.validFrom}`),
  ],
);

export type TimetableDraftLesson = typeof timetableDraftLessons.$inferSelect;

// ---------------------------------------------------------------- SP3-03: Prüfung & Freigabe

/** Bezug eines Prüfkommentars (§3.1): ganze Version, Lehrkraft, Klasse/Kurs oder Stunde (Wochentag + Stunde). Neue Werte nur hinten anfügen. */
export const PLAN_COMMENT_TARGETS = ["version", "teacher", "group", "slot"] as const;
export type PlanCommentTarget = (typeof PLAN_COMMENT_TARGETS)[number];
export const planCommentTargetEnum = pgEnum("plan_comment_target", PLAN_COMMENT_TARGETS);

/**
 * SP3-03: Kommentare zu einer Planversion (Prüfung durch die Schulleitung, Rückmeldung von Lehrkräften aus der Vorschau „Mein Plan ab …“).
 * Der Bezug steht in eigenen Spalten statt als JSON (§3.1 „target jsonb“), damit Kontolöschung und gelöschte Gruppen ihn per
 * Fremdschlüssel leeren. Sichtbar für `stundenplan.manage` (alle, erledigen) und `stundenplan.review` (ab Prüfung); eine Lehrkraft sieht nur
 * eigene Kommentare. **Nur das Modul Stundenplan liest diese Tabelle** (Querschnittstest) – nie Schülersicht, Monitor oder Gong.
 */
export const timetablePlanComments = pgTable(
  "timetable_plan_comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    versionId: text("version_id")
      .notNull()
      .references(() => timetablePlanVersions.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** aus der Lehrkräfte-Vorschau geschrieben (Rückmeldung an die Planung) */
    fromPreview: boolean("from_preview").notNull().default(false),
    targetKind: planCommentTargetEnum("target_kind").notNull().default("version"),
    /** Bezug Lehrkraft (bzw. bei einer Stunde aus der Vorschau: die eigene) */
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "set null" }),
    /** Bezug Klasse/Kurs (bzw. bei einer Stunde: optional die Gruppe) */
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    /** nur Bezug Stunde: 0 = Montag … 4 = Freitag */
    weekday: integer("weekday"),
    periodNr: integer("period_nr"),
    /** ≤ 500 Zeichen, keine Gesundheitsangaben */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("timetable_plan_comments_version_idx").on(t.versionId, t.createdAt),
    index("timetable_plan_comments_author_idx").on(t.authorId),
    check("timetable_plan_comments_body", sql`char_length(${t.body}) between 1 and 500`),
    check("timetable_plan_comments_slot", sql`(${t.targetKind} = 'slot') = (${t.weekday} is not null and ${t.periodNr} is not null)`),
    check("timetable_plan_comments_weekday", sql`${t.weekday} is null or ${t.weekday} between 0 and 4`),
  ],
);

export type TimetablePlanComment = typeof timetablePlanComments.$inferSelect;
