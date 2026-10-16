import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, notifications, surveyAnswers, surveyParticipation, surveyQuestions, surveyResponses, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createSurvey, type SurveyInput } from "./service";
import { checkAnswers, MIN_ANONYMOUS, remindNonParticipants, results, resultsCsv, submitResponse } from "./teilnahme";

const NOW = new Date("2026-10-05T08:00:00Z");
const base: SurveyInput = {
  title: "Projektwoche",
  description: "",
  anonymous: true,
  opensAt: new Date("2026-10-05T06:00:00Z"),
  closesAt: new Date("2026-10-12T20:00:00Z"),
  targets: { roles: [], groups: [{ groupId: "g-7b", parents: false }] },
  questions: [
    { kind: "single", text: "Gefallen?", options: ["Ja", "Nein"], required: true },
    { kind: "multi", text: "Was war gut?", options: ["Essen", "Programm", "Wetter"], required: false },
    { kind: "scale", text: "Gelernt?", options: [], required: true },
    { kind: "text", text: "Ändern?", options: [], required: false },
  ],
};

describe("Umfragen: teilnehmen und auswerten", () => {
  let h: DbHandle;
  let students: string[];
  const p = (id: string) => loadPermissions(h.db, id);
  const qids = async (surveyId: string) =>
    (await h.db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, surveyId)).orderBy(surveyQuestions.position)).map((q) => q.id);

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

  it("prüft Antworten gegen die Fragen", () => {
    const qs = base.questions.map((q, i) => ({ ...q, id: `q${i}` }));
    expect(checkAnswers(qs, { q0: { choices: [1] }, q2: { scale: 4 } }).map((a) => a.questionId)).toEqual(["q0", "q2"]);
    const err = (() => {
      try {
        checkAnswers(qs, { q0: { choices: [0, 1] }, q1: { choices: [7] }, q2: { scale: 6 }, q3: { text: "x".repeat(2001) } });
      } catch (e) {
        return (e as ValidationError).fieldErrors;
      }
    })();
    expect(err).toEqual({ "q:q0": "Bitte nur eine Antwort wählen", "q:q1": "Ungültige Auswahl", "q:q2": "Wert zwischen 1 und 5", "q:q3": "Höchstens 2000 Zeichen" });
    expect(() => checkAnswers(qs, {})).toThrow(ValidationError);
  });

  it("anonym: kein Personenbezug, nur der Tag; zweite Teilnahme abgelehnt; Fremde und Lehrkräfte nicht", async () => {
    const id = await createSurvey(h.db, await p("u-jana.brandt"), base, NOW);
    const [q0, q1, q2, q3] = await qids(id);
    const lea = await p("u-lea.schaefer");
    await submitResponse(h.db, lea, id, { [q0!]: { choices: [0] }, [q1!]: { choices: [2, 0] }, [q2!]: { scale: 5 }, [q3!]: { text: "  Mehr Pausen  " } }, NOW);
    const [resp] = await h.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, id));
    expect(resp).toMatchObject({ respondentId: null, day: "2026-10-05" });
    const answers = await h.db.select().from(surveyAnswers).where(eq(surveyAnswers.responseId, resp!.id));
    expect(answers.every((a) => a.respondentId === null)).toBe(true);
    expect(answers.find((a) => a.questionId === q1)?.choices).toEqual([0, 2]);
    expect(answers.find((a) => a.questionId === q3)?.text).toBe("Mehr Pausen");
    expect(await h.db.select().from(surveyParticipation).where(eq(surveyParticipation.surveyId, id))).toEqual([{ surveyId: id, userId: "u-lea.schaefer" }]);

    await expect(submitResponse(h.db, lea, id, { [q0!]: { choices: [1] }, [q2!]: { scale: 1 } }, NOW)).rejects.toBeInstanceOf(ValidationError);
    expect((await h.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, id))).length).toBe(1);
    await expect(submitResponse(h.db, await p("u-daniel.okafor"), id, { [q0!]: { choices: [1] }, [q2!]: { scale: 1 } }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitResponse(h.db, lea, id, {}, new Date("2026-10-13T00:00:00Z"))).rejects.toBeInstanceOf(ValidationError);
  });

  it(`anonym: Ergebnisse erst ab ${MIN_ANONYMOUS} Antworten, Freitexte sortiert, CSV ohne Namen`, async () => {
    const jana = await p("u-jana.brandt");
    const id = await createSurvey(h.db, jana, { ...base, title: "Anonym-Auswertung" }, NOW);
    const [q0, , q2, q3] = await qids(id);
    const texts = ["Zebra", "Apfel", "Ärger", "Birne"];
    for (const [i, sid] of students.slice(0, MIN_ANONYMOUS - 1).entries()) {
      await submitResponse(h.db, await p(sid), id, { [q0!]: { choices: [i % 2] }, [q2!]: { scale: i + 1 }, [q3!]: { text: texts[i] } }, NOW);
    }
    const early = await results(h.db, jana, id, NOW);
    expect(early).toMatchObject({ hidden: true, total: MIN_ANONYMOUS - 1, questions: [] });
    await expect(resultsCsv(h.db, jana, id, NOW)).rejects.toBeInstanceOf(ValidationError);

    await submitResponse(h.db, await p(students[MIN_ANONYMOUS - 1]!), id, { [q0!]: { choices: [0] }, [q2!]: { scale: 5 } }, NOW);
    const res = await results(h.db, jana, id, NOW);
    if (res.hidden) throw new Error("erwartet Ergebnisse");
    expect(res.total).toBe(5);
    expect(res.participants).toBe(5);
    expect(res.audience).toBeGreaterThan(5);
    expect(res.questions[0]!.options).toEqual([
      { label: "Ja", count: 3 },
      { label: "Nein", count: 2 },
    ]);
    expect(res.questions[2]!.scale).toEqual({ counts: [1, 1, 1, 1, 1], average: 3 });
    expect(res.questions[3]!.texts).toEqual([{ text: "Apfel" }, { text: "Ärger" }, { text: "Birne" }, { text: "Zebra" }]);

    const csv = await resultsCsv(h.db, jana, id, NOW);
    expect(csv.name).toBe("umfrage-Anonym-Auswertung.csv");
    const lines = csv.body.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Gefallen?;Was war gut?;Gelernt?;Ändern?");
    expect(lines).toHaveLength(6);
    expect(csv.body).not.toContain("Schäfer");

    await expect(results(h.db, await p("u-lea.schaefer"), id, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("namentlich: Antworten mit Namen in Auswertung und CSV, auch unter 5 Antworten", async () => {
    const jana = await p("u-jana.brandt");
    const id = await createSurvey(h.db, jana, { ...base, title: "Namentlich", anonymous: false }, NOW);
    const [q0, , q2, q3] = await qids(id);
    await submitResponse(h.db, await p("u-lea.schaefer"), id, { [q0!]: { choices: [1] }, [q2!]: { scale: 2 }, [q3!]: { text: "Längere Pausen; bitte" } }, NOW);
    const res = await results(h.db, jana, id, NOW);
    if (res.hidden) throw new Error("erwartet Ergebnisse");
    expect(res.questions[3]!.texts).toEqual([{ text: "Längere Pausen; bitte", name: "Lea Schäfer" }]);
    const [resp] = await h.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, id));
    expect(resp!.respondentId).toBe("u-lea.schaefer");
    const csv = await resultsCsv(h.db, jana, id, NOW);
    expect(csv.body.trim().split("\r\n")[1]).toBe('Lea Schäfer;2026-10-05;Nein;;2;"Längere Pausen; bitte"');
  });

  it("Erinnerung: Gong nur an Nicht-Teilnehmende, nur solange offen, nur für Ersteller:in", async () => {
    const jana = await p("u-jana.brandt");
    const id = await createSurvey(h.db, jana, { ...base, title: "Erinnern" }, NOW);
    const [q0, , q2] = await qids(id);
    await submitResponse(h.db, await p("u-lea.schaefer"), id, { [q0!]: { choices: [0] }, [q2!]: { scale: 3 } }, NOW);
    const { open } = await results(h.db, jana, id, NOW);
    // alle der 7b ohne Lea (hat teilgenommen) und ohne Jana selbst (Klassenleitung, ist Mitglied) – „open“ zählt genauso
    expect(await remindNonParticipants(h.db, jana, id, NOW)).toBe(open);
    const gong = (uid: string) => h.db.select().from(notifications).where(and(eq(notifications.userId, uid), eq(notifications.title, "Erinnerung: Erinnern")));
    expect(await gong("u-lea.schaefer")).toEqual([]);
    expect((await gong(students.find((s) => s !== "u-lea.schaefer")!)).length).toBe(1);
    await expect(remindNonParticipants(h.db, await p("u-lea.schaefer"), id, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(remindNonParticipants(h.db, jana, id, new Date("2026-10-13T00:00:00Z"))).rejects.toBeInstanceOf(ValidationError);
  });
});
