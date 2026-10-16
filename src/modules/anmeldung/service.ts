// Schulanmeldung (P4-32): Verfahren, Gesprächstermine (Slot-Generator), Statusmaschine der Anträge mit Löschfrist
// (`retention_from`, LK-90) und Kapazitäten. Reine Logik + DB, ohne Next – Server Actions in actions.ts.
// Keine automatische Auswahl: Kapazität, Geschwister und Schulweg sind nur Information (Q-34).
import { and, asc, count, desc, eq, gt, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren, gradeLevels, rooms, schoolYears, schoolYearTransitions } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { assertImpressumComplete } from "@/core/school/impressum";
import { fromBerlinLocal, fromBerlinLocalStrict, isCalendarDate, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  ANTRAG_STATUS_LABELS,
  defaultFields,
  OPTIONAL_FIELDS,
  parseFields,
  VERFAHREN_KINDS,
  type AntragStatus,
  type EreignisKind,
  type VerfahrenFields,
  type VerfahrenKind,
  type VerfahrenStatus,
} from "./labels";

export const MODULE = "anmeldung";

// ---------------------------------------------------------------- Rechte

export const canManage = (v: PermissionSet) => hasPermission(v, "anmeldung.manage");
export const canDecide = (v: PermissionSet) => hasPermission(v, "anmeldung.decide");
export const canView = (v: PermissionSet) => canManage(v) || canDecide(v) || hasPermission(v, "anmeldung.view");

function assertManage(v: PermissionSet) {
  if (!canManage(v)) throw new ForbiddenError("anmeldung.manage");
}
function assertView(v: PermissionSet) {
  if (!canView(v)) throw new ForbiddenError("anmeldung.view");
}

// ---------------------------------------------------------------- Verfahren

export const NAME_MAX = 120;
export const INTRO_MAX = 8000;
export const CAPACITY_MAX = 2000;
/** LK-90: so viele Tage nach `retention_from` löscht der Löschlauf */
export const LK90_DAYS = 90;
/** Q-36: Löschfrist abgelehnter/Wartelisten-Anträge ab Abschluss (Vorgabe), Grenzen wie die DB-Prüfung */
export const REJECT_KEEP_DEFAULT = 60;
export const REJECT_KEEP_MIN = 31;
export const REJECT_KEEP_MAX = 365;

export interface VerfahrenInput {
  name: string;
  kind: string;
  targetSchoolYearId: string;
  targetGradeLevel: string | number;
  /** Berliner Ortszeit „YYYY-MM-DDTHH:MM“ */
  opensAt: string;
  closesAt: string;
  capacity?: string | number | null;
  intro?: string;
  fields?: Partial<Record<string, boolean>>;
  rejectKeepDays?: string | number | null;
}

interface NormalizedVerfahren {
  name: string;
  kind: VerfahrenKind;
  targetSchoolYearId: string;
  targetGradeLevel: number;
  opensAt: Date;
  closesAt: Date;
  capacity: number | null;
  intro: string;
  fields: VerfahrenFields;
  rejectKeepDays: number;
}

const toInt = (x: string | number | null | undefined): number | null => {
  if (x === null || x === undefined || String(x).trim() === "") return null;
  const n = Number(x);
  return Number.isInteger(n) ? n : NaN;
};

function parseLocal(s: string): Date | null {
  try {
    return fromBerlinLocalStrict(s.trim());
  } catch {
    return null;
  }
}

async function normalizeVerfahren(db: Db, input: VerfahrenInput): Promise<NormalizedVerfahren> {
  const fe: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 3) fe.name = "Name angeben (mind. 3 Zeichen)";
  else if (name.length > NAME_MAX) fe.name = `Bitte kürzer (höchstens ${NAME_MAX} Zeichen)`;
  const kind = (VERFAHREN_KINDS as readonly string[]).includes(input.kind) ? (input.kind as VerfahrenKind) : null;
  if (!kind) fe.kind = "Art wählen";
  const [year] = input.targetSchoolYearId
    ? await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, input.targetSchoolYearId))
    : [];
  if (!year) fe.targetSchoolYearId = "Schuljahr wählen (unter Stammdaten anlegen, falls es fehlt)";
  const level = toInt(input.targetGradeLevel);
  const [grade] = level !== null && !Number.isNaN(level) ? await db.select({ level: gradeLevels.level }).from(gradeLevels).where(eq(gradeLevels.level, level)) : [];
  if (!grade) fe.targetGradeLevel = "Jahrgang wählen";
  const opensAt = parseLocal(input.opensAt);
  const closesAt = parseLocal(input.closesAt);
  if (!opensAt) fe.opensAt = "Beginn angeben (gültiges Datum und Uhrzeit)";
  if (!closesAt) fe.closesAt = "Ende angeben (gültiges Datum und Uhrzeit)";
  else if (opensAt && closesAt <= opensAt) fe.closesAt = "Ende muss nach dem Beginn liegen";
  const capacity = toInt(input.capacity);
  if (capacity !== null && (Number.isNaN(capacity) || capacity < 1 || capacity > CAPACITY_MAX)) fe.capacity = `Zahl 1–${CAPACITY_MAX} oder leer`;
  const intro = (input.intro ?? "").replace(/\r\n/g, "\n").trim();
  if (intro.length > INTRO_MAX) fe.intro = `Bitte kürzer (höchstens ${INTRO_MAX} Zeichen)`;
  const keep = toInt(input.rejectKeepDays) ?? REJECT_KEEP_DEFAULT;
  if (Number.isNaN(keep) || keep < REJECT_KEEP_MIN || keep > REJECT_KEEP_MAX)
    fe.rejectKeepDays = `Zahl ${REJECT_KEEP_MIN}–${REJECT_KEEP_MAX} (Widerspruchsfrist 1 Monat + Puffer)`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const base = defaultFields(kind!);
  const fields = Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, typeof input.fields?.[f] === "boolean" ? input.fields[f] : base[f]])) as VerfahrenFields;
  return { name, kind: kind!, targetSchoolYearId: year!.id, targetGradeLevel: grade!.level, opensAt: opensAt!, closesAt: closesAt!, capacity, intro, fields, rejectKeepDays: keep };
}

