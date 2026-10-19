// Schulbücherei – Bestand (BU-01): Titel und Exemplare anlegen, ändern, aussondern, CSV-Import für den Altbestand.
// Der Bestand hat keinen Personenbezug; Ausleihen (mit Personenbezug) kommen mit BU-02.
import { and, count, eq, ilike, inArray, isNotNull, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import { detectSeparator, splitCsvLine } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiTitles } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { COPY_CONDITIONS, MEDIA_TYPE_LABELS, MEDIA_TYPES, copyNumber, normalizeIsbn, type CopyCondition, type MediaType } from "./labels";

export const canStock = (p: PermissionSet) => hasPermission(p, "buecherei.stock");

function requireStock(p: PermissionSet) {
  if (!canStock(p)) throw new ForbiddenError("buecherei.stock");
}

/** Höchstens so viele Exemplare auf einmal anlegen (Formular und Import-Zeile). */
export const MAX_COPIES_AT_ONCE = 200;

// ---------------------------------------------------------------- Titel

export interface TitleInput {
  title: string;
  author?: string | null;
  isbn?: string | null;
  publisher?: string | null;
  year?: string | number | null;
  keywords?: string | null;
  ageFrom?: string | number | null;
  mediaType: string;
  note?: string | null;
}

const trimOrNull = (s: string | null | undefined) => s?.trim() || null;

function intOrNull(raw: string | number | null | undefined): number | null | "bad" {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) ? n : "bad";
}

/** Rein bis auf die Dublettenprüfung: Eingaben prüfen und normalisieren (ISBN → ISBN-13). */
async function validateTitle(db: Db, input: TitleInput, selfId?: string) {
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) fe.title = "Titel mit 1 bis 200 Zeichen";
  for (const [k, v, n] of [
    ["author", trimOrNull(input.author), 120],
    ["publisher", trimOrNull(input.publisher), 120],
    ["keywords", trimOrNull(input.keywords), 300],
    ["note", trimOrNull(input.note), 500],
  ] as const)
    if (v && v.length > n) fe[k] = `höchstens ${n} Zeichen`;
  const rawIsbn = trimOrNull(input.isbn);
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : null;
  if (rawIsbn && !isbn) fe.isbn = "keine gültige ISBN (Prüfziffer)";
  const year = intOrNull(input.year);
  const thisYear = new Date().getFullYear();
  if (year === "bad" || (year !== null && (year < 1450 || year > thisYear + 1))) fe.year = `Jahr zwischen 1450 und ${thisYear + 1}`;
  const ageFrom = intOrNull(input.ageFrom);
  if (ageFrom === "bad" || (ageFrom !== null && (ageFrom < 0 || ageFrom > 21))) fe.ageFrom = "Alter zwischen 0 und 21";
  if (!(MEDIA_TYPES as readonly string[]).includes(input.mediaType)) fe.mediaType = "Medienart wählen";
  if (isbn) {
    const [dup] = await db.select({ id: buechereiTitles.id, title: buechereiTitles.title }).from(buechereiTitles).where(eq(buechereiTitles.isbn, isbn));
    if (dup && dup.id !== selfId) fe.isbn = `ISBN gehört schon zu „${dup.title}“ – dort ein weiteres Exemplar anlegen`;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    title,
    author: trimOrNull(input.author),
    isbn,
    publisher: trimOrNull(input.publisher),
    year: year as number | null,
    keywords: trimOrNull(input.keywords),
    ageFrom: ageFrom as number | null,
    mediaType: input.mediaType as MediaType,
    note: trimOrNull(input.note),
  };
}

export interface CopyInput {
  count?: string | number | null;
  signature?: string | null;
  location?: string | null;
  condition?: string | null;
}

function validateCopies(input: CopyInput, { allowZero }: { allowZero: boolean }) {
  const fe: Record<string, string> = {};
  const n = intOrNull(input.count);
  const copies = n === null ? (allowZero ? 0 : 1) : n;
  if (copies === "bad" || copies < (allowZero ? 0 : 1) || copies > MAX_COPIES_AT_ONCE) fe.count = `${allowZero ? 0 : 1} bis ${MAX_COPIES_AT_ONCE} Exemplare`;
  const signature = trimOrNull(input.signature);
  const location = trimOrNull(input.location);
  if (signature && signature.length > 40) fe.signature = "höchstens 40 Zeichen";
  if (location && location.length > 80) fe.location = "höchstens 80 Zeichen";
  const condition = trimOrNull(input.condition) ?? "gut";
  if (!(COPY_CONDITIONS as readonly string[]).includes(condition)) fe.condition = "Zustand wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { count: copies as number, signature, location, condition: condition as CopyCondition };
}

