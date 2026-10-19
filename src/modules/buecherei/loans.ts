// Schulbücherei – Theke (BU-02): Person wählen, Exemplare per Hand-Scanner (Tastatur) ausleihen, Rückgabe nur scannen,
// verlängern. Datenschutz (docs/BUECHEREI.md): Die Theke sieht nur Name, Klasse und offene Ausleihen einer Person; die Rückgabe
// ohne Befund löscht die Ausleihe (nur der Zähler je Monat/Medienart bleibt) – kein Ausleihverlauf je Person, auch nicht im
// Audit-Log (Ausleihe/Rückgabe werden dort bewusst nicht protokolliert, nur Befunde).
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { buechereiCopies, buechereiLoans, buechereiReservations, buechereiStats, buechereiTitles, groupMembers, groups, users } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { isCardCode, personByCard } from "./cards";
import { dueDate, nextOpenDay } from "./dates";
import { BORROWER_ROLES, isValidCopyNumber, type MediaType } from "./labels";
import { checkoutReservation, canUse, promoteReservations, reservedByOthers } from "./reservations";
import { LOAN_DAYS, MAX_RENEWALS } from "./settings";

export const canDesk = (p: PermissionSet) => hasPermission(p, "buecherei.desk");
/** Befunde (Schäden) bearbeiten gehört zu den Ersatzforderungen – Verwaltung, nicht die Theke (Schüler-Helfer:innen). */
export const canFindings = (p: PermissionSet) => hasPermission(p, "buecherei.materials");

function requireDesk(p: PermissionSet) {
  if (!canDesk(p)) throw new ForbiddenError("buecherei.desk");
}

export { BORROWER_ROLES };

export const MAX_FINDING_LENGTH = 200;

// ---------------------------------------------------------------- Fälligkeit

export { dueDate, nextOpenDay };

async function loanDays(db: Db, mediaType: MediaType): Promise<number> {
  return Number(await readModuleSetting(db, LOAN_DAYS[mediaType]));
}

async function bumpStats(db: Db, today: string, mediaType: MediaType, field: "loans" | "renewals") {
  const month = today.slice(0, 7);
  await db
    .insert(buechereiStats)
    .values({ month, mediaType, [field]: 1 })
    .onConflictDoUpdate({ target: [buechereiStats.month, buechereiStats.mediaType], set: { [field]: sql`${buechereiStats[field]} + 1` } });
}

// ---------------------------------------------------------------- Personen

export interface Borrower {
  id: string;
  name: string;
  className: string | null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Klassen (aktive Klassengruppe) von Schüler:innen – „7b“ statt „Klasse 7b“; Lehrkräfte als Gruppenmitglied zählen nicht. */
export async function classNamesOf(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ userId: groupMembers.userId, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.userId, [...ids]), eq(groups.kind, "klasse"), isNull(groups.archivedAt), eq(groupMembers.role, "member"), eq(users.role, "schueler")));
  return new Map(rows.map((r) => [r.userId, r.name.replace(/^Klasse /, "")]));
}

/**
 * Personensuche an der Theke (Recht `buecherei.desk`): jedes Wort muss im Namen oder in der Klasse vorkommen („lea 7b“).
 * Nur aktive Konten, die ausleihen können; höchstens 30 Treffer, nur Name und Klasse.
 */
export async function searchBorrowers(db: Db, viewer: PermissionSet, q: string): Promise<Borrower[]> {
  requireDesk(viewer);
  const words = q.trim().slice(0, 60).split(/\s+/).filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const conds: SQL[] = words.map((w) => {
    const like = `%${escapeLike(w)}%`;
    return sql`(${users.name} ilike ${like} or ${users.role} = 'schueler' and exists (select 1 from group_members gm join groups g on g.id = gm.group_id where gm.user_id = ${users.id} and gm.role = 'member' and g.kind = 'klasse' and g.archived_at is null and (g.name ilike ${like} or g.slug = ${w.toLowerCase()})))`;
  });
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, [...BORROWER_ROLES]), ...conds))
    .orderBy(de(users.lastName), de(users.firstName), asc(users.id))
    .limit(30);
  const cls = await classNamesOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, className: cls.get(r.id) ?? null }));
}

