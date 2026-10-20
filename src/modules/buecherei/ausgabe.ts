// Schulbücherei Stufe 2 – Ausgabe und Rücknahme von Schulbüchern (BU-11, docs/BUECHEREI.md „Stufe 2 – Festlegungen“). Nur mit
// dem Schalter `buecherei.lernmittel` und dem Recht `buecherei.materials`. Ausgabe klassen- bzw. kursweise per Scan (Ausweis oder
// Person wählen, Inventarnummern `L-…` scannen), Rücknahme nur scannen – mit Zustandsvermerk am Exemplar (ohne Person).
// Löschregel: Die Zuordnung Exemplar ↔ Person gehört zum laufenden Schuljahr; Rücknahme ohne Befund löscht sie sofort (kein
// Verlauf), mit Befund bleibt sie bis zur Erledigung (danach LK-SJ-1J), Nicht-Zurückgegebenes bleibt als offener Posten und geht
// spätestens mit dem Konto. Ausgabe und Rücknahme stehen im Audit-Log nur mit der Inventarnummer, ohne Person.
// Mahnung nach Ablauf der Rückgabefrist: Eltern Minderjähriger schon ab der 1. Stufe (Entscheidung 4), ohne Titel.
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { buechereiMaterialCopies, buechereiMaterialIssues, buechereiTeachingMaterials, groupMembers, groups, schoolYears, users } from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { mailFooter, type MailContent } from "@/core/mail-templates";
import { readModuleSetting } from "@/core/modules/settings";
import { notifyBundled } from "@/core/notifications";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { childrenOf, parentLinks } from "@/core/school/majority";
import { ValidationError } from "@/modules/verwaltung/users";
import { verifiedEmails } from "@/modules/sprechtag/mails";
import { cardOwner, isCardCode } from "./cards";
import { isOpenDay } from "./dates";
import { BORROWER_ROLES, COPY_CONDITIONS, MATERIAL_PREFIX, isValidCopyNumber, type CopyCondition } from "./labels";
import { canMaterials, lernmittelEnabled } from "./lernmittel";
import { classNamesOf, normalizeScan } from "./loans";
import { MAX_DUNNING_LEVEL, nextDunningLevel } from "./mahnungen";
import { fmtDay } from "./reservations";
import { DUNNING_DAYS, DUNNING_MAIL } from "./settings";

/** Gruppen, über die ausgegeben wird: Klassen und Kurse (auch Wahlpflicht). */
export const ISSUE_GROUP_KINDS = ["klasse", "kurs", "wahlpflicht"] as const;

export const MAX_ISSUE_FINDING = 200;
export const MAX_CONDITION_NOTE = 200;
/** Eltern Minderjähriger erfahren es bei Schulbüchern schon ab der 1. Mahnung (Entscheidung 4, anders als Stufe 1). */
export const SCHOOLBOOK_PARENT_LEVEL = 1;

async function requireIssue(db: Db, p: PermissionSet) {
  if (!canMaterials(p)) throw new ForbiddenError("buecherei.materials");
  if (!(await lernmittelEnabled(db))) throw new ValidationError({ code: "Die Schulbuchausleihe ist ausgeschaltet (Verwaltung → Rechte & Module → Bücherei)" });
}

/** Rein: ist das eine Inventarnummer der Lernmittel (`L-…`)? Die Prüfziffer prüft `isValidCopyNumber`. */
export const isMaterialNumber = (code: string) => code.startsWith(`${MATERIAL_PREFIX}-`);

