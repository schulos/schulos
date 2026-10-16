import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { calendarEvents, groupFeatures, groups } from "@/core/db/schema";
import { addDays, fromBerlinLocal, mondayOf, toBerlinDate } from "@/core/time";
import { GROUP_CALENDAR_FEATURE } from "./service";

/** Gruppenkalender für alle festen Gruppen + Beispieltermine rund um die aktuelle Woche. */
export async function seedKalender(db: Db, now = new Date()) {
  const gs = await db
    .select({ id: groups.id })
    .from(groups)
    .where(inArray(groups.kind, ["klasse", "kurs", "ag", "fachschaft", "gremium"]));
  await db.insert(groupFeatures).values(gs.map((g) => ({ groupId: g.id, feature: GROUP_CALENDAR_FEATURE })));

  const mo = mondayOf(toBerlinDate(now));
  const at = (dayOffset: number, hm: string) => fromBerlinLocal(`${addDays(mo, dayOffset)}T${hm}`);
  const day = (dayOffset: number) => fromBerlinLocal(addDays(mo, dayOffset));

  await db.insert(calendarEvents).values([
    { id: "ev-sprechtag", title: "Elternsprechtag", location: "Hauptgebäude", scope: "school", ownerId: "u-sabine.kowalski", startsAt: at(3, "15:00"), endsAt: at(3, "19:00") },
    { id: "ev-konferenz", title: "Lehrerkonferenz", location: "Aula", scope: "group", groupId: "g-lehrerkonferenz", ownerId: "u-petra.lindner", startsAt: at(1, "14:30"), endsAt: at(1, "16:30") },
    // Ferien liefert der Schulkalender (Stammdaten), hier nur ein mehrtägiger Schultermin
    { id: "ev-austausch", title: "Schüleraustausch Frankreich", scope: "school", allDay: true, ownerId: "u-sabine.kowalski", startsAt: day(12), endsAt: day(19) },
    { id: "ev-wandertag", title: "Wandertag 7b", description: "Treffpunkt 8:15 Uhr am Bahnhof", scope: "group", groupId: "g-7b", allDay: true, ownerId: "u-jana.brandt", startsAt: day(9), endsAt: day(10) },
    { id: "ev-elternabend", title: "Elternabend 7b", location: "Raum 112", scope: "group", groupId: "g-7b", ownerId: "u-jana.brandt", startsAt: at(8, "19:00"), endsAt: at(8, "20:30") },
    { id: "ev-klausur-q1e", title: "Klausur Englisch", location: "Raum 301", scope: "group", groupId: "g-q1-e-gk1", ownerId: "u-jana.brandt", startsAt: at(4, "09:55"), endsAt: at(4, "11:30") },
    {
      id: "ev-schuelerzeitung",
      title: "Redaktionstreffen",
      location: "Bibliothek",
      scope: "group",
      groupId: "g-ag-schuelerzeitung",
      ownerId: "u-jana.brandt",
      startsAt: at(3, "14:15"),
      endsAt: at(3, "15:45"),
      repeatWeeklyUntil: addDays(mo, 7 * 10 + 3),
    },
    { id: "ev-korrektur", title: "Korrekturen Erörterung 7b", scope: "personal", ownerId: "u-jana.brandt", startsAt: at(2, "16:00"), endsAt: at(2, "18:00") },
  ]);
}
