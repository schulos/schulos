// Dateien: persönlicher Bereich + Gruppenordner (Gruppenmerkmal).
import { and, asc, eq, inArray, isNull, sql, sum } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { fileNodes, groupFeatures, groups } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import type { PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { scanUpload } from "@/modules/upload-scan";
import { de } from "@/core/db/sort";

export const GROUP_FOLDER_FEATURE = "dateien.gruppenordner";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const QUOTA = { personal: 200 * 1024 * 1024, group: 1024 * 1024 * 1024 };
const STAFF = ["lehrkraft", "verwaltung", "admin"];

export type SpaceKey = "personal" | `group:${string}`;
type Space = { kind: "personal"; userId: string } | { kind: "group"; groupId: string };

export function parseSpace(viewer: PermissionSet, key: string): Space | null {
  if (key === "personal") return { kind: "personal", userId: viewer.userId };
  const m = key.match(/^group:([\w-]+)$/);
  return m ? { kind: "group", groupId: m[1]! } : null;
}

const spaceCond = (s: Space) => (s.kind === "personal" ? and(eq(fileNodes.ownerId, s.userId), isNull(fileNodes.groupId)) : eq(fileNodes.groupId, s.groupId));
const spaceValues = (s: Space) => (s.kind === "personal" ? { ownerId: s.userId, groupId: null } : { ownerId: null, groupId: s.groupId });

/** Gruppenordner, die der Betrachter nutzen darf (Mitglied + Merkmal aktiv). */
export async function groupFolders(db: Db, viewer: PermissionSet) {
  if (viewer.memberOf.size === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, GROUP_FOLDER_FEATURE)))
    .where(inArray(groups.id, [...viewer.memberOf]))
    .orderBy(de(groups.name));
}

async function canUse(db: Db, viewer: PermissionSet, s: Space): Promise<boolean> {
  if (s.kind === "personal") return s.userId === viewer.userId;
  if (!viewer.memberOf.has(s.groupId)) return false;
  const [f] = await db.select().from(groupFeatures).where(and(eq(groupFeatures.groupId, s.groupId), eq(groupFeatures.feature, GROUP_FOLDER_FEATURE)));
  return !!f;
}

/** Fremde Einträge im Gruppenordner löschen/umbenennen: Leitung oder Personal. */
function canModify(viewer: PermissionSet, s: Space, node: { createdBy: string | null }) {
  if (s.kind === "personal") return true;
  return node.createdBy === viewer.userId || viewer.leaderOf.has(s.groupId) || STAFF.includes(viewer.role);
}

async function requireSpace(db: Db, viewer: PermissionSet, key: string): Promise<Space> {
  const s = parseSpace(viewer, key);
  if (!s || !(await canUse(db, viewer, s))) throw new ValidationError({ space: "Kein Zugriff auf diesen Bereich" });
  return s;
}

export function cleanName(raw: string): string {
  const name = raw.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name || name === "." || name === "..") throw new ValidationError({ name: "Ungültiger Name" });
  return name;
}

async function nodeIn(db: Db, s: Space, id: string | null, kind?: "folder" | "file") {
  if (id === null) return null;
  const [n] = await db.select().from(fileNodes).where(and(eq(fileNodes.id, id), spaceCond(s)));
  if (!n || (kind && n.kind !== kind)) throw new ValidationError({ parent: "Ordner nicht gefunden" });
  return n;
}

async function siblingNames(db: Db, s: Space, parentId: string | null, exceptId?: string) {
  const rows = await db
    .select({ id: fileNodes.id, name: fileNodes.name })
    .from(fileNodes)
    .where(and(spaceCond(s), parentId ? eq(fileNodes.parentId, parentId) : isNull(fileNodes.parentId)));
  return new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase()));
}

/** „Bericht.pdf" → „Bericht (2).pdf", falls schon vorhanden */
function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export async function usage(db: Db, s: Space): Promise<number> {
  const [r] = await db.select({ total: sum(fileNodes.size) }).from(fileNodes).where(spaceCond(s));
  return Number(r?.total ?? 0);
}

export async function listFolder(db: Db, viewer: PermissionSet, key: string, folderId: string | null) {
  const s = await requireSpace(db, viewer, key);
  const folder = await nodeIn(db, s, folderId, "folder");
  // Brotkrumen über rekursive CTE nach oben
  const crumbs: { id: string; name: string }[] = [];
  if (folder) {
    const rows = await db.execute<{ id: string; name: string; depth: number }>(sql`
      with recursive up(id, name, parent_id, depth) as (
        select id, name, parent_id, 0 from file_nodes where id = ${folder.id}
        union all
        select f.id, f.name, f.parent_id, up.depth + 1 from file_nodes f join up on f.id = up.parent_id
      ) select id, name, depth from up order by depth desc`);
    crumbs.push(...rowsOf<{ id: string; name: string }>(rows).map((r) => ({ id: r.id, name: r.name })));
  }
  const items = await db
    .select({ id: fileNodes.id, kind: fileNodes.kind, name: fileNodes.name, size: fileNodes.size, mime: fileNodes.mime, createdBy: fileNodes.createdBy, updatedAt: fileNodes.updatedAt })
    .from(fileNodes)
    .where(and(spaceCond(s), folder ? eq(fileNodes.parentId, folder.id) : isNull(fileNodes.parentId)))
    // Ordner zuerst: Postgres sortiert Enums nach Deklaration (folder < file)
    .orderBy(asc(fileNodes.kind), asc(sql`lower(${fileNodes.name})`));
  const used = await usage(db, s);
  return {
    space: s,
    crumbs,
    items: items.map((i) => ({ ...i, canModify: canModify(viewer, s, i) })),
    used,
    quota: QUOTA[s.kind],
  };
}

