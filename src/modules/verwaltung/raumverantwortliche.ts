// RS-06 (docs/RAUMSTECKBRIEF.md): Raumverantwortliche und Änderungshistorie des Raumsteckbriefs.
// Verantwortlich ist eine Person (nur Beschäftigte) oder eine Gruppe (Fachschaft, Gremium, frei – gilt für ihre Beschäftigten).
// Verantwortliche pflegen Infofelder, Fotos und Ausstattung ihres Raums (`canEditRoomInfo`), nie die Stammdaten. Wer
// verantwortlich ist, sehen nur Beschäftigte. Eintragen und Entfernen: Recht „Raumdaten pflegen“ bzw. `verwaltung.school`.
// Personenbezug folgt dem Konto (LK-KONTO, Kaskade bei der Kontolöschung).
// Historie: aus dem Audit-Log (`verwaltung.room.*` mit Ziel = Raumkürzel) nur für Pflegende – Vorgang, wer, wann und welche
// Felder bzw. Ausstattung, nie die Texte der Infofelder (das Audit enthält sie gar nicht).
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { auditLog, groups, roomResponsibles, rooms, users, type GroupKind } from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { isPseudonym } from "@/core/privacy/protokoll";
import { STAFF_ROLES, isStaffRole } from "@/core/roles";
import { ACTION_LABELS } from "./audit-view";
import { ROOM_DATA_PERMISSION, canEditRoomInfo, canMaintainAllRooms, roomAudience } from "./raum-rechte";
import { ValidationError } from "./users";

export const RESPONSIBLES_MAX = 10;
export const RESPONSIBLE_NOTE_MAX = 120;
export const HISTORY_LIMIT = 30;

/** Gruppenarten, die verantwortlich sein können (keine Klassen, Kurse, AGs – dort sind Schüler:innen Mitglied). */
export const RESPONSIBLE_GROUP_KINDS: readonly GroupKind[] = ["fachschaft", "gremium", "frei"];

export interface RoomResponsible {
  id: string;
  kind: "person" | "gruppe";
  /** Konto bzw. Gruppe */
  refId: string;
  name: string;
  note: string | null;
  /** Konto aktiv bzw. Gruppe nicht archiviert – sonst nur in der Pflege sichtbar */
  active: boolean;
}

const byName = (a: { kind: string; name: string }, b: { kind: string; name: string }) => (a.kind === b.kind ? a.name.localeCompare(b.name, "de") : a.kind === "person" ? -1 : 1);

/** Alle Verantwortlichen eines Raums (Personen zuerst, dann Gruppen) – ohne Rechteprüfung, für Pflege und Steckbrief. */
export async function listResponsibles(db: Db, roomId: string): Promise<RoomResponsible[]> {
  const rows = await db
    .select({
      id: roomResponsibles.id,
      userId: roomResponsibles.userId,
      groupId: roomResponsibles.groupId,
      note: roomResponsibles.note,
      userName: users.name,
      userStatus: users.status,
      groupName: groups.name,
      groupArchived: groups.archivedAt,
    })
    .from(roomResponsibles)
    .leftJoin(users, eq(users.id, roomResponsibles.userId))
    .leftJoin(groups, eq(groups.id, roomResponsibles.groupId))
    .where(eq(roomResponsibles.roomId, roomId));
  return rows
    .map((r): RoomResponsible =>
      r.userId
        ? { id: r.id, kind: "person", refId: r.userId, name: r.userName ?? "", note: r.note, active: r.userStatus === "active" }
        : { id: r.id, kind: "gruppe", refId: r.groupId!, name: r.groupName ?? "", note: r.note, active: r.groupArchived === null },
    )
    .sort(byName);
}

/** Verantwortliche für den Steckbrief: nur Beschäftigte sehen sie (sonst null), nur aktive Konten und Gruppen. */
export async function responsiblesFor(db: Db, viewer: PermissionSet, roomId: string): Promise<RoomResponsible[] | null> {
  if (roomAudience(viewer) !== "personal") return null;
  return (await listResponsibles(db, roomId)).filter((r) => r.active);
}

