// Vertretungs-Gong gebündelt (Q5-03, I-03/I-09): eine Nachricht je Person und Tag statt eines Gongs je Stunde. Jede Änderung
// (Speichern oder Zurücknehmen) ersetzt die Tagesnachricht der Betroffenen durch den aktuellen Stand des Tages. Empfänger:
// Schüler:innen der Gruppe, Lehrkraft, Vertretungslehrkraft und – nach der Moduleinstellung „Eltern über Vertretungen und
// Entfall informieren bis Jahrgang“ (Vorgabe ganze Sek I, Oberstufe nie, F-02) – Eltern der betroffenen Schüler:innen.
// GATE-031 (S-05): Eltern bekommen die Notiz der Vertretung nicht (Freitext – könnte einen Abwesenheitsgrund enthalten; VVT:
// „ohne Grund für die Abwesenheit einer Lehrkraft“). GATE-031 (C-07): Lesen des Tagesstands und Ersetzen der Nachricht
// unter einer Sperre je Tag – sonst überschreibt eine ältere Fassung eine neuere, wenn zwei Personen gleichzeitig ändern.
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { groupMembers, groups, parentChild, subjects, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { readGradeSetting } from "@/core/modules/settings";
import { notifyBundled } from "@/core/notifications";
import { sek1GradeOf, withinGradeSetting } from "@/core/school/grades";
import { parentInformedSql, parentLinks } from "@/core/school/majority";
import { TZ, fromBerlinLocal } from "@/core/time";
import { coupledGroupLabel, subjectLabel } from "./display";
import { isDraftDay } from "./freigabe";
import { PARENTS_SUBSTITUTION } from "./settings";
import type { SubstitutionKind } from "./schema";

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
}

const bundleKey = (date: string) => `stundenplan:${date}`;

/** Gekoppelte Gruppen mit derselben Änderung in einer Zeile: „Mathe (7a/7b)“. */
function merge(changes: readonly DayChange[]): (DayChange & { groupNames: string[] })[] {
  const out = new Map<string, DayChange & { groupNames: string[] }>();
  for (const c of [...changes].sort((a, b) => a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true }))) {
    const key = [c.periodNr, c.subjectName, c.insteadOf, c.kind, c.substituteId, c.roomId, c.note, c.targetPeriod, c.mergeGroup].join("|");
    const prev = out.get(key);
    if (prev) {
      if (!prev.groupNames.includes(c.groupName)) prev.groupNames.push(c.groupName);
    } else out.set(key, { ...c, groupNames: [c.groupName] });
  }
  return [...out.values()];
}

const KIND_WORD = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung", move: "Verlegung", merge: "Zusammenlegung" } as const;

/**
 * Tagesnachricht für eine Person. Rein. Eine Änderung: wie bisher („Entfall Di, 13.10., 3. Std: Mathe (7b)“, Einzelheiten im
 * Text); mehrere: Zusammenfassung im Titel, je Stunde eine Zeile im Text; keine (zurückgenommen): Hinweis auf den Regelplan.
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
      (c.kind === "substitute" || c.kind === "merge") && c.substituteName ? `bei ${c.substituteName}` : null,
      c.roomId ? `Raum ${c.roomId}` : null,
      c.note,
    ]
      .filter(Boolean)
      .join(sep);
  if (lines.length === 1) {
    const c = lines[0]!;
    return { title: `${KIND_WORD[c.kind]} ${day}, ${c.periodNr}. Std: ${what(c)}`, body: detail(c, " · ") || null };
  }
  const cancels = lines.filter((c) => c.kind === "cancel").length;
  const others = lines.length - cancels;
  const summary = [others && (others === 1 ? "1 Änderung" : `${others} Änderungen`), cancels && (cancels === 1 ? "1 Entfall" : `${cancels} Stunden entfallen`)].filter(Boolean).join(", ");
  const body = lines
    .map((c) => {
      const d = detail(c, ", ");
      return `${c.periodNr}. Std ${what(c)}: ${KIND_WORD[c.kind]}${d ? ` – ${d}` : ""}`;
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
  return rows.map(({ altName, mergeLessonId, ...r }) => {
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
async function informedParents(db: Db, studentIds: readonly string[]): Promise<Map<string, Set<string>>> {
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

/**
 * Tagesnachricht an alle, die eine Änderung betrifft: `students` (Schüler:innen der Gruppen) und `teachers` (Lehrkraft der
 * Stunde, Vertretung – auch eine vorherige). Die handelnde Person bekommt nichts. Gibt die Empfänger zurück.
 */
type Affected = { students: readonly string[]; teachers: readonly string[] };

export async function notifySubstitutionDay(
  db: Db,
  actorId: string,
  date: string,
  /** Betroffene – oder eine Funktion, die sie erst unter der Tagessperre ermittelt (Veröffentlichen, GATE-4f C-01) */
  affected: Affected | ((tx: Db) => Promise<Affected>),
  /** Q5-11: läuft unter derselben Tagessperre vorher (Veröffentlichen); `false` → keine Nachricht */
  guard?: (tx: Db) => Promise<boolean>,
): Promise<string[]> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bundleKey(date)}))`);
    if (guard && !(await guard(tx))) return [];
    // Q5-11: Entwurf → niemand erfährt etwas, bis der Tag veröffentlicht ist (geprüft unter der Sperre: wer während des
    // Veröffentlichens speichert, sieht danach „veröffentlicht“ und meldet selbst)
    if (await isDraftDay(tx, date)) return [];
    return notifyDayLocked(tx, actorId, date, typeof affected === "function" ? await affected(tx) : affected);
  });
}

async function notifyDayLocked(db: Db, actorId: string, date: string, affected: Affected): Promise<string[]> {
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
  recipients.delete(actorId);

  const href = `/stundenplan?woche=${date}`;
  await notifyBundled(
    db,
    [...recipients].map(([userId, list]) => ({ userId, ...dayMessage(date, list), href })),
    { moduleId: "stundenplan", bundleKey: bundleKey(date) },
  );
  return [...recipients.keys()];
}
