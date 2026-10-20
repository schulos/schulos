// Schulbücherei Stufe 2 – Schulbuchausleihe (BU-10, docs/BUECHEREI.md): Lernmittel je Jahrgang/Fach/Kurs, Exemplare mit
// Inventarnummer (`L-…`, eigener Nummernkreis) und Zustand, Bücherliste für Eltern je Jahrgang. Nur mit dem Schalter
// `buecherei.lernmittel` (Vorgabe aus). Pflege mit `buecherei.materials`; veröffentlichte Bücherlisten lesen alle, die die
// Bücherei sehen (auch Eltern). Alles hier ist ohne Personenbezug – wem ein Schulbuch gehört, kommt erst mit BU-11 in eine
// eigene Zuordnung (nur im laufenden Schuljahr), nicht in die Ausleihe der Stufe 1.
import { and, asc, count, eq, ilike, inArray, isNotNull, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { buechereiBooklists, buechereiMaterialCopies, buechereiTeachingMaterials, gradeLevels, groupMembers, groups, subjects } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { childrenOf } from "@/core/school/majority";
import { ValidationError } from "@/modules/verwaltung/users";
import { COPY_CONDITIONS, MATERIAL_PROVISIONS, materialNumber, normalizeIsbn, parseEuro, type CopyCondition, type MaterialProvision } from "./labels";
import { LERNMITTEL } from "./settings";

/** Schalter Stufe 2 an? */
export async function lernmittelEnabled(db: Db): Promise<boolean> {
  return (await readModuleSetting(db, LERNMITTEL)) === "1";
}

export const canMaterials = (p: PermissionSet) => hasPermission(p, "buecherei.materials");

/** Wer Bücherlisten lesen darf: alle mit Bücherei-Zugang (Katalog, Theke, Bestand, Lernmittel) und Eltern. */
export const canReadBooklist = (p: PermissionSet) =>
  canMaterials(p) || hasPermission(p, "buecherei.use") || hasPermission(p, "buecherei.desk") || hasPermission(p, "buecherei.stock") || p.role === "eltern";

/** Stufe 2 aus → wie nicht vorhanden (Seiten 404, Aktionen mit Meldung). */
async function requireEnabled(db: Db) {
  if (!(await lernmittelEnabled(db))) throw new ValidationError({ lernmittel: "Die Schulbuchausleihe ist ausgeschaltet (Verwaltung → Rechte & Module → Bücherei)" });
}

async function requireMaterials(db: Db, p: PermissionSet) {
  if (!canMaterials(p)) throw new ForbiddenError("buecherei.materials");
  await requireEnabled(db);
}

/** Höchstens so viele Exemplare auf einmal (Klassensätze für mehrere Klassen). */
export const MAX_MATERIAL_COPIES_AT_ONCE = 300;
export const MAX_BOOKLIST_TEXT = 2000;

const trimOrNull = (s: string | null | undefined) => s?.trim() || null;

function intOrNull(raw: string | number | null | undefined): number | null | "bad" {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) ? n : "bad";
}

// ---------------------------------------------------------------- Lernmittel

export interface MaterialInput {
  title: string;
  author?: string | null;
  isbn?: string | null;
  publisher?: string | null;
  subjectId?: string | null;
  /** Jahrgänge, z. B. ["5", "6"] */
  grades: readonly (string | number)[];
  course?: string | null;
  provision: string;
  price?: string | null;
  note?: string | null;
}