/** Laufendes Schuljahr – ohne gibt es keine Ausgabe (die Zuordnung gilt nur dafür). */
export async function currentSchoolYear(db: Db): Promise<{ id: string; name: string; endsOn: string } | null> {
  const [y] = await db.select({ id: schoolYears.id, name: schoolYears.name, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  return y ?? null;
}

async function requireYear(db: Db) {
  const y = await currentSchoolYear(db);
  if (!y) throw new ValidationError({ code: "Kein laufendes Schuljahr – erst unter Verwaltung → Stammdaten anlegen" });
  return y;
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

// ---------------------------------------------------------------- Lesen (Ausgabe-Seite)

/** Klassen und Kurse mit Zahl der Schüler:innen und der im laufenden Schuljahr ausgegebenen Schulbücher. */
export async function issueGroups(db: Db, viewer: PermissionSet) {
  await requireIssue(db, viewer);
  const year = await currentSchoolYear(db);
  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel, userId: groupMembers.userId })
    .from(groups)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.role, "member")))
    .innerJoin(users, and(eq(users.id, groupMembers.userId), eq(users.status, "active"), eq(users.role, "schueler")))
    .where(and(inArray(groups.kind, [...ISSUE_GROUP_KINDS]), isNull(groups.archivedAt)));
  const ids = [...new Set(rows.map((r) => r.userId))];
  const issued = new Map<string, number>();
  if (year && ids.length)
    for (const r of await db
      .select({ userId: buechereiMaterialIssues.userId })
      .from(buechereiMaterialIssues)
      .where(and(inArray(buechereiMaterialIssues.userId, ids), eq(buechereiMaterialIssues.schoolYearId, year.id), isNull(buechereiMaterialIssues.returnedOn))))
      issued.set(r.userId!, (issued.get(r.userId!) ?? 0) + 1);
  const by = new Map<string, { id: string; name: string; kind: string; gradeLevel: number | null; students: number; books: number }>();
  for (const r of rows) {
    const e = by.get(r.id) ?? { id: r.id, name: r.name, kind: r.kind, gradeLevel: r.gradeLevel, students: 0, books: 0 };
    e.students++;
    e.books += issued.get(r.userId) ?? 0;
    by.set(r.id, e);
  }
  return [...by.values()].sort(
    (a, b) => Number(a.kind !== "klasse") - Number(b.kind !== "klasse") || (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.name.localeCompare(b.name, "de", { numeric: true }),
  );
}

export interface IssuedBook {
  issueId: string;
  copyId: string;
  materialId: string;
  inventoryNumber: string;
  title: string;
  issuedOn: string;
  dueOn: string;
  /** aus einem früheren Schuljahr nicht zurückgegeben (offener Posten) */
  previousYear: boolean;
  overdue: boolean;
  dunningLevel: number;
}

async function openIssuesOf(db: Db, userIds: readonly string[], today: string, yearId: string | null): Promise<Map<string, IssuedBook[]>> {
  const out = new Map<string, IssuedBook[]>();
  if (!userIds.length) return out;
  const rows = await db
    .select({
      issueId: buechereiMaterialIssues.id,
      userId: buechereiMaterialIssues.userId,
      copyId: buechereiMaterialIssues.copyId,
      materialId: buechereiMaterialCopies.materialId,
      inventoryNumber: buechereiMaterialCopies.inventoryNumber,
      title: buechereiTeachingMaterials.title,
      issuedOn: buechereiMaterialIssues.issuedOn,
      dueOn: buechereiMaterialIssues.dueOn,
      schoolYearId: buechereiMaterialIssues.schoolYearId,
      dunningLevel: buechereiMaterialIssues.dunningLevel,
    })
    .from(buechereiMaterialIssues)
    .innerJoin(buechereiMaterialCopies, eq(buechereiMaterialCopies.id, buechereiMaterialIssues.copyId))
    .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
    .where(and(inArray(buechereiMaterialIssues.userId, [...userIds]), isNull(buechereiMaterialIssues.returnedOn)))
    .orderBy(asc(buechereiMaterialIssues.dueOn), asc(buechereiMaterialCopies.seq));
  for (const r of rows) {
    const list = out.get(r.userId!) ?? [];
    list.push({
      issueId: r.issueId,
      copyId: r.copyId,
      materialId: r.materialId,
      inventoryNumber: r.inventoryNumber,
      title: r.title,
      issuedOn: r.issuedOn,
      dueOn: r.dueOn,
      previousYear: r.schoolYearId !== yearId,
      overdue: r.dueOn < today,
      dunningLevel: r.dunningLevel,
    });
    out.set(r.userId!, list);
  }
  return out;
}

/**
 * Eine Klasse bzw. ein Kurs für die Ausgabe: Schüler:innen mit ihren offenen Schulbüchern und den Lernmitteln des Jahrgangs
 * (nur „leiht die Schule aus“, bei Kursen mit Fach nur dieses Fach), die ihnen noch fehlen.
 */
