// Vertretungs-Gong gebündelt (Q5-03, I-03/I-09): eine Nachricht je Person und Tag statt eines Gongs je Stunde. Jede Änderung
// (Speichern oder Zurücknehmen) ersetzt die Tagesnachricht der Betroffenen durch den aktuellen Stand des Tages. Empfänger:
// Schüler:innen der Gruppe, Lehrkraft, Vertretungslehrkraft und – nach der Moduleinstellung „Eltern über Vertretungen und
// Entfall informieren bis Jahrgang“ (Vorgabe ganze Sek I, Oberstufe nie, F-02) – Eltern der betroffenen Schüler:innen.
// GATE-031 (S-05): Eltern bekommen die Notiz der Vertretung nicht (Freitext – könnte einen Abwesenheitsgrund enthalten; VVT:
// „ohne Grund für die Abwesenheit einer Lehrkraft“). GATE-031 (C-07): Lesen des Tagesstands und Ersetzen der Nachricht
// unter einer Sperre je Tag – sonst überschreibt eine ältere Fassung eine neuere, wenn zwei Personen gleichzeitig ändern.
// VT-04: Hier stehen nur Inhalt und Empfänger der Nachricht; wann sie rausgeht (Warteschlange, Vortags-Uhrzeit, Ruhezeit), regelt
// `benachrichtigung.ts` (`notifySubstitutionDay`).
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { groupMembers, groups, parentChild, subjects, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { readGradeSetting } from "@/core/modules/settings";
import { sek1GradeOf, withinGradeSetting } from "@/core/school/grades";
import { parentInformedSql, parentLinks } from "@/core/school/majority";
import { TZ, fromBerlinLocal } from "@/core/time";
import { coupledGroupLabel, reasonLabel, roomShift, subjectLabel } from "./display";
import { PARENTS_SUBSTITUTION } from "./settings";
import type { SubstitutionKind, SubstitutionReason } from "./schema";

const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });

export interface DayChange {
  lessonId: string;
  groupId: string;
  groupName: string;
  periodNr: number;
  /** tatsächliches Fach (SP-12: bei Fachtausch das Fach der Vertretung) */
  subjectName: string;
  /** SP-12: reguläres Fach, wenn die Vertretung ein anderes gibt („Mathe statt Sport“) */
  insteadOf?: string | null;
  kind: SubstitutionKind;
  /** SP2-07 Verlegung: neue Stunde */
  targetPeriod?: number | null;
  /** SP2-07 Zusammenlegung: Gruppe der Stunde, zu der die Gruppe geht (die Lehrkraft dort steht in `substituteId`/`substituteName`) */
  mergeGroup?: string | null;
  teacherId: string | null;
  substituteId: string | null;
  substituteName: string | null;
  /** neuer Raum */
  roomId: string | null;
  note: string | null;
  /** VT-04: bisheriger Raum der Stunde (für „Raum 106 → 105“) */
  oldRoomId?: string | null;
  /** VT-04 (F-10-8): öffentliche Grund-Kategorie – auch für Eltern */
  reason?: SubstitutionReason | null;
  /** VT-04 (F-10-9): Vertretung nur als Betreuung */
  supervisionOnly?: boolean;
  /** VT-04 (F-10-10): Vertretungslehrkraft hat die Vertretung schon bestätigt */
  acknowledged?: boolean;
}

export const bundleKey = (date: string) => `stundenplan:${date}`;

/** Gekoppelte Gruppen mit derselben Änderung in einer Zeile: „Mathe (7a/7b)“. */
function merge(changes: readonly DayChange[]): (DayChange & { groupNames: string[] })[] {
  const out = new Map<string, DayChange & { groupNames: string[] }>();
  for (const c of [...changes].sort((a, b) => a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true }))) {
    const key = [c.periodNr, c.subjectName, c.insteadOf, c.kind, c.substituteId, c.roomId, c.oldRoomId, c.note, c.targetPeriod, c.mergeGroup, c.reason, c.supervisionOnly].join("|");
    const prev = out.get(key);
    if (prev) {
      if (!prev.groupNames.includes(c.groupName)) prev.groupNames.push(c.groupName);
    } else out.set(key, { ...c, groupNames: [c.groupName] });
  }
  return [...out.values()];
}