async function validateMaterial(db: Db, input: MaterialInput, selfId?: string) {
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) fe.title = "Titel mit 1 bis 200 Zeichen";
  for (const [k, v, n] of [
    ["author", trimOrNull(input.author), 120],
    ["publisher", trimOrNull(input.publisher), 120],
    ["course", trimOrNull(input.course), 60],
    ["note", trimOrNull(input.note), 500],
  ] as const)
    if (v && v.length > n) fe[k] = `höchstens ${n} Zeichen`;
  const rawIsbn = trimOrNull(input.isbn);
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : null;
  if (rawIsbn && !isbn) fe.isbn = "keine gültige ISBN (Prüfziffer)";
  const subjectId = trimOrNull(input.subjectId);
  if (subjectId) {
    const [s] = await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, subjectId));
    if (!s) fe.subjectId = "Fach gibt es nicht";
  }
  const grades = [...new Set(input.grades.map((g) => Number(String(g).trim())))].filter((g) => Number.isInteger(g)).sort((a, b) => a - b);
  if (!grades.length) fe.grades = "mindestens einen Jahrgang wählen";
  else {
    const known = new Set((await db.select({ level: gradeLevels.level }).from(gradeLevels)).map((r) => r.level));
    if (grades.some((g) => !known.has(g))) fe.grades = "unbekannter Jahrgang";
  }
  if (!(MATERIAL_PROVISIONS as readonly string[]).includes(input.provision)) fe.provision = "Ausleihe oder Kauf wählen";
  const price = parseEuro(input.price);
  if (price === "bad") fe.price = "Preis in Euro, z. B. 24,50";
  if (isbn) {
    const [dup] = await db
      .select({ id: buechereiTeachingMaterials.id, title: buechereiTeachingMaterials.title })
      .from(buechereiTeachingMaterials)
      .where(eq(buechereiTeachingMaterials.isbn, isbn));
    if (dup && dup.id !== selfId) fe.isbn = `ISBN gehört schon zu „${dup.title}“ – dort Jahrgänge ergänzen`;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    title,
    author: trimOrNull(input.author),
    isbn,
    publisher: trimOrNull(input.publisher),
    subjectId,
    grades,
    course: trimOrNull(input.course),
    provision: input.provision as MaterialProvision,
    priceCents: price as number | null,
    note: trimOrNull(input.note),
  };
}

export async function createMaterial(db: Db, viewer: PermissionSet, input: MaterialInput, copies: CopiesInput = {}): Promise<{ id: string; numbers: string[] }> {
  await requireMaterials(db, viewer);
  const row = await validateMaterial(db, input);
  const c = validateCopies(copies, { allowZero: true });
  if (row.provision === "kauf" && c.count > 0) throw new ValidationError({ count: "Lernmittel zum Selbstkaufen haben keine Exemplare der Schule" });
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [m] = await tx.insert(buechereiTeachingMaterials).values(row).returning({ id: buechereiTeachingMaterials.id });
    const numbers = await insertCopies(tx, m!.id, c);
    await audit(tx, viewer.userId, "buecherei.material.create", m!.id, { title: row.title, grades: row.grades, copies: numbers.length });
    return { id: m!.id, numbers };
  });
}

export async function updateMaterial(db: Db, viewer: PermissionSet, id: string, input: MaterialInput): Promise<void> {
  await requireMaterials(db, viewer);
  const row = await validateMaterial(db, input, id);
  if (row.provision === "kauf") {
    const [c] = await db.select({ n: count() }).from(buechereiMaterialCopies).where(and(eq(buechereiMaterialCopies.materialId, id), isNull(buechereiMaterialCopies.withdrawnOn)));
    if ((c?.n ?? 0) > 0) throw new ValidationError({ provision: "Es gibt noch Exemplare der Schule – erst aussondern, dann auf „selbst kaufen“ umstellen" });
  }
  const [m] = await db
    .update(buechereiTeachingMaterials)
    .set({ ...row, updatedAt: new Date() })
    .where(eq(buechereiTeachingMaterials.id, id))
    .returning({ id: buechereiTeachingMaterials.id });
  if (!m) throw new ValidationError({ title: "Lernmittel gibt es nicht" });
  await audit(db, viewer.userId, "buecherei.material.update", id, { title: row.title, grades: row.grades });
}

/** Archivieren (nicht mehr auf Bücherlisten, z. B. neue Auflage) bzw. zurückholen. Exemplare bleiben. */
export async function setMaterialArchived(db: Db, viewer: PermissionSet, id: string, archived: boolean, today: string): Promise<void> {
  await requireMaterials(db, viewer);
  const [m] = await db
    .update(buechereiTeachingMaterials)
    .set({ archivedOn: archived ? today : null, updatedAt: new Date() })
    .where(and(eq(buechereiTeachingMaterials.id, id), archived ? isNull(buechereiTeachingMaterials.archivedOn) : isNotNull(buechereiTeachingMaterials.archivedOn)))
    .returning({ title: buechereiTeachingMaterials.title });
  if (!m) throw new ValidationError({ material: archived ? "Lernmittel gibt es nicht oder ist schon archiviert" : "Lernmittel gibt es nicht oder ist nicht archiviert" });
  await audit(db, viewer.userId, archived ? "buecherei.material.archive" : "buecherei.material.restore", id, { title: m.title });
}

