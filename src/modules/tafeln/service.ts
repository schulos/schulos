// Tafeln (P3-12): eine Tafel ist eine Datei „*.excalidraw“ im Gruppenordner (Modul Dateien, Tabelle `file_nodes`) – keine
// eigene Tabelle. Zugriff wie beim Gruppenordner: Mitglieder der Gruppe mit aktivem Merkmal „Gruppenordner“ öffnen und
// zeichnen; archivierte Gruppe nur lesen. Umbenennen/Löschen läuft über Dateien (dort: Ersteller:in, Leitung, Personal).
// Der Inhalt selbst läuft über live.ts.
import { and, eq, ilike, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { fileNodes, groupFeatures, groups } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import type { FileStorage } from "@/core/files/storage";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { cleanName, GROUP_FOLDER_FEATURE, uploadFile } from "@/modules/dateien/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { BOARD_EXT, boardFileName, boardTitle, isBoardName, serializeScene } from "./scene";

export const BOARD_MIME = "application/vnd.excalidraw+json";

export interface BoardAccess {
  id: string;
  name: string;
  title: string;
  groupId: string;
  groupName: string;
  archived: boolean;
  canWrite: boolean;
}

/** Zugriff auf eine Tafel oder null (keine Tafel, kein Mitglied, Gruppenordner aus). */
export async function boardAccess(db: Db, viewer: PermissionSet, id: string): Promise<BoardAccess | null> {
  const [row] = await db
    .select({ id: fileNodes.id, name: fileNodes.name, kind: fileNodes.kind, groupId: fileNodes.groupId, groupName: groups.name, archivedAt: groups.archivedAt, feature: groupFeatures.feature })
    .from(fileNodes)
    .innerJoin(groups, eq(groups.id, fileNodes.groupId))
    .leftJoin(groupFeatures, and(eq(groupFeatures.groupId, fileNodes.groupId), eq(groupFeatures.feature, GROUP_FOLDER_FEATURE)))
    .where(eq(fileNodes.id, id));
  if (!row || row.kind !== "file" || !row.groupId || !row.feature || !isBoardName(row.name) || !viewer.memberOf.has(row.groupId)) return null;
  const archived = !!row.archivedAt;
  return { id: row.id, name: row.name, title: boardTitle(row.name), groupId: row.groupId, groupName: row.groupName, archived, canWrite: !archived };
}

/** Gruppen, in denen der Betrachter eine Tafel anlegen kann: Mitglied, Gruppenordner aktiv, nicht archiviert. */
export async function boardGroups(db: Db, viewer: PermissionSet) {
  if (viewer.memberOf.size === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, GROUP_FOLDER_FEATURE)))
    .where(and(inArray(groups.id, [...viewer.memberOf]), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
}

/** Alle Tafeln aus den Gruppenordnern des Betrachters (auch in Unterordnern). */
export async function listBoards(db: Db, viewer: PermissionSet) {
  if (viewer.memberOf.size === 0) return [];
  const rows = await db
    .select({ id: fileNodes.id, name: fileNodes.name, groupId: fileNodes.groupId, groupName: groups.name, updatedAt: fileNodes.updatedAt })
    .from(fileNodes)
    .innerJoin(groups, eq(groups.id, fileNodes.groupId))
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, fileNodes.groupId), eq(groupFeatures.feature, GROUP_FOLDER_FEATURE)))
    .where(and(inArray(fileNodes.groupId, [...viewer.memberOf]), eq(fileNodes.kind, "file"), ilike(fileNodes.name, `%${BOARD_EXT}`)))
    .orderBy(de(groups.name), de(fileNodes.name));
  return rows.filter((r) => isBoardName(r.name)).map((r) => ({ ...r, title: boardTitle(r.name) }));
}

/** Neue, leere Tafel im Hauptordner der Gruppe (gleicher Name vorhanden → „Name (2).excalidraw“). */
export async function createBoard(db: Db, storage: FileStorage, viewer: PermissionSet, input: { title: string; groupId: string }): Promise<string> {
  if (!(await boardGroups(db, viewer)).some((g) => g.id === input.groupId)) throw new ForbiddenError("tafeln.create");
  const title = input.title.trim();
  if (!title.replace(/\.excalidraw$/i, "").trim()) throw new ValidationError({ title: "Titel fehlt" });
  if (title.length > 100) throw new ValidationError({ title: "Höchstens 100 Zeichen" });
  const name = cleanName(boardFileName(title));
  const data = new TextEncoder().encode(serializeScene([]));
  const node = await uploadFile(db, storage, viewer, `group:${input.groupId}`, null, { name, type: BOARD_MIME, data });
  return node.id;
}
