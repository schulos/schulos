// Losverfahren bei Anmeldeüberhang (LO-01, docs/LOSVERFAHREN.md). Hebt Q-34 („kein Los in V1“) für ein eigenes, protokolliertes
// Werkzeug auf: Die Schulleitung (`anmeldung.decide`) bildet aus offenen Anträgen, die nach den übrigen Kriterien gleichrangig
// sind, eine Losgruppe für N Plätze – SchulOS bewertet keine Kriterien. Ablauf:
//   vorbereiten → Seed (128 Bit) entsteht, angezeigt wird nur sein SHA-256 (Commit-Reveal, Zeug:innen sehen den Hash vorab)
//   ziehen      → Seed wird aufgedeckt, Reihenfolge = lotOrder(seed, Vorgangsnummern) – mit jedem Werkzeug nachrechenbar
//   übernehmen  → Rang 1…N „aufgenommen“, Rest „Warteliste“ mit Rang, über die bestehende Entscheidung (Mail wie dort)
//   neu losen   → nur nach dem Ziehen und nur mit Pflicht-Begründung; der alte Lauf bleibt als „verworfen“ sichtbar
// Gespeichert werden nur Antrags-IDs/-nummern, Seed und Zeug:innen-Funktionen; Namen nur in Anzeige und Druck aus den Anträgen.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungLose, anmeldungVerfahren } from "@/core/db/schema";
import { lotOrder } from "@/core/los";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { decide } from "./entscheidung";
import { ANTRAG_STATUS_LABELS, type AntragStatus, type LosStatus } from "./labels";
import { antragNumber, canDecide, canView, OPEN_STATUSES } from "./service";

/** Höchstens so viele Anträge in einer Losgruppe. */
export const LOT_MAX = 500;
/** Länge von Zeug:innen-Funktionen und Begründung */
export const WITNESSES_MAX = 300;
export const REASON_MAX = 500;

export interface LotParticipant {
  id: string;
  number: string;
}

export interface LotOutcome {
  number: string;
  /** Rang im Los (1 = zuerst gezogen) */
  rank: number;
  outcome: "aufgenommen" | "warteliste";
  /** Rang auf der Warteliste (nur bei „warteliste“) */
  waitlistRank: number | null;
}

// ---------------------------------------------------------------- rein

/** Neuer Seed: 128 Bit Zufall als Hex (aus dem Zufallsgenerator des Betriebssystems). */
export const newSeed = () => randomBytes(16).toString("hex");
/** SHA-256 (hex) des Seeds – wird vor dem Ziehen angezeigt. */
export const seedHashOf = (seed: string) => createHash("sha256").update(seed, "utf8").digest("hex");

/** Rein: Ergebnis aus der gezogenen Reihenfolge – Rang 1…N aufgenommen, der Rest Warteliste mit Rang 1, 2 … */
export function lotOutcome(order: readonly string[], places: number): LotOutcome[] {
  return order.map((number, i) => ({
    number,
    rank: i + 1,
    outcome: i < places ? "aufgenommen" : "warteliste",
    waitlistRank: i < places ? null : i - places + 1,
  }));
}

/** Rein: prüft ein Protokoll nach – passt der Seed zum Hash und ergibt er genau diese Reihenfolge? */
export function verifyLot(lot: { seed: string; seedHash: string; numbers: readonly string[]; order: readonly string[] }): { hashOk: boolean; orderOk: boolean } {
  const recomputed = lotOrder(lot.seed, lot.numbers);
  return { hashOk: seedHashOf(lot.seed) === lot.seedHash, orderOk: recomputed.length === lot.order.length && recomputed.every((n, i) => n === lot.order[i]) };
}

// ---------------------------------------------------------------- Lesen

export interface LotView {
  id: string;
  verfahrenId: string;
  seq: number;
  status: LosStatus;
  places: number;
  participants: LotParticipant[];
  seedHash: string;
  /** nur nach dem Ziehen (sonst null – der Seed bleibt bis dahin geheim) */
  seed: string | null;
  order: string[] | null;
  witnesses: string | null;
  reason: string | null;
  replacesId: string | null;
  preparedAt: Date;
  drawnAt: Date | null;
  appliedAt: Date | null;
  discardedAt: Date | null;
}

