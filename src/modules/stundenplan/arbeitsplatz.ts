// VT-03a: Vertretungs-Arbeitsplatz `/planung/vertretungen` – Dringlichkeit der offenen Stunden (Ampel), Kontext der gewählten Stunde
// (Tag der vorgeschlagenen Lehrkraft mit Hohl-/Randstunde, Stundenzahl, Aufsicht, Tagesregel, Bereitschaft), Kopfleiste
// („Gong geplant 18:00 (34)“) und die Ansicht aufgehobener Vertretungen. Nur für die Vertretungsplanung (`stundenplan.substitute`,
// geprüft in der Seite) – Bereitschaft, Tagesregel und Aufsicht sind Personaldienst wie in Vorschlägen und Aufsichtsplan.
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groups, subjects, timetableLessons, users } from "@/core/db/schema";
import type { SchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, toBerlinDate, weekdayMon0 } from "@/core/time";
import { absencesBetween, absentTeachers } from "./abwesenheit";
import { dutiesOn } from "./aufsichten";
import { listStandby } from "./bereitschaft";
import { listTeacherRules } from "./deputate";
import { slotDisplay } from "./display";
import { teacherRuleSummary, type TeacherDayRule } from "./lehrkraftregeln";
import { listSlots, type LessonSlot } from "./service";
import type { PlannedNotification } from "./benachrichtigung";
import type { SubstitutionChangeView } from "./vertretung-historie";
import { schoolYearOn } from "./vertretung-regeln";

// ---------------------------------------------------------------- Ampel der offenen Stunden

/**
 * Dringlichkeit einer Stunde aus dem Vertretungsbedarf: `dringend` = offen und beginnt in höchstens `soonMinutes` Minuten (oder läuft
 * schon), `heute` = offen, später am Tag, `spaeter` = offen an einem kommenden Tag, `vorbei` = offen, aber schon zu Ende,
 * `geregelt` = Vertretung/Entfall/Verlegung eingetragen.
 */
export type Urgency = "dringend" | "heute" | "spaeter" | "vorbei" | "geregelt";

/** Ampel: rot – gelb – grün; vorbei grau. Reihenfolge = Sortierung (dringend zuerst). */
export const URGENCY: Record<Urgency, { label: string; tone: "danger" | "warn" | "success" | "neutral"; order: number }> = {
  dringend: { label: "dringend", tone: "danger", order: 0 },
  heute: { label: "heute", tone: "warn", order: 1 },
  spaeter: { label: "noch Zeit", tone: "warn", order: 2 },
  geregelt: { label: "geregelt", tone: "success", order: 3 },
  vorbei: { label: "vorbei", tone: "neutral", order: 4 },
};

/** Vorgabe: zwei Stunden Vorlauf gelten als dringend (Projektleitung kann ändern; siehe Lebenszyklus-Dokument §3.2 VT-03a). */
export const SOON_MINUTES = 120;

/** Rein: Dringlichkeit einer Stunde am Tag `date` (Zeiten „08:00“ bzw. „08:00:00“, Berliner Ortszeit). */
export function needUrgency(n: { date: string; startsAt: string; endsAt: string; open: boolean }, now: Date, soonMinutes = SOON_MINUTES): Urgency {
  if (!n.open) return "geregelt";
  const start = fromBerlinLocal(`${n.date}T${n.startsAt.slice(0, 5)}`).getTime();
  const end = fromBerlinLocal(`${n.date}T${n.endsAt.slice(0, 5)}`).getTime();
  if (end <= now.getTime()) return "vorbei";
  if (start - now.getTime() <= soonMinutes * 60_000) return "dringend";
  return n.date === toBerlinDate(now) ? "heute" : "spaeter";
}

// ---------------------------------------------------------------- Tagwechsel

/** Rein: vorheriger bzw. nächster Schultag (Wochenende, Feiertage, Ferien übersprungen); höchstens ein Jahr weit. */
export function stepSchoolDay(cal: Pick<SchoolCalendar, "isSchoolDay">, date: string, dir: 1 | -1): string {
  let d = addDays(date, dir);
  for (let i = 0; i < 370 && !cal.isSchoolDay(d); i++) d = addDays(d, dir);
  return d;
}

// ---------------------------------------------------------------- Kopfleiste: Nachrichten

