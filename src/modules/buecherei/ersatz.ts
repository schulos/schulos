// Schulbücherei Stufe 2 – Ersatzforderungen (BU-12, docs/BUECHEREI.md, Entscheidung 6): Betrag und Grund für Schaden oder
// Verlust erfassen, Status offen/bezahlt/erlassen vermerken, Brief an die Eltern (bzw. die volljährige Person) drucken – keine
// Zahlungsabwicklung, keine Säumnisgebühren. Ausgangspunkt sind Rückgaben mit Befund (Stufe 1), Schulbuch-Rücknahmen mit
// Befund und nicht zurückgegebene Schulbücher (Verlust). Nur mit Schalter `buecherei.lernmittel` und Recht `buecherei.materials`.
// Mit dem Abschluss (bezahlt/erlassen) ist der Befund erledigt – beide gehen dann nach LK-SJ-1J.
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  buechereiCompensations,
  buechereiCopies,
  buechereiLoans,
  buechereiMaterialCopies,
  buechereiMaterialIssues,
  buechereiTeachingMaterials,
  buechereiTitles,
  users,
} from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { childrenOf, parentLinks } from "@/core/school/majority";
import { ValidationError } from "@/modules/verwaltung/users";
import { COMPENSATION_STATUSES, parseEuro, type CompensationStatus } from "./labels";
import { canMaterials, lernmittelEnabled } from "./lernmittel";
import { classNamesOf } from "./loans";

export const MAX_COMPENSATION_REASON = 200;
/** Grund bei einem nicht zurückgegebenen Schulbuch (Verlust), wenn nichts anderes eingetragen ist. */
export const LOSS_REASON = "nicht zurückgegeben (Verlust)";

async function requireComp(db: Db, p: PermissionSet) {
  if (!canMaterials(p)) throw new ForbiddenError("buecherei.materials");
  if (!(await lernmittelEnabled(db))) throw new ValidationError({ amount: "Die Schulbuchausleihe ist ausgeschaltet (Verwaltung → Rechte & Module → Bücherei)" });
}

const noComp = (col: "loan_id" | "issue_id", idSql: ReturnType<typeof sql>) => sql`not exists (select 1 from buecherei_compensations c where c.${sql.raw(col)} = ${idSql})`;

// ---------------------------------------------------------------- Zu klären

export interface CompensationCandidate {
  kind: "ausleihe" | "schulbuch" | "verlust";
  /** Ausleihe- bzw. Ausgabe-ID */
  id: string;
  item: string;
  reason: string;
  /** Vorschlag: Preis des Lernmittels (Bücherei ohne Preis) */
  suggestedCents: number | null;
  since: string;
  userId: string | null;
  name: string | null;
  className: string | null;
}

/**
 * Was eine Ersatzforderung brauchen könnte: offene Befunde aus Bücherei und Schulbuchausleihe ohne Forderung sowie Schulbücher,
 * deren Rückgabefrist abgelaufen ist (Verlust). Mit Name und Klasse (nur `buecherei.materials`).
 */
export async function compensationCandidates(db: Db, viewer: PermissionSet, today: string): Promise<CompensationCandidate[]> {
  await requireComp(db, viewer);
  const [loans, findings, lost] = await Promise.all([
    db
      .select({ id: buechereiLoans.id, title: buechereiTitles.title, nr: buechereiCopies.barcode, reason: buechereiLoans.finding, since: buechereiLoans.returnedOn, userId: buechereiLoans.userId, name: users.name })
      .from(buechereiLoans)
      .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
      .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
      .leftJoin(users, eq(users.id, buechereiLoans.userId))
      .where(and(isNotNull(buechereiLoans.returnedOn), isNull(buechereiLoans.findingResolvedOn), noComp("loan_id", sql`${buechereiLoans.id}`)))
      .orderBy(asc(buechereiLoans.returnedOn)),
    issueRows(db, and(isNotNull(buechereiMaterialIssues.returnedOn), isNull(buechereiMaterialIssues.findingResolvedOn))),
    issueRows(db, and(isNull(buechereiMaterialIssues.returnedOn), lt(buechereiMaterialIssues.dueOn, today))),
  ]);
  const cls = await classNamesOf(db, [...loans, ...findings, ...lost].map((r) => r.userId).filter((x): x is string => !!x));
  const person = (r: { userId: string | null; name: string | null }) => ({ userId: r.userId, name: r.name, className: r.userId ? (cls.get(r.userId) ?? null) : null });
  return [
    ...loans.map((r) => ({ kind: "ausleihe" as const, id: r.id, item: `${r.title} (${r.nr})`, reason: r.reason ?? "", suggestedCents: null, since: r.since!, ...person(r) })),
    ...findings.map((r) => ({ kind: "schulbuch" as const, id: r.id, item: `${r.title} (${r.nr})`, reason: r.finding ?? "", suggestedCents: r.price, since: r.returnedOn!, ...person(r) })),
    ...lost.map((r) => ({ kind: "verlust" as const, id: r.id, item: `${r.title} (${r.nr})`, reason: LOSS_REASON, suggestedCents: r.price, since: r.dueOn, ...person(r) })),
  ];
}

