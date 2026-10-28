// Raumsteckbrief (RS-02/RS-03, docs/RAUMSTECKBRIEF.md): eine Seite je Raum für alle Angemeldeten, Felder je Sicht gefiltert.
// Schüler:innen/Eltern („familie“) sehen Kopf, Ausstattung grob, Infofelder „für alle“ und die Belegung nur als frei/belegt;
// Beschäftigte („personal“, STAFF_ROLES) zusätzlich Klasse/Lehrkraft, Personal-Infofelder und offene Mängel. Gefiltert wird
// hier im Service, nicht erst in der Seite. Räume sind Kernstammdaten – Abschnitte aus abschaltbaren Modulen (Stundenplan,
// Gebäude & Technik, Buchungen) kommen nur, wenn der Aufrufer das Modul als eingeschaltet meldet.
// Andockpunkte: RS-04 Fotos (Titelbild im Kopf), RS-05 Ausstattungskatalog (ersetzt `equipment`), RS-06 Raumverantwortliche
// und Recht „Raumdaten pflegen“ (erweitert `canEditRoomInfo`).
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  ROOM_INFO_VISIBILITIES,
  bookingResources,
  gebaeudeAssets,
  gebaeudeInspectionTypes,
  gebaeudeInspections,
  gebaeudeTickets,
  periods,
  roomInfoFields,
  roomInfoValues,
  rooms,
  timetableRoomBlocks,
  type RoomBlockReason,
  type RoomEquipment,
  type RoomInfoVisibility,
  type RoomKind,
} from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { isStaffRole } from "@/core/roles";
import { addDays } from "@/core/time";
import { CATEGORY_LABELS, OPEN_STATUSES, PRIORITY_LABELS, STATUS_LABELS, ticketNumber, type TicketCategory, type TicketPriority, type TicketStatus } from "@/modules/gebaeude/labels";
import { inspectionState } from "@/modules/gebaeude/pruefungen";
import { ROOM_BLOCK_LABELS, occupancyOn } from "@/modules/stundenplan/raeume";
import { ROOM_OCCUPANCY_FAMILY } from "./settings";
import { ValidationError } from "./users";

// ---------------------------------------------------------------- Sicht und Rechte

export type RoomAudience = "personal" | "familie";

/** Beschäftigte (STAFF_ROLES) sehen den Steckbrief mit Details, Schüler:innen und Eltern die gefilterte Fassung. */
export function roomAudience(viewer: PermissionSet): RoomAudience {
  return isStaffRole(viewer.role) ? "personal" : "familie";
}

/** Sichtbarkeiten, die eine Sicht lesen darf. */
export function visibleFor(audience: RoomAudience): readonly RoomInfoVisibility[] {
  return audience === "personal" ? ROOM_INFO_VISIBILITIES : ["alle"];
}

/**
 * Wer Infofelder eines Raums pflegt. Bis RS-06 (Recht „Raumdaten pflegen“, Raumverantwortliche pflegen ihren Raum) wer heute
 * Räume bearbeiten darf: `verwaltung.school`. RS-06 erweitert nur diese Funktion (der Raum ist schon Parameter).
 */
export function canEditRoomInfo(viewer: PermissionSet, roomId: string): boolean {
  return roomId !== "" && hasPermission(viewer, "verwaltung.school");
}

/** Infofelder anlegen, umbenennen, Sichtbarkeit ändern, löschen: Stammdaten-Recht (schulweit, nicht je Raum). */
export function canManageInfoFields(viewer: PermissionSet): boolean {
  return hasPermission(viewer, "verwaltung.school");
}

// ---------------------------------------------------------------- Infofelder (RS-03)

export type RoomInfoField = typeof roomInfoFields.$inferSelect;

export const INFO_LABEL_MAX = 60;
export const INFO_VALUE_MAX = 1000;
export const INFO_FIELDS_MAX = 30;

/** Rein: Reihenfolge, dann Bezeichnung (in JS statt per Collation der Datenbank). */
const byOrder = (a: { sortOrder: number; label: string }, b: { sortOrder: number; label: string }) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, "de");

/** Vorgabe-Infofelder (Projektleitung 2026-10-28) – dieselben legt Migration 0115 an. */
export const DEFAULT_INFO_FIELDS: { id: string; label: string; visibility: RoomInfoVisibility; sortOrder: number }[] = [
  { id: "technik", label: "Technik/Netz", visibility: "personal", sortOrder: 1 },
  { id: "nutzung", label: "Nutzungshinweise", visibility: "personal", sortOrder: 2 },
  { id: "sicherheit", label: "Sicherheit", visibility: "personal", sortOrder: 3 },
  { id: "lueftung", label: "Fenster/Lüftung", visibility: "alle", sortOrder: 4 },
  { id: "flaeche", label: "Fläche", visibility: "alle", sortOrder: 5 },
  { id: "durchwahl", label: "Durchwahl", visibility: "personal", sortOrder: 6 },
];