/** Löschen nur ohne Exemplare (Fehlerfassung) – sonst archivieren. */
export async function deleteMaterial(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  await requireMaterials(db, viewer);
  const [c] = await db.select({ n: count() }).from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.materialId, id));
  if ((c?.n ?? 0) > 0) throw new ValidationError({ material: "Lernmittel mit Exemplaren lässt sich nicht löschen – archivieren" });
  const [m] = await db.delete(buechereiTeachingMaterials).where(eq(buechereiTeachingMaterials.id, id)).returning({ title: buechereiTeachingMaterials.title });
  if (!m) throw new ValidationError({ material: "Lernmittel gibt es nicht" });
  await audit(db, viewer.userId, "buecherei.material.delete", id, { title: m.title });
}

// ---------------------------------------------------------------- Exemplare

export interface CopiesInput {
  count?: string | number | null;
  condition?: string | null;
  acquiredYear?: string | number | null;
}

function validateCondition(raw: string | null | undefined, fallback: CopyCondition, fe: Record<string, string>): CopyCondition {
  const condition = trimOrNull(raw) ?? fallback;
  if (!(COPY_CONDITIONS as readonly string[]).includes(condition)) fe.condition = "Zustand wählen";
  return condition as CopyCondition;
}

function validateYear(raw: string | number | null | undefined, fe: Record<string, string>): number | null {
  const y = intOrNull(raw);
  const thisYear = new Date().getFullYear();
  if (y === "bad" || (y !== null && (y < 1990 || y > thisYear + 1))) {
    fe.acquiredYear = `Jahr zwischen 1990 und ${thisYear + 1}`;
    return null;
  }
  return y;
}

function validateCopies(input: CopiesInput, { allowZero }: { allowZero: boolean }) {
  const fe: Record<string, string> = {};
  const n = intOrNull(input.count);
  const copies = n === null ? (allowZero ? 0 : 1) : n;
  if (copies === "bad" || copies < (allowZero ? 0 : 1) || copies > MAX_MATERIAL_COPIES_AT_ONCE) fe.count = `${allowZero ? 0 : 1} bis ${MAX_MATERIAL_COPIES_AT_ONCE} Exemplare`;
  const condition = validateCondition(input.condition, "neu", fe);
  const acquiredYear = validateYear(input.acquiredYear, fe);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { count: copies as number, condition, acquiredYear };
}

/** Exemplare mit fortlaufender Inventarnummer (`L-…`) anlegen – eigener Nummernkreis neben den Büchereiexemplaren. */
async function insertCopies(db: Db, materialId: string, c: { count: number; condition: CopyCondition; acquiredYear: number | null }): Promise<string[]> {
  if (c.count === 0) return [];
  const [m] = await db.select({ seq: max(buechereiMaterialCopies.seq) }).from(buechereiMaterialCopies);
  const start = (m?.seq ?? 0) + 1;
  const rows = Array.from({ length: c.count }, (_, i) => ({
    materialId,
    seq: start + i,
    inventoryNumber: materialNumber(start + i),
    condition: c.condition,
    acquiredYear: c.acquiredYear,
  }));
  await db.insert(buechereiMaterialCopies).values(rows);
  return rows.map((r) => r.inventoryNumber);
}

export async function addMaterialCopies(db: Db, viewer: PermissionSet, materialId: string, input: CopiesInput): Promise<string[]> {
  await requireMaterials(db, viewer);
  const c = validateCopies(input, { allowZero: false });
  const [m] = await db.select({ provision: buechereiTeachingMaterials.provision }).from(buechereiTeachingMaterials).where(eq(buechereiTeachingMaterials.id, materialId));
  if (!m) throw new ValidationError({ count: "Lernmittel gibt es nicht" });
  if (m.provision === "kauf") throw new ValidationError({ count: "Lernmittel zum Selbstkaufen haben keine Exemplare der Schule" });
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const numbers = await insertCopies(tx, materialId, c);
    await audit(tx, viewer.userId, "buecherei.material.copies", materialId, { copies: numbers.length });
    return numbers;
  });
}

