// Raumsteckbrief: Sicht und Pflegerechte (RS-02…RS-05) – eigene Datei, damit Steckbrief, Fotos, Ausstattung und die
// Raumsuche im Stundenplan sie ohne Ringabhängigkeit nutzen. RS-06 erweitert nur `canEditRoomInfo`.
import { ROOM_INFO_VISIBILITIES, type RoomInfoVisibility } from "@/core/db/schema";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { isStaffRole } from "@/core/roles";

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
 * Wer Raumdaten eines Raums pflegt (Infofelder, Fotos, Ausstattung). Bis RS-06 (Recht „Raumdaten pflegen“,
 * Raumverantwortliche pflegen ihren Raum) wer heute Räume bearbeiten darf: `verwaltung.school`. RS-06 erweitert nur diese
 * Funktion (der Raum ist schon Parameter).
 */
export function canEditRoomInfo(viewer: PermissionSet, roomId: string): boolean {
  return roomId !== "" && hasPermission(viewer, "verwaltung.school");
}

/** Schulweite Einstellungen des Steckbriefs (Infofelder anlegen, Ausstattungskatalog umbenennen/zusammenführen): Stammdaten-Recht. */
export function canManageInfoFields(viewer: PermissionSet): boolean {
  return hasPermission(viewer, "verwaltung.school");
}
