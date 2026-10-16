// Elternbriefe: an Klassen/Kurse, Empfänger = Eltern der Schüler:innen, Lesebestätigung + Rückmeldung je Kind.
// Q5-05: Eigenständige (volljährige) Schüler:innen bekommen den Brief selbst und bestätigen selbst; ihre Eltern sehen ihn nur mit
// Einwilligung der Person („Eltern weiter informieren“) und bestätigen dann nicht.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groupMembers, groups, parentChild, parentLetterGroups, parentLetterReceipts, parentLetters, users } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { childrenOf as childrenOfParent, guardianRecipients, isSelfResponsible, type ParentMode } from "@/core/school/majority";
import { cleanName, MAX_FILE_BYTES } from "@/modules/dateien/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { LETTER_RESPONSES } from "./schema";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const REMIND_EVERY_MS = 12 * 60 * 60 * 1000;

export interface LetterInput {
  title: string;
  body: string;
  groupIds: string[];
  responseType: (typeof LETTER_RESPONSES)[number];
  question: string;
  dueDate: string | null;
  attachment?: { name: string; type: string; data: Uint8Array } | null;
}

/** Gruppen, an die der Betrachter schreiben darf: alle Klassen (send_all) bzw. eigene Klassen/Kurse/AGs. */
export async function sendableGroups(db: Db, viewer: PermissionSet) {
  if (!hasPermission(viewer, "elternbriefe.send")) return [];
  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel })
    .from(groups)
    .where(inArray(groups.kind, ["klasse", "kurs", "ag"]));
  const all = hasPermission(viewer, "elternbriefe.send_all");
  return rows
    .filter((g) => (all ? g.kind === "klasse" || viewer.memberOf.has(g.id) : viewer.memberOf.has(g.id)))
    .sort((a, b) => a.kind.localeCompare(b.kind) || (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.name.localeCompare(b.name, "de", { numeric: true }));
}

async function studentsOf(db: Db, groupIds: string[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, groupIds), eq(users.role, "schueler")));
  return rows.map((r) => r.id);
}


export async function createLetter(db: Db, storage: FileStorage, viewer: PermissionSet, input: LetterInput): Promise<string> {
  if (!hasPermission(viewer, "elternbriefe.send")) throw new ForbiddenError("elternbriefe.send");
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  if (!title) fe.title = "Betreff angeben";
  if (title.length > 150) fe.title = "Betreff bitte kürzer fassen";
  if (!input.body.trim()) fe.body = "Text angeben";
  const allowed = new Set((await sendableGroups(db, viewer)).map((g) => g.id));
  const groupIds = [...new Set(input.groupIds)];
  if (groupIds.length === 0) fe.groupIds = "Mindestens eine Klasse oder einen Kurs wählen";
  else if (groupIds.some((g) => !allowed.has(g))) fe.groupIds = "An diese Gruppe dürfen Sie keine Elternbriefe schicken";
  if (!LETTER_RESPONSES.includes(input.responseType)) fe.responseType = "Art der Rückmeldung wählen";
  if (input.responseType !== "none" && !input.question.trim()) fe.question = "Frage für die Rückmeldung angeben";
  if (input.dueDate !== null && !YMD.test(input.dueDate)) fe.dueDate = "Datum prüfen";
  if (input.attachment && input.attachment.data.byteLength > MAX_FILE_BYTES) fe.attachment = "Der Anhang ist größer als 25 MB";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const students = await studentsOf(db, groupIds);
  if (students.length === 0) throw new ValidationError({ groupIds: "In den gewählten Gruppen sind keine Schüler:innen" });

  let attachment = {};
  if (input.attachment && input.attachment.data.byteLength > 0) {
    const key = newStorageKey();
    await storage.put(key, input.attachment.data);
    attachment = {
      attachmentKey: key,
      attachmentName: cleanName(input.attachment.name),
      attachmentMime: input.attachment.type || "application/octet-stream",
      attachmentSize: input.attachment.data.byteLength,
    };
  }
  const [row] = await db
    .insert(parentLetters)
    .values({
      title,
      body: input.body.trim(),
      authorId: viewer.userId,
      responseType: input.responseType,
      question: input.responseType === "none" ? null : input.question.trim(),
      dueDate: input.dueDate,
      ...attachment,
    })
    .returning({ id: parentLetters.id });
  const id = row!.id;
  await db.insert(parentLetterGroups).values(groupIds.map((groupId) => ({ letterId: id, groupId })));
  await db.insert(parentLetterReceipts).values(students.map((studentId) => ({ letterId: id, studentId })));
  await audit(db, viewer.userId, "elternbriefe.send", id, { groups: groupIds.length, students: students.length });
  await notify(db, (await guardianRecipients(db, students, { withInformed: true })).filter((id) => id !== viewer.userId), { moduleId: "elternbriefe", title: `Elternbrief: ${title}`, body: input.responseType === "none" ? "Bitte Lesebestätigung geben" : "Bitte Rückmeldung geben", href: `/elternbriefe/${id}` });
  return id;
}

