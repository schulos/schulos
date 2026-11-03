// Veranstaltungsanmeldung an die Hausmeisterei (VA-01…03, PHASE4 P4-75, Projektleitung 2026-11-02): eigene Tabellen statt
// Ticket-Kategorie. Anmelden darf, wer Mängel melden darf (`gebaeude.report`); bestätigen, zurückfragen und ablehnen die
// Hausmeisterei (`gebaeude.manage`). Mit eingeschalteter Moduleinstellung geht die Anmeldung zuerst an die Schulleitung
// (`gebaeude.event_approve`). Bei der Bestätigung sperrt SchulOS Räume nur dort, wo Unterricht betroffen ist (je Raum und Tag die
// berührten Stunden); Wartung, Raumsperren, Buchungen und andere Veranstaltungen sind nur ein Konflikthinweis. Optional
// Schulkalender-Eintrag. „Heute im Haus“, Wochenvorschau, Gong am Vortag (Job `gebaeude-veranstaltungen`). Löschklasse LK-ENDE-1J.
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
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { getModule } from "@/modules";
import { blockLabel, createRoomBlock, deleteRoomBlock, teachersInRooms } from "@/modules/stundenplan/raumsperren";
import { listSlots } from "@/modules/stundenplan/service";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  EVENT_ACTIVE_STATUSES,
  EVENT_MAX_DAYS,
  EVENT_MAX_PERSONS,
  EVENT_MAX_ROOMS,
  EVENT_NEED_KEYS,
  EVENT_SEATING,
  EVENT_TEXT_MAX,
  type EventHistoryKind,
  type EventNeed,
  type EventSeating,
  type EventStatus,
} from "./labels";
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

// ---------------------------------------------------------------- Anlegen

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

/**
 * Veranstaltung anmelden (Recht `gebaeude.report`). Ohne Freigabe geht sie als „angemeldet“ an die Hausmeisterei, mit eingeschalteter
 * Schulleitungs-Freigabe als „wartet auf Freigabe“ an alle mit `gebaeude.event_approve`. Konflikte sind nur ein Hinweis.
 */
export async function createEvent(db: Db, viewer: PermissionSet, input: EventInput, now = new Date()): Promise<{ id: string; conflicts: EventConflict[] }> {
  if (!canReport(viewer)) throw new ForbiddenError("gebaeude.report");
  const e = await parseEvent(db, input, now);
  const approval = await approvalRequired(db);
  const status: EventStatus = approval ? "freigabe" : "angemeldet";
  const [row] = await db
    .insert(gebaeudeEvents)
    .values({
      title: e.title,
      organizerId: viewer.userId,
      status,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      setupAt: e.setupAt,
      teardownAt: e.teardownAt,
      location: e.location,
      persons: e.persons,
      seating: e.seating,
      ...e.needs,
      details: e.details,
    })
    .returning({ id: gebaeudeEvents.id });
  const id = row!.id;
  if (e.roomIds.length) await db.insert(gebaeudeEventRooms).values(e.roomIds.map((roomId) => ({ eventId: id, roomId })));
  await history(db, id, viewer.userId, "angemeldet");
  await audit(db, viewer.userId, "gebaeude.event.create", id, { rooms: e.roomIds, approval });
  const span = eventSpan(e.startsAt, e.endsAt);
  const recipients = (approval ? await usersWithPermission(db, EVENT_APPROVE_PERMISSION) : await caretakers(db)).filter((u) => u !== viewer.userId);
  await notify(db, recipients, {
    moduleId: MODULE,
    title: approval ? `Veranstaltung zur Freigabe: ${e.title}` : `Veranstaltung angemeldet: ${e.title}`,
    body: span,
    href: eventHref(id),
  });
  return { id, conflicts: await eventConflicts(db, { roomIds: e.roomIds, from: e.setupAt, to: e.teardownAt, excludeId: id }) };
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

/** Schulleitung gibt frei (Recht `gebaeude.event_approve`, Stand „wartet auf Freigabe“) → an die Hausmeisterei. */
export async function approveEvent(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  if (!canApproveEvents(viewer)) throw new ForbiddenError(EVENT_APPROVE_PERMISSION);
  const e = await loadEvent(db, id);
  if (!(await transition(db, id, ["freigabe"], "angemeldet"))) throw stale();
  await history(db, id, viewer.userId, "freigegeben");
  await audit(db, viewer.userId, "gebaeude.event.approve", id);
  const span = eventSpan(e.startsAt, e.endsAt);
  await notify(db, (await caretakers(db)).filter((u) => u !== viewer.userId), { moduleId: MODULE, title: `Veranstaltung angemeldet: ${e.title}`, body: span, href: eventHref(id) });
  if (e.organizerId && e.organizerId !== viewer.userId)
    await notify(db, [e.organizerId], { moduleId: MODULE, title: `Veranstaltung freigegeben: ${e.title}`, body: "Liegt jetzt bei der Hausmeisterei.", href: eventHref(id) });
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
}

/**
 * Bestätigen (Recht `gebaeude.manage`, Stand „angemeldet“ oder „Rückfrage“). Raumsperre nur bei Überschneidung mit Unterricht –
 * je Raum und Tag eine Sperre über die berührten Stunden (Grund „Veranstaltung“), Gong an die betroffenen Lehrkräfte; alles andere
 * bleibt Konflikthinweis. Optional Schulkalender-Eintrag „im Namen des Moduls“ (ohne `kalender.school`, mit Audit).
 */
export async function confirmEvent(db: Db, viewer: PermissionSet, id: string, opts: ConfirmOptions): Promise<{ blocks: number; notified: number }> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const note = opts.note?.trim() || null;
  if (note && note.length > EVENT_TEXT_MAX) throw new ValidationError({ note: `höchstens ${EVENT_TEXT_MAX} Zeichen` });
  const e = await loadEvent(db, id);
  if (!(await transition(db, id, ["angemeldet", "rueckfrage"], "bestaetigt"))) throw stale();
  const roomIds = await roomsOf(db, id);
  let blocks = 0;
  let notified = 0;
  if (opts.blockRooms && roomIds.length) {
    const overlaps = await lessonOverlaps(db, roomIds, e.setupAt, e.teardownAt);
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
      await db.insert(gebaeudeEventBlocks).values({ eventId: id, roomBlockId: blockId });
      blocks++;
    }
    if (overlaps.length) {
      const blocked = [...new Set(overlaps.map((o) => o.roomId))];
      const teachers = (await teachersInRooms(db, blocked, e.setupAt, e.teardownAt)).filter((u) => u !== viewer.userId);
      notified = await notify(db, teachers, {
        moduleId: MODULE,
        title: `Raum ${blocked.join(", ")} gesperrt: Veranstaltung ${e.title}`,
        body: `${eventSpan(e.setupAt, e.teardownAt)} – bitte Vertretungsplan beachten`,
        href: "/stundenplan",
      });
    }
  }
  if (opts.calendar) {
    const place = [roomIds.length ? `Raum ${roomIds.join(", ")}` : null, e.location].filter(Boolean).join(" · ") || null;
    const [c] = await db
      .insert(calendarEvents)
      .values({ title: e.title.slice(0, 200), description: null, location: place, startsAt: e.startsAt, endsAt: e.endsAt, allDay: false, scope: "school", ownerId: viewer.userId })
      .returning({ id: calendarEvents.id });
    await db.update(gebaeudeEvents).set({ calendarEventId: c!.id }).where(eq(gebaeudeEvents.id, id));
  }
  await history(db, id, viewer.userId, "bestaetigt", note);
  await audit(db, viewer.userId, "gebaeude.event.confirm", id, { blocks, calendar: opts.calendar });
  if (e.organizerId && e.organizerId !== viewer.userId)
    await notify(db, [e.organizerId], { moduleId: MODULE, title: `Veranstaltung bestätigt: ${e.title}`, body: note?.slice(0, 200) ?? eventSpan(e.startsAt, e.endsAt), href: eventHref(id) });
  return { blocks, notified };
}

