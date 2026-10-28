// SP3-04 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.3, R1): reine Regeln für das Veröffentlichen einer Planversion – welche Stunden des
// gültigen Plans bleiben, enden oder entfallen, welche neu entstehen (`transferPlan`) und wohin Vertretungen, Material und
// Klassenbuch-Einträge ab dem Stichtag ziehen (`transferRefs`). Ohne Datenbank, mit Tabellen-Tests aus dem Demo-Plan
// (`plan-uebertrag.test.ts`); `veroeffentlichen.ts` liest, schreibt und sichert die Rücknahme-Daten.
import { addDays, isoWeek, weekdayMon0 } from "@/core/time";
import { planDiff, type DiffField, type DiffKind, type DiffLesson } from "./plan-diff";

/** Eine Stunde mit Gültigkeit (gültiger Plan bzw. Entwurf; `originLessonId` nur im Entwurf). */
export interface TransferLesson extends DiffLesson {
  validFrom: string;
  validUntil: string | null;
  fixed: boolean;
  solverRunId: string | null;
}

/** Eine neue Stunde des gültigen Plans aus einer Entwurfsstunde. */
export interface CreatedLesson extends Omit<TransferLesson, "originLessonId"> {
  /** die Entwurfsstunde, aus der sie entsteht */
  draftId: string;
  /** die Stunde des gültigen Plans, die sie ersetzt (geändert), sonst `null` (neu) */
  predecessorId: string | null;
}

export interface TransferPlan {
  from: string;
  /** Stunden des gültigen Plans, die unverändert bleiben (id, Klassenbuch, Vertretungen, Material bleiben) */
  kept: string[];
  /** Stunden, die am Vortag des Stichtags enden – mit ihrem bisherigen Ende */
  ended: { id: string; validUntil: string | null }[];
  /** Stunden, die erst ab dem Stichtag begannen und ganz entfallen */
  deleted: string[];
  /** neue Stunden ab dem Stichtag */
  created: CreatedLesson[];
  /** Stunde des gültigen Plans → ihre Nachfolgerin (geändert) */
  successor: Map<string, CreatedLesson>;
  /** Zahlen wie in der Vorschau: Paare unverändert/geändert, neu, entfällt */
  counts: Record<DiffKind, number>;
  /** davon geändert nur im Zeitraum (Beginn/Ende) bzw. nur, weil ein Teil derselben Kopplung sich ändert */
  changedTiming: number;
  changedWithCoupling: number;
}

/** Zeitraum ab dem Stichtag bis höchstens Schuljahresende (`null` = nichts mehr ab dem Stichtag). */
function window(l: Pick<TransferLesson, "validFrom" | "validUntil">, from: string, yearEnd: string): { start: string; end: string } | null {
  const start = l.validFrom > from ? l.validFrom : from;
  const end = l.validUntil === null || l.validUntil > yearEnd ? yearEnd : l.validUntil;
  return start <= end ? { start, end } : null;
}

/**
 * Rein (§2.3 Schritt 1 und 3): Veröffentlichen einer Version ab `from` gegen den gültigen Plan. `live` = Stunden des gültigen Plans, die
 * ab dem Stichtag im Schuljahr gelten; `draft` = alle Entwurfsstunden der Version. Paare wie im Diff (`planDiff`: Herkunft, sonst gleicher
 * Inhalt). Ein Paar bleibt **unverändert** (Live-Zeile unangetastet), wenn Inhalt, Kopplungspartner und Zeitraum ab dem Stichtag gleich
 * sind (Ende bis höchstens Schuljahresende verglichen – „unbefristet“ und „bis Schuljahresende“ sind gleich). Kopplungen zählen als Einheit:
 * ändert sich ein Teil (oder kommt einer dazu bzw. fällt weg), bekommen alle Teile neue Zeilen mit einer neuen Kopplungs-id – sonst teilten
 * sich beendete und neue Zeilen dieselbe Kopplung. Geänderte und entfallende Stunden enden am Vortag (bzw. werden gelöscht, wenn sie erst ab
 * dem Stichtag begannen); neue Zeilen gelten ab dem Stichtag (bzw. dem späteren Beginn im Entwurf) bis zum Entwurfsende, höchstens
 * Schuljahresende.
 */
