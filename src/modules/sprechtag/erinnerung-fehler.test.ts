// G4D-C11: scheitert der Versand der Erinnerung, bleibt der Sprechtag „nicht erinnert“ – der nächste Lauf versucht es erneut.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild, sprechtagEvents } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { runSprechtagReminders } from "./erinnerung";
import { bookAppointments, createEvent, releaseAvailability } from "./service";

const fail = vi.hoisted(() => ({ once: false }));
vi.mock("./mails", async (orig) => {
  const real = await orig<typeof import("./mails")>();
  return {
    ...real,
    verifiedEmails: async (...args: Parameters<typeof real.verifiedEmails>) => {
      if (fail.once) {
        fail.once = false;
        throw new Error("Testfehler beim Versand");
      }
      return real.verifiedEmails(...args);
    },
  };
});

const LEA = "u-lea.schaefer";
const JANA = "u-jana.brandt";
const opts = { mail: true, school: "Gesamtschule am Lindenhof" };

describe("Sprechtag-Erinnerung: Vermerk und Versand gemeinsam (G4D-C11)", () => {
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
    await bookAppointments(h.db, await p(mother), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:30" }], new Date("2026-11-02T10:00:00+01:00"), "2026-11-02");
  }, 60_000);
  afterAll(() => h.close());

  it("Fehler beim Versand → kein Vermerk, kein halber Gong; der nächste Lauf erinnert", async () => {
    fail.once = true;
    await expect(runSprechtagReminders(h.db, new Date("2026-11-11T16:00:00+01:00"), opts)).rejects.toThrow("Testfehler");
    const [e] = await h.db.select().from(sprechtagEvents).where(eq(sprechtagEvents.id, eventId));
    expect(e!.remindedOn).toBeNull();
    const reminder = () => h.db.select().from(notifications).where(and(eq(notifications.userId, mother), eq(notifications.bundleKey, `sprechtag:erinnerung:${eventId}`)));
    expect(await reminder()).toEqual([]);
    expect(await runSprechtagReminders(h.db, new Date("2026-11-11T17:00:00+01:00"), opts)).toBe(2);
    expect(await reminder()).toHaveLength(1);
  });
});