type LotRow = typeof anmeldungLose.$inferSelect;

function toView(r: LotRow): LotView {
  const drawn = r.drawnAt !== null;
  return {
    id: r.id,
    verfahrenId: r.verfahrenId,
    seq: r.seq,
    status: r.status,
    places: r.places,
    participants: r.participants as LotParticipant[],
    seedHash: r.seedHash,
    seed: drawn ? r.seed : null,
    order: drawn ? (r.drawOrder as string[] | null) : null,
    witnesses: r.witnesses,
    reason: r.reason,
    replacesId: r.replacesId,
    preparedAt: r.preparedAt,
    drawnAt: r.drawnAt,
    appliedAt: r.appliedAt,
    discardedAt: r.discardedAt,
  };
}

/** Läufe eines Verfahrens, neueste zuerst (lesen mit `anmeldung.view`). */
export async function listLots(db: Db, viewer: PermissionSet, verfahrenId: string): Promise<LotView[]> {
  if (!canView(viewer)) throw new ForbiddenError("anmeldung.view");
  const rows = await db.select().from(anmeldungLose).where(eq(anmeldungLose.verfahrenId, verfahrenId)).orderBy(desc(anmeldungLose.seq));
  return rows.map(toView);
}

export interface LotDetailRow {
  number: string;
  antragId: string;
  /** null = Antrag inzwischen gelöscht (nur noch die Nummer im Protokoll) */
  child: string | null;
  status: AntragStatus | null;
  waitlistRank: number | null;
  outcome: LotOutcome | null;
}

/** Ein Lauf mit Teilnehmenden (Namen aus den noch vorhandenen Anträgen) und – nach dem Ziehen – dem Ergebnis. */
export async function getLot(db: Db, viewer: PermissionSet, lotId: string): Promise<{ lot: LotView; verfahrenName: string; rows: LotDetailRow[]; verify: { hashOk: boolean; orderOk: boolean } | null } | null> {
  if (!canView(viewer)) throw new ForbiddenError("anmeldung.view");
  const [r] = await db
    .select({ l: anmeldungLose, verfahrenName: anmeldungVerfahren.name })
    .from(anmeldungLose)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungLose.verfahrenId))
    .where(eq(anmeldungLose.id, lotId));
  if (!r) return null;
  const lot = toView(r.l);
  const ids = lot.participants.map((p) => p.id);
  const antraege = ids.length
    ? await db
        .select({
          id: anmeldungAntraege.id,
          first: anmeldungAntraege.childFirstName,
          last: anmeldungAntraege.childLastName,
          status: anmeldungAntraege.status,
          waitlistRank: anmeldungAntraege.waitlistRank,
        })
        .from(anmeldungAntraege)
        .where(inArray(anmeldungAntraege.id, ids))
    : [];
  const byId = new Map(antraege.map((a) => [a.id, a]));
  const outcomes = lot.order ? new Map(lotOutcome(lot.order, lot.places).map((o) => [o.number, o])) : null;
  const numbers = lot.order ?? lot.participants.map((p) => p.number);
  const byNumber = new Map(lot.participants.map((p) => [p.number, p]));
  const rows = numbers.map((number) => {
    const p = byNumber.get(number)!;
    const a = byId.get(p.id);
    return {
      number,
      antragId: p.id,
      child: a ? `${a.last}, ${a.first}` : null,
      status: a?.status ?? null,
      waitlistRank: a?.waitlistRank ?? null,
      outcome: outcomes?.get(number) ?? null,
    };
  });
  const verify =
    lot.seed && lot.order ? verifyLot({ seed: lot.seed, seedHash: lot.seedHash, numbers: lot.participants.map((p) => p.number), order: lot.order }) : null;
  return { lot, verfahrenName: r.verfahrenName, rows, verify };
}

// ---------------------------------------------------------------- Schreiben

