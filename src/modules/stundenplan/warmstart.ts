// SQ-02: Startlösung eines Warmstarts aus den Stunden eines Entwurfs – rein, ohne Datenbank. Die Stunden eines Lehrauftrags bzw.
// Bands werden seinen Einheiten zugeordnet (Doppelstunden zuerst auf zwei aufeinanderfolgende Stunden, dann Einzelstunden); was
// nicht passt, bleibt für den Solver „nicht gesetzt“ und wird in den Runden bevorzugt eingeplant.
import { unitParts, type Placement, type SolverInput, type SolverUnit } from "./solver";

/** Eine Stunde des Entwurfs, die der Lauf ersetzen darf (nicht fixiert, mit Lehrauftrag). */
export interface StartLesson {
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
}

export interface StartPlacements {
  placements: Placement[];
  /** Einheiten ohne Platz im Entwurf (offene Stunden, auseinandergezogene Doppelstunden …) */
  open: number;
  /** Stunden des Entwurfs, die keiner Einheit zugeordnet wurden (mehr Stunden als Lehrauftrag, andere Lehrkraft-Aufteilung …) */
  unused: number;
}

const key = (g: string, s: string, wd: number, nr: number) => `${g}|${s}|${wd}|${nr}`;

/**
 * Rein: Platzierungen der Einheiten aus den Entwurfsstunden. Je Lehrauftrag/Band (Einheiten mit derselben id vor `#`) zählen die
 * Slots, in denen sein erster Teil (erste Gruppe, Fach) eine Stunde hat – Stunden mit passender Lehrkraft zuerst. Doppelstunden
 * nehmen zwei aufeinanderfolgende Stunden (nicht über eine große Pause), Einzelstunden den Rest. Jede Entwurfsstunde wird höchstens
 * einmal verbraucht (je Teil und Gruppe); der Raum eines Teils kommt aus seiner Stunde. Die Zulässigkeit prüft erst der Solver.
 */
export function startPlacements(input: Pick<SolverInput, "units" | "periods" | "breakAfter">, lessons: StartLesson[]): StartPlacements {
  const pool = new Map<string, StartLesson[]>();
  for (const l of lessons) {
    const k = key(l.groupId, l.subjectId, l.weekday, l.periodNr);
    pool.set(k, [...(pool.get(k) ?? []), l]);
  }
  const fits = (l: StartLesson, teachers: string[]) => !teachers.length || (l.teacherId !== null && teachers.includes(l.teacherId));
  /** nimmt eine Stunde aus dem Vorrat (passende Lehrkraft zuerst) */
  const claim = (g: string, s: string, wd: number, nr: number, teachers: string[]): StartLesson | null => {
    const rows = pool.get(key(g, s, wd, nr));
    if (!rows?.length) return null;
    const i = Math.max(
      0,
      rows.findIndex((l) => fits(l, teachers)),
    );
    return rows.splice(i, 1)[0]!;
  };
  const periodSet = new Set(input.periods);
  const noDoubleAfter = new Set(input.breakAfter ?? []);
  const byPrefix = new Map<string, SolverUnit[]>();
  for (const u of input.units) {
    const p = u.id.split("#")[0]!;
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), u]);
  }
  const placements: Placement[] = [];
  let used = 0;
  const done = new Set<string>();
  /** belegte Slots je Lehrauftrag/Band (eine Einheit je Slot) */
  const taken = new Map<string, Set<string>>();
  /** Einheiten einer Gruppe setzen – `strict`: nur Stunden mit passender Lehrkraft (1. Durchgang), sonst auch umbesetzte */
  const place = (prefix: string, units: SolverUnit[], strict: boolean) => {
    const parts = unitParts(units[0]!);
    const lead = parts[0]!;
    const g0 = lead.groupIds[0];
    if (!g0) return;
    const busy = taken.get(prefix) ?? new Set<string>();
    taken.set(prefix, busy);
    const free = (wd: number, nr: number) => !busy.has(`${wd}-${nr}`) && (pool.get(key(g0, lead.subjectId, wd, nr)) ?? []).some((l) => !strict || fits(l, lead.teacherIds));
    const slots = [
      ...new Map(lessons.filter((l) => l.groupId === g0 && l.subjectId === lead.subjectId).map((l) => [`${l.weekday}-${l.periodNr}`, { wd: l.weekday, nr: l.periodNr }])).values(),
    ].sort((a, b) => a.wd - b.wd || a.nr - b.nr);
    const take = (u: SolverUnit, wd: number, nr: number) => {
      for (let k = 0; k < u.length; k++) busy.add(`${wd}-${nr + k}`);
      const roomIds = parts.map((part) => {
        let room: string | null | undefined;
        for (let k = 0; k < u.length; k++)
          for (const g of part.groupIds) {
            const l = claim(g, part.subjectId, wd, nr + k, part.teacherIds);
            if (!l) continue;
            used++;
            if (room === undefined) room = l.roomId;
          }
        return room ?? null;
      });
      placements.push({
        unitId: u.id,
        weekday: wd,
        periodNr: nr,
        roomId: roomIds[0] ?? null,
        roomIds,
      });
      done.add(u.id);
    };
    // Doppelstunden: zwei aufeinanderfolgende Stunden am selben Tag, nicht über eine große Pause; dann Einzelstunden
    for (const u of units.filter((x) => x.length === 2 && !done.has(x.id))) {
      const at = slots.find((x) => free(x.wd, x.nr) && periodSet.has(x.nr + 1) && !noDoubleAfter.has(x.nr) && free(x.wd, x.nr + 1));
      if (at) take(u, at.wd, at.nr);
    }
    for (const u of units.filter((x) => x.length === 1 && !done.has(x.id))) {
      const at = slots.find((x) => free(x.wd, x.nr));
      if (at) take(u, at.wd, at.nr);
    }
  };
  for (const strict of [true, false]) for (const [prefix, units] of byPrefix) place(prefix, units, strict);
  const order = new Map(input.units.map((u, i) => [u.id, i]));
  placements.sort((a, b) => order.get(a.unitId)! - order.get(b.unitId)!);
  return {
    placements,
    open: input.units.length - placements.length,
    unused: lessons.length - used,
  };
}
