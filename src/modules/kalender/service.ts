// Kalender: persönlich, Gruppe (Gruppenmerkmal), Schule. Wöchentliche Serien werden beim Lesen aufgefaltet.
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { calendarEvents, groupFeatures, groupMembers, groups } from "@/core/db/schema";
import { childIdsQuery } from "@/core/school/majority";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, toBerlinDate, toBerlinLocal } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { de } from "@/core/db/sort";

export const GROUP_CALENDAR_FEATURE = "kalender.gruppenkalender";
const STAFF = ["lehrkraft", "verwaltung", "admin"];

export type CalendarKey = "personal" | "school" | `group:${string}`;

export interface CalendarInfo {
  key: CalendarKey;
  label: string;
  color: string;
}

const PALETTE = ["#1971C2", "#7048E8", "#2F9E44", "#C2255C", "#E8590C", "#0C8599", "#5C940D", "#AE3EC9"];
function colorFor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** Gruppenkalender, die der Betrachter sehen darf: Gruppen mit Merkmal, in denen er (oder sein Kind) Mitglied ist. */
async function readableGroups(db: Db, viewer: PermissionSet) {
  const ids = new Set(viewer.memberOf);
  if (viewer.role === "eltern") {
    const kids = await db
      .select({ g: groupMembers.groupId })
      .from(groupMembers)
      // Q5-05: eigenständige Kinder nur mit deren Einwilligung
      .where(inArray(groupMembers.userId, childIdsQuery(db, viewer.userId, "inform")));
    kids.forEach((k) => ids.add(k.g));
  }
  if (ids.size === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name, subjectId: groups.subjectId })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, GROUP_CALENDAR_FEATURE)))
    .where(inArray(groups.id, [...ids]))
    .orderBy(de(groups.name));
}

/** Alle Kalender, die der Betrachter sieht. */
export async function readableCalendars(db: Db, viewer: PermissionSet): Promise<CalendarInfo[]> {
  const gs = await readableGroups(db, viewer);
  return [
    { key: "personal", label: "Persönlich", color: "#5B6472" },
    { key: "school", label: "Schule", color: "var(--accent)" },
    ...gs.map((g) => ({ key: `group:${g.id}` as const, label: g.name, color: colorFor(g.id) })),
  ];
}

/** Darf der Betrachter in diesen Kalender schreiben? */
export function canWriteCalendar(viewer: PermissionSet, key: CalendarKey): boolean {
  if (key === "personal") return true;
  if (hasPermission(viewer, "kalender.manage")) return true;
  if (key === "school") return hasPermission(viewer, "kalender.school");
  const groupId = key.slice(6);
  // Gruppenleitung oder Personal, das Mitglied ist
  return viewer.leaderOf.has(groupId) || (STAFF.includes(viewer.role) && viewer.memberOf.has(groupId));
}

export async function writableCalendars(db: Db, viewer: PermissionSet): Promise<CalendarInfo[]> {
  return (await readableCalendars(db, viewer)).filter((c) => canWriteCalendar(viewer, c.key));
}

function keyOf(e: { scope: string; groupId: string | null }): CalendarKey {
  return e.scope === "group" ? `group:${e.groupId}` : (e.scope as "personal" | "school");
}

export interface Occurrence {
  eventId: string;
  key: CalendarKey;
  calendar: string;
  color: string;
  title: string;
  location: string | null;
  description: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  ownerId: string | null;
  /** Ziel beim Anklicken, wenn nicht der Termin selbst (z. B. Klassenarbeit → Klausurplan) */
  href?: string;
}

/**
 * Termine im Zeitraum [fromYmd, toYmd) (Berliner Kalendertage), Serien aufgefaltet,
 * nach Beginn sortiert. `only` schränkt auf bestimmte Kalender ein.
 */