export function transferPlan(
  input: { live: readonly TransferLesson[]; draft: readonly TransferLesson[]; from: string; yearEnd: string },
  newId: () => string = () => crypto.randomUUID(),
): TransferPlan {
  const { from, yearEnd } = input;
  const live = input.live.filter((l) => window(l, from, yearEnd) !== null);
  const draft = input.draft.filter((d) => window(d, from, yearEnd) !== null);
  const diff = planDiff(live, draft);

  // Paare und Einzelne über die Kennungen (Live- und Entwurfs-ids sind verschieden)
  const pairOfLive = new Map<string, { draft: TransferLesson; changes: DiffField[] }>();
  const pairedDraft = new Set<string>();
  for (const e of diff.entries)
    if (e.before && e.after) {
      pairOfLive.set(e.before.id, { draft: e.after as TransferLesson, changes: e.changes });
      pairedDraft.add(e.after.id);
    }

  const sameTiming = (l: TransferLesson, d: TransferLesson) => {
    const a = window(l, from, yearEnd);
    const b = window(d, from, yearEnd);
    return a !== null && b !== null && a.start === b.start && a.end === b.end;
  };

  // Kopplungen als Einheit: Union-Find über Live- und Entwurfsstunden (Paar, gleiche Kopplungs-id je Seite)
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const L = (id: string) => `L:${id}`;
  const D = (id: string) => `D:${id}`;
  for (const l of live) find(L(l.id));
  for (const d of draft) find(D(d.id));
  for (const [lid, p] of pairOfLive) union(L(lid), D(p.draft.id));
  const byCoupling = (rows: readonly TransferLesson[], key: (id: string) => string) => {
    const first = new Map<string, string>();
    for (const r of rows) {
      if (!r.couplingId) continue;
      const f = first.get(r.couplingId);
      if (f) union(key(r.id), f);
      else first.set(r.couplingId, key(r.id));
    }
  };
  byCoupling(live, L);
  byCoupling(draft, D);

  // bleibt eine Stunde für sich unverändert?
  const keepAlone = new Set<string>();
  let changedTiming = 0;
  for (const l of live) {
    const p = pairOfLive.get(l.id);
    if (!p) continue;
    if (p.changes.length === 0 && sameTiming(l, p.draft)) keepAlone.add(l.id);
    else if (p.changes.length === 0) changedTiming++;
  }
  // eine Einheit bleibt nur, wenn jede ihrer Stunden für sich bleibt (keine neue, keine entfallende)
  const broken = new Set<string>();
  for (const l of live) if (!keepAlone.has(l.id)) broken.add(find(L(l.id)));
  for (const d of draft) if (!pairedDraft.has(d.id)) broken.add(find(D(d.id)));
  const kept = live.filter((l) => keepAlone.has(l.id) && !broken.has(find(L(l.id)))).map((l) => l.id);
  const keptSet = new Set(kept);
  const changedWithCoupling = [...keepAlone].filter((id) => !keptSet.has(id)).length;

  // neue Zeilen: geänderte Paare und neue Entwurfsstunden; je Kopplung des Entwurfs eine neue Kopplungs-id
  const couplingIds = new Map<string, string>();
  const predecessorOf = new Map<string, string>();
  for (const [lid, p] of pairOfLive) if (!keptSet.has(lid)) predecessorOf.set(p.draft.id, lid);
  const keptDraft = new Set(kept.map((lid) => pairOfLive.get(lid)!.draft.id));
  const created: CreatedLesson[] = [];
  for (const d of draft) {
    if (keptDraft.has(d.id)) continue;
    const w = window(d, from, yearEnd)!;
    let couplingId: string | null = null;
    if (d.couplingId) {
      if (!couplingIds.has(d.couplingId)) couplingIds.set(d.couplingId, newId());
      couplingId = couplingIds.get(d.couplingId)!;
    }
    created.push({
      id: newId(),
      draftId: d.id,
      predecessorId: predecessorOf.get(d.id) ?? null,
      groupId: d.groupId,
      subjectId: d.subjectId,
      teacherId: d.teacherId,
      roomId: d.roomId,
      weekday: d.weekday,
      periodNr: d.periodNr,
      week: d.week,
      couplingId,
      fixed: d.fixed,
      solverRunId: d.solverRunId,
      validFrom: w.start,
      validUntil: w.end,
    });
  }
  const successor = new Map<string, CreatedLesson>();
  for (const c of created) if (c.predecessorId) successor.set(c.predecessorId, c);

  const dayBefore = addDays(from, -1);
  const ended: TransferPlan["ended"] = [];
  const deleted: string[] = [];
  for (const l of live) {
    if (keptSet.has(l.id)) continue;
    if (l.validFrom >= from) deleted.push(l.id);
    else if (l.validUntil === null || l.validUntil > dayBefore) ended.push({ id: l.id, validUntil: l.validUntil });
  }
  const pairs = pairOfLive.size;
  const counts: Record<DiffKind, number> = {
    unchanged: kept.length,
    changed: pairs - kept.length,
    added: draft.length - pairs,
    removed: live.length - pairs,
  };
  return { from, kept, ended, deleted, created, successor, counts, changedTiming, changedWithCoupling };
}

