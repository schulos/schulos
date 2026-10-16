// Kurswahlen (P4-64): Übernahme der Zuteilung in Gruppen (Wahlpflicht/Kurs/AG mit Jahrgang, Fach, Niveau, Leitung) und
// Lehraufträge als Vorschlag für die Unterrichtsverteilung. Vorher werden Konflikte mit bestehenden Gruppen geprüft.
import { and, eq, gt, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { gradeLevels, groupMembers, groups, kurswahlAngebote, kurswahlVerfahren, kurswahlWahlen, schoolYears, timetableAssignmentGroups, timetableAssignments, users, type KurswahlVerfahren } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { createAssignment, planningYear } from "@/modules/stundenplan/verteilung";
import { addMembers, createGroup } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { KIND_GROUP, MANAGE, getVerfahren, listAngebote, targetStudents, verfahrenState } from "./service";

export interface PlannedGroup {
  offerId: string;
  offerTitle: string;
  name: string;
  /** vorhandene Gruppe gleichen Namens und gleicher Art im Schuljahr → wird ergänzt (Hinweis, Leitung bleibt unverändert) */
  existingId: string | null;
  /** schon übernommen */
  groupId: string | null;
  students: string[];
  teacherName: string | null;
}

export interface Conflict {
  kind: "ohne_kurs" | "zu_wenig" | "schon_in_gruppe" | "name_vergeben" | "vorhandene_gruppe";
  text: string;
}

export interface TransferPreview {
  groups: PlannedGroup[];
  conflicts: Conflict[];
}

async function yearOf(db: Db, v: KurswahlVerfahren): Promise<string | null> {
  if (v.schoolYearId) return v.schoolYearId;
  return (await planningYear(db))?.id ?? null;
}

/** Vorschau: geplante Gruppen und Konflikte (Personen ohne Kurs, schon in einer Gruppe gleicher Art und gleichen Fachs, Name vergeben). */
export async function transferPreview(db: Db, perms: PermissionSet, v: KurswahlVerfahren): Promise<TransferPreview> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const [offers, wahlen, target, [grade]] = await Promise.all([
    listAngebote(db, v.id),
    // G4E-C04: Plätze über der Höchstzahl kommen nie in Gruppen
    db
      .select()
      .from(kurswahlWahlen)
      .where(and(eq(kurswahlWahlen.verfahrenId, v.id), lte(kurswahlWahlen.place, v.maxCourses))),
    targetStudents(db, v),
    db.select({ code: gradeLevels.code }).from(gradeLevels).where(eq(gradeLevels.level, v.courseGrade)),
  ]);
  const yearId = await yearOf(db, v);
  const kind = KIND_GROUP[v.kind];
  const names = new Map([...target.map((t) => [t.id, t.name] as const)]);
  const conflicts: Conflict[] = [];
  const planned: PlannedGroup[] = [];
  for (const o of offers) {
    const students = wahlen.filter((w) => w.assignedId === o.id).map((w) => w.studentId);
    if (students.length === 0 && !o.groupId) continue;
    const name = `${grade?.code ?? v.courseGrade} ${o.title}`;
    const sameName = await db
      .select({ id: groups.id, kind: groups.kind, schoolYearId: groups.schoolYearId })
      .from(groups)
      .where(and(eq(groups.name, name), isNull(groups.archivedAt)));
    const existing = sameName.find((g) => g.kind === kind && (g.schoolYearId === yearId || g.schoolYearId == null));
    if (!o.groupId && sameName.length && !existing) conflicts.push({ kind: "name_vergeben", text: `Den Namen „${name}“ trägt schon eine andere Gruppe – es entsteht eine zweite Gruppe mit diesem Namen` });
    // G4D-S02: eine vorhandene Gruppe wird nie still ergänzt – bestätigen; ihre Leitung ändert die Übernahme nicht
    if (!o.groupId && existing && students.length)
      conflicts.push({ kind: "vorhandene_gruppe", text: `„${name}“ gibt es schon – die ${students.length} Zugeteilten kommen in diese Gruppe; die Leitung bleibt, wie sie ist (ändern in der Gruppenverwaltung)` });
    planned.push({ offerId: o.id, offerTitle: o.title, name, existingId: o.groupId ? null : (existing?.id ?? null), groupId: o.groupId, students, teacherName: o.teacherName });
    // schon in einer Gruppe gleicher Art und gleichen Fachs (ohne die Zielgruppe selbst)
    if (o.subjectId && students.length && !o.groupId) {
      const ignore = [existing?.id, o.groupId].filter((x): x is string => Boolean(x));
      const already = await db
        .select({ userId: groupMembers.userId, groupName: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(
          and(
            inArray(groupMembers.userId, students),
            eq(groups.kind, kind),
            eq(groups.subjectId, o.subjectId),
            isNull(groups.archivedAt),
            ...(ignore.length ? [ne(groups.id, ignore[0]!)] : []),
          ),
        );
      for (const a of already) conflicts.push({ kind: "schon_in_gruppe", text: `${names.get(a.userId) ?? "Eine Schüler:in"} ist schon in „${a.groupName}“ (${o.title})` });
    }
  }
  const assigned = new Set(wahlen.filter((w) => w.assignedId).map((w) => w.studentId));
  const without = target.filter((t) => !assigned.has(t.id));
  if (without.length) conflicts.push({ kind: "ohne_kurs", text: `${without.length} ohne Kurs: ${without.map((t) => `${t.name} (${t.className})`).join(", ")}` });
  // P4-67: bei Mehrfachwahl weniger Kurse als die Mindestzahl
  if (v.minCourses > 1) {
    const n = new Map<string, number>();
    for (const w of wahlen) if (w.assignedId) n.set(w.studentId, (n.get(w.studentId) ?? 0) + 1);
    const few = target.filter((t) => assigned.has(t.id) && (n.get(t.id) ?? 0) < v.minCourses);
    if (few.length)
      conflicts.push({ kind: "zu_wenig", text: `${few.length} mit weniger als ${v.minCourses} Kursen: ${few.map((t) => `${t.name} (${t.className}, ${n.get(t.id)})`).join(", ")}` });
  }
  return { groups: planned, conflicts };
}

/** Übernehmen legt Gruppen an und befüllt sie – das ist Gruppenverwaltung (G4D-S02). */
export const TRANSFER_GROUPS = "verwaltung.groups";

/**
 * Übernahme: je Angebot mit Zugeteilten eine Gruppe anlegen (bzw. die vorhandene gleichen Namens ergänzen – nur nach
 * Bestätigung, ohne die Leitung zu ändern), Mitglieder und bei neuen Gruppen die Leitung eintragen. Danach steht die Zuteilung
 * fest und ist für die Familien sichtbar. Mit Konflikten nur nach Bestätigung. Braucht zusätzlich `verwaltung.groups`.
 * Alles in einer Transaktion, die das Verfahren zuerst belegt (G4D-C02: kein Doppelklick, keine halbe Übernahme).
 */
export async function transfer(db: Db, perms: PermissionSet, verfahrenId: string, opts: { acceptConflicts: boolean }, today: string, now = new Date()): Promise<string[]> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  if (!hasPermission(perms, TRANSFER_GROUPS)) throw new ForbiddenError(TRANSFER_GROUPS);
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ transfer: "Dieses Wahlverfahren gibt es nicht mehr" });
  if (v.transferredAt) throw new ValidationError({ transfer: "Schon übernommen" });
  if (!v.allocatedAt) throw new ValidationError({ transfer: "Erst die Zuteilung berechnen" });
  if (verfahrenState(v, today) === "offen") throw new ValidationError({ transfer: "Die Wahl ist noch offen – erst nach dem Wahlende übernehmen" });
  const created: string[] = [];
  await db.transaction(async (tx) => {
    // belegen: nur eine Übernahme je Verfahren, und nur auf genau die gelesene Zuteilung
    const claimed = await tx
      .update(kurswahlVerfahren)
      .set({ transferredAt: now })
      .where(and(eq(kurswahlVerfahren.id, v.id), isNull(kurswahlVerfahren.transferredAt), eq(kurswahlVerfahren.allocatedAt, v.allocatedAt!)))
      .returning({ id: kurswahlVerfahren.id });
    if (!claimed.length) throw new ValidationError({ transfer: "Inzwischen geändert oder schon übernommen – bitte die Seite neu laden" });
    // G4D-C01: seit der Berechnung abgegebene Wahlen → Zuteilung veraltet
    const [stale] = await tx
      .select({ id: kurswahlWahlen.studentId })
      .from(kurswahlWahlen)
      .where(and(eq(kurswahlWahlen.verfahrenId, v.id), isNotNull(kurswahlWahlen.submittedAt), gt(kurswahlWahlen.submittedAt, v.allocatedAt!)))
      .limit(1);
    if (stale) throw new ValidationError({ transfer: "Seit der Berechnung wurde gewählt – Zuteilung veraltet, bitte neu berechnen" });
    const preview = await transferPreview(tx, perms, v);
    if (preview.conflicts.length && !opts.acceptConflicts) throw new ValidationError({ transfer: `${preview.conflicts.length} Hinweise – bitte ansehen und bestätigen` });
    const offers = new Map((await listAngebote(tx, v.id)).map((o) => [o.id, o]));
    const yearId = await yearOf(tx, v);
    const kind = KIND_GROUP[v.kind];
    for (const p of preview.groups) {
      const o = offers.get(p.offerId)!;
      let groupId = p.groupId ?? p.existingId;
      const fresh = !groupId;
      if (!groupId) {
        groupId = await createGroup(tx, perms.userId, { name: p.name, kind, gradeLevel: v.courseGrade, level: o.level, subjectId: o.subjectId });
        if (yearId) await tx.update(groups).set({ schoolYearId: yearId }).where(eq(groups.id, groupId));
        created.push(groupId);
      }
      await addMembers(tx, perms.userId, groupId, p.students);
      // G4D-S02: Leitung nur in neu angelegten Gruppen – in vorhandenen bleibt sie Sache der Gruppenverwaltung
      if (fresh && o.teacherId) await addMembers(tx, perms.userId, groupId, [o.teacherId], "leader");
      await tx.update(kurswahlAngebote).set({ groupId }).where(eq(kurswahlAngebote.id, o.id));
    }
    await audit(tx, perms.userId, "kurswahl.transfer", v.id, { groups: preview.groups.length, created: created.length, conflicts: preview.conflicts.length });
  });
  return created;
}

