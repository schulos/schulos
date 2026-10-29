// Handbuch (HB-01…HB-04, docs/HANDBUCH.md): Bereiche → Seiten mit Zielgruppen, Ansprechperson und Überprüfung.
// Sichtbarkeit filtert der Service selbst: Pflegende (`hilfe.edit`/`hilfe.manage`) sehen alles, die Ansprechperson ihre Seite
// (auch als Entwurf), alle anderen nur veröffentlichte Seiten ihrer Zielgruppen (Regel wie News, `core/school/audience`).
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { groups, hilfeAttachments, hilfePages, hilfeRevisions, hilfeSections, hilfeTargets, users, type HilfePageStatus } from "@/core/db/schema";
import type { FileStorage } from "@/core/files/storage";
import { de } from "@/core/db/sort";
import { ROLE_LABELS } from "@/core/labels";
import { readModuleSetting } from "@/core/modules/settings";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ROLES, STAFF_ROLES, type Role } from "@/core/roles";
import { audienceGroups, targetedTo } from "@/core/school/audience";
import { toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { REVIEW_MONTHS } from "./settings";

export const EDIT = "hilfe.edit";
export const MANAGE = "hilfe.manage";

/** Pflegende: Bereiche und alle Seiten anlegen, ändern, veröffentlichen (Recht „Handbuch bearbeiten“ oder „verwalten“). */
export const canEditAll = (p: PermissionSet) => hasPermission(p, EDIT) || hasPermission(p, MANAGE);
/** Löschen von Seiten und Bereichen. */
export const canManage = (p: PermissionSet) => hasPermission(p, MANAGE);
/** Darf diese Person die Seite bearbeiten? Pflegende alle, die Ansprechperson ihre eigene (HB-02). */
export const canEditPage = (p: PermissionSet, page: { contactId: string | null }) => canEditAll(p) || (page.contactId !== null && page.contactId === p.userId && !p.locked);

/** Vorgabe beim Anlegen (Projektleitung 2026-10-28): eigene Seiten zunächst nur für Personal. */
export const STAFF_TARGET_ROLES: Role[] = ["lehrkraft", "personal", "beratung", "verwaltung"];

/** Routen unter /hilfe, die keine Seitenadresse sein dürfen. */
const RESERVED_SLUGS = new Set(["neu", "bereiche", "suche", "druck"]);

const MAX_BODY = 50_000;

// ---------------------------------------------------------------- rein (getestet ohne DB)

/** Adresse aus dem Titel: „Zwei-Faktor einrichten“ → „zwei-faktor-einrichten“ (Umlaute ausgeschrieben, höchstens 60 Zeichen). */
export function slugify(title: string): string {
  const map: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
  const s = title
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => map[c]!)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "seite";
}

