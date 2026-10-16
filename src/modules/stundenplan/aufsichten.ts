// Pausenaufsichten (P2b-20): Bereiche, Aufsichtsplan je Schuljahr, offene Aufsichten bei Abwesenheit, Vertretung.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { periods, timetableDutyAreas, timetableDutyChanges, timetableDuties, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { notifyBundled } from "@/core/notifications";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { absencesBetween, absenceCovers, type Absence } from "./abwesenheit";
import { lessonActiveOn } from "./service";
import { planningYear } from "./verteilung";

export interface BreakSlot {
  /** Pause nach dieser Stunde */
  afterPeriod: number;
  startsAt: string;
  endsAt: string;
  label: string;
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Rein: Pausen aus dem Zeitraster – Lücken von mindestens `minGap` Minuten zwischen zwei Stunden. */
export function breaksFrom(ps: { nr: number; startsAt: string; endsAt: string }[], minGap = 10): BreakSlot[] {
  const sorted = [...ps].sort((a, b) => a.nr - b.nr);
  const out: BreakSlot[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (minutes(b.startsAt) - minutes(a.endsAt) < minGap) continue;
    out.push({ afterPeriod: a.nr, startsAt: a.endsAt, endsAt: b.startsAt, label: "" });
  }
  // „1. Pause“, „2. Pause“ …; die längste heißt „große Pause“, wenn sie eindeutig ist
  const longest = Math.max(...out.map((x) => minutes(x.endsAt) - minutes(x.startsAt)));
  const unique = out.filter((x) => minutes(x.endsAt) - minutes(x.startsAt) === longest).length === 1;
  out.forEach((x, i) => (x.label = unique && minutes(x.endsAt) - minutes(x.startsAt) === longest ? `${i + 1}. Pause (große)` : `${i + 1}. Pause`));
  return out;
}

export async function schoolBreaks(db: Db): Promise<BreakSlot[]> {
  return breaksFrom(await db.select().from(periods));
}

// ---------------------------------------------------------------- Bereiche

export async function listAreas(db: Db) {
  return db.select().from(timetableDutyAreas).orderBy(asc(timetableDutyAreas.sortOrder), asc(timetableDutyAreas.name));
}

export async function createArea(db: Db, actorId: string, name: string): Promise<string> {
  const n = name.trim();
  if (!n || n.length > 60) throw new ValidationError({ name: "Name mit 1 bis 60 Zeichen" });
  const areas = await listAreas(db);
  if (areas.some((a) => a.name.toLowerCase() === n.toLowerCase())) throw new ValidationError({ name: "Diesen Bereich gibt es schon" });
  const [row] = await db
    .insert(timetableDutyAreas)
    .values({ name: n, sortOrder: (areas.at(-1)?.sortOrder ?? 0) + 1 })
    .returning({ id: timetableDutyAreas.id });
  await audit(db, actorId, "stundenplan.duty.area_create", null, { name: n });
  return row!.id;
}

export async function deleteArea(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableDutyAreas).where(eq(timetableDutyAreas.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.duty.area_delete", null, { name: old.name });
}

// ---------------------------------------------------------------- Plan

export interface DutyInput {
  areaId: string;
  weekday: number;
  afterPeriod: number;
  teacherId: string;
}

export async function addDuty(db: Db, actorId: string, input: DutyInput): Promise<string> {
  const fe: Record<string, string> = {};
  const year = await planningYear(db);
  if (!year) fe.areaId = "Zuerst ein Schuljahr anlegen";
  const [[area], [teacher], breaks] = await Promise.all([
    db.select({ id: timetableDutyAreas.id }).from(timetableDutyAreas).where(eq(timetableDutyAreas.id, input.areaId)),
    db.select({ role: users.role }).from(users).where(eq(users.id, input.teacherId)),
    schoolBreaks(db),
  ]);
  if (!area) fe.areaId = "Bereich wählen";
  if (teacher?.role !== "lehrkraft") fe.teacherId = "Lehrkraft wählen";
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 4) fe.weekday = "Wochentag wählen";
  if (!breaks.some((b) => b.afterPeriod === input.afterPeriod)) fe.afterPeriod = "Pause wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  // dieselbe Lehrkraft in derselben Pause nur an einem Ort
  const same = await db
    .select({ id: timetableDuties.id, areaId: timetableDuties.areaId })
    .from(timetableDuties)
    .where(and(eq(timetableDuties.schoolYearId, year!.id), eq(timetableDuties.teacherId, input.teacherId), eq(timetableDuties.weekday, input.weekday), eq(timetableDuties.afterPeriod, input.afterPeriod)));
  if (same.length) throw new ValidationError({ teacherId: same[0]!.areaId === input.areaId ? "Die Lehrkraft ist hier schon eingeteilt" : "Die Lehrkraft hat in dieser Pause schon eine Aufsicht" });
  const [row] = await db
    .insert(timetableDuties)
    .values({ schoolYearId: year!.id, ...input })
    .returning({ id: timetableDuties.id });
  await audit(db, actorId, "stundenplan.duty.add", input.teacherId, { area: input.areaId, weekday: input.weekday, after: input.afterPeriod });
  return row!.id;
}

export async function removeDuty(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableDuties).where(eq(timetableDuties.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.duty.remove", old.teacherId, { area: old.areaId, weekday: old.weekday, after: old.afterPeriod });
}

export interface PlannedDuty {
  id: string;
  areaId: string;
  weekday: number;
  afterPeriod: number;
  teacherId: string;
  teacherCode: string | null;
}

export async function dutyPlan(db: Db): Promise<PlannedDuty[]> {
  const year = await planningYear(db);
  if (!year) return [];
  return db
    .select({
      id: timetableDuties.id,
      areaId: timetableDuties.areaId,
      weekday: timetableDuties.weekday,
      afterPeriod: timetableDuties.afterPeriod,
      teacherId: timetableDuties.teacherId,
      teacherCode: users.shortCode,
    })
    .from(timetableDuties)
    .innerJoin(users, eq(users.id, timetableDuties.teacherId))
    .where(eq(timetableDuties.schoolYearId, year.id))
    .orderBy(asc(users.shortCode));
}

// ---------------------------------------------------------------- Tag

/** Rein: Fehlt die Lehrkraft in der Pause? Abwesend in der Stunde davor oder danach (bzw. ganztägig). */
export function absentForBreak(absences: Absence[], teacherId: string, date: string, afterPeriod: number): Absence | null {
  return absences.find((a) => a.teacherId === teacherId && (absenceCovers(a, date, afterPeriod) || absenceCovers(a, date, afterPeriod + 1))) ?? null;
}

export interface DayDuty extends PlannedDuty {
  date: string;
  areaName: string;
  breakLabel: string;
  startsAt: string;
  /** Lehrkraft abwesend → Aufsicht offen, solange keine Vertretung eingetragen ist */
  absent: boolean;
  change: { id: string; substituteId: string | null; substituteCode: string | null } | null;
  status: "regular" | "open" | "covered" | "dropped";
}

/** Aufsichten eines Tages mit Status; Wochenende/Feiertage liefern eine leere Liste über den Aufrufer. */
export async function dutiesOn(db: Db, date: string): Promise<DayDuty[]> {
  const weekday = weekdayMon0(date);
  if (weekday > 4) return [];
  const [plan, areas, breaks, absences] = await Promise.all([dutyPlan(db), listAreas(db), schoolBreaks(db), absencesBetween(db, date, date)]);
  const today = plan.filter((d) => d.weekday === weekday);
  if (!today.length) return [];
  const changes = await db
    .select({ id: timetableDutyChanges.id, dutyId: timetableDutyChanges.dutyId, substituteId: timetableDutyChanges.substituteId, code: users.shortCode })
    .from(timetableDutyChanges)
    .leftJoin(users, eq(users.id, timetableDutyChanges.substituteId))
    .where(and(eq(timetableDutyChanges.date, date), inArray(timetableDutyChanges.dutyId, today.map((d) => d.id))));
  const changeOf = new Map(changes.map((c) => [c.dutyId, c]));
  const areaName = new Map(areas.map((a) => [a.id, { name: a.name, sort: a.sortOrder }]));
  const breakOf = new Map(breaks.map((b) => [b.afterPeriod, b]));
  return today
    .filter((d) => breakOf.has(d.afterPeriod))
    .map((d) => {
      const c = changeOf.get(d.id);
      const absent = Boolean(absentForBreak(absences, d.teacherId, date, d.afterPeriod));
      const status: DayDuty["status"] = c ? (c.substituteId ? "covered" : "dropped") : absent ? "open" : "regular";
      return {
        ...d,
        date,
        areaName: areaName.get(d.areaId)?.name ?? "",
        breakLabel: breakOf.get(d.afterPeriod)!.label,
        startsAt: breakOf.get(d.afterPeriod)!.startsAt,
        absent,
        change: c ? { id: c.id, substituteId: c.substituteId, substituteCode: c.code } : null,
        status,
      };
    })
    .sort((a, b) => a.afterPeriod - b.afterPeriod || (areaName.get(a.areaId)?.sort ?? 0) - (areaName.get(b.areaId)?.sort ?? 0) || (a.teacherCode ?? "").localeCompare(b.teacherCode ?? ""));
}

/**
 * Wer kann die Aufsicht übernehmen? Anwesend, ohne eigene Aufsicht in dieser Pause; bevorzugt, wer davor oder danach
 * Unterricht hat (ist ohnehin im Haus), dann wer heute am wenigsten Aufsichten hat.
 */
export async function dutyCandidates(db: Db, dutyId: string, date: string): Promise<{ id: string; code: string | null; name: string; inHouse: boolean }[]> {
  const day = await dutiesOn(db, date);
  const duty = day.find((d) => d.id === dutyId);
  if (!duty) return [];
  const [teachers, lessons, absences] = await Promise.all([
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")).orderBy(asc(users.shortCode)),
    db.select().from(timetableLessons).where(eq(timetableLessons.weekday, weekdayMon0(date))),
    absencesBetween(db, date, date),
  ]);
  const active = lessons.filter((l) => lessonActiveOn(l, date));
  const subs = active.length
    ? await db.select().from(timetableSubstitutions).where(and(eq(timetableSubstitutions.date, date), inArray(timetableSubstitutions.lessonId, active.map((l) => l.id))))
    : [];
  const subOf = new Map(subs.map((s) => [s.lessonId, s]));
  const inHouse = new Set<string>();
  for (const l of active) {
    if (l.periodNr !== duty.afterPeriod && l.periodNr !== duty.afterPeriod + 1) continue;
    const s = subOf.get(l.id);
    if (l.teacherId && !(s && (s.kind === "cancel" || s.kind === "substitute"))) inHouse.add(l.teacherId);
    if (s?.kind === "substitute" && s.substituteId) inHouse.add(s.substituteId);
  }
  const busy = new Set(day.filter((d) => d.afterPeriod === duty.afterPeriod).flatMap((d) => [d.status === "covered" ? d.change!.substituteId! : d.teacherId]));
  const load = new Map<string, number>();
  for (const d of day) {
    const who = d.status === "covered" ? d.change!.substituteId! : d.teacherId;
    load.set(who, (load.get(who) ?? 0) + 1);
  }
  return teachers
    .filter((t) => !busy.has(t.id) && !absentForBreak(absences, t.id, date, duty.afterPeriod))
    .map((t) => ({ ...t, inHouse: inHouse.has(t.id) }))
    .sort((a, b) => Number(b.inHouse) - Number(a.inHouse) || (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || (a.code ?? "").localeCompare(b.code ?? ""));
}

/** Vertretung für eine Aufsicht eintragen (`substituteId` null = Aufsicht entfällt bewusst). */
export async function setDutyChange(db: Db, actorId: string, dutyId: string, date: string, substituteId: string | null): Promise<void> {
  if (substituteId) {
    const ok = (await dutyCandidates(db, dutyId, date)).some((c) => c.id === substituteId);
    if (!ok) throw new ValidationError({ substituteId: "Die Lehrkraft ist in dieser Pause nicht frei" });
  } else if (!(await dutiesOn(db, date)).some((d) => d.id === dutyId)) throw new ValidationError({ dutyId: "Aufsicht gibt es an diesem Tag nicht" });
  const before = (await dutiesOn(db, date)).find((d) => d.id === dutyId);
  await db
    .insert(timetableDutyChanges)
    .values({ dutyId, date, substituteId, createdBy: actorId })
    .onConflictDoUpdate({ target: [timetableDutyChanges.dutyId, timetableDutyChanges.date], set: { substituteId, createdBy: actorId, createdAt: new Date() } });
  await audit(db, actorId, "stundenplan.duty.change", substituteId, { duty: dutyId, date });
  if (before) await dutyGong(db, actorId, before, before.change?.substituteId ?? null, substituteId);
}

export async function clearDutyChange(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableDutyChanges).where(eq(timetableDutyChanges.id, id)).returning();
  if (!old) return;
  await audit(db, actorId, "stundenplan.duty.change_clear", null, { duty: old.dutyId, date: old.date });
  const duty = (await dutiesOn(db, old.date)).find((d) => d.id === old.dutyId);
  if (duty) await dutyGong(db, actorId, duty, old.substituteId, undefined);
}

// ---------------------------------------------------------------- Gong bei Aufsichtsvertretung (Q5-09, I-19)

const gongDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });

