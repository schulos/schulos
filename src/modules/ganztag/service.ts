// Ganztag – Anwesenheitslisten (GT-01…GT-03, docs/GANZTAG.md).
// Angebote sind Gruppen der Arten AG/Förderkurs/frei mit Merkmal `ganztag.liste`. Rechte prüft der Service selbst:
// „Ganztag verwalten“ (`ganztag.manage`) darf alles, die Gruppenleitung nur ihre eigenen Angebote. Termine entstehen aus
// Serien (Ferien, Feiertage und unterrichtsfreie Tage übersprungen) oder einzeln; Listen starten leer, „alle anwesend“ ist ein
// Schalter. Keine Gründe, kein Freitext, keine Schreibverbindung ins Klassenbuch.
import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  ganztagGroupSettings,
  ganztagMarks,
  ganztagSeries,
  ganztagSessions,
  groupMembers,
  groups,
  schoolYears,
  users,
  type GanztagMarkStatus,
  type GanztagSessionStatus,
  type GroupKind,
} from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { readModuleSetting } from "@/core/modules/settings";
import { notify } from "@/core/notifications";
import { accessBlocked, ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { loadSchoolCalendar, dayOffLabel, type SchoolCalendar } from "@/core/school/calendar";
import { guardianRecipients } from "@/core/school/majority";
import { addDays, isCalendarDate, toBerlinDate, weekdayMon0 } from "@/core/time";
import { setGroupFeature } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { EDIT_DAYS } from "./settings";

export const MANAGE = "ganztag.manage";
export const VIEW_ALL = "ganztag.view_all";
export const LIST_FEATURE = "ganztag.liste";
/** Entscheidung Projektleitung 2026-10-28: Listen nur für AGs, Förderkurse und freie Gruppen (keine Klassen/Fachkurse). */
export const LIST_KINDS: readonly GroupKind[] = ["ag", "foerderkurs", "frei"];

export const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"] as const;
const SHORT_DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Darf alle Angebote verwalten (Merkmal, Termine, Listen). */
export const canManage = (p: PermissionSet) => hasPermission(p, MANAGE);
/** Leitet diese Person die Gruppe? (Gruppenleitung, nicht gesperrt) */
export const leads = (p: PermissionSet, groupId: string) => !accessBlocked(p) && p.leaderOf.has(groupId);
/** Termine und Listen dieser Gruppe pflegen: Verwaltende oder die Leitung. */
export const canRun = (p: PermissionSet, groupId: string) => canManage(p) || leads(p, groupId);

// ---------------------------------------------------------------- rein (getestet ohne DB)

/** „14:00“ bzw. „9:05“ → „09:05“; sonst null. */
export function parseTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** „Di, 03.11.2026“ */
export function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${SHORT_DAYS[weekdayMon0(ymd)]}, ${d}.${m}.${y}`;
}

/**
 * Termine einer Serie: jeder `weekday` (0 = Montag) zwischen `from` und `to` (einschließlich), an dem Unterricht ist – Ferien,
 * Feiertage und unterrichtsfreie Tage werden übersprungen und mit Grund zurückgegeben.
 */
export function seriesDates(cal: SchoolCalendar, weekday: number, from: string, to: string): { dates: string[]; skipped: { date: string; reason: string }[] } {
  const dates: string[] = [];
  const skipped: { date: string; reason: string }[] = [];
  let d = addDays(from, (weekday - weekdayMon0(from) + 7) % 7);
  for (; d <= to; d = addDays(d, 7)) {
    const off = cal.dayOff(d);
    if (off) skipped.push({ date: d, reason: dayOffLabel(off) });
    else dates.push(d);
  }
  return { dates, skipped };
}

export type RecordState = "offen" | "zukunft" | "abgelaufen" | "ausgefallen";

/**
 * Darf die Liste jetzt erfasst werden? Nicht vor dem Tag, nicht bei Ausfall; die Leitung nur bis `editDays` Tage danach,
 * „Ganztag verwalten“ auch später (Nachtrag nach Papierliste).
 */
export function recordState(session: { date: string; status: GanztagSessionStatus }, today: string, editDays: number, manager: boolean): RecordState {
  if (session.status === "ausgefallen") return "ausgefallen";
  if (session.date > today) return "zukunft";
  if (!manager && session.date < addDays(today, -editDays)) return "abgelaufen";
  return "offen";
}

// ---------------------------------------------------------------- Angebote (Gruppen mit Merkmal)

// Spalten in Unterabfragen ausdrücklich qualifizieren (drizzle schreibt sie dort ohne Tabellennamen)
const hasListFeature = sql<boolean>`exists (select 1 from "group_features" gf where gf."group_id" = "groups"."id" and gf."feature" = ${LIST_FEATURE})`;

async function leaderNames(db: Db, groupIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ groupId: groupMembers.groupId, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, groupIds), eq(groupMembers.role, "leader")))
    .orderBy(de(users.lastName), de(users.firstName));
  for (const r of rows) out.set(r.groupId, [...(out.get(r.groupId) ?? []), r.name]);
  return out;
}

/** Ist die Gruppe ein Angebot mit Anwesenheitsliste? (passende Art, nicht archiviert, Merkmal an) */
async function loadOffer(db: Db, groupId: string) {
  const [g] = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, archivedAt: groups.archivedAt, listOn: hasListFeature })
    .from(groups)
    .where(eq(groups.id, groupId));
  if (!g || g.archivedAt || !LIST_KINDS.includes(g.kind) || !g.listOn) return null;
  return { id: g.id, name: g.name, kind: g.kind };
}

async function requireOffer(db: Db, viewer: PermissionSet, groupId: string) {
  if (!canRun(viewer, groupId)) throw new ForbiddenError(MANAGE);
  const offer = await loadOffer(db, groupId);
  if (!offer) throw new ForbiddenError(`${MANAGE} (keine Anwesenheitsliste)`);
  return offer;
}

export interface EligibleGroup {
  id: string;
  name: string;
  kind: GroupKind;
  members: number;
  leaders: string[];
  listOn: boolean;
}

/** Verwaltung: alle Gruppen, für die sich die Liste einschalten lässt (AG, Förderkurs, frei; nicht archiviert). */
export async function listEligibleGroups(db: Db, viewer: PermissionSet): Promise<EligibleGroup[]> {
  if (!canManage(viewer)) throw new ForbiddenError(MANAGE);
  const memberCount = sql<number>`(select count(*)::int from "group_members" gm where gm."group_id" = "groups"."id" and gm."role" = 'member')`;
  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, members: memberCount, listOn: hasListFeature })
    .from(groups)
    .where(and(inArray(groups.kind, [...LIST_KINDS]), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
  const leaders = await leaderNames(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, members: Number(r.members), listOn: !!r.listOn, leaders: leaders.get(r.id) ?? [] }));
}

/** Merkmal `ganztag.liste` schalten (nur „Ganztag verwalten“, nur passende Gruppenarten). Daten bleiben beim Ausschalten. */
export async function setListFeature(db: Db, viewer: PermissionSet, groupId: string, on: boolean): Promise<void> {
  if (!canManage(viewer)) throw new ForbiddenError(MANAGE);
  const [g] = await db.select({ kind: groups.kind, archivedAt: groups.archivedAt }).from(groups).where(eq(groups.id, groupId));
  if (!g) throw new ValidationError({ groupId: "Gruppe nicht gefunden" });
  if (on && (g.archivedAt || !LIST_KINDS.includes(g.kind))) throw new ValidationError({ groupId: "Anwesenheitslisten gibt es nur für AGs, Förderkurse und freie Gruppen" });
  await setGroupFeature(db, viewer.userId, groupId, LIST_FEATURE, on);
  if (on) await db.insert(ganztagGroupSettings).values({ groupId }).onConflictDoNothing();
}

export interface OfferSummary {
  id: string;
  name: string;
  kind: GroupKind;
  leaders: string[];
  /** Termine heute (auch ausgefallene) */
  today: { id: string; startsAt: string; endsAt: string; status: GanztagSessionStatus }[];
  /** nächster Termin ab morgen (ohne ausgefallene) */
  next: { id: string; date: string; startsAt: string } | null;
  /** vergangene Termine im Erfassungsfenster, die noch nicht erfasst sind */
  open: number;
}

/** Angebote des Betrachters: „Ganztag verwalten“ alle, die Leitung ihre eigenen. */
export async function listOffers(db: Db, viewer: PermissionSet, now = new Date()): Promise<OfferSummary[]> {
  const today = toBerlinDate(now);
  const manager = canManage(viewer);
  const mine = [...viewer.leaderOf];
  if (!manager && (mine.length === 0 || accessBlocked(viewer))) return [];
  const gs = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind })
    .from(groups)
    .where(and(inArray(groups.kind, [...LIST_KINDS]), isNull(groups.archivedAt), sql`${hasListFeature}`, manager ? undefined : inArray(groups.id, mine)))
    .orderBy(de(groups.name));
  if (gs.length === 0) return [];
  const ids = gs.map((g) => g.id);
  const editDays = Number(await readModuleSetting(db, EDIT_DAYS));
  const [leaders, sessions] = await Promise.all([
    leaderNames(db, ids),
    db
      .select({ id: ganztagSessions.id, groupId: ganztagSessions.groupId, date: ganztagSessions.date, startsAt: ganztagSessions.startsAt, endsAt: ganztagSessions.endsAt, status: ganztagSessions.status })
      .from(ganztagSessions)
      .where(and(inArray(ganztagSessions.groupId, ids), sql`${ganztagSessions.date} >= ${addDays(today, -Math.max(editDays, 30))}`))
      .orderBy(asc(ganztagSessions.date), asc(ganztagSessions.startsAt)),
  ]);
  return gs.map((g) => {
    const own = sessions.filter((s) => s.groupId === g.id);
    const next = own.find((s) => s.date > today && s.status !== "ausgefallen");
    return {
      ...g,
      leaders: leaders.get(g.id) ?? [],
      today: own.filter((s) => s.date === today).map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, status: s.status })),
      next: next ? { id: next.id, date: next.date, startsAt: next.startsAt } : null,
      open: own.filter((s) => s.date < today && s.status === "geplant" && recordState(s, today, editDays, manager) === "offen").length,
    };
  });
}

export interface SessionRow {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  status: GanztagSessionStatus;
  seriesId: string | null;
  marks: number;
}

export interface OfferDetail {
  group: { id: string; name: string; kind: GroupKind };
  leaders: string[];
  members: number;
  series: { id: string; weekday: number; startsAt: string; endsAt: string; validFrom: string; validTo: string; sessions: number }[];
  sessions: SessionRow[];
  /** Vorgabe für neue Serien: das laufende Schuljahr ab heute */
  defaults: { validFrom: string; validTo: string };
}

/** Ein Angebot mit Serien und Terminen – null, wenn es nicht sichtbar ist (keine Leitung/kein Verwalten oder Liste aus). */
export async function getOffer(db: Db, viewer: PermissionSet, groupId: string, now = new Date()): Promise<OfferDetail | null> {
  if (!canRun(viewer, groupId)) return null;
  const offer = await loadOffer(db, groupId);
  if (!offer) return null;
  const today = toBerlinDate(now);
  const markCount = sql<number>`(select count(*)::int from "ganztag_marks" gm where gm."session_id" = "ganztag_sessions"."id")`;
  const [leaders, [members], series, sessions, year] = await Promise.all([
    leaderNames(db, [groupId]),
    db.select({ n: count() }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "member"))),
    db
      .select({
        id: ganztagSeries.id,
        weekday: ganztagSeries.weekday,
        startsAt: ganztagSeries.startsAt,
        endsAt: ganztagSeries.endsAt,
        validFrom: ganztagSeries.validFrom,
        validTo: ganztagSeries.validTo,
        sessions: sql<number>`(select count(*)::int from "ganztag_sessions" gs where gs."series_id" = "ganztag_series"."id")`,
      })
      .from(ganztagSeries)
      .where(eq(ganztagSeries.groupId, groupId))
      .orderBy(asc(ganztagSeries.weekday), asc(ganztagSeries.startsAt), asc(ganztagSeries.validFrom)),
    db
      .select({
        id: ganztagSessions.id,
        date: ganztagSessions.date,
        startsAt: ganztagSessions.startsAt,
        endsAt: ganztagSessions.endsAt,
        status: ganztagSessions.status,
        seriesId: ganztagSessions.seriesId,
        marks: markCount,
      })
      .from(ganztagSessions)
      .where(eq(ganztagSessions.groupId, groupId))
      .orderBy(asc(ganztagSessions.date), asc(ganztagSessions.startsAt)),
    currentYear(db, today),
  ]);
  return {
    group: offer,
    leaders: leaders.get(groupId) ?? [],
    members: members?.n ?? 0,
    series: series.map((s) => ({ ...s, sessions: Number(s.sessions) })),
    sessions: sessions.map((s) => ({ ...s, marks: Number(s.marks) })),
    defaults: { validFrom: year && year.startsOn > today ? year.startsOn : today, validTo: year?.endsOn ?? addDays(today, 180) },
  };
}

/** Schuljahr, in dem `ymd` liegt (sonst das als aktuell markierte). */
async function yearOf(db: Db, ymd: string) {
  const rows = await db.select({ id: schoolYears.id, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn, isCurrent: schoolYears.isCurrent }).from(schoolYears);
  return rows.find((y) => y.startsOn <= ymd && ymd <= y.endsOn) ?? null;
}

async function currentYear(db: Db, today: string) {
  const rows = await db.select({ id: schoolYears.id, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn, isCurrent: schoolYears.isCurrent }).from(schoolYears);
  return rows.find((y) => y.startsOn <= today && today <= y.endsOn) ?? rows.find((y) => y.isCurrent) ?? null;
}

// ---------------------------------------------------------------- Serien und Termine (GT-02)

export interface SeriesInput {
  weekday: number;
  startsAt: string;
  endsAt: string;
  validFrom: string;
  validTo: string;
}

function checkTimes(startsAt: string, endsAt: string, errors: Record<string, string>) {
  const s = parseTime(startsAt);
  const e = parseTime(endsAt);
  if (!s) errors.startsAt = "Beginn als Uhrzeit angeben, z. B. 14:00";
  if (!e) errors.endsAt = "Ende als Uhrzeit angeben, z. B. 15:30";
  if (s && e && e <= s) errors.endsAt = "Das Ende muss nach dem Beginn liegen";
  return { s: s ?? "", e: e ?? "" };
}

/**
 * Serie anlegen und ihre Termine erzeugen (Ferien, Feiertage, unterrichtsfreie Tage übersprungen). Termine, die es zur selben
 * Zeit am selben Tag schon gibt, bleiben unverändert. Gültigkeit höchstens ein Jahr.
 */
export async function createSeries(
  db: Db,
  viewer: PermissionSet,
  groupId: string,
  input: SeriesInput,
  cal?: SchoolCalendar,
): Promise<{ seriesId: string; created: number; skipped: { date: string; reason: string }[] }> {
  await requireOffer(db, viewer, groupId);
  const errors: Record<string, string> = {};
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 4) errors.weekday = "Wochentag wählen (Montag bis Freitag)";
  const { s, e } = checkTimes(input.startsAt, input.endsAt, errors);
  if (!isCalendarDate(input.validFrom)) errors.validFrom = "Datum angeben";
  if (!isCalendarDate(input.validTo)) errors.validTo = "Datum angeben";
  else if (isCalendarDate(input.validFrom) && input.validTo < input.validFrom) errors.validTo = "Das Ende muss nach dem Beginn liegen";
  else if (isCalendarDate(input.validFrom) && input.validTo > addDays(input.validFrom, 366)) errors.validTo = "Eine Serie gilt höchstens ein Jahr";
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const calendar = cal ?? (await loadSchoolCalendar(db));
  const { dates, skipped } = seriesDates(calendar, input.weekday, input.validFrom, input.validTo);
  if (dates.length === 0) throw new ValidationError({ validTo: "In diesem Zeitraum fällt kein Termin auf einen Schultag" });
  const year = await yearOf(db, input.validFrom);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ganztagSeries)
      .values({ groupId, schoolYearId: year?.id ?? null, weekday: input.weekday, startsAt: s, endsAt: e, validFrom: input.validFrom, validTo: input.validTo })
      .returning({ id: ganztagSeries.id });
    const seriesId = row!.id;
    const inserted = await tx
      .insert(ganztagSessions)
      .values(dates.map((date) => ({ groupId, seriesId, date, startsAt: s, endsAt: e })))
      .onConflictDoNothing()
      .returning({ id: ganztagSessions.id });
    await audit(tx, viewer.userId, "ganztag.series.create", seriesId, { groupId, weekday: input.weekday, from: input.validFrom, to: input.validTo, sessions: inserted.length });
    return { seriesId, created: inserted.length, skipped };
  });
}

/** Serie löschen: noch nicht erfasste Termine gehen mit, erfasste bleiben als Einzeltermine stehen. */
export async function deleteSeries(db: Db, viewer: PermissionSet, seriesId: string): Promise<{ removed: number; kept: number }> {
  const [s] = await db.select({ groupId: ganztagSeries.groupId }).from(ganztagSeries).where(eq(ganztagSeries.id, seriesId));
  if (!s) throw new ValidationError({ seriesId: "Serie nicht gefunden" });
  await requireOffer(db, viewer, s.groupId);
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(ganztagSessions)
      .where(and(eq(ganztagSessions.seriesId, seriesId), ne(ganztagSessions.status, "erfasst")))
      .returning({ id: ganztagSessions.id });
    const [kept] = await tx.select({ n: count() }).from(ganztagSessions).where(eq(ganztagSessions.seriesId, seriesId));
    await tx.delete(ganztagSeries).where(eq(ganztagSeries.id, seriesId));
    await audit(tx, viewer.userId, "ganztag.series.delete", seriesId, { groupId: s.groupId, removed: removed.length, kept: kept?.n ?? 0 });
    return { removed: removed.length, kept: kept?.n ?? 0 };
  });
}

/** Einzeltermin anlegen (auch außerhalb der Schultage, z. B. Ausflug in den Ferien – bewusst nicht gesperrt). */
export async function createSession(db: Db, viewer: PermissionSet, groupId: string, input: { date: string; startsAt: string; endsAt: string }): Promise<string> {
  await requireOffer(db, viewer, groupId);
  const errors: Record<string, string> = {};
  if (!isCalendarDate(input.date)) errors.date = "Datum angeben";
  const { s, e } = checkTimes(input.startsAt, input.endsAt, errors);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const [row] = await db.insert(ganztagSessions).values({ groupId, date: input.date, startsAt: s, endsAt: e }).onConflictDoNothing().returning({ id: ganztagSessions.id });
  if (!row) throw new ValidationError({ startsAt: "Zu dieser Zeit gibt es an dem Tag schon einen Termin" });
  await audit(db, viewer.userId, "ganztag.session.create", row.id, { groupId, date: input.date });
  return row.id;
}

async function loadSession(db: Db, sessionId: string) {
  const [s] = await db.select().from(ganztagSessions).where(eq(ganztagSessions.id, sessionId));
  return s ?? null;
}

/** Teilnehmende einer Gruppe: Mitglieder (nicht Leitung) mit der Rolle Schüler:in. */
async function participantIds(db: Db, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "member"), eq(users.role, "schueler")));
  return rows.map((r) => r.id);
}

/**
 * Ausfall markieren bzw. zurücknehmen. Nur Termine ohne Erfassung. Liegt der Termin heute oder später, bekommen Teilnehmende und
 * Eltern (minderjähriger bzw. mit Einwilligung informierter) einen Gong – ohne Grund.
 */
export async function setSessionCancelled(db: Db, viewer: PermissionSet, sessionId: string, cancelled: boolean, now = new Date()): Promise<number> {
  const s = await loadSession(db, sessionId);
  if (!s) throw new ValidationError({ sessionId: "Termin nicht gefunden" });
  const offer = await requireOffer(db, viewer, s.groupId);
  if (cancelled && s.status === "erfasst") throw new ValidationError({ sessionId: "Der Termin ist schon erfasst – erst die Liste leeren" });
  if (cancelled === (s.status === "ausgefallen")) return 0;
  await db
    .update(ganztagSessions)
    .set({ status: cancelled ? "ausgefallen" : "geplant", cancelledAt: cancelled ? now : null })
    .where(eq(ganztagSessions.id, sessionId));
  await audit(db, viewer.userId, cancelled ? "ganztag.session.cancel" : "ganztag.session.reinstate", sessionId, { groupId: s.groupId, date: s.date });
  if (s.date < toBerlinDate(now)) return 0;
  const students = await participantIds(db, s.groupId);
  const recipients = [...students, ...(await guardianRecipients(db, students, { withInformed: true }))];
  const when = `${dateLabel(s.date)}, ${s.startsAt}–${s.endsAt} Uhr`;
  return notify(db, recipients, {
    moduleId: "ganztag",
    title: cancelled ? `${offer.name} fällt aus` : `${offer.name} findet doch statt`,
    body: when,
  });
}

/** Termin löschen: die Leitung nur ohne Erfassung, „Ganztag verwalten“ auch mit (Markierungen gehen mit). */
export async function deleteSession(db: Db, viewer: PermissionSet, sessionId: string): Promise<string> {
  const s = await loadSession(db, sessionId);
  if (!s) throw new ValidationError({ sessionId: "Termin nicht gefunden" });
  await requireOffer(db, viewer, s.groupId);
  if (s.status === "erfasst" && !canManage(viewer)) throw new ValidationError({ sessionId: "Erfasste Termine löscht nur die Verwaltung des Ganztags" });
  await db.delete(ganztagSessions).where(eq(ganztagSessions.id, sessionId));
  await audit(db, viewer.userId, "ganztag.session.delete", sessionId, { groupId: s.groupId, date: s.date, status: s.status });
  return s.groupId;
}

// ---------------------------------------------------------------- Liste erfassen (GT-03)

export interface ListRow {
  studentId: string;
  name: string;
  className: string | null;
  status: GanztagMarkStatus | null;
  minutesLate: number | null;
  /** nicht (mehr) Mitglied der Gruppe – nur sichtbar, weil eine Markierung existiert */
  former: boolean;
}

export interface SessionList {
  session: { id: string; date: string; startsAt: string; endsAt: string; status: GanztagSessionStatus; allPresent: boolean };
  group: { id: string; name: string };
  rows: ListRow[];
  state: RecordState;
  editDays: number;
  counts: { anwesend: number; fehlt: number; verspaetet: number; offen: number };
}

/** Liste eines Termins (nur Leitung der Gruppe bzw. „Ganztag verwalten“) – null, wenn nicht sichtbar. */
export async function getSessionList(db: Db, viewer: PermissionSet, sessionId: string, now = new Date()): Promise<SessionList | null> {
  const s = await loadSession(db, sessionId);
  if (!s || !canRun(viewer, s.groupId)) return null;
  const offer = await loadOffer(db, s.groupId);
  if (!offer) return null;
  const editDays = Number(await readModuleSetting(db, EDIT_DAYS));
  const ids = await participantIds(db, s.groupId);
  const marks = await db.select().from(ganztagMarks).where(eq(ganztagMarks.sessionId, sessionId));
  const all = [...new Set([...ids, ...marks.map((m) => m.studentId)])];
  const people = all.length
    ? await db
        .select({ id: users.id, name: users.name, lastName: users.lastName, firstName: users.firstName })
        .from(users)
        .where(inArray(users.id, all))
        .orderBy(de(users.lastName), de(users.firstName))
    : [];
  const classes = all.length
    ? await db
        .select({ userId: groupMembers.userId, name: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(inArray(groupMembers.userId, all), eq(groups.kind, "klasse"), isNull(groups.archivedAt), eq(groupMembers.role, "member")))
    : [];
  const classOf = new Map(classes.map((c) => [c.userId, c.name]));
  const markOf = new Map(marks.map((m) => [m.studentId, m]));
  const member = new Set(ids);
  const rows: ListRow[] = people.map((p) => {
    const m = markOf.get(p.id);
    return { studentId: p.id, name: p.name, className: classOf.get(p.id) ?? null, status: m?.status ?? null, minutesLate: m?.minutesLate ?? null, former: !member.has(p.id) };
  });
  const counts = { anwesend: 0, fehlt: 0, verspaetet: 0, offen: 0 };
  for (const r of rows) counts[r.status ?? "offen"]++;
  return {
    session: { id: s.id, date: s.date, startsAt: s.startsAt, endsAt: s.endsAt, status: s.status, allPresent: s.allPresent },
    group: { id: offer.id, name: offer.name },
    rows,
    state: recordState(s, toBerlinDate(now), editDays, canManage(viewer)),
    editDays,
    counts,
  };
}

async function requireRecordable(db: Db, viewer: PermissionSet, sessionId: string, now: Date) {
  const s = await loadSession(db, sessionId);
  if (!s) throw new ValidationError({ sessionId: "Termin nicht gefunden" });
  await requireOffer(db, viewer, s.groupId);
  const editDays = Number(await readModuleSetting(db, EDIT_DAYS));
  const state = recordState(s, toBerlinDate(now), editDays, canManage(viewer));
  if (state === "zukunft") throw new ValidationError({ sessionId: "Die Liste lässt sich erst am Tag des Termins erfassen" });
  if (state === "ausgefallen") throw new ValidationError({ sessionId: "Der Termin ist ausgefallen" });
  if (state === "abgelaufen") throw new ValidationError({ sessionId: `Nachtragen geht nur bis ${editDays} Tage nach dem Termin – bitte an die Verwaltung des Ganztags wenden` });
  return s;
}

/** Status nach einer Änderung: erfasst, sobald es eine Markierung gibt, sonst wieder geplant. */
async function refreshStatus(tx: Db, sessionId: string, viewer: PermissionSet, now: Date) {
  const [n] = await tx.select({ n: count() }).from(ganztagMarks).where(eq(ganztagMarks.sessionId, sessionId));
  const recorded = (n?.n ?? 0) > 0;
  await tx
    .update(ganztagSessions)
    .set(recorded ? { status: "erfasst", recordedAt: now, recordedBy: viewer.userId } : { status: "geplant", recordedAt: null, recordedBy: null })
    .where(eq(ganztagSessions.id, sessionId));
}

/**
 * Eine Zeile setzen: anwesend / fehlt / verspätet (mit Minuten) oder leeren (`null`). Nur für Teilnehmende der Gruppe bzw. Zeilen,
 * die schon eine Markierung haben.
 */
export async function setMark(
  db: Db,
  viewer: PermissionSet,
  sessionId: string,
  studentId: string,
  status: GanztagMarkStatus | null,
  minutesLate: number | null = null,
  now = new Date(),
): Promise<void> {
  const s = await requireRecordable(db, viewer, sessionId, now);
  const [existing] = await db.select({ id: ganztagMarks.studentId }).from(ganztagMarks).where(and(eq(ganztagMarks.sessionId, sessionId), eq(ganztagMarks.studentId, studentId)));
  if (!existing && !(await participantIds(db, s.groupId)).includes(studentId)) throw new ValidationError({ studentId: "Nicht in dieser Gruppe" });
  let late: number | null = null;
  if (status === "verspaetet" && minutesLate !== null) {
    if (!Number.isInteger(minutesLate) || minutesLate < 1 || minutesLate > 240) throw new ValidationError({ minutesLate: "Minuten zwischen 1 und 240" });
    late = minutesLate;
  }
  await db.transaction(async (tx) => {
    if (status === null) await tx.delete(ganztagMarks).where(and(eq(ganztagMarks.sessionId, sessionId), eq(ganztagMarks.studentId, studentId)));
    else
      await tx
        .insert(ganztagMarks)
        .values({ sessionId, studentId, status, minutesLate: late, source: "leitung", recordedBy: viewer.userId, recordedAt: now })
        .onConflictDoUpdate({
          target: [ganztagMarks.sessionId, ganztagMarks.studentId],
          set: { status, minutesLate: late, source: "leitung", recordedBy: viewer.userId, recordedAt: now },
        });
    await refreshStatus(tx, sessionId, viewer, now);
  });
}

/**
 * Schalter „alle anwesend“ (Projektleitung 2026-10-28: Listen starten leer). An: alle Teilnehmenden ohne eigene Markierung werden
 * „anwesend“ (Herkunft `alle_anwesend`). Aus: genau diese Markierungen fallen wieder weg – von Hand gesetzte bleiben.
 */
export async function setAllPresent(db: Db, viewer: PermissionSet, sessionId: string, on: boolean, now = new Date()): Promise<number> {
  const s = await requireRecordable(db, viewer, sessionId, now);
  const ids = await participantIds(db, s.groupId);
  return db.transaction(async (tx) => {
    let changed = 0;
    if (on) {
      if (ids.length) {
        const rows = await tx
          .insert(ganztagMarks)
          .values(ids.map((studentId) => ({ sessionId, studentId, status: "anwesend" as const, source: "alle_anwesend" as const, recordedBy: viewer.userId, recordedAt: now })))
          .onConflictDoNothing()
          .returning({ id: ganztagMarks.studentId });
        changed = rows.length;
      }
    } else {
      const rows = await tx
        .delete(ganztagMarks)
        .where(and(eq(ganztagMarks.sessionId, sessionId), eq(ganztagMarks.source, "alle_anwesend")))
        .returning({ id: ganztagMarks.studentId });
      changed = rows.length;
    }
    await tx.update(ganztagSessions).set({ allPresent: on }).where(eq(ganztagSessions.id, sessionId));
    await refreshStatus(tx, sessionId, viewer, now);
    await audit(tx, viewer.userId, on ? "ganztag.list.all_present" : "ganztag.list.all_present_off", sessionId, { groupId: s.groupId, changed });
    return changed;
  });
}