/** Datum + n Monate (YYYY-MM-DD), Monatsende abgeschnitten: 2026-01-31 + 1 → 2026-02-28. */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Fällig am (oder null, wenn die Erinnerung ausgeschaltet ist). */
export function reviewDueOn(reviewedOn: string, months: number): string | null {
  return months > 0 ? addMonths(reviewedOn, months) : null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------------------------------------------------------------- Sichtbarkeit

const TARGETS = { table: hilfeTargets, owner: hilfeTargets.pageId, role: hilfeTargets.role, groupId: hilfeTargets.groupId };

/** Bedingung „Seite ist für den Betrachter sichtbar“ (undefined = alles). */
export async function pageVisibility(db: Db, viewer: PermissionSet): Promise<SQL | undefined> {
  if (canEditAll(viewer)) return undefined;
  return or(
    eq(hilfePages.contactId, viewer.userId),
    and(eq(hilfePages.status, "veroeffentlicht"), targetedTo(db, TARGETS, hilfePages.id, viewer, await audienceGroups(db, viewer))),
  );
}

// ---------------------------------------------------------------- Lesen

export interface OutlinePage {
  id: string;
  slug: string;
  title: string;
  status: HilfePageStatus;
}

export interface OutlineSection {
  id: string;
  title: string;
  pages: OutlinePage[];
}

/** Gliederung: Bereiche mit ihren sichtbaren Seiten. Wer nicht pflegt, sieht leere Bereiche nicht. */
export async function listOutline(db: Db, viewer: PermissionSet): Promise<OutlineSection[]> {
  const [sections, pages] = await Promise.all([
    db.select({ id: hilfeSections.id, title: hilfeSections.title }).from(hilfeSections).orderBy(asc(hilfeSections.position), de(hilfeSections.title)),
    db
      .select({ id: hilfePages.id, slug: hilfePages.slug, title: hilfePages.title, status: hilfePages.status, sectionId: hilfePages.sectionId })
      .from(hilfePages)
      .where(await pageVisibility(db, viewer))
      .orderBy(asc(hilfePages.position), de(hilfePages.title)),
  ]);
  const editor = canEditAll(viewer);
  return sections
    .map((s) => ({ ...s, pages: pages.filter((p) => p.sectionId === s.id).map((p) => ({ id: p.id, slug: p.slug, title: p.title, status: p.status })) }))
    .filter((s) => editor || s.pages.length > 0);
}

export interface PageHit {
  id: string;
  slug: string;
  title: string;
  sectionTitle: string;
  body: string;
  status: HilfePageStatus;
}

/** Volltextsuche (HB-03) über Titel und Text – nur sichtbare Seiten; kurze Begriffe zusätzlich als Teilwort im Titel. */
export async function searchPages(db: Db, viewer: PermissionSet, q: string, limit = 20): Promise<PageHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const fts = sql`to_tsvector('german', ${hilfePages.title} || ' ' || ${hilfePages.body}) @@ websearch_to_tsquery('german', ${term})`;
  return db
    .select({ id: hilfePages.id, slug: hilfePages.slug, title: hilfePages.title, sectionTitle: hilfeSections.title, body: hilfePages.body, status: hilfePages.status })
    .from(hilfePages)
    .innerJoin(hilfeSections, eq(hilfeSections.id, hilfePages.sectionId))
    .where(and(await pageVisibility(db, viewer), or(fts, ilike(hilfePages.title, `%${likeEscape(term)}%`))))
    .orderBy(de(hilfePages.title))
    .limit(limit);
}

export interface PageDetail {
  id: string;
  slug: string;
  title: string;
  body: string;
  status: HilfePageStatus;
  position: number;
  sectionId: string;
  sectionTitle: string;
  contactId: string | null;
  contactName: string | null;
  updatedByName: string | null;
  updatedAt: Date;
  reviewedOn: string;
  reviewRemindedAt: Date | null;
  /** lesbare Zielgruppen (leer = alle) */
  targets: string[];
  targetRoles: Role[];
  targetGroupIds: string[];
}

const contact = alias(users, "hilfe_contact");
const editor = alias(users, "hilfe_editor");

async function loadPage(db: Db, where: SQL | undefined): Promise<PageDetail | null> {
  const [row] = await db
    .select({
      id: hilfePages.id,
      slug: hilfePages.slug,
      title: hilfePages.title,
      body: hilfePages.body,
      status: hilfePages.status,
      position: hilfePages.position,
      sectionId: hilfePages.sectionId,
      sectionTitle: hilfeSections.title,
      contactId: hilfePages.contactId,
      contactName: contact.name,
      updatedByName: editor.name,
      updatedAt: hilfePages.updatedAt,
      reviewedOn: hilfePages.reviewedOn,
      reviewRemindedAt: hilfePages.reviewRemindedAt,
    })
    .from(hilfePages)
    .innerJoin(hilfeSections, eq(hilfeSections.id, hilfePages.sectionId))
    .leftJoin(contact, eq(contact.id, hilfePages.contactId))
    .leftJoin(editor, eq(editor.id, hilfePages.updatedBy))
    .where(where);
  if (!row) return null;
  const t = await db
    .select({ role: hilfeTargets.role, groupId: hilfeTargets.groupId, groupName: groups.name })
    .from(hilfeTargets)
    .leftJoin(groups, eq(groups.id, hilfeTargets.groupId))
    .where(eq(hilfeTargets.pageId, row.id));
  return {
    ...row,
    targets: t.map((x) => (x.role ? ROLE_LABELS[x.role] : (x.groupName ?? "?"))),
    targetRoles: t.flatMap((x) => (x.role ? [x.role] : [])),
    targetGroupIds: t.flatMap((x) => (x.groupId ? [x.groupId] : [])),
  };
}

/** Eine Seite per Adresse – null, wenn es sie nicht gibt oder der Betrachter sie nicht sehen darf. */
export async function getPage(db: Db, viewer: PermissionSet, slug: string): Promise<PageDetail | null> {
  return loadPage(db, and(eq(hilfePages.slug, slug), await pageVisibility(db, viewer)));
}

