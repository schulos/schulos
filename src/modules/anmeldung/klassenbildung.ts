// Klassenbildung (KB-01, docs/KLASSENBILDUNG.md): Vorschlag für die Verteilung der Neuaufnahmen eines Jahrgangs auf die neuen
// Klassen. Rein und deterministisch (gleiche Eingabe + gleicher Seed → gleiches Ergebnis), ohne Server-Importe – läuft im Browser
// des Schritts „Neuaufnahmen“. Nur ein Vorschlag: Verteilung und Feinschliff bleiben bei Menschen (kein Art.-22-Fall).
//
// Harte Regeln: Klassengrößen unterscheiden sich höchstens um 1 (⌊n/k⌋ … ⌈n/k⌉); Kinder derselben Familie (gleiche E-Mail,
// z. B. Mehrlinge) bleiben zusammen, außer die Familie ist als „getrennt“ markiert; festgepinnte Kinder bleiben, wo sie sind;
// höchstens 2 Wünsche je Kind (weitere werden ignoriert und gemeldet). Wenn Festpinnen eine harte Regel unmöglich macht, gewinnt
// das Festpinnen, und `explain` meldet es.
// Weiche Ziele (Projektleitung 2026-11-01, kb-2/kb-3/kb-4): Grundschul-Gruppen ab 4 Kindern gleichmäßig verteilen, Gruppen von 2–3
// zusammenhalten, kein Kind als Einzige:r seiner Grundschule in der Klasse, wenn vermeidbar; Wünsche „zusammen“/„nicht zusammen“
// erfüllen (ein gegenseitiger Wunsch zählt doppelt); „getrennte“ Familien auf verschiedene Klassen. Kein Geschlecht, keine weiteren
// Kriterien (kb-6/kb-7).

/** Vorgabe für den Klassengröße-Richtwert (Klassenfrequenzrichtwert NRW Sek I: 27); Einstellung `anmeldung.klassengroesse`. */
export const CLASS_SIZE_DEFAULT = 27;
/** Höchstzahl berücksichtigter Wünsche je Kind (kb-1). */
export const MAX_WISHES_PER_CHILD = 2;

export interface KbChild {
  id: string;
  /** Anzeigename für Begründungen, z. B. „Muster, Mia“ */
  label: string;
  /** Grundschule; leer/null = unbekannt (geht nicht in die Mischung ein) */
  school: string | null;
  /** Familienschlüssel (z. B. aus der E-Mail von Elternteil 1) – Kinder mit gleichem Schlüssel bleiben zusammen */
  family: string;
}

export interface KbWish {
  /** Antrag, für den der Wunsch erfasst ist */
  from: string;
  /** Partnerkind */
  to: string;
  kind: "zusammen" | "nicht_zusammen";
}

export interface KbInput {
  children: readonly KbChild[];
  classNames: readonly string[];
  /** festgepinnt: Kind → Klasse (Klassen, die es nicht gibt, werden ignoriert) */
  pinned?: Readonly<Record<string, string>>;
  wishes?: readonly KbWish[];
  /** Familien (Schlüssel), die das Sekretariat als „getrennt“ markiert hat (kb-4) */
  separateFamilies?: readonly string[];
  /** 0 = Standardvorschlag; andere Werte → „Neu vorschlagen“ */
  seed?: number;
}

export interface KbClassStats {
  name: string;
  size: number;
  pinned: number;
  /** Kinder je Grundschule, absteigend (unbekannte Grundschule als „ohne Angabe“) */
  schools: { school: string; count: number }[];
  /** Kinder, die in der Klasse als Einzige aus ihrer Grundschule sind */
  alone: number;
  wishesMet: number;
  wishesTotal: number;
}

export interface KbExplanation {
  /** Begründung je Kind (Sätze, deutsch) */
  reasons: Record<string, string[]>;
  stats: KbClassStats[];
  /** Hinweise zum ganzen Vorschlag (z. B. Festpinnen sprengt die Größenregel) */
  warnings: string[];
}

export interface KbResult extends KbExplanation {
  /** Kind → Klasse */
  assignment: Record<string, string>;
}

const NO_SCHOOL = "ohne Angabe";
const W_SIZE = 10_000;
const W_FAMILY_SEPARATE = 40;
const W_WISH = 30;
const W_ALONE = 12;
const W_SMALL_SPLIT = 8;
const W_EVEN = 2;