export type VerfahrenRow = typeof anmeldungVerfahren.$inferSelect;

async function loadVerfahren(db: Db, id: string): Promise<VerfahrenRow> {
  const [v] = await db.select().from(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, id));
  if (!v) throw new ValidationError({ verfahren: "Verfahren gibt es nicht" });
  return v;
}

export async function createVerfahren(db: Db, viewer: PermissionSet, input: VerfahrenInput, now = new Date()): Promise<string> {
  assertManage(viewer);
  const n = await normalizeVerfahren(db, input);
  const [row] = await db
    .insert(anmeldungVerfahren)
    .values({ ...n, status: "entwurf", createdBy: viewer.userId, createdAt: now, updatedAt: now })
    .returning({ id: anmeldungVerfahren.id });
  await audit(db, viewer.userId, "anmeldung.verfahren.anlegen", row!.id, { art: n.kind });
  return row!.id;
}

export async function updateVerfahren(db: Db, viewer: PermissionSet, id: string, input: VerfahrenInput, now = new Date()): Promise<void> {
  assertManage(viewer);
  const v = await loadVerfahren(db, id);
  if (v.status === "abgeschlossen") throw new ValidationError({ verfahren: "Abgeschlossene Verfahren lassen sich nicht mehr ändern" });
  const n = await normalizeVerfahren(db, input);
  if (v.status !== "entwurf") {
    // nach dem Veröffentlichen: Art und Ziel stehen fest (Eltern haben sich darauf angemeldet)
    const fe: Record<string, string> = {};
    if (n.kind !== v.kind) fe.kind = "Nach dem Veröffentlichen nicht mehr änderbar";
    if (n.targetSchoolYearId !== v.targetSchoolYearId) fe.targetSchoolYearId = "Nach dem Veröffentlichen nicht mehr änderbar";
    if (n.targetGradeLevel !== v.targetGradeLevel) fe.targetGradeLevel = "Nach dem Veröffentlichen nicht mehr änderbar";
    if (Object.keys(fe).length) throw new ValidationError(fe);
  }
  await db
    .update(anmeldungVerfahren)
    .set({ ...n, updatedAt: now })
    .where(eq(anmeldungVerfahren.id, id));
  await audit(db, viewer.userId, "anmeldung.verfahren.aendern", id);
}

/** Veröffentlichen (Entwurf bzw. geschlossen → offen): braucht mindestens einen Gesprächstermin, ein Ende in der Zukunft und ein vollständiges Impressum. */
export async function publishVerfahren(db: Db, viewer: PermissionSet, id: string, now = new Date()): Promise<void> {
  assertManage(viewer);
  const v = await loadVerfahren(db, id);
  if (v.status !== "entwurf" && v.status !== "geschlossen") throw new ValidationError({ verfahren: "Nur Entwürfe und geschlossene Verfahren lassen sich veröffentlichen" });
  if (v.closesAt <= now) throw new ValidationError({ closesAt: "Das Ende des Anmeldezeitraums liegt in der Vergangenheit" });
  const [slots] = await db.select({ n: count() }).from(anmeldungSlots).where(eq(anmeldungSlots.verfahrenId, id));
  if (!slots?.n) throw new ValidationError({ verfahren: "Bitte zuerst Gesprächstermine anlegen" });
  // Q5-22: öffentliche Seiten nur mit vollständigem Impressum (§ 5 DDG)
  await assertImpressumComplete(db);
  await db.update(anmeldungVerfahren).set({ status: "offen", updatedAt: now }).where(eq(anmeldungVerfahren.id, id));
  await audit(db, viewer.userId, "anmeldung.verfahren.veroeffentlichen", id);
}

/** Schließen (offen → geschlossen): keine neuen Anträge mehr, bestehende werden weiter bearbeitet. */
export async function closeVerfahren(db: Db, viewer: PermissionSet, id: string, now = new Date()): Promise<void> {
  assertManage(viewer);
  const v = await loadVerfahren(db, id);
  if (v.status !== "offen") throw new ValidationError({ verfahren: "Nur veröffentlichte Verfahren lassen sich schließen" });
  await db.update(anmeldungVerfahren).set({ status: "geschlossen", updatedAt: now }).where(eq(anmeldungVerfahren.id, id));
  await audit(db, viewer.userId, "anmeldung.verfahren.schliessen", id);
}

/** Entwurf ohne Anträge löschen. */
export async function deleteVerfahren(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  assertManage(viewer);
  const v = await loadVerfahren(db, id);
  const [a] = await db.select({ n: count() }).from(anmeldungAntraege).where(eq(anmeldungAntraege.verfahrenId, id));
  if (v.status !== "entwurf" || a?.n) throw new ValidationError({ verfahren: "Nur Entwürfe ohne Anträge lassen sich löschen" });
  await db.delete(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, id));
  await audit(db, viewer.userId, "anmeldung.verfahren.loeschen", id);
}

/** Anträge, über die noch nicht entschieden ist (Abschluss erst danach). */
export const OPEN_STATUSES: readonly AntragStatus[] = ["eingegangen", "termin", "vollstaendig"];
export const DECISION_STATUSES: readonly AntragStatus[] = ["aufgenommen", "warteliste", "abgelehnt"];

/**
 * Abschließen (geschlossen → abgeschlossen, Recht „decide“): erst, wenn über alle Anträge entschieden ist. Ab jetzt läuft
 * die Löschfrist abgelehnter und Wartelisten-Anträge (Q-36).
 */