/** „Schulhof, Mo., 5.10. nach der 2. Std“ */
export function dutyLabel(d: Pick<DayDuty, "areaName" | "afterPeriod">, date: string): string {
  return `${d.areaName}, ${gongDay.format(fromBerlinLocal(date))} nach der ${d.afterPeriod}. Std`;
}

/**
 * Nachrichten nach einer Änderung: `next` = neue Vertretung (null = entfällt, undefined = Änderung zurückgenommen).
 * Vertretende bekommen „übernehmen“ bzw. „zurückgenommen“, die eingeteilte Lehrkraft, wer ihre Aufsicht übernimmt bzw. dass
 * sie entfällt oder wieder gilt. Je Person, Aufsicht und Tag eine Nachricht (gebündelt), die handelnde Person nie.
 */
export async function dutyGong(db: Db, actorId: string, duty: DayDuty, prev: string | null, next: string | null | undefined): Promise<number> {
  const what = dutyLabel(duty, duty.date);
  const items: { userId: string; title: string; body?: string; href: string }[] = [];
  if (next) items.push({ userId: next, title: `Aufsicht übernehmen: ${what}`, body: `${duty.breakLabel} ab ${duty.startsAt}`, href: "/" });
  if (prev && prev !== next) items.push({ userId: prev, title: `Aufsicht ${what}: Vertretung zurückgenommen`, body: "Du musst diese Aufsicht nicht übernehmen.", href: "/" });
  if (prev !== next) {
    let mine: string;
    if (next === undefined) mine = `Deine Aufsicht ${what} gilt wieder`;
    else if (next === null) mine = `Deine Aufsicht ${what} entfällt`;
    else {
      const [sub] = await db.select({ name: users.name, code: users.shortCode }).from(users).where(eq(users.id, next));
      mine = `Deine Aufsicht ${what} übernimmt ${sub?.code ?? sub?.name ?? "eine Vertretung"}`;
    }
    items.push({ userId: duty.teacherId, title: mine, href: "/" });
  }
  let n = 0;
  for (const i of items.filter((x) => x.userId !== actorId)) n += await notifyBundled(db, [i], { moduleId: "stundenplan", bundleKey: `aufsicht:${duty.id}:${duty.date}` });
  return n;
}

