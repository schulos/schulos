// Beurlaubung vorab (Q5-16, F-08, I-06): Eltern minderjähriger Kinder bzw. volljährige Schüler:innen beantragen, die
// Klassenleitung entscheidet bis zur eingestellten Zahl Schultage (Vorgabe 2), darüber die Schulleitung (Recht
// `abwesenheiten.leave_decide`). Gründe nur als Auswahl ohne Art.-9-Bezug, kein Freitext. Genehmigt → Fehlstunden im Zeitraum
// gelten als entschuldigt, das Klassenbuch zeigt „beurlaubt“. Rechtslage (§ 43 SchulG NRW, Formerfordernis) zu prüfen –
// docs/DSB-FRAGEN.md §9.
import { and, desc, eq, gte, inArray, lte, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { absenceLeaveRequests, groupMembers, groups, users } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { loadSchoolCalendar, type SchoolCalendar } from "@/core/school/calendar";
import { isSelfResponsible } from "@/core/school/majority";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { rangeLabel } from "./labels";
import { LEAVE_REASONS, type AbsenceLeaveRequest } from "./schema";
import { LEAVE_CLASS_LEAD_DAYS } from "./settings";
import { applyToClassbook } from "./wirkung";
import { canDecide, classOf, isParentOfMinor } from "./zustaendig";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const LEAVE_REASON_LABEL = { familiaer: "familiärer Anlass", veranstaltung: "Wettkampf/Veranstaltung", sonstiges: "sonstiger Grund" } as const;
export const LEAVE_STATUS_LABEL = { beantragt: "beantragt", genehmigt: "genehmigt", abgelehnt: "abgelehnt" } as const;
export const LEAVE_DECIDER_LABEL = { klassenleitung: "Klassenleitung", schulleitung: "Schulleitung" } as const;
/** so weit voraus kann beantragt werden */
export const LEAVE_MAX_AHEAD_DAYS = 365;
/** höchstens so lang am Stück */
export const LEAVE_MAX_DAYS = 31;

export interface LeaveInput {
  studentId: string;
  fromDate: string;
  toDate: string;
  reason: (typeof LEAVE_REASONS)[number];
}

/** Rein: Schultage im Zeitraum (ohne Wochenenden, Feiertage, Ferien, freie Tage). */
export function countSchoolDays(cal: SchoolCalendar, from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (cal.isSchoolDay(d)) n++;
  return n;
}

/** Rein: wer entscheidet bei so vielen Schultagen und dieser Grenze (0 = immer die Schulleitung). */
export function deciderFor(schoolDays: number, limit: number): "klassenleitung" | "schulleitung" {
  return limit > 0 && schoolDays <= limit ? "klassenleitung" : "schulleitung";
}

/** Antragsberechtigt: Elternteil eines minderjährigen Kindes oder die volljährige Schülerin/der volljährige Schüler selbst. */
async function mayRequest(db: Db, viewer: PermissionSet, studentId: string): Promise<boolean> {
  if (viewer.role === "eltern") return isParentOfMinor(db, viewer.userId, studentId);
  if (viewer.role === "schueler" && viewer.userId === studentId) return isSelfResponsible(db, studentId);
  return false;
}

/** Wer über einen Antrag entscheiden darf: Schulleitung immer, Klassenleitung (bzw. `abwesenheiten.manage`) bis zur Grenze. */
async function mayDecide(db: Db, viewer: PermissionSet, row: Pick<AbsenceLeaveRequest, "decider" | "studentId">): Promise<boolean> {
  if (hasPermission(viewer, "abwesenheiten.leave_decide")) return true;
  return row.decider === "klassenleitung" && (await canDecide(db, viewer, row.studentId));
}

/** Empfänger:innen des Gongs zum neuen Antrag. Schulleitung: Inhaber:innen des Rechts ohne Admin-Konten (nur, wenn es sonst niemanden gibt). */
async function deciderIds(db: Db, decider: "klassenleitung" | "schulleitung", studentId: string): Promise<string[]> {
  if (decider === "klassenleitung") return (await classOf(db, studentId)).leaderIds;
  const ids = await usersWithPermission(db, "abwesenheiten.leave_decide");
  if (ids.length === 0) return [];
  const people = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), ne(users.role, "admin")));
  return people.length ? people.map((p) => p.id) : ids;
}

/**
 * GATE-4f C-10: Hat außer Admin-Konten niemand das Recht „Beurlaubungen über der Grenze entscheiden“? Dann landen solche
 * Anträge nur bei Admins – die Schule soll das Recht bewusst vergeben (Hinweis in „Offen für dich“ und DS-12).
 */
export async function leaveDecidersMissing(db: Db): Promise<boolean> {
  const ids = await usersWithPermission(db, "abwesenheiten.leave_decide");
  if (ids.length === 0) return true;
  const people = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), ne(users.role, "admin"))).limit(1);
  return people.length === 0;
}