export async function createFolder(db: Db, viewer: PermissionSet, key: string, parentId: string | null, rawName: string): Promise<string> {
  const s = await requireSpace(db, viewer, key);
  await nodeIn(db, s, parentId, "folder");
  const name = cleanName(rawName);
  if ((await siblingNames(db, s, parentId)).has(name.toLowerCase())) throw new ValidationError({ name: "Name existiert bereits" });
  const [n] = await db.insert(fileNodes).values({ kind: "folder", name, parentId, createdBy: viewer.userId, ...spaceValues(s) }).returning({ id: fileNodes.id });
  return n!.id;
}

export interface UploadInput {
  name: string;
  type: string;
  data: Uint8Array;
}

export async function uploadFile(db: Db, storage: FileStorage, viewer: PermissionSet, key: string, parentId: string | null, f: UploadInput) {
  const s = await requireSpace(db, viewer, key);
  await nodeIn(db, s, parentId, "folder");
  if (f.data.byteLength > MAX_FILE_BYTES) throw new ValidationError({ file: `„${f.name}“ ist größer als 25 MB` });
  const noSpace = () => new ValidationError({ file: "Speicherplatz reicht nicht aus" });
  if ((await usage(db, s)) + f.data.byteLength > QUOTA[s.kind]) throw noSpace(); // früh ablehnen, bevor geschrieben wird
  const storageKey = newStorageKey();
  await scanUpload(f.data, f.name, "file"); // P4-72
  await storage.put(storageKey, f.data);
  try {
    // SEC-05: Prüfen und Eintragen atomar – parallele Uploads in denselben Bereich warten auf die Sperre und sehen
    // den neuen Stand (sonst bestehen 100 gleichzeitige Uploads alle dieselbe Kontingent-Prüfung).
    return await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const lock = s.kind === "personal" ? `dateien:user:${s.userId}` : `dateien:group:${s.groupId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
      if ((await usage(tx, s)) + f.data.byteLength > QUOTA[s.kind]) throw noSpace();
      const name = uniqueName(cleanName(f.name), await siblingNames(tx, s, parentId));
      const [n] = await tx
        .insert(fileNodes)
        .values({ kind: "file", name, parentId, size: f.data.byteLength, mime: f.type || "application/octet-stream", storageKey, createdBy: viewer.userId, ...spaceValues(s) })
        .returning({ id: fileNodes.id, name: fileNodes.name });
      return n!;
    });
  } catch (err) {
    await storage.delete(storageKey);
    throw err;
  }
}

export async function renameNode(db: Db, viewer: PermissionSet, key: string, id: string, rawName: string) {
  const s = await requireSpace(db, viewer, key);
  const node = (await nodeIn(db, s, id))!;
  if (!canModify(viewer, s, node)) throw new ValidationError({ name: "Keine Berechtigung" });
  const name = cleanName(rawName);
  if ((await siblingNames(db, s, node.parentId, id)).has(name.toLowerCase())) throw new ValidationError({ name: "Name existiert bereits" });
  await db.update(fileNodes).set({ name }).where(eq(fileNodes.id, id));
}

/** Löscht Datei oder Ordner samt Inhalt (DB per Cascade, Speicher explizit). */
export async function deleteNode(db: Db, storage: FileStorage, viewer: PermissionSet, key: string, id: string) {
  const s = await requireSpace(db, viewer, key);
  const node = (await nodeIn(db, s, id))!;
  if (!canModify(viewer, s, node)) throw new ValidationError({ name: "Keine Berechtigung" });
  // Löschen und Schlüssel lesen in einer Anweisung (P312-08): stellt eine Tafel (tafeln/live.ts) zwischendurch ihre Zeile
  // auf eine neue Fassung um, liefert RETURNING den neuen Schlüssel – sonst bliebe genau diese Fassung verwaist im Speicher.
  const res = await db.execute<{ storage_key: string | null }>(sql`
    with recursive down(id) as (
      select id from file_nodes where id = ${id}
      union all
      select f.id from file_nodes f join down on f.parent_id = down.id
    ) delete from file_nodes where id in (select id from down) returning storage_key`);
  const keys = rowsOf<{ storage_key: string | null }>(res).flatMap((r) => (r.storage_key ? [r.storage_key] : []));
  await Promise.all(keys.map((k) => storage.delete(k)));
  return keys.length;
}

/** Datei für den Download – nur wenn der Betrachter den Bereich nutzen darf. */
export async function getDownload(db: Db, viewer: PermissionSet, id: string) {
  const [n] = await db.select().from(fileNodes).where(and(eq(fileNodes.id, id), eq(fileNodes.kind, "file")));
  if (!n) return null;
  const s: Space = n.groupId ? { kind: "group", groupId: n.groupId } : { kind: "personal", userId: n.ownerId! };
  if (!(await canUse(db, viewer, s))) return null;
  return n;
}
