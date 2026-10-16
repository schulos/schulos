// Zweites Schulprofil (P2b-24): ein frisch angelegtes Gymnasium wird aus den Vorlagen der Schulform aufgebaut und
// der Solver plant es vollständig – unabhängig von der Demo-Gesamtschule.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  curriculumHours,
  groups,
  periods,
  rooms,
  schoolYears,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  users,
} from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { defaultTimeGrid, SUBJECT_TEMPLATE } from "@/core/school/templates";
import { ROOMS, TEACHERS } from "@/core/seed/data";
import { applyCurriculumTemplate, ensureGradeLevels } from "@/modules/verwaltung/stammdaten";
import { solve, validate } from "./solver";
import { solverInputFromDb } from "./solver-input";
import { planningYear } from "./verteilung";

describe("Gymnasium (zweites Schulprofil)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    const db = h.db;
    await db.insert(appSettings).values([
      { key: "school.name", value: "Gymnasium am Test" },
      { key: "school.state", value: "NW" },
      { key: "school.form", value: "gymnasium" },
      { key: "school.oberstufe", value: true },
      { key: "school.abitur", value: "g9" },
    ]);
    await db.insert(schoolYears).values({ id: "sj", name: "2026/27", startsOn: "2026-08-01", endsOn: "2027-07-31", isCurrent: true });
    await db.insert(subjects).values(SUBJECT_TEMPLATE.map((s, i) => ({ id: s.id, name: s.name, color: s.color, roomKind: s.roomKind ?? null, sortOrder: i })));
    await db.insert(rooms).values(ROOMS);
    await db.insert(periods).values(defaultTimeGrid({ form: "gymnasium" }).periods);
    await ensureGradeLevels(db);
    await applyCurriculumTemplate(db, null);
    await db
      .insert(users)
      .values(
        TEACHERS.map(([first, last, code]) => ({
          id: `t-${code}`,
          name: `${first} ${last}`,
          email: `${code}@test.local`,
          username: code.toLowerCase(),
          shortCode: code,
          role: "lehrkraft" as const,
        })),
      );
  }, 60_000);
  afterAll(() => h.close());

  it("Stundentafel des Gymnasiums → Lehraufträge → Solver setzt alles kollisionsfrei", async () => {
    const db = h.db;
    const tafel = await db.select().from(curriculumHours);
    const grades = [...new Set(tafel.map((t) => t.gradeLevel))].sort((a, b) => a - b);
    expect(grades.length).toBeGreaterThanOrEqual(5); // Sek I des Gymnasiums
    // zwei Klassen je Jahrgang, Lehrkräfte nach Fach und Auslastung
    const load = new Map<string, number>();
    const classes = grades.flatMap((g) =>
      ["a", "b"].map((x) => ({ id: `g-${g}${x}`, name: `Klasse ${g}${x}`, slug: `${g}${x}`, kind: "klasse" as const, gradeLevel: g })),
    );
    await db.insert(groups).values(classes);
    const rows: { id: string; groupId: string; subjectId: string; hours: number; teacherId: string }[] = [];
    for (const c of classes) {
      for (const t of tafel.filter((x) => x.gradeLevel === c.gradeLevel)) {
        const pool = TEACHERS.filter(([, , , subs]) => subs.includes(t.subjectId)).map(([, , code]) => `t-${code}`);
        const teacherId = pool.reduce((best, x) => ((load.get(x) ?? 0) < (load.get(best) ?? 0) ? x : best));
        load.set(teacherId, (load.get(teacherId) ?? 0) + t.hours);
        rows.push({ id: `la-${c.id}-${t.subjectId}`, groupId: c.id, subjectId: t.subjectId, hours: t.hours, teacherId });
      }
    }
    await db
      .insert(timetableAssignments)
      .values(
        rows.map((r) => ({
          id: r.id,
          schoolYearId: "sj",
          subjectId: r.subjectId,
          hours: r.hours,
          doubleLessons: r.subjectId === "SP" && r.hours >= 2 ? 1 : 0,
        })),
      );
    await db.insert(timetableAssignmentGroups).values(rows.map((r) => ({ assignmentId: r.id, groupId: r.groupId })));
    await db.insert(timetableAssignmentTeachers).values(rows.map((r) => ({ assignmentId: r.id, teacherId: r.teacherId })));

    const input = await solverInputFromDb(db, (await planningYear(db))!, "2026-10-05", { seed: 2 });
    expect(input.units.length).toBeGreaterThan(200);
    const r = solve(input);
    expect(r.unplaced).toEqual([]);
    expect(validate(input, r.placements)).toEqual([]);
    expect(r.breakdown.noRoom).toBe(0);
    expect(r.breakdown.classGap).toBeLessThanOrEqual(3 * 10);
    // Deterministisch: gleicher Startwert, gleicher Plan
    expect(solve({ ...input }).placements).toEqual(r.placements);
  }, 60_000);
});
