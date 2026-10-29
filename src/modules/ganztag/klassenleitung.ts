// GT-04: Klassenleitung – Übersicht der Ganztagszeilen der eigenen Klasse und gebündelter Tageshinweis bei unentschuldigtem
// Fehlen in verpflichtenden Angeboten (Projektleitung 2026-10-28). Nur ein Hinweis: keine Schreibverbindung ins Klassenbuch,
// die Übernahme dorthin bleibt Sache der Klassenleitung. Keine Gründe.
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { auditRead } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  ganztagGroupSettings,
  ganztagMarks,
  ganztagSessions,
  groupFeatures,
  groupMembers,
  groups,
  notifications,
  users,
  type GanztagExcused,
  type GanztagMarkStatus,
} from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { notifyBundled } from "@/core/notifications";
import { accessBlocked, type PermissionSet } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { reconcileSession } from "./abgleich";
import { currentYear, dateLabel, LIST_FEATURE } from "./service";

/** Bündel je Klassenleitung und Tag: höchstens ein Hinweis (`notifications.bundle_key`). */
export const hintBundleKey = (date: string) => `ganztag-fehlen:${date}`;

/** So weit zurück gleicht der Tageslauf „entschuldigt?“ mit den Abwesenheiten ab (Nachmeldungen sind bis 14 Tage möglich). */
const RECONCILE_DAYS = 14;

/** Klassen (nicht archiviert) der Schüler:innen und ihre Leitungen. */
async function classesOf(db: Db, studentIds: readonly string[]) {
  if (studentIds.length === 0) return { classOf: new Map<string, { id: string; name: string }>(), leadersOf: new Map<string, string[]>() };
  const rows = await db
    .select({ userId: groupMembers.userId, groupId: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.userId, [...studentIds]), eq(groupMembers.role, "member"), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  const classOf = new Map(rows.map((r) => [r.userId, { id: r.groupId, name: r.name }]));
  const classIds = [...new Set(rows.map((r) => r.groupId))];
  const leaders = classIds.length
    ? await db
        .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(inArray(groupMembers.groupId, classIds), eq(groupMembers.role, "leader")))
    : [];
  const leadersOf = new Map<string, string[]>();
  for (const l of leaders) leadersOf.set(l.groupId, [...(leadersOf.get(l.groupId) ?? []), l.userId]);
  return { classOf, leadersOf };
}

/**
 * Tageslauf (Job `ganztag-hinweis`, abends): gleicht zuerst „entschuldigt?“ der Zeilen „fehlt“ der letzten 14 Tage mit den
 * Abwesenheiten ab, dann bekommt jede Klassenleitung **einen** gebündelten Hinweis zu den heutigen Terminen verpflichtender
 * Angebote (Hinweis an die Klassenleitung eingeschaltet), in denen Kinder ihrer Klasse ohne Entschuldigung gefehlt haben – mit
 * Angebot und Name, ohne Grund. Je Klassenleitung und Tag höchstens einmal (ein zweiter Lauf schickt nichts).
 */
export async function runClassLeadHints(db: Db, now = new Date()): Promise<{ reconciled: number; sent: number }> {
  const today = toBerlinDate(now);
  // 1. Abgleich: Meldungen, die nach der Erfassung kamen (ohne neue Vorbelegung)
  const recent = await db
    .selectDistinct({ id: ganztagSessions.id, date: ganztagSessions.date })
    .from(ganztagSessions)
    .innerJoin(ganztagMarks, eq(ganztagMarks.sessionId, ganztagSessions.id))
    .where(and(gte(ganztagSessions.date, addDays(today, -RECONCILE_DAYS)), lte(ganztagSessions.date, today), eq(ganztagMarks.status, "fehlt"), ne(ganztagSessions.status, "ausgefallen")));
  let reconciled = 0;
  for (const s of recent) if (await reconcileSession(db, s, [], { prefill: false })) reconciled++;

  // 2. heute unentschuldigt gefehlt in verpflichtenden Angeboten mit Liste
  const rows = await db
    .select({ studentId: ganztagMarks.studentId, studentName: users.name, lastName: users.lastName, firstName: users.firstName, offer: groups.name, startsAt: ganztagSessions.startsAt })
    .from(ganztagMarks)
    .innerJoin(ganztagSessions, eq(ganztagSessions.id, ganztagMarks.sessionId))
    .innerJoin(groups, eq(groups.id, ganztagSessions.groupId))
    .innerJoin(ganztagGroupSettings, eq(ganztagGroupSettings.groupId, groups.id))
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, LIST_FEATURE)))
    .innerJoin(users, eq(users.id, ganztagMarks.studentId))
    .where(
      and(
        eq(ganztagSessions.date, today),
        eq(ganztagSessions.status, "erfasst"),
        isNull(groups.archivedAt),
        eq(ganztagGroupSettings.mandatory, true),
        eq(ganztagGroupSettings.notifyClassLead, true),
        eq(ganztagMarks.status, "fehlt"),
        ne(ganztagMarks.excused, "ja"),
      ),
    )
    .orderBy(de(users.lastName), de(users.firstName), asc(ganztagSessions.startsAt));
  if (rows.length === 0) return { reconciled, sent: 0 };

  const { classOf, leadersOf } = await classesOf(
    db,
    rows.map((r) => r.studentId),
  );
  const perLeader = new Map<string, string[]>();
  for (const r of rows) {
    const cls = classOf.get(r.studentId);
    if (!cls) continue;
    for (const leader of leadersOf.get(cls.id) ?? []) perLeader.set(leader, [...(perLeader.get(leader) ?? []), `${r.studentName} (${cls.name}): ${r.offer}`]);
  }
  // genau einmal je Tag: wer den Hinweis für heute schon hat, bekommt keinen zweiten
  const key = hintBundleKey(today);
  const already = perLeader.size
    ? await db
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(and(eq(notifications.bundleKey, key), inArray(notifications.userId, [...perLeader.keys()])))
    : [];
  for (const a of already) perLeader.delete(a.userId);
  const sent = await notifyBundled(
    db,
    [...perLeader].map(([userId, lines]) => ({
      userId,
      title: `Ganztag: unentschuldigt gefehlt am ${dateLabel(today)}`,
      body: `${[...new Set(lines)].join(" · ")} – Hinweis aus verpflichtenden Angeboten, kein Eintrag im Klassenbuch.`,
      href: "/ganztag/klasse",
    })),
    { moduleId: "ganztag", bundleKey: key },
  );
  return { reconciled, sent };
}

