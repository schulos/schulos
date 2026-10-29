// Anhänge der Handbuchseiten (HB-05, docs/HANDBUCH.md): PDF, Bilder (JPEG/PNG/WebP, Metadaten werden entfernt) und Office-Dateien
// (Word/Excel/PowerPoint sowie OpenDocument). Typ an den ersten Bytes geprüft und zur Endung passend, höchstens 10 Anhänge je Seite
// und 20 MB je Datei, Virenscan vor dem Speichern. Sichtbar ist ein Anhang genau für die, die die Seite sehen; anhängen darf, wer die
// Seite bearbeiten darf (Pflegende, Ansprechperson). Dateien liegen im Dateispeicher (STORAGE_KEY_COLUMNS, Auskunft EXPORT_FILES).
import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { hilfeAttachments, hilfePages } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { cleanImage, sniffImage, type ImageRules } from "@/core/images";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { scanUpload } from "@/modules/upload-scan";
import { ValidationError } from "@/modules/verwaltung/users";
import { canEditPage, EDIT, pageVisibility } from "./service";

export const ATTACHMENTS_MAX = 10;
export const ATTACHMENT_MAX_MB = 20;

const PDF = "application/pdf";
const ZIP_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};
const OLE_TYPES: Record<string, string> = { doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint" };
const IMAGE_EXT: Record<string, string[]> = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] };

/** Anzeige der erlaubten Formate (Formular, Fehlermeldung). */
export const ATTACHMENT_FORMATS = "PDF, JPEG, PNG, WebP, Word, Excel, PowerPoint, OpenDocument";
/** `accept` für das Dateifeld. */
export const ATTACHMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp";

/** Typen, die der Browser direkt anzeigen darf – alles andere wird nur heruntergeladen. */
export const INLINE_MIMES = new Set([PDF, "image/jpeg", "image/png", "image/webp"]);

const IMAGE_RULES: ImageRules = {
  field: "file",
  maxBytes: ATTACHMENT_MAX_MB * 1024 * 1024,
  types: ["image/jpeg", "image/png", "image/webp"],
  empty: "Bitte eine Datei auswählen",
  tooBig: `Die Datei ist zu groß (höchstens ${ATTACHMENT_MAX_MB} MB)`,
  wrongType: `Dateityp nicht erlaubt (${ATTACHMENT_FORMATS})`,
};

/** Rein: Dateiname ohne Pfad- und Steuerzeichen, höchstens 120 Zeichen. */
export function cleanName(raw: string): string {
  return (
    raw
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || "Datei"
  );
}

const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const startsWith = (b: Uint8Array, sig: number[]) => b.length > sig.length && sig.every((x, i) => b[i] === x);

/**
 * Rein: prüft eine Datei und liefert die zu speichernden Bytes (Bilder ohne Metadaten) samt Typ.
 * Geprüft wird an den ersten Bytes, nicht am Browser-Typ; die Endung muss dazu passen (kein „bild.png“ mit PDF-Inhalt).
 */
export function checkAttachment(name: string, bytes: Uint8Array): { data: Uint8Array; mime: string } {
  const fail = (msg: string): never => {
    throw new ValidationError({ file: msg });
  };
  if (!bytes.length) fail("Bitte eine Datei auswählen");
  if (bytes.length > ATTACHMENT_MAX_MB * 1024 * 1024) fail(IMAGE_RULES.tooBig);
  const ext = extOf(name);
  const wrong = () => fail(`Dateityp nicht erlaubt (${ATTACHMENT_FORMATS}) oder Endung passt nicht zum Inhalt`);
  const image = sniffImage(bytes);
  if (image) {
    if (!IMAGE_EXT[image]!.includes(ext)) wrong();
    const clean = cleanImage(bytes, IMAGE_RULES);
    return { data: clean.data, mime: clean.mime };
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    if (ext !== "pdf") wrong();
    return { data: bytes, mime: PDF };
  }
  // OOXML und OpenDocument sind ZIP-Container
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && Object.hasOwn(ZIP_TYPES, ext)) return { data: bytes, mime: ZIP_TYPES[ext]! };
  // alte Office-Formate (OLE2)
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && Object.hasOwn(OLE_TYPES, ext)) return { data: bytes, mime: OLE_TYPES[ext]! };
  return wrong();
}

export interface AttachmentItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
}

