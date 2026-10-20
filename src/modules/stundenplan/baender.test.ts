// SP2-01: Migration 0100 – bisherige Kopplungen im Lehrauftrag („Gekoppelt mit“) werden zu Bändern; der Solver setzt sie weiter
// als eine Kopplung.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { createTestDb } from "@/core/db/testing";
import {
  groups,
  notenbuchBooks,
  schoolYears,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableBands,
  users,
} from "@/core/db/schema";
import { unitsFrom } from "./solver-input";
import { distribution } from "./verteilung";

/** Datenteil der Migration 0100 (nach der Tabellenanlage) – zum erneuten Ausführen auf Altdaten. */
function dataStatements(): string[] {
  const file = readFileSync(join(process.cwd(), "drizzle", "0100_sp2_01_baender.sql"), "utf8");
  const start = file.indexOf("-- SP2-01 Daten");
  expect(start).toBeGreaterThan(0);
  return file
    .slice(start)
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** id des neuen Lehrauftrags für eine weitere Gruppe: md5(Lehrauftrag|Gruppe) als UUID */
function memberId(assignmentId: string, groupId: string): string {
  const h = createHash("md5").update(`${assignmentId}|${groupId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe("Migration 0100: Kopplungen → Bänder", () => {
  let h: DbHandle;
  const year = { id: "sj", startsOn: "2026-08-01", endsOn: "2027-07-31" };
  const run = async () => {
    for (const st of dataStatements()) await h.db.execute(sql.raw(st));
  };

  beforeAll(async () => {
    h = await createTestDb();
    const db = h.db;
    await db.insert(schoolYears).values({ ...year, name: "2026/27", isCurrent: true });
    await db.insert(subjects).values([
      { id: "REL", name: "Religion", color: "#868E96" },
      { id: "D", name: "Deutsch", color: "#1C7ED6" },
    ]);
    await db.insert(groups).values([
      { id: "g-7a", name: "7a", slug: "7a", kind: "klasse", gradeLevel: 7 },
      { id: "g-7b", name: "7b", slug: "7b", kind: "klasse", gradeLevel: 7 },
      { id: "g-7c", name: "7c", slug: "7c", kind: "klasse", gradeLevel: 7 },
    ]);
    await db.insert(users).values([
      { id: "t1", name: "Lehrkraft Eins", email: "t1@example.test", role: "lehrkraft", shortCode: "EIN" },
      { id: "t2", name: "Lehrkraft Zwei", email: "t2@example.test", role: "lehrkraft", shortCode: "ZWE" },
    ]);
    // Altbestand: Religion 7b + 7a gekoppelt (zwei Lehrkräfte), eine zweite Kopplung mit denselben Gruppen, Deutsch 7a einzeln
    await db.insert(timetableAssignments).values([
      { id: "a-rel", schoolYearId: "sj", subjectId: "REL", hours: 2, doubleLessons: 1, note: "Kopplung" },
      { id: "a-rel2", schoolYearId: "sj", subjectId: "REL", hours: 1, doubleLessons: 0 },
      { id: "a-d", schoolYearId: "sj", subjectId: "D", hours: 4, doubleLessons: 0 },
    ]);
    await db.insert(timetableAssignmentGroups).values([
      { assignmentId: "a-rel", groupId: "g-7b" },
      { assignmentId: "a-rel", groupId: "g-7a" },
      { assignmentId: "a-rel2", groupId: "g-7a" },
      { assignmentId: "a-rel2", groupId: "g-7b" },
      { assignmentId: "a-rel2", groupId: "g-7c" },
      { assignmentId: "a-d", groupId: "g-7a" },
    ]);
    await db.insert(timetableAssignmentTeachers).values([
      { assignmentId: "a-rel", teacherId: "t1" },
      { assignmentId: "a-rel", teacherId: "t2" },
      { assignmentId: "a-rel2", teacherId: "t1" },
      { assignmentId: "a-d", teacherId: "t1" },
    ]);
    const weights = { schriftlich: 50, sonstige: 50 };
    await db.insert(notenbuchBooks).values([
      { id: "nb-7a", schoolYearId: "sj", term: 1, groupId: "g-7a", subjectId: "REL", assignmentId: "a-rel", scale: "noten6", weights },
      { id: "nb-7b", schoolYearId: "sj", term: 1, groupId: "g-7b", subjectId: "REL", assignmentId: "a-rel", scale: "noten6", weights },
    ]);
    await run();
  });
  afterAll(() => h.close());

  it("legt je Kopplung ein Band an (id, Stunden, Name aus Fach + Gruppen, eindeutig)", async () => {
    const bands = await h.db.select().from(timetableBands).orderBy(asc(timetableBands.id));
    expect(bands.map(({ id, name, hours, doubleLessons }) => ({ id, name, hours, doubleLessons }))).toEqual([
      { id: "a-rel", name: "Religion 7a/7b", hours: 2, doubleLessons: 1 },
      { id: "a-rel2", name: "Religion 7a/7b/7c", hours: 1, doubleLessons: 0 },
    ]);
  });

  it("je Gruppe ein Lehrauftrag mit denselben Angaben im Band; Einzel-Lehraufträge bleiben", async () => {
    const rows = await h.db.select().from(timetableAssignments);
    const groupsOf = async (id: string) =>
      (await h.db.select({ g: timetableAssignmentGroups.groupId }).from(timetableAssignmentGroups).where(eq(timetableAssignmentGroups.assignmentId, id))).map((x) => x.g);
    const teachersOf = async (id: string) =>
      (await h.db.select({ t: timetableAssignmentTeachers.teacherId }).from(timetableAssignmentTeachers).where(eq(timetableAssignmentTeachers.assignmentId, id)))
        .map((x) => x.t)
        .sort();
    expect(rows).toHaveLength(6);
    const m7b = memberId("a-rel", "g-7b");
    expect(rows.find((r) => r.id === "a-rel")).toMatchObject({ bandId: "a-rel", hours: 2, doubleLessons: 1, note: "Kopplung" });
    expect(rows.find((r) => r.id === m7b)).toMatchObject({ bandId: "a-rel", subjectId: "REL", hours: 2, doubleLessons: 1, note: "Kopplung" });
    expect(await groupsOf("a-rel")).toEqual(["g-7a"]);
    expect(await groupsOf(m7b)).toEqual(["g-7b"]);
    expect(await teachersOf(m7b)).toEqual(["t1", "t2"]);
    expect(rows.filter((r) => r.bandId === "a-rel2")).toHaveLength(3);
    expect(rows.find((r) => r.id === "a-d")!.bandId).toBeNull();
    for (const r of rows) expect(await groupsOf(r.id)).toHaveLength(1);
  });

  it("Notenbücher zeigen auf den Lehrauftrag ihrer Gruppe", async () => {
    const books = await h.db.select({ id: notenbuchBooks.id, a: notenbuchBooks.assignmentId }).from(notenbuchBooks).orderBy(asc(notenbuchBooks.id));
    expect(books).toEqual([
      { id: "nb-7a", a: "a-rel" },
      { id: "nb-7b", a: memberId("a-rel", "g-7b") },
    ]);
  });

  it("Verteilung: Band einheitlich, Lehrkraft zählt das Band einmal; Solver setzt es wie die alte Kopplung", async () => {
    const d = await distribution(h.db, year, "2026-10-05");
    const band = d.bands.find((b) => b.id === "a-rel")!;
    expect(band).toMatchObject({ name: "Religion 7a/7b", hours: 2, planned: 0, together: 0, uniform: true });
    expect(band.memberIds).toHaveLength(2);
    // t1: Religion 7a/7b (2, einmal) + Religion 7a/7b/7c (1, einmal) + Deutsch (4)
    expect(d.teachers.find((t) => t.id === "t1")!.assigned).toBe(7);
    expect(d.groups.find((g) => g.id === "g-7b")!.assigned).toBe(3);
    const units = unitsFrom(d, { roomKindOf: new Map(), homeRoomOf: new Map(), sizeOf: new Map(), classIds: new Set(["g-7a", "g-7b", "g-7c"]) });
    const rel = units.filter((u) => u.subjectId === "REL" && u.length === 2);
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ assignmentId: "a-rel", groupIds: ["g-7a", "g-7b"], teacherIds: ["t1", "t2"], label: "7a + 7b Religion (EIN + ZWE)" });
    expect(rel[0]!.parts.map((p) => p.teacherIds)).toEqual([["t1"], ["t2"]]);
    expect(units.filter((u) => u.subjectId === "REL")).toHaveLength(2);
    expect(units.find((u) => u.assignmentId === "a-rel2")).toMatchObject({ groupIds: ["g-7a", "g-7b", "g-7c"], length: 1 });
  });

  it("erneuter Lauf ändert nichts", async () => {
    const count = async () => ({
      bands: (await h.db.select().from(timetableBands)).length,
      assignments: (await h.db.select().from(timetableAssignments)).length,
      groups: (await h.db.select().from(timetableAssignmentGroups)).length,
      teachers: (await h.db.select().from(timetableAssignmentTeachers)).length,
    });
    const before = await count();
    await run();
    expect(await count()).toEqual(before);
  });
});