function assertDecide(viewer: PermissionSet) {
  if (!canDecide(viewer)) throw new ForbiddenError("anmeldung.decide");
}

const listNumbers = (ns: readonly string[]) => `${ns.slice(0, 5).join(", ")}${ns.length > 5 ? " …" : ""}`;

/** Prüft, dass alle Anträge noch offen sind (sonst: Lauf verwerfen und neu bilden). */
async function assertStillOpen(db: Db, participants: readonly LotParticipant[]) {
  const rows = await db.select({ id: anmeldungAntraege.id, status: anmeldungAntraege.status }).from(anmeldungAntraege).where(inArray(anmeldungAntraege.id, participants.map((p) => p.id)));
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const changed = participants.filter((p) => !(OPEN_STATUSES as readonly string[]).includes(status.get(p.id) ?? ""));
  if (changed.length)
    throw new ValidationError({
      los: `Nicht mehr offen: ${listNumbers(changed.map((p) => `${p.number} (${status.has(p.id) ? ANTRAG_STATUS_LABELS[status.get(p.id)!] : "gelöscht"})`))} – bitte den Lauf verwerfen und die Losgruppe neu bilden`,
    });
}

async function loadVerfahrenForLot(db: Db, verfahrenId: string, lock = false) {
  const q = db.select({ id: anmeldungVerfahren.id, status: anmeldungVerfahren.status }).from(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, verfahrenId));
  const [v] = lock ? await q.for("update") : await q;
  if (!v) throw new ValidationError({ verfahren: "Verfahren gibt es nicht" });
  if (v.status === "abgeschlossen") throw new ValidationError({ verfahren: "Das Verfahren ist abgeschlossen – kein Losverfahren mehr" });
  if (v.status === "entwurf") throw new ValidationError({ verfahren: "Das Verfahren ist noch ein Entwurf" });
  return v;
}

/**
 * Los vorbereiten: Losgruppe aus offenen Anträgen desselben Verfahrens für `places` Plätze (1 ≤ N < Teilnehmende). Der Seed
 * entsteht jetzt und bleibt bis zum Ziehen geheim; zurück kommt der Lauf mit Seed-Hash. Ein Antrag steht höchstens in einem
 * offenen Lauf (vorbereitet oder gezogen, nicht übernommen) – so kann niemand zwei Läufe für dieselbe Gruppe parallel halten.
 */
