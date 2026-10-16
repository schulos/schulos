import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, surveyResponses, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { subscribe, type LiveEvent } from "@/core/notifications/bus";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { activeQuickPolls, answerQuickPoll, endQuickPoll, pollState, startQuickPoll } from "./schnell";
import { listForParticipant, listOwn } from "./service";
import { MIN_ANONYMOUS } from "./teilnahme";

const NOW = new Date("2026-10-05T08:00:00Z");
const later = (s: number) => new Date(NOW.getTime() + s * 1000);

describe("Schnellumfrage", () => {
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

  it("Leitung startet; Mitglieder bekommen den Stand live; Schüler:innen und Fremde starten nicht", async () => {
    const events: LiveEvent[] = [];
    const off = subscribe("u-lea.schaefer", (e) => events.push(e));
    const id = await startQuickPoll(h.db, await p("u-jana.brandt"), "g-7b", { question: "Schon fertig?", options: ["Ja", " Nein ", ""], minutes: 5 }, NOW);
    off();
    expect(events).toEqual([
      { type: "poll", poll: { id, groupId: "g-7b", question: "Schon fertig?", options: ["Ja", "Nein"], closesAt: later(300).toISOString(), open: true, total: 0, counted: 0, counts: null } },
    ]);
    await expect(startQuickPoll(h.db, await p("u-lea.schaefer"), "g-7b", { question: "?", options: ["a", "b"], minutes: 5 }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startQuickPoll(h.db, await p("u-daniel.okafor"), "g-7b", { question: "?", options: ["a", "b"], minutes: 5 }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startQuickPoll(h.db, await p("u-jana.brandt"), "g-7b", { question: "?", options: ["a"], minutes: 7 }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("anonym: Verteilung erst ab 5 Antworten, je Person einmal; nicht in den Umfrage-Listen", async () => {
    const jana = await p("u-jana.brandt");
    const id = await startQuickPoll(h.db, jana, "g-7b", { question: "Tempo?", options: ["zu schnell", "passt", "zu langsam"], minutes: 10 }, NOW);
    const lea = await p("u-lea.schaefer");
    expect((await activeQuickPolls(h.db, lea, "g-7b", later(10))).find((x) => x.id === id)).toMatchObject({ answered: false, canEnd: false, total: 0 });
    for (const [i, sid] of students.slice(0, MIN_ANONYMOUS - 1).entries()) await answerQuickPoll(h.db, await p(sid), id, i % 2, later(20));
    expect(await pollState(h.db, id, later(30))).toMatchObject({ total: MIN_ANONYMOUS - 1, counts: null });
    await answerQuickPoll(h.db, await p(students[MIN_ANONYMOUS - 1]!), id, 2, later(40));
    expect(await pollState(h.db, id, later(50))).toMatchObject({ total: MIN_ANONYMOUS, counts: [2, 2, 1] });
    await expect(answerQuickPoll(h.db, await p(students[0]!), id, 1, later(60))).rejects.toBeInstanceOf(ValidationError);
    const [resp] = await h.db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, id));
    expect(resp!.respondentId).toBeNull();

    expect((await listForParticipant(h.db, lea, later(10))).map((s) => s.id)).not.toContain(id);
    expect((await listOwn(h.db, jana, later(10))).map((s) => s.id)).not.toContain(id);
  });

  it("endet von Hand oder nach Zeit; danach keine Antworten mehr", async () => {
    const jana = await p("u-jana.brandt");
    const id = await startQuickPoll(h.db, jana, "g-7b", { question: "Pause?", options: ["Ja", "Nein"], minutes: 1 }, NOW);
    await expect(endQuickPoll(h.db, await p("u-lea.schaefer"), id, later(5))).rejects.toBeInstanceOf(ForbiddenError);
    await endQuickPoll(h.db, jana, id, later(5));
    expect(await pollState(h.db, id, later(6))).toMatchObject({ open: false });
    expect((await activeQuickPolls(h.db, jana, "g-7b", later(6))).map((x) => x.id)).not.toContain(id);
    await expect(answerQuickPoll(h.db, await p("u-lea.schaefer"), id, 0, later(7))).rejects.toBeInstanceOf(ValidationError);

    const timed = await startQuickPoll(h.db, jana, "g-7b", { question: "Noch da?", options: ["Ja", "Nein"], minutes: 1 }, NOW);
    expect((await activeQuickPolls(h.db, jana, "g-7b", later(61))).map((x) => x.id)).not.toContain(timed);
    // sofort beenden verletzt nicht die Regel „Ende nach Beginn“
    const instant = await startQuickPoll(h.db, jana, "g-7b", { question: "Sofort?", options: ["Ja", "Nein"], minutes: 1 }, NOW);
    await endQuickPoll(h.db, jana, instant, NOW);
  });
});
