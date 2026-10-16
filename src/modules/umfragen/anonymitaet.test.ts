// Review 2026-10-10: Anonymität bei Schnell- und normalen Umfragen (Fünferschritte, kein Umbau nach Antworten, CSV).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, surveyQuestions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { answerQuickPoll, pollState, startQuickPoll } from "./schnell";
import { createSurvey, deleteSurvey, updateSurvey, type SurveyInput } from "./service";
import { countedOf, csvCell, results, resultsCsv, submitResponse } from "./teilnahme";

const NOW = new Date("2026-10-05T08:00:00Z");
const later = (s: number) => new Date(NOW.getTime() + s * 1000);
const base: SurveyInput = {
  title: "Klassenfahrt",
  description: "",
  anonymous: true,
  opensAt: new Date("2026-10-05T06:00:00Z"),
  closesAt: new Date("2026-10-12T20:00:00Z"),
  targets: { roles: [], groups: [{ groupId: "g-7b", parents: false }] },
  questions: [
    { kind: "single", text: "Ziel?", options: ["Meer", "Berge"], required: true },
    { kind: "text", text: "Wünsche?", options: [], required: false },
  ],
};

describe("Umfragen: Anonymität (Review 2026-10-10)", () => {
  let h: DbHandle;
  let students: string[];
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    students = (
      await h.db
        .select({ id: groupMembers.userId })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler")))
    ).map((r) => r.id);
  }, 60_000);
  afterAll(() => h.close());

  it("Fünferschritte: eingerechnet werden nur volle Fünfer", () => {
    expect([0, 4, 5, 9, 10, 17].map(countedOf)).toEqual([0, 0, 5, 5, 10, 15]);
  });

  it("Schnellumfrage: Verteilung ändert sich erst mit der nächsten vollen Fünfergruppe", async () => {
    const id = await startQuickPoll(h.db, await p("u-jana.brandt"), "g-7b", { question: "Pause?", options: ["Ja", "Nein"], minutes: 10 }, NOW);
    for (const sid of students.slice(0, 5)) await answerQuickPoll(h.db, await p(sid), id, 0, later(10));
    expect(await pollState(h.db, id, later(20))).toMatchObject({ total: 5, counted: 5, counts: [5, 0] });
    // die sechste Antwort ist sofort gezählt, verrät aber nicht, was gewählt wurde
    await answerQuickPoll(h.db, await p(students[5]!), id, 1, later(30));
    expect(await pollState(h.db, id, later(40))).toMatchObject({ total: 6, counted: 5, counts: [5, 0] });
  });

  it("Schnellumfragen lassen sich nicht bearbeiten (nur löschen)", async () => {
    const jana = await p("u-jana.brandt");
    const id = await startQuickPoll(h.db, jana, "g-7b", { question: "Fertig?", options: ["Ja", "Nein"], minutes: 5 }, NOW);
    await expect(updateSurvey(h.db, jana, id, { ...base, anonymous: false }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteSurvey(h.db, jana, id);
  });

  it("anonym: Zielgruppen nach der ersten Antwort fest, Ergebnisse und CSV nur über volle Fünfer", async () => {
    const jana = await p("u-jana.brandt");
    const id = await createSurvey(h.db, jana, base, NOW);
    const [q] = await h.db.select().from(surveyQuestions).where(and(eq(surveyQuestions.surveyId, id), eq(surveyQuestions.position, 0)));
    const [t] = await h.db.select().from(surveyQuestions).where(and(eq(surveyQuestions.surveyId, id), eq(surveyQuestions.position, 1)));
    // vor der ersten Antwort darf noch alles geändert werden
    await updateSurvey(h.db, jana, id, { ...base, targets: { roles: ["schueler"], groups: [] } }, NOW);
    await updateSurvey(h.db, jana, id, base, NOW);
    const [q2] = await h.db.select().from(surveyQuestions).where(and(eq(surveyQuestions.surveyId, id), eq(surveyQuestions.position, 0)));
    const [t2] = await h.db.select().from(surveyQuestions).where(and(eq(surveyQuestions.surveyId, id), eq(surveyQuestions.position, 1)));
    expect(q2!.id).not.toBe(q!.id); // Fragen ohne Antworten werden ersetzt
    for (const [i, sid] of students.slice(0, 7).entries())
      await submitResponse(h.db, await p(sid), id, { [q2!.id]: { choices: [i < 5 ? 0 : 1] }, [t2!.id]: { text: i === 6 ? "=HYPERLINK(1)" : "" } }, NOW);
    expect(t).toBeDefined();

    const res = await results(h.db, jana, id, NOW);
    expect(res).toMatchObject({ total: 7, counted: 5, hidden: false });
    expect(res.questions[0]!.options).toEqual([
      { label: "Meer", count: 5 },
      { label: "Berge", count: 0 },
    ]);
    const csv = await resultsCsv(h.db, jana, id, NOW);
    expect(csv.body.trim().split("\r\n")).toHaveLength(1 + 5);
    expect(csv.body).not.toContain("HYPERLINK");

    await expect(updateSurvey(h.db, jana, id, { ...base, targets: { roles: [], groups: [{ groupId: "g-7b", parents: true }] } }, NOW)).rejects.toBeInstanceOf(ValidationError);
    // Titel/Zeitraum bleiben änderbar, solange die Zielgruppen gleich bleiben
    await updateSurvey(h.db, jana, id, { ...base, title: "Klassenfahrt 2027" }, NOW);
  });

  it("CSV entschärft Formeln am Zellanfang", () => {
    expect(["=1+1", "+49 170", "-2", "@SUMME(A1)", "\tx", "normal", 'a"b;c'].map(csvCell)).toEqual(["'=1+1", "'+49 170", "'-2", "'@SUMME(A1)", "'\tx", "normal", '"a""b;c"']);
  });
});