/** Zustand eines Exemplars ändern; der Vermerk beschreibt nur die Sache („Einband lose“), keine Namen. */
export async function updateMaterialCopy(db: Db, viewer: PermissionSet, copyId: string, input: { condition?: string | null; conditionNote?: string | null; acquiredYear?: string | number | null }): Promise<void> {
  await requireMaterials(db, viewer);
  const fe: Record<string, string> = {};
  const condition = validateCondition(input.condition, "gut", fe);
  const conditionNote = trimOrNull(input.conditionNote);
  if (conditionNote && conditionNote.length > 200) fe.conditionNote = "höchstens 200 Zeichen";
  const acquiredYear = validateYear(input.acquiredYear, fe);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [r] = await db
    .update(buechereiMaterialCopies)
    .set({ condition, conditionNote, acquiredYear })
    .where(eq(buechereiMaterialCopies.id, copyId))
    .returning({ materialId: buechereiMaterialCopies.materialId, nr: buechereiMaterialCopies.inventoryNumber });
  if (!r) throw new ValidationError({ copy: "Exemplar gibt es nicht" });
  await audit(db, viewer.userId, "buecherei.material.copy.update", r.materialId, { inventoryNumber: r.nr, condition });
}

/** Exemplar aussondern (verloren, verschlissen, alte Auflage) – bleibt mit Datum und Grund stehen. */
export async function withdrawMaterialCopy(db: Db, viewer: PermissionSet, copyId: string, reason: string, today: string): Promise<void> {
  await requireMaterials(db, viewer);
  const why = reason.trim();
  if (why.length < 2 || why.length > 200) throw new ValidationError({ reason: "Grund mit 2 bis 200 Zeichen" });
  const [r] = await db
    .update(buechereiMaterialCopies)
    .set({ withdrawnOn: today, withdrawnReason: why })
    .where(and(eq(buechereiMaterialCopies.id, copyId), isNull(buechereiMaterialCopies.withdrawnOn)))
    .returning({ materialId: buechereiMaterialCopies.materialId, nr: buechereiMaterialCopies.inventoryNumber });
  if (!r) throw new ValidationError({ reason: "Exemplar gibt es nicht oder ist schon ausgesondert" });
  await audit(db, viewer.userId, "buecherei.material.copy.withdraw", r.materialId, { inventoryNumber: r.nr, reason: why });
}

export async function restoreMaterialCopy(db: Db, viewer: PermissionSet, copyId: string): Promise<void> {
  await requireMaterials(db, viewer);
  const [r] = await db
    .update(buechereiMaterialCopies)
    .set({ withdrawnOn: null, withdrawnReason: null })
    .where(and(eq(buechereiMaterialCopies.id, copyId), isNotNull(buechereiMaterialCopies.withdrawnOn)))
    .returning({ materialId: buechereiMaterialCopies.materialId, nr: buechereiMaterialCopies.inventoryNumber });
  if (!r) throw new ValidationError({ copy: "Exemplar gibt es nicht oder ist nicht ausgesondert" });
  await audit(db, viewer.userId, "buecherei.material.copy.restore", r.materialId, { inventoryNumber: r.nr });
}

// ---------------------------------------------------------------- Lesen (Pflege)

export interface MaterialFilter {
  q?: string;
  grade?: number;
  subjectId?: string;
  archived?: boolean;
}

export type MaterialRow = Awaited<ReturnType<typeof listMaterials>>[number];

const COPY_COUNTS = {
  copies: sql<number>`(select count(*)::int from buecherei_material_copies c where c.material_id = "buecherei_teaching_materials"."id" and c.withdrawn_on is null)`,
  worn: sql<number>`(select count(*)::int from buecherei_material_copies c where c.material_id = "buecherei_teaching_materials"."id" and c.withdrawn_on is null and c.condition = 'schlecht')`,
};