/** Verfasser:in oder „an alle“ darf Brief, Rückmeldungen und Erinnern sehen. */
function canManage(viewer: PermissionSet, letter: { authorId: string | null }): boolean {
  return letter.authorId === viewer.userId || hasPermission(viewer, "elternbriefe.send_all");
}

/**
 * Für wen der Betrachter Elternbriefe sieht (`inform`) bzw. bestätigt (`act`): Eltern – ihre Kinder (eigenständige nur mit deren
 * Einwilligung und nie zum Bestätigen); eigenständige Schüler:innen – sich selbst (Q5-05).
 */
async function childrenOf(db: Db, viewer: PermissionSet, mode: ParentMode): Promise<{ id: string; name: string }[]> {
  if (viewer.role === "eltern") return (await childrenOfParent(db, viewer.userId, mode)).map(({ id, name }) => ({ id, name }));
  if (viewer.role === "schueler" && (await isSelfResponsible(db, viewer.userId))) {
    return db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, viewer.userId));
  }
  return [];
}

export interface ReceiptRow {
  studentId: string;
  studentName: string;
  groupName: string | null;
  parents: string[];
  readAt: Date | null;
  confirmedAt: Date | null;
  confirmedByName: string | null;
  answerYes: boolean | null;
  answerText: string | null;
  /** Darf der Betrachter für diese Zeile bestätigen? (Eltern minderjähriger Kinder bzw. die eigenständige Person selbst) */
  canConfirm: boolean;
}

export interface LetterView {
  /** manage = Verfasser:in/„an alle“ (alle Zeilen, Erinnern), parent = nur die eigenen Kinder bzw. die eigenständige Person selbst */
  mode: "manage" | "parent";
  letter: typeof parentLetters.$inferSelect;
  groupNames: string[];
  receipts: ReceiptRow[];
}