/** Exemplare mit fortlaufender Exemplarnummer anlegen; liefert die neuen Nummern. */
async function insertCopies(db: Db, titleId: string, c: { count: number; signature: string | null; location: string | null; condition: CopyCondition }): Promise<string[]> {
  if (c.count === 0) return [];
  const [m] = await db.select({ seq: max(buechereiCopies.seq) }).from(buechereiCopies);
  const start = (m?.seq ?? 0) + 1;
  const rows = Array.from({ length: c.count }, (_, i) => ({
    titleId,
    seq: start + i,
    barcode: copyNumber(start + i),
    signature: c.signature,
    location: c.location,
    condition: c.condition,
  }));
  await db.insert(buechereiCopies).values(rows);
  return rows.map((r) => r.barcode);
}

/** Titel anlegen, optional gleich mit Exemplaren (Recht `buecherei.stock`). */
export async function createTitle(db: Db, viewer: PermissionSet, input: TitleInput, copies: CopyInput = {}): Promise<{ id: string; barcodes: string[] }> {
  requireStock(viewer);
  const row = await validateTitle(db, input);
  const c = validateCopies(copies, { allowZero: true });
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [t] = await tx.insert(buechereiTitles).values(row).returning({ id: buechereiTitles.id });
    const barcodes = await insertCopies(tx, t!.id, c);
    await audit(tx, viewer.userId, "buecherei.title.create", t!.id, { title: row.title, copies: barcodes.length });
    return { id: t!.id, barcodes };
  });
}

export async function updateTitle(db: Db, viewer: PermissionSet, id: string, input: TitleInput): Promise<void> {
  requireStock(viewer);
  const row = await validateTitle(db, input, id);
  const [t] = await db.update(buechereiTitles).set({ ...row, updatedAt: new Date() }).where(eq(buechereiTitles.id, id)).returning({ id: buechereiTitles.id });
  if (!t) throw new ValidationError({ title: "Titel gibt es nicht" });
  await audit(db, viewer.userId, "buecherei.title.update", id, { title: row.title });
}

/** Titel löschen – nur ohne Exemplare (Fehlerfassung); Bestand wird ausgesondert, nicht gelöscht. */
export async function deleteTitle(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireStock(viewer);
  const [c] = await db.select({ n: count() }).from(buechereiCopies).where(eq(buechereiCopies.titleId, id));
  if ((c?.n ?? 0) > 0) throw new ValidationError({ title: "Titel mit Exemplaren lässt sich nicht löschen – Exemplare aussondern" });
  const [t] = await db.delete(buechereiTitles).where(eq(buechereiTitles.id, id)).returning({ title: buechereiTitles.title });
  if (!t) throw new ValidationError({ title: "Titel gibt es nicht" });
  await audit(db, viewer.userId, "buecherei.title.delete", id, { title: t.title });
}

// ---------------------------------------------------------------- Exemplare

export async function addCopies(db: Db, viewer: PermissionSet, titleId: string, input: CopyInput): Promise<string[]> {
  requireStock(viewer);
  const c = validateCopies(input, { allowZero: false });
  const [t] = await db.select({ id: buechereiTitles.id }).from(buechereiTitles).where(eq(buechereiTitles.id, titleId));
  if (!t) throw new ValidationError({ count: "Titel gibt es nicht" });
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const barcodes = await insertCopies(tx, titleId, c);
    await audit(tx, viewer.userId, "buecherei.copy.create", titleId, { copies: barcodes.length });
    return barcodes;
  });
}

export async function updateCopy(db: Db, viewer: PermissionSet, copyId: string, input: Omit<CopyInput, "count">): Promise<void> {
  requireStock(viewer);
  const c = validateCopies({ ...input, count: 1 }, { allowZero: false });
  const [r] = await db
    .update(buechereiCopies)
    .set({ signature: c.signature, location: c.location, condition: c.condition })
    .where(eq(buechereiCopies.id, copyId))
    .returning({ id: buechereiCopies.id, titleId: buechereiCopies.titleId });
  if (!r) throw new ValidationError({ copy: "Exemplar gibt es nicht" });
  await audit(db, viewer.userId, "buecherei.copy.update", r.titleId, { copy: copyId });
}