/** Anhänge einer Seite – nur, wenn der Betrachter die Seite sehen darf (sonst leer). */
export async function listAttachments(db: Db, viewer: PermissionSet, pageId: string): Promise<AttachmentItem[]> {
  return db
    .select({ id: hilfeAttachments.id, name: hilfeAttachments.name, mime: hilfeAttachments.mime, size: hilfeAttachments.size, createdAt: hilfeAttachments.createdAt })
    .from(hilfeAttachments)
    .innerJoin(hilfePages, eq(hilfePages.id, hilfeAttachments.pageId))
    .where(and(eq(hilfeAttachments.pageId, pageId), await pageVisibility(db, viewer)))
    .orderBy(asc(hilfeAttachments.createdAt), asc(hilfeAttachments.name));
}

/**
 * Hängt eine Datei an eine Seite: prüfen (Typ, Größe, Virenscan), speichern. Höchstens 10 je Seite – auch bei parallelen Uploads
 * (Sperre je Seite). Gibt die Id des Anhangs zurück.
 */
export async function addAttachment(db: Db, storage: FileStorage, actor: PermissionSet, pageId: string, file: { name: string; data: Uint8Array }): Promise<string> {
  const [page] = await db.select({ id: hilfePages.id, contactId: hilfePages.contactId }).from(hilfePages).where(eq(hilfePages.id, pageId));
  if (!page || !canEditPage(actor, page)) throw new ForbiddenError(EDIT);
  const name = cleanName(file.name);
  const checked = checkAttachment(name, file.data);
  await scanUpload(checked.data, name, "file");
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hilfe:anhang:${pageId}`}))`);
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(hilfeAttachments).where(eq(hilfeAttachments.pageId, pageId));
    if (Number(n) >= ATTACHMENTS_MAX) throw new ValidationError({ file: `Höchstens ${ATTACHMENTS_MAX} Anhänge je Seite – erst einen löschen` });
    // Datei zuerst; bricht danach etwas ab, räumt der Dateispeicher-Lauf sie weg (sweepOrphanFiles)
    const key = newStorageKey();
    await storage.put(key, checked.data);
    const [row] = await tx
      .insert(hilfeAttachments)
      .values({ pageId, storageKey: key, name, mime: checked.mime, size: checked.data.length, uploadedBy: actor.userId })
      .returning({ id: hilfeAttachments.id });
    await audit(tx, actor.userId, "hilfe.attachment.add", pageId, { attachment: row!.id });
    return row!.id;
  });
}

/** Löscht einen Anhang samt Datei (wer die Seite bearbeiten darf). Gibt die Adresse der Seite zurück. */
export async function deleteAttachment(db: Db, storage: FileStorage, actor: PermissionSet, attachmentId: string): Promise<string> {
  const [a] = await db
    .select({ id: hilfeAttachments.id, key: hilfeAttachments.storageKey, pageId: hilfeAttachments.pageId, slug: hilfePages.slug, contactId: hilfePages.contactId })
    .from(hilfeAttachments)
    .innerJoin(hilfePages, eq(hilfePages.id, hilfeAttachments.pageId))
    .where(eq(hilfeAttachments.id, attachmentId));
  if (!a || !canEditPage(actor, a)) throw new ForbiddenError(EDIT);
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.delete(hilfeAttachments).where(eq(hilfeAttachments.id, attachmentId));
    await audit(tx, actor.userId, "hilfe.attachment.delete", a.pageId, { attachment: attachmentId });
  });
  await storage.delete(a.key).catch(() => {});
  return a.slug;
}

/**
 * Anhang für die Auslieferung (Route /api/hilfe/anhang/[id]): null = nicht vorhanden oder die Seite ist für den Betrachter
 * nicht sichtbar (die Route antwortet dann einheitlich 404).
 */
export async function attachmentFile(db: Db, viewer: PermissionSet, attachmentId: string): Promise<{ key: string; name: string; mime: string; size: number } | null> {
  const [a] = await db
    .select({ key: hilfeAttachments.storageKey, name: hilfeAttachments.name, mime: hilfeAttachments.mime, size: hilfeAttachments.size })
    .from(hilfeAttachments)
    .innerJoin(hilfePages, eq(hilfePages.id, hilfeAttachments.pageId))
    .where(and(eq(hilfeAttachments.id, attachmentId), await pageVisibility(db, viewer)));
  return a ?? null;
}