export async function issueGroup(db: Db, viewer: PermissionSet, groupId: string, today: string) {
  await requireIssue(db, viewer);
  const [g] = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel, subjectId: groups.subjectId })
    .from(groups)
    .where(and(eq(groups.id, groupId), inArray(groups.kind, [...ISSUE_GROUP_KINDS]), isNull(groups.archivedAt)));
  if (!g) return null;
  const year = await currentSchoolYear(db);
  const members = await db
    .select({ id: users.id, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.role, "member"), eq(users.status, "active"), eq(users.role, "schueler")))
    .orderBy(de(users.lastName), de(users.firstName), users.id);
  const materials = g.gradeLevel
    ? await db
        .select({ id: buechereiTeachingMaterials.id, title: buechereiTeachingMaterials.title, course: buechereiTeachingMaterials.course, subjectId: buechereiTeachingMaterials.subjectId })
        .from(buechereiTeachingMaterials)
        .where(
          and(
            isNull(buechereiTeachingMaterials.archivedOn),
            eq(buechereiTeachingMaterials.provision, "leihe"),
            sql`${g.gradeLevel} = any(${buechereiTeachingMaterials.grades})`,
            g.kind !== "klasse" && g.subjectId ? eq(buechereiTeachingMaterials.subjectId, g.subjectId) : undefined,
          ),
        )
        .orderBy(asc(buechereiTeachingMaterials.title))
    : [];
  const books = await openIssuesOf(
    db,
    members.map((m) => m.id),
    today,
    year?.id ?? null,
  );
  const students = members.map((m) => {
    const mine = books.get(m.id) ?? [];
    const have = new Set(mine.filter((b) => !b.previousYear).map((b) => b.materialId));
    return { ...m, books: mine, missing: materials.filter((x) => !have.has(x.id)).map((x) => ({ id: x.id, title: x.title, course: x.course })) };
  });
  return { group: g, year, materials, students };
}

/** Kopfzahlen: offen im laufenden Schuljahr, offene Posten aus früheren Jahren bzw. überfällig, offene Befunde. */
export async function issueSummary(db: Db, viewer: PermissionSet, today: string) {
  await requireIssue(db, viewer);
  const year = await currentSchoolYear(db);
  const rows = await db
    .select({ schoolYearId: buechereiMaterialIssues.schoolYearId, dueOn: buechereiMaterialIssues.dueOn, returnedOn: buechereiMaterialIssues.returnedOn, resolved: buechereiMaterialIssues.findingResolvedOn })
    .from(buechereiMaterialIssues);
  const open = rows.filter((r) => !r.returnedOn);
  return {
    year: year?.name ?? null,
    issued: open.filter((r) => r.schoolYearId === year?.id && r.dueOn >= today).length,
    overdue: open.filter((r) => r.schoolYearId !== year?.id || r.dueOn < today).length,
    findings: rows.filter((r) => r.returnedOn && !r.resolved).length,
  };
}