/** Exemplar aussondern (verloren, beschädigt, veraltet …) – bleibt mit Datum und Grund im Bestand, nicht mehr ausleihbar. */
export async function withdrawCopy(db: Db, viewer: PermissionSet, copyId: string, reason: string, today: string): Promise<void> {
  requireStock(viewer);
  const why = reason.trim();
  if (why.length < 2 || why.length > 200) throw new ValidationError({ reason: "Grund mit 2 bis 200 Zeichen" });
  const [r] = await db
    .update(buechereiCopies)
    .set({ withdrawnOn: today, withdrawnReason: why })
    .where(and(eq(buechereiCopies.id, copyId), isNull(buechereiCopies.withdrawnOn)))
    .returning({ titleId: buechereiCopies.titleId, barcode: buechereiCopies.barcode });
  if (!r) throw new ValidationError({ reason: "Exemplar gibt es nicht oder ist schon ausgesondert" });
  await audit(db, viewer.userId, "buecherei.copy.withdraw", r.titleId, { barcode: r.barcode, reason: why });
}

/** Aussonderung zurücknehmen (Irrtum, Exemplar wiedergefunden). */
export async function restoreCopy(db: Db, viewer: PermissionSet, copyId: string): Promise<void> {
  requireStock(viewer);
  const [r] = await db
    .update(buechereiCopies)
    .set({ withdrawnOn: null, withdrawnReason: null })
    .where(and(eq(buechereiCopies.id, copyId), isNotNull(buechereiCopies.withdrawnOn)))
    .returning({ titleId: buechereiCopies.titleId, barcode: buechereiCopies.barcode });
  if (!r) throw new ValidationError({ copy: "Exemplar gibt es nicht oder ist nicht ausgesondert" });
  await audit(db, viewer.userId, "buecherei.copy.restore", r.titleId, { barcode: r.barcode });
}

// ---------------------------------------------------------------- Lesen

export interface TitleFilter {
  q?: string;
  mediaType?: MediaType;
  /** auch Titel, deren Exemplare alle ausgesondert sind */
  withdrawn?: boolean;
}

export type TitleRow = Awaited<ReturnType<typeof listTitles>>[number];

/** Bestandsliste mit Exemplarzahl (verfügbar = nicht ausgesondert); Suche über Titel, Autor:in, ISBN, Schlagwörter und Exemplarnummer. */
export async function listTitles(db: Db, viewer: PermissionSet, f: TitleFilter = {}) {
  requireStock(viewer);
  const q = f.q?.trim().slice(0, 100);
  const conds: (SQL | undefined)[] = [f.mediaType ? eq(buechereiTitles.mediaType, f.mediaType) : undefined];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const isbn = normalizeIsbn(q);
    conds.push(
      or(
        ilike(buechereiTitles.title, like),
        ilike(buechereiTitles.author, like),
        ilike(buechereiTitles.keywords, like),
        isbn ? eq(buechereiTitles.isbn, isbn) : ilike(buechereiTitles.isbn, like),
        sql`exists (select 1 from buecherei_copies c where c.title_id = "buecherei_titles"."id" and c.barcode ilike ${like})`,
      ),
    );
  }
  const rows = await db
    .select({
      id: buechereiTitles.id,
      title: buechereiTitles.title,
      author: buechereiTitles.author,
      isbn: buechereiTitles.isbn,
      year: buechereiTitles.year,
      mediaType: buechereiTitles.mediaType,
      copies: sql<number>`(select count(*)::int from buecherei_copies c where c.title_id = "buecherei_titles"."id")`,
      active: sql<number>`(select count(*)::int from buecherei_copies c where c.title_id = "buecherei_titles"."id" and c.withdrawn_on is null)`,
    })
    .from(buechereiTitles)
    .where(and(...conds));
  return rows
    .filter((r) => f.withdrawn || r.active > 0 || r.copies === 0)
    .sort((a, b) => a.title.localeCompare(b.title, "de", { numeric: true }) || (a.author ?? "").localeCompare(b.author ?? "", "de"));
}

export async function getTitle(db: Db, viewer: PermissionSet, id: string) {
  requireStock(viewer);
  const [title] = await db.select().from(buechereiTitles).where(eq(buechereiTitles.id, id));
  if (!title) return null;
  const copies = await db.select().from(buechereiCopies).where(eq(buechereiCopies.titleId, id)).orderBy(buechereiCopies.seq);
  return { title, copies };
}

