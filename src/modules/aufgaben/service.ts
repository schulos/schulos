// Aufgaben: stellen → abgeben → Feedback. Status wird aus den Daten berechnet, nicht gespeichert.
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { groupMembers, groups, taskFiles, taskGroups, tasks, taskSubmissions, users } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { notify } from "@/core/notifications";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { cleanName, MAX_FILE_BYTES } from "@/modules/dateien/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { scanUpload } from "@/modules/upload-scan";
import { de } from "@/core/db/sort";

export type SubmissionType = (typeof tasks.$inferSelect)["submissionType"];
export type TaskStatus = "offen" | "abgegeben" | "verspaetet" | "fehlt" | "zurueckgegeben";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  offen: "Offen",
  abgegeben: "Abgegeben",
  verspaetet: "Verspätet abgegeben",
  fehlt: "Fehlt",
  zurueckgegeben: "Zurückgegeben",
};

export const canCreate = (p: PermissionSet) => hasPermission(p, "aufgaben.create");

export function statusOf(dueAt: Date, sub: { submittedAt: Date; returnedAt: Date | null } | null | undefined, now = new Date()): TaskStatus {
  if (sub?.returnedAt) return "zurueckgegeben";
  if (sub) return sub.submittedAt > dueAt ? "verspaetet" : "abgegeben";
  return now > dueAt ? "fehlt" : "offen";
}

export interface FileInput {
  name: string;
  type: string;
  data: Uint8Array;
}

async function storeFiles(db: Db, storage: FileStorage, taskId: string, submissionId: string | null, uploadedBy: string, files: FileInput[]) {
  for (const f of files) {
    if (f.data.byteLength === 0) continue;
    if (f.data.byteLength > MAX_FILE_BYTES) throw new ValidationError({ files: `„${f.name}“ ist größer als 25 MB` });
  }
  // P4-72: erst alle prüfen, dann speichern – ein Fund verhindert den ganzen Upload
  for (const f of files) if (f.data.byteLength > 0) await scanUpload(f.data, f.name, "files");
  for (const f of files) {
    if (f.data.byteLength === 0) continue;
    const storageKey = newStorageKey();
    await storage.put(storageKey, f.data);
    await db.insert(taskFiles).values({
      taskId,
      submissionId,
      name: cleanName(f.name),
      mime: f.type || "application/octet-stream",
      size: f.data.byteLength,
      storageKey,
      uploadedBy,
    });
  }
}

/** Gruppen, denen eine Lehrkraft Aufgaben stellen kann (eigene Klassen/Kurse/AGs). */
export async function assignableGroups(db: Db, viewer: PermissionSet) {
  if (viewer.memberOf.size === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(inArray(groups.id, [...viewer.memberOf]), inArray(groups.kind, ["klasse", "kurs", "ag"])))
    .orderBy(asc(groups.gradeLevel), de(groups.name));
}

const deCollator = new Intl.Collator("de");

/** Schüler:innen aller Zielgruppen einer Aufgabe (ohne Duplikate), deutsch sortiert (ä bei a, nicht hinter z). */
export async function studentsOfTask(db: Db, taskId: string) {
  const rows = await db
    .selectDistinct({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName })
    .from(taskGroups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, taskGroups.groupId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(taskGroups.taskId, taskId), eq(users.role, "schueler"), eq(users.status, "active")));
  return rows.sort((a, b) => deCollator.compare(a.lastName, b.lastName) || deCollator.compare(a.firstName, b.firstName));
}

export interface TaskInput {
  title: string;
  description: string;
  groupIds: string[];
  startsAt?: Date;
  dueAt: Date;
  submissionType: SubmissionType;
  files?: FileInput[];
}

