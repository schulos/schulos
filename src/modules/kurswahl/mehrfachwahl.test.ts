import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, kurswahlWahlen, parentChild } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { missing } from "./erinnerung";
import {
  checkPlaces,
  createAngebot,
  createVerfahren,
  deleteAngebot,
  familyOverview,
  getVerfahren,
  getWahlPlaces,
  listAngebote,
  offerShortage,
  submitChoices,
  targetStudents,
  updateVerfahren,
  wahlRows,
  type VerfahrenInput,
} from "./service";
import { transfer, transferPreview } from "./uebernahme";
import { progress } from "./uebersicht";
import { assignManually, assignmentLines, runAllocation, statistics } from "./zuteilen";

// P4-67: Mehrfachwahl – „Anzahl Kurse je Person“ (Mindest-/Höchstzahl), je Platz eigene Wünsche, Zuteilung ohne doppelten Kurs,
// Übernahme in mehrere Gruppen.
const SABINE = "u-sabine.kowalski";
const LEA = "u-lea.schaefer";
const OPEN = "2026-11-05";
const AFTER = "2026-11-20";
const input: VerfahrenInput = {
  title: "AGs 7b",
  kind: "ag",
  note: null,
  gradeLevel: 7,
  classIds: ["g-7b"],
  courseGrade: 7,
  schoolYearId: null,
  opensOn: "2026-11-01",
  closesOn: "2026-11-15",
  choices: 2,
  chooser: "eltern",
  parentConfirm: false,
  minCourses: 1,
  maxCourses: 2,
};
const offer = (title: string, maxSize: number | null = null) => ({
  title,
  subjectId: null,
  level: null,
  minSize: 0,
  maxSize,
  note: null,
  teacherId: null,
  hours: null,
});

