// Kurswahlen (P4-63): Zuteilung – rein, deterministisch, erklärbar. Keine DB, keine Uhr, kein Math.random.
//
// Verfahren (in Runden nach Priorität, „Erstwunsch zuerst“):
// 1. Von Hand Zugeteilte stehen fest und belegen ihre Plätze zuerst.
// 2. Runde r = 1 … k: Alle noch Offenen, deren r-ter Wunsch ein laufendes Angebot ist, bewerben sich dort. Reichen die
//    freien Plätze, bekommen alle den Platz; sonst entscheidet das Los (Reihenfolge aus Seed + Personen-ID, protokolliert).
// 3. Danach: Angebote unter der Mindestgröße – das mit dem größten Abstand zur Mindestgröße fällt aus (bei Gleichstand das
//    spätere in der Liste), und alles beginnt ohne es neu. Wiederholen, bis alle laufenden Angebote groß genug sind.
//    Von Hand Zugeteilte halten ihr Angebot am Leben.
// 4. Wer gewählt hat, aber keinen Wunsch bekommt, erhält einen Restplatz (das laufende Angebot mit den meisten freien
//    Plätzen) – ausdrücklich als Restplatz begründet. Wer nicht gewählt hat, bleibt offen (von Hand zuteilen).
//
// P4-67 Mehrfachwahl: Eine Person wählt mehrere Kurse („Plätze“, z. B. zwei AGs), je Platz mit eigenen Wünschen. Zugeteilt
// wird Platz für Platz – erst alle 1. Plätze (Schritt 2), dann alle 2. Plätze usw.; die Kapazitäten gelten über alle Plätze.
// Ein Kurs, den die Person schon hat (von Hand oder auf einem früheren Platz), zählt auf späteren Plätzen als „schon
// zugeteilt“ – niemand bekommt denselben Kurs zweimal. Mindestgrößen (Schritt 3) zählen alle Plätze zusammen. Der Seed des
// 1. Platzes ist der des Verfahrens (Ergebnisse mit einem Platz bleiben gleich), spätere Plätze losen mit „Seed#Platz“.

export interface AllocOffer {
  id: string;
  title: string;
  minSize: number;
  /** null = unbegrenzt */
  maxSize: number | null;
}

export interface AllocPlace {
  /** Angebots-IDs, 1. Wunsch zuerst; leer = für diesen Platz nicht gewählt */
  choices: readonly string[];
  /** von Hand zugeteilt (bleibt fest) */
  manual?: string | null;
}

export interface AllocStudent {
  id: string;
  /** Angebots-IDs, 1. Wunsch zuerst; leer = nicht gewählt (1. Platz, wenn `places` fehlt) */
  choices: readonly string[];
  /** von Hand zugeteilt (bleibt fest; 1. Platz, wenn `places` fehlt) */
  manual?: string | null;
  /** P4-67: alle Plätze (1. Platz zuerst) – ersetzt `choices`/`manual` */
  places?: readonly AllocPlace[];
}

export interface Assignment {
  studentId: string;
  /** Platz (1-basiert, P4-67) */
  place: number;
  offerId: string | null;
  /** erfüllter Wunsch (1-basiert); null bei Restplatz, von Hand oder ohne Zuteilung */
  rank: number | null;
  reason: string;
}

export interface OfferResult {
  id: string;
  count: number;
  cancelled: boolean;
  reason: string | null;
}

export interface AllocationResult {
  assignments: Assignment[];
  offers: OfferResult[];
  /** Protokoll in Sätzen (Ausfälle, Lose) */
  log: string[];
}

/** FNV-1a (32 Bit) – stabiler Hash für die Losreihenfolge. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Losreihenfolge: kleinerer Hash zuerst, bei Gleichstand die ID. */
export function lotOrder(seed: string, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => hash(`${seed}:${a}`) - hash(`${seed}:${b}`) || (a < b ? -1 : a > b ? 1 : 0));
}

const free = (o: AllocOffer, n: number) => (o.maxSize == null ? Infinity : o.maxSize - n);

