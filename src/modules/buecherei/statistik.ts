// Schulbücherei – Statistik (BU-05) ohne Personenbezug: Ausleihen je Monat und Medienart (Zähler `buecherei_stats`), Bestand je
// Medienart, nie ausgeliehene Exemplare und Aussonderungsvorschläge (Nutzung je Exemplar: Zahl der Ausleihen und Monat der
// letzten, ohne Person). Keine Auswertung je Person oder Klasse – das gibt das Datenmodell bewusst nicht her.
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiLoans, buechereiStats, buechereiTitles } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { MEDIA_TYPES, type MediaType } from "./labels";

export const canStats = (p: PermissionSet) => hasPermission(p, "buecherei.stock");

function requireStats(p: PermissionSet) {
  if (!canStats(p)) throw new ForbiddenError("buecherei.stock");
}

/** Rein: die letzten `n` Monate bis einschließlich des Monats von `today` („2026-10“), älteste zuerst. */
export function lastMonths(today: string, n: number): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (n - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** Rein: Monat `ym` minus `months` Monate. */
export function monthsBack(ym: string, months: number): string {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 - months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthRow {
  month: string;
  loans: Record<MediaType, number>;
  total: number;
  renewals: number;
  dunnings: number;
}

/** Ausleihen je Monat und Medienart der letzten `months` Monate (auch Monate ohne Ausleihe), dazu Summen. */
export async function loanStatistics(db: Db, viewer: PermissionSet, today: string, months = 12) {
  requireStats(viewer);
  const list = lastMonths(today, months);
  const rows = await db.select().from(buechereiStats).where(gte(buechereiStats.month, list[0]!));
  const empty = () => Object.fromEntries(MEDIA_TYPES.map((m) => [m, 0])) as Record<MediaType, number>;
  const byMonth = new Map<string, MonthRow>(list.map((month) => [month, { month, loans: empty(), total: 0, renewals: 0, dunnings: 0 }]));
  for (const r of rows) {
    const e = byMonth.get(r.month);
    if (!e) continue;
    e.loans[r.mediaType] += r.loans;
    e.total += r.loans;
    e.renewals += r.renewals;
    e.dunnings += r.dunnings;
  }
  const result = [...byMonth.values()];
  const totals = { loans: empty(), total: 0, renewals: 0, dunnings: 0 };
  for (const r of result) {
    for (const m of MEDIA_TYPES) totals.loans[m] += r.loans[m];
    totals.total += r.total;
    totals.renewals += r.renewals;
    totals.dunnings += r.dunnings;
  }
  return { months: result, totals, max: Math.max(0, ...result.map((r) => r.total)) };
}

/** Bestand je Medienart: Titel, Exemplare im Bestand, davon ausgeliehen bzw. nie ausgeliehen, ausgesondert. */
export async function stockStatistics(db: Db, viewer: PermissionSet) {
  requireStats(viewer);
  const rows = await db
    .select({
      mediaType: buechereiTitles.mediaType,
      titles: sql<number>`count(distinct ${buechereiTitles.id})::int`,
      active: sql<number>`(count(${buechereiCopies.id}) filter (where ${buechereiCopies.withdrawnOn} is null))::int`,
      withdrawn: sql<number>`(count(${buechereiCopies.id}) filter (where ${buechereiCopies.withdrawnOn} is not null))::int`,
      never: sql<number>`(count(${buechereiCopies.id}) filter (where ${buechereiCopies.withdrawnOn} is null and ${buechereiCopies.loanCount} = 0))::int`,
      loaned: sql<number>`(count(${buechereiCopies.id}) filter (where exists (select 1 from buecherei_loans l where l.copy_id = ${buechereiCopies.id} and l.returned_on is null)))::int`,
    })
    .from(buechereiTitles)
    .leftJoin(buechereiCopies, eq(buechereiCopies.titleId, buechereiTitles.id))
    .groupBy(buechereiTitles.mediaType);
  const by = new Map(rows.map((r) => [r.mediaType, r]));
  return MEDIA_TYPES.map((m) => {
    const r = by.get(m);
    return { mediaType: m, titles: r?.titles ?? 0, active: r?.active ?? 0, withdrawn: r?.withdrawn ?? 0, never: r?.never ?? 0, loaned: r?.loaned ?? 0 };
  }).filter((r) => r.titles > 0);
}

/** Höchstens so viele Zeilen je Liste („nie ausgeliehen“, Vorschläge). */
export const MAX_LIST = 200;

/**
 * Titel, von denen kein Exemplar im Bestand je ausgeliehen wurde (gezählt ab BU-05), mit Zahl der Exemplare und „im Bestand
 * seit“ (ältestes Exemplar). Älteste zuerst.
 */
export async function neverLoaned(db: Db, viewer: PermissionSet) {
  requireStats(viewer);
  const rows = await db
    .select({
      titleId: buechereiTitles.id,
      title: buechereiTitles.title,
      author: buechereiTitles.author,
      mediaType: buechereiTitles.mediaType,
      copies: sql<number>`count(*)::int`,
      since: sql<string>`to_char(min(${buechereiCopies.createdAt}) at time zone 'Europe/Berlin', 'YYYY-MM-DD')`,
    })
    .from(buechereiCopies)
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .where(isNull(buechereiCopies.withdrawnOn))
    .groupBy(buechereiTitles.id, buechereiTitles.title, buechereiTitles.author, buechereiTitles.mediaType)
    .having(sql`max(${buechereiCopies.loanCount}) = 0`);
  return rows.sort((a, b) => a.since.localeCompare(b.since) || a.title.localeCompare(b.title, "de", { numeric: true })).slice(0, MAX_LIST);
}

export type SuggestionReason = "zustand" | "nie" | "lange";

export interface Suggestion {
  copyId: string;
  titleId: string;
  barcode: string;
  title: string;
  condition: string;
  loanCount: number;
  lastLoanMonth: string | null;
  reason: SuggestionReason;
}

/**
 * Aussonderungsvorschläge (nur Vorschläge – aussondern bleibt eine Entscheidung im Bestand): Exemplare im Regal (nicht
 * ausgeliehen) in schlechtem Zustand, seit mindestens `years` Jahren im Bestand und nie ausgeliehen, oder zuletzt vor mehr
 * als `years` Jahren ausgeliehen.
 */
export async function withdrawalSuggestions(db: Db, viewer: PermissionSet, today: string, years = 3): Promise<Suggestion[]> {
  requireStats(viewer);
  const cutoffMonth = monthsBack(today.slice(0, 7), years * 12);
  const cutoff = new Date(`${cutoffMonth}-01T00:00:00Z`);
  const rows = await db
    .select({
      copyId: buechereiCopies.id,
      titleId: buechereiTitles.id,
      barcode: buechereiCopies.barcode,
      title: buechereiTitles.title,
      condition: buechereiCopies.condition,
      loanCount: buechereiCopies.loanCount,
      lastLoanMonth: buechereiCopies.lastLoanMonth,
    })
    .from(buechereiCopies)
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .leftJoin(buechereiLoans, and(eq(buechereiLoans.copyId, buechereiCopies.id), isNull(buechereiLoans.returnedOn)))
    .where(
      and(
        isNull(buechereiCopies.withdrawnOn),
        isNull(buechereiLoans.id),
        or(
          eq(buechereiCopies.condition, "schlecht"),
          and(eq(buechereiCopies.loanCount, 0), lt(buechereiCopies.createdAt, cutoff)),
          lt(buechereiCopies.lastLoanMonth, cutoffMonth),
        ),
      ),
    )
    .orderBy(buechereiCopies.seq)
    .limit(MAX_LIST);
  return rows.map((r) => ({ ...r, reason: r.condition === "schlecht" ? "zustand" : r.loanCount === 0 ? "nie" : "lange" }));
}
