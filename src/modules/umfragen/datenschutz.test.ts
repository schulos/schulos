// P3-10: Datenschutz-Prüfung über die Module der Phase 3 – Auskunft (Art. 15) findet eigene Beiträge, Karten und
// namentliche Antworten, aber nichts, was eine anonyme Antwort einer Person zuordnen würde; Kontolöschung räumt auf.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { surveyAnswers, surveyParticipation, surveyQuestions, surveyResponses } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { processingRecords } from "@/core/privacy/hinweise";
import { MODULES } from "@/modules";
import { createTopic } from "@/modules/foren/service";
import { addCard } from "@/modules/pinnwaende/service";
import { createSurvey, type SurveyInput } from "./service";
import { submitResponse } from "./teilnahme";

const NOW = new Date("2026-10-05T08:00:00Z");
const survey = (title: string, anonymous: boolean): SurveyInput => ({
  title,
  description: "",
  anonymous,
  opensAt: new Date("2026-10-05T06:00:00Z"),
  closesAt: new Date("2026-10-12T20:00:00Z"),
  targets: { roles: [], groups: [{ groupId: "g-7b", parents: false }] },
  questions: [{ kind: "text", text: "Was meinst du?", options: [], required: true }],
});

describe("Datenschutz Phase 3", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Auskunft: namentliche Antwort, Teilnahme, Forenbeitrag und Karte – anonyme Antwort nicht zuordenbar", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    const named = await createSurvey(h.db, jana, survey("Namentlich", false), NOW);
    const anon = await createSurvey(h.db, jana, survey("Anonym", true), NOW);
    const q = async (id: string) => (await h.db.select().from(surveyQuestions).where(eq(surveyQuestions.surveyId, id)))[0]!.id;
    await submitResponse(h.db, lea, named, { [await q(named)]: { text: "NAMENTLICH-TEXT" } }, NOW);
    await submitResponse(h.db, lea, anon, { [await q(anon)]: { text: "ANONYM-TEXT" } }, NOW);
    await createTopic(h.db, lea, "g-7b", { title: "Mein Thema", body: "FORUM-TEXT" }, NOW);
    await addCard(h.db, lea, "board-7b-projekt", { columnId: "col-7b-ideen", kind: "text", title: "KARTEN-TEXT", body: "" });

    const data = (await collectPersonalData(h.db, "u-lea.schaefer"))!;
    const text = JSON.stringify(data.sections);
    for (const t of ["NAMENTLICH-TEXT", "FORUM-TEXT", "KARTEN-TEXT"]) expect(text).toContain(t);
    expect(text).not.toContain("ANONYM-TEXT");
    const participation = data.sections.find((s) => s.table === "umfragen_participation")!.rows;
    expect(participation.map((r) => r.survey_id).sort()).toEqual([named, anon].sort());

    // anonyme Antwort: weder Antwort noch Antwortzeile tragen einen Personenbezug, nur den Tag
    const [resp] = await h.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, anon));
    expect(Object.keys(resp!).sort()).toEqual(["day", "id", "respondentId", "seq", "surveyId"]);
    expect(resp!.respondentId).toBeNull();
    expect((await h.db.select().from(surveyAnswers).where(eq(surveyAnswers.responseId, resp!.id)))[0]!.respondentId).toBeNull();
  });

  it("Konto gelöscht: Teilnahme geht mit, namentliche Antworten bleiben ohne Namen (Ergebnis der Umfrage stimmt weiter)", async () => {
    const before = await h.db.select().from(surveyResponses).where(eq(surveyResponses.respondentId, "u-lea.schaefer"));
    expect(before.length).toBe(1);
    await deleteAccounts(h.db, ["u-lea.schaefer"]);
    expect(await h.db.select().from(surveyParticipation).where(eq(surveyParticipation.userId, "u-lea.schaefer"))).toEqual([]);
    const [after] = await h.db.select().from(surveyResponses).where(eq(surveyResponses.id, before[0]!.id));
    expect(after!.respondentId).toBeNull();
    expect((await h.db.select().from(surveyAnswers).where(eq(surveyAnswers.responseId, before[0]!.id)))[0]!.respondentId).toBeNull();
  });

  it("Verzeichnis der Verarbeitungstätigkeiten enthält alle neuen Module", () => {
    const titles = processingRecords(MODULES).map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(["Kursraum", "Umfragen", "Foren", "Pinnwände"]));
  });
});
