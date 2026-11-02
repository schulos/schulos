// INV-05 (docs/INVENTAR.md, Stufe 4): Ausleihe von Inventar (Leihgeräte wie Tablets, Instrumente) an Personen mit Konto –
// Schüler:innen und Beschäftigte (wie die Bücherei: keine Eltern, keine technischen Admin-Konten, keine Externen ohne Konto).
// Verleihen, Frist ändern, Rückgabe buchen und Stornieren darf, wer die Kategorie des Geräts pflegt (`requireMaintain`: Recht
// `gebaeude.inventory`/`configure` oder verantwortliche Gruppe). Wer verliehen hat, steht nur im Audit-Log (`gebaeude.asset.loan*`,
// Ziel = Gerät, ohne Namen). Erinnerungen über den täglichen Lauf `gebaeude-leihe` nach dem Muster der Bücherei-Mahnungen (BU-04):
// vor dem Rückgabedatum ein Gong, danach an Schultagen bis zu drei Erinnerungen, ab der zweiten auch an die Eltern Minderjähriger,
// Mail optional ohne Gerät. Personenbezug: `gebaeude_loans` mit LK-ENDE-1J ab Rückgabe; der Leihvertrag ist nur Druck.
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, gte, ne, or, sql, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { gebaeudeAssetCategories, gebaeudeAssets, gebaeudeLoans, groupMembers, users } from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { mailFooter, type MailContent } from "@/core/mail-templates";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { readModuleSetting } from "@/core/modules/settings";
import { notifyBundled } from "@/core/notifications";
import { ForbiddenError, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { isStaffRole, type Role } from "@/core/roles";
import { childrenOf, parentLinks } from "@/core/school/majority";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { dueDate, isOpenDay } from "@/modules/buecherei/dates";
import { BORROWER_ROLES } from "@/modules/buecherei/labels";
import { classNamesOf } from "@/modules/buecherei/loans";
import { nextDunningLevel } from "@/modules/buecherei/mahnungen";
import { verifiedEmails } from "@/modules/sprechtag/mails";
import { ValidationError } from "@/modules/verwaltung/users";
import { INVENTORY_PERMISSION, maintainableCategories, requireMaintain } from "./inventar";
import { LOAN_MAX_DAYS, LOAN_MAX_OVERDUE_LEVEL, LOAN_OVERDUE_INTERVAL_DAYS, LOAN_PARENT_LEVEL, LOAN_TEXT_MAX, loanState, type LoanState } from "./labels";
import gebaeude from "./manifest";
import { canViewAll } from "./service";
import { LOAN_DAYS, LOAN_MAIL, LOAN_REMIND_DAYS } from "./settings";

/** Wer ausleihen kann: dieselben Rollen wie in der Bücherei (alle Konten der Schule außer Eltern und Admin-Konten). */
export const LOAN_BORROWER_ROLES: readonly Role[] = BORROWER_ROLES;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
/** Datum wie in der Prüfplanung („05.11.2026“) – eigene Kopie, damit `pruefungen.ts` diese Datei ohne Kreisbezug nutzen kann. */
export const formatLoanDay = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const clean = (v: string | null | undefined) => v?.trim().slice(0, LOAN_TEXT_MAX) || null;

// ---------------------------------------------------------------- Rechte

/** Darf die Person überhaupt verleihen (alle Kategorien oder mindestens eine verantwortete)? */
export async function canLendAny(db: Db, viewer: PermissionSet): Promise<boolean> {
  const own = await maintainableCategories(db, viewer);
  return own === null || own.size > 0;
}

async function requireLendAny(db: Db, viewer: PermissionSet): Promise<Set<string> | null> {
  const own = await maintainableCategories(db, viewer);
  if (own !== null && own.size === 0) throw new ForbiddenError(INVENTORY_PERMISSION);
  return own;
}

// ---------------------------------------------------------------- Personen

export interface LoanBorrower {
  id: string;
  name: string;
  className: string | null;
}

/**
 * Personensuche zum Verleihen (wer verleihen darf): jedes Wort muss im Namen oder in der Klasse vorkommen („lea 7b“). Nur aktive
 * Konten mit Ausleih-Rolle; höchstens 20 Treffer, nur Name und Klasse.
 */
export async function searchLoanBorrowers(db: Db, viewer: PermissionSet, q: string): Promise<LoanBorrower[]> {
  await requireLendAny(db, viewer);
  const words = q.trim().slice(0, 60).split(/\s+/).filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const conds: SQL[] = words.map((w) => {
    const like = `%${escapeLike(w)}%`;
    return sql`(${users.name} ilike ${like} or ${users.role} = 'schueler' and exists (select 1 from group_members gm join groups g on g.id = gm.group_id where gm.user_id = ${users.id} and gm.role = 'member' and g.kind = 'klasse' and g.archived_at is null and (g.name ilike ${like} or g.slug = ${w.toLowerCase()})))`;
  });
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, [...LOAN_BORROWER_ROLES]), ...conds))
    .orderBy(de(users.lastName), de(users.firstName), asc(users.id))
    .limit(20);
  const cls = await classNamesOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, className: cls.get(r.id) ?? null }));
}