/** Kennzahlen für den Kopf der Bestandsseite. */
export async function stockSummary(db: Db, viewer: PermissionSet) {
  requireStock(viewer);
  const [[t], [c], [w]] = await Promise.all([
    db.select({ n: count() }).from(buechereiTitles),
    db.select({ n: count() }).from(buechereiCopies).where(isNull(buechereiCopies.withdrawnOn)),
    db.select({ n: count() }).from(buechereiCopies).where(isNotNull(buechereiCopies.withdrawnOn)),
  ]);
  return { titles: t?.n ?? 0, copies: c?.n ?? 0, withdrawn: w?.n ?? 0 };
}

// ---------------------------------------------------------------- CSV-Import (Altbestand)

export interface TitleCsvRow {
  line: number;
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  year: number | null;
  keywords: string | null;
  mediaType: MediaType;
  signature: string | null;
  location: string | null;
  count: number;
}

type CsvField = Exclude<keyof TitleCsvRow, "line">;

const CSV_HEADERS: Record<string, CsvField> = {
  titel: "title",
  title: "title",
  autor: "author",
  "autor:in": "author",
  autorin: "author",
  verfasser: "author",
  isbn: "isbn",
  verlag: "publisher",
  jahr: "year",
  erscheinungsjahr: "year",
  schlagwörter: "keywords",
  schlagworte: "keywords",
  medienart: "mediaType",
  art: "mediaType",
  signatur: "signature",
  standort: "location",
  exemplare: "count",
  anzahl: "count",
};

export const MAX_TITLE_CSV_BYTES = 1024 * 1024;
export const MAX_TITLE_CSV_ROWS = 5000;

/** Rein: Medienart aus Schlüssel oder Beschriftung („Buch“, „DVD“ → Film); leer = Buch. */
export function parseMediaType(raw: string): MediaType | null {
  const v = raw.trim().toLowerCase();
  if (!v) return "buch";
  const direct = MEDIA_TYPES.find((k) => k === v || MEDIA_TYPE_LABELS[k].toLowerCase() === v);
  if (direct) return direct;
  const aliases: Record<string, MediaType> = { dvd: "film", "blu-ray": "film", video: "film", brettspiel: "spiel", spiele: "spiel", gerät: "geraet", geräte: "geraet" };
  return aliases[v] ?? null;
}

/**
 * Rein: Bestandsliste lesen – mit oder ohne Kopfzeile, „;“ oder „,“, UTF-8 mit/ohne BOM. Ohne Kopfzeile gilt
 * `Titel;Autor;ISBN;Verlag;Jahr;Medienart;Signatur;Standort;Exemplare`. Ohne Angabe ein Exemplar je Zeile.
 */
export function parseTitleCsv(text: string): { rows: TitleCsvRow[]; errors: { line: number; message: string }[] } {
  const clean = text.replace(/^﻿/, "");
  const sep = detectSeparator(clean);
  let columns: (CsvField | null)[] = ["title", "author", "isbn", "publisher", "year", "mediaType", "signature", "location", "count"];
  const rows: TitleCsvRow[] = [];
  const errors: { line: number; message: string }[] = [];
  let first = true;
  const thisYear = new Date().getFullYear();
  clean.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    if (!raw.trim()) return;
    const cells = splitCsvLine(raw, sep).map((c) => c.trim());
    if (first) {
      first = false;
      const mapped = cells.map((c) => CSV_HEADERS[c.toLowerCase()] ?? null);
      if (mapped.includes("title") && mapped.filter(Boolean).length >= 2) {
        columns = mapped;
        return;
      }
    }
    const rec: Partial<Record<CsvField, string>> = {};
    columns.forEach((c, i) => {
      if (c) rec[c] = cells[i] ?? "";
    });
    const title = rec.title ?? "";
    const isbn = rec.isbn ? normalizeIsbn(rec.isbn) : null;
    const mediaType = parseMediaType(rec.mediaType ?? "");
    const year = rec.year ? Number(rec.year) : null;
    const n = rec.count ? Number(rec.count) : 1;
    if (!title) errors.push({ line, message: "Titel fehlt" });
    else if (title.length > 200) errors.push({ line, message: "Titel zu lang (höchstens 200 Zeichen)" });
    else if (rec.isbn && !isbn) errors.push({ line, message: `ISBN „${rec.isbn}“ ungültig` });
    else if (!mediaType) errors.push({ line, message: `Medienart „${rec.mediaType ?? ""}“ unbekannt` });
    else if (year !== null && (!Number.isInteger(year) || year < 1450 || year > thisYear + 1)) errors.push({ line, message: `Jahr „${rec.year}“ ungültig` });
    else if (!Number.isInteger(n) || n < 1 || n > MAX_COPIES_AT_ONCE) errors.push({ line, message: `Exemplare „${rec.count}“ ungültig (1 bis ${MAX_COPIES_AT_ONCE})` });
    else if ((rec.author ?? "").length > 120 || (rec.publisher ?? "").length > 120) errors.push({ line, message: "Autor oder Verlag zu lang (höchstens 120 Zeichen)" });
    else if ((rec.signature ?? "").length > 40 || (rec.location ?? "").length > 80) errors.push({ line, message: "Signatur (40) oder Standort (80 Zeichen) zu lang" });
    else if ((rec.keywords ?? "").length > 300) errors.push({ line, message: "Schlagwörter zu lang (höchstens 300 Zeichen)" });
    else
      rows.push({
        line,
        title,
        author: rec.author || null,
        isbn,
        publisher: rec.publisher || null,
        year,
        keywords: rec.keywords || null,
        mediaType,
        signature: rec.signature || null,
        location: rec.location || null,
        count: n,
      });
  });
  if (rows.length > MAX_TITLE_CSV_ROWS) errors.push({ line: 0, message: `Höchstens ${MAX_TITLE_CSV_ROWS} Zeilen je Import` });
  return { rows, errors };
}