export async function prepareLot(
  db: Db,
  viewer: PermissionSet,
  verfahrenId: string,
  input: { antragIds: readonly string[]; places: number | string },
  opts: { now?: Date; replacesId?: string | null; reason?: string | null } = {},
): Promise<LotView> {
  assertDecide(viewer);
  const now = opts.now ?? new Date();
  const ids = [...new Set(input.antragIds.map((i) => String(i).trim()).filter(Boolean))];
  if (ids.length < 2) throw new ValidationError({ antraege: "Für ein Los mindestens zwei offene Anträge auswählen" });
  if (ids.length > LOT_MAX) throw new ValidationError({ antraege: `Höchstens ${LOT_MAX} Anträge in einer Losgruppe` });
  const places = typeof input.places === "number" ? input.places : Number(String(input.places).trim());
  if (!Number.isInteger(places) || places < 1) throw new ValidationError({ places: "Plätze: eine ganze Zahl ab 1" });
  if (places >= ids.length) throw new ValidationError({ places: `Für ${ids.length} Anträge reichen ${places} Plätze – kein Los nötig (Plätze müssen weniger sein als Anträge)` });
  const seed = newSeed();
  const created = await db.transaction(async (tx) => {
    // Sperre auf dem Verfahren: Läufe eines Verfahrens entstehen nacheinander (laufende Nummer, „ein offener Lauf je Antrag“)
    await loadVerfahrenForLot(tx, verfahrenId, true);
    const rows = await tx
      .select({ id: anmeldungAntraege.id, year: anmeldungAntraege.year, seq: anmeldungAntraege.seq, status: anmeldungAntraege.status })
      .from(anmeldungAntraege)
      .where(and(inArray(anmeldungAntraege.id, ids), eq(anmeldungAntraege.verfahrenId, verfahrenId)));
    if (rows.length !== ids.length) throw new ValidationError({ antraege: "Mindestens ein Antrag gehört nicht zu diesem Verfahren" });
    const blocked = rows.filter((a) => !(OPEN_STATUSES as readonly string[]).includes(a.status));
    if (blocked.length)
      throw new ValidationError({
        antraege: `Nur offene Anträge (ohne Entscheidung) können gelost werden – nicht ${listNumbers(blocked.map((a) => `${antragNumber(a.year, a.seq)} (${ANTRAG_STATUS_LABELS[a.status]})`))}`,
      });
    const open = await tx
      .select({ seq: anmeldungLose.seq, participants: anmeldungLose.participants })
      .from(anmeldungLose)
      .where(and(eq(anmeldungLose.verfahrenId, verfahrenId), inArray(anmeldungLose.status, ["vorbereitet", "gezogen"])));
    const busy = new Map<string, number>();
    for (const l of open) for (const p of l.participants as LotParticipant[]) busy.set(p.id, l.seq);
    const inOther = rows.filter((a) => busy.has(a.id));
    if (inOther.length)
      throw new ValidationError({
        antraege: `Schon in einem offenen Lauf: ${listNumbers(inOther.map((a) => `${antragNumber(a.year, a.seq)} (Lauf ${busy.get(a.id)})`))} – den Lauf erst übernehmen oder verwerfen`,
      });
    // Teilnehmende nach Vorgangsnummer – unabhängig von der Klickreihenfolge (die Reihenfolge bestimmt allein das Los)
    const participants: LotParticipant[] = rows
      .map((a) => ({ id: a.id, number: antragNumber(a.year, a.seq) }))
      .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    const [last] = await tx.select({ n: max(anmeldungLose.seq) }).from(anmeldungLose).where(eq(anmeldungLose.verfahrenId, verfahrenId));
    const [lot] = await tx
      .insert(anmeldungLose)
      .values({
        verfahrenId,
        seq: (last?.n ?? 0) + 1,
        places,
        participants,
        seed,
        seedHash: seedHashOf(seed),
        replacesId: opts.replacesId ?? null,
        reason: opts.reason ?? null,
        preparedBy: viewer.userId,
        preparedAt: now,
      })
      .returning();
    await audit(tx, viewer.userId, "anmeldung.los.vorbereiten", lot!.id, { verfahren: verfahrenId, lauf: lot!.seq, teilnehmende: participants.length, plaetze: places, ...(opts.replacesId ? { ersetzt: opts.replacesId } : {}) });
    return lot!;
  });
  return toView(created);
}

/** Lauf laden und Verfahren prüfen (offen bzw. geschlossen). */
async function loadLot(db: Db, lotId: string, lock = false): Promise<LotRow> {
  const q = db.select().from(anmeldungLose).where(eq(anmeldungLose.id, lotId));
  const [l] = lock ? await q.for("update") : await q;
  if (!l) throw new ValidationError({ los: "Diesen Lauf gibt es nicht" });
  return l;
}

const trimText = (s: string | null | undefined, maxLen: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen) || null;

/**
 * Los ziehen: deckt den Seed auf und speichert die Reihenfolge (`lotOrder` über die Vorgangsnummern). Zeug:innen nur als
 * Funktionen (keine Namen). Nur aus „vorbereitet“, nur solange alle Anträge noch offen sind; das Ziehen ist endgültig.
 */
