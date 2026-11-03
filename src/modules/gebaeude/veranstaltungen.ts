// Veranstaltungsanmeldung an die Hausmeisterei (VA-01…03, PHASE4 P4-75, Projektleitung 2026-11-02): eigene Tabellen statt
// Ticket-Kategorie. Anmelden darf, wer Mängel melden darf (`gebaeude.report`); bestätigen, zurückfragen und ablehnen die
// Hausmeisterei (`gebaeude.manage`). Mit eingeschalteter Moduleinstellung geht die Anmeldung zuerst an die Schulleitung
// (`gebaeude.event_approve`). Bei der Bestätigung sperrt SchulOS Räume nur dort, wo Unterricht betroffen ist (je Raum und Tag die
// berührten Stunden); Wartung, Raumsperren, Buchungen und andere Veranstaltungen sind nur ein Konflikthinweis. Optional
// Schulkalender-Eintrag. „Heute im Haus“, Wochenvorschau, Gong am Vortag (Job `gebaeude-veranstaltungen`). Löschklasse LK-ENDE-1J.
// VA-05/06 (Projektleitung 2026-11-03): Bearbeiten durch die anmeldende Person – Zeit oder Räume geändert → zurück auf „angemeldet“
// (Sperren und Kalendereintrag fallen weg), erneute Freigabe nur bei geändertem Zeitraum oder zusätzlichen Räumen; sonst bleibt die
// Bestätigung. Serien wöchentlich/alle 2 Wochen (bis Datum oder höchstens 26 Termine, Ferien und freie Tage übersprungen), Bestätigung
// der ganzen Serie in einem Schritt (Termine mit Konflikt bleiben offen), Ändern/Absagen „nur dieser“ oder „dieser und alle folgenden“.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  bookingResources,
  bookings,
  calendarEvents,
  gebaeudeEventBlocks,
  gebaeudeEventHistory,
  gebaeudeEventRooms,
  gebaeudeEvents,
  gebaeudeMaintenance,
  gebaeudeMaintenanceRooms,
  periods,
  rooms,
  timetableRoomBlocks,
  users,
} from "@/core/db/schema";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { readModuleSetting } from "@/core/modules/settings";
import { notify } from "@/core/notifications";
import { dayOffLabel, loadSchoolCalendar, type SchoolCalendar } from "@/core/school/calendar";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, isCalendarDate, toBerlinDate } from "@/core/time";
import { getModule } from "@/modules";
import { blockLabel, createRoomBlock, deleteRoomBlock, teachersInRooms } from "@/modules/stundenplan/raumsperren";
import { periodsText } from "@/modules/stundenplan/tagesmitteilungen";
import { listSlots } from "@/modules/stundenplan/service";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  EVENT_ACTIVE_STATUSES,
  EVENT_MAX_DAYS,
  EVENT_MAX_PERSONS,
  EVENT_MAX_ROOMS,
  EVENT_NEED_KEYS,
  EVENT_REPEATS,
  EVENT_SEATING,
  EVENT_SERIES_MAX,
  EVENT_TEXT_MAX,
  type EventHistoryKind,
  type EventNeed,
  type EventRepeat,
  type EventScope,
  type EventSeating,
  type EventStatus,
} from "./labels";
import type { GebaeudeEvent } from "./schema";
import { canManage, canReport, canViewAll, responsibleUsers } from "./service";
import { EVENT_APPROVAL } from "./settings";

const MODULE = "gebaeude";
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const EVENT_APPROVE_PERMISSION = "gebaeude.event_approve";
export const EVENTS_HREF = "/gebaeude/veranstaltungen";
const eventHref = (id: string) => `${EVENTS_HREF}/${id}`;

// ---------------------------------------------------------------- Rechte

export const canApproveEvents = (p: PermissionSet) => hasPermission(p, EVENT_APPROVE_PERMISSION);
/** Übersicht aller Veranstaltungen: Hausmeisterei/Verwaltung (`manage`/`view_all`) und die Schulleitung (Freigabe-Recht). */
export const canSeeAllEvents = (p: PermissionSet) => canViewAll(p) || canApproveEvents(p);
/** Bereich „Veranstaltungen“ überhaupt: anmelden oder alle sehen. */
export const canUseEvents = (p: PermissionSet) => canReport(p) || canSeeAllEvents(p);

/** Ist die Schulleitungs-Freigabe eingeschaltet? */
export async function approvalRequired(db: Db): Promise<boolean> {
  return (await readModuleSetting(db, EVENT_APPROVAL)) === "1";
}

// ---------------------------------------------------------------- Anzeige (rein)

const dayTime = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const timeOnly = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayOnly = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", timeZone: TZ });

/** Rein: „Fr., 13.11., 18:00–21:00“ bzw. über mehrere Tage „Fr., 13.11., 18:00 – Sa., 14.11., 12:00“. */
export function eventSpan(from: Date, to: Date): string {
  return toBerlinDate(from) === toBerlinDate(to) ? `${dayTime.format(from)}–${timeOnly.format(to)}` : `${dayTime.format(from)} – ${dayTime.format(to)}`;
}

/** Rein: Überschrift eines Tages der Wochenvorschau („Freitag, 13.11.“). */
export const dayHeading = (ymd: string) => dayOnly.format(fromBerlinLocal(`${ymd}T12:00`));

