// SP-G-15: synthetischer Groß-Benchmark – große Gesamtschule (6-zügig 5–10 + Oberstufe mit Kursen und Konfliktmengen,
// ~1 500 Einheiten). Misst Laufzeit, nicht gesetzt und Hohlstunden; Grenzwerte stehen in docs/LASTTEST.md („Solver“).
import { describe, expect, it } from "vitest";
import { createSolver, rng, solve, validate, type SolverInput, type SolverUnit, type UnitPart } from "./solver";
import { precheck } from "./solver-check";

interface SchoolSpec {
  /** Klassen je Jahrgang 5–10 */
  zuege: number;
  /** Kurse je Oberstufen-Jahrgang (EF, Q1, Q2) */
  coursesPerGrade: number;
  /** Schüler:innen je Oberstufen-Jahrgang */
  studentsPerGrade: number;
}

/** Stundentafel Sek I (vereinfacht, 31 Stunden): Fach → [Stunden, Doppelstunden, Raumart] */
const SEK1: [string, number, number, string | null][] = [
  ["D", 4, 0, null],
  ["M", 4, 0, null],
  ["E", 4, 0, null],
  ["GL", 3, 0, null],
  ["NW", 3, 1, "nw"],
  ["SP", 3, 1, "sport"],
  ["KU", 2, 1, "kunst"],
  ["MU", 2, 0, "musik"],
  ["REL", 2, 0, null],
  ["WP", 2, 1, null],
  ["AL", 2, 1, "technik"],
];
/** Oberstufenkurse: Fach, Stunden, Doppelstunden, Raumart */
const OBERSTUFE: [string, number, number, string | null][] = [
  ["D", 3, 1, null],
  ["M", 3, 1, null],
  ["E", 3, 1, null],
  ["BI", 3, 1, "nw"],
  ["CH", 3, 1, "nw"],
  ["PH", 3, 1, "nw"],
  ["GE", 3, 1, null],
  ["SW", 3, 1, null],
  ["SP", 2, 1, "sport"],
  ["KU", 3, 1, "kunst"],
  ["IF", 3, 1, "nw"],
  ["PL", 3, 1, null],
];

/** Erzeugt eine große Schule deterministisch (fester Startwert). */
export function syntheticSchool(spec: SchoolSpec, seed = 11): SolverInput {
  const random = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
  const units: SolverUnit[] = [];
  const classIds = new Set<string>();
  const names = new Map<string, string>();
  // Lehrkräfte: je Fach ein Pool, jede Lehrkraft zwei Fächer, höchstens 26 Stunden
  const subjects = [...new Set([...SEK1, ...OBERSTUFE].map((s) => s[0]))];
  const teachers: { id: string; subjects: string[]; load: number }[] = [];
  const teacherCount = Math.ceil((spec.zuege * 6 * 31 + 3 * spec.coursesPerGrade * 3) / 24);
  for (let i = 0; i < teacherCount; i++) {
    const a = subjects[i % subjects.length]!;
    const b = subjects[(i * 7 + 3) % subjects.length]!;
    teachers.push({ id: `L${String(i + 1).padStart(3, "0")}`, subjects: a === b ? [a] : [a, b], load: 0 });
  }
  const teacherFor = (subject: string, hours: number) => {
    const pool = teachers.filter((t) => t.subjects.includes(subject) && t.load + hours <= 26).sort((x, y) => x.load - y.load);
    const t = pool[0] ?? teachers.filter((t) => t.load + hours <= 26).sort((x, y) => x.load - y.load)[0] ?? teachers.sort((x, y) => x.load - y.load)[0]!;
    t.load += hours;
    return t.id;
  };
  const rooms: SolverInput["rooms"] = [];
  const addRooms = (kind: string, n: number, cap: number) => {
    for (let i = 0; i < n; i++) rooms.push({ id: `${kind.toUpperCase()}${i + 1}`, kind, capacity: cap });
  };
  const classCount = spec.zuege * 6;
  addRooms("klassenraum", classCount + 6, 32);
  addRooms("nw", Math.ceil(classCount / 4) + 3, 30);
  addRooms("sport", 3, 60);
  addRooms("kunst", 3, 30);
  addRooms("musik", 2, 30);
  addRooms("technik", 2, 20);
  let a = 0;
  const push = (group: string[], subject: string, hours: number, doubles: number, roomKind: string | null, homeRoom: string | null, size: number) => {
    const assignmentId = `a${++a}`;
    const part: UnitPart = { assignmentId, groupIds: group, teacherIds: [teacherFor(subject, hours)], subjectId: subject, roomId: null, roomKind, homeRoomId: homeRoom, size };
    const common = { ...part, label: `${group.join("+")} ${subject}`, parts: [part] };
    const d = Math.min(doubles, Math.floor(hours / 2));
    for (let i = 0; i < d; i++) units.push({ ...common, id: `${assignmentId}#d${i}`, length: 2 });
    for (let i = 0; i < hours - 2 * d; i++) units.push({ ...common, id: `${assignmentId}#e${i}`, length: 1 });
  };
  // Sek I: Klassen mit Stammraum, Jahrgänge 5–8 nur bis zur 7. Stunde (Sperrzeiten), 9–10 bis zur 8.
  const prefs: SolverInput["prefs"] = new Map();
  const periods = [1, 2, 3, 4, 5, 6, 7, 8];
  const blockedAfter = (last: number) => {
    const m = new Map<string, number | null>();
    for (let wd = 0; wd < 5; wd++) for (const p of periods) if (p > last) m.set(`${wd}-${p}`, null);
    return m;
  };
  let room = 0;
  for (let grade = 5; grade <= 10; grade++)
    for (let z = 0; z < spec.zuege; z++) {
      const id = `${grade}${String.fromCharCode(97 + z)}`;
      classIds.add(id);
      names.set(id, `Klasse ${id}`);
      const home = rooms[room++]!.id;
      for (const [subject, hours, doubles, kind] of SEK1) push([id], subject, hours, doubles, kind, home, 28);
      prefs.set(`group:${id}`, blockedAfter(grade <= 8 ? 7 : 8));
    }
  // Oberstufe: Kurse in Schienen (je Schiene 4 Kurse ohne gemeinsame Schüler:innen – so wählen Schulen), jede Schüler:in
  // belegt in 8 von 10 Schienen einen Kurs → Konfliktmengen über Schienen hinweg, wie aus `group_members` abgeleitet
  const members: { groupId: string; userId: string }[] = [];
  const perBand = 4;
  for (const grade of ["EF", "Q1", "Q2"]) {
    const bands: string[][] = [];
    for (let k = 0; k < spec.coursesPerGrade; k++) {
      const [subject, hours, doubles, kind] = OBERSTUFE[k % OBERSTUFE.length]!;
      const id = `${grade}-${subject}${Math.floor(k / OBERSTUFE.length) + 1}`;
      names.set(id, id);
      push([id], subject, hours, doubles, kind, null, 20);
      const band = Math.floor(k / perBand);
      (bands[band] ??= []).push(id);
    }
    for (let s = 0; s < spec.studentsPerGrade; s++) {
      const chosenBands = new Set<number>();
      while (chosenBands.size < Math.min(8, bands.length)) chosenBands.add(Math.floor(random() * bands.length));
      for (const b of chosenBands) members.push({ groupId: pick(bands[b]!), userId: `${grade}-s${s}` });
    }
  }
  const conflicts = new Map<string, Set<string>>();
  const byUser = new Map<string, string[]>();
  for (const m of members) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.groupId]);
  for (const gs of byUser.values())
    for (const x of gs)
      for (const y of gs) {
        if (x === y) continue;
        if (!conflicts.has(x)) conflicts.set(x, new Set());
        conflicts.get(x)!.add(y);
      }
  // Teilzeit: jede fünfte Lehrkraft hat einen freien Tag
  teachers.forEach((t, i) => {
    if (i % 5 !== 0) return;
    const m = new Map<string, number | null>();
    for (const p of periods) m.set(`${i % 5}-${p}`, null);
    prefs.set(`teacher:${t.id}`, m);
  });
  for (const t of teachers) names.set(t.id, t.id);
  return { weekdays: [0, 1, 2, 3, 4], periods, breakAfter: [2, 4, 6], units, fixed: [], rooms, prefs, conflicts, classIds, names, seed: 1 };
}

