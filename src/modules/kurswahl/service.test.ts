import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  choosersOf,
  confirmChoice,
  createAngebot,
  createVerfahren,
  deleteAngebot,
  familyOverview,
  getVerfahren,
  getWahl,
  listAngebote,
  roleFor,
  submitChoice,
  targetStudents,
  updateVerfahren,
  verfahrenState,
  wahlRows,
  type AngebotInput,
  type VerfahrenInput,
} from "./service";

const TODAY = "2026-11-02";
const LEA = "u-lea.schaefer";
const SABINE = "u-sabine.kowalski";
const input: VerfahrenInput = {
  title: "WP I Jahrgang 7",
  kind: "wp1",
  note: null,
  gradeLevel: 7,
  classIds: [],
  courseGrade: 7,
  schoolYearId: null,
  opensOn: "2026-11-01",
  closesOn: "2026-11-15",
  choices: 3,
  chooser: "eltern",
  parentConfirm: false,
};
const offer = (title: string, subjectId: string | null, extra: Partial<AngebotInput> = {}): AngebotInput => ({
  title,
  subjectId,
  level: null,
  minSize: 0,
  maxSize: null,
  note: null,
  teacherId: null,
  hours: null,
  ...extra,
});

describe("Kurswahlen – Verfahren, Angebote, Wahl", () => {
  let h: DbHandle;
  let id: string;
  let offers: string[];
  let mother: string;
  const p = (u: string) => loadPermissions(h.db, u);

  beforeAll(async () => {
    h = await createSeededTestDb();
    [{ parentId: mother }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
  }, 60_000);
  afterAll(() => h.close());

  it("nur die Verwaltung legt Verfahren und Angebote an; Prüfungen der Eingaben", async () => {
    await expect(createVerfahren(h.db, await p("u-jana.brandt"), input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createVerfahren(h.db, await p(SABINE), { ...input, closesOn: "2026-10-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createVerfahren(h.db, await p(SABINE), { ...input, classIds: ["g-8a"] })).rejects.toBeInstanceOf(ValidationError);
    id = await createVerfahren(h.db, await p(SABINE), input);
    const v = (await getVerfahren(h.db, id))!;
    expect(verfahrenState(v, "2026-10-31")).toBe("geplant");
    expect(verfahrenState(v, TODAY)).toBe("offen");
    expect(verfahrenState(v, "2026-11-16")).toBe("geschlossen");
    await expect(createAngebot(h.db, await p(SABINE), id, offer("Zu klein", null, { minSize: 10, maxSize: 5 }))).rejects.toBeInstanceOf(ValidationError);
    offers = [];
    for (const [t, s] of [
      ["Französisch", "F"],
      ["Naturwissenschaften", "BI"],
      ["Darstellen und Gestalten", "KU"],
      ["Informatik", "IF"],
    ] as const)
      offers.push(await createAngebot(h.db, await p(SABINE), id, offer(t, s, { maxSize: 28 })));
    expect((await listAngebote(h.db, id)).map((a) => a.title)).toEqual(["Französisch", "Naturwissenschaften", "Darstellen und Gestalten", "Informatik"]);
  });

  it("Zielgruppe: alle Klassen des Jahrgangs bzw. die gewählten", async () => {
    const all = await targetStudents(h.db, { gradeLevel: 7, classIds: [] });
    expect(all).toHaveLength(50);
    expect(all.find((s) => s.id === LEA)?.className).toBe("7b");
    expect(await targetStudents(h.db, { gradeLevel: 7, classIds: ["g-7a"] })).toHaveLength(25);
  });

  it("Eltern wählen für ihr minderjähriges Kind; das Kind liest nur; fremde Eltern gar nicht", async () => {
    const v = (await getVerfahren(h.db, id))!;
    expect(await roleFor(h.db, await p(mother), v, LEA)).toBe("waehlt");
    expect(await roleFor(h.db, await p(LEA), v, LEA)).toBe("liest");
    await expect(submitChoice(h.db, await p(LEA), id, LEA, offers.slice(0, 3), TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    const [stranger] = await h.db.select({ id: users.id }).from(users).where(and(eq(users.role, "eltern")));
    if (stranger!.id !== mother) await expect(submitChoice(h.db, await p(stranger!.id), id, LEA, offers.slice(0, 3), TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    // zu wenige, doppelte, fremde Angebote
    await expect(submitChoice(h.db, await p(mother), id, LEA, offers.slice(0, 2), TODAY)).rejects.toBeInstanceOf(ValidationError);
    await expect(submitChoice(h.db, await p(mother), id, LEA, [offers[0]!, offers[0]!, offers[1]!], TODAY)).rejects.toBeInstanceOf(ValidationError);
    await expect(submitChoice(h.db, await p(mother), id, LEA, [offers[0]!, offers[1]!, "x"], TODAY)).rejects.toBeInstanceOf(ValidationError);
    // außerhalb des Zeitraums
    await expect(submitChoice(h.db, await p(mother), id, LEA, offers.slice(0, 3), "2026-11-16")).rejects.toBeInstanceOf(ValidationError);
    await submitChoice(h.db, await p(mother), id, LEA, [offers[1]!, offers[0]!, offers[3]!], TODAY);
    expect((await getWahl(h.db, id, LEA))!.choices).toEqual([offers[1], offers[0], offers[3]]);
    const mine = await familyOverview(h.db, await p(mother), TODAY);
    expect(mine.map((m) => [m.student.id, m.role])).toEqual([[LEA, "waehlt"]]);
  });

  it("nach der ersten Wahl bleibt die Zielgruppe fest; ein gelöschtes Angebot fällt aus den Wünschen", async () => {
    await expect(updateVerfahren(h.db, await p(SABINE), id, { ...input, classIds: ["g-7a"] })).rejects.toBeInstanceOf(ValidationError);
    await updateVerfahren(h.db, await p(SABINE), id, { ...input, title: "WP I – Jahrgang 7" });
    await deleteAngebot(h.db, await p(SABINE), offers[3]!);
    expect((await getWahl(h.db, id, LEA))!.choices).toEqual([offers[1], offers[0]]);
    offers.pop();
  });

  it("Schüler:innen wählen, Eltern bestätigen mit Häkchen (Gong); eine Änderung hebt die Bestätigung auf", async () => {
    const sv = await createVerfahren(h.db, await p(SABINE), { ...input, title: "Religion/PP 7", kind: "religion_pp", choices: 1, chooser: "schueler", parentConfirm: true });
    const rel = await createAngebot(h.db, await p(SABINE), sv, offer("Ev. Religion", "REL"));
    const pp = await createAngebot(h.db, await p(SABINE), sv, offer("Praktische Philosophie", null));
    const v = (await getVerfahren(h.db, sv))!;
    expect(await roleFor(h.db, await p(LEA), v, LEA)).toBe("waehlt");
    expect(await roleFor(h.db, await p(mother), v, LEA)).toBe("bestaetigt");
    await expect(confirmChoice(h.db, await p(mother), sv, LEA, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await submitChoice(h.db, await p(LEA), sv, LEA, [pp], TODAY);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, mother), eq(notifications.moduleId, "kurswahl")));
    expect(gong.map((g) => g.title)).toEqual(["Kurswahl bestätigen: Lea Schäfer"]);
    await expect(confirmChoice(h.db, await p(LEA), sv, LEA, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await confirmChoice(h.db, await p(mother), sv, LEA, TODAY);
    expect((await getWahl(h.db, sv, LEA))!.confirmedBy).toBe(mother);
    await submitChoice(h.db, await p(LEA), sv, LEA, [rel], TODAY);
    expect((await getWahl(h.db, sv, LEA))!.confirmedBy).toBeNull();
  });

  it("Volljährige wählen selbst, ihre Eltern nicht mehr (informiert: nur lesen)", async () => {
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, LEA));
    const v = (await getVerfahren(h.db, id))!;
    expect(await roleFor(h.db, await p(LEA), v, LEA)).toBe("waehlt");
    expect(await roleFor(h.db, await p(mother), v, LEA)).toBeNull();
    expect(await choosersOf(h.db, v, [LEA])).toEqual([LEA]);
    await h.db.update(users).set({ parentsInformedSince: new Date() }).where(eq(users.id, LEA));
    expect(await roleFor(h.db, await p(mother), v, LEA)).toBe("liest");
    await expect(submitChoice(h.db, await p(mother), id, LEA, offers.slice(0, 3), TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await h.db.update(users).set({ selfResponsible: false, parentsInformedSince: null }).where(eq(users.id, LEA));
    expect(await choosersOf(h.db, v, [LEA])).toEqual([mother]);
  });

  it("die Verwaltung sieht alle Wahlen der Zielgruppe, sonst niemand", async () => {
    const v = (await getVerfahren(h.db, id))!;
    await expect(wahlRows(h.db, await p(mother), v)).rejects.toBeInstanceOf(ForbiddenError);
    const rows = await wahlRows(h.db, await p(SABINE), v);
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r.wahl?.submittedAt)).toHaveLength(1);
  });
});