/** Rein: Auf-/Abbau als Zusatz („Aufbau ab 16:00, Abbau bis 22:30“), leer ohne Auf-/Abbau. */
export function setupText(e: { startsAt: Date; endsAt: Date; setupAt: Date; teardownAt: Date }): string {
  const fmt = (a: Date, b: Date) => (toBerlinDate(a) === toBerlinDate(b) ? timeOnly.format(a) : dayTime.format(a));
  return [
    e.setupAt < e.startsAt ? `Aufbau ab ${fmt(e.setupAt, e.startsAt)}` : null,
    e.teardownAt > e.endsAt ? `Abbau bis ${fmt(e.teardownAt, e.endsAt)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Rein: Tage (YYYY-MM-DD, Berliner Zeit), die der Zeitraum berührt. */
export function daysOf(from: Date, to: Date): string[] {
  const out: string[] = [];
  const last = toBerlinDate(new Date(to.getTime() - 1));
  for (let d = toBerlinDate(from); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------- Eingaben

export interface EventInput {
  title: string;
  /** „YYYY-MM-DDTHH:MM“ (Berliner Ortszeit) */
  start: string;
  end: string;
  /** Aufbau ab bzw. Abbau bis – leer = Beginn bzw. Ende */
  setup: string | null;
  teardown: string | null;
  roomIds: readonly string[];
  location: string | null;
  persons: string | number;
  seating: string;
  needs: Partial<Record<EventNeed, boolean>>;
  details: string | null;
  /** VA-06: Wiederholung (nur beim Anmelden) – „keine“/leer = einzelner Termin */
  repeat?: RepeatInput | null;
}

export interface RepeatInput {
  every: string;
  /** letzter möglicher Tag „YYYY-MM-DD“ */
  until: string | null;
  /** höchstens so viele Termine (einschließlich des ersten) */
  count: string | number | null;
}

interface ParsedEvent {
  title: string;
  startsAt: Date;
  endsAt: Date;
  setupAt: Date;
  teardownAt: Date;
  roomIds: string[];
  location: string | null;
  persons: number;
  seating: EventSeating;
  needs: Record<EventNeed, boolean>;
  details: string | null;
}

async function parseEvent(db: Db, input: EventInput, now: Date): Promise<ParsedEvent> {
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  const location = input.location?.trim() || null;
  const details = input.details?.trim() || null;
  const roomIds = [...new Set(input.roomIds.map((r) => r.trim()).filter(Boolean))];
  const persons = typeof input.persons === "number" ? input.persons : Number(String(input.persons).trim() || NaN);
  if (title.length < 3 || title.length > 120) fe.title = "Titel mit 3 bis 120 Zeichen";
  if (location && location.length > 120) fe.location = "höchstens 120 Zeichen";
  if (details && details.length > EVENT_TEXT_MAX) fe.details = `höchstens ${EVENT_TEXT_MAX} Zeichen`;
  if (!Number.isInteger(persons) || persons < 1 || persons > EVENT_MAX_PERSONS) fe.persons = `Personenzahl von 1 bis ${EVENT_MAX_PERSONS}`;
  if (!(EVENT_SEATING as readonly string[]).includes(input.seating)) fe.seating = "Bestuhlung wählen";
  if (!LOCAL.test(input.start)) fe.start = "Beginn angeben";
  if (!LOCAL.test(input.end)) fe.end = "Ende angeben";
  if (input.setup && !LOCAL.test(input.setup)) fe.setup = "Zeitpunkt angeben";
  if (input.teardown && !LOCAL.test(input.teardown)) fe.teardown = "Zeitpunkt angeben";
  let startsAt = now;
  let endsAt = now;
  let setupAt = now;
  let teardownAt = now;
  if (!fe.start && !fe.end && !fe.setup && !fe.teardown) {
    startsAt = fromBerlinLocal(input.start);
    endsAt = fromBerlinLocal(input.end);
    setupAt = input.setup ? fromBerlinLocal(input.setup) : startsAt;
    teardownAt = input.teardown ? fromBerlinLocal(input.teardown) : endsAt;
    if (endsAt <= startsAt) fe.end = "Ende liegt vor dem Beginn";
    else if (setupAt > startsAt) fe.setup = "Aufbau liegt nach dem Beginn";
    else if (teardownAt < endsAt) fe.teardown = "Abbau endet vor der Veranstaltung";
    else if (setupAt <= now) fe[input.setup ? "setup" : "start"] = "Liegt in der Vergangenheit";
    else if (teardownAt.getTime() - setupAt.getTime() > EVENT_MAX_DAYS * 86_400_000) fe.teardown = `Aufbau bis Abbau höchstens ${EVENT_MAX_DAYS} Tage`;
  }
  if (roomIds.length > EVENT_MAX_ROOMS) fe.roomIds = `Höchstens ${EVENT_MAX_ROOMS} Räume`;
  else if (roomIds.length) {
    const found = new Set((await db.select({ id: rooms.id }).from(rooms).where(inArray(rooms.id, roomIds))).map((r) => r.id));
    const missing = roomIds.filter((r) => !found.has(r));
    if (missing.length) fe.roomIds = `Raum ${missing.join(", ")} gibt es nicht`;
  } else if (!location) fe.roomIds = "Räume wählen oder einen Ort angeben";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const needs = Object.fromEntries(EVENT_NEED_KEYS.map((k) => [k, !!input.needs[k]])) as Record<EventNeed, boolean>;
  return { title, startsAt, endsAt, setupAt, teardownAt, roomIds, location, persons, seating: input.seating as EventSeating, needs, details };
}

async function history(db: Db, eventId: string, actorId: string | null, kind: EventHistoryKind, text: string | null = null) {
  await db.insert(gebaeudeEventHistory).values({ eventId, actorId, kind, text });
}

/** Hausmeisterei: Zuständigkeitsgruppe der Kategorie „Gebäude“, sonst alle mit `gebaeude.manage`. */
const caretakers = (db: Db) => responsibleUsers(db, "gebaeude");

// ---------------------------------------------------------------- Serien (VA-06, rein)

/** Rein: Tage zwischen zwei Kalendertagen („YYYY-MM-DD“), b − a. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Rein: Ortszeit „YYYY-MM-DDTHH:MM“ um `days` Kalendertage verschieben (Uhrzeit bleibt, auch über die Zeitumstellung). */
export const shiftLocal = (local: string, days: number) => `${addDays(local.slice(0, 10), days)}${local.slice(10)}`;

export interface SeriesPlan {
  /** alle Termine (Tag des Beginns), der erste ist der gewählte Tag */
  dates: string[];
  /** übersprungene Wiederholungen mit Grund („Herbstferien“, „Feiertag (…)“) */
  skipped: { date: string; reason: string }[];
  every: 1 | 2;
}

/**
 * Rein: Termine einer Serie ab `first` – jede bzw. jede zweite Woche, bis `until` (einschließlich) oder bis `count` Termine erreicht
 * sind (der erste zählt mit), höchstens 26. Wiederholungen in Ferien, an Feiertagen und freien Tagen werden übersprungen und mit Grund
 * gemeldet; der gewählte erste Tag bleibt immer (bewusst gewählt). Höchstens ein Jahr. Fehler als `ValidationError`.
 */
export function seriesPlan(cal: Pick<SchoolCalendar, "dayOff">, first: string, repeat: RepeatInput): SeriesPlan | null {
  if (!repeat.every || repeat.every === "keine") return null;
  const fe: Record<string, string> = {};
  if (!(EVENT_REPEATS as readonly string[]).includes(repeat.every)) fe.repeat = "Wiederholung wählen";
  const every: 1 | 2 = (repeat.every as EventRepeat) === "zweiwoechentlich" ? 2 : 1;
  const until = repeat.until?.trim() || null;
  const rawCount = typeof repeat.count === "number" ? String(repeat.count) : repeat.count?.trim() || "";
  const count = rawCount ? Number(rawCount) : null;
  const limit = addDays(first, 366);
  if (until && (!isCalendarDate(until) || until <= first)) fe.until = "Ein Tag nach dem ersten Termin";
  else if (until && until > limit) fe.until = "Eine Serie läuft höchstens ein Jahr";
  if (count !== null && (!Number.isInteger(count) || count < 2 || count > EVENT_SERIES_MAX)) fe.count = `2 bis ${EVENT_SERIES_MAX} Termine`;
  if (!until && count === null && !fe.repeat) fe.until = "Enddatum oder Anzahl der Termine angeben";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const dates = [first];
  const skipped: SeriesPlan["skipped"] = [];
  const last = until ?? limit;
  for (let d = addDays(first, 7 * every); d <= last; d = addDays(d, 7 * every)) {
    if (count !== null && dates.length >= count) break;
    const off = cal.dayOff(d);
    if (off) {
      skipped.push({ date: d, reason: dayOffLabel(off) });
      continue;
    }
    dates.push(d);
    if (dates.length > EVENT_SERIES_MAX) throw new ValidationError({ until: `Höchstens ${EVENT_SERIES_MAX} Termine – früheres Enddatum oder eine Anzahl wählen` });
  }
  if (dates.length < 2) throw new ValidationError({ until: "Kein weiterer Termin außerhalb von Ferien und freien Tagen" });
  return { dates, skipped, every };
}

/** Rein: Zusammenfassung einer Serie für Verlauf und Rückmeldung („Serie wöchentlich, 10 Termine bis Fr., 18.12.; übersprungen: …“). */
export function seriesSummary(plan: SeriesPlan): string {
  const head = `Serie ${plan.every === 1 ? "wöchentlich" : "alle 2 Wochen"}, ${plan.dates.length} Termine bis ${ymdText(plan.dates.at(-1)!)}`;
  return plan.skipped.length ? `${head}; übersprungen: ${plan.skipped.map((x) => `${ymdText(x.date)} (${x.reason})`).join(", ")}` : head;
}

/** Zeitpunkte einer (schon geprüften) Eingabe, um `days` Tage verschoben. */
function shifted(e: ParsedEvent, input: EventInput, days: number): ParsedEvent {
  if (days === 0) return e;
  const at = (local: string) => fromBerlinLocal(shiftLocal(local, days));
  const startsAt = at(input.start);
  const endsAt = at(input.end);
  return { ...e, startsAt, endsAt, setupAt: input.setup ? at(input.setup) : startsAt, teardownAt: input.teardown ? at(input.teardown) : endsAt };
}

// ---------------------------------------------------------------- Anlegen

/**
 * Veranstaltung anmelden (Recht `gebaeude.report`). Ohne Freigabe geht sie als „angemeldet“ an die Hausmeisterei, mit eingeschalteter
 * Schulleitungs-Freigabe als „wartet auf Freigabe“ an alle mit `gebaeude.event_approve`. Konflikte sind nur ein Hinweis.
 * VA-06: mit Wiederholung entsteht je Termin eine Veranstaltung mit gemeinsamer Serien-ID – ein gebündelter Gong; übersprungene
 * Termine stehen im Verlauf und in der Rückgabe.
 */
export async function createEvent(
  db: Db,
  viewer: PermissionSet,
  input: EventInput,
  now = new Date(),
  cal?: SchoolCalendar,
): Promise<{ id: string; ids: string[]; conflicts: EventConflict[]; skipped: SeriesPlan["skipped"] }> {
  if (!canReport(viewer)) throw new ForbiddenError("gebaeude.report");
  const e = await parseEvent(db, input, now);
  const first = input.start.slice(0, 10);
  const plan = input.repeat ? seriesPlan(cal ?? (await loadSchoolCalendar(db)), first, input.repeat) : null;
  const approval = await approvalRequired(db);
  const status: EventStatus = approval ? "freigabe" : "angemeldet";
  const seriesId = plan ? crypto.randomUUID() : null;
  const summary = plan ? seriesSummary(plan) : null;
  const occurrences = plan ? plan.dates.map((d) => shifted(e, input, dayDiff(first, d))) : [e];
  const ids = await db.transaction(async (tx) => {
    const out: string[] = [];
    for (const o of occurrences) {
      const [row] = await tx
        .insert(gebaeudeEvents)
        .values({
          title: o.title,
          organizerId: viewer.userId,
          status,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          setupAt: o.setupAt,
          teardownAt: o.teardownAt,
          location: o.location,
          persons: o.persons,
          seating: o.seating,
          ...o.needs,
          details: o.details,
          seriesId,
        })
        .returning({ id: gebaeudeEvents.id });
      const id = row!.id;
      if (o.roomIds.length) await tx.insert(gebaeudeEventRooms).values(o.roomIds.map((roomId) => ({ eventId: id, roomId })));
      await history(tx, id, viewer.userId, "angemeldet", summary);
      out.push(id);
    }
    await audit(tx, viewer.userId, "gebaeude.event.create", out[0]!, { rooms: e.roomIds, approval, ...(plan ? { series: out.length, skipped: plan.skipped.length } : {}) });
    return out;
  });
  const id = ids[0]!;
  const span = eventSpan(e.startsAt, e.endsAt);
  const recipients = (approval ? await usersWithPermission(db, EVENT_APPROVE_PERMISSION) : await caretakers(db)).filter((u) => u !== viewer.userId);
  await notify(db, recipients, {
    moduleId: MODULE,
    title: `${plan ? "Veranstaltungsreihe" : "Veranstaltung"} ${approval ? "zur Freigabe" : "angemeldet"}: ${e.title}${plan ? ` (${ids.length} Termine)` : ""}`,
    body: plan ? `ab ${span}` : span,
    href: eventHref(id),
  });
  return { id, ids, conflicts: await eventConflicts(db, { roomIds: e.roomIds, from: e.setupAt, to: e.teardownAt, excludeId: id }), skipped: plan?.skipped ?? [] };
}

// ---------------------------------------------------------------- Konflikte

export type ConflictKind = "unterricht" | "wartung" | "raumsperre" | "buchung" | "veranstaltung";
export interface EventConflict {
  kind: ConflictKind;
  roomId: string;
  text: string;
}

export const CONFLICT_LABELS: Record<ConflictKind, string> = {
  unterricht: "Unterricht",
  wartung: "Wartung",
  raumsperre: "Raumsperre",
  buchung: "Buchung",
  veranstaltung: "Veranstaltung",
};

/** Unterricht in den Räumen im Zeitraum: je Raum und Tag die berührten Stunden (entfallene und verlegte Stunden zählen nicht). */
export async function lessonOverlaps(db: Db, roomIds: readonly string[], from: Date, to: Date): Promise<{ roomId: string; date: string; periods: number[] }[]> {
  const out: { roomId: string; date: string; periods: number[] }[] = [];
  const fromYmd = toBerlinDate(from);
  const toYmd = addDays(toBerlinDate(to), 1);
  for (const roomId of new Set(roomIds)) {
    const byDay = new Map<string, Set<number>>();
    // Entwürfe zählen mit (wie bei Wartungsterminen) – lieber einmal zu viel sperren als Unterricht in die Aula setzen
    for (const s of await listSlots(db, { kind: "room", id: roomId }, fromYmd, toYmd, { drafts: true })) {
      if (s.perspective === "away" || s.change?.kind === "cancel") continue;
      const start = fromBerlinLocal(`${s.date}T${s.startsAt.slice(0, 5)}`);
      const end = fromBerlinLocal(`${s.date}T${s.endsAt.slice(0, 5)}`);
      if (end <= from || start >= to) continue;
      byDay.set(s.date, (byDay.get(s.date) ?? new Set()).add(s.periodNr));
    }
    for (const [date, ps] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) out.push({ roomId, date, periods: [...ps].sort((a, b) => a - b) });
  }
  return out;
}

const periodText = (ps: readonly number[]) => (ps.length === 1 ? `${ps[0]}. Std` : `${ps[0]}.–${ps.at(-1)}. Std`);
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });
const ymdText = (ymd: string) => shortDay.format(fromBerlinLocal(`${ymd}T12:00`));

/**
 * Was liegt im Zeitraum in diesen Räumen? Unterricht (führt bei der Bestätigung zur Raumsperre), Wartungstermine, Raumsperren,
 * Raumbuchungen (nur mit eingeschaltetem Modul Buchungen) und andere nicht abgesagte Veranstaltungen – nur Sachangaben, keine Namen.
 */
export async function eventConflicts(db: Db, q: { roomIds: readonly string[]; from: Date; to: Date; excludeId?: string }): Promise<EventConflict[]> {
  const roomIds = [...new Set(q.roomIds)];
  if (!roomIds.length) return [];
  const out: EventConflict[] = [];
  const fromYmd = toBerlinDate(q.from);
  const toYmd = toBerlinDate(new Date(q.to.getTime() - 1));
  for (const l of await lessonOverlaps(db, roomIds, q.from, q.to)) out.push({ kind: "unterricht", roomId: l.roomId, text: `${ymdText(l.date)}, ${periodText(l.periods)}` });

  const maint = await db
    .select({ roomId: gebaeudeMaintenanceRooms.roomId, title: gebaeudeMaintenance.title, startsAt: gebaeudeMaintenance.startsAt, endsAt: gebaeudeMaintenance.endsAt })
    .from(gebaeudeMaintenanceRooms)
    .innerJoin(gebaeudeMaintenance, eq(gebaeudeMaintenance.id, gebaeudeMaintenanceRooms.maintenanceId))
    .where(and(inArray(gebaeudeMaintenanceRooms.roomId, roomIds), lt(gebaeudeMaintenance.startsAt, q.to), gt(gebaeudeMaintenance.endsAt, q.from)));
  for (const m of maint) out.push({ kind: "wartung", roomId: m.roomId, text: `${m.title} (${eventSpan(m.startsAt, m.endsAt)})` });

  const own = q.excludeId ? (await db.select({ id: gebaeudeEventBlocks.roomBlockId }).from(gebaeudeEventBlocks).where(eq(gebaeudeEventBlocks.eventId, q.excludeId))).map((b) => b.id) : [];
  const blocks = await db
    .select()
    .from(timetableRoomBlocks)
    .where(and(inArray(timetableRoomBlocks.roomId, roomIds), lte(timetableRoomBlocks.startsOn, toYmd), gte(timetableRoomBlocks.endsOn, fromYmd)));
  for (const b of blocks) {
    if (own.includes(b.id)) continue;
    const span = b.startsOn === b.endsOn ? ymdText(b.startsOn) : `${ymdText(b.startsOn)} – ${ymdText(b.endsOn)}`;
    const ps = b.fromPeriod !== null && b.toPeriod !== null ? `, ${periodText(b.fromPeriod === b.toPeriod ? [b.fromPeriod] : [b.fromPeriod, b.toPeriod])}` : "";
    out.push({ kind: "raumsperre", roomId: b.roomId, text: `${blockLabel(b).replace(/^Gesperrt: /, "")} (${span}${ps})` });
  }

  const states = await loadModuleStates(db);
  const buchungen = getModule("buchungen");
  if (buchungen && isEnabled(buchungen, states)) {
    const rows = await db
      .select({ roomId: bookingResources.roomId, date: bookings.date, periodNr: bookings.periodNr, startsAt: periods.startsAt, endsAt: periods.endsAt })
      .from(bookings)
      .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
      .innerJoin(periods, eq(periods.nr, bookings.periodNr))
      .where(and(inArray(bookingResources.roomId, roomIds), gte(bookings.date, fromYmd), lte(bookings.date, toYmd)));
    for (const b of rows) {
      const start = fromBerlinLocal(`${b.date}T${b.startsAt.slice(0, 5)}`);
      const end = fromBerlinLocal(`${b.date}T${b.endsAt.slice(0, 5)}`);
      if (end <= q.from || start >= q.to) continue;
      out.push({ kind: "buchung", roomId: b.roomId!, text: `${ymdText(b.date)}, ${b.periodNr}. Std gebucht` });
    }
  }

  const others = await db
    .select({ roomId: gebaeudeEventRooms.roomId, title: gebaeudeEvents.title, startsAt: gebaeudeEvents.startsAt, endsAt: gebaeudeEvents.endsAt })
    .from(gebaeudeEventRooms)
    .innerJoin(gebaeudeEvents, eq(gebaeudeEvents.id, gebaeudeEventRooms.eventId))
    .where(
      and(
        inArray(gebaeudeEventRooms.roomId, roomIds),
        inArray(gebaeudeEvents.status, [...EVENT_ACTIVE_STATUSES]),
        lt(gebaeudeEvents.setupAt, q.to),
        gt(gebaeudeEvents.teardownAt, q.from),
        q.excludeId ? ne(gebaeudeEvents.id, q.excludeId) : undefined,
      ),
    );
  for (const o of others) out.push({ kind: "veranstaltung", roomId: o.roomId, text: `${o.title} (${eventSpan(o.startsAt, o.endsAt)})` });

  return out.sort((a, b) => a.roomId.localeCompare(b.roomId, "de", { numeric: true }) || CONFLICT_ORDER[a.kind] - CONFLICT_ORDER[b.kind]);
}

const CONFLICT_ORDER: Record<ConflictKind, number> = { unterricht: 0, raumsperre: 1, wartung: 2, buchung: 3, veranstaltung: 4 };

// ---------------------------------------------------------------- Entscheiden

async function loadEvent(db: Db, id: string) {
  const [e] = await db.select().from(gebaeudeEvents).where(eq(gebaeudeEvents.id, id));
  if (!e) throw new ValidationError({ event: "Veranstaltung gibt es nicht" });
  return e;
}

async function roomsOf(db: Db, eventId: string): Promise<string[]> {
  const rs = await db.select({ roomId: gebaeudeEventRooms.roomId }).from(gebaeudeEventRooms).where(eq(gebaeudeEventRooms.eventId, eventId));
  return rs.map((r) => r.roomId).sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
}

/** Status nur wechseln, wenn er noch einer der erwarteten ist (zwei gleichzeitige Entscheidungen → eine gewinnt). */
async function transition(db: Db, id: string, from: readonly EventStatus[], to: EventStatus): Promise<boolean> {
  const rows = await db
    .update(gebaeudeEvents)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(gebaeudeEvents.id, id), inArray(gebaeudeEvents.status, [...from])))
    .returning({ id: gebaeudeEvents.id });
  return rows.length > 0;
}

function requireText(text: string | null | undefined, field = "text"): string {
  const t = text?.trim() ?? "";
  if (t.length < 3 || t.length > EVENT_TEXT_MAX) throw new ValidationError({ [field]: `Text mit 3 bis ${EVENT_TEXT_MAX} Zeichen` });
  return t;
}

const stale = () => new ValidationError({ status: "Die Veranstaltung hat inzwischen einen anderen Stand – Seite neu laden" });

/** VA-06: Termine einer Serie (nach Beginn sortiert). */
async function seriesEvents(db: Db, seriesId: string): Promise<GebaeudeEvent[]> {
  return db.select().from(gebaeudeEvents).where(eq(gebaeudeEvents.seriesId, seriesId)).orderBy(asc(gebaeudeEvents.startsAt));
}

/**
 * VA-06: Termine, für die ein Schritt gilt – ohne Serie bzw. „nur dieser“ der Termin selbst; „folgende“ dieser und alle späteren der
 * Serie im passenden Stand; „serie“ alle Termine der Serie im passenden Stand. Vergangene (Abbau vorbei) nie.
 */
async function targetsOf(db: Db, e: GebaeudeEvent, scope: EventScope | "serie", statuses: readonly EventStatus[], now: Date): Promise<GebaeudeEvent[]> {
  if (!e.seriesId || scope === "einzeln") return [e];
  const all = await seriesEvents(db, e.seriesId);
  return all.filter((o) => (o.id === e.id || statuses.includes(o.status)) && o.teardownAt > now && (scope === "serie" || o.startsAt >= e.startsAt));
}

const countText = (n: number) => (n === 1 ? "1 Termin" : `${n} Termine`);

/**
 * Schulleitung gibt frei (Recht `gebaeude.event_approve`, Stand „wartet auf Freigabe“) → an die Hausmeisterei. VA-06: mit
 * `scope: "serie"` alle wartenden Termine der Serie in einem Schritt (ein Gong).
 */
export async function approveEvent(db: Db, viewer: PermissionSet, id: string, scope: "einzeln" | "serie" = "einzeln", now = new Date()): Promise<number> {
  if (!canApproveEvents(viewer)) throw new ForbiddenError(EVENT_APPROVE_PERMISSION);
  const e = await loadEvent(db, id);
  const done: GebaeudeEvent[] = [];
  for (const t of await targetsOf(db, e, scope, ["freigabe"], now)) {
    if (!(await transition(db, t.id, ["freigabe"], "angemeldet"))) {
      if (t.id === id && scope === "einzeln") throw stale();
      continue;
    }
    await history(db, t.id, viewer.userId, "freigegeben");
    await audit(db, viewer.userId, "gebaeude.event.approve", t.id);
    done.push(t);
  }
  if (!done.length) throw stale();
  const series = done.length > 1;
  const first = done[0]!;
  const span = eventSpan(first.startsAt, first.endsAt);
  await notify(db, (await caretakers(db)).filter((u) => u !== viewer.userId), {
    moduleId: MODULE,
    title: series ? `Veranstaltungsreihe angemeldet: ${e.title} (${done.length} Termine)` : `Veranstaltung angemeldet: ${e.title}`,
    body: series ? `ab ${span}` : span,
    href: eventHref(first.id),
  });
  if (e.organizerId && e.organizerId !== viewer.userId)
    await notify(db, [e.organizerId], {
      moduleId: MODULE,
      title: `${series ? "Veranstaltungsreihe" : "Veranstaltung"} freigegeben: ${e.title}`,
      body: series ? `${countText(done.length)} liegen jetzt bei der Hausmeisterei.` : "Liegt jetzt bei der Hausmeisterei.",
      href: eventHref(first.id),
    });
  return done.length;
}

/** Rückfrage der Hausmeisterei (Stand „angemeldet“, auch eine weitere bei „Rückfrage“) – Gong an die anmeldende Person, die mit einer Antwort zurückgibt. */
export async function askEvent(db: Db, viewer: PermissionSet, id: string, text: string): Promise<void> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = requireText(text);
  const e = await loadEvent(db, id);
  if (!(await transition(db, id, ["angemeldet", "rueckfrage"], "rueckfrage"))) throw stale();
  await history(db, id, viewer.userId, "rueckfrage", t);
  await audit(db, viewer.userId, "gebaeude.event.ask", id);
  if (e.organizerId && e.organizerId !== viewer.userId) await notify(db, [e.organizerId], { moduleId: MODULE, title: `Rückfrage zur Veranstaltung: ${e.title}`, body: t.slice(0, 200), href: eventHref(id) });
}

/** Antwort der anmeldenden Person auf eine Rückfrage → wieder „angemeldet“ bei der Hausmeisterei. */
export async function answerEvent(db: Db, viewer: PermissionSet, id: string, text: string): Promise<void> {
  const e = await loadEvent(db, id);
  if (e.organizerId !== viewer.userId || !canReport(viewer)) throw new ForbiddenError("gebaeude.report");
  const t = requireText(text);
  if (!(await transition(db, id, ["rueckfrage"], "angemeldet"))) throw stale();
  await history(db, id, viewer.userId, "antwort", t);
  await audit(db, viewer.userId, "gebaeude.event.answer", id);
  await notify(db, (await caretakers(db)).filter((u) => u !== viewer.userId), { moduleId: MODULE, title: `Antwort zur Veranstaltung: ${e.title}`, body: t.slice(0, 200), href: eventHref(id) });
}

/** Ablehnen mit Begründung: Hausmeisterei (angemeldet/Rückfrage) bzw. Schulleitung (wartet auf Freigabe). */
export async function rejectEvent(db: Db, viewer: PermissionSet, id: string, text: string): Promise<void> {
  const e = await loadEvent(db, id);
  const from: EventStatus[] = [];
  if (canManage(viewer)) from.push("angemeldet", "rueckfrage");
  if (canApproveEvents(viewer)) from.push("freigabe");
  if (!from.length) throw new ForbiddenError("gebaeude.manage");
  const t = requireText(text);
  if (!(await transition(db, id, from, "abgelehnt"))) throw stale();
  await history(db, id, viewer.userId, "abgelehnt", t);
  await audit(db, viewer.userId, "gebaeude.event.reject", id, { from: e.status });
  if (e.organizerId && e.organizerId !== viewer.userId) await notify(db, [e.organizerId], { moduleId: MODULE, title: `Veranstaltung abgelehnt: ${e.title}`, body: t.slice(0, 200), href: eventHref(id) });
}

export interface ConfirmOptions {
  /** Räume sperren, wo Unterricht betroffen ist (je Raum und Tag die berührten Stunden) */
  blockRooms: boolean;
  /** Eintrag im Schulkalender (nur, wenn das Kalender-Modul an ist – entscheidet der Aufrufer) */
  calendar: boolean;
  note?: string | null;
  /** VA-06: „serie“ = alle offenen Termine der Serie in einem Schritt (Termine mit Konflikt bleiben offen) */
  scope?: "einzeln" | "serie";
}

export interface ConfirmResult {
  blocks: number;
  notified: number;
  /** bestätigte Termine */
  confirmed: number;
  /** VA-06: Termine der Serie, die wegen eines Konflikts offen bleiben („Fr., 13.11.“) */
  open: string[];
}

type LessonOverlap = Awaited<ReturnType<typeof lessonOverlaps>>[number];
interface Confirmed {
  e: GebaeudeEvent;
  overlaps: LessonOverlap[];
}

/** Rein: Ort für den Schulkalender („Raum Aula, 106 · Schulhof“), leer = null. */
const calendarPlace = (roomIds: readonly string[], location: string | null) => [roomIds.length ? `Raum ${roomIds.join(", ")}` : null, location].filter(Boolean).join(" · ") || null;

/** Einen Termin bestätigen: Stand per bedingtem UPDATE, Raumsperren bei Unterricht, optional Kalender, Verlauf, Audit (ohne Gong). */
async function confirmOne(db: Db, viewer: PermissionSet, e: GebaeudeEvent, opts: ConfirmOptions, note: string | null): Promise<Confirmed | null> {
  if (!(await transition(db, e.id, ["angemeldet", "rueckfrage"], "bestaetigt"))) return null;
  const roomIds = await roomsOf(db, e.id);
  const overlaps = opts.blockRooms && roomIds.length ? await lessonOverlaps(db, roomIds, e.setupAt, e.teardownAt) : [];
  for (const o of overlaps) {
    const blockId = await createRoomBlock(db, viewer.userId, {
      roomId: o.roomId,
      startsOn: o.date,
      endsOn: o.date,
      fromPeriod: o.periods[0]!,
      toPeriod: o.periods.at(-1)!,
      reason: "veranstaltung",
      note: e.title.slice(0, 80),
    });
    await db.insert(gebaeudeEventBlocks).values({ eventId: e.id, roomBlockId: blockId });
  }
  if (opts.calendar) {
    const [c] = await db
      .insert(calendarEvents)
      .values({ title: e.title.slice(0, 200), description: null, location: calendarPlace(roomIds, e.location), startsAt: e.startsAt, endsAt: e.endsAt, allDay: false, scope: "school", ownerId: viewer.userId })
      .returning({ id: calendarEvents.id });
    await db.update(gebaeudeEvents).set({ calendarEventId: c!.id }).where(eq(gebaeudeEvents.id, e.id));
  }
  await history(db, e.id, viewer.userId, "bestaetigt", note);
  await audit(db, viewer.userId, "gebaeude.event.confirm", e.id, { blocks: overlaps.length, calendar: opts.calendar });
  return { e, overlaps };
}

/**
 * Gongs nach einer Bestätigung – gebündelt auch für eine ganze Serie: Stundenplanung (VA-04, Link auf den ersten betroffenen Tag),
 * betroffene Lehrkräfte (je Person einer) und die anmeldende Person. Rückgabe: Zahl der Gongs an Planung und Lehrkräfte.
 */
async function confirmNotices(db: Db, viewer: PermissionSet, e: GebaeudeEvent, done: Confirmed[], note: string | null, series: { open: number } | null): Promise<number> {
  let notified = 0;
  const overlaps = done.flatMap((d) => d.overlaps);
  if (overlaps.length) {
    // VA-04: ein gebündelter Gong an die Stundenplanung (Recht `stundenplan.substitute`) mit Link auf den ersten betroffenen Tag
    const planners = (await usersWithPermission(db, "stundenplan.substitute")).filter((u) => u !== viewer.userId);
    const first = [...overlaps].sort((a, b) => a.date.localeCompare(b.date))[0]!;
    const lines = overlaps.map((o) => `${dayHeading(o.date)}: Raum ${o.roomId}, ${periodsText(o.periods[0]!, o.periods.at(-1)!)}`);
    notified += await notify(db, planners, {
      moduleId: MODULE,
      title: `Veranstaltung ${e.title}: ${overlaps.length === 1 ? "1 Raumsperre" : `${overlaps.length} Raumsperren`}`,
      body: `${lines.slice(0, 4).join("; ")}${lines.length > 4 ? `; … (${lines.length - 4} weitere)` : ""} – Vertretungen prüfen`,
      href: `/planung/vertretungen?datum=${first.date}`,
    });
    const withBlocks = done.filter((d) => d.overlaps.length);
    const teachers = new Set<string>();
    for (const d of withBlocks) for (const u of await teachersInRooms(db, [...new Set(d.overlaps.map((o) => o.roomId))], d.e.setupAt, d.e.teardownAt)) teachers.add(u);
    const blocked = [...new Set(overlaps.map((o) => o.roomId))];
    const d0 = withBlocks[0]!.e;
    notified += await notify(
      db,
      [...teachers].filter((u) => u !== viewer.userId && !planners.includes(u)),
      {
        moduleId: MODULE,
        title: `Raum ${blocked.join(", ")} gesperrt: Veranstaltung ${e.title}`,
        body: `${withBlocks.length > 1 ? `${countText(withBlocks.length)} ab ` : ""}${eventSpan(d0.setupAt, d0.teardownAt)} – bitte Vertretungsplan beachten`,
        href: "/stundenplan",
      },
    );
  }
  if (e.organizerId && e.organizerId !== viewer.userId) {
    const body = series
      ? `${countText(done.length)} bestätigt${series.open ? `, ${countText(series.open)} mit Konflikt noch offen` : ""}${note ? ` – ${note.slice(0, 200)}` : ""}`
      : (note?.slice(0, 200) ?? eventSpan(e.startsAt, e.endsAt));
    await notify(db, [e.organizerId], { moduleId: MODULE, title: `${series ? "Veranstaltungsreihe" : "Veranstaltung"} bestätigt: ${e.title}`, body, href: eventHref(done[0]!.e.id) });
  }
  return notified;
}

/**
 * Bestätigen (Recht `gebaeude.manage`, Stand „angemeldet“ oder „Rückfrage“). Raumsperre nur bei Überschneidung mit Unterricht –
 * je Raum und Tag eine Sperre über die berührten Stunden (Grund „Veranstaltung“), Gong an die betroffenen Lehrkräfte; alles andere
 * bleibt Konflikthinweis. Optional Schulkalender-Eintrag „im Namen des Moduls“ (ohne `kalender.school`, mit Audit).
 * VA-06: `scope: "serie"` bestätigt alle offenen Termine der Serie in einem Schritt; Termine mit Konflikt (Wartung, Raumsperre,
 * Buchung, andere Veranstaltung – Unterricht nur, wenn nicht gesperrt wird) bleiben einzeln offen und werden zurückgemeldet.
 */
export async function confirmEvent(db: Db, viewer: PermissionSet, id: string, opts: ConfirmOptions, now = new Date()): Promise<ConfirmResult> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const note = opts.note?.trim() || null;
  if (note && note.length > EVENT_TEXT_MAX) throw new ValidationError({ note: `höchstens ${EVENT_TEXT_MAX} Zeichen` });
  const e = await loadEvent(db, id);
  if (opts.scope !== "serie" || !e.seriesId) {
    const c = await confirmOne(db, viewer, e, opts, note);
    if (!c) throw stale();
    const notified = await confirmNotices(db, viewer, e, [c], note, null);
    return { blocks: c.overlaps.length, notified, confirmed: 1, open: [] };
  }
  const done: Confirmed[] = [];
  const open: string[] = [];
  for (const t of await targetsOf(db, e, "serie", ["angemeldet", "rueckfrage"], now)) {
    if (t.status !== "angemeldet" && t.status !== "rueckfrage") continue;
    const conflicts = (await eventConflicts(db, { roomIds: await roomsOf(db, t.id), from: t.setupAt, to: t.teardownAt, excludeId: t.id })).filter((c) => c.kind !== "unterricht" || !opts.blockRooms);
    if (conflicts.length) {
      open.push(ymdText(toBerlinDate(t.startsAt)));
      continue;
    }
    const c = await confirmOne(db, viewer, t, opts, note);
    if (c) done.push(c);
  }
  if (!done.length && !open.length) throw stale();
  const notified = done.length ? await confirmNotices(db, viewer, e, done, note, { open: open.length }) : 0;
  return { blocks: done.reduce((n, d) => n + d.overlaps.length, 0), notified, confirmed: done.length, open };
}

/** Raumsperren und Kalendereintrag einer Veranstaltung entfernen (Absage, wesentliche Änderung). */
async function releaseEvent(db: Db, actorId: string, e: { id: string; calendarEventId: string | null }) {
  const linked = await db.select({ blockId: gebaeudeEventBlocks.roomBlockId }).from(gebaeudeEventBlocks).where(eq(gebaeudeEventBlocks.eventId, e.id));
  for (const l of linked) await deleteRoomBlock(db, actorId, l.blockId);
  if (e.calendarEventId) {
    await db.delete(calendarEvents).where(eq(calendarEvents.id, e.calendarEventId));
    await db.update(gebaeudeEvents).set({ calendarEventId: null }).where(eq(gebaeudeEvents.id, e.id));
  }
}

/**
 * Absagen: die anmeldende Person (eigene) oder die Hausmeisterei, solange die Veranstaltung nicht vorbei ist. Raumsperren und
 * Kalendereintrag fallen weg; die Gegenseite bekommt einen Gong. VA-06: `scope: "folgende"` sagt diesen und alle späteren Termine der
 * Serie ab (ein Gong). Rückgabe: Zahl der abgesagten Termine.
 */
export async function cancelEvent(db: Db, viewer: PermissionSet, id: string, text: string | null, now = new Date(), scope: EventScope = "einzeln"): Promise<number> {
  const e = await loadEvent(db, id);
  const own = e.organizerId === viewer.userId && canReport(viewer);
  if (!own && !canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = text?.trim() || null;
  if (t && t.length > EVENT_TEXT_MAX) throw new ValidationError({ text: `höchstens ${EVENT_TEXT_MAX} Zeichen` });
  if (e.teardownAt <= now) throw new ValidationError({ status: "Die Veranstaltung ist schon vorbei" });
  const done: GebaeudeEvent[] = [];
  for (const x of await targetsOf(db, e, scope, EVENT_ACTIVE_STATUSES, now)) {
    if (!(await transition(db, x.id, EVENT_ACTIVE_STATUSES, "abgesagt"))) {
      if (x.id === id) throw stale();
      continue;
    }
    await releaseEvent(db, viewer.userId, x);
    await history(db, x.id, viewer.userId, "abgesagt", t);
    await audit(db, viewer.userId, "gebaeude.event.cancel", x.id, { from: x.status, ...(scope === "folgende" ? { scope } : {}) });
    done.push(x);
  }
  const series = done.length > 1;
  const msg = {
    moduleId: MODULE,
    title: `Veranstaltung abgesagt: ${e.title}${series ? ` (${done.length} Termine ab ${ymdText(toBerlinDate(e.startsAt))})` : ""}`,
    body: t?.slice(0, 200) ?? eventSpan(e.startsAt, e.endsAt),
    href: eventHref(id),
  };
  if (own) {
    if (done.some((x) => x.status !== "freigabe")) await notify(db, (await caretakers(db)).filter((u) => u !== viewer.userId), msg);
  } else if (e.organizerId && e.organizerId !== viewer.userId) await notify(db, [e.organizerId], msg);
  return done.length;
}

// ---------------------------------------------------------------- Bearbeiten (VA-05)

export interface EventChanges {
  /** geänderte Angaben als Beschriftung („Zeit“, „Räume“, „Personenzahl“ …) */
  fields: string[];
  time: boolean;
  roomsAdded: boolean;
  roomsRemoved: boolean;
}

/** Rein: Was ändert sich gegenüber dem gespeicherten Stand? Zeit = Aufbau, Beginn, Ende oder Abbau. */
export function eventChanges(
  old: Pick<GebaeudeEvent, "title" | "startsAt" | "endsAt" | "setupAt" | "teardownAt" | "location" | "persons" | "seating" | "details" | EventNeed>,
  oldRooms: readonly string[],
  next: Pick<ParsedEvent, "title" | "startsAt" | "endsAt" | "setupAt" | "teardownAt" | "location" | "persons" | "seating" | "details" | "needs" | "roomIds">,
): EventChanges {
  const time = (["startsAt", "endsAt", "setupAt", "teardownAt"] as const).some((k) => old[k].getTime() !== next[k].getTime());
  const before = new Set(oldRooms);
  const after = new Set(next.roomIds);
  const roomsAdded = [...after].some((r) => !before.has(r));
  const roomsRemoved = [...before].some((r) => !after.has(r));
  const fields = [
    time && "Zeit",
    (roomsAdded || roomsRemoved) && "Räume",
    old.title !== next.title && "Titel",
    (old.location ?? null) !== next.location && "Ort",
    old.persons !== next.persons && "Personenzahl",
    old.seating !== next.seating && "Bestuhlung",
    EVENT_NEED_KEYS.some((k) => old[k] !== next.needs[k]) && "Bedarf",
    (old.details ?? null) !== next.details && "Einzelheiten",
  ].filter((f): f is string => typeof f === "string");
  return { fields, time, roomsAdded, roomsRemoved };
}

/**
 * Rein: Stand nach einer Änderung (Projektleitung 2026-11-03). Wesentlich sind Zeit und Räume → zurück auf „angemeldet“ (die
 * Hausmeisterei bestätigt neu); mit eingeschalteter Freigabe geht es nur bei geändertem Zeitraum oder zusätzlichen Räumen erneut an die
 * Schulleitung (weniger Räume nicht). Unwesentliche Änderungen behalten den Stand. „Wartet auf Freigabe“ bleibt.
 */
export function statusAfterEdit(status: EventStatus, c: Pick<EventChanges, "time" | "roomsAdded" | "roomsRemoved">, approval: boolean): EventStatus {
  if (status === "freigabe") return "freigabe";
  if (!(c.time || c.roomsAdded || c.roomsRemoved)) return status;
  return approval && (c.time || c.roomsAdded) ? "freigabe" : "angemeldet";
}

export interface UpdateResult {
  /** geänderte Termine */
  changed: number;
  /** davon zurück zur Bestätigung bei der Hausmeisterei bzw. erneut zur Freigabe */
  reconfirm: number;
  reapprove: number;
}

/**
 * Bearbeiten durch die anmeldende Person (VA-05) – nur offene oder bestätigte Veranstaltungen vor dem Aufbau. Wesentliche Änderung
 * (Zeit/Raum) einer bestätigten Veranstaltung hebt Raumsperren und Kalendereintrag auf (`releaseEvent`); unwesentliche behalten die
 * Bestätigung und ziehen Titel/Ort im Kalendereintrag und die Sperr-Notiz nach. VA-06: `scope: "folgende"` überträgt die Änderung auf
 * alle späteren Termine der Serie (Datum um denselben Abstand verschoben). Gong gebündelt an Hausmeisterei bzw. Schulleitung.
 */
export async function updateEvent(db: Db, viewer: PermissionSet, id: string, input: EventInput, scope: EventScope = "einzeln", now = new Date()): Promise<UpdateResult> {
  const e = await loadEvent(db, id);
  if (e.organizerId !== viewer.userId || !canReport(viewer)) throw new ForbiddenError("gebaeude.report");
  if (!EVENT_ACTIVE_STATUSES.includes(e.status) || e.setupAt <= now) throw new ValidationError({ status: "Ändern geht nur bei offenen oder bestätigten Veranstaltungen vor dem Aufbau" });
  const parsed = await parseEvent(db, { ...input, repeat: null }, now);
  const approval = await approvalRequired(db);
  const base = toBerlinDate(e.startsAt);
  const targets = (await targetsOf(db, e, scope, EVENT_ACTIVE_STATUSES, now)).filter((t) => t.id === id || t.setupAt > now);
  const result: UpdateResult = { changed: 0, reconfirm: 0, reapprove: 0 };
  const fieldsAll = new Set<string>();
  let essentialAny = false;
  const done: { t: GebaeudeEvent; to: EventStatus }[] = [];
  for (const t of targets) {
    const next = shifted(parsed, input, dayDiff(base, toBerlinDate(t.startsAt)));
    const oldRooms = await roomsOf(db, t.id);
    const c = eventChanges(t, oldRooms, next);
    if (!c.fields.length) continue;
    const to = statusAfterEdit(t.status, c, approval);
    const rows = await db
      .update(gebaeudeEvents)
      .set({
        title: next.title,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        setupAt: next.setupAt,
        teardownAt: next.teardownAt,
        location: next.location,
        persons: next.persons,
        seating: next.seating,
        ...next.needs,
        details: next.details,
        status: to,
        updatedAt: now,
        // neuer Tag → der Gong am Vortag kommt neu
        ...(c.time ? { remindedAt: null } : {}),
      })
      .where(and(eq(gebaeudeEvents.id, t.id), eq(gebaeudeEvents.status, t.status)))
      .returning({ id: gebaeudeEvents.id });
    if (!rows.length) {
      if (t.id === id) throw stale();
      continue;
    }
    if (c.roomsAdded || c.roomsRemoved) {
      await db.delete(gebaeudeEventRooms).where(eq(gebaeudeEventRooms.eventId, t.id));
      if (next.roomIds.length) await db.insert(gebaeudeEventRooms).values(next.roomIds.map((roomId) => ({ eventId: t.id, roomId })));
    }
    if (t.status === "bestaetigt" && to !== "bestaetigt") await releaseEvent(db, viewer.userId, t);
    else if (t.status === "bestaetigt") {
      // unwesentlich geändert: Kalendereintrag und Notiz der Raumsperren nachziehen
      if (t.calendarEventId && (c.fields.includes("Titel") || c.fields.includes("Ort")))
        await db.update(calendarEvents).set({ title: next.title.slice(0, 200), location: calendarPlace(oldRooms, next.location) }).where(eq(calendarEvents.id, t.calendarEventId));
      if (c.fields.includes("Titel")) {
        const linked = (await db.select({ id: gebaeudeEventBlocks.roomBlockId }).from(gebaeudeEventBlocks).where(eq(gebaeudeEventBlocks.eventId, t.id))).map((b) => b.id);
        if (linked.length) await db.update(timetableRoomBlocks).set({ note: next.title.slice(0, 80) }).where(inArray(timetableRoomBlocks.id, linked));
      }
    }
    const effect = to === t.status ? (t.status === "bestaetigt" ? " – Bestätigung bleibt" : "") : to === "freigabe" ? " – erneut zur Freigabe" : " – neu zu bestätigen";
    await history(db, t.id, viewer.userId, "geaendert", `${c.fields.join(", ")} geändert${effect}`);
    await audit(db, viewer.userId, "gebaeude.event.update", t.id, { fields: c.fields, from: t.status, to, ...(scope === "folgende" ? { scope } : {}) });
    result.changed++;
    if (to !== t.status && to === "freigabe") result.reapprove++;
    else if (to !== t.status) result.reconfirm++;
    for (const f of c.fields) fieldsAll.add(f);
    if (c.time || c.roomsAdded || c.roomsRemoved) essentialAny = true;
    done.push({ t, to });
  }
  if (!result.changed) throw new ValidationError({ status: "Nichts geändert" });

  const n = done.length;
  const suffix = n > 1 ? ` (${n} Termine)` : "";
  const fields = [...fieldsAll].join(", ");
  const href = eventHref(done[0]!.t.id);
  const toApprove = done.filter((d) => d.to === "freigabe" && d.t.status !== "freigabe");
  if (toApprove.length)
    await notify(db, (await usersWithPermission(db, EVENT_APPROVE_PERMISSION)).filter((u) => u !== viewer.userId), {
      moduleId: MODULE,
      title: `Veranstaltung geändert, erneut zur Freigabe: ${parsed.title}${suffix}`,
      body: `${fields} geändert`,
      href,
    });
  if (done.some((d) => d.to !== "freigabe" || d.t.status !== "freigabe"))
    await notify(db, (await caretakers(db)).filter((u) => u !== viewer.userId), {
      moduleId: MODULE,
      title: `Veranstaltung geändert: ${parsed.title}${suffix}`,
      body: `${fields} geändert${toApprove.length ? " – erneut zur Freigabe an die Schulleitung" : essentialAny ? " – bitte neu bestätigen" : ""}`,
      href,
    });
  return result;
}

// ---------------------------------------------------------------- Lesen

const eventColumns = {
  id: gebaeudeEvents.id,
  title: gebaeudeEvents.title,
  status: gebaeudeEvents.status,
  organizerId: gebaeudeEvents.organizerId,
  organizerName: users.name,
  startsAt: gebaeudeEvents.startsAt,
  endsAt: gebaeudeEvents.endsAt,
  setupAt: gebaeudeEvents.setupAt,
  teardownAt: gebaeudeEvents.teardownAt,
  location: gebaeudeEvents.location,
  persons: gebaeudeEvents.persons,
  seating: gebaeudeEvents.seating,
  needsTech: gebaeudeEvents.needsTech,
  needsLocking: gebaeudeEvents.needsLocking,
  needsHeating: gebaeudeEvents.needsHeating,
  needsCleaning: gebaeudeEvents.needsCleaning,
  details: gebaeudeEvents.details,
  calendarEventId: gebaeudeEvents.calendarEventId,
  seriesId: gebaeudeEvents.seriesId,
  createdAt: gebaeudeEvents.createdAt,
};

async function withRooms<T extends { id: string; startsAt: Date; endsAt: Date }>(db: Db, rows: T[]) {
  if (!rows.length) return [];
  const links = await db
    .select({ eventId: gebaeudeEventRooms.eventId, roomId: gebaeudeEventRooms.roomId })
    .from(gebaeudeEventRooms)
    .where(inArray(gebaeudeEventRooms.eventId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    ...r,
    rooms: links
      .filter((l) => l.eventId === r.id)
      .map((l) => l.roomId)
      .sort((a, b) => a.localeCompare(b, "de", { numeric: true })),
    span: eventSpan(r.startsAt, r.endsAt),
  }));
}

async function selectEvents(db: Db, where: SQL | undefined, order: SQL[] = [asc(gebaeudeEvents.setupAt), asc(gebaeudeEvents.title)]) {
  const rows = await db
    .select(eventColumns)
    .from(gebaeudeEvents)
    .leftJoin(users, eq(users.id, gebaeudeEvents.organizerId))
    .where(where)
    .orderBy(...order);
  return withRooms(db, rows);
}

export type EventRow = Awaited<ReturnType<typeof selectEvents>>[number];
/** Zeile einer Liste – bei Serien steht nur der früheste Termin, `seriesMore` zählt die weiteren (VA-06). */
export type EventListRow = EventRow & { seriesMore: number };

/** Rein: Termine einer Serie in einer Liste zusammenfassen (der erste in der Reihenfolge bleibt, die übrigen zählen mit). */
export function collapseSeries<T extends { seriesId: string | null }>(rows: readonly T[]): (T & { seriesMore: number })[] {
  const out: (T & { seriesMore: number })[] = [];
  const seen = new Map<string, T & { seriesMore: number }>();
  for (const r of rows) {
    const known = r.seriesId ? seen.get(r.seriesId) : undefined;
    if (known) {
      known.seriesMore++;
      continue;
    }
    const row = { ...r, seriesMore: 0 };
    if (r.seriesId) seen.set(r.seriesId, row);
    out.push(row);
  }
  return out;
}

/** Rein: Ort einer Veranstaltung („Raum Aula, 106 · Schulhof“). */
export const eventPlace = (e: { rooms: readonly string[]; location: string | null }) =>
  [e.rooms.length ? `Raum ${e.rooms.join(", ")}` : null, e.location].filter(Boolean).join(" · ") || "ohne Ort";

/** Eigene Anmeldungen (alle mit `gebaeude.report`): laufende und künftige, dazu vergangene der letzten 30 Tage. */
export async function myEvents(db: Db, viewer: PermissionSet, now = new Date()): Promise<EventRow[]> {
  if (!canReport(viewer)) throw new ForbiddenError("gebaeude.report");
  return selectEvents(db, and(eq(gebaeudeEvents.organizerId, viewer.userId), gte(gebaeudeEvents.teardownAt, new Date(now.getTime() - 30 * 86_400_000))), [asc(gebaeudeEvents.startsAt)]);
}

export interface EventOverview {
  /** wartet auf die Schulleitung (nur mit Freigabe-Recht) */
  approval: EventListRow[];
  /** liegt bei der Hausmeisterei bzw. wartet auf eine Antwort */
  open: EventListRow[];
  /** Wochenvorschau: heute und die nächsten 6 Tage, je Tag die berührenden (nicht abgelehnten/abgesagten) Veranstaltungen */
  week: { date: string; events: EventRow[] }[];
  /** später als die Wochenvorschau, bestätigt */
  later: EventListRow[];
  /** abgelehnt/abgesagt bzw. vorbei in den letzten 30 Tagen */
  past: EventRow[];
}

/** Übersicht für Hausmeisterei, Verwaltung und Schulleitung. */
export async function eventOverview(db: Db, viewer: PermissionSet, now = new Date()): Promise<EventOverview> {
  if (!canSeeAllEvents(viewer)) throw new ForbiddenError("gebaeude.view_all");
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await selectEvents(db, gte(gebaeudeEvents.teardownAt, since));
  const today = toBerlinDate(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const weekEnd = fromBerlinLocal(`${addDays(today, 7)}T00:00`);
  const running = rows.filter((r) => EVENT_ACTIVE_STATUSES.includes(r.status) && r.teardownAt > now);
  const week = days.map((date) => {
    const from = fromBerlinLocal(`${date}T00:00`);
    const to = fromBerlinLocal(`${addDays(date, 1)}T00:00`);
    return { date, events: running.filter((r) => r.setupAt < to && r.teardownAt > from) };
  });
  return {
    approval: canApproveEvents(viewer) ? collapseSeries(running.filter((r) => r.status === "freigabe")) : [],
    open: collapseSeries(running.filter((r) => r.status === "angemeldet" || r.status === "rueckfrage")),
    week,
    later: collapseSeries(running.filter((r) => r.status === "bestaetigt" && r.setupAt >= weekEnd)),
    past: rows.filter((r) => !running.includes(r)).reverse(),
  };
}

/** Veranstaltungen, die den Tag berühren (für „Heute im Haus“) – ohne abgelehnte/abgesagte, ohne Namen. */
export async function eventsOn(db: Db, date: string) {
  const from = fromBerlinLocal(`${date}T00:00`);
  const to = fromBerlinLocal(`${addDays(date, 1)}T00:00`);
  const rows = await db
    .select({ id: gebaeudeEvents.id, title: gebaeudeEvents.title, status: gebaeudeEvents.status, startsAt: gebaeudeEvents.startsAt, endsAt: gebaeudeEvents.endsAt, setupAt: gebaeudeEvents.setupAt, teardownAt: gebaeudeEvents.teardownAt, location: gebaeudeEvents.location })
    .from(gebaeudeEvents)
    .where(and(inArray(gebaeudeEvents.status, [...EVENT_ACTIVE_STATUSES]), lt(gebaeudeEvents.setupAt, to), gt(gebaeudeEvents.teardownAt, from)))
    .orderBy(asc(gebaeudeEvents.setupAt));
  return withRooms(db, rows);
}

/** Zahl offener Anmeldungen für die Hausmeisterei (angemeldet) – für Hinweise. */
export async function openEventCount(db: Db): Promise<number> {
  const rows = await db.select({ id: gebaeudeEvents.id }).from(gebaeudeEvents).where(eq(gebaeudeEvents.status, "angemeldet"));
  return rows.length;
}

export interface EventDetail {
  event: EventRow;
  history: { id: string; at: Date; kind: EventHistoryKind; text: string | null; actorName: string | null }[];
  conflicts: EventConflict[];
  blocks: { id: string; roomId: string; startsOn: string; fromPeriod: number | null; toPeriod: number | null }[];
  can: {
    approve: boolean;
    decide: boolean;
    answer: boolean;
    cancel: boolean;
    /** VA-05: anmeldende Person, offen oder bestätigt, vor dem Aufbau */
    edit: boolean;
  };
  own: boolean;
  /** VA-06: Serie – alle Termine, Stelle dieses Termins, Zahl der offenen/wartenden und der folgenden aktiven Termine */
  series: {
    items: { id: string; startsAt: Date; status: EventStatus; label: string }[];
    position: number;
    /** offene Termine bei der Hausmeisterei (für „ganze Serie bestätigen“) */
    open: number;
    /** Termine, die auf die Freigabe warten */
    approval: number;
    /** dieser und spätere aktive Termine (für „dieser und alle folgenden“) */
    following: number;
  } | null;
}

/** Detail: anmeldende Person (eigene) oder alle mit Übersichtsrecht; sonst `null` (Seite 404). */
export async function getEvent(db: Db, viewer: PermissionSet, id: string, now = new Date()): Promise<EventDetail | null> {
  const [event] = await selectEvents(db, eq(gebaeudeEvents.id, id));
  if (!event) return null;
  const own = event.organizerId === viewer.userId;
  if (!own && !canSeeAllEvents(viewer)) return null;
  const hist = await db
    .select({ id: gebaeudeEventHistory.id, at: gebaeudeEventHistory.at, kind: gebaeudeEventHistory.kind, text: gebaeudeEventHistory.text, actorName: users.name })
    .from(gebaeudeEventHistory)
    .leftJoin(users, eq(users.id, gebaeudeEventHistory.actorId))
    .where(eq(gebaeudeEventHistory.eventId, id))
    .orderBy(asc(gebaeudeEventHistory.at), asc(gebaeudeEventHistory.id));
  const blocks = await db
    .select({ id: timetableRoomBlocks.id, roomId: timetableRoomBlocks.roomId, startsOn: timetableRoomBlocks.startsOn, fromPeriod: timetableRoomBlocks.fromPeriod, toPeriod: timetableRoomBlocks.toPeriod })
    .from(gebaeudeEventBlocks)
    .innerJoin(timetableRoomBlocks, eq(timetableRoomBlocks.id, gebaeudeEventBlocks.roomBlockId))
    .where(eq(gebaeudeEventBlocks.eventId, id))
    .orderBy(asc(timetableRoomBlocks.startsOn), asc(timetableRoomBlocks.roomId));
  const active = EVENT_ACTIVE_STATUSES.includes(event.status) && event.teardownAt > now;
  // Konflikte nennen nur Sachangaben (Zeit, Raum, Titel von Wartung/Veranstaltung, Sperrgrund) – auch für die anmeldende Person
  const conflicts = active ? await eventConflicts(db, { roomIds: event.rooms, from: event.setupAt, to: event.teardownAt, excludeId: id }) : [];
  let series: EventDetail["series"] = null;
  if (event.seriesId) {
    const all = await seriesEvents(db, event.seriesId);
    const running = all.filter((o) => EVENT_ACTIVE_STATUSES.includes(o.status) && o.teardownAt > now);
    series = {
      items: all.map((o) => ({ id: o.id, startsAt: o.startsAt, status: o.status, label: eventSpan(o.startsAt, o.endsAt) })),
      position: all.findIndex((o) => o.id === id) + 1,
      open: running.filter((o) => o.status === "angemeldet" || o.status === "rueckfrage").length,
      approval: running.filter((o) => o.status === "freigabe").length,
      following: running.filter((o) => o.startsAt >= event.startsAt).length,
    };
  }
  return {
    event,
    history: hist,
    conflicts,
    blocks,
    own,
    series,
    can: {
      approve: event.status === "freigabe" && canApproveEvents(viewer) && active,
      decide: (event.status === "angemeldet" || event.status === "rueckfrage") && canManage(viewer) && active,
      answer: event.status === "rueckfrage" && own && canReport(viewer) && active,
      cancel: active && ((own && canReport(viewer)) || canManage(viewer)),
      edit: active && own && canReport(viewer) && event.setupAt > now,
    },
  };
}

// ---------------------------------------------------------------- Gong am Vortag (Job `gebaeude-veranstaltungen`)

/**
 * Täglicher Lauf: Veranstaltungen, deren Aufbau morgen beginnt (bestätigte und noch offene, nicht „wartet auf Freigabe“) – Gong an die
 * Hausmeisterei und die anmeldende Person, je Veranstaltung einmal (bedingtes UPDATE auf `reminded_at`, kein Doppelversand).
 */
export async function runEventReminders(db: Db, now = new Date()): Promise<{ events: number; notified: number }> {
  const tomorrow = addDays(toBerlinDate(now), 1);
  const from = fromBerlinLocal(`${tomorrow}T00:00`);
  const to = fromBerlinLocal(`${addDays(tomorrow, 1)}T00:00`);
  const due = await db
    .select({ id: gebaeudeEvents.id })
    .from(gebaeudeEvents)
    .where(and(inArray(gebaeudeEvents.status, ["angemeldet", "rueckfrage", "bestaetigt"]), gte(gebaeudeEvents.setupAt, from), lt(gebaeudeEvents.setupAt, to), isNull(gebaeudeEvents.remindedAt)));
  let events = 0;
  let notified = 0;
  const staff = due.length ? await caretakers(db) : [];
  for (const { id } of due) {
    const [e] = await db
      .update(gebaeudeEvents)
      .set({ remindedAt: now })
      .where(and(eq(gebaeudeEvents.id, id), isNull(gebaeudeEvents.remindedAt)))
      .returning();
    if (!e) continue;
    events++;
    const roomIds = await roomsOf(db, id);
    const place = eventPlace({ rooms: roomIds, location: e.location });
    const extra = setupText(e);
    const body = `${eventSpan(e.startsAt, e.endsAt)} · ${place}${extra ? ` · ${extra}` : ""}${e.status === "bestaetigt" ? "" : " · noch nicht bestätigt"}`;
    notified += await notify(db, [...staff, ...(e.organizerId ? [e.organizerId] : [])], { moduleId: MODULE, title: `Morgen im Haus: ${e.title}`, body, href: eventHref(id) });
  }
  return { events, notified };
}

// ---------------------------------------------------------------- Auskunft (Art. 15)

/** Lesbarer Teil der Auskunft: selbst angemeldete Veranstaltungen (bis zur Löschung 1 Jahr nach dem Ende). */
export async function eventAuskunft(db: Db, userId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({
      id: gebaeudeEvents.id,
      titel: gebaeudeEvents.title,
      stand: gebaeudeEvents.status,
      beginn: gebaeudeEvents.startsAt,
      ende: gebaeudeEvents.endsAt,
      ort: gebaeudeEvents.location,
      personen: gebaeudeEvents.persons,
      bedarf: gebaeudeEvents.details,
    })
    .from(gebaeudeEvents)
    .where(eq(gebaeudeEvents.organizerId, userId))
    .orderBy(desc(gebaeudeEvents.startsAt));
  const links = rows.length
    ? await db.select().from(gebaeudeEventRooms).where(inArray(gebaeudeEventRooms.eventId, rows.map((r) => r.id)))
    : [];
  return rows.map(({ id, ...r }) => ({
    ...r,
    beginn: r.beginn.toISOString(),
    ende: r.ende.toISOString(),
    raeume: links
      .filter((l) => l.eventId === id)
      .map((l) => l.roomId)
      .join(", "),
  }));
}