export async function drawLot(db: Db, viewer: PermissionSet, lotId: string, input: { witnesses?: string | null } = {}, now = new Date()): Promise<LotView> {
  assertDecide(viewer);
  const witnesses = trimText(input.witnesses, WITNESSES_MAX);
  const drawn = await db.transaction(async (tx) => {
    const l = await loadLot(tx, lotId, true);
    if (l.status !== "vorbereitet") throw new ValidationError({ los: "Dieser Lauf ist schon gezogen oder verworfen" });
    await loadVerfahrenForLot(tx, l.verfahrenId);
    const participants = l.participants as LotParticipant[];
    await assertStillOpen(tx, participants);
    const order = lotOrder(l.seed, participants.map((p) => p.number));
    const [done] = await tx
      .update(anmeldungLose)
      .set({ status: "gezogen", drawOrder: order, witnesses, drawnBy: viewer.userId, drawnAt: now })
      .where(and(eq(anmeldungLose.id, lotId), eq(anmeldungLose.status, "vorbereitet")))
      .returning();
    if (!done) throw new ValidationError({ los: "Dieser Lauf wurde inzwischen geändert – bitte neu laden" });
    await audit(tx, viewer.userId, "anmeldung.los.ziehen", lotId, { verfahren: l.verfahrenId, lauf: l.seq, teilnehmende: participants.length, plaetze: l.places, zeugen: Boolean(witnesses) });
    return done;
  });
  return toView(drawn);
}

/**
 * Ergebnis übernehmen: Rang 1…N „aufgenommen“, der Rest „Warteliste“ mit Rang – über die bestehende Entscheidung (`decide`:
 * Recht, Statusmaschine, Verlauf, Mail „Bescheid folgt per Post“ bei der ersten Entscheidung). Alles oder nichts (eine
 * Transaktion); ändert sich ein Antrag inzwischen, bleibt alles, wie es war.
 */
export async function applyLot(
  db: Db,
  viewer: PermissionSet,
  lotId: string,
  ctx: { school: string; now?: Date },
): Promise<{ admitted: number; waitlisted: number; mails: number }> {
  assertDecide(viewer);
  const now = ctx.now ?? new Date();
  return db.transaction(async (tx) => {
    const l = await loadLot(tx, lotId, true);
    if (l.status !== "gezogen") throw new ValidationError({ los: l.status === "uebernommen" ? "Das Ergebnis ist schon übernommen" : "Erst das Los ziehen" });
    await loadVerfahrenForLot(tx, l.verfahrenId);
    const participants = l.participants as LotParticipant[];
    await assertStillOpen(tx, participants);
    const idOf = new Map(participants.map((p) => [p.number, p.id]));
    const outcomes = lotOutcome(l.drawOrder as string[], l.places);
    let mails = 0;
    for (const o of outcomes) {
      const antragId = idOf.get(o.number)!;
      const note = `Losverfahren Lauf ${l.seq}: Rang ${o.rank} von ${outcomes.length}${o.waitlistRank ? `, Wartelisten-Rang ${o.waitlistRank}` : ""}`;
      const r = await decide(tx, viewer, l.verfahrenId, [antragId], o.outcome, { school: ctx.school, note, now });
      mails += r.mails;
      if (o.waitlistRank) await tx.update(anmeldungAntraege).set({ waitlistRank: o.waitlistRank }).where(eq(anmeldungAntraege.id, antragId));
      await tx.insert(anmeldungEreignisse).values({ antragId, actorId: viewer.userId, kind: "notiz", text: note, at: now });
    }
    const [done] = await tx
      .update(anmeldungLose)
      .set({ status: "uebernommen", appliedBy: viewer.userId, appliedAt: now })
      .where(and(eq(anmeldungLose.id, lotId), eq(anmeldungLose.status, "gezogen")))
      .returning({ id: anmeldungLose.id });
    if (!done) throw new ValidationError({ los: "Dieser Lauf wurde inzwischen geändert – bitte neu laden" });
    const admitted = outcomes.filter((o) => o.outcome === "aufgenommen").length;
    await audit(tx, viewer.userId, "anmeldung.los.uebernehmen", lotId, { verfahren: l.verfahrenId, lauf: l.seq, aufgenommen: admitted, warteliste: outcomes.length - admitted });
    return { admitted, waitlisted: outcomes.length - admitted, mails };
  });
}

/**
 * Lauf verwerfen. Vorbereitet (Seed noch geheim, nichts gezogen): Begründung freiwillig. Gezogen: nur mit Begründung – der
 * Lauf bleibt mit Seed, Reihenfolge und Begründung im Protokoll sichtbar. Übernommene Läufe lassen sich nicht verwerfen
 * (Korrekturen laufen über die normale Entscheidung).
 */
