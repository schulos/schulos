import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { absenceReports, auditLog, classbookAbsences, classbookEntries, notifications, parentChild, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { saveEntry } from "@/modules/klassenbuch/service";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { buildDays, dayStatus, decideDay, openDays, ownAbsences } from "./fehlzeiten";
import { decideReport, reportAbsence } from "./service";
import { UNEXCUSED_HINT } from "./settings";

const MO = "2026-10-05";
const DI = "2026-10-06";
const MI = "2026-10-07";
const DO = "2026-10-08";
const TODAY = "2026-10-09";

describe("dayStatus / buildDays (rein)", () => {
  it("nicht entschuldigt vor offen vor entschuldigt; nur Verspätungen → kein Status", () => {
    expect(dayStatus([], false)).toBeNull();
    expect(dayStatus([true, false, null], false)).toBe("nicht_entschuldigt");
    expect(dayStatus([true, null], false)).toBe("ohne_meldung");
    expect(dayStatus([null], true)).toBe("gemeldet");
    expect(dayStatus([true, true], false)).toBe("entschuldigt");
  });

  it("Tage neueste zuerst, Summen über Fehlstunden und Verspätungen", () => {
    const { days, totals } = buildDays(
      [
        { date: MO, periodNr: 2, subjectName: "Mathe", kind: "absent", minutesLate: null, excused: null },
        { date: MO, periodNr: 1, subjectName: "Deutsch", kind: "absent", minutesLate: null, excused: null },
        { date: DI, periodNr: 1, subjectName: "Deutsch", kind: "late", minutesLate: 10, excused: null },
      ],
      () => false,
    );
    expect(days.map((d) => [d.date, d.absent, d.status, d.lessons.map((l) => l.periodNr)])).toEqual([
      [DI, 0, null, [1]],
      [MO, 2, "ohne_meldung", [1, 2]],
    ]);
    expect(totals).toEqual({ absent: 2, excused: 0, unexcused: 0, open: 2, lateCount: 1, lateMinutes: 10 });
  });
});

describe("Eigene Fehlzeiten + Gong an Eltern (Q5-13)", () => {
  let h: DbHandle;
  let mutter: string;
  let eltern: string[];
  let fremdeMutter: string;
  const lessons: Record<number, string> = {};
  const lea = "u-lea.schaefer";
  const jana = "u-jana.brandt";
  const p = (id: string) => loadPermissions(h.db, id);
  const fehlt = async (date: string, weekday: number) =>
    saveEntry(h.db, await p(jana), { lessonId: lessons[weekday]!, date, topic: "Thema", homework: "", absences: [{ studentId: lea, kind: "absent", minutesLate: null }] }, TODAY);
  const gongs = async (userId: string) =>
    (await h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.moduleId, "abwesenheiten")))).map((n) => n.title);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(classbookEntries);
    await h.db.delete(absenceReports);
    await h.db.delete(timetableLessons);
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    eltern = (await h.db.select().from(parentChild).where(eq(parentChild.childId, lea))).map((r) => r.parentId);
    const kid9a = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    fremdeMutter = (await h.db.select().from(parentChild).where(eq(parentChild.childId, kid9a)))[0]!.parentId;
    const rows = await h.db
      .insert(timetableLessons)
      .values([0, 1, 2, 3].map((weekday) => ({ groupId: "g-7b", weekday, periodNr: 1, subjectId: "D", teacherId: jana, roomId: "106", validFrom: "2026-08-01" })))
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday });
    for (const r of rows) lessons[r.weekday] = r.id;
    await fehlt(MO, 0);
    await saveEntry(h.db, await p(jana), { lessonId: lessons[1]!, date: DI, topic: "Thema", homework: "", absences: [{ studentId: lea, kind: "late", minutesLate: 5 }] }, TODAY);
  }, 60_000);
  afterAll(() => h.close());

  it("Schülerin sieht die eigenen Fehlzeiten, Eltern die ihres Kindes (protokolliert), sonst niemand", async () => {
    const own = await ownAbsences(h.db, await p(lea), lea, TODAY);
    expect(own.from).toBe("2026-08-01");
    expect(own.days.map((d) => [d.date, d.status])).toEqual([
      [DI, null],
      [MO, "ohne_meldung"],
    ]);
    expect(own.totals).toMatchObject({ absent: 1, open: 1, lateCount: 1, lateMinutes: 5 });
    const before = (await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.fehlzeiten"))).length;
    await ownAbsences(h.db, await p(mutter), lea, TODAY);
    const reads = await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.fehlzeiten"));
    expect(reads).toHaveLength(before + 1);
    expect(reads.at(-1)).toMatchObject({ actorId: mutter, target: lea });
    await expect(ownAbsences(h.db, await p(fremdeMutter), lea, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ownAbsences(h.db, await p(jana), lea, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    const mitschueler = (await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.find((u) => u.id !== lea)!.id;
    await expect(ownAbsences(h.db, await p(mitschueler), lea, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("vor der Entscheidung kein Gong an die Eltern; offene Meldung zeigt „gemeldet“ und fehlt bei den Fehltagen ohne Meldung", async () => {
    for (const e of eltern) expect(await gongs(e)).toEqual([]);
    expect((await openDays(h.db, await p(jana), TODAY)).map((d) => [d.studentId, d.date, d.hours])).toEqual([[lea, MO, 1]]);
    await reportAbsence(h.db, await p(mutter), { studentId: lea, fromDate: MO, toDate: MO, reason: "krank" }, TODAY);
    expect((await ownAbsences(h.db, await p(lea), lea, TODAY)).days.find((d) => d.date === MO)!.status).toBe("gemeldet");
    expect(await openDays(h.db, await p(jana), TODAY)).toEqual([]);
    await h.db.delete(absenceReports);
    await h.db.delete(notifications);
  });

  it("Klassenleitung entscheidet „nicht entschuldigt“ → Gong an alle Eltern; nur die Klassenleitung darf", async () => {
    await expect(decideDay(h.db, await p("u-daniel.okafor"), lea, MO, false, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideDay(h.db, await p(mutter), lea, MO, false, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideDay(h.db, await p(jana), lea, DI, false, TODAY)).rejects.toBeInstanceOf(ValidationError); // nur verspätet
    await expect(decideDay(h.db, await p(jana), lea, "2026-10-12", false, TODAY)).rejects.toBeInstanceOf(ValidationError); // Zukunft
    await decideDay(h.db, await p(jana), lea, MO, false, TODAY);
    for (const e of eltern) expect(await gongs(e)).toEqual(["Lea Schäfer: 5.10. nicht entschuldigt"]);
    expect(await gongs(lea)).toEqual([]);
    expect((await ownAbsences(h.db, await p(mutter), lea, TODAY)).days.find((d) => d.date === MO)!.status).toBe("nicht_entschuldigt");
    expect(await openDays(h.db, await p(jana), TODAY)).toEqual([]);
    // entschuldigen geht auch nachträglich – ohne Gong an die Eltern
    await h.db.delete(notifications);
    await decideDay(h.db, await p(jana), lea, MO, true, TODAY);
    for (const e of eltern) expect(await gongs(e)).toEqual([]);
    expect((await ownAbsences(h.db, await p(lea), lea, TODAY)).days.find((d) => d.date === MO)!.status).toBe("entschuldigt");
  });

  it("Hinweis an die Klassenleitung ab N unentschuldigten Tagen – eine Nachricht je Halbjahr, die mitzählt", async () => {
    await writeModuleSetting(h.db, UNEXCUSED_HINT, "3");
    await h.db.delete(notifications);
    await fehlt(MI, 2);
    await fehlt(DO, 3);
    await decideDay(h.db, await p(jana), lea, MO, false, TODAY);
    await decideDay(h.db, await p(jana), lea, MI, false, TODAY);
    expect((await gongs(jana)).filter((t) => t.includes("Tage"))).toEqual([]);
    await decideDay(h.db, await p(jana), lea, DO, false, TODAY);
    const hint = (await h.db.select().from(notifications).where(eq(notifications.userId, jana))).filter((n) => n.title.includes("Tage"));
    expect(hint.map((n) => n.title)).toEqual(["Lea Schäfer: 3 Tage mit unentschuldigten Fehlstunden im Halbjahr"]);
    expect(hint[0]!.body).toContain("keine Meldung an Schulleitung oder Behörden");
    // ein weiterer Tag ersetzt die Nachricht statt eine zweite anzulegen
    await saveEntry(h.db, await p(jana), { lessonId: lessons[1]!, date: DI, topic: "Thema", homework: "", absences: [{ studentId: lea, kind: "absent", minutesLate: null }] }, TODAY);
    await decideDay(h.db, await p(jana), lea, DI, false, TODAY);
    const after = (await h.db.select().from(notifications).where(eq(notifications.userId, jana))).filter((n) => n.title.includes("Tage"));
    expect(after.map((n) => n.title)).toEqual(["Lea Schäfer: 4 Tage mit unentschuldigten Fehlstunden im Halbjahr"]);
    // Einstellung „aus“: kein Hinweis
    await writeModuleSetting(h.db, UNEXCUSED_HINT, "0");
    await h.db.delete(notifications);
    await decideDay(h.db, await p(jana), lea, DI, false, TODAY);
    expect((await gongs(jana)).filter((t) => t.includes("Tage"))).toEqual([]);
  });

  it("Meldung „nicht entschuldigt“: die meldende Mutter bekommt eine Nachricht, die anderen Eltern auch", async () => {
    await h.db.delete(notifications);
    await h.db.update(classbookAbsences).set({ excused: null }).where(eq(classbookAbsences.studentId, lea));
    const id = await reportAbsence(h.db, await p(mutter), { studentId: lea, fromDate: MO, toDate: DI, reason: "sonstiges" }, TODAY);
    await decideReport(h.db, await p(jana), id, false, TODAY);
    expect(await gongs(mutter)).toEqual(["Lea Schäfer: 5.10.–6.10. nicht entschuldigt"]);
    for (const e of eltern.filter((x) => x !== mutter)) expect(await gongs(e)).toEqual(["Lea Schäfer: 5.10.–6.10. nicht entschuldigt"]);
    const decided = await h.db
      .select({ excused: classbookAbsences.excused })
      .from(classbookAbsences)
      .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
      .where(and(eq(classbookAbsences.studentId, lea), inArray(classbookEntries.date, [MO, DI])));
    expect(decided.every((d) => d.excused === false)).toBe(true);
  });
});
