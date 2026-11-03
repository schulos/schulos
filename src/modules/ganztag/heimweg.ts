// GT-09/GT-10 (Projektleitung 2026-11-03, docs/GANZTAG.md „Folge (Runde 14)“): Heimweg je Teilnehmende:r als *Art* der Regel
// (geht allein / wird abgeholt / Bus) – keine Namen oder Kontaktdaten Abholberechtigter. Eltern (bzw. eigenständige Schüler:innen)
// ändern den Heimweg für einen Termin bis zur Frist am selben Tag (Moduleinstellung, Vorgabe 12:00) mit Gong an die Leitung; die
// Leitung vermerkt „gegangen“, die Uhrzeit bleibt am Termin (Löschung zum Schuljahresende).
import { and, eq, inArray } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { ganztagDepartures, ganztagSessions, ganztagWayHomeRules, groupMembers, groups, users, type GanztagWayHome } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { readModuleSetting } from "@/core/modules/settings";
import { notify } from "@/core/notifications";
import { accessBlocked, ForbiddenError, type PermissionSet } from "@/core/permissions";
import { isParentFor, isSelfResponsible } from "@/core/school/majority";
import { berlinParts, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { WAY_LABEL } from "./labels";
import { GANZTAG_WAY_HOME } from "./schema";
import { canRun, dateLabel, MANAGE, participantIds, requireRecordable } from "./service";
import { WAY_HOME_DEADLINE } from "./settings";


export const isWay = (v: unknown): v is GanztagWayHome => typeof v === "string" && (GANZTAG_WAY_HOME as readonly string[]).includes(v);

/** Frist für Tagesänderungen der Familie als „HH:MM“ (Moduleinstellung in vollen Stunden, Vorgabe 12). */
export async function wayDeadline(db: Db): Promise<string> {
  return `${(await readModuleSetting(db, WAY_HOME_DEADLINE)).padStart(2, "0")}:00`;
}

/** „HH:MM“ der Berliner Ortszeit */
export function berlinTime(d: Date): string {
  const p = berlinParts(d);
  return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
}

/**
 * Rein: Darf die Familie den Heimweg für einen Termin an `date` jetzt noch ändern? Für spätere Tage immer, am Tag selbst nur vor
 * der Frist (`deadline`, „12:00“), vergangene Tage nie.
 */
export function familyMayChange(date: string, now: Date, deadline: string): boolean {
  const today = toBerlinDate(now);
  if (date > today) return true;
  if (date < today) return false;
  return berlinTime(now) < deadline;
}

/** Handelt diese Person für die Schüler:in? Eltern minderjähriger Kinder (`act`), eigenständige Schüler:innen für sich selbst. */
export async function actsFor(db: Db, viewer: PermissionSet, studentId: string): Promise<boolean> {
  if (accessBlocked(viewer)) return false;
  if (viewer.role === "eltern") return isParentFor(db, viewer.userId, studentId, "act");
  if (viewer.role === "schueler" && viewer.userId === studentId) return isSelfResponsible(db, studentId);
  return false;
}

async function leaderIds(db: Db, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "leader")));
  return rows.map((r) => r.id);
}

async function studentName(db: Db, studentId: string): Promise<string> {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, studentId));
  return u?.name ?? "";
}

async function groupName(db: Db, groupId: string): Promise<string> {
  const [g] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId));
  return g?.name ?? "";
}

/** Regeln je Teilnehmende:r eines Angebots. */
export async function wayRulesOf(db: Db, groupId: string, studentIds?: readonly string[]): Promise<Map<string, GanztagWayHome>> {
  if (studentIds && studentIds.length === 0) return new Map();
  const rows = await db
    .select({ studentId: ganztagWayHomeRules.studentId, way: ganztagWayHomeRules.way })
    .from(ganztagWayHomeRules)
    .where(and(eq(ganztagWayHomeRules.groupId, groupId), studentIds ? inArray(ganztagWayHomeRules.studentId, [...studentIds]) : undefined));
  return new Map(rows.map((r) => [r.studentId, r.way]));
}