const KIND_WORD = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung", move: "Verlegung", merge: "Zusammenlegung" } as const;
/** VT-04 (F-10-9): „Betreuung“ statt „Vertretung“ wie im Vertretungsplan */
const kindWord = (c: Pick<DayChange, "kind" | "supervisionOnly">) => (c.kind === "substitute" && c.supervisionOnly ? "Betreuung" : KIND_WORD[c.kind]);

/**
 * Tagesnachricht für eine Person. Rein. Eine Änderung: wie bisher („Entfall Di, 13.10., 3. Std: Mathe (7b)“, Einzelheiten im
 * Text); mehrere: Zusammenfassung im Titel, je Stunde eine Zeile im Text; keine (zurückgenommen): Hinweis auf den Regelplan.
 * VT-04: Einzelheiten mit Raum „alt → neu“ (Regel `roomShift` wie im Vertretungsplan; Zusammenlegung: Raum der anderen Stunde) und
 * Grund-Kategorie.
 */
export function dayMessage(date: string, changes: readonly DayChange[]): { title: string; body: string | null } {
  const day = shortDay.format(fromBerlinLocal(date));
  const lines = merge(changes);
  if (lines.length === 0) return { title: `Vertretungsplan ${day}: keine Änderungen mehr`, body: "Die Änderungen für diesen Tag sind zurückgenommen – es gilt der reguläre Stundenplan." };
  const what = (c: (typeof lines)[number]) => `${subjectLabel(c.subjectName, c.insteadOf)} (${coupledGroupLabel(c.groupNames)})`;
  const detail = (c: DayChange, sep: string) =>
    [
      c.kind === "move" && c.targetPeriod ? `in der ${c.targetPeriod}. Std` : null,
      c.kind === "merge" && c.mergeGroup ? `mit ${coupledGroupLabel([c.mergeGroup])}` : null,
      // R1b/A10: die aufnehmende Stunde gibt es nicht mehr – die Stunde wird neu geregelt
      c.kind === "merge" && !c.mergeGroup ? "aufgehoben – wird neu geregelt" : null,
      (c.kind === "substitute" || c.kind === "merge") && c.substituteName ? `bei ${c.substituteName}` : null,
      c.roomId ? `Raum ${c.kind === "merge" ? c.roomId : roomShift(c.oldRoomId, c.roomId)}` : null,
      reasonLabel(c.reason) ? `Grund: ${reasonLabel(c.reason)}` : null,
      c.note,
    ]
      .filter(Boolean)
      .join(sep);
  if (lines.length === 1) {
    const c = lines[0]!;
    return { title: `${kindWord(c)} ${day}, ${c.periodNr}. Std: ${what(c)}`, body: detail(c, " · ") || null };
  }
  const cancels = lines.filter((c) => c.kind === "cancel").length;
  const others = lines.length - cancels;
  const summary = [others && (others === 1 ? "1 Änderung" : `${others} Änderungen`), cancels && (cancels === 1 ? "1 Entfall" : `${cancels} Stunden entfallen`)].filter(Boolean).join(", ");
  const body = lines
    .map((c) => {
      const d = detail(c, ", ");
      return `${c.periodNr}. Std ${what(c)}: ${kindWord(c)}${d ? ` – ${d}` : ""}`;
    })
    .join(" · ");
  return { title: `Vertretungsplan ${day}: ${summary}`, body };
}

const substitute = alias(users, "substitute");
const altSubject = alias(subjects, "alt_subject");