// ---------------------------------------------------------------- Übertrag (§2.3 Schritt 2)

/** Gilt die (neue) Stunde an diesem Tag – gleicher Wochentag, im Zeitraum, passende A/B-Woche? */
export function holdsOn(l: Pick<TransferLesson, "weekday" | "week" | "validFrom" | "validUntil">, ymd: string): boolean {
  if (weekdayMon0(ymd) !== l.weekday) return false;
  if (ymd < l.validFrom || (l.validUntil !== null && ymd > l.validUntil)) return false;
  return l.week === "all" || l.week === (isoWeek(ymd) % 2 === 1 ? "A" : "B");
}

export interface RefSubstitution {
  id: string;
  lessonId: string;
  date: string;
  kind: "cancel" | "substitute" | "room" | "move" | "merge";
  targetPeriod: number | null;
  mergeLessonId: string | null;
}
export interface RefDated {
  id: string;
  lessonId: string;
  date: string;
}

export interface RefTransfer {
  /** Vertretungen: neue Stunde (`lessonId`) bzw. neue aufnehmende Stunde (`mergeLessonId`), nur geänderte Felder */
  substitutionMoves: { id: string; lessonId?: { from: string; to: string }; mergeLessonId?: { from: string; to: string } }[];
  /** Vertretungen, die nicht umziehen können (Nachfolger findet an dem Tag nicht statt, Stunde entfällt) – gesichert und gelöscht */
  substitutionsRemoved: string[];
  materialMoves: { id: string; from: string; to: string }[];
  materialsRemoved: string[];
  classbookMoves: { id: string; from: string; to: string }[];
  /** Klassenbuch-Einträge ab dem Stichtag ohne Nachfolger – sie bleiben, verlieren aber den Bezug zur Stunde */
  classbookDetached: { id: string; lessonId: string }[];
}

/**
 * Rein (§2.3 Schritt 2): Vertretungen, Material und Klassenbuch-Einträge **ab dem Stichtag** an Stunden, die enden oder entfallen, ziehen
 * auf die Nachfolgerin um, wenn sie an dem Tag stattfindet (`holdsOn`: gleicher Wochentag, Zeitraum, A/B-Woche) – sonst werden Vertretungen
 * und Material gesichert und gelöscht, Klassenbuch-Einträge verlieren den Bezug. Eine Verlegung zieht nur mit, wenn ihre Zielstunde nicht die
 * neue Stunde selbst ist; eine Zusammenlegung nur, wenn beide Stunden (abgebende und aufnehmende) an dem Tag stattfinden und in derselben
 * Stunde liegen. Unveränderte Stunden behalten alles.
 */
