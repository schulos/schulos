// Diagnose (P2b-13): prüft Plan und Unterrichtsverteilung auf offene Stunden, Hohlstunden, Fach mehrfach am Tag,
// Stundentafel, ungeeignete Räume, Deputat über/unter Soll, Bänder (SP2-02: zur selben Zeit, gemeinsame Schüler:innen) und
// Tagesgrenzen/Ganztag je Jahrgang (SP2-03), Tagesregeln je Lehrkraft (SP2-04) und Zeitwünsche (SP2-05: gesperrt belegt, −3/−2).
// Reine Prüflogik + Loader.
import { and, count, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, periods, rooms, subjects, timetableLessons, users } from "@/core/db/schema";
import { ROOM_KIND_LABELS } from "@/core/labels";
import type { RoomKind } from "@/core/db/schema";
import { readSchoolSettings } from "@/core/settings";
import { defaultObligation, deputyAccounts, type DeputyAccount } from "./deputate";
import { WEEKDAYS } from "./manage";
import type { LESSON_WEEKS } from "./schema";
import { longBreaksAfter } from "./solver-check";
import { bandsWithSharedStudents, conflictsFrom } from "./solver-input";
import { distribution, planningYear, PLANNED_GROUP_KINDS, type Distribution } from "./verteilung";
import { loadDayLimits } from "./jahrgangsregeln";
import { classWeek, dayProblems, isAfternoon, problemText, ruleSummary, weeklyCapacity, type DayLimits } from "./tagesgrenzen";
import { presenceDays, teacherDayProblems, teacherProblemText, teacherRuleSummary, teacherWeek, teacherWeeklyCapacity } from "./lehrkraftregeln";
import { allPrefs, prefKey, prefLabel, type PrefGrid } from "./zeitwuensche";

export const DIAGNOSIS_CATEGORIES = ["open", "gaps", "subjectDay", "curriculum", "room", "deputy", "band", "day", "teacherDay", "prefs"] as const;
export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number];

export const DIAGNOSIS_LABELS: Record<DiagnosisCategory, string> = {
  open: "Offene Stunden",
  gaps: "Hohlstunden",
  subjectDay: "Fach mehrfach am Tag",
  curriculum: "Stundentafel",
  room: "Raum ungeeignet",
  deputy: "Deputat über/unter Soll",
  band: "Bänder",
  day: "Tagesgrenzen",
  teacherDay: "Tagesregeln Lehrkräfte",
  prefs: "Zeitwünsche",
};

/** error = muss behoben werden · warn = sollte geprüft werden · info = zur Kenntnis */
export type Severity = "error" | "warn" | "info";

export interface Finding {
  category: DiagnosisCategory;
  severity: Severity;
  /** worauf sich der Hinweis bezieht (für Gruppierung und Links) */
  target: { kind: "group" | "teacher" | "band"; id: string; label: string };
  message: string;
  /** betroffener Lehrauftrag (Link zum Bearbeiten) */
  assignmentId?: string;
}

type Week = (typeof LESSON_WEEKS)[number];

export interface DiagLesson {
  id: string;
  couplingId: string | null;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  week: Week;
}

