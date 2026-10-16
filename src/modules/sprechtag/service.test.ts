import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, notifications, parentChild, sprechtagAppointments, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  allAppointments,
  bookAppointments,
  bookingStudents,
  cancelAppointment,
  createEvent,
  eventState,
  familyAppointments,
  getEvent,
  releaseAvailability,
  suggestForFamily,
  teacherAppointments,
  teacherBoards,
  teachersOfStudent,
  updateEvent,
  withdrawAvailability,
  type EventInput,
} from "./service";

const TODAY = "2026-11-02";
const NOW = new Date("2026-11-02T10:00:00+01:00");
const DATE = "2026-11-12";
const input: EventInput = {
  title: "Elternsprechtag Herbst",
  date: DATE,
  startsAt: "16:00",
  endsAt: "17:00",
  slotMinutes: 10,
  breaks: [{ from: "16:30", to: "16:40" }],
  bookingOpensOn: "2026-11-01",
  bookingClosesOn: "2026-11-11",
};
const LEA = "u-lea.schaefer";

/** ValidationError mit passendem Feldtext */
async function refused(pr: Promise<unknown>, re: RegExp) {
  const err = await pr.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  expect(Object.values((err as ValidationError).fieldErrors).join(" ")).toMatch(re);
}
const JANA = "u-jana.brandt";