/** Eine Person als Entleihende:r (für die Auswahl im Formular) – `null`, wenn sie nicht ausleihen kann. */
export async function loanBorrower(db: Db, viewer: PermissionSet, userId: string): Promise<LoanBorrower | null> {
  await requireLendAny(db, viewer);
  const [u] = await db
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.status !== "active" || !LOAN_BORROWER_ROLES.includes(u.role)) return null;
  const cls = await classNamesOf(db, [u.id]);
  return { id: u.id, name: u.name, className: cls.get(u.id) ?? null };
}

// ---------------------------------------------------------------- Verleihen, Frist, Rückgabe

/** Vorgeschlagenes Rückgabedatum: heute + Leihfrist (Moduleinstellung), auf den nächsten Schultag verschoben. */
export async function defaultLoanDue(db: Db, today: string): Promise<string> {
  return dueDate(db, today, Number(await readModuleSetting(db, LOAN_DAYS)));
}

function validateDue(raw: string, today: string): string {
  const due = raw.trim();
  if (!YMD.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) throw new ValidationError({ dueOn: "Rückgabedatum wählen" });
  if (due < today) throw new ValidationError({ dueOn: "Das Rückgabedatum liegt in der Vergangenheit" });
  if (due > addDays(today, LOAN_MAX_DAYS)) throw new ValidationError({ dueOn: "Höchstens zwei Jahre im Voraus" });
  return due;
}

export interface LoanInput {
  userId: string;
  dueOn: string;
  accessories?: string | null;
}

/**
 * Gerät an eine Person verleihen. Nur Inventar in Betrieb, nur Einzelstücke (keine Sammelposten), je Gerät eine offene Ausleihe
 * (Sperre + Teilindex). Die Person braucht ein aktives Konto mit Ausleih-Rolle. Audit am Gerät ohne Namen.
 */
export async function lendAsset(db: Db, viewer: PermissionSet, assetId: string, input: LoanInput, today: string): Promise<string> {
  const [a] = await db
    .select({ id: gebaeudeAssets.id, categoryId: gebaeudeAssets.categoryId, active: gebaeudeAssets.active, quantity: gebaeudeAssets.quantity })
    .from(gebaeudeAssets)
    .where(eq(gebaeudeAssets.id, assetId));
  if (!a) throw new ValidationError({ asset: "Inventar gibt es nicht" });
  await requireMaintain(db, viewer, a.categoryId);
  if (!a.active) throw new ValidationError({ asset: "Das Gerät ist ausgemustert" });
  if (a.quantity > 1) throw new ValidationError({ asset: "Sammelposten lassen sich nicht verleihen – bitte das Gerät einzeln inventarisieren" });
  const dueOn = validateDue(input.dueOn, today);
  const [u] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, input.userId.trim()));
  if (!u || u.status !== "active" || !LOAN_BORROWER_ROLES.includes(u.role)) throw new ValidationError({ userId: "Diese Person kann nichts ausleihen" });
  const id = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gebaeude:leihe:${assetId}`}))`);
    const [open] = await tx.select({ id: gebaeudeLoans.id }).from(gebaeudeLoans).where(and(eq(gebaeudeLoans.assetId, assetId), isNull(gebaeudeLoans.returnedAt)));
    if (open) throw new ValidationError({ asset: "Das Gerät ist schon verliehen – erst die Rückgabe buchen" });
    const [row] = await tx
      .insert(gebaeudeLoans)
      .values({ assetId, userId: u.id, loanedOn: today, dueOn, accessories: clean(input.accessories) })
      .returning({ id: gebaeudeLoans.id });
    return row!.id;
  });
  await audit(db, viewer.userId, "gebaeude.asset.loan", assetId, { loan: id, due: dueOn });
  return id;
}

