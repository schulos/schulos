import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { exams, groupMembers, notifications, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createExam, deleteExam, examIndex, examLabel, listExams, plannableExamGroups, ruleViolations, type ExamInput } from "./service";

const TODAY = "2026-10-03";
const base: ExamInput = { groupId: "g-7b", subjectId: "D", kind: "klassenarbeit", title: "1. Klassenarbeit", date: "2026-10-12", periodFrom: 1, periodTo: 2, roomId: null, override: false };

describe("Klausurplan", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(exams);
  }, 60_000);
  afterAll(() => h.close());

  it("Lehrkraft plant für eigene Unterrichtsgruppen, nicht für fremde", async () => {
    const jana = await p("u-jana.brandt");
    const own = (await plannableExamGroups(h.db, jana)).map((g) => g.id);
    expect(own).toContain("g-7b");
    expect(own).toContain("g-q1-e-gk1");
    await expect(createExam(h.db, await p("u-daniel.okafor"), { ...base, groupId: "g-q1-e-gk1" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("legt eine Arbeit an, Gong an die Klasse", async () => {
    await createExam(h.db, await p("u-jana.brandt"), base, TODAY);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-lea.schaefer"), eq(notifications.moduleId, "klausurplan")));
    expect(gong.map((g) => g.title)).toEqual(["Klassenarbeit Deutsch: Mo., 12.10."]);
  });

  it("höchstens eine am Tag und drei in der Woche – Schulleitung darf Ausnahmen genehmigen", async () => {
    const jana = await p("u-jana.brandt");
    try {
      await createExam(h.db, jana, { ...base, subjectId: "E", title: "1. Klassenarbeit Englisch" }, TODAY);
      throw new Error("erwartet ValidationError");
    } catch (err) {
      expect((err as ValidationError).fieldErrors.date).toBe("Alle Schüler:innen der Gruppe haben an diesem Tag schon eine Arbeit: Deutsch (Klasse 7b)");
    }
    await createExam(h.db, jana, { ...base, subjectId: "E", date: "2026-10-13" }, TODAY);
    await createExam(h.db, jana, { ...base, subjectId: "D", title: "Test", kind: "test", date: "2026-10-14" }, TODAY);
    expect(await ruleViolations(h.db, "g-7b", "2026-10-15")).toEqual(["Alle Schüler:innen der Gruppe haben in dieser Woche schon 3 Arbeiten"]);
    await expect(createExam(h.db, await p("u-jana.brandt"), { ...base, date: "2026-10-15", override: true }, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await createExam(h.db, await p("u-petra.lindner"), { ...base, subjectId: "GE", date: "2026-10-15", override: true }, TODAY);
  });

  it("Oberstufe: Regel gilt je Schüler:in über alle Kurse", async () => {
    const jana = await p("u-jana.brandt");
    await createExam(h.db, jana, { ...base, groupId: "g-q1-e-gk1", subjectId: "E", kind: "klausur", title: "Klausur 1", date: "2026-10-20" }, TODAY);
    // Teilmenge der Q1 im Deutsch-GK: wer auch im Englisch-GK sitzt, hätte zwei Klausuren an einem Tag
    const [eng, deu] = await Promise.all(
      ["g-q1-e-gk1", "g-q1-d-gk1"].map(async (g) =>
        (await h.db.select({ id: groupMembers.userId }).from(groupMembers).innerJoin(users, eq(users.id, groupMembers.userId)).where(and(eq(groupMembers.groupId, g), eq(users.role, "schueler")))).map((r) => r.id),
      ),
    );
    const overlap = deu!.filter((s) => eng!.includes(s)).length;
    expect(overlap).toBeGreaterThan(0);
    expect(await ruleViolations(h.db, "g-q1-d-gk1", "2026-10-20")).toEqual([`${overlap} Schüler:innen haben an diesem Tag schon eine Arbeit: Englisch (Q1 Englisch GK1)`]);
  });

  it("validiert Datum und Stunden; sichtbar für Klasse und Eltern, nicht für fremde Schüler:innen", async () => {
    const jana = await p("u-jana.brandt");
    await expect(createExam(h.db, jana, { ...base, date: "2026-10-02" }, TODAY)).rejects.toMatchObject({ fieldErrors: { date: expect.stringContaining("Vergangenheit") } });
    await expect(createExam(h.db, jana, { ...base, date: "2026-10-17" }, TODAY)).rejects.toMatchObject({ fieldErrors: { date: expect.stringContaining("Wochenende") } });
    await expect(createExam(h.db, jana, { ...base, date: "2026-10-19", periodFrom: 3, periodTo: 2 }, TODAY)).rejects.toMatchObject({ fieldErrors: { periodFrom: expect.any(String) } });
    const lea = await listExams(h.db, await p("u-lea.schaefer"), "2026-10-12", "2026-10-17");
    expect(lea.map((e) => `${e.date} ${e.subjectName}`)).toEqual(["2026-10-12 Deutsch", "2026-10-13 Englisch", "2026-10-14 Deutsch", "2026-10-15 Geschichte"]);
    expect(lea[0]).toMatchObject({ startsAt: "08:00", endsAt: "09:35", teacherCode: "BRA" });
    const fremd = (await h.db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, "g-9a")))[5]!.id;
    expect(await listExams(h.db, await p(fremd), "2026-10-12", "2026-10-17")).toEqual([]);
    expect(examIndex(lea).get("g-7b:2026-10-12:2")!.title).toBe("1. Klassenarbeit");
    expect(examLabel(lea[0]!, "D")).toBe("Klassenarbeit · 1. Klassenarbeit");
    expect(examLabel(lea[0]!, "KU")).toBe("Klassenarbeit Deutsch · 1. Klassenarbeit");
  });

  it("löschen: eigene oder mit manage", async () => {
    const [mine] = await listExams(h.db, await p("u-jana.brandt"), "2026-10-12", "2026-10-13");
    await expect(deleteExam(h.db, await p("u-daniel.okafor"), mine!.id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteExam(h.db, await p("u-jana.brandt"), mine!.id);
    expect(await listExams(h.db, await p("u-jana.brandt"), "2026-10-12", "2026-10-13")).toEqual([]);
  });
});