/** Auswahl für das Eintragen: aktive Beschäftigte und Gruppen der zulässigen Arten (nicht archiviert). */
export async function responsibleCandidates(db: Db) {
  const [people, teams] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, shortCode: users.shortCode })
      .from(users)
      .where(and(eq(users.status, "active"), inArray(users.role, [...STAFF_ROLES]))),
    db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(isNull(groups.archivedAt), inArray(groups.kind, [...RESPONSIBLE_GROUP_KINDS]))),
  ]);
  return {
    people: people.sort((a, b) => a.name.localeCompare(b.name, "de")),
    groups: teams.sort((a, b) => a.name.localeCompare(b.name, "de")),
  };
}

export interface ResponsibleInput {
  /** „u:<konto-id>“ oder „g:<gruppen-id>“ */
  target: string;
  note?: string | null;
}

/** Trägt eine Person oder Gruppe als verantwortlich ein (Recht „Raumdaten pflegen“ bzw. `verwaltung.school`). */
export async function addResponsible(db: Db, viewer: PermissionSet, roomId: string, input: ResponsibleInput): Promise<string> {
  if (!canMaintainAllRooms(viewer)) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ target: `Raum ${roomId} gibt es nicht` });
  const note = (input.note ?? "").trim().replace(/\s+/g, " ") || null;
  if (note && note.length > RESPONSIBLE_NOTE_MAX) throw new ValidationError({ note: `Hinweis höchstens ${RESPONSIBLE_NOTE_MAX} Zeichen` });
  const m = /^([ug]):(.+)$/.exec(input.target.trim());
  if (!m) throw new ValidationError({ target: "Person oder Gruppe wählen" });
  const [, kind, refId] = m as unknown as [string, "u" | "g", string];
  let values: typeof roomResponsibles.$inferInsert;
  if (kind === "u") {
    const [u] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, refId));
    if (!u || u.status !== "active") throw new ValidationError({ target: "Person gibt es nicht" });
    if (!isStaffRole(u.role)) throw new ValidationError({ target: "Raumverantwortliche können nur Beschäftigte sein" });
    values = { roomId, userId: u.id, note };
  } else {
    const [g] = await db.select({ id: groups.id, kind: groups.kind, archivedAt: groups.archivedAt }).from(groups).where(eq(groups.id, refId));
    if (!g || g.archivedAt) throw new ValidationError({ target: "Gruppe gibt es nicht" });
    if (!RESPONSIBLE_GROUP_KINDS.includes(g.kind)) throw new ValidationError({ target: "Nur Fachschaften, Gremien und freie Gruppen können verantwortlich sein" });
    values = { roomId, groupId: g.id, note };
  }
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`raum:verantwortliche:${roomId}`}))`);
    const existing = await tx.select({ userId: roomResponsibles.userId, groupId: roomResponsibles.groupId }).from(roomResponsibles).where(eq(roomResponsibles.roomId, roomId));
    if (existing.some((e) => (values.userId && e.userId === values.userId) || (values.groupId && e.groupId === values.groupId)))
      throw new ValidationError({ target: "Schon als verantwortlich eingetragen" });
    if (existing.length >= RESPONSIBLES_MAX) throw new ValidationError({ target: `Höchstens ${RESPONSIBLES_MAX} Verantwortliche je Raum` });
    const [row] = await tx.insert(roomResponsibles).values(values).returning({ id: roomResponsibles.id });
    await audit(tx, viewer.userId, "verwaltung.room.responsible.add", roomId, values.userId ? { userId: values.userId } : { groupId: values.groupId });
    return row!.id;
  });
}

/** Entfernt eine Zuordnung (Recht „Raumdaten pflegen“ bzw. `verwaltung.school`). */
export async function removeResponsible(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  if (!canMaintainAllRooms(viewer)) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  const [row] = await db.select().from(roomResponsibles).where(eq(roomResponsibles.id, id));
  if (!row) return;
  await db.delete(roomResponsibles).where(eq(roomResponsibles.id, id));
  await audit(db, viewer.userId, "verwaltung.room.responsible.remove", row.roomId, row.userId ? { userId: row.userId } : { groupId: row.groupId });
}

// ---------------------------------------------------------------- Historie

/** Vorgänge, die zur Historie eines Raums gehören (Ziel = Raumkürzel). Katalog- und Infofeld-Verwaltung zielen nicht auf einen Raum. */
export const HISTORY_ACTIONS = [
  "verwaltung.room.create",
  "verwaltung.room.update",
  "verwaltung.room.activate",
  "verwaltung.room.deactivate",
  "verwaltung.room.info",
  "verwaltung.room.photo.add",
  "verwaltung.room.photo.caption",
  "verwaltung.room.photo.cover",
  "verwaltung.room.photo.delete",
  "verwaltung.room.equipment",
  "verwaltung.room.responsible.add",
  "verwaltung.room.responsible.remove",
  "verwaltung.room.layout.create",
  "verwaltung.room.layout.update",
  "verwaltung.room.layout.default",
  "verwaltung.room.layout.delete",
] as const;

export interface RoomHistoryEntry {
  id: number;
  at: Date;
  label: string;
  /** Felder bzw. Ausstattung – nie die Texte der Infofelder */
  detail: string | null;
  actor: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Änderungen eines Raums aus dem Audit-Log, neueste zuerst – nur für Pflegende (`canEditRoomInfo`). Gibt nur Vorgang, wer, wann
 * und Feldnamen/Ausstattung aus; Zuordnungen nennen die Person bzw. Gruppe, solange das Audit nicht pseudonymisiert ist.
 */
export async function roomHistory(db: Db, viewer: PermissionSet, roomId: string, limit = HISTORY_LIMIT): Promise<RoomHistoryEntry[]> {
  if (!(await canEditRoomInfo(db, viewer, roomId))) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  const actor = alias(users, "actor");
  const rows = await db
    .select({ id: auditLog.id, at: auditLog.createdAt, action: auditLog.action, meta: auditLog.meta, actorName: actor.name, actorPseudonym: auditLog.actorPseudonym, actorId: auditLog.actorId })
    .from(auditLog)
    .leftJoin(actor, eq(actor.id, auditLog.actorId))
    .where(and(eq(auditLog.target, roomId), inArray(auditLog.action, [...HISTORY_ACTIONS])))
    .orderBy(desc(auditLog.id))
    .limit(limit);
  const metas = rows.map((r) => (r.meta ?? {}) as Record<string, unknown>);
  const userIds = metas.flatMap((m) => (typeof m.userId === "string" && !isPseudonym(m.userId) ? [m.userId] : []));
  const groupIds = metas.flatMap((m) => (typeof m.groupId === "string" ? [m.groupId] : []));
  const [people, teams] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    groupIds.length ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : [],
  ]);
  const names = new Map([...people, ...teams].map((x) => [x.id, x.name]));
  return rows.map((r, i) => {
    const m = metas[i]!;
    let detail: string | null = null;
    if (r.action === "verwaltung.room.info") detail = strings(m.fields).join(", ") || null;
    else if (r.action === "verwaltung.room.equipment")
      detail = typeof m.set === "string" ? `${m.set}: ${typeof m.quantityFrom === "number" ? `${m.quantityFrom} → ` : ""}${String(m.quantity ?? "")}` : strings(m.changed).join(", ") || null;
    else if (r.action.startsWith("verwaltung.room.responsible."))
      detail = typeof m.groupId === "string" ? (names.get(m.groupId) ?? "Gruppe") : typeof m.userId === "string" ? (names.get(m.userId) ?? "Person") : null;
    else if (r.action === "verwaltung.room.update" && typeof m.renamedFrom === "string") detail = `Kürzel vorher ${m.renamedFrom}`;
    else if (r.action.startsWith("verwaltung.room.layout.") && typeof m.name === "string")
      detail = [m.name, typeof m.renamedFrom === "string" && `vorher ${m.renamedFrom}`, typeof m.seats === "number" && `${m.seats} Plätze`].filter(Boolean).join(" · ");
    return {
      id: r.id,
      at: r.at,
      label: ACTION_LABELS[r.action] ?? r.action,
      detail,
      actor: r.actorName ?? (r.actorPseudonym ? `Pseudonym ${r.actorPseudonym}` : r.actorId ? "gelöschtes Konto" : "System"),
    };
  });
}
