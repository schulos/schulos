// Machbarkeits-Vorprüfung (SP-G-03) und große Pausen (SP-G-04a) – rein, ohne Datenbank.
//
// Vor dem Lauf: je Lehrkraft und Gruppe der Bedarf (Stunden aller Einheiten) gegen die freien, ungesperrten Slots nach Abzug
// der fixierten Stunden; je Raumart der Bedarf gegen Räume × Slots. Was sicher nicht passt, ist ein Fehler (der Lauf
// wird trotzdem gerechnet – die Einheiten landen dann mit konkretem Grund unter „nicht gesetzt“), was knapp ist, eine Warnung.
import type { SolverInput } from "./solver";

export interface PrecheckFinding {
  severity: "error" | "warn";
  kind: "teacher" | "group" | "roomKind" | "double";
  id: string | null;
  label: string;
  /** Stunden, die der Solver für diesen Beteiligten setzen muss */
  demand: number;
  /** Slots, die dafür zur Verfügung stehen */
  free: number;
  message: string;
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Stunden, nach denen eine große Pause (≥ `minGap` Minuten) folgt – über sie hinweg gibt es keine Doppelstunde. */
export function longBreaksAfter(periods: { nr: number; startsAt: string; endsAt: string }[], minGap = 20): number[] {
  const sorted = [...periods].sort((a, b) => a.nr - b.nr);
  const out: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (minutes(b.startsAt) - minutes(a.endsAt) >= minGap) out.push(a.nr);
  }
  return out;
}

/** Vorprüfung der Solver-Eingabe: Fehler zuerst, dann Warnungen, jeweils engster Beteiligter zuerst. */
export function precheck(input: SolverInput): PrecheckFinding[] {
  const name = (id: string) => input.names?.get(id) ?? id;
  const slots = input.weekdays.length * input.periods.length;
  const out: PrecheckFinding[] = [];
  const blockedCount = (kind: string, id: string) => {
    const m = input.prefs.get(`${kind}:${id}`);
    if (!m) return 0;
    let n = 0;
    for (const [k, v] of m) {
      if (v !== null) continue;
      const [wd, nr] = k.split("-").map(Number);
      if (input.weekdays.includes(wd!) && input.periods.includes(nr!)) n++;
    }
    return n;
  };
  const judge = (kind: PrecheckFinding["kind"], id: string, label: string, demand: number, free: number, detail: string) => {
    if (!demand) return;
    const reserve = free - demand;
    const severity: PrecheckFinding["severity"] | null = reserve < 0 ? "error" : reserve < Math.max(2, Math.ceil(demand * 0.1)) ? "warn" : null;
    if (!severity) return;
    out.push({
      severity,
      kind,
      id,
      label,
      demand,
      free,
      message:
        severity === "error"
          ? `${label}: ${demand} Stunden zu setzen, aber nur ${free} Slots frei${detail} – ${demand - free} passen sicher nicht`
          : `${label}: ${demand} Stunden auf ${free} freie Slots${detail} – sehr eng`,
    });
  };

  // Lehrkräfte und Gruppen: Bedarf aus den Einheiten, frei = Slots − fixiert − gesperrt
  const demand = new Map<string, number>();
  for (const u of input.units) {
    for (const t of u.teacherIds) demand.set(`t:${t}`, (demand.get(`t:${t}`) ?? 0) + u.length);
    for (const g of u.groupIds) demand.set(`g:${g}`, (demand.get(`g:${g}`) ?? 0) + u.length);
  }
  const fixedSlots = new Map<string, Set<string>>();
  const addFixed = (key: string, f: { weekday: number; periodNr: number }) => {
    if (!fixedSlots.has(key)) fixedSlots.set(key, new Set());
    fixedSlots.get(key)!.add(`${f.weekday}-${f.periodNr}`);
  };
  for (const f of input.fixed) {
    addFixed(`g:${f.groupId}`, f);
    if (f.teacherId) addFixed(`t:${f.teacherId}`, f);
    if (f.roomId) addFixed(`r:${f.roomId}`, f);
  }
  for (const [key, need] of [...demand.entries()].sort()) {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    const fixed = fixedSlots.get(key)?.size ?? 0;
    const blocked = blockedCount(kind === "t" ? "teacher" : "group", id);
    const free = Math.max(0, slots - fixed - blocked);
    const detail = fixed || blocked ? ` (${[fixed ? `${fixed} fixiert` : null, blocked ? `${blocked} gesperrt` : null].filter(Boolean).join(", ")})` : "";
    if (kind === "t") judge("teacher", id, `Lehrkraft ${name(id)}`, need, free, detail);
    else judge("group", id, `${input.classIds.has(id) ? "Klasse" : "Gruppe"} ${name(id)}`, need, free, detail);
  }

  // Raumarten: Bedarf der Teile mit Fachraum (SP-G-02: je Teil ein Raum) gegen Räume dieser Art × Slots (Raum ist im Solver weich → Warnung)
  const roomNeed = new Map<string, number>();
  for (const u of input.units) for (const part of u.parts) if (part.roomKind) roomNeed.set(part.roomKind, (roomNeed.get(part.roomKind) ?? 0) + u.length);
  for (const [kind, need] of [...roomNeed.entries()].sort()) {
    const rooms = input.rooms.filter((r) => r.kind === kind);
    const fixedInKind = rooms.reduce((s, r) => s + (fixedSlots.get(`r:${r.id}`)?.size ?? 0), 0);
    const free = rooms.length * slots - fixedInKind;
    if (!rooms.length) {
      out.push({ severity: "warn", kind: "roomKind", id: kind, label: `Raumart ${kind}`, demand: need, free: 0, message: `Raumart ${kind}: ${need} Stunden brauchen einen Fachraum, es gibt keinen aktiven Raum dieser Art` });
      continue;
    }
    if (need > free)
      out.push({
        severity: "warn",
        kind: "roomKind",
        id: kind,
        label: `Raumart ${kind}`,
        demand: need,
        free,
        message: `Raumart ${kind}: ${need} Stunden für ${rooms.length} ${rooms.length === 1 ? "Raum" : "Räume"} (${free} Slots frei) – ${need - free} Stunden bekommen keinen Fachraum`,
      });
  }

  // Doppelstunden: gibt es überhaupt ein Stundenpaar ohne große Pause?
  const doubles = input.units.filter((u) => u.length === 2).length;
  if (doubles) {
    const breaks = new Set(input.breakAfter ?? []);
    const pairs = input.periods.filter((p) => input.periods.includes(p + 1) && !breaks.has(p)).length;
    if (!pairs)
      out.push({
        severity: "error",
        kind: "double",
        id: null,
        label: "Doppelstunden",
        demand: doubles,
        free: 0,
        message: `${doubles} Doppelstunden, aber im Zeitraster liegt zwischen allen Stunden eine große Pause – keine Doppelstunde möglich`,
      });
  }

  const rank = { error: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.free - a.demand - (b.free - b.demand) || a.label.localeCompare(b.label, "de"));
}