export async function discardLot(db: Db, viewer: PermissionSet, lotId: string, reasonRaw: string | null, now = new Date()): Promise<LotRow> {
  assertDecide(viewer);
  const reason = trimText(reasonRaw, REASON_MAX);
  return db.transaction(async (tx) => {
    const l = await loadLot(tx, lotId, true);
    if (l.status === "uebernommen") throw new ValidationError({ los: "Ein übernommener Lauf bleibt – Korrekturen über die Entscheidung je Antrag" });
    if (l.status === "verworfen") throw new ValidationError({ los: "Dieser Lauf ist schon verworfen" });
    if (l.status === "gezogen" && !reason) throw new ValidationError({ reason: "Nach dem Ziehen nur mit Begründung" });
    const [done] = await tx
      .update(anmeldungLose)
      .set({ status: "verworfen", reason: reason ?? l.reason, discardedBy: viewer.userId, discardedAt: now })
      .where(and(eq(anmeldungLose.id, lotId), eq(anmeldungLose.status, l.status)))
      .returning();
    if (!done) throw new ValidationError({ los: "Dieser Lauf wurde inzwischen geändert – bitte neu laden" });
    await audit(tx, viewer.userId, "anmeldung.los.verwerfen", lotId, { verfahren: l.verfahrenId, lauf: l.seq, gezogen: l.status === "gezogen" });
    return done;
  });
}

/**
 * Neu losen: nur nach dem Ziehen (vor der Übernahme) und nur mit Pflicht-Begründung. Der alte Lauf wird mit Begründung
 * verworfen und bleibt sichtbar; der neue Lauf hat dieselbe Gruppe und Platzzahl, einen neuen Seed und verweist auf den alten.
 * Eine andere Gruppe: Lauf verwerfen und aus der Entscheidungsliste neu bilden.
 */
export async function repeatLot(db: Db, viewer: PermissionSet, lotId: string, reasonRaw: string | null, now = new Date()): Promise<LotView> {
  assertDecide(viewer);
  const reason = trimText(reasonRaw, REASON_MAX);
  if (!reason) throw new ValidationError({ reason: "Neu losen nur mit Begründung" });
  const l = await loadLot(db, lotId);
  if (l.status !== "gezogen") throw new ValidationError({ los: "Neu losen geht nur nach dem Ziehen und vor der Übernahme" });
  return db.transaction(async (tx) => {
    await discardLot(tx, viewer, lotId, reason, now);
    const participants = l.participants as LotParticipant[];
    const next = await prepareLot(tx, viewer, l.verfahrenId, { antragIds: participants.map((p) => p.id), places: l.places }, { now, replacesId: l.id, reason });
    await audit(tx, viewer.userId, "anmeldung.los.wiederholen", next.id, { verfahren: l.verfahrenId, lauf: next.seq, ersetzt: l.seq });
    return next;
  });
}

/** Läufe, in denen ein Antrag vorkommt (Auskunft, Antragsseite) – nur Lauf-Nummer, Stand und Ergebnis. */
export async function lotsOfAntrag(db: Db, verfahrenId: string, antragId: string): Promise<{ seq: number; status: LosStatus; rank: number | null; total: number }[]> {
  const rows = await db.select().from(anmeldungLose).where(eq(anmeldungLose.verfahrenId, verfahrenId)).orderBy(asc(anmeldungLose.seq));
  return rows
    .map((r) => ({ r, p: (r.participants as LotParticipant[]).find((p) => p.id === antragId) }))
    .filter((x) => x.p)
    .map(({ r, p }) => {
      const order = r.drawnAt ? (r.drawOrder as string[] | null) : null;
      const i = order ? order.indexOf(p!.number) : -1;
      return { seq: r.seq, status: r.status, rank: i >= 0 ? i + 1 : null, total: (r.participants as LotParticipant[]).length };
    });
}