export async function completeVerfahren(db: Db, viewer: PermissionSet, id: string, now = new Date()): Promise<void> {
  if (!canDecide(viewer)) throw new ForbiddenError("anmeldung.decide");
  const v = await loadVerfahren(db, id);
  if (v.status !== "geschlossen") throw new ValidationError({ verfahren: "Erst das Verfahren schließen, dann abschließen" });
  const [open] = await db
    .select({ n: count() })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, id), inArray(anmeldungAntraege.status, [...OPEN_STATUSES])));
  if (open?.n) throw new ValidationError({ verfahren: `Noch ${open.n} Anträge ohne Entscheidung` });
  await db.transaction(async (tx) => {
    await tx.update(anmeldungVerfahren).set({ status: "abgeschlossen", completedAt: now, updatedAt: now }).where(eq(anmeldungVerfahren.id, id));
    await tx
      .update(anmeldungAntraege)
      .set({ retentionFrom: rejectRetentionFrom(now, v.rejectKeepDays), updatedAt: now })
      .where(and(eq(anmeldungAntraege.verfahrenId, id), inArray(anmeldungAntraege.status, ["abgelehnt", "warteliste"])));
  });
  await audit(db, viewer.userId, "anmeldung.verfahren.abschliessen", id);
}

export interface VerfahrenListRow extends VerfahrenRow {
  schoolYearName: string;
  counts: Partial<Record<AntragStatus, number>>;
  slotCount: number;
}

export async function listVerfahren(db: Db, viewer: PermissionSet): Promise<VerfahrenListRow[]> {
  assertView(viewer);
  const rows = await db
    .select({ v: anmeldungVerfahren, schoolYearName: schoolYears.name })
    .from(anmeldungVerfahren)
    .innerJoin(schoolYears, eq(schoolYears.id, anmeldungVerfahren.targetSchoolYearId))
    .orderBy(desc(anmeldungVerfahren.opensAt), de(anmeldungVerfahren.name));
  const ids = rows.map((r) => r.v.id);
  const [byStatus, slots] = ids.length
    ? await Promise.all([
        db
          .select({ id: anmeldungAntraege.verfahrenId, status: anmeldungAntraege.status, n: count() })
          .from(anmeldungAntraege)
          .where(inArray(anmeldungAntraege.verfahrenId, ids))
          .groupBy(anmeldungAntraege.verfahrenId, anmeldungAntraege.status),
        db
          .select({ id: anmeldungSlots.verfahrenId, n: count() })
          .from(anmeldungSlots)
          .where(inArray(anmeldungSlots.verfahrenId, ids))
          .groupBy(anmeldungSlots.verfahrenId),
      ])
    : [[], []];
  return rows.map((r) => ({
    ...r.v,
    schoolYearName: r.schoolYearName,
    counts: Object.fromEntries(byStatus.filter((b) => b.id === r.v.id).map((b) => [b.status, b.n])),
    slotCount: slots.find((s) => s.id === r.v.id)?.n ?? 0,
  }));
}

export async function getVerfahren(db: Db, viewer: PermissionSet, id: string) {
  assertView(viewer);
  const [r] = await db
    .select({ v: anmeldungVerfahren, schoolYearName: schoolYears.name, schoolYearStartsOn: schoolYears.startsOn })
    .from(anmeldungVerfahren)
    .innerJoin(schoolYears, eq(schoolYears.id, anmeldungVerfahren.targetSchoolYearId))
    .where(eq(anmeldungVerfahren.id, id));
  if (!r) return null;
  return { ...r.v, schoolYearName: r.schoolYearName, schoolYearStartsOn: r.schoolYearStartsOn, fieldSet: parseFields(r.v.fields, r.v.kind) };
}

/** Rein: nimmt dieses Verfahren gerade Anträge an? */
export function acceptsSubmissions(v: Pick<VerfahrenRow, "status" | "opensAt" | "closesAt">, now = new Date()): boolean {
  return v.status === "offen" && v.opensAt <= now && now < v.closesAt;
}

/** Öffentliche Liste: veröffentlichte Verfahren, deren Zeitraum läuft (ohne Rechte – nur Name, Art, Zeitraum, Hinweistext). */
export async function openVerfahren(db: Db, now = new Date()) {
  const rows = await db
    .select({
      id: anmeldungVerfahren.id,
      name: anmeldungVerfahren.name,
      kind: anmeldungVerfahren.kind,
      opensAt: anmeldungVerfahren.opensAt,
      closesAt: anmeldungVerfahren.closesAt,
      intro: anmeldungVerfahren.intro,
      status: anmeldungVerfahren.status,
    })
    .from(anmeldungVerfahren)
    .where(and(eq(anmeldungVerfahren.status, "offen"), gt(anmeldungVerfahren.closesAt, now)))
    .orderBy(asc(anmeldungVerfahren.closesAt), de(anmeldungVerfahren.name));
  return rows.filter((v) => acceptsSubmissions(v, now));
}

// ---------------------------------------------------------------- Gesprächstermine

export interface SlotSpec {
  /** Tage „YYYY-MM-DD“ */
  days: string[];
  /** Zeitfenster je Tag, „HH:MM“ */
  windows: { from: string; to: string }[];
  durationMinutes: number;
  /** parallele Gespräche je Termin */
  parallel: number;
  /** Pause zwischen zwei Gesprächen */
  breakMinutes?: number;
}

export const MAX_SLOTS_PER_RUN = 500;

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Rein: Termine aus Tagen × Zeitfenstern × Dauer (+ Pause), je Termin `parallel` Plätze. Zeiten in Berliner Ortszeit
 * (auch an Tagen mit Zeitumstellung richtig). Fehler als Feldfehler.
 */