export interface OpenLoan {
  id: string;
  titleId: string;
  barcode: string;
  title: string;
  mediaType: MediaType;
  loanedOn: string;
  dueOn: string;
  renewals: number;
  overdue: boolean;
  /** BU-04: Mahnstufe 0–3 (nur für die Person selbst bzw. ihre Eltern – die Theke bekommt sie nicht) */
  dunningLevel: number;
}

/** Offene Ausleihen einer Person (Theke, „Meine Ausleihen“) – Rückgaben mit Befund gehören nicht dazu. */
export async function openLoansOf(db: Db, userId: string, today: string): Promise<OpenLoan[]> {
  const rows = await db
    .select({
      id: buechereiLoans.id,
      titleId: buechereiCopies.titleId,
      barcode: buechereiCopies.barcode,
      title: buechereiTitles.title,
      mediaType: buechereiTitles.mediaType,
      loanedOn: buechereiLoans.loanedOn,
      dueOn: buechereiLoans.dueOn,
      renewals: buechereiLoans.renewals,
      dunningLevel: buechereiLoans.dunningLevel,
    })
    .from(buechereiLoans)
    .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .where(and(eq(buechereiLoans.userId, userId), isNull(buechereiLoans.returnedOn)))
    .orderBy(asc(buechereiLoans.dueOn), asc(buechereiCopies.barcode));
  return rows.map((r) => ({ ...r, overdue: r.dueOn < today }));
}

/**
 * Eine Person an der Theke: nur Name, Klasse und offene Ausleihen – kein Verlauf, keine Befunde, keine Mahnstufen
 * (Entscheidung 3, docs/BUECHEREI.md). Gesperrte Konten (Abgang) erscheinen noch, damit Rückgaben möglich bleiben.
 */
