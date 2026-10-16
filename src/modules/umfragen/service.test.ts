import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild, surveyQuestions, surveyResponses } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createSurvey, deleteSurvey, getSurvey, listForParticipant, listOwn, resolveAudience, statusOf, updateSurvey, type SurveyInput } from "./service";

const NOW = new Date("2026-10-05T08:00:00Z");
const base: SurveyInput = {
  title: "Wie war die Projektwoche?",
  description: "Kurz und ehrlich – keine Namen nennen.",
  anonymous: true,
  opensAt: new Date("2026-10-05T06:00:00Z"),
  closesAt: new Date("2026-10-12T20:00:00Z"),
  targets: { roles: [], groups: [{ groupId: "g-7b", parents: false }] },
  questions: [
    { kind: "single", text: "Hat es dir gefallen?", options: ["Ja", "Teils", "Nein", " "], required: true },
    { kind: "scale", text: "Wie viel hast du gelernt?", options: ["ignoriert"], required: true },
    { kind: "text", text: "Was sollen wir ändern?", options: [], required: false },
  ],
};

function fieldErrors(fn: () => Promise<unknown>) {
  return fn().then(
    () => {
      throw new Error("erwartet ValidationError");
    },
    (err: unknown) => {
      if (!(err instanceof ValidationError)) throw err;
      return err.fieldErrors;
    },
  );
}