export function generateSlots(spec: SlotSpec): { startsAt: Date; endsAt: Date; capacity: number }[] {
  const fe: Record<string, string> = {};
  const days = [...new Set(spec.days.map((d) => d.trim()).filter(Boolean))].sort();
  if (!days.length) fe.days = "Mindestens einen Tag wählen";
  else if (days.some((d) => !YMD.test(d) || !isCalendarDate(d))) fe.days = `Ungültiges Datum: ${days.find((d) => !YMD.test(d) || !isCalendarDate(d))}`;
  if (!spec.windows.length) fe.windows = "Mindestens ein Zeitfenster angeben";
  else if (spec.windows.some((w) => !HM.test(w.from) || !HM.test(w.to) || minutesOf(w.to) <= minutesOf(w.from)))
    fe.windows = "Zeitfenster als „von–bis“ (HH:MM), Ende nach Beginn";
  if (!Number.isInteger(spec.durationMinutes) || spec.durationMinutes < 5 || spec.durationMinutes > 240) fe.durationMinutes = "Dauer 5–240 Minuten";
  if (!Number.isInteger(spec.parallel) || spec.parallel < 1 || spec.parallel > 50) fe.parallel = "Parallele Gespräche 1–50";
  const pause = spec.breakMinutes ?? 0;
  if (!Number.isInteger(pause) || pause < 0 || pause > 120) fe.breakMinutes = "Pause 0–120 Minuten";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const out: { startsAt: Date; endsAt: Date; capacity: number }[] = [];
  for (const day of days)
    for (const w of spec.windows) {
      const end = minutesOf(w.to);
      for (let t = minutesOf(w.from); t + spec.durationMinutes <= end; t += spec.durationMinutes + pause) {
        out.push({ startsAt: fromBerlinLocal(`${day}T${hm(t)}`), endsAt: fromBerlinLocal(`${day}T${hm(t + spec.durationMinutes)}`), capacity: spec.parallel });
        if (out.length > MAX_SLOTS_PER_RUN) throw new ValidationError({ days: `Zu viele Termine auf einmal (höchstens ${MAX_SLOTS_PER_RUN})` });
      }
    }
  if (!out.length) throw new ValidationError({ durationMinutes: "In die Zeitfenster passt kein Gespräch dieser Dauer" });
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Termine anlegen; schon vorhandene Startzeiten werden übersprungen (Generator mehrfach anwendbar). */
export async function addSlots(
  db: Db,
  viewer: PermissionSet,
  verfahrenId: string,
  spec: SlotSpec & { roomId?: string | null; note?: string | null },
): Promise<{ added: number; skipped: number }> {
  assertManage(viewer);
  const v = await loadVerfahren(db, verfahrenId);
  if (v.status === "abgeschlossen") throw new ValidationError({ verfahren: "Abgeschlossenes Verfahren" });
  const slots = generateSlots(spec);
  const roomId = spec.roomId?.trim() || null;
  if (roomId) {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
    if (!r) throw new ValidationError({ roomId: "Raum gibt es nicht" });
  }
  const note = spec.note?.trim().slice(0, 200) || null;
  const rows = await db
    .insert(anmeldungSlots)
    .values(slots.map((s) => ({ ...s, verfahrenId, roomId, note })))
    .onConflictDoNothing()
    .returning({ id: anmeldungSlots.id });
  await audit(db, viewer.userId, "anmeldung.termine.anlegen", verfahrenId, { anzahl: rows.length });
  return { added: rows.length, skipped: slots.length - rows.length };
}

/**
 * Unbestätigte Anträge halten ihren Termin nur so lange (P4-34): sonst könnte jemand ohne Bestätigung alle Termine 48 h
 * blockieren. Wer später bestätigt und dessen Termin inzwischen vergeben ist, wählt über den Vorgangslink einen neuen.
 */
export const UNCONFIRMED_HOLD_MINUTES = 120;

/** Belegte Plätze: alle Anträge mit Termin außer zurückgezogenen; unbestätigte nur in den ersten zwei Stunden. */
export function holdsSlot(now: Date) {
  return and(
    ne(anmeldungAntraege.status, "zurueckgezogen"),
    or(ne(anmeldungAntraege.status, "unbestaetigt"), gt(anmeldungAntraege.createdAt, new Date(now.getTime() - UNCONFIRMED_HOLD_MINUTES * 60_000))),
  )!;
}

export async function deleteSlot(db: Db, viewer: PermissionSet, slotId: string, now = new Date()): Promise<void> {
  assertManage(viewer);
  const [booked] = await db
    .select({ n: count() })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.slotId, slotId), holdsSlot(now)));
  if (booked?.n) throw new ValidationError({ slot: "Termin ist gebucht – erst die Anträge auf einen anderen Termin legen" });
  const [s] = await db.delete(anmeldungSlots).where(eq(anmeldungSlots.id, slotId)).returning({ verfahrenId: anmeldungSlots.verfahrenId });
  if (s) await audit(db, viewer.userId, "anmeldung.termine.loeschen", s.verfahrenId);
}

export interface SlotRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  free: number;
  roomId: string | null;
  note: string | null;
}

/** Termine eines Verfahrens mit belegten/freien Plätzen (chronologisch). */
export async function listSlots(db: Db, verfahrenId: string, now = new Date()): Promise<SlotRow[]> {
  const rows = await db
    .select({
      id: anmeldungSlots.id,
      startsAt: anmeldungSlots.startsAt,
      endsAt: anmeldungSlots.endsAt,
      capacity: anmeldungSlots.capacity,
      roomId: anmeldungSlots.roomId,
      note: anmeldungSlots.note,
    })
    .from(anmeldungSlots)
    .where(eq(anmeldungSlots.verfahrenId, verfahrenId))
    .orderBy(asc(anmeldungSlots.startsAt));
  const booked = await db
    .select({ slotId: anmeldungAntraege.slotId, n: count() })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, verfahrenId), holdsSlot(now)))
    .groupBy(anmeldungAntraege.slotId);
  const bySlot = new Map(booked.map((b) => [b.slotId, b.n]));
  return rows.map((r) => {
    const n = bySlot.get(r.id) ?? 0;
    return { ...r, booked: n, free: Math.max(0, r.capacity - n) };
  });
}

