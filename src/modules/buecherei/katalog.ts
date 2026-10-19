// Schulbücherei – Katalog und „Meine Ausleihen“ (BU-03). Der Katalog zeigt Titel mit Verfügbarkeit ohne Personenbezug (wie
// viele frei, wann das nächste zurückkommt, wie viele Vormerkungen – nie wer). „Meine Ausleihen“ zeigt nur Aktuelles: offene
// Ausleihen und Vormerkungen, keinen Verlauf. Eltern sehen das ihrer Kinder lesend (Eltern-Kind-Zuordnung, bei Eigenständigen
// nur mit deren Einwilligung „Eltern informieren“).
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { buechereiCopies, buechereiLoans, buechereiReservations, buechereiTitles } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { childrenOf } from "@/core/school/majority";
import { normalizeIsbn, type MediaType } from "./labels";
import { openLoansOf, renewalBlock, type OpenLoan } from "./loans";
import { availability, canBorrow, canUse, fmtDay, shelfCount, waitingPosition, type Availability } from "./reservations";
import { MAX_RENEWALS } from "./settings";

export { canBorrow, canUse };

function requireUse(p: PermissionSet) {
  if (!canUse(p)) throw new ForbiddenError("buecherei.use");
}

export const CATALOG_LIMIT = 100;

export interface CatalogFilter {
  q?: string;
  mediaType?: MediaType;
  limit?: number;
}

export interface CatalogRow extends Availability {
  id: string;
  title: string;
  author: string | null;
  year: number | null;
  mediaType: MediaType;
  ageFrom: number | null;
  /** frei im Regal (nicht für andere bereitgelegt) */
  shelf: number;
}

/**
 * Katalog (Recht `buecherei.use`): Titel mit mindestens einem Exemplar im Bestand; Suche über Titel, Autor:in, Schlagwörter und
 * ISBN (jedes Wort muss vorkommen). Ohne Exemplarnummern, Standort-Interna oder Personen.
 */
export async function searchCatalog(db: Db, viewer: PermissionSet, f: CatalogFilter = {}): Promise<CatalogRow[]> {
  requireUse(viewer);
  const words = (f.q ?? "").trim().slice(0, 100).split(/\s+/).filter(Boolean).slice(0, 8);
  const conds: (SQL | undefined)[] = [
    f.mediaType ? eq(buechereiTitles.mediaType, f.mediaType) : undefined,
    sql`exists (select 1 from buecherei_copies c where c.title_id = ${buechereiTitles.id} and c.withdrawn_on is null)`,
  ];
  for (const w of words) {
    const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const isbn = normalizeIsbn(w);
    conds.push(or(ilike(buechereiTitles.title, like), ilike(buechereiTitles.author, like), ilike(buechereiTitles.keywords, like), isbn ? eq(buechereiTitles.isbn, isbn) : undefined));
  }
  const rows = await db
    .select({
      id: buechereiTitles.id,
      title: buechereiTitles.title,
      author: buechereiTitles.author,
      year: buechereiTitles.year,
      mediaType: buechereiTitles.mediaType,
      ageFrom: buechereiTitles.ageFrom,
    })
    .from(buechereiTitles)
    .where(and(...conds))
    .orderBy(de(buechereiTitles.title), asc(buechereiTitles.id))
    .limit(Math.min(f.limit ?? CATALOG_LIMIT, CATALOG_LIMIT));
  const av = await availability(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const a = av.get(r.id)!;
    return { ...r, ...a, shelf: shelfCount(a) };
  });
}