/** Legt fehlende Vorgabe-Infofelder an (Demo-Seed nach dem Leeren aller Tabellen); vorhandene bleiben unverändert. */
export async function ensureDefaultInfoFields(db: Db): Promise<void> {
  await db.insert(roomInfoFields).values(DEFAULT_INFO_FIELDS).onConflictDoNothing();
}

export async function listInfoFields(db: Db): Promise<RoomInfoField[]> {
  return (await db.select().from(roomInfoFields)).sort(byOrder);
}

export interface InfoFieldInput {
  label: string;
  visibility: string;
  /** leer = ans Ende */
  sortOrder?: string | number | null;
}

async function validateField(db: Db, input: InfoFieldInput, exceptId?: string) {
  const fe: Record<string, string> = {};
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!label) fe.label = "Bezeichnung angeben";
  else if (label.length > INFO_LABEL_MAX) fe.label = `Bezeichnung höchstens ${INFO_LABEL_MAX} Zeichen`;
  else {
    const [dup] = await db
      .select({ id: roomInfoFields.id })
      .from(roomInfoFields)
      .where(sql`lower(${roomInfoFields.label}) = lower(${label})`);
    if (dup && dup.id !== exceptId) fe.label = "Diese Bezeichnung gibt es schon";
  }
  if (!(ROOM_INFO_VISIBILITIES as readonly string[]).includes(input.visibility)) fe.visibility = "Sichtbarkeit wählen";
  const raw = input.sortOrder === null || input.sortOrder === undefined ? "" : String(input.sortOrder).trim();
  const sortOrder = raw === "" ? null : Number(raw);
  if (sortOrder !== null && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999)) fe.sortOrder = "Reihenfolge 0–999 oder leer";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { label, visibility: input.visibility as RoomInfoVisibility, sortOrder };
}

export async function createInfoField(db: Db, viewer: PermissionSet, input: InfoFieldInput): Promise<string> {
  if (!canManageInfoFields(viewer)) throw new ForbiddenError("verwaltung.school");
  const v = await validateField(db, input);
  const [{ n, top }] = (await db
    .select({ n: sql<number>`count(*)::int`, top: sql<number>`coalesce(max(${roomInfoFields.sortOrder}), 0)::int` })
    .from(roomInfoFields)) as [{ n: number; top: number }];
  if (n >= INFO_FIELDS_MAX) throw new ValidationError({ label: `Höchstens ${INFO_FIELDS_MAX} Infofelder` });
  const id = crypto.randomUUID();
  await db.insert(roomInfoFields).values({ id, label: v.label, visibility: v.visibility, sortOrder: v.sortOrder ?? top + 1 });
  await audit(db, viewer.userId, "verwaltung.room.info_field.create", id, { label: v.label, visibility: v.visibility });
  return id;
}

export async function updateInfoField(db: Db, viewer: PermissionSet, id: string, input: InfoFieldInput): Promise<void> {
  if (!canManageInfoFields(viewer)) throw new ForbiddenError("verwaltung.school");
  const [old] = await db.select().from(roomInfoFields).where(eq(roomInfoFields.id, id));
  if (!old) throw new ValidationError({ label: "Infofeld gibt es nicht" });
  const v = await validateField(db, input, id);
  await db
    .update(roomInfoFields)
    .set({ label: v.label, visibility: v.visibility, sortOrder: v.sortOrder ?? old.sortOrder })
    .where(eq(roomInfoFields.id, id));
  await audit(db, viewer.userId, "verwaltung.room.info_field.update", id, {
    label: v.label,
    ...(old.label !== v.label ? { labelFrom: old.label } : {}),
    ...(old.visibility !== v.visibility ? { visibility: v.visibility, visibilityFrom: old.visibility } : {}),
  });
}

/** Löscht ein Infofeld samt seinen Werten in allen Räumen (das Formular fragt nach). */
export async function deleteInfoField(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  if (!canManageInfoFields(viewer)) throw new ForbiddenError("verwaltung.school");
  const [old] = await db.select().from(roomInfoFields).where(eq(roomInfoFields.id, id));
  if (!old) return;
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(roomInfoValues).where(eq(roomInfoValues.fieldId, id))) as [{ n: number }];
  await db.delete(roomInfoFields).where(eq(roomInfoFields.id, id));
  await audit(db, viewer.userId, "verwaltung.room.info_field.delete", id, { label: old.label, values: n });
}