/** Leitet die Person eine (nicht archivierte) Klasse? */
export async function leadsClass(db: Db, viewer: PermissionSet): Promise<boolean> {
  if (accessBlocked(viewer) || viewer.leaderOf.size === 0) return false;
  const [g] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(inArray(groups.id, [...viewer.leaderOf]), eq(groups.kind, "klasse"), isNull(groups.archivedAt)))
    .limit(1);
  return !!g;
}

export interface ClassMarkRow {
  sessionId: string;
  date: string;
  startsAt: string;
  offer: string;
  mandatory: boolean;
  studentId: string;
  studentName: string;
  className: string;
  status: GanztagMarkStatus;
  minutesLate: number | null;
  excused: GanztagExcused;
}

export interface ClassLeadView {
  classes: { id: string; name: string }[];
  /** Teilnahme an Angeboten mit Liste je Schüler:in der Klasse */
  participation: { studentId: string; name: string; className: string; offers: string[] }[];
  /** fehlt/verspätet in diesem Schuljahr (neueste zuerst) */
  rows: ClassMarkRow[];
  /** Termine mit Zeilen aus der Klasse: anwesend/fehlt/verspätet gesamt */
  totals: { anwesend: number; fehlt: number; verspaetet: number; unexcused: number };
}

/**
 * Klassenleitung: Ganztagszeilen der Kinder der eigenen Klasse(n) im laufenden Schuljahr – nur fehlt/verspätet einzeln, anwesend
 * als Zahl. Null, wenn die Person keine Klasse leitet. Lesezugriff wird protokolliert.
 */
export async function classLeadView(db: Db, viewer: PermissionSet, now = new Date()): Promise<ClassLeadView | null> {
  if (accessBlocked(viewer) || viewer.leaderOf.size === 0) return null;
  const classes = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(inArray(groups.id, [...viewer.leaderOf]), eq(groups.kind, "klasse"), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
  if (classes.length === 0) return null;
  const today = toBerlinDate(now);
  const year = await currentYear(db, today);
  const from = year?.startsOn ?? addDays(today, -180);
  const students = await db
    .select({ id: users.id, name: users.name, classId: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, classes.map((c) => c.id)), eq(groupMembers.role, "member"), eq(users.role, "schueler")))
    .orderBy(de(users.lastName), de(users.firstName));
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const ids = students.map((s) => s.id);
  const empty = { classes, participation: [], rows: [], totals: { anwesend: 0, fehlt: 0, verspaetet: 0, unexcused: 0 } };
  if (ids.length === 0) return empty;
  const [offers, marks] = await Promise.all([
    db
      .select({ userId: groupMembers.userId, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, LIST_FEATURE)))
      .where(and(inArray(groupMembers.userId, ids), eq(groupMembers.role, "member"), isNull(groups.archivedAt)))
      .orderBy(de(groups.name)),
    db
      .select({
        sessionId: ganztagSessions.id,
        date: ganztagSessions.date,
        startsAt: ganztagSessions.startsAt,
        offer: groups.name,
        mandatory: ganztagGroupSettings.mandatory,
        studentId: ganztagMarks.studentId,
        status: ganztagMarks.status,
        minutesLate: ganztagMarks.minutesLate,
        excused: ganztagMarks.excused,
      })
      .from(ganztagMarks)
      .innerJoin(ganztagSessions, eq(ganztagSessions.id, ganztagMarks.sessionId))
      .innerJoin(groups, eq(groups.id, ganztagSessions.groupId))
      .leftJoin(ganztagGroupSettings, eq(ganztagGroupSettings.groupId, groups.id))
      .where(and(inArray(ganztagMarks.studentId, ids), gte(ganztagSessions.date, from), lte(ganztagSessions.date, today), ne(ganztagSessions.status, "ausgefallen")))
      .orderBy(desc(ganztagSessions.date), desc(ganztagSessions.startsAt)),
  ]);
  const byId = new Map(students.map((s) => [s.id, s]));
  const totals = { anwesend: 0, fehlt: 0, verspaetet: 0, unexcused: 0 };
  const rows: ClassMarkRow[] = [];
  for (const m of marks) {
    totals[m.status]++;
    if (m.status === "fehlt" && m.excused !== "ja") totals.unexcused++;
    if (m.status === "anwesend") continue;
    const s = byId.get(m.studentId)!;
    rows.push({ ...m, mandatory: m.mandatory ?? false, studentName: s.name, className: className.get(s.classId) ?? "" });
  }
  const offersOf = new Map<string, string[]>();
  for (const o of offers) offersOf.set(o.userId, [...(offersOf.get(o.userId) ?? []), o.name]);
  const participation = students
    .filter((s) => offersOf.has(s.id))
    .map((s) => ({ studentId: s.id, name: s.name, className: className.get(s.classId) ?? "", offers: [...new Set(offersOf.get(s.id))] }));
  await auditRead(db, viewer.userId, "lesen.ganztag", null, { classes: classes.length });
  return { classes, participation, rows, totals };
}