async function loadLoan(db: Db, loanId: string) {
  const [l] = await db
    .select({ id: gebaeudeLoans.id, assetId: gebaeudeLoans.assetId, userId: gebaeudeLoans.userId, dueOn: gebaeudeLoans.dueOn, returnedAt: gebaeudeLoans.returnedAt, categoryId: gebaeudeAssets.categoryId })
    .from(gebaeudeLoans)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeLoans.assetId))
    .where(eq(gebaeudeLoans.id, loanId));
  if (!l) throw new ValidationError({ loan: "Ausleihe gibt es nicht" });
  return l;
}

/** Rückgabedatum ändern (verlängern oder verkürzen) – Erinnerungen beginnen neu. */
export async function extendLoan(db: Db, viewer: PermissionSet, loanId: string, rawDue: string, today: string): Promise<string> {
  const l = await loadLoan(db, loanId);
  await requireMaintain(db, viewer, l.categoryId);
  if (l.returnedAt) throw new ValidationError({ dueOn: "Das Gerät ist schon zurückgegeben" });
  const dueOn = validateDue(rawDue, today);
  if (dueOn === l.dueOn) return l.assetId;
  await db.update(gebaeudeLoans).set({ dueOn, remindedDueOn: null, overdueLevel: 0, overdueOn: null }).where(and(eq(gebaeudeLoans.id, loanId), isNull(gebaeudeLoans.returnedAt)));
  await audit(db, viewer.userId, "gebaeude.asset.loan.extend", l.assetId, { loan: loanId, from: l.dueOn, to: dueOn });
  return l.assetId;
}

/**
 * Rückgabe buchen: optional mit Befund (Sache, keine Namen). Erinnerungsstand wird geleert; ab jetzt läuft die Löschfrist
 * (LK-ENDE-1J ab `returned_at`). Den Zustand des Geräts ändern die Pflegenden getrennt per Knopf.
 */
export async function returnLoan(db: Db, viewer: PermissionSet, loanId: string, note: string | null, now = new Date()): Promise<string> {
  const l = await loadLoan(db, loanId);
  await requireMaintain(db, viewer, l.categoryId);
  const [done] = await db
    .update(gebaeudeLoans)
    .set({ returnedAt: now, returnNote: clean(note), remindedDueOn: null, overdueLevel: 0, overdueOn: null })
    .where(and(eq(gebaeudeLoans.id, loanId), isNull(gebaeudeLoans.returnedAt)))
    .returning({ id: gebaeudeLoans.id });
  if (!done) throw new ValidationError({ loan: "Die Rückgabe ist schon gebucht" });
  await audit(db, viewer.userId, "gebaeude.asset.return", l.assetId, { loan: loanId, late: l.dueOn < toBerlinDate(now), finding: Boolean(clean(note)) });
  return l.assetId;
}

/** Versehentlich angelegte Ausleihe stornieren (nur offene): Zeile weg, Audit am Gerät. */
export async function cancelLoan(db: Db, viewer: PermissionSet, loanId: string): Promise<string> {
  const l = await loadLoan(db, loanId);
  await requireMaintain(db, viewer, l.categoryId);
  if (l.returnedAt) throw new ValidationError({ loan: "Zurückgegebene Ausleihen lassen sich nicht stornieren" });
  await db.delete(gebaeudeLoans).where(and(eq(gebaeudeLoans.id, loanId), isNull(gebaeudeLoans.returnedAt)));
  await audit(db, viewer.userId, "gebaeude.asset.loan.cancel", l.assetId, { loan: loanId });
  return l.assetId;
}

/** Hat das Gerät eine offene Ausleihe? (Ausmustern/Löschen sperren, Inventur „verliehen“). */
export async function hasOpenLoan(db: Db, assetId: string): Promise<boolean> {
  const [r] = await db.select({ n: count() }).from(gebaeudeLoans).where(and(eq(gebaeudeLoans.assetId, assetId), isNull(gebaeudeLoans.returnedAt)));
  return (r?.n ?? 0) > 0;
}

/** Geräte (aus der Liste) mit offener Ausleihe – für die Inventur. */
export async function lentAssetIds(db: Db, assetIds: readonly string[]): Promise<Set<string>> {
  if (!assetIds.length) return new Set();
  const rows = await db
    .select({ assetId: gebaeudeLoans.assetId })
    .from(gebaeudeLoans)
    .where(and(inArray(gebaeudeLoans.assetId, [...assetIds]), isNull(gebaeudeLoans.returnedAt)));
  return new Set(rows.map((r) => r.assetId));
}

