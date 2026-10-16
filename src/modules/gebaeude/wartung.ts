// Gebäude & Technik (P4-17): Wartungstermine einer Firma – optional Raumsperre und Eintrag im Schulkalender, Gong an die
// Lehrkräfte, die im Zeitraum in den betroffenen Räumen unterrichten (Stundenplan-Service). Kein Monitor-Laufband.
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { calendarEvents, gebaeudeMaintenance, gebaeudeMaintenanceRooms, rooms, timetableRoomBlocks, users } from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { createRoomBlock, deleteRoomBlock, teachersInRooms } from "@/modules/stundenplan/raumsperren";
import { ValidationError } from "@/modules/verwaltung/users";
import { canManage, canViewAll } from "./service";

const MODULE = "gebaeude";
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** Höchstens so viele Tage – längere Arbeiten sind eher eine Raumsperre „Renovierung“. */
export const MAX_MAINTENANCE_DAYS = 31;

export interface MaintenanceInput {
  title: string;
  provider: string | null;
  /** „YYYY-MM-DDTHH:MM“ (Berliner Ortszeit) */
  start: string;
  end: string;
  building: string | null;
  roomIds: readonly string[];
  note: string | null;
  /** Räume für den Zeitraum sperren (ganze Tage, Grund „sonstiges“) */
  blockRooms: boolean;
  /** Eintrag im Schulkalender (nur, wenn das Kalender-Modul an ist – entscheidet der Aufrufer) */
  calendar: boolean;
}

const when = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

/** Rein: „Mo., 12.10., 08:00–12:00“ bzw. über mehrere Tage „Mo., 12.10., 08:00 – Di., 13.10., 16:00“. */
export function maintenanceSpan(from: Date, to: Date): string {
  return toBerlinDate(from) === toBerlinDate(to) ? `${when.format(from)}–${time.format(to)}` : `${when.format(from)} – ${when.format(to)}`;
}

/**
 * Wartungstermin anlegen (Recht `gebaeude.manage`). Sperrt auf Wunsch die Räume (ganze Tage) und trägt den Termin im
 * Schulkalender ein – „im Namen des Moduls“ ohne `kalender.school`, mit Audit. Gong an betroffene Lehrkräfte.
 */
export async function createMaintenance(db: Db, viewer: PermissionSet, input: MaintenanceInput): Promise<{ id: string; notified: number }> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  const provider = input.provider?.trim() || null;
  const building = input.building?.trim() || null;
  const note = input.note?.trim() || null;
  const roomIds = [...new Set(input.roomIds.map((r) => r.trim()).filter(Boolean))];
  if (title.length < 3 || title.length > 120) fe.title = "Titel mit 3 bis 120 Zeichen";
  if (provider && provider.length > 120) fe.provider = "höchstens 120 Zeichen";
  if (building && building.length > 60) fe.building = "höchstens 60 Zeichen";
  if (note && note.length > 2000) fe.note = "höchstens 2000 Zeichen";
  if (!LOCAL.test(input.start)) fe.start = "Beginn angeben";
  if (!LOCAL.test(input.end)) fe.end = "Ende angeben";
  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  if (!fe.start && !fe.end) {
    startsAt = fromBerlinLocal(input.start);
    endsAt = fromBerlinLocal(input.end);
    if (endsAt <= startsAt) fe.end = "Ende liegt vor dem Beginn";
    else if (endsAt.getTime() - startsAt.getTime() > MAX_MAINTENANCE_DAYS * 86_400_000) fe.end = `Höchstens ${MAX_MAINTENANCE_DAYS} Tage`;
  }
  if (roomIds.length > 50) fe.roomIds = "Höchstens 50 Räume";
  else if (roomIds.length) {
    const found = new Set((await db.select({ id: rooms.id }).from(rooms).where(inArray(rooms.id, roomIds))).map((r) => r.id));
    const missing = roomIds.filter((r) => !found.has(r));
    if (missing.length) fe.roomIds = `Raum ${missing.join(", ")} gibt es nicht`;
  }
  if (input.blockRooms && !roomIds.length) fe.roomIds = "Für eine Raumsperre Räume wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  const [m] = await db
    .insert(gebaeudeMaintenance)
    .values({ title, provider, startsAt: startsAt!, endsAt: endsAt!, building, note, blocksRooms: input.blockRooms, createdBy: viewer.userId })
    .returning({ id: gebaeudeMaintenance.id });
  const id = m!.id;
  const span = maintenanceSpan(startsAt!, endsAt!);
  for (const roomId of roomIds) {
    let roomBlockId: string | null = null;
    if (input.blockRooms) {
      roomBlockId = await createRoomBlock(db, viewer.userId, {
        roomId,
        startsOn: toBerlinDate(startsAt!),
        endsOn: toBerlinDate(new Date(endsAt!.getTime() - 1)),
        fromPeriod: null,
        toPeriod: null,
        reason: "sonstiges",
        note: `Wartung: ${title}`.slice(0, 80),
      });
    }
    await db.insert(gebaeudeMaintenanceRooms).values({ maintenanceId: id, roomId, roomBlockId });
  }
  if (input.calendar) {
    const place = [roomIds.length ? `Raum ${roomIds.join(", ")}` : null, building].filter(Boolean).join(" · ") || null;
    const [e] = await db
      .insert(calendarEvents)
      .values({
        title: `Wartung: ${title}`.slice(0, 200),
        description: provider ? `Firma: ${provider}` : null,
        location: place,
        startsAt: startsAt!,
        endsAt: endsAt!,
        allDay: false,
        scope: "school",
        ownerId: viewer.userId,
      })
      .returning({ id: calendarEvents.id });
    await db.update(gebaeudeMaintenance).set({ calendarEventId: e!.id }).where(eq(gebaeudeMaintenance.id, id));
  }
  await audit(db, viewer.userId, "gebaeude.maintenance.create", id, { rooms: roomIds, blockRooms: input.blockRooms, calendar: input.calendar });

  let notified = 0;
  if (roomIds.length) {
    const teachers = (await teachersInRooms(db, roomIds, startsAt!, endsAt!)).filter((u) => u !== viewer.userId);
    notified = await notify(db, teachers, {
      moduleId: MODULE,
      title: `Wartung in Raum ${roomIds.join(", ")}: ${title}`,
      body: `${span}${input.blockRooms ? " – Raum gesperrt, bitte Vertretungsplan beachten" : ""}`,
      href: "/gebaeude/wartung",
    });
  }
  return { id, notified };
}

