// Texte (P3-11): je Gruppe (Gruppenmerkmal „texte.doc“), gemeinsam bearbeitet. Zugriff nur für Mitglieder der Gruppe;
// anlegen, umbenennen, löschen und den Schreibmodus setzen darf die Leitung (Gruppenleitung bzw. Personal in der Gruppe).
// Der Inhalt selbst läuft über live.ts (Yjs); hier stehen Rechte und Metadaten.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupFeatures, groups, TEXT_MODES, textDocs, type TextMode } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { forgetDoc, notifyDoc, withDoc } from "./live";
import { docToMarkdown } from "./markdown";

export const TEXT_FEATURE = "texte.doc";
const STAFF = ["lehrkraft", "verwaltung", "admin"];
export const MODE_LABELS: Record<TextMode, string> = { alle: "Alle schreiben", leitung: "Nur Leitung schreibt, alle lesen" };

export type TextRole = "leader" | "member";

export interface DocAccess {
  doc: typeof textDocs.$inferSelect;
  role: TextRole;
  /** archivierte Gruppe: nur lesen; Modus „leitung“: nur die Leitung schreibt */
  canWrite: boolean;
  groupName: string;
  archived: boolean;
}

/** Zugriff des Betrachters auf einen Text oder null (kein Mitglied, Merkmal aus, Text unbekannt). */
export async function docAccess(db: Db, viewer: PermissionSet, id: string): Promise<DocAccess | null> {
  const [row] = await db
    .select({ doc: textDocs, groupName: groups.name, archivedAt: groups.archivedAt, feature: groupFeatures.feature })
    .from(textDocs)
    .innerJoin(groups, eq(groups.id, textDocs.groupId))
    .leftJoin(groupFeatures, and(eq(groupFeatures.groupId, textDocs.groupId), eq(groupFeatures.feature, TEXT_FEATURE)))
    .where(eq(textDocs.id, id));
  if (!row || !row.feature || !viewer.memberOf.has(row.doc.groupId)) return null;
  const role: TextRole = viewer.leaderOf.has(row.doc.groupId) || STAFF.includes(viewer.role) ? "leader" : "member";
  const archived = !!row.archivedAt;
  return { doc: row.doc, role, canWrite: !archived && (row.doc.mode === "alle" || role === "leader"), groupName: row.groupName, archived };
}

async function requireLeader(db: Db, viewer: PermissionSet, id: string): Promise<DocAccess> {
  const a = await docAccess(db, viewer, id);
  if (!a || a.role !== "leader") throw new ForbiddenError("texte.manage");
  return a;
}

/** Gruppen, in denen der Betrachter Texte anlegen darf: Leitung bzw. Personal, Merkmal aktiv, nicht archiviert. */
export async function docGroups(db: Db, viewer: PermissionSet) {
  const ids = STAFF.includes(viewer.role) ? [...viewer.memberOf] : [...viewer.leaderOf];
  if (ids.length === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, TEXT_FEATURE)))
    .where(and(inArray(groups.id, ids), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
}

/** Texte aller Gruppen des Betrachters mit aktivem Merkmal. */
export async function listDocs(db: Db, viewer: PermissionSet) {
  if (viewer.memberOf.size === 0) return [];
  return db
    .select({ id: textDocs.id, title: textDocs.title, mode: textDocs.mode, groupId: textDocs.groupId, groupName: groups.name, updatedAt: textDocs.updatedAt })
    .from(textDocs)
    .innerJoin(groups, eq(groups.id, textDocs.groupId))
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, textDocs.groupId), eq(groupFeatures.feature, TEXT_FEATURE)))
    .where(inArray(textDocs.groupId, [...viewer.memberOf]))
    .orderBy(de(groups.name), de(textDocs.title));
}

function checkTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new ValidationError({ title: "Titel fehlt" });
  if (t.length > 120) throw new ValidationError({ title: "Höchstens 120 Zeichen" });
  return t;
}

function checkMode(mode: string): TextMode {
  if (!(TEXT_MODES as readonly string[]).includes(mode)) throw new ValidationError({ mode: "Unbekannter Modus" });
  return mode as TextMode;
}

/** Neuer, leerer Text in einer Gruppe (Leitung/Personal der Gruppe). */
export async function createDoc(db: Db, viewer: PermissionSet, input: { title: string; mode: string; groupId: string }, now = new Date()): Promise<string> {
  if (!(await docGroups(db, viewer)).some((g) => g.id === input.groupId)) throw new ForbiddenError("texte.manage");
  const title = checkTitle(input.title);
  const mode = checkMode(input.mode);
  const [d] = await db.insert(textDocs).values({ groupId: input.groupId, ownerId: viewer.userId, title, mode, createdAt: now, updatedAt: now }).returning({ id: textDocs.id });
  return d!.id;
}

/** Titel und Schreibmodus ändern (Leitung); die Anwesenden erfahren es live. */
export async function updateDoc(db: Db, viewer: PermissionSet, id: string, input: { title: string; mode: string }, now = new Date()): Promise<void> {
  await requireLeader(db, viewer, id);
  const title = checkTitle(input.title);
  const mode = checkMode(input.mode);
  await db.update(textDocs).set({ title, mode, updatedAt: now }).where(eq(textDocs.id, id));
  await notifyDoc(db, id, { title });
}

/** Text löschen (Leitung) – erst aus dem Speicher nehmen, damit kein verzögertes Speichern ihn wieder anlegt. */
export async function deleteDoc(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  await requireLeader(db, viewer, id);
  await notifyDoc(db, id, { removed: true });
  forgetDoc(id);
  await db.delete(textDocs).where(eq(textDocs.id, id));
}

/** Markdown-Export für Mitglieder. */
export async function exportMarkdown(db: Db, viewer: PermissionSet, id: string): Promise<{ title: string; markdown: string } | null> {
  const a = await docAccess(db, viewer, id);
  if (!a) return null;
  const markdown = await withDoc(db, id, docToMarkdown);
  return { title: a.doc.title, markdown: markdown ?? "" };
}

/** Dateiname für den Download: Titel ohne Sonderzeichen. */
export function exportFilename(title: string): string {
  const base = title
    .replace(/[äÄ]/g, (c) => (c === "ä" ? "ae" : "Ae"))
    .replace(/[öÖ]/g, (c) => (c === "ö" ? "oe" : "Oe"))
    .replace(/[üÜ]/g, (c) => (c === "ü" ? "ue" : "Ue"))
    .replace(/ß/g, "ss")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || "text"}.md`;
}