/** Für Eltern: nur künftige Termine mit freien Plätzen. */
export async function freeSlots(db: Db, verfahrenId: string, now = new Date()): Promise<SlotRow[]> {
  return (await listSlots(db, verfahrenId, now)).filter((s) => s.free > 0 && s.startsAt > now);
}

// ---------------------------------------------------------------- Anträge

export const antragNumber = (year: number, seq: number) => `A-${year}-${String(seq).padStart(4, "0")}`;

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Platz im Termin prüfen (in einer Transaktion; Sperre auf dem Termin – `FOR UPDATE` –, damit zwei gleichzeitige Buchungen
 * nicht denselben letzten Platz nehmen: die zweite wartet, bis die erste fertig ist, und zählt dann neu).
 * `future`: nur künftige Termine (Eltern buchen nichts in der Vergangenheit).
 */
export async function assertSlotFree(
  tx: Tx | Db,
  verfahrenId: string,
  slotId: string,
  opts: { exceptAntragId?: string; now?: Date; future?: boolean } = {},
): Promise<{ startsAt: Date; endsAt: Date }> {
  const now = opts.now ?? new Date();
  const [slot] = await tx
    .select({ id: anmeldungSlots.id, capacity: anmeldungSlots.capacity, verfahrenId: anmeldungSlots.verfahrenId, startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt })
    .from(anmeldungSlots)
    .where(eq(anmeldungSlots.id, slotId))
    .for("update");
  if (!slot || slot.verfahrenId !== verfahrenId) throw new ValidationError({ slotId: "Termin gibt es nicht" });
  if (opts.future && slot.startsAt <= now) throw new ValidationError({ slotId: "Dieser Termin liegt in der Vergangenheit – bitte einen anderen wählen" });
  const exceptAntragId = opts.exceptAntragId;
  const conds = [eq(anmeldungAntraege.slotId, slotId), holdsSlot(now)];
  if (exceptAntragId) conds.push(ne(anmeldungAntraege.id, exceptAntragId));
  const [b] = await tx
    .select({ n: count() })
    .from(anmeldungAntraege)
    .where(and(...conds));
  if ((b?.n ?? 0) >= slot.capacity) throw new ValidationError({ slotId: "Dieser Termin ist inzwischen ausgebucht – bitte einen anderen wählen" });
  return { startsAt: slot.startsAt, endsAt: slot.endsAt };
}

export interface AntragData {
  childFirstName: string;
  childLastName: string;
  childBirthDate: string;
  primarySchool?: string | null;
  sibling?: boolean;
  siblingNote?: string | null;
  secondChoiceSchool?: string | null;
  parent1Name: string;
  parent1Email: string;
  parent1Phone?: string | null;
  addressStreet?: string | null;
  addressZip?: string | null;
  addressCity?: string | null;
  parent2Name?: string | null;
  parent2Email?: string | null;
  hints?: string | null;
  slotId?: string | null;
}

/**
 * Antrag speichern (unbestätigt, mit Nummer). Die Prüfung der Eingaben (öffentliches Formular) macht P4-34; hier nur
 * Nummer, Termin-Platz und Fristbeginn: unbestätigte Anträge löscht ein Job nach 48 h – `retention_from` = Eingang ist die
 * Rückfallebene, falls der Job einmal nicht läuft (LK-90).
 */
export async function insertAntrag(
  db: Db,
  verfahrenId: string,
  data: AntragData,
  opts: {
    now?: Date;
    confirmTokenHash?: string | null;
    confirmExpiresAt?: Date | null;
    status?: "unbestaetigt" | "eingegangen";
    /** nur künftige Termine annehmen (öffentliches Formular) */
    future?: boolean;
    /** Antrag eines Elternkontos (P4-34b): ohne Mailbestätigung, gleich „eingegangen“ bzw. mit Termin „termin“ */
    parentUserId?: string | null;
  } = {},
): Promise<{ id: string; number: string }> {
  const now = opts.now ?? new Date();
  const v = await loadVerfahren(db, verfahrenId);
  const [sy] = await db.select({ startsOn: schoolYears.startsOn }).from(schoolYears).where(eq(schoolYears.id, v.targetSchoolYearId));
  const year = Number(sy!.startsOn.slice(0, 4));
  const status: AntragStatus = opts.status === "eingegangen" && data.slotId ? "termin" : (opts.status ?? "unbestaetigt");
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        if (data.slotId) await assertSlotFree(tx, verfahrenId, data.slotId, { now, future: opts.future });
        // GATE-4c (Code-L2): Nummernvergabe je Jahr hintereinander – sonst bekommen viele gleichzeitige Einreichungen auf
        // verschiedene Termine (Öffnung um 8:00) dieselbe Nummer und laufen in die Wiederholung (Reihenfolge: Termin, dann Nummer)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`anmeldung:nummer:${year}`}))`);
        const [m] = await tx.select({ m: max(anmeldungAntraege.seq) }).from(anmeldungAntraege).where(eq(anmeldungAntraege.year, year));
        const seq = (m?.m ?? 0) + 1;
        const [row] = await tx
          .insert(anmeldungAntraege)
          .values({
            ...data,
            verfahrenId,
            year,
            seq,
            status,
            slotId: data.slotId ?? null,
            parentUserId: opts.parentUserId ?? null,
            consentAt: now,
            confirmTokenHash: opts.confirmTokenHash ?? null,
            confirmExpiresAt: opts.confirmExpiresAt ?? null,
            confirmedAt: status === "unbestaetigt" ? null : now,
            retentionFrom: status === "unbestaetigt" ? now : null,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: anmeldungAntraege.id });
        await tx
          .insert(anmeldungEreignisse)
          .values({ antragId: row!.id, at: now, actorId: opts.parentUserId ?? null, kind: "eingegangen", text: status === "unbestaetigt" ? "Online-Formular" : opts.parentUserId ? "Elternkonto" : "" });
        return { id: row!.id, number: antragNumber(year, seq) };
      });
    } catch (err) {
      // zwei Anträge gleichzeitig: nächste Nummer versuchen
      if (!isUniqueViolation(err) || attempt >= 4) throw err;
    }
  }
}