export async function createTask(db: Db, storage: FileStorage, viewer: PermissionSet, input: TaskInput, now = new Date()): Promise<string> {
  if (!canCreate(viewer)) throw new ValidationError({ title: "Keine Berechtigung" });
  const errors: Record<string, string> = {};
  if (!input.title.trim()) errors.title = "Titel fehlt";
  const groupIds = [...new Set(input.groupIds)];
  const allowed = new Set((await assignableGroups(db, viewer)).map((g) => g.id));
  if (groupIds.length === 0) errors.groupIds = "Mindestens eine Gruppe wählen";
  else if (groupIds.some((g) => !allowed.has(g))) errors.groupIds = "Nur eigene Klassen, Kurse oder AGs";
  const startsAt = input.startsAt ?? now;
  if (!(input.dueAt > startsAt)) errors.dueAt = "Die Frist muss nach dem Start liegen";
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const [t] = await db
    .insert(tasks)
    .values({ title: input.title.trim(), description: input.description.trim(), authorId: viewer.userId, startsAt, dueAt: input.dueAt, submissionType: input.submissionType })
    .returning({ id: tasks.id });
  const id = t!.id;
  await db.insert(taskGroups).values(groupIds.map((groupId) => ({ taskId: id, groupId })));
  await storeFiles(db, storage, id, null, viewer.userId, input.files ?? []);

  if (startsAt <= now) {
    const students = await studentsOfTask(db, id);
    await notify(db, students.map((s) => s.id), { moduleId: "aufgaben", title: `Neue Aufgabe: ${input.title.trim()}`, body: "Neu in Aufgaben", href: `/aufgaben/${id}` });
  }
  return id;
}

async function taskGroupNames(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, string[]>();
  const rows = await db
    .select({ taskId: taskGroups.taskId, name: groups.name })
    .from(taskGroups)
    .innerJoin(groups, eq(groups.id, taskGroups.groupId))
    .where(inArray(taskGroups.taskId, ids))
    .orderBy(de(groups.name));
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.taskId, [...(m.get(r.taskId) ?? []), r.name]);
  return m;
}

/** Aufgaben einer Schülerin/eines Schülers (nur gestartete) mit eigenem Status. */
export async function listForStudent(db: Db, viewer: PermissionSet, now = new Date()) {
  if (viewer.memberOf.size === 0) return [];
  const rows = await db
    .selectDistinct({
      id: tasks.id,
      title: tasks.title,
      dueAt: tasks.dueAt,
      startsAt: tasks.startsAt,
      submissionType: tasks.submissionType,
      authorName: users.name,
    })
    .from(tasks)
    .innerJoin(taskGroups, eq(taskGroups.taskId, tasks.id))
    .leftJoin(users, eq(users.id, tasks.authorId))
    .where(and(inArray(taskGroups.groupId, [...viewer.memberOf]), lte(tasks.startsAt, now)))
    .orderBy(asc(tasks.dueAt));
  const subs = rows.length
    ? await db
        .select()
        .from(taskSubmissions)
        .where(and(eq(taskSubmissions.studentId, viewer.userId), inArray(taskSubmissions.taskId, rows.map((r) => r.id))))
    : [];
  const names = await taskGroupNames(db, rows.map((r) => r.id));
  return rows.map((r) => {
    const sub = subs.find((s) => s.taskId === r.id);
    return { ...r, groups: names.get(r.id) ?? [], status: statusOf(r.dueAt, sub, now), grade: sub?.returnedAt ? sub.grade : null };
  });
}