export function transferRefs(
  plan: Pick<TransferPlan, "from" | "kept" | "successor"> & { gone: ReadonlySet<string> },
  /** Lage der unveränderten Stunden (für Zusammenlegungen an eine geänderte/unveränderte Stunde) */
  keptLessons: ReadonlyMap<string, Pick<TransferLesson, "periodNr">>,
  refs: { substitutions: readonly RefSubstitution[]; materials: readonly RefDated[]; classbook: readonly RefDated[] },
): RefTransfer {
  const out: RefTransfer = { substitutionMoves: [], substitutionsRemoved: [], materialMoves: [], materialsRemoved: [], classbookMoves: [], classbookDetached: [] };
  /** wo die Stunde an dem Tag nach dem Veröffentlichen liegt: dieselbe (unverändert/nicht betroffen), die Nachfolgerin oder keine */
  const after = (id: string, date: string): { id: string; periodNr: number | null } | null => {
    if (!plan.gone.has(id)) return { id, periodNr: keptLessons.get(id)?.periodNr ?? null };
    const s = plan.successor.get(id);
    return s && holdsOn(s, date) ? { id: s.id, periodNr: s.periodNr } : null;
  };
  for (const s of refs.substitutions) {
    if (s.date < plan.from) continue;
    const touchesLesson = plan.gone.has(s.lessonId);
    const touchesMerge = s.mergeLessonId !== null && plan.gone.has(s.mergeLessonId);
    if (!touchesLesson && !touchesMerge) continue;
    const own = after(s.lessonId, s.date);
    const host = s.mergeLessonId ? after(s.mergeLessonId, s.date) : null;
    let ok = own !== null;
    if (ok && s.kind === "move" && s.targetPeriod !== null && own!.periodNr !== null && s.targetPeriod === own!.periodNr) ok = false;
    if (ok && s.kind === "merge" && s.mergeLessonId) ok = host !== null && (own!.periodNr === null || host.periodNr === null || own!.periodNr === host.periodNr);
    if (!ok) {
      out.substitutionsRemoved.push(s.id);
      continue;
    }
    const move: RefTransfer["substitutionMoves"][number] = { id: s.id };
    if (own!.id !== s.lessonId) move.lessonId = { from: s.lessonId, to: own!.id };
    if (host && s.mergeLessonId && host.id !== s.mergeLessonId) move.mergeLessonId = { from: s.mergeLessonId, to: host.id };
    if (move.lessonId || move.mergeLessonId) out.substitutionMoves.push(move);
  }
  for (const m of refs.materials) {
    if (m.date < plan.from || !plan.gone.has(m.lessonId)) continue;
    const to = after(m.lessonId, m.date);
    if (to) out.materialMoves.push({ id: m.id, from: m.lessonId, to: to.id });
    else out.materialsRemoved.push(m.id);
  }
  for (const c of refs.classbook) {
    if (c.date < plan.from || !plan.gone.has(c.lessonId)) continue;
    const to = after(c.lessonId, c.date);
    if (to) out.classbookMoves.push({ id: c.id, from: c.lessonId, to: to.id });
    else out.classbookDetached.push({ id: c.id, lessonId: c.lessonId });
  }
  return out;
}

// ---------------------------------------------------------------- Änderungsliste je Person (§2.3 Schritt 5)

export const WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr"] as const;

/** Namen für die Änderungsliste (Kürzel statt Namen der Lehrkräfte, wie im Plan). */
export interface ChangeNames {
  groups: ReadonlyMap<string, string>;
  subjects: ReadonlyMap<string, string>;
  teachers: ReadonlyMap<string, string>;
}

/** Eine Änderung für die Änderungsliste (aus dem Diff, ohne „unverändert“). */
export interface ChangeItem {
  kind: Exclude<DiffKind, "unchanged">;
  before: DiffLesson | null;
  after: DiffLesson | null;
  changes: DiffField[];
}

const slotText = (l: DiffLesson) => `${WEEKDAY_SHORT[l.weekday] ?? "?"} ${l.periodNr}. Std${l.week !== "all" ? ` (${l.week}-Woche)` : ""}`;

