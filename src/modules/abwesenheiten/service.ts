// Abwesenheiten: Eltern melden, Klassenleitung entschuldigt – Ergebnis wirkt auf die Klassenbuch-Fehlzeiten.
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { absenceReports, groupMembers, groups, users } from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasExplicitGrant, hasPermission, type PermissionSet } from "@/core/permissions";
import { addDays } from "@/core/time";
import { childrenOf, isSelfResponsible } from "@/core/school/majority";
import { ValidationError } from "@/modules/verwaltung/users";
import { afterUnexcused } from "./fehlzeiten";
import { rangeLabel, REASON_LABEL, STATUS_LABEL } from "./labels";
import { ABSENCE_REASONS } from "./schema";
import { applyToClassbook, onLeave } from "./wirkung";
import { canDecide, classOf, isParentOfMinor } from "./zustaendig";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export { rangeLabel, REASON_LABEL, STATUS_LABEL };

export interface ReportInput {
  studentId: string;
  fromDate: string;
  toDate: string;
  reason: (typeof ABSENCE_REASONS)[number];
}

/**
 * Meldung anlegen. Eltern minderjähriger Kinder bzw. eigenständige (volljährige) Schüler:innen für sich selbst (DS-19,
 * § 123 Abs. 2 SchulG NRW): Status „gemeldet“, Gong an die Klassenleitung.
 * Klassenleitung (z. B. schriftliche Entschuldigung): gleich „entschuldigt“.
 * Sekretariat (Recht `abwesenheiten.phone`, Anruf der Eltern): wie bei Eltern Status „gemeldet“ und Gong an die
 * Klassenleitung – entschieden wird weiterhin dort (Q5-01). Über das Telefon-Formular (`channel: "telefon"`) gilt das auch
 * für Personen, die selbst entscheiden dürften (Schulleitung, Admin).
 */
export async function reportAbsence(
  db: Db,
  viewer: PermissionSet,
  input: ReportInput,
  todayYmd: string,
  opts: { /** Telefon-Formular: immer der Sekretariatsweg, auch wenn die Person selbst entscheiden dürfte (Code-Review Gate 4a M3) */ channel?: "telefon" } = {},
): Promise<string> {
  if (opts.channel === "telefon" && !hasPermission(viewer, "abwesenheiten.phone")) throw new ForbiddenError("abwesenheiten.phone");
  const viaPhone = opts.channel === "telefon";
  const ownSelf = !viaPhone && viewer.role === "schueler" && viewer.userId === input.studentId && (await isSelfResponsible(db, input.studentId));
  const parent = ownSelf || (!viaPhone && viewer.role === "eltern" && (await isParentOfMinor(db, viewer.userId, input.studentId)));
  const leader = !viaPhone && !parent && (await canDecide(db, viewer, input.studentId));
  const phone = viaPhone || (!parent && !leader && hasPermission(viewer, "abwesenheiten.phone"));
  if (!parent && !leader && !phone) throw new ForbiddenError("abwesenheiten.report");
  if (phone) {
    const [student] = await db.select({ role: users.role }).from(users).where(eq(users.id, input.studentId));
    if (student?.role !== "schueler") throw new ValidationError({ studentId: "Schüler:in wählen" });
  }
  const fe: Record<string, string> = {};
  if (!YMD.test(input.fromDate)) fe.fromDate = "Ersten Tag angeben";
  if (!YMD.test(input.toDate)) fe.toDate = "Letzten Tag angeben";
  else if (input.toDate < input.fromDate) fe.toDate = "Der letzte Tag liegt vor dem ersten";
  else if (input.toDate > addDays(input.fromDate, 30)) fe.toDate = "Höchstens 31 Tage am Stück";
  if ((parent || phone) && YMD.test(input.fromDate) && input.fromDate < addDays(todayYmd, -14)) fe.fromDate = "Nachmeldungen sind bis zu 14 Tage rückwirkend möglich";
  if (!ABSENCE_REASONS.includes(input.reason)) fe.reason = "Grund wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  const status = leader ? "entschuldigt" : "gemeldet";
  const [row] = await db
    .insert(absenceReports)
    .values({ ...input, reportedBy: viewer.userId, status, decidedBy: leader ? viewer.userId : null, decidedAt: leader ? new Date() : null })
    .returning({ id: absenceReports.id });
  if (leader) await applyToClassbook(db, input.studentId, input.fromDate, input.toDate, true);
  await audit(db, viewer.userId, "abwesenheiten.report", input.studentId, { from: input.fromDate, to: input.toDate, status, ...(phone ? { channel: "telefon" } : {}), ...(ownSelf ? { selbst: true } : {}) });

  if (parent || phone) {
    const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.studentId));
    const { leaderIds } = await classOf(db, input.studentId);
    await notify(db, leaderIds, {
      moduleId: "abwesenheiten",
      title: `Abwesenheit gemeldet: ${student?.name} (${rangeLabel(input.fromDate, input.toDate)})`,
      body: `Grund: ${REASON_LABEL[input.reason]}`,
      href: "/abwesenheiten",
    });
  }
  return row!.id;
}

