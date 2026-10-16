import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { parentChild } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { monitorData } from "@/modules/monitor/service";
import { sprechtagSearch } from "./search";
import { bookAppointments, createEvent, releaseAvailability } from "./service";

const JANA = "u-jana.brandt";
const LEA = "u-lea.schaefer";

describe("Sprechtag: Monitor und Suche", () => {
  let h: DbHandle;
  let eventId: string;
  let mother: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const user = async (id: string) => ({ user: { id } as never, perms: await p(id) });

  beforeAll(async () => {
    h = await createSeededTestDb();
    [{ parentId: mother }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    eventId = await createEvent(
      h.db,
      await p("u-sabine.kowalski"),
      { title: "Herbstsprechtag", date: "2099-11-12", startsAt: "16:00", endsAt: "17:00", slotMinutes: 15, breaks: [], bookingOpensOn: "2026-01-01", bookingClosesOn: "2099-11-11" },
      "2026-11-02",
    );
    await releaseAvailability(h.db, await p(JANA), eventId, { roomId: "106", blockedSlots: [] }, "2026-11-02");
    await bookAppointments(h.db, await p(mother), eventId, [{ teacherId: JANA, studentId: LEA, slot: "16:00" }]);
  }, 60_000);
  afterAll(() => h.close());

  it("Monitor-Profil „Sprechtag“: Lehrkräfte und Räume, keine Familien", async () => {
    const d = await monitorData(h.db, { profile: "sprechtag" });
    expect(d.sprechtag).toMatchObject({ title: "Herbstsprechtag", time: "16:00–17:00 Uhr" });
    expect(d.sprechtag!.rows).toEqual([{ teacher: "Jana Brandt", code: "BRA", room: expect.any(String) }]);
    expect(JSON.stringify(d)).not.toMatch(/Lea|Schäfer/);
    expect((await monitorData(h.db, { profile: "foyer" })).sprechtag).toBeUndefined();
  });

  it("Suche: Verwaltung, Lehrkräfte und buchende Eltern finden den Sprechtag – Schüler:innen nicht", async () => {
    expect((await sprechtagSearch.search(h.db, await user("u-sabine.kowalski"), "herbst")).map((x) => x.href)).toEqual([`/sprechtag/${eventId}`]);
    expect((await sprechtagSearch.search(h.db, await user(JANA), "herbst")).map((x) => x.href)).toEqual([`/sprechtag/${eventId}`]);
    expect((await sprechtagSearch.search(h.db, await user(mother), "herbst")).map((x) => x.href)).toEqual([`/sprechtag/buchen?e=${eventId}`]);
    expect(await sprechtagSearch.search(h.db, await user(LEA), "herbst")).toEqual([]);
  });
});