describe("Kurswahlen – Mehrfachwahl (P4-67)", () => {
  let h: DbHandle;
  let id: string;
  let chess: string;
  let choir: string;
  let robots: string;
  let mother: string;
  const p = (u: string) => loadPermissions(h.db, u);

  beforeAll(async () => {
    h = await createSeededTestDb();
    id = await createVerfahren(h.db, await p(SABINE), input);
    chess = await createAngebot(h.db, await p(SABINE), id, offer("AG Schach", 2));
    choir = await createAngebot(h.db, await p(SABINE), id, offer("AG Chor"));
    robots = await createAngebot(h.db, await p(SABINE), id, offer("AG Robotik"));
    [{ parentId: mother }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [
      { parentId: string },
    ];
  }, 60_000);
  afterAll(() => h.close());

  it("Einstellung: Mindest-/Höchstzahl 1–6, Mindestzahl ≤ Höchstzahl", async () => {
    await expect(createVerfahren(h.db, await p(SABINE), { ...input, minCourses: 3, maxCourses: 2 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createVerfahren(h.db, await p(SABINE), { ...input, minCourses: 1, maxCourses: 7 })).rejects.toBeInstanceOf(ValidationError);
    const v = (await getVerfahren(h.db, id))!;
    expect([v.minCourses, v.maxCourses]).toEqual([1, 2]);
  });

  it("Prüfung der Plätze (rein): Anzahl, Wünsche je Platz, kein Kurs zweimal als 1. Wunsch", () => {
    const ids = new Set(["A", "B", "C"]);
    const v = { minCourses: 2, maxCourses: 3 };
    expect(checkPlaces(v, 2, ids, [["A", "B"]])).toEqual({ error: "Bitte mindestens 2 Kurse wählen" });
    expect(checkPlaces(v, 2, ids, [["A", "B"], ["B"]])).toEqual({ error: "Kurs 2: bitte 2 verschiedene Wünsche wählen" });
    expect(
      checkPlaces(v, 2, ids, [
        ["A", "B"],
        ["A", "C"],
      ]),
    ).toEqual({ error: "Jeden Kurs nur einmal als 1. Wunsch – niemand bekommt einen Kurs doppelt" });
    expect(
      checkPlaces(v, 2, ids, [
        ["A", "B"],
        ["B", "A"],
        ["C", "A"],
        ["A", "C"],
      ]),
    ).toEqual({ error: "Höchstens 3 Kurse" });
    // leere Plätze am Ende zählen nicht; der 2. Wunsch darf auf mehreren Plätzen stehen
    expect(
      checkPlaces(v, 2, ids, [
        ["A", "B"],
        ["B", "A"],
        ["", ""],
      ]),
    ).toEqual({
      places: [
        ["A", "B"],
        ["B", "A"],
      ],
    });
    // ein Kurs je Person: alte Meldungen bleiben
    expect(checkPlaces({ minCourses: 1, maxCourses: 1 }, 1, ids, [[]])).toEqual({ error: "Bitte einen Wunsch wählen" });
  });

  it("Familie wählt zwei Kurse (je Platz zwei Wünsche); ein Platz weniger löscht die Zeile; Fortschritt zählt Personen", async () => {
    await submitChoices(
      h.db,
      await p(mother),
      id,
      LEA,
      [
        [chess, choir],
        [choir, robots],
      ],
      OPEN,
    );
    expect((await getWahlPlaces(h.db, id, LEA)).map((w) => [w.place, w.choices])).toEqual([
      [1, [chess, choir]],
      [2, [choir, robots]],
    ]);
    const fam = (await familyOverview(h.db, await p(mother), OPEN)).find((f) => f.verfahren.id === id)!;
    expect(fam.places).toHaveLength(2);
    // nur noch ein Kurs (Mindestzahl 1)
    await submitChoices(h.db, await p(mother), id, LEA, [[chess, choir], []], OPEN);
    expect(await getWahlPlaces(h.db, id, LEA)).toHaveLength(1);
    await submitChoices(
      h.db,
      await p(mother),
      id,
      LEA,
      [
        [chess, choir],
        [choir, robots],
      ],
      OPEN,
    );
    const v = (await getVerfahren(h.db, id))!;
    expect((await progress(h.db, v)).submitted).toBe(1);
    expect((await missing(h.db, id)).notChosen).not.toContain(LEA);
    // Anzahl der Kurse fest, sobald gewählt wurde
    await expect(updateVerfahren(h.db, await p(SABINE), id, { ...input, maxCourses: 3 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Zuteilung ohne doppelten Kurs, deterministisch; Statistik zählt alle Plätze; von Hand je Platz", async () => {
    const target = (await targetStudents(h.db, input)).map((s) => s.id).filter((s) => s !== LEA);
    const now = new Date();
    // vier weitere wählen Schach + Chor als 1. Wünsche, zwei davon nur einen Kurs
    await h.db
      .insert(kurswahlWahlen)
      .values([
        ...target.slice(0, 4).map((s) => ({ verfahrenId: id, studentId: s, place: 1, choices: [chess, robots], submittedBy: SABINE, submittedAt: now })),
        ...target.slice(0, 2).map((s) => ({ verfahrenId: id, studentId: s, place: 2, choices: [chess, choir], submittedBy: SABINE, submittedAt: now })),
      ]);
    const r1 = await runAllocation(h.db, await p(SABINE), id);
    const rows = await h.db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, id));
    const per = new Map<string, string[]>();
    for (const w of rows) if (w.assignedId) per.set(w.studentId, [...(per.get(w.studentId) ?? []), w.assignedId]);
    for (const [, got] of per) expect(new Set(got).size).toBe(got.length);
    // Schach hat 2 Plätze für 5 Bewerbungen auf dem 1. Platz – Los, Rest bekommt den 2. Wunsch
    expect(rows.filter((w) => w.assignedId === chess)).toHaveLength(2);
    expect(r1.log.some((l) => l.startsWith("AG Schach, 1. Wunsch"))).toBe(true);
    // gleiche Wahlen, gleicher Seed → gleiches Ergebnis
    const r2 = await runAllocation(h.db, await p(SABINE), id);
    expect(r2.assignments).toEqual(r1.assignments);
    const v = (await getVerfahren(h.db, id))!;
    const stats = await statistics(h.db, await p(SABINE), v);
    expect(stats.find((s) => s.id === choir)!.demand.total).toBeGreaterThanOrEqual(3);
    expect(stats.reduce((n, s) => n + s.assigned, 0)).toBe(rows.filter((w) => w.assignedId).length);
    // von Hand: Lea auf Platz 2 in Robotik; ein Kurs, den sie auf Platz 1 hat, geht nicht noch einmal
    const lea1 = (await getWahlPlaces(h.db, id, LEA))[0]!.assignedId!;
    await expect(assignManually(h.db, await p(SABINE), id, LEA, lea1, 2)).rejects.toMatchObject({
      fieldErrors: { offerId: "Diesen Kurs hat die Person schon auf einem anderen Platz" },
    });
    await expect(assignManually(h.db, await p(SABINE), id, LEA, robots, 3)).rejects.toMatchObject({ fieldErrors: { offerId: "Unbekannter Platz" } });
    if (lea1 !== robots) {
      await assignManually(h.db, await p(SABINE), id, LEA, robots, 2);
      expect((await getWahlPlaces(h.db, id, LEA))[1]).toMatchObject({ assignedId: robots, manual: true });
    }
    const wr = (await wahlRows(h.db, await p(SABINE), v)).find((r) => r.student.id === LEA)!;
    expect(wr.places).toHaveLength(2);
  });

  it("Übernahme: Personen kommen in mehrere Gruppen; Hinweis bei weniger Kursen als die Mindestzahl", async () => {
    // Mindestzahl 2 ist nach der Wahl nicht mehr einstellbar – für den Hinweis direkt setzen
    const v = (await getVerfahren(h.db, id))!;
    await runAllocation(h.db, await p(SABINE), id);
    const prev = await transferPreview(h.db, await p(SABINE), { ...v, minCourses: 2, allocatedAt: new Date() });
    expect(prev.conflicts.some((c) => c.kind === "zu_wenig")).toBe(true);
    await transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, AFTER);
    const offers = await listAngebote(h.db, id);
    const groupsOfLea = await h.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.userId, LEA),
          // nur die Gruppen dieser Kurswahl
          eq(groupMembers.role, "member"),
        ),
      );
    const kursGroups = new Set(offers.map((o) => o.groupId).filter(Boolean));
    expect(groupsOfLea.filter((g) => kursGroups.has(g.groupId))).toHaveLength(2);
  });

  it("G4E-C04/C05/C06: Höchstzahl nie unter Zuteilungen von Hand; alle Plätze in der Liste; zu wenige Angebote", async () => {
    const sab = await p(SABINE);
    const before = "2026-10-20";
    const base = { ...input, title: "AGs 7b (zwei)" };
    const v2 = await createVerfahren(h.db, sab, base);
    const a = await createAngebot(h.db, sab, v2, offer("AG A"));
    const b = await createAngebot(h.db, sab, v2, offer("AG B"));
    // vor Wahlbeginn: Förderkurs von Hand auf Platz 2, danach soll die Höchstzahl auf 1 – abgelehnt
    await assignManually(h.db, sab, v2, LEA, b, 2);
    await expect(updateVerfahren(h.db, sab, v2, { ...base, maxCourses: 1 }, before)).rejects.toMatchObject({
      fieldErrors: { maxCourses: expect.stringMatching(/Kurs 2/) },
    });
    // nach dem Aufheben geht es; die leere Zeile verschwindet mit
    await assignManually(h.db, sab, v2, LEA, null, 2);
    await updateVerfahren(h.db, sab, v2, { ...base, maxCourses: 1 }, before);
    expect((await h.db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, v2))).filter((w) => w.place > 1)).toEqual([]);
    // Altbestand/gleichzeitiges Senken: eine Zeile über der Höchstzahl zählt nirgends (Statistik, Übernahme)
    await h.db.insert(kurswahlWahlen).values({ verfahrenId: v2, studentId: LEA, place: 2, choices: [], assignedId: b, manual: true, reason: "von Hand" });
    let v = (await getVerfahren(h.db, v2))!;
    expect((await statistics(h.db, sab, v)).find((s) => s.id === b)!.assigned).toBe(0);
    expect((await transferPreview(h.db, sab, v)).groups.flatMap((g) => g.students)).not.toContain(LEA);
    await h.db.delete(kurswahlWahlen).where(and(eq(kurswahlWahlen.verfahrenId, v2), eq(kurswahlWahlen.place, 2)));

    // C05: bei Mehrfachwahl je Person alle Plätze bis zur Höchstzahl – auch ohne Wahl lässt sich Platz 2/3 zuteilen
    await updateVerfahren(h.db, sab, v2, { ...base, maxCourses: 3 }, before);
    v = (await getVerfahren(h.db, v2))!;
    const lines = assignmentLines(await wahlRows(h.db, sab, v), v.maxCourses).filter((l) => l.r.student.id === LEA);
    expect(lines.map((l) => [l.place, l.w])).toEqual([
      [1, null],
      [2, null],
      [3, null],
    ]);
    expect(assignmentLines(await wahlRows(h.db, sab, v), 1).filter((l) => l.r.student.id === LEA)).toHaveLength(1);

    // C06: mehr Pflicht-Kurse als Angebote
    expect(offerShortage({ minCourses: 3 }, 2)).toMatch(/nur 2 Angebote/);
    expect(offerShortage({ minCourses: 2 }, 2)).toBeNull();
    expect(checkPlaces({ minCourses: 3, maxCourses: 3 }, 1, new Set([a, b]), [[a], [b]])).toEqual({ error: expect.stringMatching(/weniger Angebote/) });
    await updateVerfahren(h.db, sab, v2, { ...base, minCourses: 2, maxCourses: 3 }, before);
    // während der Wahl: Mindestzahl nicht über die Angebote, letztes nötiges Angebot nicht löschen
    await expect(updateVerfahren(h.db, sab, v2, { ...base, minCourses: 3, maxCourses: 3 }, OPEN)).rejects.toMatchObject({
      fieldErrors: { minCourses: expect.stringMatching(/nur 2 Angebote/) },
    });
    await expect(deleteAngebot(h.db, sab, b, OPEN)).rejects.toMatchObject({ fieldErrors: { title: expect.stringMatching(/Die Wahl läuft/) } });
    // vor Wahlbeginn geht beides (die Detailseite warnt)
    await deleteAngebot(h.db, sab, b, before);
    expect(await listAngebote(h.db, v2)).toHaveLength(1);
  });
});