/**
 * Rein: eine Zeile der Änderungsliste – „Mo 3. Std Mathematik (7b): Raum 106 → 105“, „neu: Di 2. Std Englisch (7b) · BRA · R 105“,
 * „entfällt: Fr 6. Std Sport (7b)“. Lehrkräfte als Kürzel (wie im Plan), Räume als Kennung.
 */
export function changeLine(c: ChangeItem, n: ChangeNames): string {
  const what = (l: DiffLesson) => `${n.subjects.get(l.subjectId) ?? l.subjectId} (${n.groups.get(l.groupId) ?? "?"})`;
  const who = (id: string | null) => (id ? (n.teachers.get(id) ?? "?") : "ohne Lehrkraft");
  if (c.kind === "added") {
    const a = c.after!;
    return `neu: ${slotText(a)} ${what(a)} · ${who(a.teacherId)}${a.roomId ? ` · R ${a.roomId}` : ""}`;
  }
  if (c.kind === "removed") return `entfällt: ${slotText(c.before!)} ${what(c.before!)}`;
  const a = c.before!;
  const b = c.after!;
  const parts: string[] = [];
  if (c.changes.includes("slot") || c.changes.includes("week")) parts.push(`${slotText(a)} → ${slotText(b)}`);
  if (c.changes.includes("subject")) parts.push(`Fach ${n.subjects.get(a.subjectId) ?? a.subjectId} → ${n.subjects.get(b.subjectId) ?? b.subjectId}`);
  if (c.changes.includes("teacher")) parts.push(`Lehrkraft ${who(a.teacherId)} → ${who(b.teacherId)}`);
  if (c.changes.includes("room")) parts.push(`Raum ${a.roomId ?? "–"} → ${b.roomId ?? "–"}`);
  if (c.changes.includes("group")) parts.push(`Gruppe ${n.groups.get(a.groupId) ?? "?"} → ${n.groups.get(b.groupId) ?? "?"}`);
  if (c.changes.includes("coupling") && parts.length === 0) parts.push("andere Kopplung");
  return `${slotText(a)} ${what(a)}: ${parts.join("; ")}`;
}

/**
 * Rein: Änderungslisten je Lehrkraft (vorher und nachher beteiligt) und je Klasse/Kurs aus dem Diff – „Kein Gong für Unveränderte“ (§2.3):
 * Paare ohne sichtbare Änderung (nur Zeitraum oder Kopplungs-id) fehlen. Zeilen je Person sortiert nach Tag/Stunde, ohne Doppel.
 */
export function changeLists(items: readonly ChangeItem[], n: ChangeNames): { byTeacher: Map<string, string[]>; byGroup: Map<string, string[]> } {
  const byTeacher = new Map<string, string[]>();
  const byGroup = new Map<string, string[]>();
  const at = (c: ChangeItem) => (c.before ?? c.after)!;
  const sorted = [...items].sort((x, y) => at(x).weekday - at(y).weekday || at(x).periodNr - at(y).periodNr);
  const add = (m: Map<string, string[]>, k: string | null | undefined, line: string) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.includes(line)) list.push(line);
    m.set(k, list);
  };
  for (const c of sorted) {
    const line = changeLine(c, n);
    add(byTeacher, c.before?.teacherId, line);
    add(byTeacher, c.after?.teacherId, line);
    add(byGroup, c.before?.groupId, line);
    add(byGroup, c.after?.groupId, line);
  }
  return { byTeacher, byGroup };
}

/** Rein: Nachricht der Änderungsliste – Titel mit Stichtag und Zahl, je Änderung eine Zeile. */
export function planMessage(validFromLabel: string, versionLabel: string, lines: readonly string[]): { title: string; body: string } {
  const title = `Neuer Stundenplan ab ${validFromLabel}: ${lines.length === 1 ? "1 Änderung" : `${lines.length} Änderungen`} für dich`;
  const shown = lines.slice(0, 12);
  const more = lines.length - shown.length;
  return { title, body: `Version ${versionLabel}. ${shown.join(" · ")}${more > 0 ? ` · … und ${more} weitere – siehe Stundenplan` : ""}` };
}