export interface DiagnoseInput {
  lessons: DiagLesson[];
  periods: number[];
  /** Stunden, nach denen eine große Pause folgt (SP-G-04a): eine gewünschte Doppelstunde darüber hinweg ist ein Hinweis */
  breakAfter?: number[];
  groups: { id: string; name: string; kind: string; gradeLevel: number | null; size: number }[];
  teachers: { id: string; code: string | null; name: string }[];
  subjects: { id: string; name: string; roomKind: RoomKind | null }[];
  rooms: { id: string; kind: RoomKind; capacity: number | null; active: boolean }[];
  distribution: Pick<Distribution, "assignments" | "unmatched" | "curriculum"> & Partial<Pick<Distribution, "bands">>;
  accounts: (Pick<DeputyAccount, "id" | "code" | "name" | "target" | "assigned" | "balance"> & Partial<Pick<DeputyAccount, "dayRule">>)[];
  /** Gruppen mit gemeinsamen Schüler:innen (SP2-02: Band-Mitglieder, die parallel liegen, obwohl Schüler:innen in beiden sind) */
  conflicts?: Map<string, Set<string>>;
  /** SP2-03: Tagesgrenzen und Ganztag je Klasse */
  dayLimits?: DayLimits;
  /** SP2-05: Zeitwünsche des Planungsjahres (`${kind}:${id}` → Raster, wie `allPrefs`) */
  prefs?: Map<string, PrefGrid>;
}

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const hoursLabel = (n: number) => `${num.format(n)} ${n === 1 ? "Stunde" : "Stunden"}`;
const periodList = (ps: number[]) => ps.map((p) => `${p}.`).join(", ");

/** Wochen, in denen eine Stunde liegt: „all“ in A und B. */
const inWeek = (l: { week: Week }, w: "A" | "B") => l.week === "all" || l.week === w;

/**
 * Wertet eine Tages-Prüfung je Woche aus: ohne A/B-Stunden einmal, sonst für A- und B-Woche getrennt
 * (gleiche Ergebnisse werden zusammengefasst).
 */
function perWeek<T>(lessons: DiagLesson[], check: (ls: DiagLesson[]) => T[], same: (a: T[], b: T[]) => boolean): { week: "" | " (A-Woche)" | " (B-Woche)"; items: T[] }[] {
  if (lessons.every((l) => l.week === "all")) return [{ week: "", items: check(lessons) }];
  const a = check(lessons.filter((l) => inWeek(l, "A")));
  const b = check(lessons.filter((l) => inWeek(l, "B")));
  if (same(a, b)) return [{ week: "", items: a }];
  return [
    { week: " (A-Woche)", items: a },
    { week: " (B-Woche)", items: b },
  ];
}

/** Freie Stunden zwischen der ersten und letzten belegten Stunde eines Tages. */
export function gapsOf(occupied: Iterable<number>, periodNrs: number[]): number[] {
  const taken = new Set(occupied);
  if (!taken.size) return [];
  const min = Math.min(...taken);
  const max = Math.max(...taken);
  return periodNrs.filter((p) => p > min && p < max && !taken.has(p));
}

/** Blöcke direkt aufeinanderfolgender Stunden, z. B. [1,2,5] → [[1,2],[5]]. */
export function blocksOf(periodNrs: Iterable<number>): number[][] {
  const sorted = [...new Set(periodNrs)].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (last && last.at(-1)! + 1 === p) last.push(p);
    else out.push([p]);
  }
  return out;
}