export async function listSections(db: Db) {
  return db.select().from(hilfeSections).orderBy(asc(hilfeSections.position), de(hilfeSections.title));
}

/** Wer Ansprechperson sein kann: aktive Konten des Personals (keine Schüler:innen, keine Eltern). */
export async function contactCandidates(db: Db) {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.role, [...STAFF_ROLES]), eq(users.status, "active")))
    .orderBy(de(users.name));
}

// ---------------------------------------------------------------- Bereiche

function sectionTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new ValidationError({ title: "Titel fehlt" });
  if (title.length > 80) throw new ValidationError({ title: "Höchstens 80 Zeichen" });
  return title;
}

export async function createSection(db: Db, actor: PermissionSet, rawTitle: string): Promise<string> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  const title = sectionTitle(rawTitle);
  const [{ max } = { max: -1 }] = await db.select({ max: sql<number>`coalesce(max(${hilfeSections.position}), -1)::int` }).from(hilfeSections);
  const [row] = await db.insert(hilfeSections).values({ title, position: Number(max) + 1 }).returning({ id: hilfeSections.id });
  await audit(db, actor.userId, "hilfe.section.create", row!.id);
  return row!.id;
}

export async function renameSection(db: Db, actor: PermissionSet, id: string, rawTitle: string): Promise<void> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  const rows = await db.update(hilfeSections).set({ title: sectionTitle(rawTitle) }).where(eq(hilfeSections.id, id)).returning({ id: hilfeSections.id });
  if (!rows.length) throw new ValidationError({ title: "Diesen Bereich gibt es nicht mehr" });
  await audit(db, actor.userId, "hilfe.section.update", id);
}

/** Reihenfolge: mit dem Nachbarn tauschen (−1 nach oben, +1 nach unten). */
export async function moveSection(db: Db, actor: PermissionSet, id: string, dir: -1 | 1): Promise<void> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  const all = await listSections(db);
  await swapPositions(db, "section", all.map((s) => s.id), id, dir);
}

export async function deleteSection(db: Db, actor: PermissionSet, id: string): Promise<void> {
  if (!canManage(actor)) throw new ForbiddenError(MANAGE);
  const [used] = await db.select({ id: hilfePages.id }).from(hilfePages).where(eq(hilfePages.sectionId, id)).limit(1);
  if (used) throw new ValidationError({ section: "Der Bereich enthält noch Seiten – erst verschieben oder löschen" });
  await db.delete(hilfeSections).where(eq(hilfeSections.id, id));
  await audit(db, actor.userId, "hilfe.section.delete", id);
}

async function swapPositions(db: Db, kind: "section" | "page", ordered: string[], id: string, dir: -1 | 1): Promise<void> {
  const i = ordered.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ordered.length) return;
  const next = [...ordered];
  [next[i], next[j]] = [next[j]!, next[i]!];
  await db.transaction(async (tx) => {
    for (const [pos, rowId] of next.entries()) {
      if (kind === "section") await tx.update(hilfeSections).set({ position: pos }).where(eq(hilfeSections.id, rowId));
      else await tx.update(hilfePages).set({ position: pos }).where(eq(hilfePages.id, rowId));
    }
  });
}

// ---------------------------------------------------------------- Seiten

export interface PageInput {
  sectionId: string;
  title: string;
  body: string;
  status: HilfePageStatus;
  contactId: string | null;
  targetRoles: Role[];
  targetGroupIds: string[];
}