/** Klassenleitung entscheidet über eine Meldung; wirkt auf das Klassenbuch, Gong an die meldende Person. */
export async function decideReport(db: Db, viewer: PermissionSet, id: string, excused: boolean, todayYmd?: string): Promise<void> {
  const [r] = await db.select().from(absenceReports).where(eq(absenceReports.id, id));
  if (!r) throw new ValidationError({ id: "Meldung gibt es nicht mehr" });
  if (!(await canDecide(db, viewer, r.studentId))) throw new ForbiddenError("abwesenheiten.decide");
  const status = excused ? "entschuldigt" : "nicht_entschuldigt";
  await db.update(absenceReports).set({ status, decidedBy: viewer.userId, decidedAt: new Date() }).where(eq(absenceReports.id, id));
  await applyToClassbook(db, r.studentId, r.fromDate, r.toDate, excused);
  await audit(db, viewer.userId, "abwesenheiten.decide", r.studentId, { report: id, status });
  if (r.reportedBy && r.reportedBy !== viewer.userId) {
    const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, r.studentId));
    await notify(db, [r.reportedBy], {
      moduleId: "abwesenheiten",
      title: `${student?.name}: ${rangeLabel(r.fromDate, r.toDate)} ${STATUS_LABEL[status]}`,
      href: "/abwesenheiten",
    });
  }
  // F-03: „nicht entschuldigt“ erfahren auch die anderen Eltern (minderjähriger Kinder); Hinweis an die KL ab der Schwelle
  if (!excused) await afterUnexcused(db, r.studentId, rangeLabel(r.fromDate, r.toDate), todayYmd ?? r.toDate, [r.reportedBy, viewer.userId]);
}

/** Gilt für diese Person an diesem Tag eine Entscheidung? (für neu eingetragene Fehlstunden im Klassenbuch) */
export async function excusedStateOn(db: Db, studentIds: string[], date: string): Promise<Map<string, boolean>> {
  if (studentIds.length === 0) return new Map();
  const rows = await db
    .select({ studentId: absenceReports.studentId, status: absenceReports.status })
    .from(absenceReports)
    .where(and(inArray(absenceReports.studentId, studentIds), lte(absenceReports.fromDate, date), gte(absenceReports.toDate, date)));
  const out = new Map<string, boolean>();
  // Q5-16: genehmigte Beurlaubung = entschuldigt (geht jeder Meldung vor)
  for (const id of await onLeave(db, studentIds, date)) out.set(id, true);
  for (const r of rows) {
    if (r.status === "entschuldigt") out.set(r.studentId, true);
    else if (r.status === "nicht_entschuldigt" && !out.has(r.studentId)) out.set(r.studentId, false);
  }
  return out;
}

export interface ReportRow {
  id: string;
  studentId: string;
  studentName: string;
  groupName: string | null;
  fromDate: string;
  toDate: string;
  /** DS-20: null = Grund für diese Person ausgeblendet (Admin-Konten) */
  reason: "krank" | "sonstiges" | null;
  status: "gemeldet" | "entschuldigt" | "nicht_entschuldigt";
  reportedByName: string | null;
  createdAt: Date;
}

async function listReports(db: Db, studentIds: string[]): Promise<ReportRow[]> {
  if (studentIds.length === 0) return [];
  const student = alias(users, "student");
  const reporter = alias(users, "reporter");
  const rows = await db
    .select({ r: absenceReports, studentName: student.name, reportedByName: reporter.name })
    .from(absenceReports)
    .innerJoin(student, eq(student.id, absenceReports.studentId))
    .leftJoin(reporter, eq(reporter.id, absenceReports.reportedBy))
    .where(inArray(absenceReports.studentId, studentIds))
    .orderBy(desc(absenceReports.fromDate), desc(absenceReports.createdAt));
  const classes = await db
    .select({ userId: groupMembers.userId, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.userId, studentIds), eq(groups.kind, "klasse")));
  const classOfStudent = new Map(classes.map((c) => [c.userId, c.name]));
  return rows.map(({ r, studentName, reportedByName }) => ({
    id: r.id,
    studentId: r.studentId,
    studentName,
    groupName: classOfStudent.get(r.studentId) ?? null,
    fromDate: r.fromDate,
    toDate: r.toDate,
    reason: r.reason,
    status: r.status,
    reportedByName,
    createdAt: r.createdAt,
  }));
}