export interface AssignmentSuggestion {
  offerId: string;
  groupId: string;
  groupName: string;
  subjectId: string | null;
  hours: number | null;
  teacherId: string | null;
  teacherName: string | null;
  /** Lehrauftrag für Gruppe und Fach gibt es schon */
  exists: boolean;
  /** fehlende Angaben, z. B. „Fach“, „Wochenstunden“ */
  missing: string[];
}

/** Lehraufträge-Vorschlag: je übernommener Gruppe Fach, Stunden und Lehrkraft aus dem Angebot. */
export async function assignmentSuggestions(db: Db, perms: PermissionSet, v: KurswahlVerfahren): Promise<AssignmentSuggestion[]> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const yearId = await yearOf(db, v);
  const offers = (await listAngebote(db, v.id)).filter((o) => o.groupId);
  if (offers.length === 0) return [];
  const groupIds = offers.map((o) => o.groupId!);
  const [gs, existing] = await Promise.all([
    db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)),
    yearId
      ? db
          .select({ groupId: timetableAssignmentGroups.groupId, subjectId: timetableAssignments.subjectId })
          .from(timetableAssignmentGroups)
          .innerJoin(timetableAssignments, eq(timetableAssignments.id, timetableAssignmentGroups.assignmentId))
          .where(and(inArray(timetableAssignmentGroups.groupId, groupIds), eq(timetableAssignments.schoolYearId, yearId)))
      : Promise.resolve([]),
  ]);
  const gName = new Map(gs.map((g) => [g.id, g.name]));
  return offers.map((o) => {
    const missing = [!o.subjectId && "Fach", !o.hours && "Wochenstunden"].filter((x): x is string => Boolean(x));
    return {
      offerId: o.id,
      groupId: o.groupId!,
      groupName: gName.get(o.groupId!) ?? o.title,
      subjectId: o.subjectId,
      hours: o.hours,
      teacherId: o.teacherId,
      teacherName: o.teacherName,
      exists: existing.some((e) => e.groupId === o.groupId && e.subjectId === o.subjectId),
      missing,
    };
  });
}