// ---------------------------------------------------------------- Statusmaschine

/** Erlaubte Übergänge. Entscheidungen lassen sich korrigieren (z. B. nach Widerspruch), solange nicht übernommen. */
export const TRANSITIONS: Record<AntragStatus, readonly AntragStatus[]> = {
  unbestaetigt: ["eingegangen", "termin", "zurueckgezogen"],
  eingegangen: ["termin", "vollstaendig", "aufgenommen", "warteliste", "abgelehnt", "zurueckgezogen"],
  termin: ["eingegangen", "vollstaendig", "aufgenommen", "warteliste", "abgelehnt", "zurueckgezogen"],
  vollstaendig: ["eingegangen", "termin", "aufgenommen", "warteliste", "abgelehnt", "zurueckgezogen"],
  aufgenommen: ["warteliste", "abgelehnt", "zurueckgezogen", "uebernommen"],
  warteliste: ["aufgenommen", "abgelehnt", "zurueckgezogen"],
  abgelehnt: ["aufgenommen", "warteliste"],
  zurueckgezogen: [],
  uebernommen: [],
};

/** Wer darf in diesen Status setzen? `system` = nur Abläufe (Bestätigungslink, Übernahme), nie von Hand. */
export function requiredRight(from: AntragStatus, to: AntragStatus): "anmeldung.manage" | "anmeldung.decide" | "system" {
  if (from === "unbestaetigt" || to === "uebernommen") return "system";
  if ((DECISION_STATUSES as readonly string[]).includes(to)) return "anmeldung.decide";
  // eine Entscheidung zurücknehmen bzw. einen entschiedenen Antrag zurückziehen: auch Entscheidungsrecht
  if ((DECISION_STATUSES as readonly string[]).includes(from)) return "anmeldung.decide";
  return "anmeldung.manage";
}

export function canTransition(from: AntragStatus, to: AntragStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Rein (Q5-19, GATE-4c U1): Nachrücken von der Warteliste nach Verfahrensabschluss. Nur `warteliste → aufgenommen` und nur
 * vor Beginn des Zielschuljahres (Berliner Datum); alle anderen Änderungen bleiben nach dem Abschluss gesperrt.
 */
export function lateAdmissionOpen(schoolYearStartsOn: string | null | undefined, now: Date): boolean {
  return Boolean(schoolYearStartsOn) && toBerlinDate(now) < schoolYearStartsOn!;
}

export function isLateAdmission(from: AntragStatus, to: AntragStatus): boolean {
  return from === "warteliste" && to === "aufgenommen";
}

const dmy = (ymd: string) => ymd.split("-").reverse().join(".");

/**
 * Warum Nachrücken gerade nicht geht (null = geht): ab Beginn des Zielschuljahres nicht mehr, und auch nicht, wenn der
 * Schuljahreswechsel die Neuaufnahmen für dieses Schuljahr schon übernommen hat (das Kind käme sonst nie in eine Klasse).
 */
export async function lateAdmissionBlocker(db: Db | Tx, v: Pick<VerfahrenRow, "targetSchoolYearId">, now: Date): Promise<string | null> {
  const [y] = await db.select({ startsOn: schoolYears.startsOn }).from(schoolYears).where(eq(schoolYears.id, v.targetSchoolYearId));
  if (!lateAdmissionOpen(y?.startsOn, now)) return `Nachrücken ist nur bis zum Beginn des Schuljahres möglich${y ? ` (${dmy(y.startsOn)})` : ""}`;
  const [t] = await db
    .select({ id: schoolYearTransitions.id })
    .from(schoolYearTransitions)
    .where(and(eq(schoolYearTransitions.toYearId, v.targetSchoolYearId), isNotNull(schoolYearTransitions.admittedAt)));
  if (t) return "Die Neuaufnahmen für dieses Schuljahr sind schon übernommen – das Kind bitte über die Benutzerverwaltung anlegen";
  return null;
}

const addDaysMs = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Rein: Fristbeginn so, dass nach Abschluss + `keepDays` gelöscht wird (LK-90 zählt ab `retention_from`). */
export function rejectRetentionFrom(completedAt: Date, keepDays: number): Date {
  return addDaysMs(completedAt, keepDays - LK90_DAYS);
}

/**
 * Rein: `retention_from` nach einem Statuswechsel (docs/PHASE4.md §3.3 Datenmodell). Offene und aufgenommene Anträge haben
 * keinen Fristbeginn (NULL – der Löschlauf überspringt sie).
 */
export function retentionFromFor(
  to: AntragStatus,
  ctx: { now: Date; completedAt: Date | null; rejectKeepDays: number; transferredAt?: Date | null },
): Date | null {
  switch (to) {
    case "unbestaetigt":
      return ctx.now;
    case "zurueckgezogen":
      return ctx.now;
    case "abgelehnt":
    case "warteliste":
      return ctx.completedAt ? rejectRetentionFrom(ctx.completedAt, ctx.rejectKeepDays) : null;
    case "uebernommen":
      return ctx.transferredAt ?? ctx.now;
    default:
      return null;
  }
}

export type AntragRow = typeof anmeldungAntraege.$inferSelect;

async function loadAntrag(db: Db | Tx, id: string, lock = false): Promise<AntragRow> {
  const q = db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, id));
  const [a] = lock ? await q.for("update") : await q;
  if (!a) throw new ValidationError({ antrag: "Antrag gibt es nicht" });
  return a;
}