/**
 * Eltern: minderjährige Kinder (melden) + deren Meldungen; eigenständige (volljährige) Kinder fehlen – sie melden selbst (DS-19).
 * `informed`: Kinder, deren Fehlzeiten-Übersicht das Elternteil sehen darf (minderjährig oder mit Einwilligung, Q5-05) –
 * Meldungen samt Grund eigenständiger Kinder sehen Eltern auch mit Einwilligung nicht.
 */
export async function parentView(db: Db, parentId: string) {
  const byName = (a: { firstName: string }, b: { firstName: string }) => a.firstName.localeCompare(b.firstName, "de");
  const [acting, informed] = await Promise.all([childrenOf(db, parentId, "act"), childrenOf(db, parentId, "inform")]);
  const kids = acting.sort(byName).map(({ id, name }) => ({ id, name }));
  return { kids, informed: informed.sort(byName).map(({ id, name }) => ({ id, name })), reports: await listReports(db, kids.map((k) => k.id)) };
}

/** Eigenständige (volljährige) Schüler:innen: eigene Meldungen (DS-19). Leer für alle anderen. */
export async function selfView(db: Db, studentId: string): Promise<ReportRow[] | null> {
  if (!(await isSelfResponsible(db, studentId))) return null;
  return listReports(db, [studentId]);
}

/** Sekretariat (Telefonmeldung): alle Schüler:innen mit Klasse, nach Klasse und Name sortiert. */
export async function phoneStudents(db: Db, viewer: PermissionSet): Promise<{ id: string; name: string; groupName: string | null }[]> {
  if (!hasPermission(viewer, "abwesenheiten.phone")) throw new ForbiddenError("abwesenheiten.phone");
  const rows = await db
    .select({ id: users.id, name: users.name, lastName: users.lastName, firstName: users.firstName })
    .from(users)
    .where(and(eq(users.role, "schueler"), isNull(users.leftOn)));
  const classes = rows.length
    ? await db
        .select({ userId: groupMembers.userId, name: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(eq(groups.kind, "klasse"))
    : [];
  const classOfStudent = new Map(classes.map((c) => [c.userId, c.name]));
  return rows
    .map((r) => ({ ...r, groupName: classOfStudent.get(r.id) ?? null }))
    .sort((a, b) => (a.groupName ?? "~").localeCompare(b.groupName ?? "~", "de", { numeric: true }) || a.lastName.localeCompare(b.lastName, "de") || a.firstName.localeCompare(b.firstName, "de"))
    .map((r) => ({ id: r.id, name: r.name, groupName: r.groupName }));
}

/**
 * DS-20 (Q-4D-5, Projektleitung 2026-10-13): Wer sieht den Grund einer Krankmeldung? Klassenleitung der Klasse und wer „Alle Abwesenheiten
 * bearbeiten“ **ausdrücklich** hat – nie Admin-Konten (das Vollrecht `*` bzw. die Rolle `admin` schließt die Gründe nicht mehr
 * ein, wie im Notenbuch F5-05). Die technische Betreuung sieht Zeitraum und Stand, nicht „krank“/„sonstiges“.
 */
export function reasonVisible(viewer: PermissionSet, classId: string | null): boolean {
  if (viewer.role === "admin") return false;
  return (classId !== null && viewer.leaderOf.has(classId)) || hasExplicitGrant(viewer, "abwesenheiten.manage");
}

/** Klassenleitung: Schüler:innen der eigenen Klassen + deren Meldungen (offene zuerst) */
export async function leaderView(db: Db, viewer: PermissionSet) {
  const all = (await db.select({ id: groups.id }).from(groups).where(eq(groups.kind, "klasse"))).map((g) => g.id);
  const classIds = hasPermission(viewer, "abwesenheiten.manage") ? all : all.filter((id) => viewer.leaderOf.has(id));
  if (classIds.length === 0) return { students: [], reports: [] };
  const students = await db
    .selectDistinct({ id: users.id, name: users.name, lastName: users.lastName, firstName: users.firstName, groupName: groups.name, groupId: groups.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.groupId, classIds), eq(users.role, "schueler")));
  students.sort((a, b) => a.groupName.localeCompare(b.groupName, "de", { numeric: true }) || a.lastName.localeCompare(b.lastName, "de") || a.firstName.localeCompare(b.firstName, "de"));
  const classOfStudent = new Map(students.map((s) => [s.id, s.groupId]));
  const reports = (await listReports(db, students.map((s) => s.id))).map((r) => (reasonVisible(viewer, classOfStudent.get(r.studentId) ?? null) ? r : { ...r, reason: null }));
  reports.sort((a, b) => Number(b.status === "gemeldet") - Number(a.status === "gemeldet"));
  return { students: students.map((s) => ({ id: s.id, name: s.name, groupName: s.groupName })), reports };
}