/** Vorgeschlagene Lehraufträge anlegen (Recht `stundenplan.manage`); übersprungen wird, was fehlt oder schon da ist. */
export async function createSuggestedAssignments(db: Db, perms: PermissionSet, verfahrenId: string): Promise<number> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  if (!hasPermission(perms, "stundenplan.manage")) throw new ForbiddenError("stundenplan.manage");
  const v = await getVerfahren(db, verfahrenId);
  if (!v?.transferredAt) throw new ValidationError({ assignments: "Erst in Gruppen übernehmen" });
  const yearId = await yearOf(db, v);
  if (!yearId) throw new ValidationError({ assignments: "Kein Schuljahr angelegt" });
  const [year] = await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, yearId));
  if (!year) throw new ValidationError({ assignments: "Kein Schuljahr angelegt" });
  let n = 0;
  for (const s of await assignmentSuggestions(db, perms, v)) {
    if (s.exists || s.missing.length) continue;
    const teacherOk = s.teacherId ? (await db.select({ id: users.id }).from(users).where(and(eq(users.id, s.teacherId), eq(users.role, "lehrkraft")))).length > 0 : false;
    await createAssignment(db, perms.userId, {
      schoolYearId: yearId,
      groupIds: [s.groupId],
      subjectId: s.subjectId!,
      hours: s.hours!,
      teacherIds: teacherOk ? [s.teacherId!] : [],
      doubleLessons: 0,
      roomId: null,
      note: `aus Kurswahl „${v.title}“`.slice(0, 200),
    });
    n++;
  }
  await audit(db, perms.userId, "kurswahl.assignments", v.id, { created: n });
  return n;
}