/** Lernmittel mit Zahl der Exemplare im Bestand; Suche über Titel, Verlag, ISBN und Inventarnummer. */
export async function listMaterials(db: Db, viewer: PermissionSet, f: MaterialFilter = {}) {
  await requireMaterials(db, viewer);
  const q = f.q?.trim().slice(0, 100);
  const conds: (SQL | undefined)[] = [
    f.archived ? undefined : isNull(buechereiTeachingMaterials.archivedOn),
    f.grade ? sql`${f.grade} = any(${buechereiTeachingMaterials.grades})` : undefined,
    f.subjectId ? eq(buechereiTeachingMaterials.subjectId, f.subjectId) : undefined,
  ];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const isbn = normalizeIsbn(q);
    conds.push(
      or(
        ilike(buechereiTeachingMaterials.title, like),
        ilike(buechereiTeachingMaterials.publisher, like),
        ilike(buechereiTeachingMaterials.course, like),
        isbn ? eq(buechereiTeachingMaterials.isbn, isbn) : ilike(buechereiTeachingMaterials.isbn, like),
        sql`exists (select 1 from buecherei_material_copies c where c.material_id = "buecherei_teaching_materials"."id" and c.inventory_number ilike ${like})`,
      ),
    );
  }
  const rows = await db
    .select({
      id: buechereiTeachingMaterials.id,
      title: buechereiTeachingMaterials.title,
      publisher: buechereiTeachingMaterials.publisher,
      isbn: buechereiTeachingMaterials.isbn,
      grades: buechereiTeachingMaterials.grades,
      course: buechereiTeachingMaterials.course,
      provision: buechereiTeachingMaterials.provision,
      priceCents: buechereiTeachingMaterials.priceCents,
      archivedOn: buechereiTeachingMaterials.archivedOn,
      subjectId: buechereiTeachingMaterials.subjectId,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      ...COPY_COUNTS,
    })
    .from(buechereiTeachingMaterials)
    .leftJoin(subjects, eq(subjects.id, buechereiTeachingMaterials.subjectId))
    .where(and(...conds));
  return rows.sort(
    (a, b) => (a.grades[0] ?? 99) - (b.grades[0] ?? 99) || (a.subjectName ?? "~").localeCompare(b.subjectName ?? "~", "de") || a.title.localeCompare(b.title, "de", { numeric: true }),
  );
}

export async function getMaterial(db: Db, viewer: PermissionSet, id: string) {
  await requireMaterials(db, viewer);
  const [material] = await db
    .select({ m: buechereiTeachingMaterials, subjectName: subjects.name })
    .from(buechereiTeachingMaterials)
    .leftJoin(subjects, eq(subjects.id, buechereiTeachingMaterials.subjectId))
    .where(eq(buechereiTeachingMaterials.id, id));
  if (!material) return null;
  const copies = await db.select().from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.materialId, id)).orderBy(asc(buechereiMaterialCopies.seq));
  return { material: { ...material.m, subjectName: material.subjectName }, copies };
}

/** Kennzahlen für den Kopf der Lernmittel-Seite. */
export async function materialsSummary(db: Db, viewer: PermissionSet) {
  await requireMaterials(db, viewer);
  const [[m], [c], [w]] = await Promise.all([
    db.select({ n: count() }).from(buechereiTeachingMaterials).where(isNull(buechereiTeachingMaterials.archivedOn)),
    db.select({ n: count() }).from(buechereiMaterialCopies).where(isNull(buechereiMaterialCopies.withdrawnOn)),
    db.select({ n: count() }).from(buechereiMaterialCopies).where(and(isNull(buechereiMaterialCopies.withdrawnOn), eq(buechereiMaterialCopies.condition, "schlecht"))),
  ]);
  return { materials: m?.n ?? 0, copies: c?.n ?? 0, worn: w?.n ?? 0 };
}

/** Auswahllisten: Jahrgänge und Fächer. */
export async function materialChoices(db: Db) {
  const [grades, subjectRows] = await Promise.all([
    db.select({ level: gradeLevels.level, name: gradeLevels.name }).from(gradeLevels).orderBy(asc(gradeLevels.level)),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.name)),
  ]);
  return { grades, subjects: subjectRows };
}

