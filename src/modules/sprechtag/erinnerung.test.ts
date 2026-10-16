import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { mailOutbox, notifications, parentChild, sprechtagEvents, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { runSprechtagReminders } from "./erinnerung";
import { bookAppointments, createEvent, deleteEvent, releaseAvailability } from "./service";

const LEA = "u-lea.schaefer";
const JANA = "u-jana.brandt";
const opts = { mail: true, school: "Gesamtschule am Lindenhof" };

describe("Sprechtag: Gong bei Buchung, Erinnerung am Vortag", () => {
  let h: DbHandle;
  let eventId: string;
  let mother: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    [{ parentId: mother }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    eventId = await createEvent(
      h.db,
      await p("u-sabine.kowalski"),
      { title: "Sprechtag", date: "2026-11-12", startsAt: "16:00", endsAt: "17:00", slotMinutes: 15, breaks: [], bookingOpensOn: "2026-11-01", bookingClosesOn: "2026-11-11" },
      "2026-11-02",
    );
    await releaseAvailability(h.db, await p(JANA), eventId, { roomId: null, blockedSlots: [] }, "2026-11-02");
  }, 60_000);
  afterAll(() => h.close());

  it("Buchung → gebündelter Gong an die Lehrkraft (eine Nachricht je Sprechtag)", async () => {
    await bookAppointments(h.db, await p(mother), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:30" }], new Date("2026-11-02T10:00:00+01:00"), "2026-11-02");
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, JANA), eq(notifications.moduleId, "sprechtag")));
    expect(gong.map((g) => g.title)).toEqual(["Sprechtag: 1 Termin gebucht"]);
  });

  it("am Vortag einmal: Gong an Familie und Lehrkraft, Mail nur an bestätigte Adressen", async () => {
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, mother));
    expect(await runSprechtagReminders(h.db, new Date("2026-11-10T16:00:00+01:00"), opts)).toBe(0);
    expect(await runSprechtagReminders(h.db, new Date("2026-11-11T16:00:00+01:00"), opts)).toBe(2);
    expect(await runSprechtagReminders(h.db, new Date("2026-11-11T17:00:00+01:00"), opts)).toBe(0);
    const fam = await h.db.select().from(notifications).where(and(eq(notifications.userId, mother), eq(notifications.moduleId, "sprechtag")));
    expect(fam.map((g) => [g.title, g.body])).toEqual([["Morgen Elternsprechtag: 1 Termin", "16:30–16:45 Jana Brandt (Lea Schäfer)"]]);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "sprechtag-erinnerung"));
    expect(mails.map((m) => m.to)).toEqual(["mutter@example.org"]);
    const [e] = await h.db.select().from(sprechtagEvents).where(eq(sprechtagEvents.id, eventId));
    expect(e!.remindedOn).toBe("2026-11-11");
  });

  it("Job im Zeitplan", () => {
    expect(SCHEDULED_JOBS.find((j) => j.name === "sprechtag-erinnerung")).toMatchObject({ at: "15:00", until: "20:00" });
  });
  it("G4D-C05/S03: nach „eigenständig“ erinnert und benachrichtigt der Sprechtag die Person selbst, nicht mehr das buchende Elternteil", async () => {
    const sabine = await p("u-sabine.kowalski");
    const id = await createEvent(h.db, sabine, { title: "Sprechtag 2", date: "2026-11-19", startsAt: "16:00", endsAt: "17:00", slotMinutes: 15, breaks: [], bookingOpensOn: "2026-11-01", bookingClosesOn: "2026-11-18" }, "2026-11-02");
    await releaseAvailability(h.db, await p(JANA), id, { roomId: null, blockedSlots: [] }, "2026-11-02");
    await bookAppointments(h.db, await p(mother), id, [{ teacherId: JANA, studentId: LEA, slot: "16:15" }], new Date("2026-11-02T10:00:00+01:00"), "2026-11-02");
    await h.db.update(users).set({ selfResponsible: true, parentsInformedSince: null }).where(eq(users.id, LEA));
    const toMother = () => h.db.select().from(mailOutbox).where(and(eq(mailOutbox.purpose, "sprechtag-erinnerung"), eq(mailOutbox.to, "mutter@example.org")));
    const before = (await toMother()).length;
    expect(await runSprechtagReminders(h.db, new Date("2026-11-18T16:00:00+01:00"), opts)).toBe(2);
    const reminded = await h.db.select().from(notifications).where(eq(notifications.bundleKey, `sprechtag:erinnerung:${id}`));
    expect(reminded.map((n) => n.userId).sort()).toEqual([JANA, LEA].sort());
    expect(await toMother()).toHaveLength(before);
    const gong = (u: string) => h.db.select().from(notifications).where(and(eq(notifications.userId, u), eq(notifications.title, "Sprechtag abgesagt: Sprechtag 2 (Donnerstag, 19. November)")));
    await deleteEvent(h.db, sabine, id);
    expect(await gong(mother)).toEqual([]);
    expect(await gong(LEA)).toHaveLength(1);
    await h.db.update(users).set({ selfResponsible: false }).where(eq(users.id, LEA));
  });
});
