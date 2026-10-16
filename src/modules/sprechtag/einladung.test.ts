import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { mailOutbox, notifications, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { inviteFamily, myInvitations, studentsOfTeacher, withdrawInvitation } from "./einladung";
import { bookAppointments, createEvent, releaseAvailability } from "./service";

const TODAY = "2026-11-02";
const DATE = "2026-11-12";
const LEA = "u-lea.schaefer";
const JANA = "u-jana.brandt";
const opts = { mail: true, school: "Gesamtschule am Lindenhof" };

describe("Gesprächswunsch", () => {
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
      { title: "Sprechtag", date: DATE, startsAt: "16:00", endsAt: "17:00", slotMinutes: 15, breaks: [], bookingOpensOn: "2026-11-01", bookingClosesOn: "2026-11-11" },
      TODAY,
    );
  }, 60_000);
  afterAll(() => h.close());

  it("eigene Schüler:innen der Lehrkraft (Klasse 7b gehört dazu)", async () => {
    const list = await studentsOfTeacher(h.db, JANA, DATE);
    expect(list.find((s) => s.id === LEA)).toMatchObject({ className: "7b" });
  });

  it("erst Zeiten freigeben, dann Gong + Mail (nur bestätigte echte Adresse) an die Eltern", async () => {
    const jana = await p(JANA);
    await expect(inviteFamily(h.db, jana, eventId, LEA, opts, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await releaseAvailability(h.db, jana, eventId, { roomId: null, blockedSlots: [] }, TODAY);
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, mother));
    expect(await inviteFamily(h.db, jana, eventId, LEA, opts, TODAY)).toBe(1);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, mother), eq(notifications.moduleId, "sprechtag")));
    expect(gong.map((g) => g.title)).toEqual(["Gesprächswunsch von Jana Brandt"]);
    expect(gong[0]!.href).toBe(`/sprechtag/buchen?e=${eventId}`);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "sprechtag-gespraechswunsch"));
    expect(mails.map((m) => m.to)).toEqual(["mutter@example.org"]);
    expect(mails[0]!.text).toContain("Lea");
    await expect(inviteFamily(h.db, jana, eventId, LEA, opts, TODAY)).rejects.toBeInstanceOf(ValidationError);
  });

  it("nur eigene Schüler:innen; Eltern dürfen nicht einladen", async () => {
    const stranger = (await h.db.select({ id: users.id }).from(users).where(eq(users.role, "schueler"))).map((u) => u.id);
    const mine = new Set((await studentsOfTeacher(h.db, JANA, DATE)).map((s) => s.id));
    const other = stranger.find((s) => !mine.has(s))!;
    await expect(inviteFamily(h.db, await p(JANA), eventId, other, opts, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await expect(inviteFamily(h.db, await p(mother), eventId, LEA, opts, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Stand: gebucht ja/nein; Zurücknehmen", async () => {
    expect((await myInvitations(h.db, eventId, JANA)).map((i) => [i.name, i.bookedSlot])).toEqual([["Lea Schäfer", null]]);
    await bookAppointments(h.db, await p(mother), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:15" }], new Date("2026-11-02T10:00:00+01:00"), TODAY);
    expect((await myInvitations(h.db, eventId, JANA))[0]!.bookedSlot).toBe("16:15");
    await withdrawInvitation(h.db, await p(JANA), eventId, LEA);
    expect(await myInvitations(h.db, eventId, JANA)).toEqual([]);
  });
});