// ---------------------------------------------------------------- Lesen

export interface LoanRow {
  id: string;
  assetId: string;
  assetName: string;
  inventoryNo: string | null;
  categoryName: string;
  /** null = Konto gelöscht bzw. für diese Person nicht sichtbar */
  userId: string | null;
  borrower: string | null;
  className: string | null;
  loanedOn: string;
  dueOn: string;
  returnedAt: Date | null;
  accessories: string | null;
  returnNote: string | null;
  overdueLevel: number;
  state: LoanState;
}

const loanSelect = {
  id: gebaeudeLoans.id,
  assetId: gebaeudeLoans.assetId,
  assetName: gebaeudeAssets.name,
  inventoryNo: gebaeudeAssets.inventoryNo,
  categoryName: gebaeudeAssetCategories.name,
  userId: gebaeudeLoans.userId,
  borrower: users.name,
  loanedOn: gebaeudeLoans.loanedOn,
  dueOn: gebaeudeLoans.dueOn,
  returnedAt: gebaeudeLoans.returnedAt,
  accessories: gebaeudeLoans.accessories,
  returnNote: gebaeudeLoans.returnNote,
  overdueLevel: gebaeudeLoans.overdueLevel,
};

function loanQuery(db: Db) {
  return db
    .select(loanSelect)
    .from(gebaeudeLoans)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeLoans.assetId))
    .innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
    .leftJoin(users, eq(users.id, gebaeudeLoans.userId));
}

async function toRows(db: Db, rows: Awaited<ReturnType<ReturnType<typeof loanQuery>["where"]>>, today: string, withNames: boolean): Promise<LoanRow[]> {
  const cls = withNames ? await classNamesOf(db, [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))]) : new Map<string, string>();
  return rows.map((r) => ({
    ...r,
    userId: withNames ? r.userId : null,
    borrower: withNames ? r.borrower : null,
    className: withNames && r.userId ? (cls.get(r.userId) ?? null) : null,
    state: loanState(r, today),
  }));
}

export interface AssetLoans {
  /** offene Ausleihe (Name nur für Pflegende und die Person selbst) */
  current: LoanRow | null;
  /** frühere Ausleihen (nur Pflegende), neueste zuerst – bis zum Löschlauf */
  past: LoanRow[];
  /** darf verleihen/zurücknehmen */
  maintain: boolean;
  /** die angemeldete Person hat das Gerät gerade selbst ausgeliehen */
  mine: boolean;
}

/**
 * Leihstand eines Geräts für die Asset-Seite. Pflegende der Kategorie sehen Person, Klasse und frühere Ausleihen; `view_all` sieht
 * nur „verliehen bis …“ ohne Namen; die entleihende Person sieht ihre eigene Ausleihe; alle anderen nichts.
 */
export async function assetLoans(db: Db, viewer: PermissionSet, asset: { id: string; categoryId: string }, today: string): Promise<AssetLoans> {
  const own = await maintainableCategories(db, viewer);
  const maintain = own === null || own.has(asset.categoryId);
  const rows = await loanQuery(db)
    .where(eq(gebaeudeLoans.assetId, asset.id))
    .orderBy(sql`${gebaeudeLoans.returnedAt} is null desc`, desc(gebaeudeLoans.returnedAt), desc(gebaeudeLoans.createdAt))
    .limit(maintain ? 30 : 1);
  const open = rows.find((r) => !r.returnedAt) ?? null;
  const mine = Boolean(open && open.userId === viewer.userId);
  if (maintain) {
    const all = await toRows(db, rows, today, true);
    return { current: all.find((r) => !r.returnedAt) ?? null, past: all.filter((r) => r.returnedAt), maintain, mine };
  }
  if (!open || !(mine || canViewAll(viewer))) return { current: null, past: [], maintain, mine };
  const [current] = await toRows(db, [open], today, mine);
  return { current: current ?? null, past: [], maintain, mine };
}

/** Offene Ausleihen (Übersicht für Pflegende, nur eigene Kategorien), überfällige zuerst, dann nach Rückgabedatum. */
export async function listOpenLoans(db: Db, viewer: PermissionSet, today: string): Promise<LoanRow[]> {
  const own = await requireLendAny(db, viewer);
  const where = own === null ? isNull(gebaeudeLoans.returnedAt) : and(isNull(gebaeudeLoans.returnedAt), inArray(gebaeudeAssets.categoryId, [...own]));
  const rows = await loanQuery(db).where(where).orderBy(asc(gebaeudeLoans.dueOn), asc(gebaeudeAssets.inventoryNo), asc(gebaeudeLoans.id)).limit(500);
  return toRows(db, rows, today, true);
}

