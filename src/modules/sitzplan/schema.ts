// Sitzplan (P5-01) – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, roomLayouts, rooms, schoolYears, subjects } from "../../core/db/schema-core";

/**
 * Ein Sitzplan einer Lerngruppe (optional für ein Fach bzw. einen Raum). Sehen und ändern dürfen nur Lehrkräfte der Gruppe
 * und die Klassenleitung (Service). Raster `rows` × `cols`, Reihe 0 vorn; `desks` sind die Felder mit Tisch („r:c“).
 */
export const sitzplanPlans = pgTable(
  "sitzplan_plans",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    subjectId: text("subject_id").references(() => subjects.id, { onDelete: "set null", onUpdate: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** wer den Plan angelegt hat (bleibt sichtbar für alle Lehrkräfte der Gruppe) */
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    schoolYearId: text("school_year_id").references(() => schoolYears.id, { onDelete: "set null" }),
    rows: integer("rows").notNull(),
    cols: integer("cols").notNull(),
    desks: jsonb("desks").$type<string[]>().notNull().default([]),
    /** RS-09: aus welchem Raumlayout die Tische als Kopie stammen (Hinweis, wenn das Layout danach geändert wurde) */
    layoutId: text("layout_id").references(() => roomLayouts.id, { onDelete: "set null" }),
    layoutCopiedAt: timestamp("layout_copied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sitzplan_plans_rows", sql`${t.rows} between 1 and 12`),
    check("sitzplan_plans_cols", sql`${t.cols} between 1 and 12`),
    index("sitzplan_plans_group_idx").on(t.groupId),
  ],
);

export type SitzplanPlan = typeof sitzplanPlans.$inferSelect;

/** Platz einer Schüler:in in einem Plan. Personen ohne Zeile sitzen (noch) nicht. */
export const sitzplanSeats = pgTable(
  "sitzplan_seats",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => sitzplanPlans.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
  },
  (t) => [primaryKey({ columns: [t.planId, t.studentId] }), uniqueIndex("sitzplan_seats_place").on(t.planId, t.row, t.col), index("sitzplan_seats_student_idx").on(t.studentId)],
);
