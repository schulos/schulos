// Gesprächswunsch (P4-51): Die Lehrkraft lädt die Eltern eines Kindes gezielt ein (Gong + Mail an bestätigte Adressen).
// Bei eigenständigen (volljährigen) Schüler:innen geht der Wunsch an die Person selbst.
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  groupMembers,
  groups,
  schoolYears,
  sprechtagAppointments,
  sprechtagInvitations,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
} from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { sprechtagInviteMail, verifiedEmails } from "./mails";
import { OFFER, TEACHING_KINDS, classNames, eventState, familyRecipients, formatEventDay, getAvailability, getEvent, teachersOfStudent } from "./service";

/** Schüler:innen, die die Lehrkraft am Tag `date` unterrichtet (Stundenplan, Unterrichtsverteilung, Lerngruppen). */
export async function studentsOfTeacher(db: Db, teacherId: string, date: string): Promise<{ id: string; name: string; className: string | null }[]> {
  const [lessons, assigned, member] = await Promise.all([
    db
      .selectDistinct({ id: timetableLessons.groupId })
      .from(timetableLessons)
      .where(and(eq(timetableLessons.teacherId, teacherId), lte(timetableLessons.validFrom, date), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, date)))),
    db
      .selectDistinct({ id: timetableAssignmentGroups.groupId })
      .from(timetableAssignmentGroups)
      .innerJoin(timetableAssignments, eq(timetableAssignments.id, timetableAssignmentGroups.assignmentId))
      .innerJoin(timetableAssignmentTeachers, eq(timetableAssignmentTeachers.assignmentId, timetableAssignments.id))
      .innerJoin(schoolYears, eq(schoolYears.id, timetableAssignments.schoolYearId))
      .where(and(eq(timetableAssignmentTeachers.teacherId, teacherId), lte(schoolYears.startsOn, date), gte(schoolYears.endsOn, date))),
    db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, teacherId)),
  ]);
  const groupIds = [...new Set([...lessons, ...assigned, ...member].map((g) => g.id))];
  if (groupIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: users.id, name: users.name, lastName: users.lastName })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, groupIds), inArray(groups.kind, [...TEACHING_KINDS]), isNull(groups.archivedAt), eq(users.role, "schueler"), eq(users.status, "active")));
  const cls = await classNames(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, className: cls.get(r.id) ?? null })).sort((a, b) => (a.className ?? "").localeCompare(b.className ?? "", "de", { numeric: true }) || a.name.localeCompare(b.name, "de"));
}

export interface InviteOptions {
  /** Mail an bestätigte Adressen (nur mit SMTP bzw. in Entwicklung) */
  mail: boolean;
  school: string;
}

/** Lehrkraft schickt einen Gesprächswunsch – nur an Familien eigener Schüler:innen und nur mit freigegebenen Zeiten. */
export async function inviteFamily(db: Db, perms: PermissionSet, eventId: string, studentId: string, opts: InviteOptions, today: string): Promise<number> {
  if (!hasPermission(perms, OFFER)) throw new ForbiddenError(OFFER);
  const e = await getEvent(db, eventId);
  if (!e || eventState(e, today) === "vorbei") throw new ValidationError({ studentId: "Dieser Sprechtag ist vorbei" });
  if (!(await getAvailability(db, eventId, perms.userId))) throw new ValidationError({ studentId: "Zuerst eigene Zeiten freigeben" });
  if (!(await teachersOfStudent(db, studentId, e.date)).includes(perms.userId)) throw new ValidationError({ studentId: "Schüler:in wählen, die du unterrichtest" });
  const [row] = await db.insert(sprechtagInvitations).values({ eventId, teacherId: perms.userId, studentId }).onConflictDoNothing().returning({ s: sprechtagInvitations.studentId });
  if (!row) throw new ValidationError({ studentId: "Gesprächswunsch ist schon verschickt" });
  const [teacher] = await db.select({ name: users.name }).from(users).where(eq(users.id, perms.userId));
  const [student] = await db.select({ name: users.name, firstName: users.firstName }).from(users).where(eq(users.id, studentId));
  const recipients = await familyRecipients(db, [studentId]);
  const day = formatEventDay(e.date);
  const href = `/sprechtag/buchen?e=${eventId}`;
  await notify(db, recipients, {
    moduleId: "sprechtag",
    title: `Gesprächswunsch von ${teacher?.name ?? "einer Lehrkraft"}`,
    body: `${teacher?.name ?? "Eine Lehrkraft"} möchte am Elternsprechtag (${day}) über ${student?.firstName || student?.name || "Ihr Kind"} sprechen – bitte einen Termin buchen.`,
    href,
  });
  if (opts.mail) {
    const emails = await verifiedEmails(db, recipients);
    for (const to of emails.values()) {
      await enqueueMail(db, { to, ...sprechtagInviteMail({ school: opts.school, teacher: teacher?.name ?? "Eine Lehrkraft", child: student?.firstName || "Ihr Kind", day, link: appUrl(href) }), purpose: "sprechtag-gespraechswunsch" });
    }
  }
  await audit(db, perms.userId, "sprechtag.invite", eventId, { recipients: recipients.length });
  return recipients.length;
}

/** Gesprächswunsch zurücknehmen (nur eigene). */
export async function withdrawInvitation(db: Db, perms: PermissionSet, eventId: string, studentId: string): Promise<void> {
  if (!hasPermission(perms, OFFER)) throw new ForbiddenError(OFFER);
  await db
    .delete(sprechtagInvitations)
    .where(and(eq(sprechtagInvitations.eventId, eventId), eq(sprechtagInvitations.teacherId, perms.userId), eq(sprechtagInvitations.studentId, studentId)));
}

/** Eigene Gesprächswünsche mit Stand (gebucht ja/nein). */
export async function myInvitations(db: Db, eventId: string, teacherId: string) {
  const rows = await db
    .select({ studentId: sprechtagInvitations.studentId, name: users.name, createdAt: sprechtagInvitations.createdAt })
    .from(sprechtagInvitations)
    .innerJoin(users, eq(users.id, sprechtagInvitations.studentId))
    .where(and(eq(sprechtagInvitations.eventId, eventId), eq(sprechtagInvitations.teacherId, teacherId)))
    .orderBy(asc(users.lastName));
  const booked = await db
    .select({ studentId: sprechtagAppointments.studentId, slot: sprechtagAppointments.slot })
    .from(sprechtagAppointments)
    .where(and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.teacherId, teacherId)));
  const cls = await classNames(
    db,
    rows.map((r) => r.studentId),
  );
  return rows.map((r) => ({ ...r, className: cls.get(r.studentId) ?? null, bookedSlot: booked.find((b) => b.studentId === r.studentId)?.slot ?? null }));
}
