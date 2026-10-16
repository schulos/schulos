// Stammdaten Schuljahre mit Halbjahreswechsel und aktuellem Schuljahr.
import { asc, count, eq, isNotNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { groups, notenbuchBooks, schoolYears } from "@/core/db/schema";
import { ValidationError } from "./users";

export type SchoolYear = typeof schoolYears.$inferSelect;

export async function listSchoolYears(db: Db): Promise<SchoolYear[]> {
  return db.select().from(schoolYears).orderBy(asc(schoolYears.startsOn));
}

/** Anzahl Gruppen je Schuljahr (dann nicht löschbar) */
export async function schoolYearUsage(db: Db): Promise<Map<string, number>> {
  const rows = await db.select({ id: groups.schoolYearId, n: count() }).from(groups).where(isNotNull(groups.schoolYearId)).groupBy(groups.schoolYearId);
  return new Map(rows.map((r) => [r.id!, r.n]));
}

/** Halbjahr eines Datums im Schuljahr: 1, 2 oder null (außerhalb bzw. ohne Halbjahreswechsel nur 1). */
export function termOf(year: Pick<SchoolYear, "startsOn" | "endsOn" | "term2StartsOn">, date: string): 1 | 2 | null {
  if (date < year.startsOn || date > year.endsOn) return null;
  return year.term2StartsOn && date >= year.term2StartsOn ? 2 : 1;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => ISO_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export interface SchoolYearInput {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  term2StartsOn: string;
}

/** Prüft alle Schuljahre zusammen: Pflichtfelder, Reihenfolge der Daten, keine Überschneidung, Namen eindeutig. */
export function checkSchoolYears(rows: readonly SchoolYearInput[]): Record<string, string> {
  const fe: Record<string, string> = {};
  const names = new Set<string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) fe[`name-${r.id}`] = "Name angeben";
    else if (names.has(name.toLowerCase())) fe[`name-${r.id}`] = "Name doppelt";
    names.add(name.toLowerCase());
    if (!isDate(r.startsOn)) fe[`start-${r.id}`] = "Datum angeben";
    if (!isDate(r.endsOn)) fe[`end-${r.id}`] = "Datum angeben";
    else if (isDate(r.startsOn) && r.endsOn <= r.startsOn) fe[`end-${r.id}`] = "Ende muss nach dem Beginn liegen";
    if (r.term2StartsOn) {
      if (!isDate(r.term2StartsOn)) fe[`term2-${r.id}`] = "Datum oder leer";
      else if (r.term2StartsOn <= r.startsOn || r.term2StartsOn > r.endsOn) fe[`term2-${r.id}`] = "Muss innerhalb des Schuljahres liegen";
    }
  }
  const sorted = rows.filter((r) => isDate(r.startsOn) && isDate(r.endsOn)).toSorted((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (sorted[i]!.startsOn <= prev.endsOn) fe[`start-${sorted[i]!.id}`] ??= `Überschneidet sich mit ${prev.name.trim() || "dem Schuljahr davor"}`;
  }
  return fe;
}

/** Speichert alle Schuljahre; genau eines ist das aktuelle (Gruppen, Stundenplan, Klassenbuch richten sich danach). */
export async function saveSchoolYears(db: Db, actorId: string, rows: SchoolYearInput[], currentId: string | null): Promise<void> {
  const fe = checkSchoolYears(rows);
  if (rows.length && !rows.some((r) => r.id === currentId)) fe.current = "Aktuelles Schuljahr wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db.transaction(async (tx) => {
    // Namen sind eindeutig: erst Platzhalter, dann Zielnamen (Tausch möglich)
    for (const r of rows) await tx.update(schoolYears).set({ name: `~${r.id}`, isCurrent: false }).where(eq(schoolYears.id, r.id));
    for (const r of rows) {
      await tx
        .update(schoolYears)
        .set({ name: r.name.trim(), startsOn: r.startsOn, endsOn: r.endsOn, term2StartsOn: r.term2StartsOn || null, isCurrent: r.id === currentId })
        .where(eq(schoolYears.id, r.id));
    }
  });
  await audit(db, actorId, "verwaltung.stammdaten.school_years", null, { count: rows.length, current: currentId });
}

const plusYear = (iso: string) => `${Number(iso.slice(0, 4)) + 1}${iso.slice(4)}`;

/** Legt das Folgejahr des letzten Schuljahres an (Daten +1 Jahr), ohne Schuljahr ab dem 1.8. des laufenden Jahres. */
export async function addNextSchoolYear(db: Db, actorId: string, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const last = (await listSchoolYears(db)).at(-1);
  const y = Number(today.slice(0, 4)) - (today.slice(5) < "08-01" ? 1 : 0);
  const startsOn = last ? plusYear(last.startsOn) : `${y}-08-01`;
  const endsOn = last ? plusYear(last.endsOn) : `${y + 1}-07-31`;
  const term2StartsOn = last?.term2StartsOn ? plusYear(last.term2StartsOn) : `${Number(startsOn.slice(0, 4)) + 1}-02-01`;
  const sy = Number(startsOn.slice(0, 4));
  const name = `${sy}/${String((sy + 1) % 100).padStart(2, "0")}`;
  const [row] = await db
    .insert(schoolYears)
    .values({ name, startsOn, endsOn, term2StartsOn, isCurrent: !last })
    .returning({ id: schoolYears.id });
  await audit(db, actorId, "verwaltung.stammdaten.school_year_add", row!.id, { name });
  return row!.id;
}

export async function deleteSchoolYear(db: Db, actorId: string, id: string): Promise<void> {
  const [y] = await db.select().from(schoolYears).where(eq(schoolYears.id, id));
  if (!y) return;
  if (y.isCurrent) throw new ValidationError({ [`name-${id}`]: "Das aktuelle Schuljahr kann nicht gelöscht werden" });
  const used = (await schoolYearUsage(db)).get(id) ?? 0;
  if (used) throw new ValidationError({ [`name-${id}`]: `${y.name} hat noch ${used} Gruppen` });
  // G5A-C06: Notenbücher gehen nur mit ihrer Löschfrist (Löschlauf), nie per Kaskade über das Schuljahr
  const [{ n: books } = { n: 0 }] = await db.select({ n: count() }).from(notenbuchBooks).where(eq(notenbuchBooks.schoolYearId, id));
  if (books) throw new ValidationError({ [`name-${id}`]: `${y.name} hat noch ${books} ${books === 1 ? "Notenbuch" : "Notenbücher"} (gehen mit ihrer Löschfrist)` });
  await db.delete(schoolYears).where(eq(schoolYears.id, id));
  await audit(db, actorId, "verwaltung.stammdaten.school_year_delete", id, { name: y.name });
}