/** Plätze einer Person (ohne `places`: genau einer aus `choices`/`manual`). */
export function placesOf(s: AllocStudent): readonly AllocPlace[] {
  return s.places?.length ? s.places : [{ choices: s.choices, manual: s.manual }];
}

const slot = (studentId: string, place: number) => `${studentId}#${place}`;
/** Seed des Loses je Platz: 1. Platz wie bisher, spätere mit Platznummer */
export const placeSeed = (seed: string, place: number) => (place === 1 ? seed : `${seed}#${place}`);

function runRounds(offers: AllocOffer[], students: readonly AllocStudent[], seed: string, active: Set<string>, log: string[] | null) {
  const count = new Map(offers.map((o) => [o.id, 0]));
  const result = new Map<string, Assignment>();
  const byId = new Map(offers.map((o) => [o.id, o]));
  /** Je Person: Kurse, die sie schon hat (kein Kurs doppelt) */
  const held = new Map<string, Set<string>>();
  const holds = (id: string) => held.get(id) ?? held.set(id, new Set()).get(id)!;
  for (const s of students) {
    placesOf(s).forEach((pl, i) => {
      if (pl.manual && byId.has(pl.manual) && !holds(s.id).has(pl.manual)) {
        result.set(slot(s.id, i + 1), { studentId: s.id, place: i + 1, offerId: pl.manual, rank: null, reason: "von Hand zugeteilt" });
        count.set(pl.manual, count.get(pl.manual)! + 1);
        holds(s.id).add(pl.manual);
      }
    });
  }
  const maxPlace = Math.max(0, ...students.map((s) => placesOf(s).length));
  /** Je Person und Platz: welche Wünsche voll bzw. ausgefallen waren (für die Begründung) */
  const missed = new Map<string, string[]>();
  const miss = (key: string, text: string) => missed.set(key, [...(missed.get(key) ?? []), text]);
  for (let p = 1; p <= maxPlace; p++) {
    const maxRank = Math.max(0, ...students.map((s) => placesOf(s)[p - 1]?.choices.length ?? 0));
    for (let r = 0; r < maxRank; r++) {
      const applicants = new Map<string, string[]>();
      for (const s of students) {
        const key = slot(s.id, p);
        if (result.has(key)) continue;
        const want = placesOf(s)[p - 1]?.choices[r];
        if (!want) continue;
        if (holds(s.id).has(want)) {
          if (byId.has(want)) miss(key, `${r + 1}. Wunsch „${byId.get(want)!.title}“ schon zugeteilt`);
          continue;
        }
        if (!active.has(want)) {
          if (byId.has(want)) miss(key, `${r + 1}. Wunsch „${byId.get(want)!.title}“ fällt aus`);
          continue;
        }
        applicants.set(want, [...(applicants.get(want) ?? []), s.id]);
      }
      for (const o of offers) {
        const list = applicants.get(o.id);
        if (!list) continue;
        const room = free(o, count.get(o.id)!);
        const order = list.length > room ? lotOrder(placeSeed(seed, p), list) : list;
        const winners = order.slice(0, Math.max(0, room));
        const losers = order.slice(winners.length);
        if (losers.length && room > 0 && log)
          log.push(`${o.title}, ${p > 1 ? `${p}. Platz, ` : ""}${r + 1}. Wunsch: ${list.length} Bewerbungen auf ${Math.max(0, room)} Plätze – Los`);
        for (const w of winners) {
          const lost = missed.get(slot(w, p));
          result.set(slot(w, p), {
            studentId: w,
            place: p,
            offerId: o.id,
            rank: r + 1,
            reason: r === 0 ? (losers.length ? "1. Wunsch erfüllt (Los gewonnen)" : "1. Wunsch erfüllt") : `${r + 1}. Wunsch erfüllt – ${lost?.join(", ") ?? "vorherige Wünsche voll"}`,
          });
          holds(w).add(o.id);
        }
        count.set(o.id, count.get(o.id)! + winners.length);
        for (const l of losers) miss(slot(l, p), `${r + 1}. Wunsch „${o.title}“ voll${room > 0 ? " (Los)" : ""}`);
      }
    }
  }
  return { result, count, missed, held: holds };
}

