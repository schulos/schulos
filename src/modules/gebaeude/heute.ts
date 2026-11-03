// „Heute im Haus“ (Q5-08b, I-50): Veranstaltungen (VA-02), Raumbuchungen, Wartungstermine und Raumsperren des Tages für die Hausmeisterei.
// Nur mit `gebaeude.manage`; Buchungen nur bei eingeschaltetem Modul Buchungen (ohne Notiz), Sperren nur mit Stundenplan.
import type { Db } from "@/core/db/client";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { getModule } from "@/modules";
import { bookingsOn, type DayBooking } from "@/modules/buchungen/service";
import { blocksOn, type RoomBlock } from "@/modules/stundenplan/raumsperren";
import { eventsOn } from "./veranstaltungen";
import { listMaintenance } from "./wartung";

export interface TodayInHouse {
  bookingsVisible: boolean;
  bookings: DayBooking[];
  maintenance: Awaited<ReturnType<typeof listMaintenance>>;
  blocks: RoomBlock[];
  /** VA-02: Veranstaltungen, deren Auf-/Abbau den Tag berührt (ohne abgelehnte/abgesagte) */
  events: Awaited<ReturnType<typeof eventsOn>>;
}

export async function todayInHouse(db: Db, viewer: PermissionSet, now = new Date()): Promise<TodayInHouse> {
  if (!hasPermission(viewer, "gebaeude.manage")) throw new ForbiddenError("gebaeude.manage");
  const today = toBerlinDate(now);
  const states = await loadModuleStates(db);
  const on = (id: string) => {
    const m = getModule(id);
    return !!m && isEnabled(m, states);
  };
  const dayStart = fromBerlinLocal(`${today}T00:00`);
  const dayEnd = fromBerlinLocal(`${addDays(today, 1)}T00:00`);
  const bookingsVisible = on("buchungen");
  const [bookings, maintenance, blocks, events] = await Promise.all([
    bookingsVisible ? bookingsOn(db, today, "room") : Promise.resolve([]),
    listMaintenance(db, viewer, dayStart),
    on("stundenplan") ? blocksOn(db, today) : Promise.resolve([]),
    eventsOn(db, today),
  ]);
  return { bookingsVisible, bookings, maintenance: maintenance.filter((m) => m.startsAt < dayEnd), blocks, events };
}