const sameNums = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function diagnose(input: DiagnoseInput): Finding[] {
  const out: Finding[] = [];
  const groupOf = new Map(input.groups.map((g) => [g.id, g]));
  const subjectOf = new Map(input.subjects.map((s) => [s.id, s]));
  const roomOf = new Map(input.rooms.map((r) => [r.id, r]));
  const groupTarget = (id: string) => ({ kind: "group" as const, id, label: groupOf.get(id)?.name ?? id });
  const teacherLabel = (t: { code: string | null; name: string }) => t.code ?? t.name;
  const subjectName = (id: string) => subjectOf.get(id)?.name ?? id;

  // ---------------------------------------------------------- offene Stunden
  for (const a of input.distribution.assignments) {
    const g = a.groups[0];
    if (!g) continue;
    const target = { kind: "group" as const, id: g.id, label: a.groups.map((x) => x.name).join(" + ") };
    const who = a.teachers.map(teacherLabel).join(" + ");
    const what = `${a.subjectName}${who ? ` (${who})` : ""}`;
    if (a.planned < a.hours) out.push({ category: "open", severity: "warn", target, assignmentId: a.id, message: `${what}: ${hoursLabel(a.hours - a.planned)} nicht verplant` });
    else if (a.planned > a.hours) out.push({ category: "open", severity: "error", target, assignmentId: a.id, message: `${what}: ${hoursLabel(a.planned - a.hours)} mehr verplant als beauftragt` });
    if (!a.teachers.length) out.push({ category: "open", severity: "info", target, assignmentId: a.id, message: `${a.subjectName}: Lehrauftrag ohne Lehrkraft` });
    else if (a.otherTeacher) out.push({ category: "open", severity: "info", target, assignmentId: a.id, message: `${what}: im Plan unterrichtet eine andere Lehrkraft` });
  }
  const unmatched = new Map<string, { groupId: string; label: string; hours: number }>();
  for (const l of input.distribution.unmatched) {
    const k = `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}`;
    const b = unmatched.get(k) ?? { groupId: l.groupId, label: `${l.subjectName}${l.teacherCode ? ` (${l.teacherCode})` : ""}`, hours: 0 };
    b.hours += l.weight;
    unmatched.set(k, b);
  }
  for (const b of unmatched.values())
    out.push({ category: "open", severity: "warn", target: groupTarget(b.groupId), message: `${b.label}: ${hoursLabel(b.hours)} im Plan ohne Lehrauftrag` });

  // ---------------------------------------------------------- Hohlstunden
  const byDay = <K extends string>(ls: DiagLesson[], key: (l: DiagLesson) => K | null) => {
    const m = new Map<K, Map<number, DiagLesson[]>>();
    for (const l of ls) {
      const k = key(l);
      if (k === null) continue;
      if (!m.has(k)) m.set(k, new Map());
      const days = m.get(k)!;
      days.set(l.weekday, [...(days.get(l.weekday) ?? []), l]);
    }
    return m;
  };
  const gapFindings = (target: Finding["target"], days: Map<number, DiagLesson[]>, severity: Severity, extra: (wd: number) => DiagLesson[] = () => []) => {
    for (const [wd, ls] of [...days.entries()].sort((a, b) => a[0] - b[0])) {
      const runs = perWeek([...ls, ...extra(wd)], (x) => gapsOf(x.map((l) => l.periodNr), input.periods), sameNums);
      for (const { week, items } of runs) {
        if (!items.length) continue;
        const n = items.length;
        out.push({ category: "gaps", severity, target, message: `${WEEKDAYS[wd]}${week}: ${n} ${n === 1 ? "Hohlstunde" : "Hohlstunden"} (${periodList(items)})` });
      }
    }
  };
  const teacherById = new Map(input.teachers.map((t) => [t.id, t]));
  for (const [tid, days] of byDay(input.lessons, (l) => l.teacherId)) {
    const t = teacherById.get(tid);
    gapFindings({ kind: "teacher", id: tid, label: t ? teacherLabel(t) : tid }, days, "info");
  }
  // Klassen: Kurse, Wahlpflicht- und Förderkurse desselben Jahrgangs gelten als Kursband (die Klasse ist dort beschäftigt)
  const bandKinds = new Set(["kurs", "wahlpflicht", "foerderkurs"]);
  const bandByGrade = byDay(input.lessons, (l) => {
    const g = groupOf.get(l.groupId);
    return g && bandKinds.has(g.kind) && g.gradeLevel !== null ? String(g.gradeLevel) : null;
  });
  for (const [gid, days] of byDay(input.lessons, (l) => (groupOf.get(l.groupId)?.kind === "klasse" ? l.groupId : null))) {
    const grade = groupOf.get(gid)?.gradeLevel;
    const band = grade === null || grade === undefined ? undefined : bandByGrade.get(String(grade));
    gapFindings(groupTarget(gid), days, "warn", (wd) => band?.get(wd) ?? []);
  }

  // ---------------------------------------------------------- Fach mehrfach am Tag, Doppelstunde über die große Pause
  const breaks = new Set(input.breakAfter ?? []);
  // Gruppe × Fach, für die der Lehrauftrag Doppelstunden vorsieht – nur dort ist ein Zweier-Block über die Pause ein Hinweis
  const wantsDouble = new Set(input.distribution.assignments.filter((a) => a.doubleLessons > 0).flatMap((a) => a.groups.map((g) => `${g.id}|${a.subjectId}`)));
  for (const [gid, days] of byDay(input.lessons, (l) => l.groupId)) {
    for (const [wd, ls] of [...days.entries()].sort((a, b) => a[0] - b[0])) {
      for (const sid of [...new Set(ls.map((l) => l.subjectId))].sort()) {
        const runs = perWeek(
          ls.filter((l) => l.subjectId === sid),
          (x) => blocksOf(x.map((l) => l.periodNr)),
          (a, b) => a.length === b.length && a.every((blk, i) => sameNums(blk, b[i]!)),
        );
        for (const { week, items } of runs) {
          const all = items.flat();
          if (items.length > 1)
            out.push({ category: "subjectDay", severity: "warn", target: groupTarget(gid), message: `${subjectName(sid)} am ${WEEKDAYS[wd]}${week} ${items.length}× getrennt (${periodList(all)})` });
          else if (all.length > 2)
            out.push({ category: "subjectDay", severity: "warn", target: groupTarget(gid), message: `${subjectName(sid)} am ${WEEKDAYS[wd]}${week} ${all.length} Stunden am Stück (${periodList(all)})` });
          if (breaks.size && wantsDouble.has(`${gid}|${sid}`))
            for (const blk of items) {
              const over = blk.filter((p, i) => i + 1 < blk.length && breaks.has(p));
              if (over.length)
                out.push({ category: "subjectDay", severity: "info", target: groupTarget(gid), message: `${subjectName(sid)} am ${WEEKDAYS[wd]}${week}: Doppelstunde über die große Pause (${periodList(over.flatMap((p) => [p, p + 1]))})` });
            }
        }
      }
    }
  }

  // ---------------------------------------------------------- Stundentafel
  for (const g of input.groups) {
    if (g.kind !== "klasse" || g.gradeLevel === null) continue;
    const tafel = input.distribution.curriculum.get(g.gradeLevel);
    if (!tafel) continue;
    const assigned = new Map<string, number>();
    for (const a of input.distribution.assignments) if (a.groups.some((x) => x.id === g.id)) assigned.set(a.subjectId, (assigned.get(a.subjectId) ?? 0) + a.hours);
    if (!assigned.size) {
      const sum = [...tafel.values()].reduce((s, x) => s + x, 0);
      out.push({ category: "curriculum", severity: "warn", target: groupTarget(g.id), message: `noch keine Lehraufträge (Stundentafel ${hoursLabel(sum)})` });
      continue;
    }
    for (const sid of [...new Set([...tafel.keys(), ...assigned.keys()])]) {
      const soll = tafel.get(sid) ?? 0;
      const ist = assigned.get(sid) ?? 0;
      if (soll === ist) continue;
      const msg =
        ist < soll
          ? `${subjectName(sid)}: Stundentafel ${num.format(soll)}, Lehraufträge ${num.format(ist)} – ${hoursLabel(soll - ist)} fehlen`
          : `${subjectName(sid)}: Stundentafel ${num.format(soll)}, Lehraufträge ${num.format(ist)} – ${hoursLabel(ist - soll)} mehr`;
      out.push({ category: "curriculum", severity: ist < soll ? "warn" : "info", target: groupTarget(g.id), message: msg });
    }
  }

  // ---------------------------------------------------------- Räume (je Gruppe × Fach × Raum × Problem zusammengefasst)
  const roomIssues = new Map<string, { groupId: string; severity: Severity; message: string; slots: [number, number][] }>();
  const addRoomIssue = (l: DiagLesson, kind: string, severity: Severity, message: string) => {
    const k = `${l.groupId}|${l.subjectId}|${l.roomId ?? ""}|${kind}`;
    const e = roomIssues.get(k) ?? { groupId: l.groupId, severity, message, slots: [] };
    e.slots.push([l.weekday, l.periodNr]);
    roomIssues.set(k, e);
  };
  // Belegung je Raum-Einheit (Kopplung bzw. Einzelstunde) für die Kapazität
  const unitSize = new Map<string, number>();
  for (const l of input.lessons) {
    if (!l.roomId) continue;
    const k = `${l.couplingId ?? l.id}|${l.roomId}`;
    const groupsInUnit = input.lessons.filter((x) => (x.couplingId ?? x.id) === (l.couplingId ?? l.id) && x.roomId === l.roomId).map((x) => x.groupId);
    unitSize.set(k, [...new Set(groupsInUnit)].reduce((s, gid) => s + (groupOf.get(gid)?.size ?? 0), 0));
  }
  for (const l of input.lessons) {
    const subj = subjectOf.get(l.subjectId);
    const sName = subjectName(l.subjectId);
    if (!l.roomId) {
      addRoomIssue(l, "none", subj?.roomKind ? "warn" : "info", `${sName} ohne Raum${subj?.roomKind ? ` (Wunsch: ${ROOM_KIND_LABELS[subj.roomKind]})` : ""}`);
      continue;
    }
    const room = roomOf.get(l.roomId);
    if (!room) continue;
    if (!room.active) addRoomIssue(l, "inactive", "error", `${sName} in Raum ${room.id}: Raum ist inaktiv`);
    if (subj?.roomKind && room.kind !== subj.roomKind)
      addRoomIssue(l, "kind", "warn", `${sName} in Raum ${room.id} (${ROOM_KIND_LABELS[room.kind]}), Wunsch: ${ROOM_KIND_LABELS[subj.roomKind]}`);
    const size = unitSize.get(`${l.couplingId ?? l.id}|${l.roomId}`) ?? 0;
    if (room.capacity !== null && size > room.capacity) addRoomIssue(l, "capacity", "warn", `${sName} in Raum ${room.id}: ${size} Personen, Kapazität ${room.capacity}`);
  }
  for (const e of roomIssues.values()) out.push({ category: "room", severity: e.severity, target: groupTarget(e.groupId), message: `${e.message} – ${e.slots.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([d, p]) => `${WEEKDAYS[d]} ${p}.`).join(", ")}` });

  // ---------------------------------------------------------- Deputat
  for (const a of input.accounts) {
    if (a.balance === 0 || (a.target === 0 && a.assigned === 0)) continue;
    const target = { kind: "teacher" as const, id: a.id, label: teacherLabel(a) };
    out.push(
      a.balance < 0
        ? { category: "deputy", severity: "warn", target, message: `${hoursLabel(-a.balance)} unter Soll (Soll ${num.format(a.target)}, Lehraufträge ${num.format(a.assigned)})` }
        : { category: "deputy", severity: "warn", target, message: `${hoursLabel(a.balance)} über Soll (Soll ${num.format(a.target)}, Lehraufträge ${num.format(a.assigned)})` },
    );
  }

  // ---------------------------------------------------------- Bänder (SP2-02): zur selben Zeit, gemeinsame Schüler:innen (Q-SP2-6)
  const bands = input.distribution.bands ?? [];
  const bandTarget = (b: { id: string; name: string }) => ({ kind: "band" as const, id: b.id, label: b.name });
  const sharedIn = new Map(bandsWithSharedStudents(bands, input.distribution.assignments, input.conflicts ?? new Map()).map((b) => [b.id, b.pairs]));
  for (const b of bands) {
    if (!b.memberIds.length) {
      out.push({ category: "band", severity: "info", target: bandTarget(b), message: "Band ohne Lehraufträge" });
      continue;
    }
    if (b.memberIds.length > 1 && b.together < b.planned)
      out.push({
        category: "band",
        severity: "warn",
        target: bandTarget(b),
        message: `nur ${hoursLabel(b.together)} von ${hoursLabel(b.planned)} zur selben Zeit – die Lehraufträge des Bands liegen teils in verschiedenen Slots`,
      });
    for (const [x, y] of sharedIn.get(b.id) ?? [])
      out.push({
        category: "band",
        severity: "warn",
        target: bandTarget(b),
        message: `${groupOf.get(x)?.name ?? x} und ${groupOf.get(y)?.name ?? y} haben gemeinsame Schüler:innen – im Band liegen sie zur selben Zeit, diese Schüler:innen können nur einen Kurs besuchen`,
      });
  }

  // ---------------------------------------------------------- Tagesgrenzen und Ganztag (SP2-03)
  const lim = input.dayLimits;
  if (lim?.rules.size) {
    const classes = [...lim.rules.keys()].filter((c) => groupOf.has(c)).sort((a, b) => groupOf.get(a)!.name.localeCompare(groupOf.get(b)!.name, "de", { numeric: true }));
    for (const c of classes) {
      const rule = lim.rules.get(c)!;
      const target = groupTarget(c);
      const week = classWeek(lim, c, input.lessons);
      for (const [wd, ps] of [...week].sort((a, b) => a[0] - b[0]))
        for (const p of dayProblems(rule, ps))
          out.push({
            category: "day",
            severity: "error",
            target,
            message: p === "max" ? `${WEEKDAYS[wd]}: ${hoursLabel(ps.size)} – ${problemText(rule, "max")}` : `${WEEKDAYS[wd]}: Unterricht in der Mittagsstunde und danach – ${problemText(rule, "lunch")}`,
          });
      const afternoons = [...week.values()].filter((ps) => isAfternoon(rule, ps)).length;
      if (rule.afternoonsPerWeek !== null && afternoons > rule.afternoonsPerWeek)
        out.push({ category: "day", severity: "error", target, message: `${afternoons} Tage mit Nachmittagsunterricht – ${problemText(rule, "afternoons")}` });
      // Wochenstunden laut Verteilung (ein Band zählt einmal) gegen das, was die Grenzen erlauben
      const bandsSeen = new Set<string>();
      let hours = 0;
      for (const a of input.distribution.assignments) {
        if (!a.groups.some((g) => g.id === c)) continue;
        if (a.bandId) {
          if (bandsSeen.has(a.bandId)) continue;
          bandsSeen.add(a.bandId);
        }
        hours += a.hours;
      }
      const cap = weeklyCapacity(rule, input.periods);
      if (hours > cap)
        out.push({ category: "day", severity: "warn", target, message: `${hoursLabel(hours)} je Woche verteilt, die Tagesgrenzen erlauben höchstens ${cap} (${ruleSummary(rule)})` });
    }
  }

  // ---------------------------------------------------------- Tagesregeln je Lehrkraft (SP2-04)
  for (const a of input.accounts) {
    const rule = a.dayRule;
    if (!rule) continue;
    const target = { kind: "teacher" as const, id: a.id, label: teacherLabel(a) };
    const week = teacherWeek(a.id, input.lessons);
    for (const [wd, ps] of [...week].sort((x, y) => x[0] - y[0]))
      if (teacherDayProblems(rule, ps).length) out.push({ category: "teacherDay", severity: "error", target, message: `${WEEKDAYS[wd]}: ${hoursLabel(ps.size)} – ${teacherProblemText(rule, "max")}` });
    const days = presenceDays(week);
    if (rule.maxDays !== null && days > rule.maxDays) out.push({ category: "teacherDay", severity: "error", target, message: `${days} Tage mit Unterricht – ${teacherProblemText(rule, "days")}` });
    const cap = teacherWeeklyCapacity(rule, input.periods.length);
    if (a.assigned > cap)
      out.push({ category: "teacherDay", severity: "warn", target, message: `${hoursLabel(a.assigned)} Lehraufträge, die Tagesregel erlaubt höchstens ${cap} (${teacherRuleSummary(rule)})` });
  }

  // ---------------------------------------------------------- Zeitwünsche (SP2-05): gesperrt belegt = Fehler, −3/−2 = Warnung
  if (input.prefs?.size) {
    const prefs = input.prefs;
    // je Wunsch-Ziel (Lehrkraft, Gruppe, Raum, Fach) und Hinweis-Ziel: Slots einmal (Kopplungen, A/B-Wochen), mit dem, was dort liegt
    const hits = new Map<string, { target: Finding["target"]; severity: Severity; what: string; slots: Map<string, { wd: number; nr: number; v: number | null; lessons: Set<string> }> }>();
    const hit = (prefTarget: string, target: Finding["target"], what: string, l: DiagLesson, lessonText: string) => {
      const grid = prefs.get(prefTarget);
      if (!grid) return;
      const key = prefKey(l.weekday, l.periodNr);
      if (!grid.has(key)) return;
      const v = grid.get(key)!;
      if (v !== null && v > -2) return;
      const severity: Severity = v === null ? "error" : "warn";
      const k = `${prefTarget}|${target.kind}:${target.id}|${severity}`;
      const e = hits.get(k) ?? { target, severity, what, slots: new Map() };
      const slot = e.slots.get(key) ?? { wd: l.weekday, nr: l.periodNr, v, lessons: new Set<string>() };
      slot.lessons.add(lessonText);
      e.slots.set(key, slot);
      hits.set(k, e);
    };
    const roomIds = new Set(input.rooms.map((r) => r.id));
    for (const l of input.lessons) {
      const group = groupOf.get(l.groupId);
      if (!group) continue;
      const t = l.teacherId ? teacherById.get(l.teacherId) : undefined;
      const tCode = t ? teacherLabel(t) : null;
      const inGroup = `${subjectName(l.subjectId)}${tCode ? ` (${tCode})` : ""}`;
      if (l.teacherId) hit(`teacher:${l.teacherId}`, { kind: "teacher", id: l.teacherId, label: tCode ?? l.teacherId }, "Zeitwunsch der Lehrkraft", l, `${subjectName(l.subjectId)} ${group.name}`);
      hit(`group:${l.groupId}`, groupTarget(l.groupId), "Zeitwunsch der Gruppe", l, inGroup);
      if (l.roomId && roomIds.has(l.roomId)) hit(`room:${l.roomId}`, groupTarget(l.groupId), `Zeitwunsch Raum ${l.roomId}`, l, inGroup);
      hit(`subject:${l.subjectId}`, groupTarget(l.groupId), `Zeitwunsch Fach ${subjectName(l.subjectId)}`, l, inGroup);
    }
    for (const e of hits.values()) {
      const slots = [...e.slots.values()].sort((a, b) => a.wd - b.wd || a.nr - b.nr);
      const list = slots.map((x) => `${WEEKDAYS[x.wd]} ${x.nr}.${e.severity === "warn" ? ` (${prefLabel(x.v)})` : ""}: ${[...x.lessons].sort().join(", ")}`).join(" · ");
      out.push({
        category: "prefs",
        severity: e.severity,
        target: e.target,
        message: e.severity === "error" ? `${e.what}: gesperrte Zeit belegt – ${list}` : `${e.what}: ungünstige Zeit belegt – ${list}`,
      });
    }
  }

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  const catRank = new Map(DIAGNOSIS_CATEGORIES.map((c, i) => [c, i]));
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => catRank.get(a.f.category)! - catRank.get(b.f.category)! || rank[a.f.severity] - rank[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

export interface DiagnosisReport {
  refYmd: string;
  findings: Finding[];
  counts: Record<DiagnosisCategory, Record<Severity, number>>;
}

export function countFindings(findings: Finding[]): DiagnosisReport["counts"] {
  const counts = Object.fromEntries(DIAGNOSIS_CATEGORIES.map((c) => [c, { error: 0, warn: 0, info: 0 }])) as DiagnosisReport["counts"];
  for (const f of findings) counts[f.category][f.severity]++;
  return counts;
}

/** Diagnose für ein Schuljahr am Stichtag (wie die Unterrichtsverteilung). */
export async function diagnoseYear(db: Db, year: { id: string; startsOn: string; endsOn: string }, todayYmd: string, fallbackObligation: number, pre?: Distribution): Promise<DiagnosisReport> {
  const d = pre ?? (await distribution(db, year, todayYmd));
  const ref = d.refYmd;
  const [lessonRows, periodRows, subjectRows, roomRows, sizes, accounts, dayLimits, prefs] = await Promise.all([
    db
      .select({
        id: timetableLessons.id,
        couplingId: timetableLessons.couplingId,
        groupId: timetableLessons.groupId,
        subjectId: timetableLessons.subjectId,
        teacherId: timetableLessons.teacherId,
        roomId: timetableLessons.roomId,
        weekday: timetableLessons.weekday,
        periodNr: timetableLessons.periodNr,
        week: timetableLessons.week,
      })
      .from(timetableLessons)
      .where(and(lte(timetableLessons.validFrom, ref), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, ref)))),
    db.select({ nr: periods.nr, startsAt: periods.startsAt, endsAt: periods.endsAt }).from(periods).orderBy(periods.nr),
    db.select({ id: subjects.id, name: subjects.name, roomKind: subjects.roomKind }).from(subjects),
    db.select({ id: rooms.id, kind: rooms.kind, capacity: rooms.capacity, active: rooms.active }).from(rooms),
    db.select({ groupId: groupMembers.groupId, n: count() }).from(groupMembers).where(eq(groupMembers.role, "member")).groupBy(groupMembers.groupId),
    deputyAccounts(db, year.id, d.teachers, fallbackObligation),
    loadDayLimits(db),
    allPrefs(db),
  ]);
  // Schüler:innen der Band-Gruppen (SP2-02): gemeinsame Mitglieder in zwei Mitgliedern eines Bands
  const assignmentOf = new Map(d.assignments.map((a) => [a.id, a]));
  const bandGroups = [...new Set(d.bands.filter((b) => b.memberIds.length > 1).flatMap((b) => b.memberIds.flatMap((id) => assignmentOf.get(id)?.groups.map((g) => g.id) ?? [])))];
  const students = bandGroups.length
    ? await db
        .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(inArray(groupMembers.groupId, bandGroups), eq(groupMembers.role, "member"), eq(users.role, "schueler")))
    : [];
  const sizeOf = new Map(sizes.map((s) => [s.groupId, Number(s.n)]));
  const planned = new Set<string>(PLANNED_GROUP_KINDS);
  const findings = diagnose({
    lessons: lessonRows,
    periods: periodRows.map((p) => p.nr),
    breakAfter: longBreaksAfter(periodRows),
    groups: d.groups.filter((g) => planned.has(g.kind)).map((g) => ({ id: g.id, name: g.name, kind: g.kind, gradeLevel: g.gradeLevel, size: sizeOf.get(g.id) ?? 0 })),
    teachers: d.teachers,
    subjects: subjectRows,
    rooms: roomRows,
    distribution: d,
    accounts,
    conflicts: conflictsFrom(students),
    dayLimits,
    prefs,
  });
  return { refYmd: ref, findings, counts: countFindings(findings) };
}

/** Plan-Hinweise einer Gruppe (Hohlstunden, Fach mehrfach am Tag, Räume) für die Pflege-Seite. */
export async function groupPlanFindings(db: Db, groupId: string, todayYmd: string): Promise<Finding[]> {
  const year = await planningYear(db);
  if (!year) return [];
  const school = await readSchoolSettings(db);
  const { findings } = await diagnoseYear(db, year, todayYmd, defaultObligation(school.profile.form));
  const plan = new Set<DiagnosisCategory>(["gaps", "subjectDay", "room", "day", "prefs"]);
  return findings.filter((f) => f.target.kind === "group" && f.target.id === groupId && plan.has(f.category));
}