export async function deskPerson(db: Db, viewer: PermissionSet, userId: string, today: string) {
  requireDesk(viewer);
  const [u] = await db.select({ id: users.id, name: users.name, role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u || !BORROWER_ROLES.includes(u.role)) return null;
  const cls = await classNamesOf(db, [u.id]);
  // BU-04: Mahnstufen gehen die Theke nichts an (auch Schüler-Helfer:innen) – „überfällig“ genügt
  const loans = (await openLoansOf(db, u.id, today)).map((l) => ({ id: l.id, titleId: l.titleId, barcode: l.barcode, title: l.title, mediaType: l.mediaType, loanedOn: l.loanedOn, dueOn: l.dueOn, renewals: l.renewals, overdue: l.overdue }));
  return { id: u.id, name: u.name, className: cls.get(u.id) ?? null, active: u.status === "active", loans };
}

/** Kopfzahlen der Theke ohne Personenbezug. */
export async function deskSummary(db: Db, viewer: PermissionSet, today: string) {
  requireDesk(viewer);
  const [[open], [overdue]] = await Promise.all([
    db.select({ n: count() }).from(buechereiLoans).where(isNull(buechereiLoans.returnedOn)),
    db
      .select({ n: count() })
      .from(buechereiLoans)
      .where(and(isNull(buechereiLoans.returnedOn), lt(buechereiLoans.dueOn, today))),
  ]);
  return { open: open?.n ?? 0, overdue: overdue?.n ?? 0 };
}

// ---------------------------------------------------------------- Verbuchen

/** Rein: Eingabe des Scanners bzw. der Tastatur normalisieren (Leerzeichen weg, Großbuchstaben). */
export const normalizeScan = (raw: string) => raw.replace(/\s+/g, "").toUpperCase();

async function copyByBarcode(db: Db, barcode: string) {
  const [c] = await db
    .select({
      id: buechereiCopies.id,
      titleId: buechereiCopies.titleId,
      barcode: buechereiCopies.barcode,
      withdrawnOn: buechereiCopies.withdrawnOn,
      title: buechereiTitles.title,
      mediaType: buechereiTitles.mediaType,
    })
    .from(buechereiCopies)
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .where(eq(buechereiCopies.barcode, barcode));
  return c ?? null;
}

async function openLoanOfCopy(db: Db, copyId: string) {
  const [l] = await db
    .select({ id: buechereiLoans.id, userId: buechereiLoans.userId, dueOn: buechereiLoans.dueOn })
    .from(buechereiLoans)
    .where(and(eq(buechereiLoans.copyId, copyId), isNull(buechereiLoans.returnedOn)));
  return l ?? null;
}

function requireCopyNumber(code: string) {
  if (!isValidCopyNumber(code)) throw new ValidationError({ code: `„${code}“ ist keine gültige Exemplarnummer (Prüfziffer)` });
}

/**
 * Exemplar an eine Person ausleihen (Recht `buecherei.desk`); Fälligkeit nach der Leihfrist der Medienart. BU-03: Liegen alle
 * freien Exemplare des Titels für andere bereit (Vormerkung), geht es nicht – ohne deren Namen zu nennen; die eigene
 * Vormerkung der Person ist mit der Ausleihe erfüllt und wird gelöscht.
 */
export async function checkout(db: Db, viewer: PermissionSet, userId: string, rawCode: string, today: string): Promise<{ title: string; barcode: string; dueOn: string }> {
  requireDesk(viewer);
  const code = normalizeScan(rawCode);
  requireCopyNumber(code);
  const copy = await copyByBarcode(db, code);
  if (!copy) throw new ValidationError({ code: `Exemplar ${code} gibt es nicht` });
  if (copy.withdrawnOn) throw new ValidationError({ code: `${code} ist ausgesondert und nicht ausleihbar` });
  if (await openLoanOfCopy(db, copy.id)) throw new ValidationError({ code: `${code} ist schon ausgeliehen – erst zurückbuchen` });
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u || !BORROWER_ROLES.includes(u.role)) throw new ValidationError({ code: "Diese Person kann nicht ausleihen" });
  if (u.status !== "active") throw new ValidationError({ code: "Konto gesperrt – keine neue Ausleihe" });
  const reservation = await checkoutReservation(db, copy.titleId, userId, code);
  const dueOn = await dueDate(db, today, await loanDays(db, copy.mediaType));
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.insert(buechereiLoans).values({ copyId: copy.id, userId, loanedOn: today, dueOn });
    await bumpStats(tx, today, copy.mediaType, "loans");
    // BU-05: Nutzung je Exemplar (Zahl und Monat der letzten Ausleihe) – ohne Person
    await tx
      .update(buechereiCopies)
      .set({ loanCount: sql`${buechereiCopies.loanCount} + 1`, lastLoanMonth: today.slice(0, 7) })
      .where(eq(buechereiCopies.id, copy.id));
    if (reservation) await tx.delete(buechereiReservations).where(eq(buechereiReservations.id, reservation.id));
  });
  return { title: copy.title, barcode: copy.barcode, dueOn };
}

/**
 * Rückgabe (Recht `buecherei.desk`) – nur scannen, ohne die Person zu wählen. Ohne Befund wird die Ausleihe gelöscht
 * (Personenbezug sofort weg); mit Befund bleibt sie bis zur Erledigung (Verwaltung) und wird protokolliert. BU-03: Danach
 * rückt die nächste Vormerkung des Titels nach (Gong an die Person).
 */