/** Wartungstermin absagen (Recht `gebaeude.manage`): Raumsperren und Kalendereintrag fallen mit weg. */
export async function deleteMaintenance(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const [m] = await db.select().from(gebaeudeMaintenance).where(eq(gebaeudeMaintenance.id, id));
  if (!m) throw new ValidationError({ maintenance: "Termin gibt es nicht" });
  const linked = await db.select({ blockId: gebaeudeMaintenanceRooms.roomBlockId }).from(gebaeudeMaintenanceRooms).where(eq(gebaeudeMaintenanceRooms.maintenanceId, id));
  for (const l of linked) if (l.blockId) await deleteRoomBlock(db, viewer.userId, l.blockId);
  if (m.calendarEventId) await db.delete(calendarEvents).where(eq(calendarEvents.id, m.calendarEventId));
  await db.delete(gebaeudeMaintenance).where(eq(gebaeudeMaintenance.id, id));
  await audit(db, viewer.userId, "gebaeude.maintenance.delete", id, { title: m.title });
}

/** Termine: kommende (Vorgabe) bzw. vergangene (letzte 90 Tage) – Recht `gebaeude.manage` oder `gebaeude.view_all`. */
export async function listMaintenance(db: Db, viewer: PermissionSet, now: Date, past = false) {
  if (!canViewAll(viewer)) throw new ForbiddenError("gebaeude.view_all");
  const rows = await db
    .select({
      id: gebaeudeMaintenance.id,
      title: gebaeudeMaintenance.title,
      provider: gebaeudeMaintenance.provider,
      startsAt: gebaeudeMaintenance.startsAt,
      endsAt: gebaeudeMaintenance.endsAt,
      building: gebaeudeMaintenance.building,
      note: gebaeudeMaintenance.note,
      blocksRooms: gebaeudeMaintenance.blocksRooms,
      calendarEventId: gebaeudeMaintenance.calendarEventId,
      createdByName: users.name,
    })
    .from(gebaeudeMaintenance)
    .leftJoin(users, eq(users.id, gebaeudeMaintenance.createdBy))
    .where(past ? and(lt(gebaeudeMaintenance.endsAt, now), gte(gebaeudeMaintenance.endsAt, new Date(now.getTime() - 90 * 86_400_000))) : gte(gebaeudeMaintenance.endsAt, now))
    .orderBy(past ? desc(gebaeudeMaintenance.startsAt) : asc(gebaeudeMaintenance.startsAt));
  if (!rows.length) return [];
  const links = await db
    .select({ maintenanceId: gebaeudeMaintenanceRooms.maintenanceId, roomId: gebaeudeMaintenanceRooms.roomId, blockEnds: timetableRoomBlocks.endsOn })
    .from(gebaeudeMaintenanceRooms)
    .leftJoin(timetableRoomBlocks, eq(timetableRoomBlocks.id, gebaeudeMaintenanceRooms.roomBlockId))
    .where(inArray(gebaeudeMaintenanceRooms.maintenanceId, rows.map((r) => r.id)));
  return rows.map((r) => {
    const rs = links.filter((l) => l.maintenanceId === r.id);
    return {
      ...r,
      rooms: rs.map((l) => l.roomId).sort((a, b) => a.localeCompare(b, "de", { numeric: true })),
      blocked: rs.some((l) => l.blockEnds !== null),
      span: maintenanceSpan(r.startsAt, r.endsAt),
    };
  });
}