export interface RoomInfoEntry {
  fieldId: string;
  label: string;
  visibility: RoomInfoVisibility;
  value: string;
}

/** Ausgefüllte Infofelder eines Raums, die die Sicht lesen darf – in der Reihenfolge der Felder. */
export async function roomInfo(db: Db, roomId: string, audience: RoomAudience): Promise<RoomInfoEntry[]> {
  const rows = await db
    .select({ fieldId: roomInfoFields.id, label: roomInfoFields.label, visibility: roomInfoFields.visibility, sortOrder: roomInfoFields.sortOrder, value: roomInfoValues.value })
    .from(roomInfoValues)
    .innerJoin(roomInfoFields, eq(roomInfoFields.id, roomInfoValues.fieldId))
    .where(and(eq(roomInfoValues.roomId, roomId), inArray(roomInfoFields.visibility, [...visibleFor(audience)])));
  return rows.sort(byOrder).map((r) => ({ fieldId: r.fieldId, label: r.label, visibility: r.visibility, value: r.value }));
}

/** Alle Felder mit dem Wert des Raums (leer = ""), für das Pflegeformular. */
export async function roomInfoForm(db: Db, roomId: string): Promise<(RoomInfoField & { value: string })[]> {
  const [fields, values] = await Promise.all([listInfoFields(db), db.select().from(roomInfoValues).where(eq(roomInfoValues.roomId, roomId))]);
  const byField = new Map(values.map((v) => [v.fieldId, v.value]));
  return fields.map((f) => ({ ...f, value: byField.get(f.id) ?? "" }));
}

/**
 * Speichert die Infofelder eines Raums (`values`: Feld-ID → Text; leer löscht). Nur geänderte Felder werden geschrieben und
 * im Audit genannt (Bezeichnungen, nicht die Texte). Gibt die Zahl der Änderungen zurück.
 */
export async function setRoomInfo(db: Db, viewer: PermissionSet, roomId: string, values: Record<string, string>): Promise<number> {
  if (!canEditRoomInfo(viewer, roomId)) throw new ForbiddenError("verwaltung.school");
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ room: `Raum ${roomId} gibt es nicht` });
  const current = await roomInfoForm(db, roomId);
  const known = new Map(current.map((f) => [f.id, f]));
  const fe: Record<string, string> = {};
  for (const id of Object.keys(values)) if (!known.has(id)) fe[id] = "Unbekanntes Infofeld";
  const next = new Map(Object.entries(values).map(([id, v]) => [id, v.replace(/\r\n/g, "\n").trim()]));
  for (const [id, v] of next) if (v.length > INFO_VALUE_MAX) fe[id] = `Höchstens ${INFO_VALUE_MAX} Zeichen`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const changed = current.filter((f) => next.has(f.id) && next.get(f.id) !== f.value);
  if (!changed.length) return 0;
  const now = new Date();
  for (const f of changed) {
    const v = next.get(f.id)!;
    if (!v) await db.delete(roomInfoValues).where(and(eq(roomInfoValues.roomId, roomId), eq(roomInfoValues.fieldId, f.id)));
    else
      await db
        .insert(roomInfoValues)
        .values({ roomId, fieldId: f.id, value: v, updatedAt: now })
        .onConflictDoUpdate({ target: [roomInfoValues.roomId, roomInfoValues.fieldId], set: { value: v, updatedAt: now } });
  }
  await audit(db, viewer.userId, "verwaltung.room.info", roomId, { fields: changed.map((f) => f.label) });
  return changed.length;
}

// ---------------------------------------------------------------- Steckbrief (RS-02)

export interface ProfileBlock {
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
  reason: RoomBlockReason;
  reasonLabel: string;
  /** Freitext der Sperre – nur für Beschäftigte */
  note: string | null;
}

/** Eine Stunde in der Belegung. Für Schüler:innen/Eltern nur `belegt` ohne Details. */
export type ProfileSlot =
  | { state: "frei" }
  | { state: "belegt"; kind?: "lesson" | "booking" | "blocked"; label?: string; teacher?: string; moved?: boolean };

export interface ProfileDay {
  date: string;
  /** Ferien/Feiertag: Name, sonst null */
  closed: string | null;
  slots: Map<number, ProfileSlot>;
}

export interface ProfileDefect {
  id: string;
  number: string;
  title: string;
  category: string;
  status: TicketStatus;
  statusLabel: string;
  priority: TicketPriority;
  priorityLabel: string;
  createdAt: Date;
  /** Link auf die Meldung nur, wer sie im Modul sehen darf (eigene bzw. `gebaeude.view_all`/`manage`) */
  canOpen: boolean;
}

