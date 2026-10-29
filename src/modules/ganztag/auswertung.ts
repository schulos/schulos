// GT-06: Verwaltungsübersicht „offen heute“ und Auswertung je Angebot und Monat – ohne Namen (Projektleitung 2026-10-28).
// Die Abfragen lesen keine Schüler-IDs oder -Namen: nur Termine und Zählungen der Markierungen je Termin.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { ganztagMarks, ganztagSessions, groupMembers, groups, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { currentYear, MANAGE, VIEW_ALL } from "./service";

/** Auswertung sehen: „Ganztag auswerten“ oder „Ganztag verwalten“ (liest ohnehin alle Listen). */
export const canEvaluate = (p: PermissionSet) => hasPermission(p, VIEW_ALL) || hasPermission(p, MANAGE);

export interface MonthRow {
  groupId: string;
  offer: string;
  /** „2026-11“ */
  month: string;
  /** Termine ohne Ausfälle */
  sessions: number;
  cancelled: number;
  recorded: number;
  /** vergangene bzw. heutige Termine ohne Erfassung */
  open: number;
  /** Teilnehmertage: anwesend oder verspätet */
  present: number;
  absent: number;
  absentExcused: number;
  late: number;
  /** Anwesenheitsquote in Prozent (anwesend + verspätet je erfasster Zeile), null ohne Erfassung */
  rate: number | null;
}

export interface OpenToday {
  sessionId: string;
  groupId: string;
  offer: string;
  startsAt: string;
  endsAt: string;
  leaders: string[];
}

export interface Evaluation {
  from: string;
  to: string;
  rows: MonthRow[];
  openToday: OpenToday[];
}

/** Monatsname „November 2026“ zu „2026-11“. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"][m! - 1]} ${y}`;
}

/** Auswertung des laufenden Schuljahres bis heute (Termine aller Angebote, auch wenn die Liste inzwischen aus ist). */
export async function evaluation(db: Db, viewer: PermissionSet, now = new Date()): Promise<Evaluation> {
  if (!canEvaluate(viewer)) throw new ForbiddenError(VIEW_ALL);
  const today = toBerlinDate(now);
  const year = await currentYear(db, today);
  const from = year?.startsOn ?? addDays(today, -180);
  const to = today;
  const sessions = await db
    .select({ id: ganztagSessions.id, groupId: ganztagSessions.groupId, offer: groups.name, date: ganztagSessions.date, startsAt: ganztagSessions.startsAt, endsAt: ganztagSessions.endsAt, status: ganztagSessions.status })
    .from(ganztagSessions)
    .innerJoin(groups, eq(groups.id, ganztagSessions.groupId))
    .where(and(gte(ganztagSessions.date, from), lte(ganztagSessions.date, to)))
    .orderBy(asc(ganztagSessions.date), asc(ganztagSessions.startsAt));
  const ids = sessions.map((s) => s.id);
  // nur Zählungen je Termin – keine Schüler-IDs
  const counts = ids.length
    ? await db
        .select({
          sessionId: ganztagMarks.sessionId,
          status: ganztagMarks.status,
          excused: sql<boolean>`${ganztagMarks.excused} = 'ja'`,
          n: sql<number>`count(*)::int`,
        })
        .from(ganztagMarks)
        .where(inArray(ganztagMarks.sessionId, ids))
        .groupBy(ganztagMarks.sessionId, ganztagMarks.status, sql`${ganztagMarks.excused} = 'ja'`)
    : [];
  const bySession = new Map<string, typeof counts>();
  for (const c of counts) bySession.set(c.sessionId, [...(bySession.get(c.sessionId) ?? []), c]);

  const rows = new Map<string, MonthRow>();
  for (const s of sessions) {
    const month = s.date.slice(0, 7);
    const key = `${s.groupId}|${month}`;
    const r =
      rows.get(key) ??
      ({ groupId: s.groupId, offer: s.offer, month, sessions: 0, cancelled: 0, recorded: 0, open: 0, present: 0, absent: 0, absentExcused: 0, late: 0, rate: null } satisfies MonthRow);
    rows.set(key, r);
    if (s.status === "ausgefallen") {
      r.cancelled++;
      continue;
    }
    r.sessions++;
    if (s.status === "geplant") {
      r.open++;
      continue;
    }
    r.recorded++;
    for (const c of bySession.get(s.id) ?? []) {
      const n = Number(c.n);
      if (c.status === "anwesend") r.present += n;
      else if (c.status === "verspaetet") {
        r.present += n;
        r.late += n;
      } else {
        r.absent += n;
        if (c.excused) r.absentExcused += n;
      }
    }
  }
  for (const r of rows.values()) r.rate = r.present + r.absent > 0 ? Math.round((r.present / (r.present + r.absent)) * 100) : null;

  // „offen heute“: heutige Termine ohne Erfassung (wie `listOffers().today`, für alle Angebote)
  const todays = sessions.filter((s) => s.date === today && s.status === "geplant");
  const leaderRows = todays.length
    ? await db
        .select({ groupId: groupMembers.groupId, name: users.name })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(inArray(groupMembers.groupId, [...new Set(todays.map((s) => s.groupId))]), eq(groupMembers.role, "leader")))
        .orderBy(de(users.lastName), de(users.firstName))
    : [];
  const leaders = new Map<string, string[]>();
  for (const l of leaderRows) leaders.set(l.groupId, [...(leaders.get(l.groupId) ?? []), l.name]);
  return {
    from,
    to,
    rows: [...rows.values()].sort((a, b) => a.offer.localeCompare(b.offer, "de") || a.month.localeCompare(b.month)),
    openToday: todays.map((s) => ({ sessionId: s.id, groupId: s.groupId, offer: s.offer, startsAt: s.startsAt, endsAt: s.endsAt, leaders: leaders.get(s.groupId) ?? [] })),
  };
}

export const CSV_HEAD = ["Angebot", "Monat", "Termine", "ausgefallen", "erfasst", "nicht erfasst", "Teilnehmertage", "davon verspätet", "gefehlt", "davon entschuldigt", "Anwesenheitsquote %"];

/** CSV-Zeilen der Auswertung (ohne Namen von Schüler:innen). */
export function evaluationCsvRows(e: Evaluation): (string | number | null)[][] {
  return [CSV_HEAD, ...e.rows.map((r) => [r.offer, r.month, r.sessions, r.cancelled, r.recorded, r.open, r.present, r.late, r.absent, r.absentExcused, r.rate])];
}