export interface MyLoans {
  own: LoanRow[];
  /** Kinder (Eltern sehen lesend, minderjährig bzw. mit Einwilligung „Eltern informieren“) */
  children: { id: string; name: string; loans: LoanRow[] }[];
}

/** „Meine Leihgeräte“: offene und noch gespeicherte zurückgegebene Ausleihen der Person, bei Eltern die der Kinder. */
export async function myLoans(db: Db, viewer: PermissionSet, today: string): Promise<MyLoans> {
  const kids = viewer.role === "eltern" ? await childrenOf(db, viewer.userId, "inform") : [];
  const ids = [viewer.userId, ...kids.map((k) => k.id)];
  const rows = await loanQuery(db)
    .where(inArray(gebaeudeLoans.userId, ids))
    .orderBy(sql`${gebaeudeLoans.returnedAt} is null desc`, asc(gebaeudeLoans.dueOn), desc(gebaeudeLoans.returnedAt));
  const all = await toRows(db, rows, today, true);
  return {
    own: all.filter((r) => r.userId === viewer.userId),
    children: kids.map((k) => ({ id: k.id, name: k.name, loans: all.filter((r) => r.userId === k.id) })).filter((k) => k.loans.length > 0),
  };
}

/** Offene Leihgeräte je Person (nur Zahlen) – Hinweis beim Abgang; Modul aus → leer. */
export async function openLoanCounts(db: Db, userIds: readonly string[]): Promise<Map<string, number>> {
  if (!userIds.length || !isEnabled(gebaeude, await loadModuleStates(db))) return new Map();
  const rows = await db
    .select({ userId: gebaeudeLoans.userId, n: count() })
    .from(gebaeudeLoans)
    .where(and(inArray(gebaeudeLoans.userId, [...userIds]), isNull(gebaeudeLoans.returnedAt)))
    .groupBy(gebaeudeLoans.userId);
  return new Map(rows.map((r) => [r.userId!, r.n]));
}

// ---------------------------------------------------------------- Leihvertrag (Druck)

export interface LoanContract {
  school: string;
  borrower: string | null;
  className: string | null;
  role: Role | null;
  /** minderjährig (Unterschrift der Erziehungsberechtigten vorsehen) */
  minor: boolean;
  assetName: string;
  inventoryNo: string | null;
  categoryName: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  accessories: string | null;
  loanedOn: string;
  dueOn: string;
  returned: boolean;
}

/** Daten für den Leihvertrag (Druckansicht) – nur Pflegende der Kategorie; `null` = gibt es nicht. Wird nicht gespeichert. */
export async function loanContract(db: Db, viewer: PermissionSet, loanId: string, school: string): Promise<LoanContract | null> {
  const [l] = await db
    .select({
      categoryId: gebaeudeAssets.categoryId,
      userId: gebaeudeLoans.userId,
      borrower: users.name,
      role: users.role,
      selfResponsible: users.selfResponsible,
      assetName: gebaeudeAssets.name,
      inventoryNo: gebaeudeAssets.inventoryNo,
      categoryName: gebaeudeAssetCategories.name,
      manufacturer: gebaeudeAssets.manufacturer,
      model: gebaeudeAssets.model,
      serial: gebaeudeAssets.serial,
      accessories: gebaeudeLoans.accessories,
      loanedOn: gebaeudeLoans.loanedOn,
      dueOn: gebaeudeLoans.dueOn,
      returnedAt: gebaeudeLoans.returnedAt,
    })
    .from(gebaeudeLoans)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeLoans.assetId))
    .innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
    .leftJoin(users, eq(users.id, gebaeudeLoans.userId))
    .where(eq(gebaeudeLoans.id, loanId));
  if (!l) return null;
  const own = await maintainableCategories(db, viewer);
  if (own !== null && !own.has(l.categoryId)) return null;
  const cls = l.userId ? await classNamesOf(db, [l.userId]) : new Map<string, string>();
  return {
    school,
    borrower: l.borrower,
    className: l.userId ? (cls.get(l.userId) ?? null) : null,
    role: l.role,
    minor: l.role === "schueler" && !l.selfResponsible,
    assetName: l.assetName,
    inventoryNo: l.inventoryNo,
    categoryName: l.categoryName,
    manufacturer: l.manufacturer,
    model: l.model,
    serial: l.serial,
    accessories: l.accessories,
    loanedOn: l.loanedOn,
    dueOn: l.dueOn,
    returned: l.returnedAt !== null,
  };
}

