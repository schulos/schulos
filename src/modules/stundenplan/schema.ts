// Stundenplan – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, periods, rooms, schoolYears, subjects } from "../../core/db/schema-core";

/** A/B-Wochen: A = ungerade Kalenderwoche (ISO), B = gerade */
export const LESSON_WEEKS = ["all", "A", "B"] as const;
export const lessonWeekEnum = pgEnum("lesson_week", LESSON_WEEKS);

/** Eine regelmäßige Unterrichtsstunde: Gruppe × Wochentag × Stunde, gültig in einem Zeitraum. */
export const timetableLessons = pgTable(
  "timetable_lessons",
  {
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
  },
  (t) => [
    index("timetable_lessons_coupling_idx").on(t.couplingId),
    index("timetable_lessons_solver_run_idx").on(t.solverRunId),
    check("timetable_lessons_weekday", sql`${t.weekday} between 0 and 4`),
    check("timetable_lessons_valid", sql`${t.validUntil} is null or ${t.validUntil} >= ${t.validFrom}`),
    index("timetable_lessons_group_idx").on(t.groupId, t.weekday),
    index("timetable_lessons_teacher_idx").on(t.teacherId, t.weekday),
    index("timetable_lessons_room_idx").on(t.roomId, t.weekday),
  ],
);

export type TimetableLesson = typeof timetableLessons.$inferSelect;

/** cancel = Entfall · substitute = Vertretung (andere Lehrkraft, ggf. anderer Raum) · room = nur Raumänderung */
export const SUBSTITUTION_KINDS = ["cancel", "substitute", "room"] as const;
export const substitutionKindEnum = pgEnum("substitution_kind", SUBSTITUTION_KINDS);

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
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("timetable_substitutions_lesson_date_uq").on(t.lessonId, t.date),
    check("timetable_substitutions_subject", sql`${t.subjectId} is null or ${t.kind} = 'substitute'`),
    index("timetable_substitutions_date_idx").on(t.date),
    index("timetable_substitutions_substitute_idx").on(t.substituteId, t.date),
  ],
);

export type TimetableSubstitution = typeof timetableSubstitutions.$inferSelect;

/**
 * Lehrauftrag (Unterrichtsverteilung): „7b, Deutsch, 4 Wochenstunden, BRA“ – Planungsauftrag vor dem Stundenplan.
 * Mehrere Gruppen = Kopplung, mehrere Lehrkräfte = Teamteaching.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("timetable_assignments_hours", sql`${t.hours} between 1 and 12`),
    check("timetable_assignments_double", sql`${t.doubleLessons} >= 0 and ${t.doubleLessons} * 2 <= ${t.hours}`),
    index("timetable_assignments_year_idx").on(t.schoolYearId),
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

/** Pflichtstunden je Lehrkraft und Schuljahr (fehlt die Zeile, gilt die Vorgabe der Schulform) */
export const timetableDeputies = pgTable(
  "timetable_deputies",
  {
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    obligation: numeric("obligation", { precision: 4, scale: 1, mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.schoolYearId, t.teacherId] }), check("timetable_deputies_range", sql`${t.obligation} between 0 and 40`)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("timetable_reductions_hours", sql`${t.hours} > 0 and ${t.hours} <= 30`), index("timetable_reductions_teacher_idx").on(t.schoolYearId, t.teacherId)],
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
 * Abwesenheit (follows).
 */
export const timetableAbsenceMaterials = pgTable(
  "timetable_absence_materials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    absenceId: text("absence_id")
      .notNull()
      .references(() => timetableAbsences.id, { onDelete: "cascade" }),
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
  (t) => [uniqueIndex("timetable_absence_materials_uq").on(t.absenceId, t.lessonId, t.date), index("timetable_absence_materials_lesson_idx").on(t.lessonId, t.date)],
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