export interface ProfileInspection {
  id: string;
  typeName: string;
  dueOn: string;
  state: "ueberfaellig" | "faellig";
}

export interface RoomProfile {
  room: {
    id: string;
    name: string;
    kind: RoomKind;
    building: string | null;
    floor: string | null;
    capacity: number | null;
    equipment: RoomEquipment[];
    accessible: boolean;
    active: boolean;
  };
  audience: RoomAudience;
  /** laufende Sperren (heute) */
  blocks: ProfileBlock[];
  /** geplante Sperren der nächsten 14 Tage */
  upcomingBlocks: ProfileBlock[];
  info: RoomInfoEntry[];
  /** null: Stundenplan aus oder für Schüler:innen/Eltern abgeschaltet (Moduleinstellung) */
  week: { monday: string; periods: { nr: number; startsAt: string; endsAt: string }[]; days: ProfileDay[] } | null;
  /** null: keine Beschäftigten-Sicht oder Gebäude & Technik aus */
  defects: ProfileDefect[] | null;
  /** null: ohne `gebaeude.view_all`/`manage` oder Modul aus */
  inspections: ProfileInspection[] | null;
  /** Buchbare Ressource des Raums (Modul Buchungen), sonst null */
  bookingResourceId: string | null;
}

export interface ProfileOptions {
  today: string;
  /** Montag der gezeigten Woche */
  monday: string;
  modules: { stundenplan: boolean; gebaeude: boolean; buchungen: boolean };
}

const canViewAllTickets = (p: PermissionSet) => hasPermission(p, "gebaeude.manage") || hasPermission(p, "gebaeude.view_all");

/** Rein: Belegung einer Stunde für die Sicht – Schüler:innen/Eltern erfahren nur frei oder belegt. */
export function slotFor(o: { kind: string; label: string; moved?: boolean; teacher?: string } | undefined, audience: RoomAudience): ProfileSlot {
  if (!o || o.kind === "closed") return { state: "frei" };
  if (audience === "familie") return { state: "belegt" };
  const kind = o.kind === "lesson" || o.kind === "booking" || o.kind === "blocked" ? o.kind : undefined;
  return { state: "belegt", kind, label: o.label, ...(o.teacher ? { teacher: o.teacher } : {}), ...(o.moved ? { moved: true } : {}) };
}

function maskBlock(b: typeof timetableRoomBlocks.$inferSelect, audience: RoomAudience): ProfileBlock {
  return {
    startsOn: b.startsOn,
    endsOn: b.endsOn,
    fromPeriod: b.fromPeriod,
    toPeriod: b.toPeriod,
    reason: b.reason,
    reasonLabel: ROOM_BLOCK_LABELS[b.reason],
    note: audience === "personal" ? b.note : null,
  };
}

