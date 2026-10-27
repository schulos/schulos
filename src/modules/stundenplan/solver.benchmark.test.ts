// SP-G-15: synthetischer Groß-Benchmark – große Gesamtschule (6-zügig 5–10 + Oberstufe mit Kursen und Konfliktmengen,
// ~1 500 Einheiten). Misst Laufzeit, nicht gesetzt und Hohlstunden; Grenzwerte stehen in docs/LASTTEST.md („Solver“).
import { describe, expect, it } from "vitest";
import { createSolver, rng, solve, solveWarm, unchangedUnits, validate, type FixedLesson, type SolverInput, type SolverUnit, type UnitPart } from "./solver";
import { precheck } from "./solver-check";

interface SchoolSpec {
  /** Klassen je Jahrgang 5–10 */
  zuege: number;
  /** Kurse je Oberstufen-Jahrgang (EF, Q1, Q2) */
  coursesPerGrade: number;
  /** Schüler:innen je Oberstufen-Jahrgang */
  studentsPerGrade: number;
  /** SP-G-02: Sport in der Sek I als geteilte Klasse mit zwei Lehrkräften (zwei Teile, zwei Räume je Stunde) */
  splitSport?: boolean;
  /** SP2-02: Oberstufenkurse je Schiene als Band – eine Einheit je Stunde mit einem Teil je Kurs (eigenes Fach, Lehrkraft, Raum) */
  bands?: boolean;
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
  // geteilter Sport (SP-G-02) braucht je Klasse eine zweite Sportlehrkraft für 3 Wochenstunden
  const teacherCount = Math.ceil((spec.zuege * 6 * 31 + (spec.splitSport ? spec.zuege * 6 * 3 : 0) + 3 * spec.coursesPerGrade * 3) / 24);
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
  addRooms("sport", spec.splitSport ? 6 : 3, 60);
  addRooms("kunst", 3, 30);
  addRooms("musik", 2, 30);
  addRooms("technik", 2, 20);
  let a = 0;
  const pushUnits = (idPrefix: string, hours: number, doubles: number, common: Omit<SolverUnit, "id" | "length">) => {
    const d = Math.min(doubles, Math.floor(hours / 2));
    for (let i = 0; i < d; i++) units.push({ ...common, id: `${idPrefix}#d${i}`, length: 2 });
    for (let i = 0; i < hours - 2 * d; i++) units.push({ ...common, id: `${idPrefix}#e${i}`, length: 1 });
  };
  const partsFor = (assignmentId: string, group: string[], subject: string, hours: number, roomKind: string | null, homeRoom: string | null, size: number) => {
    const teacherIds = spec.splitSport && subject === "SP" && homeRoom ? [teacherFor(subject, hours), teacherFor(subject, hours)] : [teacherFor(subject, hours)];
    const need = { assignmentId, groupIds: group, subjectId: subject, roomId: null, roomKind, homeRoomId: homeRoom };
    const parts: UnitPart[] = teacherIds.length > 1 ? teacherIds.map((t) => ({ ...need, teacherIds: [t], size: Math.ceil(size / teacherIds.length) })) : [{ ...need, teacherIds, size }];
    return { need, teacherIds, parts };
  };
  const push = (group: string[], subject: string, hours: number, doubles: number, roomKind: string | null, homeRoom: string | null, size: number) => {
    const assignmentId = `a${++a}`;
    const { need, teacherIds, parts } = partsFor(assignmentId, group, subject, hours, roomKind, homeRoom, size);
    pushUnits(assignmentId, hours, doubles, { ...need, teacherIds, size, label: `${group.join("+")} ${subject}`, parts });
  };
  /** SP2-02: ein Band aus mehreren Kursen (gleiche Stundenzahl) – ein Teil je Kurs */
  const pushBand = (bandId: string, members: { group: string; subject: string; roomKind: string | null }[], hours: number, doubles: number, size: number) => {
    const parts = members.flatMap((m) => partsFor(`a${++a}`, [m.group], m.subject, hours, m.roomKind, null, size).parts);
    const first = parts[0]!;
    pushUnits(bandId, hours, doubles, {
      assignmentId: first.assignmentId,
      label: `${bandId}: ${members.map((m) => `${m.group} ${m.subject}`).join(" + ")}`,
      groupIds: parts.flatMap((p) => p.groupIds),
      teacherIds: [...new Set(parts.flatMap((p) => p.teacherIds))],
      subjectId: first.subjectId,
      roomId: null,
      roomKind: parts.find((p) => p.roomKind)?.roomKind ?? null,
      homeRoomId: null,
      size: size * members.length,
      parts,
    });
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
    const pending: { group: string; subject: string; roomKind: string | null }[][] = [];
    for (let k = 0; k < spec.coursesPerGrade; k++) {
      const [subject, hours, doubles, kind] = OBERSTUFE[k % OBERSTUFE.length]!;
      const id = `${grade}-${subject}${Math.floor(k / OBERSTUFE.length) + 1}`;
      names.set(id, id);
      const band = Math.floor(k / perBand);
      (bands[band] ??= []).push(id);
      // mit Bändern: Schienen aus 3-Stunden-Kursen werden eine Einheit je Stunde (Sport mit 2 Stunden bleibt einzeln)
      if (spec.bands && hours === 3) (pending[band] ??= []).push({ group: id, subject, roomKind: kind });
      else push([id], subject, hours, doubles, kind, null, 20);
    }
    pending.forEach((members, b) => {
      if (members.length > 1) pushBand(`${grade}-S${b + 1}`, members, 3, 1, 20);
      else for (const m of members) push([m.group], m.subject, 3, 1, m.roomKind, null, 20);
    });
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
    // neuer Stand SQ-01 (Zugwahl der lokalen Suche): Bewertung 1 904, Hohlstunden Lehrkräfte 132 / Klassen 3 (vorher 2 163, 169 / 13)
    expect(r.score).toBeLessThanOrEqual(1904);
    expect(r.unplaced.length).toBe(9);
    // gleiche Eingabe → gleiche Lösung, auch über solve()
    expect(solve({ ...input, iterations: r.stats.iterations }).placements).toEqual(r.placements);
  }, 300_000);

  it("SP-G-02: dieselbe Schule mit Sport als geteilte Klasse (zwei Lehrkräfte, zwei Räume je Stunde) – gültig, Räume je Teil verschieden", () => {
    const input = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130, splitSport: true });
    const split = input.units.filter((u) => u.parts.length === 2);
    expect(split.length).toBe(42 * 2); // 42 Klassen × (1 Doppel- + 1 Einzelstunde Sport)
    const t0 = performance.now();
    const r = solve(input);
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const ids = new Set(split.map((u) => u.id));
    const placed = r.placements.filter((p) => ids.has(p.unitId));
    const twoRooms = placed.filter((p) => p.roomIds?.length === 2 && p.roomIds[0] && p.roomIds[1] && p.roomIds[0] !== p.roomIds[1]).length;
    const bothSport = placed.filter((p) => p.roomIds?.every((x) => x?.startsWith("SPORT"))).length;
    console.log(`[benchmark] split ${JSON.stringify({ units: input.units.length, splitUnits: split.length, placedSplit: placed.length, twoRooms, bothSport, totalMs: Math.round(ms), unplaced: r.unplaced.length, score: r.score, roomWish: r.breakdown.roomWish, noRoom: r.breakdown.noRoom, gaps: r.gaps })}`);
    expect(twoRooms).toBe(placed.length);
    // neuer Stand SQ-01: Bewertung 2 199 (vorher 2 395)
    expect(r.score).toBeLessThanOrEqual(2199);
    expect(r.unplaced.length).toBeLessThanOrEqual(Math.ceil(input.units.length * 0.01));
    expect(r.breakdown.noRoom).toBe(0);
    expect(ms).toBeLessThan(120_000);
  }, 300_000);

  it("SP2-02: dieselbe Schule mit Oberstufen-Schienen als Bänder (vier Kurse je Einheit, eigenes Fach/Lehrkraft/Raum je Teil) – gültig, zusammen gesetzt", () => {
    const input = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130, bands: true });
    const bandUnits = input.units.filter((u) => u.parts.length > 1);
    // 3 Jahrgänge × 10 Schienen × (eine Doppel- + eine Einzelstunde); Schienen mit Sport (2 Std.) haben einen Kurs weniger im Band
    expect(bandUnits.length).toBe(3 * 10 * 2);
    expect(bandUnits.every((u) => u.parts.length >= 3 && new Set(u.parts.map((p) => p.subjectId)).size === u.parts.length)).toBe(true);
    const t0 = performance.now();
    const r = solve(input);
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const ids = new Set(bandUnits.map((u) => u.id));
    const placed = r.placements.filter((p) => ids.has(p.unitId));
    const distinctRooms = placed.filter((p) => p.roomIds && new Set(p.roomIds).size === p.roomIds.length).length;
    console.log(`[benchmark] bands ${JSON.stringify({ units: input.units.length, bandUnits: bandUnits.length, placedBands: placed.length, distinctRooms, totalMs: Math.round(ms), unplaced: r.unplaced.length, score: r.score, breakdown: r.breakdown, gaps: r.gaps })}`);
    for (const u of r.unplaced) console.log(`[benchmark] nicht gesetzt: ${u.label} – ${u.reason}`);
    // jede gesetzte Band-Stunde hat je Teil einen eigenen Raum
    expect(distinctRooms).toBe(placed.length);
    // neuer Stand SQ-01: Bewertung 1 850 (vorher 2 091)
    expect(r.score).toBeLessThanOrEqual(1850);
    expect(r.breakdown.noRoom).toBe(0);
    expect(r.unplaced.length).toBeLessThanOrEqual(Math.ceil(input.units.length * 0.01));
    expect(ms).toBeLessThan(120_000);
  }, 300_000);

  it("SP2-05: dieselbe Schule mit Schienen als Bänder und Jahrgang je Oberstufenkurs – Hohlstunden je Jahrgang über das Kursband gezählt und gesenkt", () => {
    const base = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130, bands: true });
    const gradeNr: Record<string, number> = { EF: 11, Q1: 12, Q2: 13 };
    const gradeOf = new Map([...new Set(base.units.flatMap((u) => u.groupIds))].filter((g) => g.includes("-")).map((g) => [g, gradeNr[g.split("-")[0]!]!]));
    expect(new Set(gradeOf.values()).size).toBe(3);
    /** Hohlstunden je Jahrgang: Lücken zwischen den Kurs-Stunden des Jahrgangs am Tag (Union über alle Kurse) */
    const gradeHoles = (input: SolverInput, placements: { unitId: string; weekday: number; periodNr: number }[]) => {
      const byId = new Map(input.units.map((u) => [u.id, u]));
      const day = new Map<string, Set<number>>();
      for (const p of placements) {
        const u = byId.get(p.unitId)!;
        for (const grade of new Set(u.groupIds.map((g) => gradeOf.get(g)).filter((x) => x !== undefined))) {
          const k = `${grade}|${p.weekday}`;
          if (!day.has(k)) day.set(k, new Set());
          for (let i = 0; i < u.length; i++) day.get(k)!.add(p.periodNr + i);
        }
      }
      let n = 0;
      for (const s of day.values()) {
        const min = Math.min(...s);
        const max = Math.max(...s);
        n += input.periods.filter((x) => x > min && x < max && !s.has(x)).length;
      }
      return n;
    };
    const before = solve(base);
    const input = { ...base, gradeOf };
    const t0 = performance.now();
    const r = solve(input);
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const holesBefore = gradeHoles(input, before.placements);
    const holesAfter = gradeHoles(input, r.placements);
    console.log(`[benchmark] oberstufe ${JSON.stringify({ units: input.units.length, totalMs: Math.round(ms), unplaced: r.unplaced.length, unplacedBefore: before.unplaced.length, score: r.score, holesBefore, holesAfter, breakdown: r.breakdown, gaps: r.gaps })}`);
    for (const u of r.unplaced) console.log(`[benchmark] nicht gesetzt: ${u.label} – ${u.reason}`);
    // die Kennzahl zählt die Jahrgänge wie Klassen; der Solver senkt ihre Hohlstunden
    expect(r.gaps.classTotal).toBeGreaterThanOrEqual(holesAfter);
    expect(holesAfter).toBeLessThan(holesBefore);
    // neuer Stand SQ-01: Bewertung 1 809 (vorher 1 985)
    expect(r.score).toBeLessThanOrEqual(1809);
    expect(r.unplaced.length).toBeLessThanOrEqual(Math.ceil(input.units.length * 0.01));
    expect(ms).toBeLessThan(120_000);
  }, 300_000);

  it("SP2-03: dieselbe Schule mit Tagesgrenzen (höchstens 7 Stunden am Tag, höchstens 3 Nachmittage ab der 7. Stunde) – gültig, Grenzen eingehalten", () => {
    const input = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130 });
    const rule = { maxPerDay: 7, afternoonsPerWeek: 3, lunchPeriod: null, afternoonFrom: 7 };
    input.dayRules = new Map([...input.classIds].map((c) => [c, rule]));
    const t0 = performance.now();
    const solver = createSolver(input);
    solver.construct();
    const constructMs = performance.now() - t0;
    solver.improve(Number.POSITIVE_INFINITY);
    const r = solver.result();
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const byId = new Map(input.units.map((u) => [u.id, u]));
    const day = new Map<string, Set<number>>();
    for (const p of r.placements)
      for (const g of byId.get(p.unitId)!.groupIds) {
        if (!input.classIds.has(g)) continue;
        const k = `${g}|${p.weekday}`;
        if (!day.has(k)) day.set(k, new Set());
        for (let i = 0; i < byId.get(p.unitId)!.length; i++) day.get(k)!.add(p.periodNr + i);
      }
    const maxDay = Math.max(...[...day.values()].map((s) => s.size));
    const afternoons = new Map<string, number>();
    for (const [k, s] of day) if ([...s].some((x) => x >= 7)) afternoons.set(k.split("|")[0]!, (afternoons.get(k.split("|")[0]!) ?? 0) + 1);
    const maxAfternoons = Math.max(0, ...afternoons.values());
    console.log(`[benchmark] tagesgrenzen ${JSON.stringify({ units: input.units.length, constructMs: Math.round(constructMs), totalMs: Math.round(ms), unplaced: r.unplaced.length, score: r.score, maxDay, maxAfternoons, breakdown: r.breakdown, gaps: r.gaps })}`);
    for (const u of r.unplaced) console.log(`[benchmark] nicht gesetzt: ${u.label} – ${u.reason}`);
    expect(maxDay).toBeLessThanOrEqual(7);
    expect(maxAfternoons).toBeLessThanOrEqual(3);
    // neuer Stand SQ-01: Bewertung 2 007 (vorher 2 156)
    expect(r.score).toBeLessThanOrEqual(2007);
    expect(r.unplaced.length).toBeLessThanOrEqual(Math.ceil(input.units.length * 0.01));
    expect(ms).toBeLessThan(120_000);
  }, 300_000);

  it("SP2-04: dieselbe Schule (Schienen als Bänder) mit Tagesregeln (Lehrkräfte bis 22 Std. höchstens 6 Stunden am Tag, bis 21 Std. höchstens 4 Tage) und Fachverteilung (Gewicht 6) – gültig, Regeln eingehalten", () => {
    // SP2-05: auf der Schule mit Schienen als Bänder (ohne Regeln 0–1 nicht gesetzt) – ohne Bänder lagen schon ohne Regeln 9–12 Oberstufenkurse
    // wegen dichter Konfliktmengen offen, das Ergebnis kippte je nach Gewicht zwischen 12 und 19 um die 1-%-Grenze und maß die Regeln kaum
    const input = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130, bands: true });
    const teachers = [...new Set(input.units.flatMap((u) => u.teacherIds))].sort();
    const demand = new Map<string, number>();
    for (const u of input.units) for (const t of u.teacherIds) demand.set(t, (demand.get(t) ?? 0) + u.length);
    // Teilzeit (die synthetische Schule ist voll ausgelastet, ~22–24 Std. je Lehrkraft): bis 22 Wochenstunden höchstens 6 Stunden am Tag,
    // bis 21 Wochenstunden zusätzlich höchstens 4 Anwesenheitstage
    const ruled = teachers.filter((t) => demand.get(t)! <= 22);
    const fourDays = ruled.filter((t) => demand.get(t)! <= 21);
    expect(ruled.length).toBeGreaterThanOrEqual(20);
    expect(fourDays.length).toBeGreaterThanOrEqual(10);
    input.teacherRules = new Map(ruled.map((t) => [t, { maxPerDay: 6, maxDays: fourDays.includes(t) ? 4 : null }]));
    input.weights = { subjectSpread: 6 };
    const t0 = performance.now();
    const solver = createSolver(input);
    solver.construct();
    const constructMs = performance.now() - t0;
    solver.improve(Number.POSITIVE_INFINITY);
    const r = solver.result();
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const byId = new Map(input.units.map((u) => [u.id, u]));
    const day = new Map<string, Set<number>>();
    for (const p of r.placements)
      for (const t of byId.get(p.unitId)!.teacherIds) {
        const k = `${t}|${p.weekday}`;
        if (!day.has(k)) day.set(k, new Set());
        for (let i = 0; i < byId.get(p.unitId)!.length; i++) day.get(k)!.add(p.periodNr + i);
      }
    const ruledSet = new Set(ruled);
    const maxDay = Math.max(...[...day].filter(([k]) => ruledSet.has(k.split("|")[0]!)).map(([, s]) => s.size));
    const daysOf = new Map<string, number>();
    for (const k of day.keys()) daysOf.set(k.split("|")[0]!, (daysOf.get(k.split("|")[0]!) ?? 0) + 1);
    const maxDays = Math.max(0, ...fourDays.map((t) => daysOf.get(t) ?? 0));
    console.log(`[benchmark] lehrkraftregeln ${JSON.stringify({ units: input.units.length, ruled: ruled.length, fourDays: fourDays.length, constructMs: Math.round(constructMs), totalMs: Math.round(ms), unplaced: r.unplaced.length, score: r.score, maxDay, maxDays, breakdown: r.breakdown, gaps: r.gaps })}`);
    for (const u of r.unplaced) console.log(`[benchmark] nicht gesetzt: ${u.label} – ${u.reason}`);
    expect(maxDay).toBeLessThanOrEqual(6);
    expect(maxDays).toBeLessThanOrEqual(4);
    // neuer Stand SQ-01: Bewertung 3 211 (vorher 3 397)
    expect(r.score).toBeLessThanOrEqual(3211);
    expect(r.unplaced.length).toBeLessThanOrEqual(Math.ceil(input.units.length * 0.01));
    expect(ms).toBeLessThan(120_000);
  }, 300_000);

  it("SQ-01: kleinere Schule über fünf Startwerte – die Zugwahl schlägt die frühere lokale Suche bei jedem Startwert", () => {
    // neuer Stand SQ-01: 157/144/168/158/146 bei Richtwert-Budget (15 240 Schritte); vor SQ-01 (ein Zielplatz je Schritt) 206/215/213/208/229
    const base = syntheticSchool({ zuege: 2, coursesPerGrade: 12, studentsPerGrade: 40 });
    const before = [206, 215, 213, 208, 229];
    const scores = [1, 2, 3, 4, 5].map((seed) => {
      const input = { ...base, seed };
      const r = solve(input);
      expect(validate(input, r.placements)).toEqual([]);
      expect(r.unplaced).toEqual([]);
      return r.score;
    });
    console.log(`[benchmark] sq01 ${JSON.stringify({ scores, before })}`);
    scores.forEach((x, i) => expect(x).toBeLessThan(before[i]!));
    expect(scores.reduce((a, b) => a + b, 0) / scores.length).toBeLessThanOrEqual(155);
  }, 300_000);

  it("SQ-02: Warmstart aus dem Ergebnis eines Neu-Laufs (gleiche Gründlichkeit) – je Startwert besser, nie schlechter, die meisten Einheiten bleiben", () => {
    const base = syntheticSchool({ zuege: 2, coursesPerGrade: 12, studentsPerGrade: 40 });
    const rows = [1, 2, 3, 4, 5].map((seed) => {
      const input = { ...base, seed };
      const neu = solve(input);
      const r = solveWarm(input, neu.placements);
      expect(validate(input, r.placements)).toEqual([]);
      expect(r.unplaced).toEqual([]);
      expect(r.score).toBeLessThan(neu.score);
      return { neu: neu.score, warm: r.score, stable: unchangedUnits(neu.placements, r.placements) / neu.placements.length };
    });
    console.log(`[benchmark] sq02 ${JSON.stringify(rows)}`);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Stand SQ-02: Mittel 154,6 → 133,4 (136/126/139/145/121), unverändert im Mittel ~95 % (ein zweiter Neu-Lauf mit anderem Startwert: ~43 %)
    expect(mean(rows.map((r) => r.warm))).toBeLessThanOrEqual(133.4);
    expect(Math.min(...rows.map((r) => r.stable))).toBeGreaterThan(0.85);
  }, 300_000);

  it("SQ-02: Warmstart auf der großen Schule – setzt die 9 nicht gesetzten Einheiten des Neu-Laufs, fixierte Stunden bleiben frei von anderen", () => {
    const base = syntheticSchool({ zuege: 7, coursesPerGrade: 40, studentsPerGrade: 130 });
    const neu = solve(base);
    expect(neu.unplaced.length).toBe(9);
    // jede 20. gesetzte Einheit wird fixiert (Stunden statt Einheit), der Rest ist der Start
    const byId = new Map(base.units.map((u) => [u.id, u]));
    const fixedUnits = new Set(neu.placements.filter((_, i) => i % 20 === 0).map((p) => p.unitId));
    const fixed: FixedLesson[] = neu.placements
      .filter((p) => fixedUnits.has(p.unitId))
      .flatMap((p) => {
        const u = byId.get(p.unitId)!;
        return Array.from({ length: u.length }, (_, k) =>
          u.parts.flatMap((part, i) => part.groupIds.map((g) => ({ groupId: g, teacherId: part.teacherIds[0] ?? null, roomId: p.roomIds?.[i] ?? p.roomId, subjectId: part.subjectId, weekday: p.weekday, periodNr: p.periodNr + k }))),
        ).flat();
      });
    const input = { ...base, units: base.units.filter((u) => !fixedUnits.has(u.id)), fixed };
    const start = neu.placements.filter((p) => !fixedUnits.has(p.unitId));
    const t0 = performance.now();
    const r = solveWarm(input, start);
    const ms = performance.now() - t0;
    expect(validate(input, r.placements)).toEqual([]);
    const stable = unchangedUnits(start, r.placements) / start.length;
    console.log(`[benchmark] sq02-gross ${JSON.stringify({ fixed: fixed.length, warm: r.warm, score: r.score, unplaced: r.unplaced.length, stable, ms: Math.round(ms) })}`);
    expect(r.warm!.startUnplaced).toBe(9);
    // Stand SQ-02: 9 → 0 nicht gesetzt, Bewertung 1 850 → 1 768, ~81 % der Einheiten unverändert, ~1,3 s
    expect(r.unplaced).toEqual([]);
    expect(r.score).toBeLessThanOrEqual(1768);
    expect(stable).toBeGreaterThan(0.7);
    expect(ms).toBeLessThan(120_000);
  }, 300_000);
});