describe("Umfragen", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Status nach Zeitraum", () => {
    expect(statusOf(base, new Date("2026-10-04T12:00:00Z"))).toBe("geplant");
    expect(statusOf(base, NOW)).toBe("offen");
    expect(statusOf(base, new Date("2026-10-13T00:00:00Z"))).toBe("beendet");
  });

  it("Lehrkraft legt eine Umfrage an: Optionen bereinigt, Skala ohne Optionen, Gong an die Klasse", async () => {
    const id = await createSurvey(h.db, await p("u-jana.brandt"), { ...base, notify: true }, NOW);
    const qs = await h.db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, id));
    expect(qs.map((q) => [q.position, q.kind, q.options])).toEqual([
      [0, "single", ["Ja", "Teils", "Nein"]],
      [1, "scale", []],
      [2, "text", []],
    ]);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-lea.schaefer"), eq(notifications.moduleId, "umfragen")));
    expect(gong.map((g) => g.title)).toEqual(["Umfrage: Wie war die Projektwoche?"]);
    expect(await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-jana.brandt"), eq(notifications.moduleId, "umfragen")))).toEqual([]);
  });

  it("prüft Eingaben", async () => {
    const jana = await p("u-jana.brandt");
    expect(await fieldErrors(() => createSurvey(h.db, jana, { ...base, title: " ", questions: [] }, NOW))).toMatchObject({ title: "Titel fehlt", questions: "Bitte mindestens eine Frage anlegen" });
    expect(await fieldErrors(() => createSurvey(h.db, jana, { ...base, targets: { roles: [], groups: [] } }, NOW))).toMatchObject({ targets: "Bitte mindestens eine Zielgruppe wählen" });
    expect(await fieldErrors(() => createSurvey(h.db, jana, { ...base, closesAt: base.opensAt }, NOW))).toMatchObject({ closesAt: "Ende muss nach dem Beginn liegen" });
    expect(
      await fieldErrors(() => createSurvey(h.db, jana, { ...base, questions: [{ kind: "multi", text: "Was?", options: ["A", "a"], required: true }] }, NOW)),
    ).toMatchObject({ questions: "Frage 1: Antwortmöglichkeiten doppelt" });
    expect(await fieldErrors(() => createSurvey(h.db, jana, { ...base, questions: [{ kind: "single", text: "Was?", options: ["A"], required: true }] }, NOW))).toMatchObject({
      questions: "Frage 1: mindestens zwei Antwortmöglichkeiten",
    });
    await expect(createSurvey(h.db, await p("u-lea.schaefer"), base, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Zielgruppen: Gruppe, Rolle, Eltern einer Klasse – sichtbar nur für die Gemeinten", async () => {
    const jana = await p("u-jana.brandt");
    const forParents = await createSurvey(h.db, jana, { ...base, title: "Elternsprechtag-Termine", targets: { roles: [], groups: [{ groupId: "g-7b", parents: true }] } }, NOW);
    const forStaff = await createSurvey(h.db, jana, { ...base, title: "Fortbildungswünsche", targets: { roles: ["lehrkraft"], groups: [] } }, NOW);

    const lea = await p("u-lea.schaefer");
    const leaList = (await listForParticipant(h.db, lea, NOW)).map((s) => s.title);
    expect(leaList).toContain("Wie war die Projektwoche?");
    expect(leaList).not.toContain("Elternsprechtag-Termine");
    expect(leaList).not.toContain("Fortbildungswünsche");

    const [link] = await h.db.select().from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"));
    const parent = await p(link!.parentId);
    const parentList = (await listForParticipant(h.db, parent, NOW)).map((s) => s.title);
    expect(parentList).toEqual(expect.arrayContaining(["Elternsprechtag-Termine"]));
    expect(parentList).not.toContain("Wie war die Projektwoche?");
    expect((await listForParticipant(h.db, await p("u-daniel.okafor"), NOW)).map((s) => s.title)).toContain("Fortbildungswünsche");

    const audience = await resolveAudience(h.db, forParents);
    expect(audience).toContain(link!.parentId);
    expect(audience).not.toContain("u-lea.schaefer");
    expect((await resolveAudience(h.db, forStaff)).length).toBeGreaterThan(10);

    expect(await getSurvey(h.db, lea, forParents, NOW)).toBeNull();
    expect((await getSurvey(h.db, parent, forParents, NOW))?.targets.labels).toEqual(["Eltern Klasse 7b"]);
  });

  it("geplante Umfragen erscheinen noch nicht; eigene Liste mit Antwortzahl", async () => {
    const jana = await p("u-jana.brandt");
    await createSurvey(h.db, jana, { ...base, title: "Später", opensAt: new Date("2026-10-08T06:00:00Z") }, NOW);
    expect((await listForParticipant(h.db, await p("u-lea.schaefer"), NOW)).map((s) => s.title)).not.toContain("Später");
    const own = await listOwn(h.db, jana, NOW);
    expect(own.find((s) => s.title === "Später")).toMatchObject({ status: "geplant", responses: 0 });
    expect(await listOwn(h.db, await p("u-daniel.okafor"), NOW)).toEqual([]);
    expect((await listOwn(h.db, await p("u-sabine.kowalski"), NOW)).length).toBe(own.length);
  });

  it("Bearbeiten: Fragen nur ohne Antworten, anonym/namentlich danach fest; fremde Lehrkraft darf nicht", async () => {
    const jana = await p("u-jana.brandt");
    const id = await createSurvey(h.db, jana, { ...base, title: "Bearbeiten" }, NOW);
    await updateSurvey(h.db, jana, id, { ...base, title: "Bearbeitet", questions: [{ kind: "text", text: "Nur noch eine Frage", options: [], required: true }] }, NOW);
    expect((await getSurvey(h.db, jana, id, NOW))?.questions.map((q) => q.text)).toEqual(["Nur noch eine Frage"]);

    await h.db.insert(surveyResponses).values({ surveyId: id, day: "2026-10-05" });
    await updateSurvey(h.db, jana, id, { ...base, title: "Neuer Titel", questions: [{ kind: "text", text: "Wird ignoriert", options: [], required: true }] }, NOW);
    const after = (await getSurvey(h.db, jana, id, NOW))!;
    expect(after.survey.title).toBe("Neuer Titel");
    expect(after.questions.map((q) => q.text)).toEqual(["Nur noch eine Frage"]);
    expect(await fieldErrors(() => updateSurvey(h.db, jana, id, { ...base, anonymous: false }, NOW))).toMatchObject({ anonymous: expect.stringContaining("nicht mehr ändern") });

    await expect(updateSurvey(h.db, await p("u-daniel.okafor"), id, base, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSurvey(h.db, await p("u-daniel.okafor"), id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteSurvey(h.db, jana, id);
    expect(await getSurvey(h.db, jana, id, NOW)).toBeNull();
  });

  it("unbekannte Gruppe als Zielgruppe wird abgelehnt", async () => {
    await expect(createSurvey(h.db, await p("u-jana.brandt"), { ...base, targets: { roles: [], groups: [{ groupId: "gibt-es-nicht", parents: false }] } }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });
});