/** Eine gewählte Person an der Ausgabe: Name, Klasse und offene Schulbücher. */
export async function issuePerson(db: Db, viewer: PermissionSet, userId: string, today: string) {
  await requireIssue(db, viewer);
  const [u] = await db.select({ id: users.id, name: users.name, role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u || !BORROWER_ROLES.includes(u.role)) return null;
  const year = await currentSchoolYear(db);
  const [cls, books] = await Promise.all([classNamesOf(db, [u.id]), openIssuesOf(db, [u.id], today, year?.id ?? null)]);
  return { id: u.id, name: u.name, className: cls.get(u.id) ?? null, active: u.status === "active", books: books.get(u.id) ?? [] };
}

// ---------------------------------------------------------------- Ausgabe und Rücknahme

async function materialCopy(db: Db, code: string) {
  if (!isValidCopyNumber(code) || !isMaterialNumber(code)) throw new ValidationError({ code: `„${code}“ ist keine gültige Inventarnummer eines Schulbuchs (L-…, Prüfziffer)` });
  const [c] = await db
    .select({
      id: buechereiMaterialCopies.id,
      materialId: buechereiMaterialCopies.materialId,
      inventoryNumber: buechereiMaterialCopies.inventoryNumber,
      withdrawnOn: buechereiMaterialCopies.withdrawnOn,
      title: buechereiTeachingMaterials.title,
      provision: buechereiTeachingMaterials.provision,
    })
    .from(buechereiMaterialCopies)
    .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
    .where(eq(buechereiMaterialCopies.inventoryNumber, code));
  if (!c) throw new ValidationError({ code: `Schulbuch ${code} gibt es nicht` });
  return c;
}

async function openIssueOfCopy(db: Db, copyId: string) {
  const [i] = await db
    .select({ id: buechereiMaterialIssues.id, userId: buechereiMaterialIssues.userId, dueOn: buechereiMaterialIssues.dueOn })
    .from(buechereiMaterialIssues)
    .where(and(eq(buechereiMaterialIssues.copyId, copyId), isNull(buechereiMaterialIssues.returnedOn)));
  return i ?? null;
}

/**
 * Schulbuch an eine Person ausgeben (laufendes Schuljahr, fällig zu dessen Ende). Nicht ausgesondert, nicht schon ausgegeben,
 * und dieselbe Person hat dieses Lernmittel im Schuljahr noch nicht (Doppelscan). Audit nur mit Inventarnummer.
 */
export async function issueCopy(db: Db, viewer: PermissionSet, userId: string, rawCode: string, today: string): Promise<{ title: string; inventoryNumber: string; dueOn: string }> {
  await requireIssue(db, viewer);
  const code = normalizeScan(rawCode);
  const copy = await materialCopy(db, code);
  if (copy.withdrawnOn) throw new ValidationError({ code: `${code} ist ausgesondert und wird nicht ausgegeben` });
  if (await openIssueOfCopy(db, copy.id)) throw new ValidationError({ code: `${code} ist schon ausgegeben – erst zurücknehmen` });
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u || !BORROWER_ROLES.includes(u.role)) throw new ValidationError({ code: "Diese Person bekommt keine Schulbücher" });
  if (u.status !== "active") throw new ValidationError({ code: "Konto gesperrt – keine neue Ausgabe" });
  const year = await requireYear(db);
  const [dup] = await db
    .select({ nr: buechereiMaterialCopies.inventoryNumber })
    .from(buechereiMaterialIssues)
    .innerJoin(buechereiMaterialCopies, eq(buechereiMaterialCopies.id, buechereiMaterialIssues.copyId))
    .where(
      and(
        eq(buechereiMaterialIssues.userId, userId),
        eq(buechereiMaterialIssues.schoolYearId, year.id),
        isNull(buechereiMaterialIssues.returnedOn),
        eq(buechereiMaterialCopies.materialId, copy.materialId),
      ),
    );
  if (dup) throw new ValidationError({ code: `Hat „${copy.title}“ schon (${dup.nr}) – ${code} nicht ausgegeben` });
  try {
    await db.insert(buechereiMaterialIssues).values({ copyId: copy.id, userId, schoolYearId: year.id, issuedOn: today, dueOn: year.endsOn });
  } catch (err) {
    // zwei Plätze scannen dasselbe Exemplar gleichzeitig – der eindeutige Index lässt nur eine Ausgabe zu
    if (isUniqueViolation(err)) throw new ValidationError({ code: `${code} wurde gerade ausgegeben – erst zurücknehmen` });
    throw err;
  }
  await audit(db, viewer.userId, "buecherei.material.issue", copy.materialId, { inventoryNumber: code });
  return { title: copy.title, inventoryNumber: code, dueOn: year.endsOn };
}

export interface TakeBackInput {
  /** neuer Zustand des Exemplars; leer = unverändert */
  condition?: string | null;
  /** Zustandsvermerk zur Sache („Einband lose“) – keine Namen; leer = unverändert */
  conditionNote?: string | null;
  /** Befund (Schaden, fehlt etwas) → Zeile bleibt bis zur Erledigung (Ersatzforderung, BU-12) */
  finding?: string | null;
}

/**
 * Rücknahme – nur scannen, ohne die Person zu wählen. Zustand und Vermerk landen am Exemplar (ohne Person). Ohne Befund wird
 * die Zuordnung gelöscht; mit Befund bleibt sie (mit Person) bis zur Erledigung und steht im Audit-Log.
 */