/**
 * Heimwegregel setzen bzw. löschen (`null`). Dürfen: die Familie (Eltern minderjähriger, eigenständige Schüler:innen selbst),
 * die Leitung des Angebots und „Ganztag verwalten“ (z. B. nach dem Anmeldebogen). Ändert die Familie, bekommt die Leitung einen Gong.
 */
export async function setWayRule(db: Db, viewer: PermissionSet, groupId: string, studentId: string, way: GanztagWayHome | null, now = new Date()): Promise<void> {
  const family = await actsFor(db, viewer, studentId);
  if (!family && !canRun(viewer, groupId)) throw new ForbiddenError(MANAGE);
  if (way !== null && !isWay(way)) throw new ValidationError({ way: "Heimweg wählen" });
  if (!(await participantIds(db, groupId)).includes(studentId)) throw new ValidationError({ studentId: "Nicht in diesem Angebot" });
  if (way === null) await db.delete(ganztagWayHomeRules).where(and(eq(ganztagWayHomeRules.groupId, groupId), eq(ganztagWayHomeRules.studentId, studentId)));
  else
    await db
      .insert(ganztagWayHomeRules)
      .values({ groupId, studentId, way, updatedBy: viewer.userId, updatedAt: now })
      .onConflictDoUpdate({ target: [ganztagWayHomeRules.groupId, ganztagWayHomeRules.studentId], set: { way, updatedBy: viewer.userId, updatedAt: now } });
  await audit(db, viewer.userId, "ganztag.way_home.rule", groupId, { studentId, way });
  if (family) {
    const leaders = (await leaderIds(db, groupId)).filter((id) => id !== viewer.userId);
    await notify(db, leaders, {
      moduleId: "ganztag",
      title: `Heimweg geändert: ${await studentName(db, studentId)}`,
      body: `${await groupName(db, groupId)}: ab jetzt ${way ? WAY_LABEL[way] : "keine Angabe"}`,
      href: `/ganztag/gruppe/${groupId}`,
    });
  }
}

/**
 * Tagesänderung für einen Termin (`null` = es gilt wieder die Regel). Die Familie bis zur Frist am Tag des Termins (mit Gong an die
 * Leitung), Leitung und „Ganztag verwalten“ jederzeit bis zum Ende des Termintags (z. B. nach einem Anruf).
 */
export async function setDayWay(db: Db, viewer: PermissionSet, sessionId: string, studentId: string, way: GanztagWayHome | null, now = new Date()): Promise<void> {
  const [s] = await db.select().from(ganztagSessions).where(eq(ganztagSessions.id, sessionId));
  if (!s) throw new ValidationError({ sessionId: "Termin nicht gefunden" });
  const family = await actsFor(db, viewer, studentId);
  const staff = canRun(viewer, s.groupId);
  if (!family && !staff) throw new ForbiddenError(MANAGE);
  if (way !== null && !isWay(way)) throw new ValidationError({ way: "Heimweg wählen" });
  if (s.status === "ausgefallen") throw new ValidationError({ sessionId: "Der Termin fällt aus" });
  if (!(await participantIds(db, s.groupId)).includes(studentId)) throw new ValidationError({ studentId: "Nicht in diesem Angebot" });
  const today = toBerlinDate(now);
  const deadline = await wayDeadline(db);
  if (s.date < today || (!staff && !familyMayChange(s.date, now, deadline)))
    throw new ValidationError({ way: s.date < today ? "Der Termin ist vorbei" : `Am Tag selbst geht die Änderung nur bis ${deadline} Uhr – bitte direkt bei der Leitung melden` });
  await db
    .insert(ganztagDepartures)
    .values({ sessionId, studentId, way, changedBy: viewer.userId, changedAt: now })
    .onConflictDoUpdate({ target: [ganztagDepartures.sessionId, ganztagDepartures.studentId], set: { way, changedBy: viewer.userId, changedAt: now } });
  await audit(db, viewer.userId, "ganztag.way_home.day", sessionId, { studentId, way });
  if (family) {
    const leaders = (await leaderIds(db, s.groupId)).filter((id) => id !== viewer.userId);
    const rule = (await wayRulesOf(db, s.groupId, [studentId])).get(studentId);
    const shown = way ?? rule;
    await notify(db, leaders, {
      moduleId: "ganztag",
      title: `Heimweg ${s.date === today ? "heute" : `am ${dateLabel(s.date)}`} geändert: ${await studentName(db, studentId)}`,
      body: `${await groupName(db, s.groupId)}, ${s.startsAt} Uhr: ${shown ? WAY_LABEL[shown] : "keine Angabe"}${way === null ? " (wie immer)" : ""}`,
      href: `/ganztag/termin/${sessionId}`,
    });
  }
}

