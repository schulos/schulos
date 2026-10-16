import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { kurswahlWahlen } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAngebot, createVerfahren, getVerfahren, targetStudents, type VerfahrenInput } from "./service";
import { assignManually, explainAllocation, runAllocation, statistics } from "./zuteilen";

const SABINE = "u-sabine.kowalski";
const input: VerfahrenInput = {
  title: "WP I 7b",
  kind: "wp1",
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
};
const offer = (title: string, minSize: number, maxSize: number | null) => ({ title, subjectId: null, level: null, minSize, maxSize, note: null, teacherId: null, hours: null });

describe("Kurswahlen – Zuteilung mit Speicherung", () => {
  let h: DbHandle;
  let id: string;
  let f: string, inf: string, dg: string;
  let students: string[];
  const p = (u: string) => loadPermissions(h.db, u);

  beforeAll(async () => {
    h = await createSeededTestDb();
    id = await createVerfahren(h.db, await p(SABINE), input);
    f = await createAngebot(h.db, await p(SABINE), id, offer("Französisch", 0, 10));
    inf = await createAngebot(h.db, await p(SABINE), id, offer("Informatik", 0, 16));
    dg = await createAngebot(h.db, await p(SABINE), id, offer("Darstellen und Gestalten", 5, null));
    students = (await targetStudents(h.db, input)).map((s) => s.id);
    // 24 von 25 wählen: 14× F vor IF, 8× IF vor F, 2× DG vor F (DG bleibt unter 5 und fällt aus)
    const rows = students.slice(0, 24).map((s, i) => ({ verfahrenId: id, studentId: s, choices: i < 14 ? [f, inf] : i < 22 ? [inf, f] : [dg, f], submittedBy: SABINE, submittedAt: new Date() }));
    await h.db.insert(kurswahlWahlen).values(rows);
  }, 60_000);
  afterAll(() => h.close());

  it("nur die Verwaltung teilt zu; Ergebnis mit Begründung, Ausfall und Restplatz", async () => {
    await expect(runAllocation(h.db, await p("u-jana.brandt"), id)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await runAllocation(h.db, await p(SABINE), id);
    expect(r.offers.find((o) => o.id === dg)).toMatchObject({ cancelled: true, reason: "Darstellen und Gestalten fällt aus: 2 von mindestens 5" });
    expect(r.offers.find((o) => o.id === f)!.count).toBe(10);
    const w = await h.db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, id));
    expect(w.filter((x) => x.assignedId === f)).toHaveLength(10);
    // F-Erstwähler über der Kapazität landen im 2. Wunsch IF; DG-Wähler haben F als 2. Wunsch, F ist voll → Restplatz IF
    expect(w.filter((x) => x.assignedRank === 2 && x.assignedId === inf)).toHaveLength(4);
    expect(w.filter((x) => x.reason?.startsWith("Restplatz"))).toHaveLength(2);
    expect(w.find((x) => x.choices[0] === dg)!.reason).toBe("Restplatz – 1. Wunsch „Darstellen und Gestalten“ fällt aus, 2. Wunsch „Französisch“ voll");
    const v = (await getVerfahren(h.db, id))!;
    expect(v.allocationSeed).toBeTruthy();
    // gleicher Seed → gleiches Ergebnis; Erklärung rechnet nach
    const again = await runAllocation(h.db, await p(SABINE), id);
    expect(again.assignments).toEqual(r.assignments);
    expect((await explainAllocation(h.db, await p(SABINE), v))!.log).toEqual(r.log);
  });

  it("Korrektur von Hand bleibt bei einer neuen Zuteilung, auch für Nichtwähler", async () => {
    const [someone] = (await h.db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.assignedId, f))).filter((x) => x.choices[0] === f);
    await assignManually(h.db, await p(SABINE), id, someone!.studentId, inf);
    const nonVoter = students[24]!;
    await assignManually(h.db, await p(SABINE), id, nonVoter, f);
    await expect(assignManually(h.db, await p(SABINE), id, nonVoter, "x")).rejects.toBeInstanceOf(ValidationError);
    await runAllocation(h.db, await p(SABINE), id, { newSeed: true });
    const w = await h.db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, id));
    expect(w.find((x) => x.studentId === someone!.studentId)).toMatchObject({ assignedId: inf, assignedRank: 2, manual: true, reason: "von Hand zugeteilt (2. Wunsch)" });
    expect(w.find((x) => x.studentId === nonVoter)).toMatchObject({ assignedId: f, manual: true });
    expect(w.filter((x) => x.assignedId === f)).toHaveLength(10);
  });

  it("Statistik: Nachfrage je Rang und Zugeteilte", async () => {
    const v = (await getVerfahren(h.db, id))!;
    const stats = await statistics(h.db, await p(SABINE), v);
    expect(stats.map((s) => [s.title, s.demand.byRank, s.assigned])).toEqual([
      ["Französisch", [14, 10], 10],
      ["Informatik", [8, 14], 15],
      ["Darstellen und Gestalten", [2, 0], 0],
    ]);
  });
});