export async function takeBack(
  db: Db,
  viewer: PermissionSet,
  rawCode: string,
  today: string,
  input: TakeBackInput = {},
): Promise<{ title: string; inventoryNumber: string; overdueDays: number; finding: boolean; condition: CopyCondition | null }> {
  await requireIssue(db, viewer);
  const code = normalizeScan(rawCode);
  const fe: Record<string, string> = {};
  const condition = input.condition?.trim() || null;
  if (condition && !(COPY_CONDITIONS as readonly string[]).includes(condition)) fe.condition = "Zustand wählen";
  const note = input.conditionNote?.trim() || null;
  if (note && note.length > MAX_CONDITION_NOTE) fe.conditionNote = `Vermerk höchstens ${MAX_CONDITION_NOTE} Zeichen`;
  const finding = input.finding?.trim() || null;
  if (finding && (finding.length < 2 || finding.length > MAX_ISSUE_FINDING)) fe.finding = `Befund mit 2 bis ${MAX_ISSUE_FINDING} Zeichen`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const copy = await materialCopy(db, code);
  const issue = await openIssueOfCopy(db, copy.id);
  if (!issue) throw new ValidationError({ code: `${code} ist nicht ausgegeben` });
  const overdueDays = issue.dueOn < today ? Math.round((Date.parse(today) - Date.parse(issue.dueOn)) / 86_400_000) : 0;
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    if (condition || note)
      await tx
        .update(buechereiMaterialCopies)
        .set({ ...(condition ? { condition: condition as CopyCondition } : {}), ...(note ? { conditionNote: note } : {}) })
        .where(eq(buechereiMaterialCopies.id, copy.id));
    if (!finding) await tx.delete(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.id, issue.id));
    else await tx.update(buechereiMaterialIssues).set({ returnedOn: today, finding, dunningLevel: 0, dunnedOn: null }).where(eq(buechereiMaterialIssues.id, issue.id));
  });
  await audit(db, viewer.userId, "buecherei.material.return", copy.materialId, { inventoryNumber: code, ...(condition ? { condition } : {}) });
  if (finding) await audit(db, viewer.userId, "buecherei.material.finding", issue.id, { inventoryNumber: code, finding });
  return { title: copy.title, inventoryNumber: code, overdueDays, finding: !!finding, condition: condition as CopyCondition | null };
}

export type IssueScanResult =
  | { kind: "person"; userId: string }
  | { kind: "issue"; title: string; inventoryNumber: string; dueOn: string }
  | { kind: "return"; title: string; inventoryNumber: string; overdueDays: number; finding: boolean; condition: CopyCondition | null };

/**
 * Ein Scan an der Schulbuchausgabe: Ausweis → Person wählen; Schulbuch ausgegeben → Rücknahme (egal, welche Person gewählt ist;
 * mit Zustand/Befund aus dem Formular); sonst Ausgabe an die gewählte Person. Büchereiexemplare (`B-…`) gehören an die Theke.
 */
export async function scanIssue(db: Db, viewer: PermissionSet, rawCode: string, personId: string | null, today: string, input: TakeBackInput = {}): Promise<IssueScanResult> {
  await requireIssue(db, viewer);
  const code = normalizeScan(rawCode);
  if (!code) throw new ValidationError({ code: "Ausweis oder Schulbuch scannen" });
  if (isCardCode(code)) {
    const userId = await cardOwner(db, code);
    if (!userId) throw new ValidationError({ code: "Ausweis unbekannt oder ersetzt – Person in der Liste wählen" });
    return { kind: "person", userId };
  }
  if (isValidCopyNumber(code) && !isMaterialNumber(code)) throw new ValidationError({ code: `${code} ist ein Bücherei-Exemplar – an der Theke verbuchen` });
  const copy = await materialCopy(db, code);
  if (await openIssueOfCopy(db, copy.id)) return { kind: "return", ...(await takeBack(db, viewer, code, today, input)) };
  if (input.finding?.trim()) throw new ValidationError({ code: `${code} ist nicht ausgegeben – ein Befund gehört zur Rücknahme` });
  if (!personId) throw new ValidationError({ code: `${code} ist nicht ausgegeben – für die Ausgabe erst die Person wählen` });
  return { kind: "issue", ...(await issueCopy(db, viewer, personId, code, today)) };
}