/** Vorgangslink: so viele Tage nach Anmeldeschluss bzw. Termin (das Spätere) gültig. */
export const ACCESS_GRACE_DAYS = 14;

/** Vorgangslink gültig bis Anmeldeschluss bzw. Ende des Termins (das Spätere) + 14 Tage. */
export function accessExpiryFor(closesAt: Date, slotEndsAt: Date | null, now: Date): Date {
  const base = Math.max(closesAt.getTime(), slotEndsAt?.getTime() ?? 0, now.getTime());
  return new Date(base + ACCESS_GRACE_DAYS * 86_400_000);
}

/** GATE-4c (Code-M2): der Antrag hat sich zwischen Lesen und Schreiben geändert (z. B. Eltern ziehen zurück, während entschieden wird). */
export const CHANGED_MEANWHILE = "Der Antrag wurde inzwischen geändert – bitte die Seite neu laden und noch einmal prüfen";

async function event(db: Db | Tx, antragId: string, actorId: string | null, kind: EreignisKind, text: string, at: Date) {
  await db.insert(anmeldungEreignisse).values({ antragId, actorId, kind, text, at });
}

/**
 * Status setzen. `viewer` null = System (Bestätigungslink, Rücknahme durch Eltern, Übernahme). Prüft Übergang, Recht und
 * Verfahrensstand; setzt Entscheidungsdaten und den Fristbeginn; schreibt Verlauf und Audit (ohne Personendaten).
 */
export async function setAntragStatus(
  db: Db,
  viewer: PermissionSet | null,
  antragId: string,
  to: AntragStatus,
  opts: { now?: Date; note?: string | null; transferredUserId?: string | null; from?: AntragStatus } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const a = await loadAntrag(db, antragId);
  const v = await loadVerfahren(db, a.verfahrenId);
  // `from`: Stand, den der Aufrufer gesehen hat (Entscheidung als Liste) – inzwischen anders → nicht still überschreiben
  if (opts.from && a.status !== opts.from) throw new ValidationError({ status: CHANGED_MEANWHILE });
  if (a.status === to) return;
  if (!canTransition(a.status, to)) throw new ValidationError({ status: `Von „${ANTRAG_STATUS_LABELS[a.status]}“ nicht nach „${ANTRAG_STATUS_LABELS[to]}“ möglich` });
  const right = requiredRight(a.status, to);
  if (viewer) {
    if (right === "system") throw new ForbiddenError("anmeldung (nur automatisch)");
    if (!hasPermission(viewer, right)) throw new ForbiddenError(right);
  }
  // die Rücknahme durch die Eltern selbst (System) ist ein Übergang ohne Recht – aber nur aus offenen Status
  if (!viewer && to === "zurueckgezogen" && !["unbestaetigt", ...OPEN_STATUSES].includes(a.status))
    throw new ValidationError({ status: "Über diesen Antrag ist schon entschieden – bitte an das Sekretariat wenden" });
  // Q5-19: nach dem Abschluss nur noch die Übernahme und das Nachrücken von der Warteliste (bis Schuljahresbeginn)
  const late = v.status === "abgeschlossen" && isLateAdmission(a.status, to);
  if (late) {
    const blocked = await lateAdmissionBlocker(db, v, now);
    if (blocked) throw new ValidationError({ status: blocked });
  } else if (v.status === "abgeschlossen" && to !== "uebernommen") throw new ValidationError({ status: "Das Verfahren ist abgeschlossen" });
  if (to === "termin" && !a.slotId) throw new ValidationError({ status: "Erst einen Gesprächstermin wählen" });
  if (to === "uebernommen" && !opts.transferredUserId) throw new ValidationError({ status: "Übernahme ohne Konto" });
  const decision = [...DECISION_STATUSES, "zurueckgezogen"].includes(to);
  const note = opts.note?.trim().slice(0, 1000) || null;
  const transferredAt = to === "uebernommen" ? now : a.transferredAt;
  await db.transaction(async (tx) => {
    // nur, wenn der Status noch der gelesene ist (Lost Update: Rücknahme ↔ Entscheidung ↔ Checkliste, Code-M2)
    const done = await tx
      .update(anmeldungAntraege)
      .set({
        status: to,
        updatedAt: now,
        ...(a.status === "unbestaetigt" ? { confirmedAt: now, confirmTokenHash: null, confirmExpiresAt: null } : {}),
        ...(decision ? { decidedAt: now, decidedBy: viewer?.userId ?? null } : {}),
        ...(decision && note ? { decisionNote: note } : {}),
        ...(to === "uebernommen" ? { transferredUserId: opts.transferredUserId!, transferredAt } : {}),
        retentionFrom: retentionFromFor(to, { now, completedAt: v.completedAt, rejectKeepDays: v.rejectKeepDays, transferredAt }),
      })
      .where(and(eq(anmeldungAntraege.id, antragId), eq(anmeldungAntraege.status, a.status)))
      .returning({ id: anmeldungAntraege.id });
    if (!done.length) throw new ValidationError({ status: CHANGED_MEANWHILE });
    await event(tx, antragId, viewer?.userId ?? null, "status", `${ANTRAG_STATUS_LABELS[a.status]} → ${ANTRAG_STATUS_LABELS[to]}${late ? " (Nachrücken nach Abschluss)" : ""}`, now);
  });
  if (viewer) await audit(db, viewer.userId, "anmeldung.antrag.status", antragId, { von: a.status, nach: to, ...(late ? { nachruecken: true } : {}) });
}