async function validatePage(db: Db, input: PageInput): Promise<void> {
  const errors: Record<string, string> = {};
  if (!input.title.trim()) errors.title = "Titel fehlt";
  else if (input.title.trim().length > 140) errors.title = "Höchstens 140 Zeichen";
  if (input.body.length > MAX_BODY) errors.body = `Höchstens ${MAX_BODY.toLocaleString("de-DE")} Zeichen`;
  if (!["entwurf", "veroeffentlicht"].includes(input.status)) errors.status = "Unbekannter Status";
  if (input.targetRoles.some((r) => !ROLES.includes(r) || r === "admin")) errors.targets = "Unbekannte Rolle";
  const [section] = await db.select({ id: hilfeSections.id }).from(hilfeSections).where(eq(hilfeSections.id, input.sectionId));
  if (!section) errors.sectionId = "Bitte einen Bereich wählen";
  if (input.contactId) {
    const [c] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.contactId), inArray(users.role, [...STAFF_ROLES]), eq(users.status, "active")));
    if (!c) errors.contactId = "Ansprechperson muss ein aktives Konto des Personals sein";
  }
  const gids = [...new Set(input.targetGroupIds)];
  if (gids.length) {
    const found = await db.select({ id: groups.id }).from(groups).where(inArray(groups.id, gids));
    if (found.length !== gids.length) errors.targets = "Unbekannte Gruppe";
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

async function writeTargets(db: Db, pageId: string, input: Pick<PageInput, "targetRoles" | "targetGroupIds">) {
  await db.delete(hilfeTargets).where(eq(hilfeTargets.pageId, pageId));
  const rows = [
    ...[...new Set(input.targetRoles)].map((role) => ({ pageId, role })),
    ...[...new Set(input.targetGroupIds)].map((groupId) => ({ pageId, groupId })),
  ];
  if (rows.length) await db.insert(hilfeTargets).values(rows);
}

async function uniqueSlug(db: Db, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (await db.select({ slug: hilfePages.slug }).from(hilfePages).where(or(eq(hilfePages.slug, base), ilike(hilfePages.slug, `${likeEscape(base)}-%`)))).map((r) => r.slug),
  );
  if (!taken.has(base) && !RESERVED_SLUGS.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Neue Seite (Pflegende). Gibt die Adresse (slug) zurück. `today` = Tag der Prüfung (Berlin). */
export async function createPage(db: Db, actor: PermissionSet, input: PageInput, today = toBerlinDate(new Date())): Promise<string> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  await validatePage(db, input);
  const slug = await uniqueSlug(db, input.title);
  const [{ max } = { max: -1 }] = await db
    .select({ max: sql<number>`coalesce(max(${hilfePages.position}), -1)::int` })
    .from(hilfePages)
    .where(eq(hilfePages.sectionId, input.sectionId));
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(hilfePages)
      .values({
        sectionId: input.sectionId,
        slug,
        title: input.title.trim(),
        body: input.body.trim(),
        status: input.status,
        position: Number(max) + 1,
        contactId: input.contactId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
        reviewedOn: today,
      })
      .returning({ id: hilfePages.id });
    await writeTargets(tx, row!.id, input);
    return row!.id;
  });
  await audit(db, actor.userId, "hilfe.page.create", id, { status: input.status });
  return slug;
}

async function pageRow(db: Db, id: string) {
  const [row] = await db.select().from(hilfePages).where(eq(hilfePages.id, id));
  return row ?? null;
}

/**
 * Seite ändern. Pflegende ändern alles; die Ansprechperson (ohne „Handbuch bearbeiten“) nur Titel und Text – Bereich, Status,
 * Zielgruppen und Ansprechperson bleiben, damit sie den Kreis der Lesenden nicht erweitern kann. Speichern gilt als Prüfung.
 */
export async function updatePage(db: Db, actor: PermissionSet, id: string, input: PageInput, today = toBerlinDate(new Date())): Promise<string> {
  const existing = await pageRow(db, id);
  if (!existing || !canEditPage(actor, existing)) throw new ForbiddenError(EDIT);
  const full = canEditAll(actor);
  const effective: PageInput = full
    ? input
    : {
        ...input,
        sectionId: existing.sectionId,
        status: existing.status,
        contactId: existing.contactId,
        targetRoles: [],
        targetGroupIds: [],
      };
  await validatePage(db, effective);
  await db.transaction(async (tx) => {
    // HB-06: der bisherige Stand wandert in den Verlauf, wenn sich Titel oder Text ändern
    if (effective.title.trim() !== existing.title || effective.body.trim() !== existing.body) await saveRevision(tx, existing);
    const sectionChanged = full && effective.sectionId !== existing.sectionId;
    let position = existing.position;
    if (sectionChanged) {
      const [{ max } = { max: -1 }] = await tx
        .select({ max: sql<number>`coalesce(max(${hilfePages.position}), -1)::int` })
        .from(hilfePages)
        .where(eq(hilfePages.sectionId, effective.sectionId));
      position = Number(max) + 1;
    }
    await tx
      .update(hilfePages)
      .set({
        sectionId: effective.sectionId,
        title: effective.title.trim(),
        body: effective.body.trim(),
        status: effective.status,
        contactId: effective.contactId,
        position,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        reviewedOn: today,
        reviewRemindedAt: null,
      })
      .where(eq(hilfePages.id, id));
    if (full) await writeTargets(tx, id, effective);
  });
  await audit(db, actor.userId, "hilfe.page.update", id, full ? { status: effective.status } : { als: "ansprechperson" });
  return existing.slug;
}