/** Brief für den Betrachter – oder null, wenn er ihn nicht sehen darf. Eltern sehen nur die Zeilen ihrer Kinder. */
export async function letterFor(db: Db, viewer: PermissionSet, id: string): Promise<LetterView | null> {
  const [letter] = await db.select().from(parentLetters).where(eq(parentLetters.id, id));
  if (!letter) return null;
  let studentFilter: string[] | null = null;
  let mode: LetterView["mode"] = "manage";
  let acting = new Set<string>();
  if (!canManage(viewer, letter)) {
    studentFilter = (await childrenOf(db, viewer, "inform")).map((c) => c.id);
    if (studentFilter.length === 0) return null;
    acting = new Set((await childrenOf(db, viewer, "act")).map((c) => c.id));
    mode = "parent";
  }
  const rows = await db
    .select({ r: parentLetterReceipts, studentName: users.name })
    .from(parentLetterReceipts)
    .innerJoin(users, eq(users.id, parentLetterReceipts.studentId))
    .where(and(eq(parentLetterReceipts.letterId, id), studentFilter ? inArray(parentLetterReceipts.studentId, studentFilter) : undefined));
  if (mode === "parent" && rows.length === 0) return null;
  const studentIds = rows.map((r) => r.r.studentId);
  const confirmerIds = rows.map((r) => r.r.confirmedBy).filter((x): x is string => !!x);
  const [parentRows, confirmers, classRows, groupRows] = await Promise.all([
    studentIds.length
      ? db.select({ childId: parentChild.childId, name: users.name }).from(parentChild).innerJoin(users, eq(users.id, parentChild.parentId)).where(inArray(parentChild.childId, studentIds))
      : [],
    confirmerIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, confirmerIds)) : [],
    studentIds.length
      ? db.select({ userId: groupMembers.userId, name: groups.name }).from(groupMembers).innerJoin(groups, eq(groups.id, groupMembers.groupId)).where(and(inArray(groupMembers.userId, studentIds), eq(groups.kind, "klasse")))
      : [],
    db.select({ name: groups.name }).from(parentLetterGroups).innerJoin(groups, eq(groups.id, parentLetterGroups.groupId)).where(eq(parentLetterGroups.letterId, id)),
  ]);
  const confirmerName = new Map(confirmers.map((c) => [c.id, c.name]));
  const classOf = new Map(classRows.map((c) => [c.userId, c.name]));
  const receipts: ReceiptRow[] = rows
    .map(({ r, studentName }) => ({
      studentId: r.studentId,
      studentName,
      groupName: classOf.get(r.studentId) ?? null,
      parents: parentRows.filter((p) => p.childId === r.studentId).map((p) => p.name),
      readAt: r.readAt,
      confirmedAt: r.confirmedAt,
      confirmedByName: r.confirmedBy ? (confirmerName.get(r.confirmedBy) ?? null) : null,
      answerYes: r.answerYes,
      answerText: r.answerText,
      canConfirm: acting.has(r.studentId),
    }))
    .sort((a, b) => Number(!!a.confirmedAt) - Number(!!b.confirmedAt) || (a.groupName ?? "").localeCompare(b.groupName ?? "", "de", { numeric: true }) || a.studentName.localeCompare(b.studentName, "de"));
  return { mode, letter, groupNames: groupRows.map((g) => g.name).sort((a, b) => a.localeCompare(b, "de", { numeric: true })), receipts };
}

/** Eltern (bzw. die eigenständige Person) öffnen den Brief → „gelesen“ für die Kinder, für die sie handeln. */
export async function markRead(db: Db, viewer: PermissionSet, letterId: string): Promise<void> {
  const kids = (await childrenOf(db, viewer, "act")).map((c) => c.id);
  if (kids.length === 0) return;
  await db
    .update(parentLetterReceipts)
    .set({ readAt: new Date() })
    .where(and(eq(parentLetterReceipts.letterId, letterId), inArray(parentLetterReceipts.studentId, kids), isNull(parentLetterReceipts.readAt)));
}

export async function confirmLetter(db: Db, viewer: PermissionSet, letterId: string, studentId: string, answer: { yes: boolean | null; text: string }): Promise<void> {
  const [letter] = await db.select().from(parentLetters).where(eq(parentLetters.id, letterId));
  const kids = (await childrenOf(db, viewer, "act")).map((c) => c.id);
  if (!letter || !kids.includes(studentId)) throw new ForbiddenError("elternbriefe.confirm");
  const fe: Record<string, string> = {};
  if (letter.responseType === "yesno" && answer.yes === null) fe.answer = "Bitte Ja oder Nein wählen";
  if (letter.responseType === "text" && !answer.text.trim()) fe.answer = "Bitte eine Antwort eingeben";
  if (answer.text.length > 1000) fe.answer = "Antwort bitte kürzer fassen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const now = new Date();
  const updated = await db
    .update(parentLetterReceipts)
    .set({
      readAt: now,
      confirmedAt: now,
      confirmedBy: viewer.userId,
      answerYes: letter.responseType === "yesno" ? answer.yes : null,
      answerText: letter.responseType === "text" ? answer.text.trim() : null,
    })
    .where(and(eq(parentLetterReceipts.letterId, letterId), eq(parentLetterReceipts.studentId, studentId)))
    .returning({ s: parentLetterReceipts.studentId });
  if (updated.length === 0) throw new ForbiddenError("elternbriefe.confirm");
}

/** Darf jetzt (wieder) erinnert werden? Höchstens alle 12 Stunden. */
export function remindAllowed(letter: { lastRemindedAt: Date | null }, now = new Date()): boolean {
  return !letter.lastRemindedAt || now.getTime() - letter.lastRemindedAt.getTime() >= REMIND_EVERY_MS;
}