describe("Solver-Benchmark (SP-G-15): große Schule", () => {
  it("7-zügig 5–10 + Oberstufe mit 120 Kursen (~1 600 Wochenstunden): alles gesetzt, gültig, in vertretbarer Zeit", () => {
    const input = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130 });
    const hours = input.units.reduce((s, u) => s + u.length, 0);
    expect(hours).toBeGreaterThan(1500);
    expect(input.units.length).toBeGreaterThan(1200);
    const pre = precheck(input);
    expect(pre.filter((f) => f.severity === "error")).toEqual([]);
    const t0 = performance.now();
    const solver = createSolver(input);
    let slices = 0;
    while (solver.construct(() => performance.now() - t0 < 0) > 0) slices++;
    const tConstruct = performance.now() - t0;
    solver.improve(Number.POSITIVE_INFINITY);
    const r = solver.result();
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const summary = {
      units: input.units.length,
      hours,
      teachers: new Set(input.units.flatMap((u) => u.teacherIds)).size,
      courses: input.conflicts.size,
      constructMs: Math.round(tConstruct),
      constructSlices: slices,
      totalMs: Math.round(ms),
      steps: r.stats.iterations,
      improved: r.stats.improved,
      unplaced: r.unplaced.length,
      score: r.score,
      breakdown: r.breakdown,
      gaps: r.gaps,
    };
    console.log(`[benchmark] ${JSON.stringify(summary)}`);
    for (const u of r.unplaced) console.log(`[benchmark] nicht gesetzt: ${u.label} – ${u.reason}`);
    // Grenzwerte (docs/LASTTEST.md): höchstens 1 % nicht gesetzt, Klassen-Hohlstunden im Mittel < 1 je Klasse, unter 2 Minuten auch unter Last
    expect(r.unplaced.length).toBeLessThanOrEqual(Math.ceil(input.units.length * 0.01));
    expect(r.gaps.classTotal / input.classIds.size).toBeLessThan(1);
    expect(r.breakdown.noRoom).toBe(0);
    expect(ms).toBeLessThan(120_000);
    // gleiche Eingabe → gleiche Lösung, auch über solve()
    expect(solve({ ...input, iterations: r.stats.iterations }).placements).toEqual(r.placements);
  }, 300_000);
});
