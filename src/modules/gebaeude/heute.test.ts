import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { bookingResources, bookings, gebaeudeMaintenance, timetableRoomBlocks } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { setModuleEnabled } from "@/core/modules/registry";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { fromBerlinLocal } from "@/core/time";
import buchungen from "@/modules/buchungen/manifest";
import { bookingAccess } from "@/modules/buchungen/service";
import { todayInHouse } from "./heute";

const DAY = "2026-10-06";
const NOW = fromBerlinLocal(`${DAY}T07:30`);
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.manage
const JANA = "u-jana.brandt";

describe("Heute im Haus + Buchungen lesen (Q5-08b)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(bookings);
    await h.db.delete(gebaeudeMaintenance);
    await h.db.delete(timetableRoomBlocks);
    await h.db.delete(bookingResources);
    const [aula, cart] = await h.db
      .insert(bookingResources)
      .values([
        { kind: "room", roomId: "106", name: "Raum 106" },
        { kind: "device", name: "Laptopwagen" },
      ])
      .returning({ id: bookingResources.id });
    await h.db.insert(bookings).values([
      { resourceId: aula!.id, date: DAY, periodNr: 3, bookedBy: JANA, groupId: "g-7b", note: "Theaterprobe mit Namen" },
      { resourceId: cart!.id, date: DAY, periodNr: 2, bookedBy: JANA, note: null }, // Gerät: nicht im Widget
      { resourceId: aula!.id, date: "2026-10-07", periodNr: 1, bookedBy: JANA }, // anderer Tag
    ]);
    await h.db.insert(gebaeudeMaintenance).values([
      { title: "Heizungswartung", startsAt: fromBerlinLocal(`${DAY}T06:00`), endsAt: fromBerlinLocal(`${DAY}T08:00`), building: "Altbau" },
      { title: "Aufzug", startsAt: fromBerlinLocal("2026-10-07T08:00"), endsAt: fromBerlinLocal("2026-10-07T10:00") }, // morgen
    ]);
    await h.db.insert(timetableRoomBlocks).values([
      { roomId: "106", startsOn: "2026-10-05", endsOn: DAY, reason: "sonstiges", fromPeriod: 5, toPeriod: 6 },
      { roomId: "107", startsOn: "2026-10-08", endsOn: "2026-10-09", reason: "sonstiges" }, // später
    ]);
  }, 60_000);
  afterAll(() => h.close());

  it("Zugriff auf /buchungen: buchen mit Recht, Hausmeisterei nur lesend und nur mit Modul Gebäude, sonst keiner", async () => {
    const [klaus, jana, lea] = await Promise.all([p(KLAUS), p(JANA), p("u-lea.schaefer")]);
    expect(bookingAccess(jana, true)).toBe("book");
    expect(bookingAccess(klaus, true)).toBe("read");
    expect(bookingAccess(klaus, false)).toBeNull();
    expect(bookingAccess(lea, true)).toBeNull();
  });

  it("Widget: Raumbuchungen (ohne Notiz), Wartung und Sperren von heute; nur mit gebaeude.manage", async () => {
    const klaus = await p(KLAUS);
    const r = await todayInHouse(h.db, klaus, NOW);
    expect(r.bookings.map((b) => [b.periodNr, b.resourceName, b.groupName, b.byName])).toEqual([[3, "Raum 106", "Klasse 7b", "Jana Brandt"]]);
    expect(JSON.stringify(r.bookings)).not.toContain("Theaterprobe");
    // bereits vorbei (06–08 Uhr) zählt am selben Tag weiter
    expect(r.maintenance.map((m) => m.title)).toEqual(["Heizungswartung"]);
    expect(r.blocks.map((b) => b.roomId)).toEqual(["106"]);
    await expect(todayInHouse(h.db, await p(JANA), NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Modul Buchungen aus → keine Buchungen im Widget", async () => {
    await setModuleEnabled(h.db, buchungen, false);
    const r = await todayInHouse(h.db, await p(KLAUS), NOW);
    expect(r).toMatchObject({ bookingsVisible: false, bookings: [] });
    await setModuleEnabled(h.db, buchungen, true);
  });
});
