import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { ganztagGroupSettings, ganztagMarks, ganztagMenus, ganztagSeries, ganztagSessions, ganztagWayHomeRules, grants, groupFeatures, groupMembers, groups, schoolYears } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, toBerlinDate, weekdayMon0 } from "@/core/time";
import { LIST_FEATURE, seriesDates } from "./service";

/**
 * Demo-Ganztag (GT-01): zwei AGs mit Anwesenheitsliste und wöchentlicher Serie über das Schuljahr (Ferien übersprungen) –
 * Schülerzeitung (Leitung Jana Brandt) dienstags, Robotik donnerstags. Der letzte vergangene Robotik-Termin ist erfasst.
 * Schulleitung bekommt „Ganztag auswerten“ (Vorgabe laut GANZTAG.md; die Auswertung selbst folgt mit GT-06).
 */
export async function seedGanztag(db: Db, now = new Date()) {
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
  if (!year) return;
  const offers = [
    { groupId: "g-ag-schuelerzeitung", weekday: 1, startsAt: "14:00", endsAt: "15:30" },
    { groupId: "g-ag-robotik", weekday: 3, startsAt: "14:15", endsAt: "15:45" },
  ];
  const present = await db.select({ id: groups.id }).from(groups);
  const ids = new Set(present.map((g) => g.id));
  const cal = await loadSchoolCalendar(db);
  for (const o of offers) {
    if (!ids.has(o.groupId)) continue;
    await db.insert(groupFeatures).values({ groupId: o.groupId, feature: LIST_FEATURE }).onConflictDoNothing();
    await db.insert(ganztagGroupSettings).values({ groupId: o.groupId, mandatory: o.groupId === "g-ag-robotik" }).onConflictDoNothing();
    const seriesId = `ganztag-serie-${o.groupId}`;
    await db.insert(ganztagSeries).values({ id: seriesId, groupId: o.groupId, schoolYearId: year.id, weekday: o.weekday, startsAt: o.startsAt, endsAt: o.endsAt, validFrom: year.startsOn, validTo: year.endsOn });
    const { dates } = seriesDates(cal, o.weekday, year.startsOn, year.endsOn);
    if (dates.length) await db.insert(ganztagSessions).values(dates.map((date) => ({ groupId: o.groupId, seriesId, date, startsAt: o.startsAt, endsAt: o.endsAt })));
  }
  await db.insert(grants).values({ permission: "ganztag.view_all", groupId: "g-schulleitung" }).onConflictDoNothing();

  // GT-11: Speiseplan für die nächsten zwei Wochen (Mo–Fr), zwei nummerierte Menüs – nach Gericht benannt, nicht nach Kostform
  const dishes = [
    ["Spaghetti mit Tomatensoße", "Gemüsereis mit Joghurtdip"],
    ["Hähnchen mit Kartoffeln", "Kartoffel-Gemüse-Auflauf"],
    ["Linsensuppe mit Brot", "Pfannkuchen mit Apfelmus"],
    ["Fischstäbchen mit Kartoffelpüree", "Gemüselasagne"],
    ["Milchreis mit Kirschen", "Nudeln mit Brokkoli"],
  ] as const;
  const menuRows: { date: string; number: number; title: string }[] = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(toBerlinDate(now), i);
    const wd = weekdayMon0(date);
    if (wd > 4 || cal.dayOff(date)) continue;
    dishes[wd]!.forEach((title, n) => menuRows.push({ date, number: n + 1, title }));
  }
  if (menuRows.length) await db.insert(ganztagMenus).values(menuRows).onConflictDoNothing();

  // ein erfasster Termin für die Demo: der letzte vor heute in der Robotik-AG
  const today = toBerlinDate(now);
  const [last] = await db
    .select()
    .from(ganztagSessions)
    .where(and(eq(ganztagSessions.groupId, "g-ag-robotik"), lt(ganztagSessions.date, today)))
    .orderBy(desc(ganztagSessions.date))
    .limit(1);
  if (!last) return;
  const kids = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, "g-ag-robotik"), eq(groupMembers.role, "member")))
    .orderBy(groupMembers.userId);
  const [leader] = await db.select({ id: groupMembers.userId }).from(groupMembers).where(and(eq(groupMembers.groupId, "g-ag-robotik"), eq(groupMembers.role, "leader")));
  if (kids.length === 0) return;
  // GT-09: Heimweg für die ersten Kinder der Robotik-AG (nur die Art, keine Namen Abholberechtigter)
  const ways = ["allein", "abgeholt", "bus"] as const;
  await db
    .insert(ganztagWayHomeRules)
    .values(kids.slice(0, 3).map((k, i) => ({ groupId: "g-ag-robotik", studentId: k.id, way: ways[i]!, updatedBy: leader?.id ?? null })))
    .onConflictDoNothing();
  const recordedAt = new Date(`${last.date}T14:30:00Z`);
  await db.insert(ganztagMarks).values(
    kids.map((k, i) => ({
      sessionId: last.id,
      studentId: k.id,
      status: i === 0 ? ("fehlt" as const) : i === 1 ? ("verspaetet" as const) : ("anwesend" as const),
      minutesLate: i === 1 ? 10 : null,
      source: i < 2 ? ("leitung" as const) : ("alle_anwesend" as const),
      recordedBy: leader?.id ?? null,
      recordedAt,
    })),
  );
  await db.update(ganztagSessions).set({ status: "erfasst", allPresent: true, recordedAt, recordedBy: leader?.id ?? null }).where(eq(ganztagSessions.id, last.id));
}