// ---------------------------------------------------------------- Meine Aufsichten (Q5-09, I-19)

export interface MyDuty {
  dutyId: string;
  date: string;
  afterPeriod: number;
  breakLabel: string;
  startsAt: string;
  areaName: string;
  /** regulär eingeteilt oder als Vertretung */
  kind: "regular" | "covering";
}

/**
 * Aufsichten, die die Lehrkraft an den Schultagen in [from, to) tatsächlich hat: die eigenen (sofern nicht vertreten,
 * entfallen oder wegen Abwesenheit offen) und übernommene.
 */
export async function myDutiesBetween(db: Db, teacherId: string, from: string, to: string): Promise<MyDuty[]> {
  const cal = await loadSchoolCalendar(db);
  const out: MyDuty[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    if (!cal.isSchoolDay(d)) continue;
    for (const x of await dutiesOn(db, d)) {
      const kind = x.status === "regular" && x.teacherId === teacherId ? "regular" : x.status === "covered" && x.change?.substituteId === teacherId ? "covering" : null;
      if (kind) out.push({ dutyId: x.id, date: d, afterPeriod: x.afterPeriod, breakLabel: x.breakLabel, startsAt: x.startsAt, areaName: x.areaName, kind });
    }
  }
  return out;
}

/** Regelplan der eigenen Aufsichten (für den Druck): je Wochentag und Pause. */
export async function myDutyWeek(db: Db, teacherId: string): Promise<{ weekday: number; afterPeriod: number; breakLabel: string; startsAt: string; areaName: string }[]> {
  const [plan, areas, breaks] = await Promise.all([dutyPlan(db), listAreas(db), schoolBreaks(db)]);
  const area = new Map(areas.map((a) => [a.id, a.name]));
  const brk = new Map(breaks.map((b) => [b.afterPeriod, b]));
  return plan
    .filter((d) => d.teacherId === teacherId && brk.has(d.afterPeriod))
    .map((d) => ({ weekday: d.weekday, afterPeriod: d.afterPeriod, breakLabel: brk.get(d.afterPeriod)!.label, startsAt: brk.get(d.afterPeriod)!.startsAt, areaName: area.get(d.areaId) ?? "" }))
    .sort((a, b) => a.weekday - b.weekday || a.afterPeriod - b.afterPeriod);
}