// ---------------------------------------------------------------- Bücherliste

export interface BooklistItem {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  subjectName: string | null;
  course: string | null;
  provision: MaterialProvision;
  priceCents: number | null;
}

export interface Booklist {
  grade: number;
  gradeName: string;
  text: string;
  published: boolean;
  /** von der Schule ausgeliehen */
  loan: BooklistItem[];
  /** selbst kaufen – mit Summe der bekannten Preise */
  buy: BooklistItem[];
  buyTotalCents: number;
}

/**
 * Bücherliste eines Jahrgangs: Hinweistext und die Lernmittel (ohne archivierte), getrennt nach „leiht die Schule aus“ und
 * „selbst kaufen“. Lesen dürfen alle mit Bücherei-Zugang und Eltern – aber nur freigegebene Listen; wer Lernmittel pflegt,
 * sieht auch Entwürfe. Kein Personenbezug. `null`, wenn es den Jahrgang nicht gibt oder die Liste nicht sichtbar ist.
 */
export async function booklist(db: Db, viewer: PermissionSet, grade: number): Promise<Booklist | null> {
  if (!canReadBooklist(viewer)) throw new ForbiddenError("buecherei.use");
  await requireEnabled(db);
  const [g] = await db.select({ level: gradeLevels.level, name: gradeLevels.name }).from(gradeLevels).where(eq(gradeLevels.level, grade));
  if (!g) return null;
  const [bl] = await db.select().from(buechereiBooklists).where(eq(buechereiBooklists.gradeLevel, grade));
  const published = bl?.published ?? false;
  if (!published && !canMaterials(viewer)) return null;
  const items = await db
    .select({
      id: buechereiTeachingMaterials.id,
      title: buechereiTeachingMaterials.title,
      author: buechereiTeachingMaterials.author,
      isbn: buechereiTeachingMaterials.isbn,
      publisher: buechereiTeachingMaterials.publisher,
      subjectName: subjects.name,
      sortOrder: subjects.sortOrder,
      course: buechereiTeachingMaterials.course,
      provision: buechereiTeachingMaterials.provision,
      priceCents: buechereiTeachingMaterials.priceCents,
    })
    .from(buechereiTeachingMaterials)
    .leftJoin(subjects, eq(subjects.id, buechereiTeachingMaterials.subjectId))
    .where(and(isNull(buechereiTeachingMaterials.archivedOn), sql`${grade} = any(${buechereiTeachingMaterials.grades})`));
  items.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || (a.subjectName ?? "~").localeCompare(b.subjectName ?? "~", "de") || a.title.localeCompare(b.title, "de", { numeric: true }));
  const strip = (i: (typeof items)[number]): BooklistItem => ({
    id: i.id,
    title: i.title,
    author: i.author,
    isbn: i.isbn,
    publisher: i.publisher,
    subjectName: i.subjectName,
    course: i.course,
    provision: i.provision,
    priceCents: i.priceCents,
  });
  const buy = items.filter((i) => i.provision === "kauf").map(strip);
  return {
    grade: g.level,
    gradeName: g.name,
    text: bl?.text ?? "",
    published,
    loan: items.filter((i) => i.provision === "leihe").map(strip),
    buy,
    buyTotalCents: buy.reduce((s, i) => s + (i.priceCents ?? 0), 0),
  };
}

/** Übersicht je Jahrgang für die Pflege: Zahl der Lernmittel, freigegeben ja/nein. */
export async function booklistOverview(db: Db, viewer: PermissionSet) {
  await requireMaterials(db, viewer);
  const [grades, lists, mats] = await Promise.all([
    db.select({ level: gradeLevels.level, name: gradeLevels.name }).from(gradeLevels).orderBy(asc(gradeLevels.level)),
    db.select({ grade: buechereiBooklists.gradeLevel, published: buechereiBooklists.published }).from(buechereiBooklists),
    db.select({ grades: buechereiTeachingMaterials.grades }).from(buechereiTeachingMaterials).where(isNull(buechereiTeachingMaterials.archivedOn)),
  ]);
  const pub = new Map(lists.map((l) => [l.grade, l.published]));
  return grades.map((g) => ({ ...g, materials: mats.filter((m) => m.grades.includes(g.level)).length, published: pub.get(g.level) ?? false }));
}