const timeOnly = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayTime = new Intl.DateTimeFormat("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

/**
 * Rein: Kurzanzeige der Sendewarteschlange für die Kopfleiste – „Gong geplant 18:00 (34)“ (nächster Termin, heute nur die Uhrzeit,
 * sonst mit Wochentag; in Klammern alle eingeplanten Personen), „Gong fällig (3)“, wenn der Termin schon erreicht ist (der Minutentakt
 * holt ihn gleich ab). `null` ohne offene Einträge.
 */
export function gongSummary(planned: readonly Pick<PlannedNotification, "dueAt" | "people">[], now: Date): string | null {
  if (planned.length === 0) return null;
  const next = planned.reduce((a, b) => (b.dueAt < a.dueAt ? b : a));
  const people = planned.reduce((s, p) => s + p.people, 0);
  if (next.dueAt.getTime() <= now.getTime()) return `Gong fällig (${people})`;
  const at = toBerlinDate(next.dueAt) === toBerlinDate(now) ? timeOnly.format(next.dueAt) : dayTime.format(next.dueAt);
  return `Gong geplant ${at} (${people})`;
}

// ---------------------------------------------------------------- Kontext: Tag einer Lehrkraft

export type DayPosition = "Hohlstunde" | "Randstunde" | "hat sonst frei";

/** Rein: Lage einer zusätzlichen Stunde im Tag (wie in den Vorschlägen): zwischen eigenen Stunden, am Rand oder an einem freien Tag. */
export function dayPosition(held: readonly number[], nr: number): DayPosition {
  if (!held.length) return "hat sonst frei";
  return held.some((p) => p < nr) && held.some((p) => p > nr) ? "Hohlstunde" : "Randstunde";
}

export interface TeacherDayEntry {
  label: string;
  /** hält die Stunde tatsächlich (nicht entfallen/vertreten/verlegt) */
  held: boolean;
  /** übernimmt sie als Vertretung */
  covering: boolean;
}

export interface TeacherDayPeriod {
  nr: number;
  startsAt: string;
  entries: TeacherDayEntry[];
  standby: boolean;
  /** Aufsicht in der Pause nach dieser Stunde */
  duties: string[];
  /** die zu vertretende Stunde */
  candidate: boolean;
}

export interface TeacherDay {
  periods: TeacherDayPeriod[];
  /** gehaltene Stunden an dem Tag (ohne die Vertretung) */
  held: number;
  /** Lage der Vertretungsstunde; `null`, wenn die Lehrkraft zu der Zeit selbst unterrichtet */
  position: DayPosition | null;
  /** zu der Zeit selbst im Unterricht */
  busy: boolean;
  standbyNow: boolean;
  /** Tagesregel („höchstens 5 Std./Tag“) und ob die Vertretung darüber hinausginge */
  rule: string | null;
  overRule: boolean;
}

/** Rein: Tagesübersicht einer Lehrkraft für die Vertretung in Stunde `candidate`. */
export function buildTeacherDay(input: {
  periods: readonly { nr: number; startsAt: string }[];
  entries: readonly (TeacherDayEntry & { periodNr: number })[];
  standby: readonly number[];
  duties: readonly { afterPeriod: number; label: string }[];
  candidate: number;
  rule: TeacherDayRule | null;
}): TeacherDay {
  const heldPeriods = [...new Set(input.entries.filter((e) => e.held).map((e) => e.periodNr))].sort((a, b) => a - b);
  const busy = heldPeriods.includes(input.candidate);
  const summary = input.rule ? teacherRuleSummary(input.rule) : "";
  return {
    periods: input.periods.map((p) => ({
      nr: p.nr,
      startsAt: p.startsAt.slice(0, 5),
      entries: input.entries.filter((e) => e.periodNr === p.nr).map(({ label, held, covering }) => ({ label, held, covering })),
      standby: input.standby.includes(p.nr),
      duties: input.duties.filter((d) => d.afterPeriod === p.nr).map((d) => d.label),
      candidate: p.nr === input.candidate,
    })),
    held: heldPeriods.length,
    position: busy ? null : dayPosition(heldPeriods, input.candidate),
    busy,
    standbyNow: input.standby.includes(input.candidate),
    rule: summary || null,
    overRule: !busy && input.rule?.maxPerDay != null && heldPeriods.length + 1 > input.rule.maxPerDay,
  };
}

export interface TeacherContext extends TeacherDay {
  id: string;
  code: string | null;
  name: string;
  /** an dem Tag zu der Stunde abwesend */
  absent: boolean;
}

/** Tag einer (vorgeschlagenen) Lehrkraft für die Vertretung einer Stunde – Entwurfstage mit (nur Vertretungsplanung). */
export async function teacherDayContext(db: Db, teacherId: string, date: string, candidate: number, periodList: readonly { nr: number; startsAt: string }[]): Promise<TeacherContext | null> {
  const [t] = await db.select({ id: users.id, code: users.shortCode, name: users.name, role: users.role }).from(users).where(eq(users.id, teacherId));
  if (!t || t.role !== "lehrkraft") return null;
  const year = await schoolYearOn(db, date);
  const [slots, standby, rules, duties, absences] = await Promise.all([
    listSlots(db, { kind: "teacher", id: teacherId }, date, addDays(date, 1), { drafts: true }),
    year ? listStandby(db, year.id) : Promise.resolve([]),
    year ? listTeacherRules(db, year.id) : Promise.resolve(new Map<string, TeacherDayRule>()),
    dutiesOn(db, date),
    absencesBetween(db, date, date),
  ]);
  const weekday = weekdayMon0(date);
  const day = buildTeacherDay({
    periods: periodList,
    entries: slots.map((s) => {
      const d = slotDisplay(s, "teacher");
      const held = d.tone !== "off";
      return { periodNr: s.periodNr, label: [s.subjectName, s.groupName, d.tag].filter(Boolean).join(" · "), held, covering: s.perspective === "covering" };
    }),
    standby: standby.filter((s) => s.teacherId === teacherId && s.weekday === weekday).map((s) => s.periodNr),
    duties: duties
      .filter((d) => (d.teacherId === teacherId && (d.status === "regular" || d.status === "open") && !d.absent) || d.change?.substituteId === teacherId)
      .map((d) => ({ afterPeriod: d.afterPeriod, label: `Aufsicht ${d.areaName} (${d.breakLabel})` })),
    candidate,
    rule: rules.get(teacherId) ?? null,
  });
  return { ...day, id: t.id, code: t.code, name: t.name, absent: absentTeachers(absences, date, candidate).has(teacherId) };
}

/** Tagesplan der Klasse (bzw. Gruppe) der gewählten Stunde – mit Entwurfstagen (nur Vertretungsplanung). */
export async function classDay(db: Db, groupId: string, date: string): Promise<LessonSlot[]> {
  const slots = await listSlots(db, { kind: "group", id: groupId }, date, addDays(date, 1), { drafts: true });
  return slots.sort((a, b) => a.periodNr - b.periodNr || a.subjectName.localeCompare(b.subjectName, "de"));
}

// ---------------------------------------------------------------- Aufgehobene Vertretungen (Verlauf ohne Zeile)

export interface RemovedSubstitution {
  lessonId: string;
  periodNr: number;
  groupId: string;
  groupName: string;
  subjectName: string;
  removedAt: Date;
  actorId: string | null;
}

/**
 * Rein: Stunden, deren letzter Verlaufseintrag an dem Tag ein Aufheben ist und die heute keine Änderung mehr haben – die Zeile
 * fehlt in „Alle Änderungen“, der Verlauf bleibt über die Stunde erreichbar (VT-02-Übergabe).
 */
export function removedLessons(history: readonly Pick<SubstitutionChangeView, "lessonId" | "action" | "createdAt" | "actorId">[], current: ReadonlySet<string>): { lessonId: string; removedAt: Date; actorId: string | null }[] {
  const last = new Map<string, Pick<SubstitutionChangeView, "lessonId" | "action" | "createdAt" | "actorId">>();
  for (const h of history) {
    if (!h.lessonId) continue;
    const prev = last.get(h.lessonId);
    if (!prev || prev.createdAt <= h.createdAt) last.set(h.lessonId, h);
  }
  return [...last.values()]
    .filter((h) => h.action === "delete" && !current.has(h.lessonId!))
    .map((h) => ({ lessonId: h.lessonId!, removedAt: h.createdAt, actorId: h.actorId }));
}

/** Aufgehobene Vertretungen eines Tages mit Stunde, Gruppe und Fach (Verlauf aus `substitutionHistory`). */
export async function removedSubstitutions(db: Db, history: readonly SubstitutionChangeView[], current: ReadonlySet<string>): Promise<RemovedSubstitution[]> {
  const removed = removedLessons(history, current);
  if (removed.length === 0) return [];
  const rows = await db
    .select({ id: timetableLessons.id, periodNr: timetableLessons.periodNr, groupId: timetableLessons.groupId, groupName: groups.name, subjectName: subjects.name })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .where(inArray(timetableLessons.id, removed.map((r) => r.lessonId)));
  const of = new Map(rows.map((r) => [r.id, r]));
  return removed
    .filter((r) => of.has(r.lessonId))
    .map((r) => ({ ...r, ...of.get(r.lessonId)!, lessonId: r.lessonId }))
    .sort((a, b) => a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true }));
}

/** Gruppe einer Stunde (für den Deeplink `?stunde=` ohne Lehrkraft/Gruppe). */
export async function lessonGroup(db: Db, lessonId: string): Promise<string | null> {
  const [l] = await db.select({ groupId: timetableLessons.groupId }).from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  return l?.groupId ?? null;
}

/**
 * VT-03b: Nachbarn der gewählten Stunde in der Reihenfolge der offenen Stunden (Ampel). `prev`/`next` für ↑/↓ ohne Umbruch.
 * `afterSave` = nächste offene Stunde nach dem Speichern: die folgende, sonst die erste andere; null, wenn keine andere offen ist.
 */
export function openNeighbours(openIds: readonly string[], current: string | null): { prev: string | null; next: string | null; afterSave: string | null } {
  const i = current ? openIds.indexOf(current) : -1;
  const others = openIds.filter((id) => id !== current);
  if (i < 0) return { prev: null, next: openIds[0] ?? null, afterSave: others[0] ?? null };
  return { prev: openIds[i - 1] ?? null, next: openIds[i + 1] ?? null, afterSave: openIds[i + 1] ?? others[0] ?? null };
}