function issueRows(db: Db, where: ReturnType<typeof and>) {
  return db
    .select({
      id: buechereiMaterialIssues.id,
      title: buechereiTeachingMaterials.title,
      nr: buechereiMaterialCopies.inventoryNumber,
      price: buechereiTeachingMaterials.priceCents,
      finding: buechereiMaterialIssues.finding,
      returnedOn: buechereiMaterialIssues.returnedOn,
      dueOn: buechereiMaterialIssues.dueOn,
      copyId: buechereiMaterialIssues.copyId,
      userId: buechereiMaterialIssues.userId,
      name: users.name,
    })
    .from(buechereiMaterialIssues)
    .innerJoin(buechereiMaterialCopies, eq(buechereiMaterialCopies.id, buechereiMaterialIssues.copyId))
    .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
    .leftJoin(users, eq(users.id, buechereiMaterialIssues.userId))
    .where(and(where, noComp("issue_id", sql`${buechereiMaterialIssues.id}`)))
    .orderBy(asc(buechereiMaterialIssues.dueOn), asc(buechereiMaterialCopies.seq));
}

// ---------------------------------------------------------------- Anlegen und Status

export interface CompensationInput {
  amount: string;
  reason?: string | null;
}

function validate(input: CompensationInput, fallbackReason: string) {
  const fe: Record<string, string> = {};
  const cents = parseEuro(input.amount);
  if (cents === null || cents === "bad" || cents < 1) fe.amount = "Betrag in Euro, z. B. 24,50";
  const reason = (input.reason?.trim() || fallbackReason).trim();
  if (reason.length < 2 || reason.length > MAX_COMPENSATION_REASON) fe.reason = `Grund mit 2 bis ${MAX_COMPENSATION_REASON} Zeichen (nur die Sache, keine Namen)`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { amountCents: cents as number, reason };
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/**
 * Ersatzforderung anlegen – aus einem Befund der Bücherei (`loanId`), einer Schulbuch-Rücknahme mit Befund oder einem nicht
 * zurückgegebenen Schulbuch (`issueId`). Beim Verlust wird die Ausgabe als „zurück mit Befund“ abgeschlossen (die Mahnung endet)
 * und das Exemplar ausgesondert. Je Befund höchstens eine Forderung.
 */
export async function createCompensation(db: Db, viewer: PermissionSet, src: { loanId: string } | { issueId: string }, input: CompensationInput, today: string): Promise<string> {
  await requireComp(db, viewer);
  let row: { userId: string | null; item: string; reason: string; loanId?: string; issueId?: string; lossCopyId?: string };
  if ("loanId" in src) {
    const [l] = await db
      .select({ userId: buechereiLoans.userId, title: buechereiTitles.title, nr: buechereiCopies.barcode, finding: buechereiLoans.finding })
      .from(buechereiLoans)
      .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
      .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
      .where(and(eq(buechereiLoans.id, src.loanId), isNotNull(buechereiLoans.returnedOn), isNull(buechereiLoans.findingResolvedOn)));
    if (!l) throw new ValidationError({ amount: "Befund gibt es nicht oder ist schon erledigt" });
    row = { userId: l.userId, item: `${l.title} (${l.nr})`, reason: l.finding ?? "", loanId: src.loanId };
  } else {
    const [i] = await db
      .select({
        userId: buechereiMaterialIssues.userId,
        title: buechereiTeachingMaterials.title,
        nr: buechereiMaterialCopies.inventoryNumber,
        finding: buechereiMaterialIssues.finding,
        returnedOn: buechereiMaterialIssues.returnedOn,
        resolved: buechereiMaterialIssues.findingResolvedOn,
        copyId: buechereiMaterialIssues.copyId,
      })
      .from(buechereiMaterialIssues)
      .innerJoin(buechereiMaterialCopies, eq(buechereiMaterialCopies.id, buechereiMaterialIssues.copyId))
      .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
      .where(eq(buechereiMaterialIssues.id, src.issueId));
    if (!i || i.resolved) throw new ValidationError({ amount: "Ausgabe gibt es nicht oder ist schon erledigt" });
    row = { userId: i.userId, item: `${i.title} (${i.nr})`, reason: i.returnedOn ? (i.finding ?? "") : LOSS_REASON, issueId: src.issueId, ...(i.returnedOn ? {} : { lossCopyId: i.copyId }) };
  }
  const v = validate(input, row.reason);
  let id: string;
  try {
    id = await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [c] = await tx
        .insert(buechereiCompensations)
        .values({ userId: row.userId, loanId: row.loanId ?? null, issueId: row.issueId ?? null, item: row.item, reason: v.reason, amountCents: v.amountCents, createdOn: today })
        .returning({ id: buechereiCompensations.id });
      if (row.lossCopyId) {
        // Verlust: Ausgabe abschließen (Mahnung endet, Befund bleibt bis zur Erledigung), Exemplar aussondern
        const [done] = await tx
          .update(buechereiMaterialIssues)
          .set({ returnedOn: today, finding: v.reason, dunningLevel: 0, dunnedOn: null })
          .where(and(eq(buechereiMaterialIssues.id, row.issueId!), isNull(buechereiMaterialIssues.returnedOn)))
          .returning({ id: buechereiMaterialIssues.id });
        if (!done) throw new ValidationError({ amount: "Schulbuch wurde gerade zurückgenommen – bitte neu laden" });
        await tx.update(buechereiMaterialCopies).set({ withdrawnOn: today, withdrawnReason: "verloren (Ersatzforderung)" }).where(eq(buechereiMaterialCopies.id, row.lossCopyId));
      }
      return c!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError({ amount: "Für diesen Befund gibt es schon eine Ersatzforderung" });
    throw err;
  }
  await audit(db, viewer.userId, "buecherei.compensation.create", id, { item: row.item, amountCents: v.amountCents, loss: !!row.lossCopyId });
  return id;
}

/** Status setzen: bezahlt oder erlassen schließt die Forderung (und den Befund) ab; „offen“ öffnet sie wieder. */
export async function setCompensationStatus(db: Db, viewer: PermissionSet, id: string, status: string, today: string): Promise<void> {
  await requireComp(db, viewer);
  if (!(COMPENSATION_STATUSES as readonly string[]).includes(status)) throw new ValidationError({ status: "Status wählen" });
  const s = status as CompensationStatus;
  const [c] = await db
    .update(buechereiCompensations)
    .set({ status: s, closedOn: s === "offen" ? null : today })
    .where(and(eq(buechereiCompensations.id, id), ne(buechereiCompensations.status, s)))
    .returning({ loanId: buechereiCompensations.loanId, issueId: buechereiCompensations.issueId });
  if (!c) throw new ValidationError({ status: "Forderung gibt es nicht oder hat schon diesen Status" });
  const resolved = s === "offen" ? null : today;
  if (c.loanId) await db.update(buechereiLoans).set({ findingResolvedOn: resolved }).where(eq(buechereiLoans.id, c.loanId));
  if (c.issueId) await db.update(buechereiMaterialIssues).set({ findingResolvedOn: resolved }).where(eq(buechereiMaterialIssues.id, c.issueId));
  await audit(db, viewer.userId, "buecherei.compensation.status", id, { status: s });
}

/** Betrag oder Grund einer offenen Forderung korrigieren. */
export async function updateCompensation(db: Db, viewer: PermissionSet, id: string, input: CompensationInput): Promise<void> {
  await requireComp(db, viewer);
  const v = validate(input, "");
  const [c] = await db
    .update(buechereiCompensations)
    .set(v)
    .where(and(eq(buechereiCompensations.id, id), eq(buechereiCompensations.status, "offen")))
    .returning({ id: buechereiCompensations.id });
  if (!c) throw new ValidationError({ amount: "Nur offene Forderungen lassen sich ändern" });
  await audit(db, viewer.userId, "buecherei.compensation.update", id, { amountCents: v.amountCents });
}

// ---------------------------------------------------------------- Lesen

export async function listCompensations(db: Db, viewer: PermissionSet, f: { open: boolean }) {
  await requireComp(db, viewer);
  const rows = await db
    .select({
      id: buechereiCompensations.id,
      item: buechereiCompensations.item,
      reason: buechereiCompensations.reason,
      amountCents: buechereiCompensations.amountCents,
      status: buechereiCompensations.status,
      createdOn: buechereiCompensations.createdOn,
      closedOn: buechereiCompensations.closedOn,
      letterOn: buechereiCompensations.letterOn,
      userId: buechereiCompensations.userId,
      name: users.name,
    })
    .from(buechereiCompensations)
    .leftJoin(users, eq(users.id, buechereiCompensations.userId))
    .where(f.open ? eq(buechereiCompensations.status, "offen") : ne(buechereiCompensations.status, "offen"))
    .orderBy(f.open ? asc(buechereiCompensations.createdOn) : desc(buechereiCompensations.closedOn), asc(buechereiCompensations.id))
    .limit(f.open ? 500 : 100);
  const cls = await classNamesOf(
    db,
    rows.map((r) => r.userId).filter((x): x is string => !!x),
  );
  return rows.map((r) => ({ ...r, className: r.userId ? (cls.get(r.userId) ?? null) : null }));
}

export interface CompensationLetter {
  id: string;
  /** an die Eltern (Minderjährige über „handelt für“) oder an die Person selbst */
  recipients: string[];
  toParents: boolean;
  person: string;
  className: string | null;
  item: string;
  reason: string;
  amountCents: number;
  createdOn: string;
  status: CompensationStatus;
}

/**
 * Brief zur Ersatzforderung: an die Eltern Minderjähriger (handelt für), sonst an die Person selbst. Vermerkt „Brief gedruckt am“.
 * Ohne Konto (gelöscht) → null.
 */
export async function compensationLetter(db: Db, viewer: PermissionSet, id: string, today: string): Promise<CompensationLetter | null> {
  await requireComp(db, viewer);
  const [c] = await db
    .select({ c: buechereiCompensations, name: users.name, role: users.role, selfResponsible: users.selfResponsible })
    .from(buechereiCompensations)
    .innerJoin(users, eq(users.id, buechereiCompensations.userId))
    .where(eq(buechereiCompensations.id, id));
  if (!c) return null;
  const minor = c.role === "schueler" && !c.selfResponsible;
  const parents = minor ? await parentLinks(db, [c.c.userId!], "act") : [];
  const parentNames = parents.length
    ? (await db.select({ name: users.name }).from(users).where(inArray(users.id, parents.map((p) => p.parentId)))).map((p) => p.name).sort((a, b) => a.localeCompare(b, "de"))
    : [];
  const cls = await classNamesOf(db, [c.c.userId!]);
  await db.update(buechereiCompensations).set({ letterOn: today }).where(eq(buechereiCompensations.id, id));
  await audit(db, viewer.userId, "buecherei.compensation.letter", id);
  return {
    id,
    recipients: minor ? (parentNames.length ? parentNames : [`Erziehungsberechtigte von ${c.name}`]) : [c.name],
    toParents: minor,
    person: c.name,
    className: cls.get(c.c.userId!) ?? null,
    item: c.c.item,
    reason: c.c.reason,
    amountCents: c.c.amountCents,
    createdOn: c.c.createdOn,
    status: c.c.status,
  };
}

/** Offene Forderungen einer Person (eigene Sicht, Eltern) – ohne Schalterprüfung der Daten, die Seite prüft ihn. */
export async function openCompensationsOf(db: Db, userId: string) {
  return db
    .select({ id: buechereiCompensations.id, item: buechereiCompensations.item, reason: buechereiCompensations.reason, amountCents: buechereiCompensations.amountCents, createdOn: buechereiCompensations.createdOn })
    .from(buechereiCompensations)
    .where(and(eq(buechereiCompensations.userId, userId), eq(buechereiCompensations.status, "offen")))
    .orderBy(asc(buechereiCompensations.createdOn));
}

/** Eltern (lesend): offene Forderungen der Kinder, über die sie informiert werden. */
export async function childrenCompensations(db: Db, viewer: PermissionSet) {
  if (viewer.role !== "eltern" || viewer.locked || !(await lernmittelEnabled(db))) return new Map<string, Awaited<ReturnType<typeof openCompensationsOf>>>();
  const out = new Map<string, Awaited<ReturnType<typeof openCompensationsOf>>>();
  for (const k of await childrenOf(db, viewer.userId, "inform")) out.set(k.id, await openCompensationsOf(db, k.id));
  return out;
}

/** Auskunft (Art. 15): alle Forderungen der Person – unabhängig vom Schalter. */
export async function compensationAuskunft(db: Db, userId: string) {
  return db
    .select({
      gegenstand: buechereiCompensations.item,
      grund: buechereiCompensations.reason,
      betragCent: buechereiCompensations.amountCents,
      status: buechereiCompensations.status,
      angelegt: buechereiCompensations.createdOn,
      abgeschlossen: buechereiCompensations.closedOn,
      briefGedruckt: buechereiCompensations.letterOn,
    })
    .from(buechereiCompensations)
    .where(eq(buechereiCompensations.userId, userId))
    .orderBy(asc(buechereiCompensations.createdOn));
}

const euro = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const ymdDe = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** Rein: Text für den Eigenexport – nur, wenn es Forderungen gibt. */
export function compensationText(rows: Awaited<ReturnType<typeof compensationAuskunft>>): string | null {
  if (!rows.length) return null;
  const lines = ["Ersatzforderungen der Schulbücherei", ""];
  for (const r of rows)
    lines.push(`- ${r.gegenstand}: ${r.grund}, ${euro(r.betragCent)}, angelegt am ${ymdDe(r.angelegt)} – ${r.status}${r.abgeschlossen ? ` am ${ymdDe(r.abgeschlossen)}` : ""}`);
  lines.push("");
  return lines.join("\n");
}