/** Steckbrief eines Raums für den Betrachter – null, wenn es den Raum nicht gibt. */
export async function roomProfile(db: Db, viewer: PermissionSet, roomId: string, opts: ProfileOptions): Promise<RoomProfile | null> {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  if (!room) return null;
  const audience = roomAudience(viewer);
  const { today, monday, modules } = opts;

  const [blockRows, info, familyOccupancy, resource] = await Promise.all([
    db
      .select()
      .from(timetableRoomBlocks)
      .where(and(eq(timetableRoomBlocks.roomId, roomId), gte(timetableRoomBlocks.endsOn, today), lte(timetableRoomBlocks.startsOn, addDays(today, 14))))
      .orderBy(asc(timetableRoomBlocks.startsOn), asc(timetableRoomBlocks.endsOn), asc(timetableRoomBlocks.id)),
    roomInfo(db, roomId, audience),
    audience === "familie" ? readModuleSetting(db, ROOM_OCCUPANCY_FAMILY) : Promise.resolve("frei_belegt"),
    modules.buchungen
      ? db
          .select({ id: bookingResources.id })
          .from(bookingResources)
          .where(and(eq(bookingResources.roomId, roomId), eq(bookingResources.active, true), eq(bookingResources.kind, "room")))
      : Promise.resolve([]),
  ]);

  let week: RoomProfile["week"] = null;
  if (modules.stundenplan && familyOccupancy !== "aus") {
    const ps = await db.select().from(periods).orderBy(asc(periods.nr));
    const days: ProfileDay[] = [];
    for (let i = 0; i < 5; i++) {
      const date = addDays(monday, i);
      const { occupancy, closed } = await occupancyOn(db, date);
      const mine = occupancy.get(roomId);
      days.push({ date, closed, slots: new Map(ps.map((p) => [p.nr, slotFor(mine?.get(p.nr), audience)])) });
    }
    week = { monday, periods: ps, days };
  }

  let defects: ProfileDefect[] | null = null;
  if (audience === "personal" && modules.gebaeude) {
    const rows = await db
      .select({
        id: gebaeudeTickets.id,
        year: gebaeudeTickets.year,
        seq: gebaeudeTickets.seq,
        title: gebaeudeTickets.title,
        category: gebaeudeTickets.category,
        status: gebaeudeTickets.status,
        priority: gebaeudeTickets.priority,
        createdAt: gebaeudeTickets.createdAt,
        reporterId: gebaeudeTickets.reporterId,
      })
      .from(gebaeudeTickets)
      .where(and(eq(gebaeudeTickets.roomId, roomId), isNull(gebaeudeTickets.closedAt), inArray(gebaeudeTickets.status, [...OPEN_STATUSES])))
      .orderBy(
        sql`case ${gebaeudeTickets.priority} when 'gefahr' then 0 when 'hoch' then 1 when 'normal' then 2 else 3 end`,
        desc(gebaeudeTickets.createdAt),
        asc(gebaeudeTickets.id),
      )
      .limit(50);
    const all = canViewAllTickets(viewer);
    // Ohne Namen: wer gemeldet hat bzw. bearbeitet, steht nur in der Meldung selbst (Sichtbarkeit dort wie bisher)
    defects = rows.map((r) => ({
      id: r.id,
      number: ticketNumber(r.year, r.seq),
      title: r.title,
      category: CATEGORY_LABELS[r.category as TicketCategory],
      status: r.status,
      statusLabel: STATUS_LABELS[r.status],
      priority: r.priority,
      priorityLabel: PRIORITY_LABELS[r.priority],
      createdAt: r.createdAt,
      canOpen: all || r.reporterId === viewer.userId,
    }));
  }

  let inspections: ProfileInspection[] | null = null;
  if (modules.gebaeude && canViewAllTickets(viewer)) {
    const rows = await db
      .select({ id: gebaeudeInspections.id, typeName: gebaeudeInspectionTypes.name, dueOn: gebaeudeInspections.dueOn, doneOn: gebaeudeInspections.doneOn, warnDays: gebaeudeInspectionTypes.warnDays })
      .from(gebaeudeInspections)
      .innerJoin(gebaeudeInspectionTypes, eq(gebaeudeInspectionTypes.id, gebaeudeInspections.typeId))
      .leftJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeInspections.assetId))
      .where(
        and(
          isNull(gebaeudeInspections.doneOn),
          eq(gebaeudeInspectionTypes.active, true),
          sql`coalesce(${gebaeudeAssets.active}, true)`,
          or(eq(gebaeudeInspections.roomId, roomId), eq(gebaeudeAssets.roomId, roomId)),
        ),
      )
      .orderBy(asc(gebaeudeInspections.dueOn), asc(gebaeudeInspectionTypes.name), asc(gebaeudeInspections.id));
    inspections = rows.flatMap((r) => {
      const state = inspectionState(r, r.warnDays, today);
      return state === "ueberfaellig" || state === "faellig" ? [{ id: r.id, typeName: r.typeName, dueOn: r.dueOn, state }] : [];
    });
  }

  return {
    room: { ...room, equipment: room.equipment as RoomEquipment[] },
    audience,
    blocks: blockRows.filter((b) => b.startsOn <= today).map((b) => maskBlock(b, audience)),
    upcomingBlocks: blockRows.filter((b) => b.startsOn > today).map((b) => maskBlock(b, audience)),
    info,
    week,
    defects,
    inspections,
    bookingResourceId: resource[0]?.id ?? null,
  };
}

/** Aktive Räume für die Raumliste und die globale Suche (alle Angemeldeten; keine Personendaten). */
export async function roomDirectory(db: Db, q?: string, limit = 500) {
  const term = q?.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db
    .select({ id: rooms.id, name: rooms.name, kind: rooms.kind, building: rooms.building, floor: rooms.floor, capacity: rooms.capacity, accessible: rooms.accessible })
    .from(rooms)
    .where(and(eq(rooms.active, true), like ? or(sql`${rooms.id} ilike ${like}`, sql`${rooms.name} ilike ${like}`) : undefined));
  // Sortierung in JS (Gebäude, dann Kürzel numerisch) – nicht von der Collation abhängig
  return rows
    .sort((a, b) => (a.building ?? "").localeCompare(b.building ?? "", "de") || a.id.localeCompare(b.id, "de", { numeric: true }))
    .slice(0, limit);
}
