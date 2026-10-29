// Raumsteckbrief: Sicht und Pflegerechte (RS-02…RS-06) – eigene Datei, damit Steckbrief, Fotos, Ausstattung und die
// Raumsuche im Stundenplan sie ohne Ringabhängigkeit nutzen.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { ROOM_INFO_VISIBILITIES, roomResponsibles, type RoomInfoVisibility } from "@/core/db/schema";
import { accessBlocked, hasPermission, type PermissionSet } from "@/core/permissions";
import { isStaffRole } from "@/core/roles";

export type RoomAudience = "personal" | "familie";

/** RS-06: Recht „Raumdaten pflegen“ – Infofelder, Fotos, Ausstattung und Verantwortliche aller Räume, keine Stammdaten. */
export const ROOM_DATA_PERMISSION = "verwaltung.rooms_info";

/** Beschäftigte (STAFF_ROLES) sehen den Steckbrief mit Details, Schüler:innen und Eltern die gefilterte Fassung. */
export function roomAudience(viewer: PermissionSet): RoomAudience {
  return isStaffRole(viewer.role) ? "personal" : "familie";
}

/** Sichtbarkeiten, die eine Sicht lesen darf. */
export function visibleFor(audience: RoomAudience): readonly RoomInfoVisibility[] {
  return audience === "personal" ? ROOM_INFO_VISIBILITIES : ["alle"];
}

/**
 * Raumdaten aller Räume pflegen (Infofelder, Fotos, Ausstattung) und Raumverantwortliche eintragen: Recht „Raumdaten pflegen“
 * oder das Stammdaten-Recht `verwaltung.school` (das die Raumdaten seit RS-03 schon umfasst).
 */
export function canMaintainAllRooms(viewer: PermissionSet): boolean {
  return hasPermission(viewer, ROOM_DATA_PERMISSION) || hasPermission(viewer, "verwaltung.school");
}

/** Ist das Konto selbst oder über eine seiner Gruppen für den Raum verantwortlich? (ohne Rechteprüfung) */
export async function isRoomResponsible(db: Db, viewer: PermissionSet, roomId: string): Promise<boolean> {
  const groupIds = [...viewer.memberOf];
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(roomResponsibles)
    .where(
      and(
        eq(roomResponsibles.roomId, roomId),
        groupIds.length ? or(eq(roomResponsibles.userId, viewer.userId), inArray(roomResponsibles.groupId, groupIds)) : eq(roomResponsibles.userId, viewer.userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Wer Raumdaten eines Raums pflegt (Infofelder, Fotos, Ausstattung): Recht „Raumdaten pflegen“ bzw. `verwaltung.school` für
 * alle Räume, dazu Raumverantwortliche (Person oder Mitglied der Gruppe) für ihren eigenen Raum – nur Beschäftigte und nur
 * ohne Sperre (gesperrt, Startpasswort, 2FA offen). Planungsrelevante Stammdaten (Name, Art, Plätze, Sperren) bleiben bei
 * `verwaltung.school` und hängen nicht an dieser Funktion.
 */
export async function canEditRoomInfo(db: Db, viewer: PermissionSet, roomId: string): Promise<boolean> {
  if (roomId === "") return false;
  if (canMaintainAllRooms(viewer)) return true;
  if (accessBlocked(viewer) || !isStaffRole(viewer.role)) return false;
  return isRoomResponsible(db, viewer, roomId);
}

/** Schulweite Einstellungen des Steckbriefs (Infofelder anlegen, Ausstattungskatalog umbenennen/zusammenführen): Stammdaten-Recht. */
export function canManageInfoFields(viewer: PermissionSet): boolean {
  return hasPermission(viewer, "verwaltung.school");
}