// ---------------------------------------------------------------- Befunde (Verwaltung)

/** Offene Befunde aus Rücknahmen mit Person – Grundlage einer Ersatzforderung (BU-12). */
export async function issueFindings(db: Db, viewer: PermissionSet) {
  await requireIssue(db, viewer);
  const rows = await db
    .select({
      id: buechereiMaterialIssues.id,
      inventoryNumber: buechereiMaterialCopies.inventoryNumber,
      title: buechereiTeachingMaterials.title,
      returnedOn: buechereiMaterialIssues.returnedOn,
      finding: buechereiMaterialIssues.finding,
      userId: buechereiMaterialIssues.userId,
      name: users.name,
    })
    .from(buechereiMaterialIssues)
    .innerJoin(buechereiMaterialCopies, eq(buechereiMaterialCopies.id, buechereiMaterialIssues.copyId))
    .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
    .leftJoin(users, eq(users.id, buechereiMaterialIssues.userId))
    .where(and(isNotNull(buechereiMaterialIssues.returnedOn), isNull(buechereiMaterialIssues.findingResolvedOn)))
    .orderBy(asc(buechereiMaterialIssues.returnedOn), asc(buechereiMaterialCopies.seq));
  const cls = await classNamesOf(
    db,
    rows.map((r) => r.userId).filter((x): x is string => !!x),
  );
  return rows.map((r) => ({ ...r, className: r.userId ? (cls.get(r.userId) ?? null) : null }));
}

/** Befund erledigt (ersetzt, repariert, erlassen) – danach Löschung nach LK-SJ-1J. */
export async function resolveIssueFinding(db: Db, viewer: PermissionSet, issueId: string, today: string): Promise<void> {
  await requireIssue(db, viewer);
  const [r] = await db
    .update(buechereiMaterialIssues)
    .set({ findingResolvedOn: today })
    .where(and(eq(buechereiMaterialIssues.id, issueId), isNotNull(buechereiMaterialIssues.returnedOn), isNull(buechereiMaterialIssues.findingResolvedOn)))
    .returning({ id: buechereiMaterialIssues.id });
  if (!r) throw new ValidationError({ issue: "Befund gibt es nicht oder ist schon erledigt" });
  await audit(db, viewer.userId, "buecherei.material.resolve", issueId);
}

// ---------------------------------------------------------------- Eigene Schulbücher, Eltern, Auskunft

/** Offene Schulbücher einer Person (eigene Sicht, Eltern) – nur mit eingeschalteter Schulbuchausleihe. */
export async function schoolbooksOf(db: Db, userId: string, today: string): Promise<IssuedBook[]> {
  const year = await currentSchoolYear(db);
  return (await openIssuesOf(db, [userId], today, year?.id ?? null)).get(userId) ?? [];
}

/** Eltern (nur lesend): Schulbücher der Kinder, über die sie informiert werden. */
export async function childrenSchoolbooks(db: Db, viewer: PermissionSet, today: string): Promise<{ id: string; name: string; books: IssuedBook[] }[]> {
  if (viewer.role !== "eltern" || viewer.locked || !(await lernmittelEnabled(db))) return [];
  const kids = await childrenOf(db, viewer.userId, "inform");
  const out: { id: string; name: string; books: IssuedBook[] }[] = [];
  for (const k of [...kids].sort((a, b) => a.name.localeCompare(b.name, "de"))) out.push({ id: k.id, name: k.name, books: await schoolbooksOf(db, k.id, today) });
  return out;
}

/** Lesbarer Teil der Auskunft (Art. 15): offene Schulbücher und Rücknahmen mit Befund – unabhängig vom Schalter. */
export async function schoolbookAuskunft(db: Db, userId: string) {
  return db
    .select({
      titel: buechereiTeachingMaterials.title,
      inventarnummer: buechereiMaterialCopies.inventoryNumber,
      schuljahr: schoolYears.name,
      ausgegeben: buechereiMaterialIssues.issuedOn,
      faellig: buechereiMaterialIssues.dueOn,
      mahnstufe: buechereiMaterialIssues.dunningLevel,
      zurueck: buechereiMaterialIssues.returnedOn,
      befund: buechereiMaterialIssues.finding,
      befundErledigt: buechereiMaterialIssues.findingResolvedOn,
    })
    .from(buechereiMaterialIssues)
    .innerJoin(buechereiMaterialCopies, eq(buechereiMaterialCopies.id, buechereiMaterialIssues.copyId))
    .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
    .innerJoin(schoolYears, eq(schoolYears.id, buechereiMaterialIssues.schoolYearId))
    .where(eq(buechereiMaterialIssues.userId, userId))
    .orderBy(asc(buechereiMaterialIssues.issuedOn), asc(buechereiMaterialCopies.seq));
}