export function allocate(offers: readonly AllocOffer[], students: readonly AllocStudent[], seed: string): AllocationResult {
  const list = [...offers];
  const active = new Set(list.map((o) => o.id));
  const cancelled = new Map<string, string>();
  const log: string[] = [];
  const manualOf = new Map<string, number>();
  for (const s of students) for (const pl of placesOf(s)) if (pl.manual) manualOf.set(pl.manual, (manualOf.get(pl.manual) ?? 0) + 1);
  let run = runRounds(list, students, seed, active, null);
  // Mindestgröße: eins nach dem anderen streichen
  for (;;) {
    const under = list.filter((o) => active.has(o.id) && !manualOf.has(o.id) && run.count.get(o.id)! < o.minSize);
    if (under.length === 0) break;
    const worst = under.reduce((a, b) => (o2gap(b, run.count) >= o2gap(a, run.count) ? b : a));
    active.delete(worst.id);
    const msg = `${worst.title} fällt aus: ${run.count.get(worst.id)} von mindestens ${worst.minSize}`;
    cancelled.set(worst.id, msg);
    log.push(msg);
    run = runRounds(list, students, seed, active, null);
  }
  // Endlauf mit Protokoll der Lose
  run = runRounds(list, students, seed, active, log);
  const assignments: Assignment[] = [];
  for (const s of students) {
    const places = placesOf(s);
    places.forEach((pl, i) => {
      const place = i + 1;
      const a = run.result.get(slot(s.id, place));
      if (a) {
        assignments.push(a);
        return;
      }
      if (pl.choices.length === 0) {
        // nur der 1. Platz meldet „nicht gewählt“ – weitere Plätze sind freiwillig (Mindest-/Höchstzahl)
        if (place === 1) assignments.push({ studentId: s.id, place, offerId: null, rank: null, reason: "nicht gewählt – von Hand zuteilen" });
        return;
      }
      // Restplatz: laufendes Angebot mit den meisten freien Plätzen, das die Person noch nicht hat (bei Gleichstand das erste)
      let best: AllocOffer | null = null;
      for (const o of list) {
        if (!active.has(o.id) || free(o, run.count.get(o.id)!) <= 0 || run.held(s.id).has(o.id)) continue;
        if (!best || free(o, run.count.get(o.id)!) > free(best, run.count.get(best.id)!)) best = o;
      }
      const why = run.missed.get(slot(s.id, place))?.join(", ") ?? "Wünsche nicht möglich";
      if (best) {
        run.count.set(best.id, run.count.get(best.id)! + 1);
        run.held(s.id).add(best.id);
        assignments.push({ studentId: s.id, place, offerId: best.id, rank: null, reason: `Restplatz – ${why}` });
      } else assignments.push({ studentId: s.id, place, offerId: null, rank: null, reason: `kein Platz frei – ${why}; von Hand zuteilen` });
    });
  }
  return {
    assignments,
    offers: list.map((o) => ({ id: o.id, count: active.has(o.id) ? run.count.get(o.id)! : 0, cancelled: !active.has(o.id), reason: cancelled.get(o.id) ?? null })),
    log,
  };
}

/** Abstand zur Mindestgröße (größer = weiter darunter) */
function o2gap(o: AllocOffer, count: Map<string, number>): number {
  return o.minSize - count.get(o.id)!;
}

export interface Demand {
  id: string;
  /** Anzahl je Rang: [1. Wunsch, 2. Wunsch, 3. Wunsch] */
  byRank: number[];
  total: number;
}

/** Nachfrage je Angebot und Rang (nur abgegebene Wahlen). */
export function demand(offers: readonly { id: string }[], students: readonly { choices: readonly string[] }[], ranks: number): Demand[] {
  return offers.map((o) => {
    const byRank = Array.from({ length: ranks }, (_, r) => students.filter((s) => s.choices[r] === o.id).length);
    return { id: o.id, byRank, total: byRank.reduce((a, b) => a + b, 0) };
  });
}