/** Seed-Zufall (mulberry32) – deterministisch, unabhängig von Math.random. */
function rng(seed: number): () => number {
  let a = (seed >>> 0) + 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

const schoolOf = (c: KbChild) => c.school?.trim() || null;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Wünsche bereinigen: nur bekannte Kinder, keine Selbstwünsche, Doppelte raus, höchstens 2 je Kind (in Eingabereihenfolge). */
export function normalizeWishes(children: readonly KbChild[], wishes: readonly KbWish[] = []): { wishes: KbWish[]; dropped: number } {
  const ids = new Set(children.map((c) => c.id));
  const seen = new Set<string>();
  const perChild = new Map<string, number>();
  const out: KbWish[] = [];
  let dropped = 0;
  for (const w of wishes) {
    if (!ids.has(w.from) || !ids.has(w.to) || w.from === w.to) continue;
    const key = `${w.from}|${w.to}|${w.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = perChild.get(w.from) ?? 0;
    if (n >= MAX_WISHES_PER_CHILD) {
      dropped++;
      continue;
    }
    perChild.set(w.from, n + 1);
    out.push(w);
  }
  return { wishes: out, dropped };
}

/** Untere/obere Grenze der Klassengröße (harte Regel: Unterschied höchstens 1). */
export function sizeBounds(count: number, classes: number): { min: number; max: number } {
  if (classes <= 0) return { min: 0, max: 0 };
  return { min: Math.floor(count / classes), max: Math.ceil(count / classes) };
}

interface Model {
  children: readonly KbChild[];
  classNames: readonly string[];
  wishes: KbWish[];
  separate: Set<string>;
  schoolSize: Map<string, number>;
  bounds: { min: number; max: number };
}

function buildModel(input: KbInput): Model & { dropped: number } {
  const { wishes, dropped } = normalizeWishes(input.children, input.wishes);
  const schoolSize = new Map<string, number>();
  for (const c of input.children) {
    const s = schoolOf(c);
    if (s) schoolSize.set(s, (schoolSize.get(s) ?? 0) + 1);
  }
  return {
    children: input.children,
    classNames: input.classNames,
    wishes,
    dropped,
    separate: new Set(input.separateFamilies ?? []),
    schoolSize,
    bounds: sizeBounds(input.children.length, input.classNames.length),
  };
}

/** Bewertung einer vollständigen Zuordnung (Klassenindex je Kind); kleiner ist besser. Vorberechnet, weil die Suche sie oft aufruft. */
function makeCost(m: Model, index: ReadonlyMap<string, number>): (at: readonly number[]) => number {
  const k = m.classNames.length;
  const n = m.children.length;
  const schoolNames = [...m.schoolSize.keys()];
  const schoolIdx = new Map(schoolNames.map((s, i) => [s, i]));
  const schoolOfChild = Int32Array.from(m.children, (c) => {
    const s = schoolOf(c);
    return s ? schoolIdx.get(s)! : -1;
  });
  const groupSize = Int32Array.from(schoolNames, (s) => m.schoolSize.get(s)!);
  const wishPairs = m.wishes.map((w) => [index.get(w.from)!, index.get(w.to)!, w.kind === "zusammen" ? 1 : 0] as const);
  const separated: number[][] = [];
  if (m.separate.size) {
    const byFamily = new Map<string, number[]>();
    m.children.forEach((c, i) => m.separate.has(c.family) && byFamily.set(c.family, [...(byFamily.get(c.family) ?? []), i]));
    for (const members of byFamily.values()) if (members.length > 1) separated.push(members);
  }
  const size = new Int32Array(k);
  const grid = new Int32Array(k * schoolNames.length);
  return (at) => {
    size.fill(0);
    grid.fill(0);
    for (let i = 0; i < n; i++) {
      const cls = at[i]!;
      size[cls]!++;
      const s = schoolOfChild[i]!;
      if (s >= 0) grid[s * k + cls]!++;
    }
    let total = 0;
    for (let c = 0; c < k; c++) total += W_SIZE * (Math.max(0, size[c]! - m.bounds.max) + Math.max(0, m.bounds.min - size[c]!));
    for (let s = 0; s < groupSize.length; s++) {
      const g = groupSize[s]!;
      if (g < 2) continue;
      let used = 0;
      const ideal = g / k;
      for (let c = 0; c < k; c++) {
        const v = grid[s * k + c]!;
        if (v === 1) total += W_ALONE;
        if (v > 0) used++;
        if (g > 3) total += W_EVEN * (v - ideal) * (v - ideal);
      }
      if (g <= 3) total += W_SMALL_SPLIT * (used - 1);
    }
    for (const [a, b, together] of wishPairs) if ((at[a] === at[b] ? 1 : 0) !== together) total += W_WISH;
    for (const members of separated)
      for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) if (at[members[x]!] === at[members[y]!]) total += W_FAMILY_SEPARATE;
    return total;
  };
}

interface Unit {
  members: number[];
  /** festgepinnte Klasse (Index) oder null */
  fixed: number | null;
}

/** Einheiten bilden: Familien (außer „getrennt“) als Block; festgepinnte Mitglieder bestimmen die Klasse des Blocks. */
function buildUnits(m: Model, pinned: Readonly<Record<string, string>>): Unit[] {
  const classIdx = new Map(m.classNames.map((n, i) => [n, i]));
  const pinOf = (id: string) => {
    const p = pinned[id];
    return p !== undefined && classIdx.has(p) ? classIdx.get(p)! : null;
  };
  const byFamily = new Map<string, number[]>();
  const units: Unit[] = [];
  m.children.forEach((c, i) => {
    if (m.separate.has(c.family)) units.push({ members: [i], fixed: pinOf(c.id) });
    else byFamily.set(c.family, [...(byFamily.get(c.family) ?? []), i]);
  });
  for (const members of byFamily.values()) {
    // Festgepinnte Mitglieder in verschiedenen Klassen → Familie zerfällt nach Pins (Pin gewinnt), Ungepinnte gehen zum ersten Pin
    const pins = new Map<number, number[]>();
    const free: number[] = [];
    for (const i of members) {
      const p = pinOf(m.children[i]!.id);
      if (p === null) free.push(i);
      else pins.set(p, [...(pins.get(p) ?? []), i]);
    }
    if (!pins.size) units.push({ members, fixed: null });
    else {
      let first = true;
      for (const [cls, ids] of pins) {
        units.push({ members: first ? [...ids, ...free] : ids, fixed: cls });
        first = false;
      }
    }
  }
  return units;
}

/** Anzahl der Startzuordnungen je Vorschlag (die beste gewinnt; Gleichstand: die erste). */
const STARTS = 8;

/**
 * Vorschlag berechnen: mehrere Startzuordnungen (Familienblöcke gierig in die kleinste Klasse mit Platz, Reihenfolge aus dem
 * Seed), jeweils lokale Suche (Block verschieben, zwei Blöcke tauschen), bis sich nichts mehr verbessert; die beste Zuordnung
 * gewinnt. Gleicher Seed → gleiches Ergebnis; ein anderer Seed („Neu vorschlagen“) wählt unter gleich guten Zuordnungen
 * eine andere. Ohne Klassen: leere Zuordnung.
 */
export function proposeClasses(input: KbInput): KbResult {
  const m = buildModel(input);
  const k = m.classNames.length;
  if (!k || !m.children.length) return { assignment: {}, ...explain(input, {}) };
  const index = new Map(m.children.map((c, i) => [c.id, i]));
  const units = buildUnits(m, input.pinned ?? {});
  const seed = input.seed ?? 0;
  // Grundordnung: feste Blöcke zuerst, dann größere Blöcke, sonst nach Grundschule/ID (unabhängig von der Eingabereihenfolge)
  const base = units
    .map((_, i) => i)
    .sort((a, b) => {
      const ua = units[a]!;
      const ub = units[b]!;
      if ((ua.fixed === null) !== (ub.fixed === null)) return ua.fixed === null ? 1 : -1;
      if (ub.members.length !== ua.members.length) return ub.members.length - ua.members.length;
      const ca = m.children[ua.members[0]!]!;
      const cb = m.children[ub.members[0]!]!;
      return cmp(schoolOf(ca) ?? "", schoolOf(cb) ?? "") || cmp(ca.id, cb.id);
    });

  // Gleichwertige Blöcke (gleiche Größe, gleiche Grundschulen, ohne Wünsche/„getrennt“) zu tauschen ändert nichts – überspringen
  const special = new Set([...m.wishes.flatMap((w) => [index.get(w.from)!, index.get(w.to)!])]);
  const signature = units.map((u, i) =>
    u.members.some((x) => special.has(x) || m.separate.has(m.children[x]!.family))
      ? `#${i}`
      : u.members
          .map((x) => schoolOf(m.children[x]!) ?? "")
          .sort()
          .join("|"),
  );

  const cost = makeCost(m, index);
  const attempt = (rand: (() => number) | null) => {
    // gemischt nur innerhalb gleicher Blockgröße, damit große Familien zuerst Platz finden
    const order = rand
      ? shuffle([...base], rand).sort((a, b) => {
          const ua = units[a]!;
          const ub = units[b]!;
          if ((ua.fixed === null) !== (ub.fixed === null)) return ua.fixed === null ? 1 : -1;
          return ub.members.length - ua.members.length;
        })
      : base;
    const classOrder = rand
      ? shuffle(
          m.classNames.map((_, i) => i),
          rand,
        )
      : m.classNames.map((_, i) => i);
    const at = new Array<number>(m.children.length).fill(-1);
    const unitClass = new Array<number>(units.length).fill(-1);
    const place = (u: number, cls: number) => {
      unitClass[u] = cls;
      for (const i of units[u]!.members) at[i] = cls;
    };
    const size = new Array<number>(k).fill(0);
    const schoolCount = new Map<string, number[]>();
    for (const u of order) {
      const unit = units[u]!;
      let cls = unit.fixed;
      if (cls === null) {
        const s = schoolOf(m.children[unit.members[0]!]!);
        const row = s ? (schoolCount.get(s) ?? null) : null;
        cls = classOrder.reduce((best, c) => {
          const fitsC = size[c]! + unit.members.length <= m.bounds.max;
          const fitsB = size[best]! + unit.members.length <= m.bounds.max;
          if (fitsC !== fitsB) return fitsC ? c : best;
          if (size[c] !== size[best]) return size[c]! < size[best]! ? c : best;
          if (row && row[c] !== row[best]) return row[c]! < row[best]! ? c : best;
          return best;
        }, classOrder[0]!);
      }
      place(u, cls);
      size[cls]! += unit.members.length;
      for (const i of unit.members) {
        const s = schoolOf(m.children[i]!);
        if (!s) continue;
        const row = schoolCount.get(s) ?? new Array<number>(k).fill(0);
        row[cls]!++;
        schoolCount.set(s, row);
      }
    }
    const movable = order.filter((u) => units[u]!.fixed === null);
    let best = cost(at);
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      for (const u of movable) {
        const from = unitClass[u]!;
        for (const c of classOrder) {
          if (c === from) continue;
          place(u, c);
          const v = cost(at);
          if (v < best) {
            best = v;
            improved = true;
            break;
          }
          place(u, from);
        }
      }
      for (let x = 0; x < movable.length; x++) {
        for (let y = x + 1; y < movable.length; y++) {
          const a = movable[x]!;
          const b = movable[y]!;
          const ca = unitClass[a]!;
          const cb = unitClass[b]!;
          if (ca === cb || signature[a] === signature[b]) continue;
          place(a, cb);
          place(b, ca);
          const v = cost(at);
          if (v < best) {
            best = v;
            improved = true;
          } else {
            place(a, ca);
            place(b, cb);
          }
        }
      }
      if (!improved) break;
    }
    return { at, cost: best };
  };

  let winner: { at: number[]; cost: number } | null = null;
  for (let r = 0; r < STARTS; r++) {
    const res = attempt(seed === 0 && r === 0 ? null : rng(seed * STARTS + r));
    if (!winner || res.cost < winner.cost) winner = res;
  }
  const assignment: Record<string, string> = {};
  m.children.forEach((c, i) => (assignment[c.id] = m.classNames[winner!.at[i]!]!));
  return { assignment, ...explain(input, assignment) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Begründung je Kind und Kennzahlen je Klasse für eine (auch von Hand geänderte) Zuordnung. Kinder ohne Klasse in
 * `classNames` (nicht zugeordnet oder „nicht übernehmen“) zählen nirgends mit.
 */
export function explain(input: KbInput, assignment: Readonly<Record<string, string>>): KbExplanation {
  const m = buildModel(input);
  const classes = new Set(m.classNames);
  const inClass = (id: string) => (classes.has(assignment[id] ?? "") ? assignment[id]! : null);
  const pinned = input.pinned ?? {};
  const byId = new Map(m.children.map((c) => [c.id, c]));
  const placed = m.children.filter((c) => inClass(c.id));
  const bounds = sizeBounds(placed.length, m.classNames.length);
  const count = (cls: string, pred: (c: KbChild) => boolean) => placed.filter((c) => inClass(c.id) === cls && pred(c)).length;

  const stats: KbClassStats[] = m.classNames.map((name) => {
    const members = placed.filter((c) => inClass(c.id) === name);
    const schools = new Map<string, number>();
    for (const c of members) schools.set(schoolOf(c) ?? NO_SCHOOL, (schools.get(schoolOf(c) ?? NO_SCHOOL) ?? 0) + 1);
    const mine = m.wishes.filter((w) => inClass(w.from) === name);
    return {
      name,
      size: members.length,
      pinned: members.filter((c) => pinned[c.id] === name).length,
      schools: [...schools].map(([school, n]) => ({ school, count: n })).sort((a, b) => b.count - a.count || cmp(a.school, b.school)),
      alone: members.filter((c) => schoolOf(c) && schools.get(schoolOf(c)!) === 1 && (m.schoolSize.get(schoolOf(c)!) ?? 0) > 1).length,
      wishesMet: mine.filter((w) => (w.kind === "zusammen") === (inClass(w.to) === name)).length,
      wishesTotal: mine.length,
    };
  });

  const reasons: Record<string, string[]> = {};
  for (const c of m.children) {
    const cls = inClass(c.id);
    if (!cls) continue;
    const r: string[] = [];
    if (pinned[c.id] === cls) r.push("von Hand festgelegt (festgepinnt)");
    const fam = m.children.filter((o) => o.id !== c.id && o.family === c.family);
    if (fam.length) {
      const together = fam.filter((o) => inClass(o.id) === cls);
      if (m.separate.has(c.family))
        r.push(
          together.length
            ? "Familie als „getrennt“ markiert – Trennung hier nicht möglich"
            : "Familie als „getrennt“ markiert: Geschwister in anderer Klasse",
        );
      else if (together.length === fam.length) r.push(`Familie zusammen (mit ${together.map((o) => o.label).join(", ")})`);
      else r.push("Familie durch Festpinnen getrennt");
    }
    const s = schoolOf(c);
    if (s) {
      const g = m.schoolSize.get(s) ?? 1;
      const here = count(cls, (o) => schoolOf(o) === s) - 1;
      if (g === 1) r.push(`einziges Kind aus „${s}“ im Jahrgang`);
      else if (here === 0) r.push(`einziges Kind aus „${s}“ in dieser Klasse`);
      else if (g <= 3)
        r.push(
          here === g - 1 ? `Grundschulgruppe „${s}“ zusammen (${g} Kinder)` : `mit ${plural(here, "weiteren Kind", "weiteren Kindern")} aus „${s}“`,
        );
      else r.push(`mit ${plural(here, "weiteren Kind", "weiteren Kindern")} aus „${s}“ (${g} Kinder der Grundschule auf die Klassen verteilt)`);
    }
    for (const w of m.wishes.filter((x) => x.from === c.id)) {
      const other = byId.get(w.to)!;
      const same = inClass(w.to) === cls;
      const ok = (w.kind === "zusammen") === same;
      const mutual = m.wishes.some((x) => x.from === w.to && x.to === w.from && x.kind === w.kind);
      r.push(
        `Wunsch „${w.kind === "zusammen" ? "zusammen" : "nicht zusammen"}“ mit ${other.label}${mutual ? " (gegenseitig)" : ""}: ${ok ? "erfüllt" : "nicht erfüllt"}`,
      );
    }
    if (!r.length) r.push("Ausgleich der Klassengrößen");
    reasons[c.id] = r;
  }

  const warnings: string[] = [];
  const sizes = stats.map((x) => x.size);
  if (sizes.length && placed.length && (Math.max(...sizes) > bounds.max || Math.min(...sizes) < bounds.min))
    warnings.push(`Klassengrößen weichen um mehr als 1 voneinander ab (${sizes.join(" / ")}).`);
  const familySplit = new Set(
    m.children
      .filter(
        (c) =>
          !m.separate.has(c.family) &&
          inClass(c.id) &&
          m.children.some((o) => o.family === c.family && inClass(o.id) && inClass(o.id) !== inClass(c.id)),
      )
      .map((c) => c.family),
  );
  if (familySplit.size) warnings.push(`${plural(familySplit.size, "Familie ist", "Familien sind")} auf verschiedene Klassen verteilt.`);
  if (m.dropped) warnings.push(`${plural(m.dropped, "Wunsch", "Wünsche")} über der Grenze von ${MAX_WISHES_PER_CHILD} je Kind nicht berücksichtigt.`);
  return { reasons, stats, warnings };
}