// ---------------------------------------------------------------- Auskunft (Art. 15)

/** Lesbarer Teil der Auskunft: eigene Ausleihen mit Gerät statt Kennungen (offene und noch gespeicherte zurückgegebene). */
export async function loanAuskunft(db: Db, userId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({
      geraet: gebaeudeAssets.name,
      inventarnummer: gebaeudeAssets.inventoryNo,
      kategorie: gebaeudeAssetCategories.name,
      ausgeliehen: gebaeudeLoans.loanedOn,
      rueckgabe_bis: gebaeudeLoans.dueOn,
      zurueckgegeben: gebaeudeLoans.returnedAt,
      zubehoer: gebaeudeLoans.accessories,
      befund: gebaeudeLoans.returnNote,
      erinnerungen_nach_frist: gebaeudeLoans.overdueLevel,
    })
    .from(gebaeudeLoans)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeLoans.assetId))
    .innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
    .where(eq(gebaeudeLoans.userId, userId))
    .orderBy(asc(gebaeudeLoans.loanedOn), asc(gebaeudeLoans.id));
  return rows.map((r) => ({ ...r, zurueckgegeben: r.zurueckgegeben ? r.zurueckgegeben.toISOString() : null }));
}

/** Eigenexport („Leihgeräte.txt“): offene und zurückgegebene Leihgeräte als Text; `null` = keine. */
export function loanText(rows: Awaited<ReturnType<typeof loanAuskunft>>): string | null {
  if (!rows.length) return null;
  const lines = ["Leihgeräte der Schule – offene Ausleihen und zurückgegebene bis 1 Jahr nach der Rückgabe", ""];
  for (const r of rows) {
    const back = typeof r.zurueckgegeben === "string" ? `zurückgegeben am ${formatLoanDay(toBerlinDate(new Date(r.zurueckgegeben)))}` : "noch ausgeliehen";
    lines.push(
      `- ${String(r.geraet)}${r.inventarnummer ? ` (${String(r.inventarnummer)})` : ""}, ausgeliehen am ${formatLoanDay(String(r.ausgeliehen))}, Rückgabe bis ${formatLoanDay(String(r.rueckgabe_bis))}, ${back}${r.zubehoer ? `, Zubehör: ${String(r.zubehoer)}` : ""}${r.befund ? `, Befund: ${String(r.befund)}` : ""}`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- Erinnerungen (Job `gebaeude-leihe`)

const devicesText = (n: number) => (n === 1 ? "Ein Leihgerät ist" : `${n} Leihgeräte sind`);

/** Mail bei überfälligen Leihgeräten – ohne Gerät, nur mit Link zur Anmeldung. `child` = Vorname, wenn sie an Eltern geht. */
export function overdueLoanMail(p: { school: string; level: number; count: number; since: string; link: string; child?: string }): MailContent {
  const what = p.child
    ? `${p.count === 1 ? "ein Leihgerät" : `${p.count} Leihgeräte`} der Schule, ${p.count === 1 ? "das" : "die"} ${p.child} ausgeliehen hat, ${p.count === 1 ? "ist" : "sind"}`
    : `${p.count === 1 ? "ein von Ihnen ausgeliehenes Leihgerät" : `${p.count} von Ihnen ausgeliehene Leihgeräte`} der Schule ${p.count === 1 ? "ist" : "sind"}`;
  return {
    subject: `${p.school}: Leihgerät zurückgeben (${p.level}. Erinnerung)`,
    text: [
      "Guten Tag,",
      "",
      `${what} seit dem ${formatLoanDay(p.since)} zur Rückgabe fällig (${p.level}. Erinnerung).`,
      "Bitte zurückgeben oder die Frist verlängern lassen. Um welches Gerät es geht, steht nach der Anmeldung unter „Meine Leihgeräte“:",
      "",
      p.link,
      mailFooter(p.school),
    ].join("\n"),
  };
}

interface Bucket {
  level: number;
  count: number;
  since: string;
}

function add(map: Map<string, Bucket>, key: string, level: number, dueOn: string) {
  const b = map.get(key);
  if (!b) map.set(key, { level, count: 1, since: dueOn });
  else map.set(key, { level: Math.max(b.level, level), count: b.count + 1, since: dueOn < b.since ? dueOn : b.since });
}

export const MY_LOANS_HREF = "/gebaeude/leihen/meine";

/** Pflegende einer Kategorie: Recht `inventory`/`configure` bzw. Beschäftigte der verantwortlichen Gruppe. */
async function lenders(db: Db, categoryIds: readonly string[]): Promise<string[]> {
  const ids = new Set([...(await usersWithPermission(db, INVENTORY_PERMISSION)), ...(await usersWithPermission(db, "gebaeude.configure"))]);
  if (categoryIds.length) {
    const rows = await db
      .select({ userId: groupMembers.userId, role: users.role, status: users.status })
      .from(gebaeudeAssetCategories)
      .innerJoin(groupMembers, eq(groupMembers.groupId, gebaeudeAssetCategories.responsibleGroupId))
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(inArray(gebaeudeAssetCategories.id, [...categoryIds]));
    for (const r of rows) if (r.status === "active" && isStaffRole(r.role)) ids.add(r.userId);
  }
  return [...ids];
}

export interface LoanRunOptions {
  /** Mailversand eingerichtet (bzw. in Entwicklung lesbar) */
  mail: boolean;
  school: string;
}

/**
 * Täglicher Lauf: erst vor dem Rückgabedatum erinnern (gebündelter Gong je Person), dann – nur an Schultagen – überfällige: bis zu
 * drei Erinnerungen im Abstand von 7 Tagen (Stufe wie Bücherei-Mahnungen, `nextDunningLevel`), ab der zweiten auch die Eltern
 * Minderjähriger („handelt für“), bei der ersten ein Hinweis an die Pflegenden. Jede Stufe wird mit einem bedingten UPDATE
 * vergeben (zweiter Prozess vergibt sie nicht doppelt). Benachrichtigungen und Mails nennen kein Gerät (nur „Meine Leihgeräte“ nach der Anmeldung).
 */
export async function runLoanReminders(db: Db, today: string, opts: LoanRunOptions, now = new Date()): Promise<{ reminded: number; overdue: number; parents: number; staff: number }> {
  let reminded = 0;
  const days = Number(await readModuleSetting(db, LOAN_REMIND_DAYS));
  if (days > 0) {
    const rows = await db
      .update(gebaeudeLoans)
      .set({ remindedDueOn: sql`${gebaeudeLoans.dueOn}` })
      .where(
        and(
          isNull(gebaeudeLoans.returnedAt),
          isNotNull(gebaeudeLoans.userId),
          gte(gebaeudeLoans.dueOn, today),
          lte(gebaeudeLoans.dueOn, addDays(today, days)),
          or(isNull(gebaeudeLoans.remindedDueOn), ne(gebaeudeLoans.remindedDueOn, gebaeudeLoans.dueOn)),
        ),
      )
      .returning({ userId: gebaeudeLoans.userId, dueOn: gebaeudeLoans.dueOn });
    const per = new Map<string, Bucket>();
    for (const r of rows) add(per, r.userId!, 0, r.dueOn);
    reminded = await notifyBundled(
      db,
      [...per].map(([userId, b]) => ({
        userId,
        title: "Leihgerät: Rückgabe bald fällig",
        body: `${devicesText(b.count)} am ${formatLoanDay(b.since)} zurückzugeben – bitte rechtzeitig abgeben oder verlängern lassen. Welche: unter „Meine Leihgeräte“.`,
        href: MY_LOANS_HREF,
      })),
      { moduleId: "gebaeude", bundleKey: "gebaeude:leihe:erinnerung" },
    );
  }
  if (!(await isOpenDay(db, today))) return { reminded, overdue: 0, parents: 0, staff: 0 };

  const candidates = await db
    .select({ id: gebaeudeLoans.id, userId: gebaeudeLoans.userId, dueOn: gebaeudeLoans.dueOn, overdueLevel: gebaeudeLoans.overdueLevel, overdueOn: gebaeudeLoans.overdueOn, categoryId: gebaeudeAssets.categoryId })
    .from(gebaeudeLoans)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeLoans.assetId))
    .where(and(isNull(gebaeudeLoans.returnedAt), lt(gebaeudeLoans.dueOn, today), lt(gebaeudeLoans.overdueLevel, LOAN_MAX_OVERDUE_LEVEL)))
    .orderBy(asc(gebaeudeLoans.dueOn), asc(gebaeudeLoans.id));
  const per = new Map<string, Bucket>();
  const firstTime = new Set<string>();
  let firstCount = 0;
  for (const l of candidates) {
    const level = nextDunningLevel({ dueOn: l.dueOn, dunningLevel: l.overdueLevel, dunnedOn: l.overdueOn }, today, LOAN_OVERDUE_INTERVAL_DAYS);
    if (level === null) continue;
    const [done] = await db
      .update(gebaeudeLoans)
      .set({ overdueLevel: level, overdueOn: today })
      .where(and(eq(gebaeudeLoans.id, l.id), eq(gebaeudeLoans.overdueLevel, l.overdueLevel), isNull(gebaeudeLoans.returnedAt)))
      .returning({ id: gebaeudeLoans.id });
    if (!done) continue;
    if (level === 1) {
      firstTime.add(l.categoryId);
      firstCount++;
    }
    if (l.userId) add(per, l.userId, level, l.dueOn);
  }

  // Pflegende: bei der ersten Erinnerung ein gebündelter Hinweis (Übersicht „Leihgeräte“), ohne Namen
  let staff = 0;
  if (firstCount > 0) {
    const to = await lenders(db, [...firstTime]);
    staff = await notifyBundled(
      db,
      to.map((userId) => ({ userId, title: "Leihgeräte überfällig", body: `${devicesText(firstCount)} seit heute überfällig. Übersicht unter „Leihgeräte“.`, href: "/gebaeude/leihen" })),
      { moduleId: "gebaeude", bundleKey: "gebaeude:leihe:ueberfaellig" },
    );
  }
  if (!per.size) return { reminded, overdue: 0, parents: 0, staff };

  const people = await db
    .select({ id: users.id, role: users.role, firstName: users.firstName, selfResponsible: users.selfResponsible })
    .from(users)
    .where(inArray(users.id, [...per.keys()]));
  const byId = new Map(people.map((u) => [u.id, u]));
  const minors = [...per].filter(([id, b]) => b.level >= LOAN_PARENT_LEVEL && byId.get(id)?.role === "schueler" && !byId.get(id)?.selfResponsible).map(([id]) => id);
  const links = await parentLinks(db, minors, "act");
  const informed = new Set(links.map((l) => l.childId));
  const childName = (id: string) => byId.get(id)?.firstName?.trim() || "Ihrem Kind";

  await notifyBundled(
    db,
    [...per].map(([userId, b]) => ({
      userId,
      title: `Leihgerät überfällig (${b.level}. Erinnerung)`,
      body: `${devicesText(b.count)} seit dem ${formatLoanDay(b.since)} zur Rückgabe fällig – bitte zurückgeben.${informed.has(userId) ? " Deine Eltern werden ebenfalls benachrichtigt." : ""} Welche: unter „Meine Leihgeräte“.`,
      href: MY_LOANS_HREF,
    })),
    { moduleId: "gebaeude", bundleKey: "gebaeude:leihe:mahnung" },
  );
  for (const l of links) {
    const b = per.get(l.childId)!;
    const child = childName(l.childId);
    await notifyBundled(
      db,
      [
        {
          userId: l.parentId,
          title: `Leihgerät von ${child} überfällig`,
          body: `${b.count === 1 ? "Ein Leihgerät" : `${b.count} Leihgeräte`} von ${child} ${b.count === 1 ? "ist" : "sind"} seit dem ${formatLoanDay(b.since)} zur Rückgabe fällig – bitte an die Rückgabe erinnern. Welche: unter „Meine Leihgeräte“.`,
          href: MY_LOANS_HREF,
        },
      ],
      { moduleId: "gebaeude", bundleKey: `gebaeude:leihe:mahnung:${l.childId}` },
    );
  }

  if (opts.mail && (await readModuleSetting(db, LOAN_MAIL)) === "1") {
    const emails = await verifiedEmails(db, [...per.keys(), ...links.map((l) => l.parentId)]);
    const link = appUrl(MY_LOANS_HREF);
    for (const [userId, b] of per) {
      const to = emails.get(userId);
      if (to) await enqueueMail(db, { to, ...overdueLoanMail({ school: opts.school, level: b.level, count: b.count, since: b.since, link }), purpose: "gebaeude-leihe" }, now);
    }
    for (const l of links) {
      const to = emails.get(l.parentId);
      const b = per.get(l.childId)!;
      if (to) await enqueueMail(db, { to, ...overdueLoanMail({ school: opts.school, level: b.level, count: b.count, since: b.since, link, child: childName(l.childId) }), purpose: "gebaeude-leihe" }, now);
    }
  }
  return { reminded, overdue: per.size, parents: links.length, staff };
}