export async function checkin(
  db: Db,
  viewer: PermissionSet,
  rawCode: string,
  today: string,
  finding?: string | null,
): Promise<{ title: string; barcode: string; overdueDays: number; finding: boolean }> {
  requireDesk(viewer);
  const code = normalizeScan(rawCode);
  requireCopyNumber(code);
  const note = finding?.trim() || null;
  if (note && note.length > MAX_FINDING_LENGTH) throw new ValidationError({ finding: `Befund höchstens ${MAX_FINDING_LENGTH} Zeichen` });
  const copy = await copyByBarcode(db, code);
  if (!copy) throw new ValidationError({ code: `Exemplar ${code} gibt es nicht` });
  const loan = await openLoanOfCopy(db, copy.id);
  if (!loan) throw new ValidationError({ code: `${code} ist nicht ausgeliehen` });
  const overdueDays = loan.dueOn < today ? Math.round((Date.parse(today) - Date.parse(loan.dueOn)) / 86_400_000) : 0;
  if (!note) {
    await db.delete(buechereiLoans).where(eq(buechereiLoans.id, loan.id));
  } else {
    // BU-04: Mahnstufe und Erinnerung enden mit der Rückgabe – der Befund braucht sie nicht
    await db.update(buechereiLoans).set({ returnedOn: today, finding: note, dunningLevel: 0, dunnedOn: null, remindedDueOn: null }).where(eq(buechereiLoans.id, loan.id));
    await audit(db, viewer.userId, "buecherei.loan.finding", loan.id, { barcode: copy.barcode, finding: note });
  }
  await promoteReservations(db, copy.titleId, today);
  return { title: copy.title, barcode: copy.barcode, overdueDays, finding: !!note };
}

/**
 * Verlängern an der Theke (Recht `buecherei.desk`): höchstens so oft wie eingestellt; die Frist beginnt ab heute neu (nie früher
 * als die bisherige Fälligkeit). BU-03: Hat jemand anderes den Titel vorgemerkt, geht es nicht.
 */
export async function renewLoan(db: Db, viewer: PermissionSet, loanId: string, today: string): Promise<{ dueOn: string; renewals: number }> {
  requireDesk(viewer);
  return renewChecked(db, loanId, today, null);
}

/** BU-03: eigene Ausleihe selbst verlängern („Meine Ausleihen“, Recht `buecherei.use`) – gleiche Regeln wie an der Theke. */
export async function renewOwnLoan(db: Db, viewer: PermissionSet, loanId: string, today: string): Promise<{ dueOn: string; renewals: number }> {
  if (!canUse(viewer)) throw new ForbiddenError("buecherei.use");
  return renewChecked(db, loanId, today, viewer.userId);
}

/** Rein: Grund, warum eine Ausleihe nicht verlängert werden kann – oder null. */
export function renewalBlock(renewals: number, max: number, reserved: boolean): string | null {
  if (max === 0) return "Verlängern ist ausgeschaltet";
  if (renewals >= max) return `Schon ${renewals}-mal verlängert – mehr geht nicht`;
  if (reserved) return "Vorgemerkt – bitte zurückgeben, jemand wartet darauf";
  return null;
}

async function renewChecked(db: Db, loanId: string, today: string, owner: string | null) {
  const [l] = await db
    .select({ id: buechereiLoans.id, userId: buechereiLoans.userId, titleId: buechereiCopies.titleId, dueOn: buechereiLoans.dueOn, renewals: buechereiLoans.renewals, mediaType: buechereiTitles.mediaType })
    .from(buechereiLoans)
    .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .where(and(eq(buechereiLoans.id, loanId), isNull(buechereiLoans.returnedOn)));
  if (!l || (owner && l.userId !== owner)) throw new ValidationError({ loan: "Ausleihe gibt es nicht (schon zurückgegeben?)" });
  const max = Number(await readModuleSetting(db, MAX_RENEWALS));
  const block = renewalBlock(l.renewals, max, await reservedByOthers(db, l.titleId, l.userId));
  if (block) throw new ValidationError({ loan: block });
  const next = await dueDate(db, today, await loanDays(db, l.mediaType));
  const dueOn = next > l.dueOn ? next : l.dueOn;
  const [r] = await db
    .update(buechereiLoans)
    // BU-04: neue Frist → Mahnstufe und Erinnerung beginnen von vorn
    .set({ dueOn, renewals: l.renewals + 1, dunningLevel: 0, dunnedOn: null, remindedDueOn: null })
    .where(and(eq(buechereiLoans.id, l.id), eq(buechereiLoans.renewals, l.renewals), isNull(buechereiLoans.returnedOn)))
    .returning({ renewals: buechereiLoans.renewals });
  if (!r) throw new ValidationError({ loan: "Ausleihe wurde gerade geändert – bitte neu laden" });
  await bumpStats(db, today, l.mediaType, "renewals");
  return { dueOn, renewals: r.renewals };
}