/** Rein: Text für den Eigenexport – nur, wenn es etwas gibt. */
export function schoolbookText(rows: Awaited<ReturnType<typeof schoolbookAuskunft>>): string | null {
  if (!rows.length) return null;
  const lines = ["Schulbücher – aktueller Stand (zurückgegebene Schulbücher werden nicht gespeichert)", ""];
  for (const r of rows)
    lines.push(
      r.zurueck
        ? `- ${r.titel} (${r.inventarnummer}), zurück am ${fmtDay(r.zurueck)} mit Befund: ${r.befund ?? ""}${r.befundErledigt ? ` (erledigt am ${fmtDay(r.befundErledigt)})` : ""}`
        : `- ${r.titel} (${r.inventarnummer}), Schuljahr ${r.schuljahr}, ausgegeben am ${fmtDay(r.ausgegeben)}, zurück bis ${fmtDay(r.faellig)}${r.mahnstufe ? `, ${r.mahnstufe}. Mahnung` : ""}`,
    );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------- Mahnungen nach Ablauf der Rückgabefrist

const booksText = (n: number) => (n === 1 ? "Ein Schulbuch ist" : `${n} Schulbücher sind`);

/** Mail einer Schulbuch-Mahnung – ohne Titel, nur mit Link zur Anmeldung. `child` = Vorname, wenn die Mail an Eltern geht. */
export function schoolbookMail(p: { school: string; level: number; count: number; since: string; link: string; child?: string }): MailContent {
  const what = p.child
    ? `${p.count === 1 ? "ein Schulbuch" : `${p.count} Schulbücher`} von ${p.child} ${p.count === 1 ? "ist" : "sind"}`
    : `${p.count === 1 ? "ein ausgeliehenes Schulbuch" : `${p.count} ausgeliehene Schulbücher`} ${p.count === 1 ? "ist" : "sind"}`;
  return {
    subject: `${p.school}: ${p.level}. Mahnung – Schulbücher`,
    text: [
      "Guten Tag,",
      "",
      `${what} seit dem ${fmtDay(p.since)} nicht zurückgegeben (${p.level}. Mahnung).`,
      "Bitte in der Schulbücherei abgeben. Um welche Bücher es geht, steht nach der Anmeldung unter „Bücherei“:",
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

/**
 * Täglicher Lauf (mit dem Job `buecherei-mahnungen`, nur mit eingeschalteter Schulbuchausleihe und nur an Schultagen): nicht
 * zurückgegebene Schulbücher nach Ablauf der Frist mahnen, Stufen 1–3 im eingestellten Abstand (wie Stufe 1). Eltern
 * Minderjähriger (handelt für, nicht bei Eigenständigen) schon ab der 1. Stufe; Mail wie in Stufe 1 optional. Ohne Titel.
 */
export async function runSchoolbookDunning(db: Db, today: string, opts: { mail: boolean; school: string }, now = new Date()): Promise<{ dunned: number; parents: number }> {
  if (!(await lernmittelEnabled(db)) || !(await isOpenDay(db, today))) return { dunned: 0, parents: 0 };
  const interval = Number(await readModuleSetting(db, DUNNING_DAYS));
  const candidates = await db
    .select({ id: buechereiMaterialIssues.id, userId: buechereiMaterialIssues.userId, dueOn: buechereiMaterialIssues.dueOn, dunningLevel: buechereiMaterialIssues.dunningLevel, dunnedOn: buechereiMaterialIssues.dunnedOn })
    .from(buechereiMaterialIssues)
    .where(
      and(
        isNull(buechereiMaterialIssues.returnedOn),
        isNotNull(buechereiMaterialIssues.userId),
        lt(buechereiMaterialIssues.dueOn, today),
        lt(buechereiMaterialIssues.dunningLevel, MAX_DUNNING_LEVEL),
      ),
    )
    .orderBy(asc(buechereiMaterialIssues.dueOn), asc(buechereiMaterialIssues.id));
  const per = new Map<string, Bucket>();
  for (const l of candidates) {
    const level = nextDunningLevel(l, today, interval);
    if (level === null) continue;
    const [done] = await db
      .update(buechereiMaterialIssues)
      .set({ dunningLevel: level, dunnedOn: today })
      .where(and(eq(buechereiMaterialIssues.id, l.id), eq(buechereiMaterialIssues.dunningLevel, l.dunningLevel), isNull(buechereiMaterialIssues.returnedOn)))
      .returning({ id: buechereiMaterialIssues.id });
    if (!done) continue;
    const b = per.get(l.userId!);
    per.set(l.userId!, b ? { level: Math.max(b.level, level), count: b.count + 1, since: l.dueOn < b.since ? l.dueOn : b.since } : { level, count: 1, since: l.dueOn });
  }
  if (!per.size) return { dunned: 0, parents: 0 };

  const people = await db
    .select({ id: users.id, role: users.role, firstName: users.firstName, selfResponsible: users.selfResponsible })
    .from(users)
    .where(inArray(users.id, [...per.keys()]));
  const byId = new Map(people.map((u) => [u.id, u]));
  const minors = [...per].filter(([id, b]) => b.level >= SCHOOLBOOK_PARENT_LEVEL && byId.get(id)?.role === "schueler" && !byId.get(id)?.selfResponsible).map(([id]) => id);
  const links = await parentLinks(db, minors, "act");
  const informed = new Set(links.map((l) => l.childId));
  const childName = (id: string) => byId.get(id)?.firstName?.trim() || "Ihrem Kind";

  await notifyBundled(
    db,
    [...per].map(([userId, b]) => ({
      userId,
      title: `${b.level}. Mahnung: Schulbücher`,
      body: `${booksText(b.count)} seit dem ${fmtDay(b.since)} nicht zurückgegeben – bitte in der Bücherei abgeben.${informed.has(userId) ? " Deine Eltern werden ebenfalls benachrichtigt." : ""} Welche: unter „Meine Ausleihen“.`,
      href: "/buecherei/meine",
    })),
    { moduleId: "buecherei", bundleKey: "buecherei:schulbuch-mahnung" },
  );
  for (const l of links) {
    const b = per.get(l.childId)!;
    const child = childName(l.childId);
    await notifyBundled(
      db,
      [
        {
          userId: l.parentId,
          title: `${b.level}. Mahnung: Schulbücher von ${child}`,
          body: `${b.count === 1 ? "Ein Schulbuch" : `${b.count} Schulbücher`} von ${child} ${b.count === 1 ? "ist" : "sind"} seit dem ${fmtDay(b.since)} nicht zurückgegeben – bitte an die Rückgabe erinnern. Welche: unter „Bücherei“.`,
          href: "/buecherei/meine",
        },
      ],
      { moduleId: "buecherei", bundleKey: `buecherei:schulbuch-mahnung:${l.childId}` },
    );
  }
  if (opts.mail && (await readModuleSetting(db, DUNNING_MAIL)) === "1") {
    const emails = await verifiedEmails(db, [...per.keys(), ...links.map((l) => l.parentId)]);
    const link = appUrl("/buecherei/meine");
    for (const [userId, b] of per) {
      const to = emails.get(userId);
      if (to) await enqueueMail(db, { to, ...schoolbookMail({ school: opts.school, level: b.level, count: b.count, since: b.since, link }), purpose: "buecherei-schulbuch" }, now);
    }
    for (const l of links) {
      const to = emails.get(l.parentId);
      const b = per.get(l.childId)!;
      if (to) await enqueueMail(db, { to, ...schoolbookMail({ school: opts.school, level: b.level, count: b.count, since: b.since, link, child: childName(l.childId) }), purpose: "buecherei-schulbuch" }, now);
    }
  }
  return { dunned: per.size, parents: links.length };
}