/** Alle Änderungen eines Tages mit Gruppe, Lehrkraft und Vertretung. */
export async function dayChanges(db: Db, date: string): Promise<DayChange[]> {
  const rows = await db
    .select({
      lessonId: timetableSubstitutions.lessonId,
      groupId: timetableLessons.groupId,
      groupName: groups.name,
      periodNr: timetableLessons.periodNr,
      subjectName: subjects.name,
      kind: timetableSubstitutions.kind,
      teacherId: timetableLessons.teacherId,
      substituteId: timetableSubstitutions.substituteId,
      substituteName: substitute.name,
      roomId: timetableSubstitutions.roomId,
      note: timetableSubstitutions.note,
      targetPeriod: timetableSubstitutions.targetPeriod,
      mergeLessonId: timetableSubstitutions.mergeLessonId,
      altName: altSubject.name,
      oldRoomId: timetableLessons.roomId,
      reason: timetableSubstitutions.reason,
      supervisionOnly: timetableSubstitutions.supervisionOnly,
      acknowledgedAt: timetableSubstitutions.acknowledgedAt,
    })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
    .leftJoin(altSubject, eq(altSubject.id, timetableSubstitutions.subjectId))
    .where(eq(timetableSubstitutions.date, date));
  // SP2-07 Zusammenlegung: die Lehrkraft der anderen Stunde (bzw. deren Vertretung) betreut mit – sie steht als „Vertretung“ in der Zeile
  const hostIds = rows.filter((r) => r.kind === "merge" && r.mergeLessonId).map((r) => r.mergeLessonId!);
  const hostTeacher = alias(users, "host_teacher");
  const hosts = hostIds.length
    ? await db
        .select({
          id: timetableLessons.id,
          groupName: groups.name,
          roomId: timetableLessons.roomId,
          teacherId: timetableLessons.teacherId,
          teacherName: hostTeacher.name,
          kind: timetableSubstitutions.kind,
          substituteId: timetableSubstitutions.substituteId,
          substituteName: substitute.name,
          newRoomId: timetableSubstitutions.roomId,
        })
        .from(timetableLessons)
        .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
        .leftJoin(hostTeacher, eq(hostTeacher.id, timetableLessons.teacherId))
        .leftJoin(timetableSubstitutions, and(eq(timetableSubstitutions.lessonId, timetableLessons.id), eq(timetableSubstitutions.date, date)))
        .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
        .where(inArray(timetableLessons.id, hostIds))
    : [];
  return rows.map(({ altName, mergeLessonId, acknowledgedAt, ...rest }) => {
    const r: DayChange = { ...rest, acknowledged: acknowledgedAt !== null };
    const out: DayChange = altName ? { ...r, subjectName: altName, insteadOf: r.subjectName } : r;
    const h = r.kind === "merge" ? hosts.find((x) => x.id === mergeLessonId) : undefined;
    if (!h) return out;
    const covered = h.kind === "substitute";
    return {
      ...out,
      mergeGroup: h.groupName,
      substituteId: covered ? h.substituteId : h.teacherId,
      substituteName: covered ? h.substituteName : h.teacherName,
      roomId: h.newRoomId ?? h.roomId,
    };
  });
}

/** Eltern, die über diese Schüler:innen informiert werden (Moduleinstellung), mit allen ihren berechtigten Kindern. */
export async function informedParents(db: Db, studentIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (studentIds.length === 0) return out;
  const max = await readGradeSetting(db, PARENTS_SUBSTITUTION);
  if (max === 0) return out;
  const parents = [
    ...new Set((await parentLinks(db, studentIds, "inform")).map((r) => r.parentId)),
  ];
  if (parents.length === 0) return out;
  // alle Kinder dieser Eltern: wer Kinder in 6b und 9a hat, bekommt trotzdem nur eine Nachricht am Tag
  // Q5-05: eigenständige Kinder nur mit deren Einwilligung
  const pairs = await db
    .select({ p: parentChild.parentId, c: parentChild.childId })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(inArray(parentChild.parentId, parents), parentInformedSql()));
  const grades = await sek1GradeOf(
    db,
    pairs.map((x) => x.c),
  );
  for (const { p, c } of pairs) {
    if (!withinGradeSetting(grades.get(c), max)) continue;
    out.set(p, (out.get(p) ?? new Set()).add(c));
  }
  // nur Eltern, bei denen mindestens ein betroffenes Kind berechtigt ist
  const affected = new Set(studentIds);
  for (const [p, kids] of out) if (![...kids].some((k) => affected.has(k))) out.delete(p);
  return out;
}