export type ScanResult =
  | { kind: "person"; userId: string }
  | { kind: "loan"; title: string; barcode: string; dueOn: string }
  | { kind: "return"; title: string; barcode: string; overdueDays: number; finding: boolean };

/**
 * Ein Scan an der Theke: Ausweis (BU-07) → diese Person wählen; Exemplar ausgeliehen → Rückgabe (egal, welche Person gewählt
 * ist); sonst Ausleihe an die gewählte Person. Ohne gewählte Person geht nur die Rückgabe.
 */
export async function scanAtDesk(db: Db, viewer: PermissionSet, rawCode: string, personId: string | null, today: string): Promise<ScanResult> {
  requireDesk(viewer);
  const code = normalizeScan(rawCode);
  if (!code) throw new ValidationError({ code: "Ausweis oder Exemplar scannen" });
  if (isCardCode(code)) {
    const userId = await personByCard(db, viewer, code);
    if (!userId) throw new ValidationError({ code: "Ausweis unbekannt oder ersetzt – Person über die Suche wählen" });
    return { kind: "person", userId };
  }
  requireCopyNumber(code);
  const copy = await copyByBarcode(db, code);
  if (!copy) throw new ValidationError({ code: `Exemplar ${code} gibt es nicht` });
  if (await openLoanOfCopy(db, copy.id)) return { kind: "return", ...(await checkin(db, viewer, code, today)) };
  if (!personId) throw new ValidationError({ code: `${code} ist nicht ausgeliehen – für eine Ausleihe erst die Person wählen` });
  return { kind: "loan", ...(await checkout(db, viewer, personId, code, today)) };
}

// ---------------------------------------------------------------- Befunde (Verwaltung)

/** Offene Befunde mit Person (Recht `buecherei.materials`) – Grundlage für eine Ersatzforderung (Stufe 2). */
export async function listFindings(db: Db, viewer: PermissionSet) {
  if (!canFindings(viewer)) throw new ForbiddenError("buecherei.materials");
  const rows = await db
    .select({
      id: buechereiLoans.id,
      barcode: buechereiCopies.barcode,
      title: buechereiTitles.title,
      returnedOn: buechereiLoans.returnedOn,
      finding: buechereiLoans.finding,
      userId: buechereiLoans.userId,
      name: users.name,
    })
    .from(buechereiLoans)
    .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .leftJoin(users, eq(users.id, buechereiLoans.userId))
    .where(and(isNotNull(buechereiLoans.returnedOn), isNull(buechereiLoans.findingResolvedOn)))
    .orderBy(asc(buechereiLoans.returnedOn), asc(buechereiCopies.barcode));
  const cls = await classNamesOf(
    db,
    rows.map((r) => r.userId).filter((x): x is string => !!x),
  );
  return rows.map((r) => ({ ...r, className: r.userId ? (cls.get(r.userId) ?? null) : null }));
}

/** Befund erledigt (Ersatz geleistet, repariert, erlassen) – danach Löschung nach LK-SJ-1J. */
export async function resolveFinding(db: Db, viewer: PermissionSet, loanId: string, today: string): Promise<void> {
  if (!canFindings(viewer)) throw new ForbiddenError("buecherei.materials");
  const [r] = await db
    .update(buechereiLoans)
    .set({ findingResolvedOn: today })
    .where(and(eq(buechereiLoans.id, loanId), isNotNull(buechereiLoans.returnedOn), isNull(buechereiLoans.findingResolvedOn)))
    .returning({ id: buechereiLoans.id });
  if (!r) throw new ValidationError({ loan: "Befund gibt es nicht oder ist schon erledigt" });
  await audit(db, viewer.userId, "buecherei.loan.resolve", loanId);
}