/** „Geprüft, unverändert“ (HB-04): setzt die Frist neu, ohne den Inhalt zu ändern. */
export async function markReviewed(db: Db, actor: PermissionSet, id: string, today = toBerlinDate(new Date())): Promise<void> {
  const existing = await pageRow(db, id);
  if (!existing || !canEditPage(actor, existing)) throw new ForbiddenError(EDIT);
  await db.update(hilfePages).set({ reviewedOn: today, reviewRemindedAt: null }).where(eq(hilfePages.id, id));
  await audit(db, actor.userId, "hilfe.page.review", id);
}

export async function movePage(db: Db, actor: PermissionSet, id: string, dir: -1 | 1): Promise<void> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  const existing = await pageRow(db, id);
  if (!existing) return;
  const siblings = await db
    .select({ id: hilfePages.id })
    .from(hilfePages)
    .where(eq(hilfePages.sectionId, existing.sectionId))
    .orderBy(asc(hilfePages.position), de(hilfePages.title));
  await swapPositions(db, "page", siblings.map((s) => s.id), id, dir);
}

export async function deletePage(db: Db, actor: PermissionSet, id: string, storage?: FileStorage): Promise<void> {
  if (!canManage(actor)) throw new ForbiddenError(MANAGE);
  const files = await db.select({ key: hilfeAttachments.storageKey }).from(hilfeAttachments).where(eq(hilfeAttachments.pageId, id));
  await db.delete(hilfePages).where(eq(hilfePages.id, id));
  await audit(db, actor.userId, "hilfe.page.delete", id);
  // Anhänge gehen mit der Seite (Datensatz per cascade); schlägt das Löschen der Datei fehl, räumt der Dateispeicher-Lauf auf
  if (storage) for (const f of files) await storage.delete(f.key).catch(() => {});
}

// ---------------------------------------------------------------- Verlauf (HB-06)

/** Vorgabe (HB-06): so viele Fassungen je Seite bleiben erhalten. */
export const REVISIONS_KEEP = 20;

/** Legt den aktuellen Stand der Seite im Verlauf ab und kappt auf die letzten REVISIONS_KEEP Fassungen. */
async function saveRevision(tx: Db, page: { id: string; title: string; body: string; updatedBy: string | null; updatedAt: Date }): Promise<void> {
  await tx.insert(hilfeRevisions).values({ pageId: page.id, title: page.title, body: page.body, authorId: page.updatedBy, authoredAt: page.updatedAt });
  const keep = await tx
    .select({ id: hilfeRevisions.id })
    .from(hilfeRevisions)
    .where(eq(hilfeRevisions.pageId, page.id))
    .orderBy(desc(hilfeRevisions.seq))
    .limit(REVISIONS_KEEP);
  await tx.delete(hilfeRevisions).where(and(eq(hilfeRevisions.pageId, page.id), notInArray(hilfeRevisions.id, keep.map((k) => k.id))));
}

export interface RevisionItem {
  id: string;
  title: string;
  body: string;
  authorName: string | null;
  authoredAt: Date;
}

/** Verlauf einer Seite, neueste zuerst – nur Pflegende. */
export async function listRevisions(db: Db, viewer: PermissionSet, pageId: string): Promise<RevisionItem[]> {
  if (!canEditAll(viewer)) throw new ForbiddenError(EDIT);
  return db
    .select({ id: hilfeRevisions.id, title: hilfeRevisions.title, body: hilfeRevisions.body, authorName: users.name, authoredAt: hilfeRevisions.authoredAt })
    .from(hilfeRevisions)
    .leftJoin(users, eq(users.id, hilfeRevisions.authorId))
    .where(eq(hilfeRevisions.pageId, pageId))
    .orderBy(desc(hilfeRevisions.seq));
}

/**
 * Stellt eine frühere Fassung wieder her (nur Pflegende): Titel und Text der Fassung werden aktuell; der Stand davor kommt selbst
 * in den Verlauf, nichts geht verloren. Adresse, Status und Zielgruppen bleiben. Gilt als Prüfung. Gibt die Adresse der Seite zurück.
 */