export async function requestLeave(db: Db, viewer: PermissionSet, input: LeaveInput, todayYmd: string, cal?: SchoolCalendar): Promise<string> {
  if (!(await mayRequest(db, viewer, input.studentId))) throw new ForbiddenError("abwesenheiten.leave_request");
  const fe: Record<string, string> = {};
  if (!YMD.test(input.fromDate)) fe.fromDate = "Ersten Tag angeben";
  else if (input.fromDate < todayYmd) fe.fromDate = "Beurlaubungen werden vorab beantragt – für vergangene Tage bitte eine Abwesenheit melden";
  else if (input.fromDate > addDays(todayYmd, LEAVE_MAX_AHEAD_DAYS)) fe.fromDate = "Höchstens ein Jahr im Voraus";
  if (!YMD.test(input.toDate)) fe.toDate = "Letzten Tag angeben";
  else if (YMD.test(input.fromDate) && input.toDate < input.fromDate) fe.toDate = "Der letzte Tag liegt vor dem ersten";
  else if (YMD.test(input.fromDate) && input.toDate > addDays(input.fromDate, LEAVE_MAX_DAYS - 1)) fe.toDate = `Höchstens ${LEAVE_MAX_DAYS} Tage am Stück`;
  if (!LEAVE_REASONS.includes(input.reason)) fe.reason = "Grund wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  const schoolDays = countSchoolDays(cal ?? (await loadSchoolCalendar(db)), input.fromDate, input.toDate);
  if (schoolDays === 0) throw new ValidationError({ toDate: "In diesem Zeitraum ist kein Unterricht" });
  const [overlap] = await db
    .select({ id: absenceLeaveRequests.id })
    .from(absenceLeaveRequests)
    .where(
      and(
        eq(absenceLeaveRequests.studentId, input.studentId),
        or(eq(absenceLeaveRequests.status, "beantragt"), eq(absenceLeaveRequests.status, "genehmigt")),
        lte(absenceLeaveRequests.fromDate, input.toDate),
        gte(absenceLeaveRequests.toDate, input.fromDate),
      ),
    );
  if (overlap) throw new ValidationError({ fromDate: "Für diesen Zeitraum gibt es schon einen Antrag" });

  const decider = deciderFor(schoolDays, Number(await readModuleSetting(db, LEAVE_CLASS_LEAD_DAYS)) || 0);
  const [row] = await db
    .insert(absenceLeaveRequests)
    .values({ ...input, requestedBy: viewer.userId, schoolDays, decider })
    .returning({ id: absenceLeaveRequests.id });
  await audit(db, viewer.userId, "abwesenheiten.leave.request", input.studentId, { from: input.fromDate, to: input.toDate, schoolDays, decider });
  const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.studentId));
  await notify(db, await deciderIds(db, decider, input.studentId), {
    moduleId: "abwesenheiten",
    title: `Beurlaubung beantragt: ${student?.name} (${rangeLabel(input.fromDate, input.toDate)}, ${schoolDays} ${schoolDays === 1 ? "Schultag" : "Schultage"})`,
    body: `Grund: ${LEAVE_REASON_LABEL[input.reason]} · entscheidet: ${LEAVE_DECIDER_LABEL[decider]}`,
    href: "/abwesenheiten",
  });
  return row!.id;
}

/** Entscheidung über einen Antrag; Gong an die antragstellende Person, bei Genehmigung auch an die Klassenleitung. */
export async function decideLeave(db: Db, viewer: PermissionSet, id: string, approve: boolean): Promise<void> {
  const [r] = await db.select().from(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id));
  if (!r) throw new ValidationError({ id: "Antrag gibt es nicht mehr" });
  if (!(await mayDecide(db, viewer, r))) throw new ForbiddenError("abwesenheiten.leave_decide");
  const done = () => new ValidationError({ id: "Über den Antrag ist schon entschieden" });
  if (r.status !== "beantragt") throw done();
  const status = approve ? "genehmigt" : "abgelehnt";
  // GATE-4f C-05: nur ein offener Antrag wird entschieden – entscheiden zwei gleichzeitig, gewinnt die erste (kein zweiter Gong,
  // kein Klassenbuch-Eintrag nach einer Ablehnung)
  const updated = await db
    .update(absenceLeaveRequests)
    .set({ status, decidedBy: viewer.userId, decidedAt: new Date() })
    .where(and(eq(absenceLeaveRequests.id, id), eq(absenceLeaveRequests.status, "beantragt")))
    .returning({ id: absenceLeaveRequests.id });
  if (updated.length === 0) throw done();
  if (approve) await applyToClassbook(db, r.studentId, r.fromDate, r.toDate, true);
  await audit(db, viewer.userId, "abwesenheiten.leave.decide", r.studentId, { request: id, status });
  const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, r.studentId));
  const title = `Beurlaubung ${student?.name} (${rangeLabel(r.fromDate, r.toDate)}): ${status}`;
  if (r.requestedBy && r.requestedBy !== viewer.userId) await notify(db, [r.requestedBy], { moduleId: "abwesenheiten", title, href: "/abwesenheiten" });
  if (approve) {
    const leaders = (await classOf(db, r.studentId)).leaderIds.filter((l) => l !== viewer.userId && l !== r.requestedBy);
    await notify(db, leaders, { moduleId: "abwesenheiten", title, body: "Die Fehlstunden im Zeitraum gelten als entschuldigt (beurlaubt).", href: "/abwesenheiten" });
  }
}