/**
 * Termin setzen bzw. entfernen (Sekretariat). Status folgt: mit Termin „termin“ (aus „eingegangen“), ohne Termin zurück
 * auf „eingegangen“ (aus „termin“); „vollständig“ bleibt. `viewer` null = Eltern über den Bearbeitungslink (P4-35).
 */
export async function setAntragSlot(
  db: Db,
  viewer: PermissionSet | null,
  antragId: string,
  slotId: string | null,
  now = new Date(),
  opts: { future?: boolean } = {},
): Promise<void> {
  if (viewer) assertManage(viewer);
  await db.transaction(async (tx) => {
    // GATE-4c: Antrag zuerst sperren – dieselbe Reihenfolge wie die Bestätigung (Antrag, dann Termin), sonst Deadlock (Code-L3)
    const a = await loadAntrag(tx, antragId, true);
    const [v] = await tx
      .select({ status: anmeldungVerfahren.status, closesAt: anmeldungVerfahren.closesAt })
      .from(anmeldungVerfahren)
      .where(eq(anmeldungVerfahren.id, a.verfahrenId));
    if (v?.status === "abgeschlossen") throw new ValidationError({ slotId: "Das Verfahren ist abgeschlossen" });
    if (!["unbestaetigt", ...OPEN_STATUSES].includes(a.status)) throw new ValidationError({ slotId: "Über diesen Antrag ist schon entschieden" });
    const slot = slotId ? await assertSlotFree(tx, a.verfahrenId, slotId, { exceptAntragId: antragId, now, future: opts.future }) : null;
    const status: AntragStatus = a.status === "eingegangen" && slotId ? "termin" : a.status === "termin" && !slotId ? "eingegangen" : a.status;
    // GATE-4c (Code-L5): Vorgangslink mindestens bis Termin + Karenz gültig halten (nie verkürzen)
    const accessExpiresAt =
      a.accessExpiresAt && slot && v ? new Date(Math.max(a.accessExpiresAt.getTime(), accessExpiryFor(v.closesAt, slot.endsAt, now).getTime())) : a.accessExpiresAt;
    await tx.update(anmeldungAntraege).set({ slotId, status, updatedAt: now, accessExpiresAt }).where(eq(anmeldungAntraege.id, antragId));
    await event(tx, antragId, viewer?.userId ?? null, "termin", slotId ? "Termin gesetzt" : "Termin entfernt", now);
  });
  if (viewer) await audit(db, viewer.userId, "anmeldung.antrag.termin", antragId);
}

/**
 * Checkliste „vorgelegt“ (Häkchen je Unterlage). Sind alle Unterlagen vorgelegt, rückt ein offener Antrag auf
 * „Unterlagen vollständig“ vor; fehlt danach wieder etwas, geht er zurück (mit Termin auf „termin“, sonst „eingegangen“).
 */
export async function setChecklist(
  db: Db,
  viewer: PermissionSet,
  antragId: string,
  checked: Record<string, boolean>,
  keys: readonly string[],
  now = new Date(),
): Promise<AntragStatus> {
  assertManage(viewer);
  const list = Object.fromEntries(keys.map((k) => [k, checked[k] === true]));
  const complete = keys.length > 0 && keys.every((k) => list[k]);
  // GATE-4c (Code-M2): unter Sperre lesen – sonst überschreibt die Checkliste eine gleichzeitige Entscheidung mit altem Stand
  const status = await db.transaction(async (tx) => {
    const a = await loadAntrag(tx, antragId, true);
    if (!OPEN_STATUSES.includes(a.status)) throw new ValidationError({ checklist: "Nur bei offenen Anträgen" });
    const status: AntragStatus = complete ? "vollstaendig" : a.status === "vollstaendig" ? (a.slotId ? "termin" : "eingegangen") : a.status;
    await tx.update(anmeldungAntraege).set({ checklist: list, status, updatedAt: now }).where(eq(anmeldungAntraege.id, antragId));
    if (status !== a.status) await event(tx, antragId, viewer.userId, "status", `${ANTRAG_STATUS_LABELS[a.status]} → ${ANTRAG_STATUS_LABELS[status]}`, now);
    return status;
  });
  await audit(db, viewer.userId, "anmeldung.antrag.unterlagen", antragId, { vollstaendig: complete });
  return status;
}

// ---------------------------------------------------------------- Kapazitäten

export interface CapacitySummary {
  capacity: number | null;
  byStatus: Record<AntragStatus, number>;
  /** noch offene Plätze (Kapazität − aufgenommen − übernommen), null ohne Kapazität */
  free: number | null;
  /** offene Anträge (ohne Entscheidung, bestätigt) */
  undecided: number;
}

/** Kapazität und Stand – nur zur Information bei der Entscheidung (keine automatische Auswahl, Q-34). */
export async function capacitySummary(db: Db, verfahrenId: string): Promise<CapacitySummary> {
  const v = await loadVerfahren(db, verfahrenId);
  const rows = await db
    .select({ status: anmeldungAntraege.status, n: count() })
    .from(anmeldungAntraege)
    .where(eq(anmeldungAntraege.verfahrenId, verfahrenId))
    .groupBy(anmeldungAntraege.status);
  const byStatus = Object.fromEntries((Object.keys(TRANSITIONS) as AntragStatus[]).map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0])) as Record<AntragStatus, number>;
  const taken = byStatus.aufgenommen + byStatus.uebernommen;
  return {
    capacity: v.capacity,
    byStatus,
    free: v.capacity === null ? null : v.capacity - taken,
    undecided: OPEN_STATUSES.reduce((s, k) => s + byStatus[k], 0),
  };
}

export type { VerfahrenStatus };
