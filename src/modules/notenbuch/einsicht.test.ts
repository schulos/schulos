// Notenbuch (P5-14): Schüler-/Elternsicht als Moduleinstellung – Vorgabe aus; nur eigene bzw. verknüpfte Kinder; Halbjahresnote
// erst nach dem Abschluss; Teilnoten nur im Umfang „teilnoten“; nie Kommentare oder Vorschläge; Eltern nach Jahrgang, eigenständige
// Schüler:innen nur mit Einwilligung. Navigation: „Noten“ nur bei eingeschalteter Sicht, „Notenbuch“ nur bei ausdrücklichem Recht.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, notenbuchBooks, notenbuchBookTeachers, notenbuchColumns, notenbuchEntries, notenbuchTermGrades, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { buildNav } from "@/core/modules/registry";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { displayEntry, familyGrades, gradeOwners } from "./einsicht";
import notenbuch from "./manifest";
import { PARENTS_VIEW, STUDENT_VIEW } from "./settings";

const LEA = "u-lea.schaefer"; // Schülerin 7b
const JANA = "u-jana.brandt";
const ADMIN = "u-admin";
const YEAR = "sj-2026-27";

describe("Notenbuch: Schüler-/Elternsicht (P5-14)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let parent = "";
  let other = ""; // Mitschüler:in der 7b
  let otherParent = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    [{ parentId: parent }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    const [o] = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .innerJoin(parentChild, eq(parentChild.childId, users.id))
      .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler"), ne(users.id, LEA), ne(parentChild.parentId, parent)));
    other = o!.id;
    [{ parentId: otherParent }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, other))) as [{ parentId: string }];
    // zwei Bücher: Deutsch (abgeschlossen, Halbjahresnote 2), Mathe (offen, Vorschlag 3, Punkte-Spalte)
    const [d, m] = await h.db
      .insert(notenbuchBooks)
      .values([
        { schoolYearId: YEAR, term: 1, groupId: "g-7b", subjectId: "D", scale: "noten6", weights: { schriftlich: 50, sonstige: 50 }, lockedAt: new Date("2027-01-20T10:00:00Z") },
        { schoolYearId: YEAR, term: 1, groupId: "g-7b", subjectId: "M", scale: "noten6", weights: { schriftlich: 50, sonstige: 50 } },
      ])
      .returning({ id: notenbuchBooks.id });
    await h.db.insert(notenbuchBookTeachers).values([
      { bookId: d!.id, teacherId: JANA },
      { bookId: m!.id, teacherId: JANA },
    ]);
    const [cd, cm] = await h.db
      .insert(notenbuchColumns)
      .values([
        { bookId: d!.id, kind: "sonstige", title: "Referat Balladen", date: "2026-10-01" },
        { bookId: m!.id, kind: "schriftlich", title: "1. Klassenarbeit", date: "2026-10-05", maxPoints: 40 },
      ])
      .returning({ id: notenbuchColumns.id });
    await h.db.insert(notenbuchEntries).values([
      { columnId: cd!.id, studentId: LEA, value: "2", comment: "geheimer Kommentar" },
      { columnId: cm!.id, studentId: LEA, value: "34" },
      { columnId: cd!.id, studentId: other, value: "5", comment: "fremde Note" },
    ]);
    await h.db.insert(notenbuchTermGrades).values([
      { bookId: d!.id, studentId: LEA, computed: "2", final: "2", finalizedAt: new Date() },
      { bookId: m!.id, studentId: LEA, computed: "3", final: "3", finalizedAt: new Date() },
      { bookId: d!.id, studentId: other, computed: "5", final: "5", finalizedAt: new Date() },
    ]);
  }, 60_000);
  afterAll(() => h.close());

  it("Anzeige einer Teilnote (rein): Note, fehlt/befreit, Punkte mit Note aus dem Schlüssel", () => {
    expect(displayEntry("2-", "noten6_tendenz", { maxPoints: null, key: null })).toBe("2-");
    expect(displayEntry("fehlt", "noten6", { maxPoints: 40, key: null })).toBe("fehlt");
    expect(displayEntry("34", "noten6", { maxPoints: 40, key: null })).toBe("34 von 40 Punkten → 1");
    expect(displayEntry("22.5", "punkte15", { maxPoints: 30, key: null })).toBe("22,5 von 30 Punkten → 11");
  });

  it("Vorgabe aus: niemand sieht etwas – Schülerin, Eltern, Lehrkräfte, Admin", async () => {
    for (const id of [LEA, parent, JANA, ADMIN]) {
      expect(await gradeOwners(h.db, await p(id)), id).toEqual([]);
      expect(await familyGrades(h.db, await p(id), LEA), id).toBeNull();
    }
    // Eltern-Schalter allein reicht nicht – ohne Sicht für Schüler:innen bleibt alles aus
    await writeModuleSetting(h.db, PARENTS_VIEW, "10");
    expect(await gradeOwners(h.db, await p(parent))).toEqual([]);
    await writeModuleSetting(h.db, PARENTS_VIEW, "0");
  });

  it("„nur Halbjahresnoten“: nur abgeschlossene Bücher, ohne Teilnoten, Kommentare und Vorschläge", async () => {
    await writeModuleSetting(h.db, STUDENT_VIEW, "halbjahr");
    const view = (await familyGrades(h.db, await p(LEA), LEA))!;
    expect(view.scope).toBe("halbjahr");
    expect(view.books).toEqual([expect.objectContaining({ subjectName: expect.any(String), schoolYearName: "2026/27", term: 1, closed: true, final: "2", grades: [] })]);
    expect(JSON.stringify(view)).not.toMatch(/geheimer|Referat|Klassenarbeit|"computed"|fremde/);
  });

  it("„Teilnoten“: zusätzlich eigene Teilnoten (Punkte mit Note); offene Bücher ohne Halbjahresnote; nie Kommentare", async () => {
    await writeModuleSetting(h.db, STUDENT_VIEW, "teilnoten");
    const view = (await familyGrades(h.db, await p(LEA), LEA))!;
    const byTitle = Object.fromEntries(view.books.flatMap((b) => b.grades.map((g) => [g.title, { ...g, final: b.final, closed: b.closed }])));
    expect(byTitle["Referat Balladen"]).toMatchObject({ display: "2", kind: "Sonstige Leistungen", date: "2026-10-01", final: "2", closed: true });
    // Mathe noch offen: Halbjahresnote „3“ ist festgelegt, aber nicht abgeschlossen → nicht sichtbar
    expect(byTitle["1. Klassenarbeit"]).toMatchObject({ display: "34 von 40 Punkten → 1", final: null, closed: false });
    expect(JSON.stringify(view)).not.toMatch(/geheimer|fremde|"computed"|"comment"|weight/);
  });

  it("fremdes Kind: Schülerin sieht nur sich, Eltern nur verknüpfte Kinder", async () => {
    await writeModuleSetting(h.db, PARENTS_VIEW, "10");
    const lea = await p(LEA);
    expect((await gradeOwners(h.db, lea)).map((o) => o.id)).toEqual([LEA]);
    expect(await familyGrades(h.db, lea, other)).toBeNull();
    expect(await familyGrades(h.db, await p(parent), other)).toBeNull();
    expect(await familyGrades(h.db, await p(otherParent), LEA)).toBeNull();
    const own = (await familyGrades(h.db, await p(otherParent), other))!;
    expect(own.books.map((b) => b.final)).toEqual(["5"]);
    expect(JSON.stringify(own)).not.toMatch(/fremde Note|geheimer/);
    // Lehrkräfte und Admin bekommen hier nichts (sie arbeiten im Notenbuch selbst)
    for (const id of [JANA, ADMIN]) expect(await familyGrades(h.db, await p(id), LEA), id).toBeNull();
  });

  it("Eltern nach Jahrgang: „bis 7“ zeigt das Kind der 7b, „bis 6“ nicht", async () => {
    await writeModuleSetting(h.db, PARENTS_VIEW, "7");
    expect((await gradeOwners(h.db, await p(parent))).map((o) => o.id)).toContain(LEA);
    await writeModuleSetting(h.db, PARENTS_VIEW, "6");
    expect(await gradeOwners(h.db, await p(parent))).toEqual([]);
    expect(await familyGrades(h.db, await p(parent), LEA)).toBeNull();
  });

  it("eigenständige Schülerin: sieht selbst weiter; Eltern nur mit ihrer Einwilligung", async () => {
    await writeModuleSetting(h.db, PARENTS_VIEW, "10");
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, LEA));
    expect((await gradeOwners(h.db, await p(LEA))).map((o) => o.id)).toEqual([LEA]);
    expect(await familyGrades(h.db, await p(parent), LEA)).toBeNull();
    await h.db.update(users).set({ parentsInformedSince: new Date() }).where(eq(users.id, LEA));
    expect(await familyGrades(h.db, await p(parent), LEA)).not.toBeNull();
    await h.db.update(users).set({ selfResponsible: false, parentsInformedSince: null }).where(eq(users.id, LEA));
  });

  it("Navigation: „Noten“ nur bei eingeschalteter Sicht; „Notenbuch“ nur bei ausdrücklichem Recht (Admin-`*` zählt nicht)", () => {
    const states = new Map([["notenbuch", true]]);
    const base: PermissionSet = { userId: "x", role: "schueler", locked: false, granted: new Set(), memberOf: new Set(), leaderOf: new Set() };
    const labels = (perms: PermissionSet, settings?: Map<string, string>) =>
      buildNav([notenbuch], states, perms, { settings })
        .flatMap((g) => g.items)
        .map((i) => i.label);
    expect(labels(base)).toEqual([]);
    expect(labels(base, new Map([["notenbuch.student_view", "aus"]]))).toEqual([]);
    expect(labels(base, new Map([["notenbuch.student_view", "halbjahr"]]))).toEqual(["Noten"]);
    const eltern = { ...base, role: "eltern" as const };
    expect(labels(eltern, new Map([["notenbuch.student_view", "teilnoten"], ["notenbuch.parents_view", "0"]]))).toEqual([]);
    expect(labels(eltern, new Map([["notenbuch.student_view", "teilnoten"], ["notenbuch.parents_view", "7"]]))).toEqual(["Noten"]);
    // Admin mit `*` ohne ausdrückliches Notenbuch-Recht: kein Eintrag; Sekretariat nur mit `export`: Eintrag (P5-16)
    expect(labels({ ...base, role: "admin", granted: new Set(["*"]) })).toEqual([]);
    expect(labels({ ...base, role: "verwaltung", granted: new Set(["notenbuch.export"]) })).toEqual(["Notenbuch"]);
    expect(labels({ ...base, role: "lehrkraft", granted: new Set(["notenbuch.own"]) })).toEqual(["Notenbuch"]);
  });
});