/** Hinweistext und Freigabe der Bücherliste eines Jahrgangs speichern (`buecherei.materials`). */
export async function saveBooklist(db: Db, viewer: PermissionSet, grade: number, input: { text: string; published: boolean }): Promise<void> {
  await requireMaterials(db, viewer);
  const text = input.text.replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_BOOKLIST_TEXT) throw new ValidationError({ text: `höchstens ${MAX_BOOKLIST_TEXT} Zeichen` });
  const [g] = await db.select({ level: gradeLevels.level }).from(gradeLevels).where(eq(gradeLevels.level, grade));
  if (!g) throw new ValidationError({ text: "Jahrgang gibt es nicht" });
  await db
    .insert(buechereiBooklists)
    .values({ gradeLevel: grade, text, published: input.published })
    .onConflictDoUpdate({ target: buechereiBooklists.gradeLevel, set: { text, published: input.published, updatedAt: new Date() } });
  await audit(db, viewer.userId, "buecherei.booklist.save", null, { grade, published: input.published });
}

/**
 * Jahrgänge, die eine Person auf der Bücherliste zuerst sehen soll: Schüler:innen die eigene Klasse, Eltern die Klassen ihrer
 * Kinder (über die sie informiert werden). Nur zur Vorauswahl – die Listen selbst sind nicht personenbezogen.
 */
export async function ownGrades(db: Db, viewer: PermissionSet): Promise<number[]> {
  const ids = viewer.role === "eltern" ? (await childrenOf(db, viewer.userId, "inform")).map((c) => c.id) : viewer.role === "schueler" ? [viewer.userId] : [];
  if (!ids.length) return [];
  const rows = await db
    .selectDistinct({ grade: groups.gradeLevel })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.userId, ids), eq(groups.kind, "klasse"), isNull(groups.archivedAt), eq(groupMembers.role, "member"), isNotNull(groups.gradeLevel)));
  return rows.map((r) => r.grade!).sort((a, b) => a - b);
}

/** Jahrgänge mit freigegebener Bücherliste (für die Auswahl der Lesenden). */
export async function publishedGrades(db: Db): Promise<{ level: number; name: string }[]> {
  return db
    .select({ level: gradeLevels.level, name: gradeLevels.name })
    .from(buechereiBooklists)
    .innerJoin(gradeLevels, eq(gradeLevels.level, buechereiBooklists.gradeLevel))
    .where(eq(buechereiBooklists.published, true))
    .orderBy(asc(gradeLevels.level));
}

// ---------------------------------------------------------------- Etiketten (Baustein aus BU-05)

/** Etiketten für die Inventarnummern eines Lernmittels (ohne ausgesonderte) bzw. eines Exemplars – Druckansicht aus BU-05. */
export async function materialLabels(db: Db, viewer: PermissionSet, src: { materialId: string } | { copyId: string }) {
  await requireMaterials(db, viewer);
  const rows = await db
    .select({ copyId: buechereiMaterialCopies.id, barcode: buechereiMaterialCopies.inventoryNumber, title: buechereiTeachingMaterials.title, subjectId: buechereiTeachingMaterials.subjectId })
    .from(buechereiMaterialCopies)
    .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
    .where("materialId" in src ? and(eq(buechereiMaterialCopies.materialId, src.materialId), isNull(buechereiMaterialCopies.withdrawnOn)) : eq(buechereiMaterialCopies.id, src.copyId))
    .orderBy(asc(buechereiMaterialCopies.seq))
    .limit(400);
  // Kopfzeile des Etiketts: „Lernmittel“ + Fach statt Signatur; als gedruckt gilt es immer (keine Warteschlange für Lernmittel)
  return rows.map((r) => ({ copyId: r.copyId, barcode: r.barcode, signature: r.subjectId ? `Lernmittel ${r.subjectId}` : "Lernmittel", title: r.title, printed: true }));
}