/** Aufgaben einer Lehrkraft mit Fortschritt. */
export async function listForTeacher(db: Db, viewer: PermissionSet) {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, startsAt: tasks.startsAt, submissionType: tasks.submissionType })
    .from(tasks)
    .where(hasPermission(viewer, "aufgaben.view_all") ? undefined : eq(tasks.authorId, viewer.userId))
    .orderBy(desc(tasks.dueAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [subCounts, names] = await Promise.all([
    db
      .select({
        taskId: taskSubmissions.taskId,
        submitted: count(),
        returned: sql<number>`count(${taskSubmissions.returnedAt})::int`,
      })
      .from(taskSubmissions)
      .where(inArray(taskSubmissions.taskId, ids))
      .groupBy(taskSubmissions.taskId),
    taskGroupNames(db, ids),
  ]);
  const totals = await db.execute<{ task_id: string; n: number }>(sql`
    select tg.task_id, count(distinct gm.user_id)::int as n
    from task_groups tg join group_members gm on gm.group_id = tg.group_id join users u on u.id = gm.user_id
    where tg.task_id in ${ids} and u.role = 'schueler' and u.status = 'active'
    group by tg.task_id`);
  const totalRows = rowsOf<{ task_id: string; n: number }>(totals);
  return rows.map((r) => {
    const c = subCounts.find((s) => s.taskId === r.id);
    return {
      ...r,
      groups: names.get(r.id) ?? [],
      students: totalRows.find((t) => t.task_id === r.id)?.n ?? 0,
      submitted: c?.submitted ?? 0,
      returned: c?.returned ?? 0,
    };
  });
}

/** Aufgabe mit Zugriffsprüfung: Autor:in/view_all = „manage", Schüler:in einer Zielgruppe (gestartet) = „student". */
export async function getTask(db: Db, viewer: PermissionSet, id: string, now = new Date()) {
  const [t] = await db.select({ task: tasks, authorName: users.name }).from(tasks).leftJoin(users, eq(users.id, tasks.authorId)).where(eq(tasks.id, id));
  if (!t) return null;
  const gs = await db
    .select({ id: groups.id, name: groups.name })
    .from(taskGroups)
    .innerJoin(groups, eq(groups.id, taskGroups.groupId))
    .where(eq(taskGroups.taskId, id));
  const manage = t.task.authorId === viewer.userId || hasPermission(viewer, "aufgaben.view_all");
  const student = viewer.role === "schueler" && gs.some((g) => viewer.memberOf.has(g.id)) && t.task.startsAt <= now;
  if (!manage && !student) return null;
  const files = await db
    .select({ id: taskFiles.id, name: taskFiles.name, size: taskFiles.size, mime: taskFiles.mime })
    .from(taskFiles)
    .where(and(eq(taskFiles.taskId, id), isNull(taskFiles.submissionId)));
  const mine = student ? await getSubmission(db, id, viewer.userId) : null;
  return { ...t.task, authorName: t.authorName, groups: gs, files, role: manage ? ("manage" as const) : ("student" as const), mine, status: statusOf(t.task.dueAt, mine, now) };
}

export async function getSubmission(db: Db, taskId: string, studentId: string) {
  const [s] = await db
    .select()
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.taskId, taskId), eq(taskSubmissions.studentId, studentId)));
  if (!s) return null;
  const files = await db
    .select({ id: taskFiles.id, name: taskFiles.name, size: taskFiles.size, mime: taskFiles.mime })
    .from(taskFiles)
    .where(eq(taskFiles.submissionId, s.id));
  return { ...s, files };
}

/** Abgeben oder (vor der Rückgabe) neu abgeben. Neue Abgabe ersetzt Text und Dateien. */
export async function submit(db: Db, storage: FileStorage, viewer: PermissionSet, taskId: string, input: { text?: string; files?: FileInput[] }, now = new Date()) {
  const t = await getTask(db, viewer, taskId, now);
  if (!t || t.role !== "student") throw new ValidationError({ text: "Keine Berechtigung" });
  if (t.mine?.returnedAt) throw new ValidationError({ text: "Die Abgabe wurde schon zurückgegeben" });
  const text = input.text?.trim() ?? "";
  const files = (input.files ?? []).filter((f) => f.data.byteLength > 0);
  if (t.submissionType === "text" && !text) throw new ValidationError({ text: "Bitte einen Text eingeben" });
  if (t.submissionType === "file" && files.length === 0) throw new ValidationError({ files: "Bitte mindestens eine Datei hochladen" });

  let submissionId: string;
  if (t.mine) {
    submissionId = t.mine.id;
    const old = await db.delete(taskFiles).where(eq(taskFiles.submissionId, submissionId)).returning({ key: taskFiles.storageKey });
    await Promise.all(old.map((o) => storage.delete(o.key)));
    await db.update(taskSubmissions).set({ text: text || null, submittedAt: now }).where(eq(taskSubmissions.id, submissionId));
  } else {
    const [s] = await db.insert(taskSubmissions).values({ taskId, studentId: viewer.userId, text: text || null, submittedAt: now }).returning({ id: taskSubmissions.id });
    submissionId = s!.id;
  }
  await storeFiles(db, storage, taskId, submissionId, viewer.userId, files);

  if (t.authorId) {
    const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId));
    await notify(db, [t.authorId], {
      moduleId: "aufgaben",
      title: `${me?.name} hat „${t.title}“ abgegeben`,
      body: now > t.dueAt ? "Verspätete Abgabe" : null,
      href: `/aufgaben/${taskId}/abgabe/${viewer.userId}`,
    });
  }
}