/** Antragsteller:in zieht einen noch offenen Antrag zurück (Datensatz wird gelöscht). */
export async function withdrawLeave(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  const [r] = await db.select().from(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id));
  if (!r || r.requestedBy !== viewer.userId) throw new ForbiddenError("abwesenheiten.leave_request");
  if (r.status !== "beantragt") throw new ValidationError({ id: "Über den Antrag ist schon entschieden" });
  await db.delete(absenceLeaveRequests).where(eq(absenceLeaveRequests.id, id));
  await audit(db, viewer.userId, "abwesenheiten.leave.withdraw", r.studentId, { from: r.fromDate, to: r.toDate });
}

export interface LeaveRow {
  id: string;
  studentId: string;
  studentName: string;
  groupName: string | null;
  fromDate: string;
  toDate: string;
  schoolDays: number;
  reason: AbsenceLeaveRequest["reason"];
  decider: AbsenceLeaveRequest["decider"];
  status: AbsenceLeaveRequest["status"];
  requestedBy: string | null;
  requestedByName: string | null;
  decidedByName: string | null;
}

async function listLeaves(db: Db, where: ReturnType<typeof and>): Promise<LeaveRow[]> {
  const student = alias(users, "student");
  const requester = alias(users, "requester");
  const decider = alias(users, "decider");
  const rows = await db
    .select({ r: absenceLeaveRequests, studentName: student.name, requestedByName: requester.name, decidedByName: decider.name })
    .from(absenceLeaveRequests)
    .innerJoin(student, eq(student.id, absenceLeaveRequests.studentId))
    .leftJoin(requester, eq(requester.id, absenceLeaveRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, absenceLeaveRequests.decidedBy))
    .where(where)
    .orderBy(desc(absenceLeaveRequests.fromDate), desc(absenceLeaveRequests.createdAt));
  const ids = [...new Set(rows.map((r) => r.r.studentId))];
  const classes = ids.length
    ? await db
        .select({ userId: groupMembers.userId, name: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(inArray(groupMembers.userId, ids), eq(groups.kind, "klasse")))
    : [];
  const classOfStudent = new Map(classes.map((c) => [c.userId, c.name]));
  const out = rows.map(({ r, studentName, requestedByName, decidedByName }) => ({
    id: r.id,
    studentId: r.studentId,
    studentName,
    groupName: classOfStudent.get(r.studentId) ?? null,
    fromDate: r.fromDate,
    toDate: r.toDate,
    schoolDays: r.schoolDays,
    reason: r.reason,
    decider: r.decider,
    status: r.status,
    requestedBy: r.requestedBy,
    requestedByName,
    decidedByName,
  }));
  // offene zuerst, sonst nach Datum (neueste zuerst)
  return out.sort((a, b) => Number(b.status === "beantragt") - Number(a.status === "beantragt"));
}

/** Anträge zu diesen Schüler:innen (Eltern- bzw. Klassenleitungssicht; die Auswahl der Schüler:innen prüft der Aufrufer). */
export async function leavesFor(db: Db, studentIds: readonly string[]): Promise<LeaveRow[]> {
  if (studentIds.length === 0) return [];
  return listLeaves(db, and(inArray(absenceLeaveRequests.studentId, [...studentIds])));
}

/** Klassenleitung: Anträge der eigenen Schüler:innen, mit „darf entscheiden“. */
export async function leaderLeaves(db: Db, viewer: PermissionSet, studentIds: readonly string[]): Promise<(LeaveRow & { canDecide: boolean })[]> {
  const rows = await leavesFor(db, studentIds);
  const sl = hasPermission(viewer, "abwesenheiten.leave_decide");
  return rows.map((r) => ({ ...r, canDecide: r.status === "beantragt" && (sl || r.decider === "klassenleitung") }));
}

/** Schulleitung: alle Anträge über der Grenze – offene und die der letzten 30 Tage. */
export async function principalLeaves(db: Db, viewer: PermissionSet, todayYmd: string): Promise<LeaveRow[]> {
  if (!hasPermission(viewer, "abwesenheiten.leave_decide")) throw new ForbiddenError("abwesenheiten.leave_decide");
  return listLeaves(
    db,
    and(eq(absenceLeaveRequests.decider, "schulleitung"), or(eq(absenceLeaveRequests.status, "beantragt"), gte(absenceLeaveRequests.toDate, addDays(todayYmd, -30)))),
  );
}