/** Erinnerung an alle Familien ohne Bestätigung (höchstens alle 12 Stunden; eigenständige Schüler:innen selbst). Gibt die Zahl der Erinnerten zurück. */
export async function remindLetter(db: Db, viewer: PermissionSet, letterId: string, now = new Date()): Promise<number> {
  const [letter] = await db.select().from(parentLetters).where(eq(parentLetters.id, letterId));
  if (!letter || !canManage(viewer, letter)) throw new ForbiddenError("elternbriefe.remind");
  if (!remindAllowed(letter, now)) {
    throw new ValidationError({ remind: "Erinnert wurde gerade erst – nächste Erinnerung frühestens nach 12 Stunden" });
  }
  const open = await db
    .select({ id: parentLetterReceipts.studentId })
    .from(parentLetterReceipts)
    .where(and(eq(parentLetterReceipts.letterId, letterId), isNull(parentLetterReceipts.confirmedAt)));
  const parents = await guardianRecipients(db, open.map((o) => o.id), { withInformed: false });
  await notify(db, parents, { moduleId: "elternbriefe", title: `Erinnerung: ${letter.title}`, body: "Bitte bestätigen Sie den Elternbrief", href: `/elternbriefe/${letterId}` });
  await db.update(parentLetters).set({ lastRemindedAt: now }).where(eq(parentLetters.id, letterId));
  await audit(db, viewer.userId, "elternbriefe.remind", letterId, { parents: parents.length });
  return parents.length;
}

export interface LetterSummary {
  id: string;
  title: string;
  createdAt: Date;
  dueDate: string | null;
  total: number;
  confirmed: number;
  /** Eltern-Sicht: offene Kinder */
  openFor: string[];
}

/** Übersicht: Personal sieht eigene (bzw. alle) Briefe mit Fortschritt, Eltern die Briefe an ihre Kinder (eigenständige Schüler:innen: an sich). */
export async function listLetters(db: Db, viewer: PermissionSet): Promise<LetterSummary[]> {
  if (viewer.role === "eltern" || viewer.role === "schueler") {
    const kids = await childrenOf(db, viewer, "inform");
    if (kids.length === 0) return [];
    const rows = await db
      .select({ l: parentLetters, studentId: parentLetterReceipts.studentId, confirmedAt: parentLetterReceipts.confirmedAt })
      .from(parentLetterReceipts)
      .innerJoin(parentLetters, eq(parentLetters.id, parentLetterReceipts.letterId))
      .where(inArray(parentLetterReceipts.studentId, kids.map((k) => k.id)))
      .orderBy(desc(parentLetters.createdAt));
    const out = new Map<string, LetterSummary>();
    for (const r of rows) {
      const s = out.get(r.l.id) ?? { id: r.l.id, title: r.l.title, createdAt: r.l.createdAt, dueDate: r.l.dueDate, total: 0, confirmed: 0, openFor: [] };
      s.total++;
      if (r.confirmedAt) s.confirmed++;
      else s.openFor.push(kids.find((k) => k.id === r.studentId)!.name);
      out.set(r.l.id, s);
    }
    return [...out.values()];
  }
  const all = hasPermission(viewer, "elternbriefe.send_all");
  const letters = await db
    .select()
    .from(parentLetters)
    .where(all ? undefined : eq(parentLetters.authorId, viewer.userId))
    .orderBy(desc(parentLetters.createdAt));
  if (letters.length === 0) return [];
  const receipts = await db
    .select({ letterId: parentLetterReceipts.letterId, confirmedAt: parentLetterReceipts.confirmedAt })
    .from(parentLetterReceipts)
    .where(inArray(parentLetterReceipts.letterId, letters.map((l) => l.id)));
  return letters.map((l) => {
    const mine = receipts.filter((r) => r.letterId === l.id);
    return { id: l.id, title: l.title, createdAt: l.createdAt, dueDate: l.dueDate, total: mine.length, confirmed: mine.filter((r) => r.confirmedAt).length, openFor: [] };
  });
}

/** Anhang für den Download – nur wer den Brief sehen darf. */
export async function letterAttachment(db: Db, viewer: PermissionSet, id: string) {
  const view = await letterFor(db, viewer, id);
  const l = view?.letter;
  if (!l?.attachmentKey) return null;
  return { storageKey: l.attachmentKey, name: l.attachmentName!, mime: l.attachmentMime!, size: l.attachmentSize! };
}