/**
 * GT-10: „gegangen“ vermerken bzw. zurücknehmen – nur die Leitung bzw. „Ganztag verwalten“, nur am Tag des Termins oder danach im
 * Erfassungsfenster (wie die Liste). Die Uhrzeit wird gespeichert.
 */
export async function setLeft(db: Db, viewer: PermissionSet, sessionId: string, studentId: string, left: boolean, now = new Date()): Promise<void> {
  const s = await requireRecordable(db, viewer, sessionId, now);
  if (!(await participantIds(db, s.groupId)).includes(studentId)) throw new ValidationError({ studentId: "Nicht in dieser Gruppe" });
  const values = left ? { leftAt: now, leftBy: viewer.userId } : { leftAt: null, leftBy: null };
  await db
    .insert(ganztagDepartures)
    .values({ sessionId, studentId, ...values })
    .onConflictDoUpdate({ target: [ganztagDepartures.sessionId, ganztagDepartures.studentId], set: values });
  await audit(db, viewer.userId, left ? "ganztag.left" : "ganztag.left_undo", sessionId, { groupId: s.groupId });
}

export interface DepartureInfo {
  /** gilt heute: Tagesänderung, sonst Regel */
  way: GanztagWayHome | null;
  /** Tagesänderung für diesen Termin */
  changed: boolean;
  /** „15:32“ (Berlin) oder null */
  leftAt: string | null;
}

/** Heimweg und „gegangen“ je Teilnehmende:r eines Termins. */
export async function departuresOf(db: Db, session: { id: string; groupId: string }, studentIds: readonly string[]): Promise<Map<string, DepartureInfo>> {
  const out = new Map<string, DepartureInfo>();
  if (studentIds.length === 0) return out;
  const [rules, rows] = await Promise.all([
    wayRulesOf(db, session.groupId, studentIds),
    db.select().from(ganztagDepartures).where(and(eq(ganztagDepartures.sessionId, session.id), inArray(ganztagDepartures.studentId, [...studentIds]))),
  ]);
  const day = new Map(rows.map((r) => [r.studentId, r]));
  for (const id of studentIds) {
    const d = day.get(id);
    out.set(id, { way: d?.way ?? rules.get(id) ?? null, changed: d?.way != null, leftAt: d?.leftAt ? berlinTime(d.leftAt) : null });
  }
  return out;
}

/** Angebotsseite (Leitung bzw. „Ganztag verwalten“): Teilnehmende mit ihrer Heimwegregel – null, wenn nicht sichtbar. */
export async function wayRuleList(db: Db, viewer: PermissionSet, groupId: string): Promise<{ studentId: string; name: string; way: GanztagWayHome | null }[] | null> {
  if (!canRun(viewer, groupId)) return null;
  const ids = await participantIds(db, groupId);
  if (ids.length === 0) return [];
  const [people, rules] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids))
      .orderBy(de(users.lastName), de(users.firstName)),
    wayRulesOf(db, groupId, ids),
  ]);
  return people.map((p) => ({ studentId: p.id, name: p.name, way: rules.get(p.id) ?? null }));
}