/** Betroffene einer Änderung: Schüler:innen der Gruppen und Lehrkräfte (Lehrkraft der Stunde, Vertretung – auch eine vorherige). */
export type Affected = { students: readonly string[]; teachers: readonly string[] };

export interface DayMessageItem {
  userId: string;
  title: string;
  body: string | null;
  href: string;
  /** Zahl der Änderungen für die Person (0 = „keine Änderungen mehr“) */
  changes: number;
}

/**
 * VT-04 (F-10-10): Erinnerung an noch nicht bestätigte Vertretungen – in der Nachricht an die Vertretungslehrkraft (ohne Eskalation).
 * Rein; `n` = Zahl der Stunden.
 */
export function withAckReminder(msg: { title: string; body: string | null }, n: number): { title: string; body: string | null } {
  if (n === 0) return msg;
  const line = n === 1 ? "Bitte bestätigen: 1 Vertretung ist noch nicht als „Gesehen“ markiert." : `Bitte bestätigen: ${n} Vertretungen sind noch nicht als „Gesehen“ markiert.`;
  return { title: msg.title, body: msg.body ? `${msg.body} · ${line}` : line };
}

/**
 * Tagesnachricht je betroffener Person aus dem **aktuellen** Stand des Tages (Endstand): Schüler:innen ihre Gruppen, Lehrkräfte ihre
 * Stunden und Vertretungen, Eltern nach Moduleinstellung (ohne Notiz, GATE-031 S-05). Mit `ackReminder` bekommt die
 * Vertretungslehrkraft die Erinnerung an unbestätigte Vertretungen dazu. Die Planung (Sperre, Entwurf, Empfängerauswahl) macht
 * der Aufrufer (`benachrichtigung.ts`).
 */
export async function buildDayMessages(db: Db, date: string, affected: Affected, opts: { ackReminder?: boolean } = {}): Promise<DayMessageItem[]> {
  const changes = await dayChanges(db, date);
  const parents = await informedParents(db, affected.students);
  const kids = [...new Set([...parents.values()].flatMap((s) => [...s]))];
  const people = [...new Set([...affected.students, ...kids])];
  const groupIds = [...new Set(changes.map((c) => c.groupId))];
  const memberRows =
    people.length && groupIds.length
      ? await db
          .select({ u: groupMembers.userId, g: groupMembers.groupId })
          .from(groupMembers)
          .where(and(inArray(groupMembers.userId, people), inArray(groupMembers.groupId, groupIds)))
      : [];
  const groupsOf = new Map<string, Set<string>>();
  for (const r of memberRows) groupsOf.set(r.u, (groupsOf.get(r.u) ?? new Set()).add(r.g));

  const recipients = new Map<string, DayChange[]>();
  const add = (userId: string, list: DayChange[]) => {
    const prev = recipients.get(userId) ?? [];
    recipients.set(userId, [...prev, ...list.filter((c) => !prev.some((x) => x.lessonId === c.lessonId))]);
  };
  for (const s of affected.students) add(s, changes.filter((c) => groupsOf.get(s)?.has(c.groupId)));
  for (const t of affected.teachers) add(t, changes.filter((c) => c.teacherId === t || c.substituteId === t));
  // S-05: Eltern ohne Notiz (Freitext der Planung) – ist ein Elternteil zugleich Lehrkraft der Stunde, sieht es sie dort
  const forParents = changes.map((c) => ({ ...c, note: null }));
  for (const [p, children] of parents) add(p, forParents.filter((c) => [...children].some((k) => groupsOf.get(k)?.has(c.groupId))));

  const teachers = new Set(affected.teachers);
  const href = `/stundenplan?woche=${date}`;
  return [...recipients].map(([userId, list]) => {
    const msg = dayMessage(date, list);
    // je Stunde einmal (Kopplungsteile zählen zusammen)
    const open = opts.ackReminder && teachers.has(userId) ? new Set(list.filter((c) => c.kind === "substitute" && c.substituteId === userId && !c.acknowledged).map((c) => c.periodNr)).size : 0;
    const base = { userId, changes: list.length };
    return open ? { ...base, ...withAckReminder(msg, open), href: "/stundenplan/vertretungen#meine-vertretungen" } : { ...base, ...msg, href };
  });
}

