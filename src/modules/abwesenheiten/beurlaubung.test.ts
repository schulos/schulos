import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { absenceLeaveRequests, classbookAbsences, classbookEntries, grants, notifications, parentChild, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { OPEN_CALENDAR, SchoolCalendar } from "@/core/school/calendar";
import { lessonContext, saveEntry } from "@/modules/klassenbuch/service";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { countSchoolDays, decideLeave, deciderFor, leaderLeaves, leaveDecidersMissing, leavesFor, principalLeaves, requestLeave, withdrawLeave, type LeaveInput } from "./beurlaubung";
import { LEAVE_CLASS_LEAD_DAYS } from "./settings";

const TODAY = "2026-10-09"; // Freitag
const MO = "2026-10-12";
const DI = "2026-10-13";
const MI = "2026-10-14";
const lea = "u-lea.schaefer";
const jana = "u-jana.brandt";
const petra = "u-petra.lindner";

describe("Schultage und Zuständigkeit (rein)", () => {
  it("zählt nur Schultage; Grenze 0 = immer Schulleitung", () => {
    expect(countSchoolDays(OPEN_CALENDAR, "2026-10-09", "2026-10-13")).toBe(3); // Fr, Mo, Di
    const ferien = new SchoolCalendar("NW", [{ id: "hf", kind: "ferien", name: "Herbstferien", startsOn: "2026-10-12", endsOn: "2026-10-16" }]);
    expect(countSchoolDays(ferien, "2026-10-09", "2026-10-19")).toBe(2); // Fr + Mo nach den Ferien
    expect(deciderFor(2, 2)).toBe("klassenleitung");
    expect(deciderFor(3, 2)).toBe("schulleitung");
    expect(deciderFor(1, 0)).toBe("schulleitung");
  });
});

describe("Beurlaubung vorab (Q5-16)", () => {
  let h: DbHandle;
  let mutter: string;
  let fremdeMutter: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const req = async (who: string, input: Partial<LeaveInput>) =>
    requestLeave(h.db, await p(who), { studentId: lea, fromDate: MO, toDate: MO, reason: "familiaer", ...input }, TODAY, OPEN_CALENDAR);
  const gongs = async (userId: string) =>
    (await h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.moduleId, "abwesenheiten")))).map((n) => n.title);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(classbookEntries);
    await h.db.delete(timetableLessons);
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    const kid9a = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    fremdeMutter = (await h.db.select().from(parentChild).where(eq(parentChild.childId, kid9a)))[0]!.parentId;
  }, 60_000);
  afterAll(() => h.close());

  it("nur Eltern (minderjähriger Kinder) beantragen; Gründe nur aus der Auswahl; nur vorab; keine Überschneidung", async () => {
    await expect(req(fremdeMutter, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(req(lea, {})).rejects.toBeInstanceOf(ForbiddenError); // volljährig erst mit Q5-05
    await expect(req(jana, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(req(mutter, { reason: "religion" as LeaveInput["reason"] })).rejects.toMatchObject({ fieldErrors: { reason: "Grund wählen" } });
    await expect(req(mutter, { fromDate: "2026-10-08", toDate: "2026-10-08" })).rejects.toMatchObject({ fieldErrors: { fromDate: expect.stringContaining("vorab") } });
    await expect(req(mutter, { fromDate: "2026-10-10", toDate: "2026-10-11" })).rejects.toMatchObject({ fieldErrors: { toDate: "In diesem Zeitraum ist kein Unterricht" } });
    await expect(req(mutter, { fromDate: MO, toDate: "2026-11-20" })).rejects.toBeInstanceOf(ValidationError);
    const id = await req(mutter, { fromDate: MO, toDate: DI });
    await expect(req(mutter, { fromDate: DI, toDate: MI })).rejects.toMatchObject({ fieldErrors: { fromDate: "Für diesen Zeitraum gibt es schon einen Antrag" } });
    const [row] = await h.db.select().from(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id));
    expect(row).toMatchObject({ status: "beantragt", schoolDays: 2, decider: "klassenleitung", requestedBy: mutter });
  });

  it("bis 2 Schultage: Gong an die Klassenleitung, sie genehmigt – Gong an die Mutter, Klassenbuch „beurlaubt“ und entschuldigt", async () => {
    expect(await gongs(jana)).toEqual(["Beurlaubung beantragt: Lea Schäfer (12.10.–13.10., 2 Schultage)"]);
    expect(await gongs(petra)).toEqual([]);
    const [open] = await leaderLeaves(h.db, await p(jana), [lea]);
    expect(open!.canDecide).toBe(true);
    await expect(decideLeave(h.db, await p("u-daniel.okafor"), open!.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideLeave(h.db, await p(mutter), open!.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await decideLeave(h.db, await p(jana), open!.id, true);
    await expect(decideLeave(h.db, await p(jana), open!.id, false)).rejects.toBeInstanceOf(ValidationError);
    expect(await gongs(mutter)).toEqual(["Beurlaubung Lea Schäfer (12.10.–13.10.): genehmigt"]);
    // Lehrkraft trägt am Montag „fehlt“ ein → gilt als entschuldigt, Klassenbuch zeigt „beurlaubt“
    const [lesson] = await h.db
      .insert(timetableLessons)
      .values({ groupId: "g-7b", weekday: 0, periodNr: 1, subjectId: "D", teacherId: jana, roomId: "106", validFrom: "2026-08-01" })
      .returning({ id: timetableLessons.id });
    await saveEntry(h.db, await p(jana), { lessonId: lesson!.id, date: MO, topic: "Thema", homework: "", absences: [{ studentId: lea, kind: "absent", minutesLate: null }] }, MO);
    const ctx = await lessonContext(h.db, lesson!.id, MO);
    expect(ctx.onLeave.has(lea)).toBe(true);
    expect(ctx.absences.get(lea)!.excused).toBe(true);
    // Zurückziehen geht nach der Entscheidung nicht mehr
    await expect(withdrawLeave(h.db, await p(mutter), open!.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("über 2 Schultage: Schulleitung entscheidet, die Klassenleitung nicht; Gong an die Schulleitung, nicht an Admins", async () => {
    await h.db.delete(notifications);
    const id = await req(mutter, { fromDate: "2026-11-02", toDate: "2026-11-04", reason: "veranstaltung" });
    const [row] = await h.db.select().from(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id));
    expect(row).toMatchObject({ schoolDays: 3, decider: "schulleitung" });
    expect(await gongs(petra)).toEqual(["Beurlaubung beantragt: Lea Schäfer (2.11.–4.11., 3 Schultage)"]);
    expect(await gongs("u-admin")).toEqual([]);
    expect(await gongs(jana)).toEqual([]);
    const kl = (await leaderLeaves(h.db, await p(jana), [lea])).find((r) => r.id === id)!;
    expect(kl.canDecide).toBe(false);
    await expect(decideLeave(h.db, await p(jana), id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(principalLeaves(h.db, await p(jana), TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await principalLeaves(h.db, await p(petra), TODAY)).map((r) => r.id)).toEqual([id]);
    await decideLeave(h.db, await p(petra), id, false);
    expect(await gongs(mutter)).toEqual(["Beurlaubung Lea Schäfer (2.11.–4.11.): abgelehnt"]);
    // Ablehnung: keine Nachricht an die Klassenleitung
    expect(await gongs(jana)).toEqual([]);
  });

  it("Grenze einstellbar: „immer die Schulleitung“; offener Antrag lässt sich zurückziehen (nur von der antragstellenden Person)", async () => {
    await writeModuleSetting(h.db, LEAVE_CLASS_LEAD_DAYS, "0");
    const id = await req(mutter, { fromDate: "2026-11-09", toDate: "2026-11-09", reason: "sonstiges" });
    expect((await h.db.select().from(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id)))[0]!.decider).toBe("schulleitung");
    await expect(withdrawLeave(h.db, await p(jana), id)).rejects.toBeInstanceOf(ForbiddenError);
    await withdrawLeave(h.db, await p(mutter), id);
    expect((await leavesFor(h.db, [lea])).map((r) => r.status).sort()).toEqual(["abgelehnt", "genehmigt"]);
    await writeModuleSetting(h.db, LEAVE_CLASS_LEAD_DAYS, "2");
  });

  it("nur genehmigte Beurlaubungen wirken aufs Klassenbuch", async () => {
    const rows = await h.db.select().from(classbookAbsences).where(eq(classbookAbsences.studentId, lea));
    expect(rows.every((r) => r.excused === true)).toBe(true);
  });
  it("GATE-4f C-05: entscheiden Klassenleitung und Schulleitung gleichzeitig, gilt nur die erste Entscheidung", async () => {
    await h.db.delete(notifications);
    const id = await req(mutter, { fromDate: "2026-11-16", toDate: "2026-11-16", reason: "sonstiges" });
    const [kl, sl] = [await p(jana), await p(petra)];
    const results = await Promise.allSettled([decideLeave(h.db, kl, id, false), decideLeave(h.db, sl, id, true)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ValidationError);
    const [row] = await h.db.select().from(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id));
    // genau eine Nachricht an die Mutter, passend zum gespeicherten Status
    expect(await gongs(mutter)).toEqual([`Beurlaubung Lea Schäfer (16.11.): ${row!.status}`]);
  });

  it("GATE-4f C-10: erkennt, wenn außer Admins niemand über Beurlaubungen über der Grenze entscheiden darf", async () => {
    expect(await leaveDecidersMissing(h.db)).toBe(false); // Demo: Gruppe Schulleitung
    const [g] = await h.db.delete(grants).where(and(eq(grants.permission, "abwesenheiten.leave_decide"), eq(grants.groupId, "g-schulleitung"))).returning();
    expect(await leaveDecidersMissing(h.db)).toBe(true);
    await h.db.insert(grants).values(g!);
    expect(await leaveDecidersMissing(h.db)).toBe(false);
  });
});