/** Ein Titel im Katalog: Angaben, Exemplare (Signatur, Standort, frei/ausgeliehen bis) und die eigene Lage (Vormerkung, Ausleihe). */
export async function catalogTitle(db: Db, viewer: PermissionSet, titleId: string) {
  requireUse(viewer);
  const [t] = await db
    .select({
      id: buechereiTitles.id,
      title: buechereiTitles.title,
      author: buechereiTitles.author,
      isbn: buechereiTitles.isbn,
      publisher: buechereiTitles.publisher,
      year: buechereiTitles.year,
      keywords: buechereiTitles.keywords,
      ageFrom: buechereiTitles.ageFrom,
      mediaType: buechereiTitles.mediaType,
    })
    .from(buechereiTitles)
    .where(eq(buechereiTitles.id, titleId));
  if (!t) return null;
  const copies = await db
    .select({ id: buechereiCopies.id, signature: buechereiCopies.signature, location: buechereiCopies.location, dueOn: buechereiLoans.dueOn, mine: sql<boolean>`${buechereiLoans.userId} = ${viewer.userId}` })
    .from(buechereiCopies)
    .leftJoin(buechereiLoans, and(eq(buechereiLoans.copyId, buechereiCopies.id), isNull(buechereiLoans.returnedOn)))
    .where(and(eq(buechereiCopies.titleId, t.id), isNull(buechereiCopies.withdrawnOn)))
    .orderBy(asc(buechereiCopies.seq));
  if (!copies.length) return null;
  const a = (await availability(db, [t.id])).get(t.id)!;
  const [own] = await db
    .select({ id: buechereiReservations.id, readyOn: buechereiReservations.readyOn, holdUntil: buechereiReservations.holdUntil })
    .from(buechereiReservations)
    .where(and(eq(buechereiReservations.titleId, t.id), eq(buechereiReservations.userId, viewer.userId)));
  const reservation = own ? { ...own, position: own.readyOn ? 0 : await waitingPosition(db, own.id) } : null;
  return {
    title: t,
    copies: copies.map((c) => ({ id: c.id, signature: c.signature, location: c.location, dueOn: c.dueOn ?? null })),
    availability: { ...a, shelf: shelfCount(a) },
    onLoan: copies.some((c) => c.mine === true),
    reservation,
    canReserve: canBorrow(viewer) && !own && !copies.some((c) => c.mine === true) && a.active > 0 && shelfCount(a) === 0,
  };
}

// ---------------------------------------------------------------- Meine Ausleihen

export interface MyLoan extends OpenLoan {
  /** Grund, warum Verlängern nicht geht – oder null */
  renewBlock: string | null;
}

export interface MyReservation {
  id: string;
  titleId: string;
  title: string;
  author: string | null;
  createdAt: Date;
  readyOn: string | null;
  holdUntil: string | null;
  /** Platz in der Reihe (wartend), 0 = liegt bereit */
  position: number;
}

export interface Library {
  loans: MyLoan[];
  reservations: MyReservation[];
}

/** Aktuelle Ausleihen und Vormerkungen einer Person – ohne Rechteprüfung (nur über die folgenden Funktionen aufrufen). */
async function libraryOf(db: Db, userId: string, today: string): Promise<Library> {
  const [loans, res, max] = await Promise.all([
    openLoansOf(db, userId, today),
    db
      .select({
        id: buechereiReservations.id,
        titleId: buechereiReservations.titleId,
        title: buechereiTitles.title,
        author: buechereiTitles.author,
        createdAt: buechereiReservations.createdAt,
        readyOn: buechereiReservations.readyOn,
        holdUntil: buechereiReservations.holdUntil,
      })
      .from(buechereiReservations)
      .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiReservations.titleId))
      .where(eq(buechereiReservations.userId, userId))
      .orderBy(asc(buechereiReservations.createdAt)),
    readModuleSetting(db, MAX_RENEWALS).then(Number),
  ]);
  // Titel der eigenen Ausleihen, die jemand anderes vorgemerkt hat (die Person selbst kann einen geliehenen Titel nicht vormerken)
  const titleIds = loans.map((l) => l.titleId);
  const reserved = new Set(
    titleIds.length
      ? (
          await db
            .selectDistinct({ titleId: buechereiReservations.titleId })
            .from(buechereiReservations)
            .where(and(inArray(buechereiReservations.titleId, titleIds), sql`${buechereiReservations.userId} <> ${userId}`))
        ).map((r) => r.titleId)
      : [],
  );
  const reservations: MyReservation[] = [];
  for (const r of res) reservations.push({ ...r, position: r.readyOn ? 0 : await waitingPosition(db, r.id) });
  return { loans: loans.map((l) => ({ ...l, renewBlock: renewalBlock(l.renewals, max, reserved.has(l.titleId)) })), reservations };
}