/** Raumsperren und Kalendereintrag einer Veranstaltung entfernen (Absage). */
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
 * Kalendereintrag fallen weg; die Gegenseite bekommt einen Gong.
 */
export async function cancelEvent(db: Db, viewer: PermissionSet, id: string, text: string | null, now = new Date()): Promise<void> {
  const e = await loadEvent(db, id);
  const own = e.organizerId === viewer.userId && canReport(viewer);
  if (!own && !canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = text?.trim() || null;
  if (t && t.length > EVENT_TEXT_MAX) throw new ValidationError({ text: `höchstens ${EVENT_TEXT_MAX} Zeichen` });
  if (e.teardownAt <= now) throw new ValidationError({ status: "Die Veranstaltung ist schon vorbei" });
  if (!(await transition(db, id, EVENT_ACTIVE_STATUSES, "abgesagt"))) throw stale();
  await releaseEvent(db, viewer.userId, e);
  await history(db, id, viewer.userId, "abgesagt", t);
  await audit(db, viewer.userId, "gebaeude.event.cancel", id, { from: e.status });
  const msg = { moduleId: MODULE, title: `Veranstaltung abgesagt: ${e.title}`, body: t?.slice(0, 200) ?? eventSpan(e.startsAt, e.endsAt), href: eventHref(id) };
  if (own) {
    if (e.status !== "freigabe") await notify(db, (await caretakers(db)).filter((u) => u !== viewer.userId), msg);
  } else if (e.organizerId && e.organizerId !== viewer.userId) await notify(db, [e.organizerId], msg);
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
  approval: EventRow[];
  /** liegt bei der Hausmeisterei bzw. wartet auf eine Antwort */
  open: EventRow[];
  /** Wochenvorschau: heute und die nächsten 6 Tage, je Tag die berührenden (nicht abgelehnten/abgesagten) Veranstaltungen */
  week: { date: string; events: EventRow[] }[];
  /** später als die Wochenvorschau, bestätigt */
  later: EventRow[];
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
    approval: canApproveEvents(viewer) ? running.filter((r) => r.status === "freigabe") : [],
    open: running.filter((r) => r.status === "angemeldet" || r.status === "rueckfrage"),
    week,
    later: running.filter((r) => r.status === "bestaetigt" && r.setupAt >= weekEnd),
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
  can: { approve: boolean; decide: boolean; answer: boolean; cancel: boolean };
  own: boolean;
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
  return {
    event,
    history: hist,
    conflicts,
    blocks,
    own,
    can: {
      approve: event.status === "freigabe" && canApproveEvents(viewer) && active,
      decide: (event.status === "angemeldet" || event.status === "rueckfrage") && canManage(viewer) && active,
      answer: event.status === "rueckfrage" && own && canReport(viewer) && active,
      cancel: active && ((own && canReport(viewer)) || canManage(viewer)),
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