export interface ImportResult {
  titles: number;
  /** Zeilen, deren ISBN es schon gab bzw. die in der Datei mehrfach vorkommt – dort kommen nur Exemplare dazu */
  existing: number;
  copies: number;
  dryRun: boolean;
}

/**
 * Altbestand importieren (Recht `buecherei.stock`): alles oder nichts. Gleiche ISBN (im Bestand oder weiter oben in der
 * Datei) → kein neuer Titel, nur weitere Exemplare (Dubletten). `dryRun` prüft nur und zählt (Vorschau).
 */
export async function importTitles(db: Db, viewer: PermissionSet, text: string, opts: { dryRun?: boolean } = {}): Promise<ImportResult> {
  requireStock(viewer);
  if (text.length > MAX_TITLE_CSV_BYTES) throw new ValidationError({ file: "Datei zu groß (höchstens 1 MB)" });
  const { rows, errors } = parseTitleCsv(text);
  if (errors.length) {
    errors.sort((a, b) => a.line - b.line);
    throw new ValidationError({
      file: errors.slice(0, 5).map((e) => (e.line ? `Zeile ${e.line}: ${e.message}` : e.message)).join(" · ") + (errors.length > 5 ? ` (und ${errors.length - 5} weitere)` : ""),
    });
  }
  if (!rows.length) throw new ValidationError({ file: "Keine Titel in der Datei" });
  const run = async (tx: Db): Promise<ImportResult> => {
    const isbns = [...new Set(rows.map((r) => r.isbn).filter((i): i is string => !!i))];
    const byIsbn = new Map(
      isbns.length ? (await tx.select({ id: buechereiTitles.id, isbn: buechereiTitles.isbn }).from(buechereiTitles).where(inArray(buechereiTitles.isbn, isbns))).map((t) => [t.isbn!, t.id]) : [],
    );
    let titles = 0;
    let existing = 0;
    let copies = 0;
    for (const r of rows) {
      let id = r.isbn ? byIsbn.get(r.isbn) : undefined;
      if (id) existing++;
      else {
        titles++;
        if (!opts.dryRun) {
          const [t] = await tx
            .insert(buechereiTitles)
            .values({ title: r.title, author: r.author, isbn: r.isbn, publisher: r.publisher, year: r.year, keywords: r.keywords, mediaType: r.mediaType })
            .returning({ id: buechereiTitles.id });
          id = t!.id;
        } else id = `neu-${r.line}`;
        if (r.isbn) byIsbn.set(r.isbn, id);
      }
      copies += r.count;
      if (!opts.dryRun) await insertCopies(tx, id, { count: r.count, signature: r.signature, location: r.location, condition: "gut" });
    }
    if (!opts.dryRun) await audit(tx, viewer.userId, "buecherei.import", null, { titles, existing, copies });
    return { titles, existing, copies, dryRun: !!opts.dryRun };
  };
  if (opts.dryRun) return run(db);
  return db.transaction((raw) => run(raw as unknown as Db));
}