/** „Meine Ausleihen“ (Recht `buecherei.use`): eigene offene Ausleihen und Vormerkungen. */
export async function myLibrary(db: Db, viewer: PermissionSet, today: string): Promise<Library> {
  requireUse(viewer);
  return libraryOf(db, viewer.userId, today);
}

/**
 * Eltern-Sicht (nur lesend): Ausleihen und Vormerkungen der Kinder, über die das Elternteil informiert wird (minderjährig bzw.
 * eigenständig mit Einwilligung). Andere Rollen bekommen nichts.
 */
export async function childrenLibrary(db: Db, viewer: PermissionSet, today: string): Promise<({ id: string; name: string } & Library)[]> {
  if (viewer.role !== "eltern" || viewer.locked) return [];
  const kids = await childrenOf(db, viewer.userId, "inform");
  const out: ({ id: string; name: string } & Library)[] = [];
  for (const k of [...kids].sort((a, b) => a.name.localeCompare(b.name, "de"))) out.push({ id: k.id, name: k.name, ...(await libraryOf(db, k.id, today)) });
  return out;
}

// ---------------------------------------------------------------- Auskunft und Eigenexport

/** Lesbarer Teil der Auskunft (Art. 15): offene Ausleihen, Rückgaben mit Befund, Vormerkungen – mit Titeln statt Kennungen. */
export async function libraryAuskunft(db: Db, userId: string) {
  const [loans, res] = await Promise.all([
    db
      .select({
        titel: buechereiTitles.title,
        exemplar: buechereiCopies.barcode,
        ausgeliehen: buechereiLoans.loanedOn,
        faellig: buechereiLoans.dueOn,
        verlaengert: buechereiLoans.renewals,
        mahnstufe: buechereiLoans.dunningLevel,
        zurueck: buechereiLoans.returnedOn,
        befund: buechereiLoans.finding,
        befundErledigt: buechereiLoans.findingResolvedOn,
      })
      .from(buechereiLoans)
      .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
      .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
      .where(eq(buechereiLoans.userId, userId))
      .orderBy(asc(buechereiLoans.loanedOn)),
    db
      .select({ titel: buechereiTitles.title, vorgemerkt: buechereiReservations.createdAt, bereitSeit: buechereiReservations.readyOn, abholenBis: buechereiReservations.holdUntil })
      .from(buechereiReservations)
      .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiReservations.titleId))
      .where(eq(buechereiReservations.userId, userId))
      .orderBy(asc(buechereiReservations.createdAt)),
  ]);
  return { loans, reservations: res };
}

/** Rein: Text für den Eigenexport („Bücherei.txt“) – nur, wenn es etwas gibt. */
export function libraryText(data: Awaited<ReturnType<typeof libraryAuskunft>>): string | null {
  if (!data.loans.length && !data.reservations.length) return null;
  const lines = ["Schulbücherei – aktueller Stand (ein Ausleihverlauf wird nicht gespeichert)", ""];
  const open = data.loans.filter((l) => !l.zurueck);
  const findings = data.loans.filter((l) => l.zurueck);
  if (open.length) {
    lines.push("Ausgeliehen:");
    for (const l of open) lines.push(`- ${l.titel} (${l.exemplar}), ausgeliehen am ${fmtDay(l.ausgeliehen)}, fällig am ${fmtDay(l.faellig)}${l.verlaengert ? `, ${l.verlaengert}-mal verlängert` : ""}${l.mahnstufe ? `, ${l.mahnstufe}. Mahnung` : ""}`);
    lines.push("");
  }
  if (findings.length) {
    lines.push("Rückgaben mit Befund:");
    for (const l of findings) lines.push(`- ${l.titel} (${l.exemplar}), zurück am ${fmtDay(l.zurueck!)}: ${l.befund ?? ""}${l.befundErledigt ? ` (erledigt am ${fmtDay(l.befundErledigt)})` : ""}`);
    lines.push("");
  }
  if (data.reservations.length) {
    lines.push("Vorgemerkt:");
    for (const r of data.reservations) lines.push(`- ${r.titel}${r.abholenBis ? ` – liegt bereit, abholen bis ${fmtDay(r.abholenBis)}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