export async function restoreRevision(db: Db, actor: PermissionSet, revisionId: string, today = toBerlinDate(new Date())): Promise<string> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  const [rev] = await db.select().from(hilfeRevisions).where(eq(hilfeRevisions.id, revisionId));
  if (!rev) throw new ValidationError({ revision: "Diese Fassung gibt es nicht mehr" });
  const page = await pageRow(db, rev.pageId);
  if (!page) throw new ValidationError({ revision: "Die Seite gibt es nicht mehr" });
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    if (rev.title !== page.title || rev.body !== page.body) await saveRevision(tx, page);
    await tx
      .update(hilfePages)
      .set({ title: rev.title, body: rev.body, updatedBy: actor.userId, updatedAt: new Date(), reviewedOn: today, reviewRemindedAt: null })
      .where(eq(hilfePages.id, page.id));
  });
  await audit(db, actor.userId, "hilfe.page.restore", page.id, { revision: revisionId });
  return page.slug;
}

// ---------------------------------------------------------------- Überprüfung (HB-04)

export async function reviewMonths(db: Db): Promise<number> {
  return Number(await readModuleSetting(db, REVIEW_MONTHS)) || 0;
}

export interface DueItem {
  id: string;
  slug: string;
  title: string;
  dueOn: string;
  contactName: string | null;
}

/**
 * Fällige Überprüfungen für das Widget: Pflegende sehen alle veröffentlichten Seiten (auch ohne Ansprechperson), die
 * Ansprechperson nur ihre eigenen. Leer, wenn die Erinnerung ausgeschaltet ist.
 */
export async function dueForReview(db: Db, viewer: PermissionSet, today: string, limit = 5): Promise<DueItem[]> {
  const months = await reviewMonths(db);
  if (!months) return [];
  const cutoff = addMonths(today, -months);
  const rows = await db
    .select({ id: hilfePages.id, slug: hilfePages.slug, title: hilfePages.title, reviewedOn: hilfePages.reviewedOn, contactName: contact.name })
    .from(hilfePages)
    .leftJoin(contact, eq(contact.id, hilfePages.contactId))
    .where(and(eq(hilfePages.status, "veroeffentlicht"), lte(hilfePages.reviewedOn, cutoff), canEditAll(viewer) ? undefined : eq(hilfePages.contactId, viewer.userId)))
    .orderBy(asc(hilfePages.reviewedOn), de(hilfePages.title))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, contactName: r.contactName, dueOn: addMonths(r.reviewedOn, months) }));
}

/**
 * Tagesjob (HB-04): je fälliger, veröffentlichter Seite mit Ansprechperson genau einmal ein Gong an die Ansprechperson.
 * Vermerken und Gong in einer Transaktion (bedingtes UPDATE sperrt gegen einen zweiten Prozess; scheitert der Gong, ist auch
 * der Vermerk weg). Prüfen bzw. Speichern setzt den Vermerk zurück. Gibt die Zahl der Erinnerungen zurück.
 */
export async function runReviewReminders(db: Db, now: Date): Promise<number> {
  const months = await reviewMonths(db);
  if (!months) return 0;
  const cutoff = addMonths(toBerlinDate(now), -months);
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(hilfePages)
      .set({ reviewRemindedAt: now })
      .where(and(eq(hilfePages.status, "veroeffentlicht"), isNotNull(hilfePages.contactId), isNull(hilfePages.reviewRemindedAt), lte(hilfePages.reviewedOn, cutoff)))
      .returning({ id: hilfePages.id, slug: hilfePages.slug, title: hilfePages.title, contactId: hilfePages.contactId });
    for (const p of claimed) {
      await notify(tx, [p.contactId!], {
        moduleId: "hilfe",
        title: `Überprüfung fällig: ${p.title}`,
        body: "Bitte prüfen, ob die Handbuchseite noch stimmt – speichern oder „Geprüft, unverändert“ wählen.",
        href: `/hilfe/${p.slug}`,
      });
    }
    if (claimed.length) await audit(tx, null, "hilfe.review.remind", null, { pages: claimed.length });
    return claimed.length;
  });
}

/** Welche dieser Adressen sieht der Betrachter? (Kontexthilfe: „?“ führt nur auf Seiten, die es für ihn gibt.) */
export async function visibleSlugs(db: Db, viewer: PermissionSet, slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const rows = await db
    .select({ slug: hilfePages.slug })
    .from(hilfePages)
    .where(and(inArray(hilfePages.slug, [...new Set(slugs)]), await pageVisibility(db, viewer)));
  return new Set(rows.map((r) => r.slug));
}