/** Abgabe-Matrix für die Lehrkraft. */
export async function submissionMatrix(db: Db, viewer: PermissionSet, taskId: string, now = new Date()) {
  const t = await getTask(db, viewer, taskId, now);
  if (!t || t.role !== "manage") return null;
  const [students, subs] = await Promise.all([
    studentsOfTask(db, taskId),
    db.select().from(taskSubmissions).where(eq(taskSubmissions.taskId, taskId)),
  ]);
  return {
    task: t,
    rows: students.map((s) => {
      const sub = subs.find((x) => x.studentId === s.id);
      return { student: s, status: statusOf(t.dueAt, sub, now), submittedAt: sub?.submittedAt ?? null, grade: sub?.grade ?? null };
    }),
  };
}

/** Feedback + Bewertung → Rückgabe an die Schülerin/den Schüler. */
export async function giveFeedback(db: Db, viewer: PermissionSet, taskId: string, studentId: string, input: { feedback: string; grade?: string }, now = new Date()) {
  const t = await getTask(db, viewer, taskId, now);
  if (!t || t.role !== "manage") throw new ValidationError({ feedback: "Keine Berechtigung" });
  const sub = await getSubmission(db, taskId, studentId);
  if (!sub) throw new ValidationError({ feedback: "Es gibt noch keine Abgabe" });
  if (!input.feedback.trim() && !input.grade?.trim()) throw new ValidationError({ feedback: "Feedback oder Bewertung eintragen" });
  await db
    .update(taskSubmissions)
    .set({ feedback: input.feedback.trim() || null, grade: input.grade?.trim() || null, returnedAt: now })
    .where(eq(taskSubmissions.id, sub.id));
  await notify(db, [studentId], { moduleId: "aufgaben", title: `Feedback zu „${t.title}“`, body: input.grade?.trim() ? `Bewertung: ${input.grade.trim()}` : null, href: `/aufgaben/${taskId}` });
}

/** Datei-Download mit Rechteprüfung: Aufgaben-Anhänge für alle mit Zugriff, Abgabe-Dateien nur Eigentümer:in + Lehrkraft. */
export async function getTaskFile(db: Db, viewer: PermissionSet, fileId: string) {
  const [f] = await db
    .select({ file: taskFiles, studentId: taskSubmissions.studentId })
    .from(taskFiles)
    .leftJoin(taskSubmissions, eq(taskSubmissions.id, taskFiles.submissionId))
    .where(eq(taskFiles.id, fileId));
  if (!f) return null;
  const t = await getTask(db, viewer, f.file.taskId);
  if (!t) return null;
  if (f.file.submissionId && t.role !== "manage" && f.studentId !== viewer.userId) return null;
  return f.file;
}

export async function deleteTask(db: Db, storage: FileStorage, viewer: PermissionSet, taskId: string) {
  const t = await getTask(db, viewer, taskId);
  if (!t || t.role !== "manage") throw new ValidationError({ title: "Keine Berechtigung" });
  const keys = await db.select({ key: taskFiles.storageKey }).from(taskFiles).where(eq(taskFiles.taskId, taskId));
  await db.delete(tasks).where(eq(tasks.id, taskId));
  await Promise.all(keys.map((k) => storage.delete(k.key)));
}