export async function listOccurrences(db: Db, viewer: PermissionSet, fromYmd: string, toYmd: string, only?: CalendarKey[]): Promise<Occurrence[]> {
  const cals = await readableCalendars(db, viewer);
  const visible = only ? cals.filter((c) => only.includes(c.key)) : cals;
  const info = new Map(cals.map((c) => [c.key, c]));
  const groupIds = visible.filter((c) => c.key.startsWith("group:")).map((c) => c.key.slice(6));

  const scopeConds: SQL[] = [];
  if (visible.some((c) => c.key === "personal")) scopeConds.push(and(eq(calendarEvents.scope, "personal"), eq(calendarEvents.ownerId, viewer.userId))!);
  if (visible.some((c) => c.key === "school")) scopeConds.push(eq(calendarEvents.scope, "school"));
  if (groupIds.length) scopeConds.push(inArray(calendarEvents.groupId, groupIds));
  if (scopeConds.length === 0) return [];

  const from = fromBerlinLocal(fromYmd);
  const to = fromBerlinLocal(toYmd);
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        or(...scopeConds),
        lt(calendarEvents.startsAt, to),
        or(
          and(isNull(calendarEvents.repeatWeeklyUntil), gte(calendarEvents.endsAt, from)),
          and(isNotNull(calendarEvents.repeatWeeklyUntil), gte(calendarEvents.repeatWeeklyUntil, fromYmd)),
        ),
      ),
    );

  const out: Occurrence[] = [];
  for (const e of rows) {
    const key = keyOf(e);
    const cal = info.get(key)!;
    const base = {
      eventId: e.id,
      key,
      calendar: cal.label,
      color: cal.color,
      title: e.title,
      location: e.location,
      description: e.description,
      allDay: e.allDay,
      recurring: !!e.repeatWeeklyUntil,
      ownerId: e.ownerId,
    };
    if (!e.repeatWeeklyUntil) {
      out.push({ ...base, start: e.startsAt, end: e.endsAt });
      continue;
    }
    // Serie: in Ortszeit um je 7 Tage verschieben (bleibt bei Zeitumstellung auf derselben Uhrzeit)
    const startLocal = toBerlinLocal(e.startsAt);
    const durationMs = e.endsAt.getTime() - e.startsAt.getTime();
    for (let k = 0; k < 200; k++) {
      const day = addDays(startLocal.slice(0, 10), 7 * k);
      if (day > e.repeatWeeklyUntil || day >= toYmd) break;
      const start = fromBerlinLocal(`${day}${startLocal.slice(10)}`);
      const end = new Date(start.getTime() + durationMs);
      if (end >= from) out.push({ ...base, start, end });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
}

export interface EventInput {
  calendar: CalendarKey;
  title: string;
  description?: string | null;
  location?: string | null;
  allDay: boolean;
  /** „YYYY-MM-DDTHH:MM" bzw. bei ganztägig „YYYY-MM-DD" (Berliner Ortszeit) */
  start: string;
  end: string;
  repeatWeeklyUntil?: string | null;
}

function toRow(viewer: PermissionSet, input: EventInput) {
  const errors: Record<string, string> = {};
  if (!input.title.trim()) errors.title = "Titel fehlt";
  let startsAt: Date | undefined;
  let endsAt: Date | undefined;
  try {
    startsAt = fromBerlinLocal(input.allDay ? input.start.slice(0, 10) : input.start);
    // ganztägig: Ende = Mitternacht nach dem letzten Tag
    endsAt = input.allDay ? fromBerlinLocal(addDays(input.end.slice(0, 10), 1)) : fromBerlinLocal(input.end);
  } catch {
    errors.start = "Ungültiges Datum";
  }
  if (startsAt && endsAt && endsAt < startsAt) errors.end = "Ende liegt vor dem Beginn";
  if (input.repeatWeeklyUntil && startsAt && input.repeatWeeklyUntil < toBerlinDate(startsAt)) errors.repeatWeeklyUntil = "Serie endet vor dem ersten Termin";
  if (!canWriteCalendar(viewer, input.calendar)) errors.calendar = "In diesen Kalender darfst du nicht schreiben";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const scope = input.calendar.startsWith("group:") ? "group" : (input.calendar as "personal" | "school");
  return {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    location: input.location?.trim() || null,
    allDay: input.allDay,
    startsAt: startsAt!,
    endsAt: endsAt!,
    scope,
    groupId: scope === "group" ? input.calendar.slice(6) : null,
    repeatWeeklyUntil: input.repeatWeeklyUntil || null,
  } as const;
}

export async function createEvent(db: Db, viewer: PermissionSet, input: EventInput): Promise<string> {
  const row = toRow(viewer, input);
  const [e] = await db.insert(calendarEvents).values({ ...row, ownerId: viewer.userId }).returning({ id: calendarEvents.id });
  return e!.id;
}

export async function getEvent(db: Db, viewer: PermissionSet, id: string) {
  const [e] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
  if (!e) return null;
  const key = keyOf(e);
  if (key === "personal" && e.ownerId !== viewer.userId) return null;
  if (key !== "personal" && !(await readableCalendars(db, viewer)).some((c) => c.key === key)) return null;
  return { ...e, key, editable: canWriteCalendar(viewer, key) && (key !== "personal" || e.ownerId === viewer.userId) };
}

export async function updateEvent(db: Db, viewer: PermissionSet, id: string, input: EventInput): Promise<void> {
  const existing = await getEvent(db, viewer, id);
  if (!existing?.editable) throw new ValidationError({ title: "Keine Berechtigung" });
  await db.update(calendarEvents).set(toRow(viewer, input)).where(eq(calendarEvents.id, id));
}

export async function deleteEvent(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  const existing = await getEvent(db, viewer, id);
  if (!existing?.editable) throw new ValidationError({ title: "Keine Berechtigung" });
  await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
}

/** Rohtermine eines Kalenders (Serien NICHT aufgefaltet) – für den ICS-Export. */
export async function listCalendarEvents(db: Db, viewer: PermissionSet, key: CalendarKey) {
  const cal = (await readableCalendars(db, viewer)).find((c) => c.key === key);
  if (!cal) return null;
  const where =
    key === "personal"
      ? and(eq(calendarEvents.scope, "personal"), eq(calendarEvents.ownerId, viewer.userId))
      : key === "school"
        ? eq(calendarEvents.scope, "school")
        : eq(calendarEvents.groupId, key.slice(6));
  return { calendar: cal, events: await db.select().from(calendarEvents).where(where).orderBy(asc(calendarEvents.startsAt)) };
}

const DAY_OFF_TITLE = { feiertag: "Feiertag", ferien: "Ferien", frei: "unterrichtsfrei" } as const;

/** Feiertage, Ferien und unterrichtsfreie Tage im Zeitraum [fromYmd, toYmd) als ganztägige Termine (nur lesend). */
export async function schoolDayOffOccurrences(db: Db, fromYmd: string, toYmd: string): Promise<Occurrence[]> {
  const cal = await loadSchoolCalendar(db);
  return cal.between(fromYmd, addDays(toYmd, -1)).map((x) => ({
    eventId: `dayoff-${x.kind}-${x.startsOn}`,
    key: "school" as const,
    calendar: "Ferien & Feiertage",
    color: "#868E96",
    title: x.kind === "ferien" ? x.name : `${x.name} (${DAY_OFF_TITLE[x.kind]})`,
    location: null,
    description: null,
    start: fromBerlinLocal(x.startsOn),
    end: fromBerlinLocal(addDays(x.endsOn, 1)),
    allDay: true,
    recurring: false,
    ownerId: null,
    // keine eigene Terminseite: Klick öffnet den Monat
    href: `/kalender?ansicht=monat&datum=${x.startsOn}`,
  }));
}

/** Termine des Schulkalenders (für alle sichtbar) – für Statusmonitore, an denen niemand angemeldet ist. */
export async function schoolOccurrences(db: Db, fromYmd: string, toYmd: string): Promise<Occurrence[]> {
  const nobody: PermissionSet = { userId: "", role: "schueler", locked: false, granted: new Set(), memberOf: new Set(), leaderOf: new Set() };
  return listOccurrences(db, nobody, fromYmd, toYmd, ["school"]);
}