describe("Elternsprechtag", () => {
  let h: DbHandle;
  let eventId: string;
  let mother: string;
  let other: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    [{ parentId: mother }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    const teachers = await teachersOfStudent(h.db, LEA, DATE);
    other = teachers.find((t) => t !== JANA)!;
  }, 60_000);
  afterAll(() => h.close());

  it("Verwaltung legt den Sprechtag an; Lehrkräfte und Eltern nicht", async () => {
    await expect(createEvent(h.db, await p(JANA), input, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createEvent(h.db, await p("u-sabine.kowalski"), { ...input, bookingClosesOn: "2026-11-13" }, TODAY)).rejects.toBeInstanceOf(ValidationError);
    eventId = await createEvent(h.db, await p("u-sabine.kowalski"), input, TODAY);
    const e = (await getEvent(h.db, eventId))!;
    expect(eventState(e, "2026-10-30")).toBe("geplant");
    expect(eventState(e, TODAY)).toBe("buchung");
    expect(eventState(e, DATE)).toBe("geschlossen");
    expect(eventState(e, "2026-11-13")).toBe("vorbei");
  });

  it("Lehrkräfte des Kindes: Klassenleitung und Fachlehrkräfte aus dem Stundenplan", async () => {
    const teachers = await teachersOfStudent(h.db, LEA, DATE);
    expect(teachers).toContain(JANA);
    expect(teachers.length).toBeGreaterThan(1);
    expect(other).toBeTruthy();
  });

  it("Lehrkraft gibt Zeiten frei, sperrt eine; Eltern sehen nur frei/belegt", async () => {
    await releaseAvailability(h.db, await p(JANA), eventId, { roomId: null, blockedSlots: ["16:50"] }, TODAY);
    await releaseAvailability(h.db, await p(other), eventId, { roomId: null, blockedSlots: [] }, TODAY);
    await expect(releaseAvailability(h.db, await p(mother), eventId, { roomId: null, blockedSlots: [] }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    const e = (await getEvent(h.db, eventId))!;
    const [jana] = await teacherBoards(h.db, e, [JANA]);
    expect(jana!.free).toEqual(["16:00", "16:10", "16:20", "16:40"]);
    expect(Object.keys(jana!)).not.toContain("appointments");
  });

  it("Eltern buchen zwei Termine hintereinander (Vorschlag), Kollisionen werden abgelehnt", async () => {
    const mom = await p(mother);
    expect((await bookingStudents(h.db, mom)).map((s) => s.id)).toContain(LEA);
    const e = (await getEvent(h.db, eventId))!;
    const plan = (await suggestForFamily(h.db, mom, e, [
      { teacherId: JANA, studentId: LEA },
      { teacherId: other, studentId: LEA },
    ]))!;
    expect(plan.map((x) => x.slot)).toEqual(["16:00", "16:10"]);
    await bookAppointments(h.db, mom, eventId, plan, NOW, TODAY);
    // dieselbe Zeit noch einmal: Familie hat dann schon einen Termin
    await expect(bookAppointments(h.db, mom, eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:10" }], NOW, TODAY)).rejects.toBeInstanceOf(ValidationError);
    // gesperrte Zeit und Lehrkraft, die das Kind nicht unterrichtet
    await expect(bookAppointments(h.db, mom, eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:50" }], NOW, TODAY)).rejects.toBeInstanceOf(ValidationError);
    const stranger = (await h.db.select({ id: users.id }).from(users).where(eq(users.role, "lehrkraft"))).map((u) => u.id);
    const teaching = new Set(await teachersOfStudent(h.db, LEA, DATE));
    const notTeaching = stranger.find((t) => !teaching.has(t))!;
    await refused(bookAppointments(h.db, mom, eventId, [{ teacherId: notTeaching, studentId: LEA, slot: "16:40" }], NOW, TODAY), /unterrichtet das Kind nicht/);
    // fremde Familie darf nicht für Lea buchen
    const leaParents = h.db.select({ id: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA));
    const [foreign] = await h.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "eltern"), notInArray(users.id, leaParents)))
      .limit(1);
    expect(foreign).toBeTruthy();
    await expect(bookAppointments(h.db, await p(foreign!.id), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:40" }], NOW, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    // außerhalb des Buchungsfensters
    await refused(bookAppointments(h.db, mom, eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:40" }], NOW, "2026-10-30"), /noch nicht offen/);
  });

  it("Lehrkraft sieht ihren Plan mit Namen, Eltern nur die eigenen Termine; gebuchte Zeit lässt sich nicht sperren", async () => {
    const plan = await teacherAppointments(h.db, await p(JANA), eventId, JANA);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ slot: "16:00", studentName: "Lea Schäfer", className: "7b" });
    await expect(teacherAppointments(h.db, await p(other), eventId, JANA)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await allAppointments(h.db, await p("u-sabine.kowalski"), eventId)).length).toBe(2);
    expect((await familyAppointments(h.db, await p(mother), eventId)).map((a) => a.slot)).toEqual(["16:00", "16:10"]);
    await refused(releaseAvailability(h.db, await p(JANA), eventId, { roomId: null, blockedSlots: ["16:00"] }, TODAY), /Schon gebucht/);
    await expect(withdrawAvailability(h.db, await p(JANA), eventId)).rejects.toBeInstanceOf(ValidationError);
    await refused(updateEvent(h.db, await p("u-sabine.kowalski"), eventId, { ...input, startsAt: "16:05" }, TODAY), /passen nicht ins neue Raster/);
  });

  it("Absage durch die Lehrkraft → Gong an die Eltern; Absage durch die Eltern → Gong an die Lehrkraft", async () => {
    const [a, b] = await h.db.select().from(sprechtagAppointments).where(eq(sprechtagAppointments.eventId, eventId)).orderBy(sprechtagAppointments.slot);
    await expect(cancelAppointment(h.db, await p(other === a!.teacherId ? JANA : other), a!.id, NOW, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await cancelAppointment(h.db, await p(a!.teacherId), a!.id, NOW, TODAY);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, mother), eq(notifications.moduleId, "sprechtag")));
    expect(gong.map((g) => g.title)).toEqual([expect.stringMatching(/^Termin abgesagt: .*16:00 Uhr$/)]);
    await cancelAppointment(h.db, await p(mother), b!.id, NOW, TODAY);
    const tg = await h.db.select().from(notifications).where(and(eq(notifications.userId, b!.teacherId), eq(notifications.moduleId, "sprechtag")));
    expect(tg.map((g) => g.title).filter((t) => t.startsWith("Termin abgesagt"))).toEqual(["Termin abgesagt: Lea Schäfer, Donnerstag, 12. November, 16:10 Uhr"]);
    expect(await h.db.select().from(sprechtagAppointments).where(eq(sprechtagAppointments.eventId, eventId))).toEqual([]);
  });

  it("Volljährige (eigenständig) buchen selbst; ihre Eltern nicht mehr", async () => {
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, LEA));
    expect((await bookingStudents(h.db, await p(mother))).map((s) => s.id)).not.toContain(LEA);
    await expect(bookAppointments(h.db, await p(mother), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:20" }], NOW, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await bookingStudents(h.db, await p(LEA))).map((s) => s.id)).toEqual([LEA]);
    await bookAppointments(h.db, await p(LEA), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:20" }], NOW, TODAY);
    // Eltern ohne Einwilligung sehen den Termin nicht, mit Einwilligung nur lesend
    expect(await familyAppointments(h.db, await p(mother), eventId, { informed: true })).toEqual([]);
    await h.db.update(users).set({ parentsInformedSince: new Date() }).where(eq(users.id, LEA));
    expect((await familyAppointments(h.db, await p(mother), eventId, { informed: true })).map((a) => a.slot)).toEqual(["16:20"]);
    await h.db.update(users).set({ selfResponsible: false, parentsInformedSince: null }).where(eq(users.id, LEA));
  });
  it("G4D-C05/S03: wer gebucht hat, aber nicht mehr für das Kind handelt, darf nicht absagen und bekommt keinen Gong", async () => {
    // Termin noch als Mutter der minderjährigen Lea gebucht, danach wird Lea eigenständig (ohne Einwilligung)
    const [id] = await bookAppointments(h.db, await p(mother), eventId, [{ teacherId: other, studentId: LEA, slot: "16:00" }], NOW, TODAY);
    await h.db.update(users).set({ selfResponsible: true, parentsInformedSince: null }).where(eq(users.id, LEA));
    await expect(cancelAppointment(h.db, await p(mother), id!, NOW, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    const gongs = async (u: string) => (await h.db.select().from(notifications).where(and(eq(notifications.userId, u), eq(notifications.moduleId, "sprechtag")))).length;
    const [motherBefore, leaBefore] = [await gongs(mother), await gongs(LEA)];
    await cancelAppointment(h.db, await p(other), id!, NOW, TODAY);
    expect(await gongs(mother)).toBe(motherBefore);
    expect(await gongs(LEA)).toBe(leaBefore + 1);
    await h.db.update(users).set({ selfResponsible: false }).where(eq(users.id, LEA));
  });

  it("G4D-C07/C12: gleichzeitige Buchungen – dieselbe Person nie zweimal zur selben Zeit, Lehrkraft-Zeit genau einmal, Sammel-Vorschlag ganz oder gar nicht", async () => {
    const classmates = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler"), notInArray(users.id, [LEA])));
    const kids = [];
    for (const c of classmates) {
      const teachers = await teachersOfStudent(h.db, c.id, DATE);
      const parents = await h.db.select({ id: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, c.id));
      if (teachers.includes(JANA) && teachers.includes(other) && parents.some((x) => x.id !== mother)) kids.push({ id: c.id, parent: parents.find((x) => x.id !== mother)!.id });
      if (kids.length === 2) break;
    }
    expect(kids).toHaveLength(2);
    const [sib, kidY] = kids as [{ id: string; parent: string }, { id: string; parent: string }];
    // die Mutter hat ein zweites Kind in der 7b
    await h.db.insert(parentChild).values({ parentId: mother, childId: sib.id });
    const mom = await p(mother);
    // beide Anfragen lesen ihren Stand, bevor eine von ihnen schreibt: die Transaktion startet erst, wenn beide so weit sind
    // (wie zwei Tabs im selben Moment) – ohne Prüfung in der Transaktion gelängen beide Buchungen
    const together = () => {
      let arrived = 0;
      let go!: () => void;
      const all = new Promise<void>((r) => (go = r));
      return new Proxy(h.db, {
        get(target, key) {
          if (key === "transaction")
            return async (...args: Parameters<typeof target.transaction>) => {
              if (++arrived === 2) go();
              await all;
              return target.transaction(...args);
            };
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    };
    let slow = together();
    // (C07) zwei Tabs derselben Mutter: Lea bei der zweiten Lehrkraft, das Geschwisterkind bei Jana – beide 16:40
    const twoTabs = await Promise.allSettled([
      bookAppointments(slow, mom, eventId, [{ teacherId: other, studentId: LEA, slot: "16:40" }], NOW, TODAY),
      bookAppointments(slow, mom, eventId, [{ teacherId: JANA, studentId: sib.id, slot: "16:40" }], NOW, TODAY),
    ]);
    expect(twoTabs.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((twoTabs.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as Error)).toBeInstanceOf(ValidationError);
    const at1640 = await h.db.select().from(sprechtagAppointments).where(and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.slot, "16:40"), eq(sprechtagAppointments.bookedBy, mother)));
    expect(at1640).toHaveLength(1);
    await h.db.delete(sprechtagAppointments).where(eq(sprechtagAppointments.id, at1640[0]!.id));
    // (C12b) zwei Familien wollen gleichzeitig dieselbe Lehrkraft-Zeit; die Mutter als Sammel-Vorschlag mit zwei Terminen
    slow = together();
    const race = await Promise.allSettled([
      bookAppointments(slow, mom, eventId, [
        { teacherId: JANA, studentId: sib.id, slot: "16:10" },
        { teacherId: other, studentId: sib.id, slot: "16:20" },
      ], NOW, TODAY),
      bookAppointments(slow, await p(kidY.parent), eventId, [{ teacherId: other, studentId: kidY.id, slot: "16:20" }], NOW, TODAY),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const otherAt1620 = await h.db.select().from(sprechtagAppointments).where(and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.teacherId, other), eq(sprechtagAppointments.slot, "16:20")));
    expect(otherAt1620).toHaveLength(1);
    const sibAppts = await h.db.select().from(sprechtagAppointments).where(and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.studentId, sib.id), inArray(sprechtagAppointments.slot, ["16:10", "16:20"])));
    // Mutter gewonnen → beide Termine; verloren → keiner (kein Teiltermin bei Jana)
    expect(sibAppts).toHaveLength(race[0].status === "fulfilled" ? 2 : 0);
  });
});
