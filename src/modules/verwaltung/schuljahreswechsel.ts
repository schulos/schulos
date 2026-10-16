// Schuljahreswechsel-Assistent (B-08, DS-10, DATENSCHUTZ.md §3.6–3.8). Ablauf:
//   1. neues Schuljahr wählen bzw. anlegen → Durchlauf starten
//   2. Versetzung: neue Klassen im neuen Schuljahr, Schüler:innen einzeln umsetzbar oder als Abgang vormerken
//   2b. Neuaufnahmen aus der Schulanmeldung (P4-39, anmeldung/uebernahme.ts) – nur wenn es aufgenommene Anträge gibt
//   3. Archivexport der Klassenbücher (klassenbuch/archiv.ts) und Bestätigung „übergeben“
//   4. Gruppen des alten Schuljahres archivieren (Mitgliedschaften enden, Inhalte bleiben bis zur Löschfrist)
//   5. Pflichtschritt: Löschprotokoll und Löschsperren geprüft
//   6. Abschluss: neues Schuljahr wird das aktuelle, Abgänger:innen werden mit Abgangsdatum gesperrt (Konto-Lebenszyklus)
import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { classbookEntries, gradeLevels, groupMembers, groups, recordArchives, schoolYears, schoolYearTransitions, users } from "@/core/db/schema";
import { setAccountLeft } from "@/core/privacy/konto";
import { slugify } from "./groups";
import { ValidationError } from "./users";

export type Transition = typeof schoolYearTransitions.$inferSelect;

export type TransitionStep = "promote" | "admissions" | "archive_export" | "archive_groups" | "review" | "complete" | "done";

/**
 * Rein: nächster offener Schritt eines Durchlaufs. „Neuaufnahmen“ (P4-39) nur, wenn es aufgenommene Anträge der
 * Schulanmeldung für das neue Schuljahr gibt (`pendingAdmissions` > 0, Modul an) und sie noch nicht übernommen sind.
 */
export function nextStep(
  t: Pick<Transition, "promotedAt" | "archivedAt" | "reviewedAt" | "completedAt"> & Partial<Pick<Transition, "admittedAt">>,
  exportsMissing: number,
  pendingAdmissions = 0,
): TransitionStep {
  if (t.completedAt) return "done";
  if (!t.promotedAt) return "promote";
  if (!t.admittedAt && pendingAdmissions > 0) return "admissions";
  if (!t.archivedAt && exportsMissing > 0) return "archive_export";
  if (!t.archivedAt) return "archive_groups";
  if (!t.reviewedAt) return "review";
  return "complete";
}

// ---------------------------------------------------------------- Namen

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rein: Vorschlag für den Namen der Klasse im nächsten Jahrgang. Das Jahrgangskürzel wird ersetzt („Klasse 7b“ →
 * „Klasse 8b“); beim Übergang in eine andere Stufe (Sek I → Oberstufe) heißt die neue Klasse wie der Jahrgang („EF“),
 * damit Parallelklassen zusammenlaufen.
 */
export function promotedName(name: string, from: { code: string; stage: string }, to: { code: string; stage: string }): string {
  if (from.stage !== to.stage) return to.code;
  const digits = /^\d+$/.test(from.code);
  const re = digits ? new RegExp(`(?<!\\d)${escapeRe(from.code)}(?!\\d)`) : new RegExp(`\\b${escapeRe(from.code)}\\b`, "i");
  return re.test(name) ? name.replace(re, to.code) : `${name} (${to.code})`;
}

// ---------------------------------------------------------------- Durchlauf

export async function getTransition(db: Db, fromYearId: string) {
  const [t] = await db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.fromYearId, fromYearId));
  return t ?? null;
}

/** Startet den Wechsel vom aktuellen in das gewählte Folgejahr. */
export async function startTransition(db: Db, actorId: string, fromYearId: string, toYearId: string): Promise<string> {
  const years = await db.select().from(schoolYears).where(inArray(schoolYears.id, [fromYearId, toYearId]));
  const from = years.find((y) => y.id === fromYearId);
  const to = years.find((y) => y.id === toYearId);
  if (!from || !to || from.id === to.id) throw new ValidationError({ toYearId: "Neues Schuljahr wählen" });
  if (to.startsOn <= from.endsOn) throw new ValidationError({ toYearId: `Das neue Schuljahr muss nach ${from.name} beginnen` });
  const existing = await getTransition(db, fromYearId);
  if (existing) return existing.id;
  const [row] = await db.insert(schoolYearTransitions).values({ fromYearId, toYearId, startedBy: actorId }).returning({ id: schoolYearTransitions.id });
  await audit(db, actorId, "verwaltung.schuljahreswechsel.start", null, { from: from.name, to: to.name });
  return row!.id;
}

async function loadTransition(db: Db, id: string) {
  const [t] = await db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, id));
  if (!t) throw new ValidationError({ transition: "Schuljahreswechsel nicht gefunden" });
  if (t.completedAt) throw new ValidationError({ transition: "Der Schuljahreswechsel ist bereits abgeschlossen" });
  const years = await db.select().from(schoolYears).where(inArray(schoolYears.id, [t.fromYearId, t.toYearId]));
  return { t, from: years.find((y) => y.id === t.fromYearId)!, to: years.find((y) => y.id === t.toYearId)! };
}

// ---------------------------------------------------------------- Versetzung

export interface PromotionClass {
  groupId: string;
  name: string;
  gradeLevel: number | null;
  gradeCode: string | null;
  leaders: { id: string; name: string }[];
  students: { id: string; name: string }[];
  /** Vorschlag: Name der Klasse im neuen Schuljahr; null = Abschlussjahrgang (Abgang) */
  proposal: string | null;
  /** Kurzname zum Vorschlag, aus dem alten Kurznamen abgeleitet („7b“ → „8b“) */
  proposalSlug: string | null;
}

/** Klassen des alten Schuljahres mit Schüler:innen und Vorschlag für den nächsten Jahrgang. */
export async function planPromotion(db: Db, fromYearId: string): Promise<PromotionClass[]> {
  const [levels, classes] = await Promise.all([
    db.select().from(gradeLevels).orderBy(asc(gradeLevels.level)),
    db
      .select({ id: groups.id, name: groups.name, slug: groups.slug, gradeLevel: groups.gradeLevel })
      .from(groups)
      .where(and(eq(groups.schoolYearId, fromYearId), eq(groups.kind, "klasse"), isNull(groups.archivedAt)))
      .orderBy(asc(groups.gradeLevel), asc(groups.name)),
  ]);
  if (!classes.length) return [];
  const members = await db
    .select({ groupId: groupMembers.groupId, role: groupMembers.role, id: users.id, name: users.name, userRole: users.role, lastName: users.lastName })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, classes.map((c) => c.id)), ne(users.status, "locked")))
    .orderBy(asc(users.lastName), asc(users.firstName));
  return classes.map((c) => {
    const level = levels.find((l) => l.level === c.gradeLevel);
    const next = level ? levels.find((l) => l.level > level.level) : undefined;
    const mine = members.filter((m) => m.groupId === c.id);
    return {
      groupId: c.id,
      name: c.name,
      gradeLevel: c.gradeLevel,
      gradeCode: level?.code ?? null,
      leaders: mine.filter((m) => m.role === "leader").map(({ id, name }) => ({ id, name })),
      students: mine.filter((m) => m.userRole === "schueler").map(({ id, name }) => ({ id, name })),
      proposal: level && next ? promotedName(c.name, level, next) : null,
      proposalSlug: level && next ? slugify(promotedName(c.slug, level, next)) : null,
    };
  });
}

export const LEAVE = "abgang";

export interface PromotionInput {
  /** je Klasse des alten Jahres: Name der neuen Klasse (leer = ganzer Jahrgang geht ab) und ob die Leitung mitgeht */
  classes: { groupId: string; toName: string; keepLeaders: boolean }[];
  /** einzelne Schüler:innen abweichend: Name einer neuen Klasse oder LEAVE */
  overrides: Record<string, string>;
}

/** Rein: Ziel je Schüler:in und die neuen Klassen mit Jahrgang. Wirft bei Zielen, die es nicht gibt. */
export function resolvePromotion(plan: readonly PromotionClass[], input: PromotionInput, levels: readonly { level: number }[]) {
  const fe: Record<string, string> = {};
  const byGroup = new Map(input.classes.map((c) => [c.groupId, c]));
  const targets = new Map<string, { name: string; slug: string; gradeLevel: number | null; sources: string[]; leaders: string[] }>();
  for (const c of plan) {
    const name = (byGroup.get(c.groupId)?.toName ?? c.proposal ?? "").trim();
    if (!name) continue;
    const nextLevel = c.gradeLevel == null ? null : (levels.find((l) => l.level > c.gradeLevel!)?.level ?? null);
    const key = name.toLowerCase();
    const slug = (name === c.proposal ? c.proposalSlug : null) || slugify(name) || "klasse";
    const t = targets.get(key) ?? { name, slug, gradeLevel: nextLevel, sources: [], leaders: [] };
    if (t.gradeLevel !== nextLevel) fe[`class-${c.groupId}`] = `„${name}“ bekommt Schüler:innen aus verschiedenen Jahrgängen`;
    t.sources.push(c.groupId);
    if (byGroup.get(c.groupId)?.keepLeaders ?? true) t.leaders.push(...c.leaders.map((l) => l.id));
    targets.set(key, t);
  }
  const assignment = new Map<string, string | typeof LEAVE>();
  for (const c of plan) {
    const name = (byGroup.get(c.groupId)?.toName ?? c.proposal ?? "").trim();
    for (const s of c.students) {
      const o = input.overrides[s.id]?.trim();
      const target = o || name || LEAVE;
      if (target !== LEAVE && !targets.has(target.toLowerCase())) fe[`student-${s.id}`] = `Klasse „${target}“ gibt es im neuen Schuljahr nicht`;
      assignment.set(s.id, target === LEAVE ? LEAVE : targets.get(target.toLowerCase())?.name ?? target);
    }
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { targets: [...targets.values()], assignment };
}

/** Legt die Klassen im neuen Schuljahr an, setzt Schüler:innen um und merkt Abgänger:innen vor. */
export async function promote(db: Db, actorId: string, transitionId: string, input: PromotionInput) {
  const { t, from, to } = await loadTransition(db, transitionId);
  if (t.promotedAt) throw new ValidationError({ transition: "Die Versetzung ist bereits erfolgt" });
  const plan = await planPromotion(db, from.id);
  const levels = await db.select({ level: gradeLevels.level }).from(gradeLevels);
  const { targets, assignment } = resolvePromotion(plan, input, levels);
  const homeRoom = new Map((await db.select({ id: groups.id, room: groups.homeRoomId }).from(groups).where(eq(groups.schoolYearId, from.id))).map((g) => [g.id, g.room]));
  const yearSuffix = slugify(from.name);
  const leavers = [...assignment].filter(([, v]) => v === LEAVE).map(([k]) => k);

  const created = await db.transaction(async (tx) => {
    const out = new Map<string, string>();
    for (const target of targets) {
      // Kurzname frei machen: gleichnamige Gruppe des alten Jahres bekommt das Schuljahr angehängt („8b“ → „8b-2026-27“)
      const slug = target.slug;
      const [clash] = await tx.select({ id: groups.id, schoolYearId: groups.schoolYearId }).from(groups).where(eq(groups.slug, slug));
      if (clash?.schoolYearId === from.id) await tx.update(groups).set({ slug: `${slug}-${yearSuffix}` }).where(eq(groups.id, clash.id));
      else if (clash) throw new ValidationError({ transition: `Kurzname „${slug}“ ist schon vergeben` });
      const [g] = await tx
        .insert(groups)
        .values({
          name: target.name,
          slug,
          kind: "klasse",
          gradeLevel: target.gradeLevel,
          schoolYearId: to.id,
          homeRoomId: homeRoom.get(target.sources[0]!) ?? null,
          ownerId: actorId,
        })
        .returning({ id: groups.id });
      out.set(target.name, g!.id);
      const leaders = [...new Set(target.leaders)];
      if (leaders.length) await tx.insert(groupMembers).values(leaders.map((userId) => ({ groupId: g!.id, userId, role: "leader" as const })));
    }
    const rows = [...assignment].filter(([, v]) => v !== LEAVE).map(([userId, name]) => ({ groupId: out.get(name)!, userId, role: "member" as const }));
    if (rows.length) await tx.insert(groupMembers).values(rows).onConflictDoNothing();
    await tx.update(schoolYearTransitions).set({ promotedAt: new Date(), leavers }).where(eq(schoolYearTransitions.id, t.id));
    return out;
  });
  await audit(db, actorId, "verwaltung.schuljahreswechsel.versetzung", null, {
    classes: created.size,
    students: assignment.size - leavers.length,
    leavers: leavers.length,
  });
  return { classes: [...created.values()], leavers };
}

// ---------------------------------------------------------------- Archivexport (Stand) und Archivieren

/** Gruppen des alten Schuljahres mit Akte (Klassenbuch-Einträgen) und Stand ihres Archivexports. */
export async function archiveStatus(db: Db, fromYearId: string) {
  const yearGroups = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, entries: count(classbookEntries.id) })
    .from(groups)
    .innerJoin(classbookEntries, eq(classbookEntries.groupId, groups.id))
    .where(eq(groups.schoolYearId, fromYearId))
    .groupBy(groups.id)
    .orderBy(asc(groups.gradeLevel), asc(groups.name));
  if (!yearGroups.length) return [];
  const archives = await db.select().from(recordArchives).where(inArray(recordArchives.groupId, yearGroups.map((g) => g.id)));
  return yearGroups.map((g) => ({ ...g, archive: archives.find((a) => a.groupId === g.id) ?? null }));
}

/** Archiviert alle Gruppen des alten Schuljahres: Mitgliedschaften enden, Inhalte bleiben bis zur Löschfrist. */
export async function archiveYearGroups(db: Db, actorId: string, transitionId: string): Promise<number> {
  const { t, from } = await loadTransition(db, transitionId);
  if (!t.promotedAt) throw new ValidationError({ transition: "Erst die Versetzung durchführen" });
  if (t.archivedAt) return 0;
  const missing = (await archiveStatus(db, from.id)).filter((s) => !s.archive);
  if (missing.length) throw new ValidationError({ transition: `Erst die Klassenbücher exportieren: ${missing.map((m) => m.name).join(", ")}` });
  const ids = (await db.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolYearId, from.id), isNull(groups.archivedAt)))).map((g) => g.id);
  await db.transaction(async (tx) => {
    if (ids.length) {
      await tx.update(groups).set({ archivedAt: new Date() }).where(inArray(groups.id, ids));
      await tx.delete(groupMembers).where(inArray(groupMembers.groupId, ids));
    }
    await tx.update(schoolYearTransitions).set({ archivedAt: new Date() }).where(eq(schoolYearTransitions.id, t.id));
  });
  await audit(db, actorId, "verwaltung.schuljahreswechsel.archiv", null, { groups: ids.length, year: from.name });
  return ids.length;
}

// ---------------------------------------------------------------- Prüfschritt und Abschluss

export async function confirmReview(db: Db, actorId: string, transitionId: string, confirmed: boolean): Promise<void> {
  const { t } = await loadTransition(db, transitionId);
  if (!t.archivedAt) throw new ValidationError({ review: "Erst die Gruppen archivieren" });
  if (!confirmed) throw new ValidationError({ review: "Bitte bestätigen, dass Löschprotokoll und Löschsperren geprüft sind" });
  await db.update(schoolYearTransitions).set({ reviewedAt: new Date(), reviewedBy: actorId }).where(eq(schoolYearTransitions.id, t.id));
  await audit(db, actorId, "verwaltung.schuljahreswechsel.pruefung", null, {});
}

/** Abschluss: neues Schuljahr wird das aktuelle; Abgänger:innen werden zum Schuljahresende abgemeldet. */
export async function completeTransition(db: Db, actorId: string, transitionId: string): Promise<{ left: number }> {
  const { t, from, to } = await loadTransition(db, transitionId);
  if (!t.reviewedAt) throw new ValidationError({ transition: "Erst Löschprotokoll und Löschsperren prüfen" });
  let left = 0;
  const leavers = t.leavers.length
    ? await db.select({ id: users.id, leftOn: users.leftOn }).from(users).where(inArray(users.id, t.leavers))
    : [];
  for (const u of leavers) {
    if (u.leftOn || u.id === actorId) continue;
    await setAccountLeft(db, actorId, u.id, from.endsOn);
    left++;
  }
  await db.transaction(async (tx) => {
    await tx.update(schoolYears).set({ isCurrent: false }).where(ne(schoolYears.id, to.id));
    await tx.update(schoolYears).set({ isCurrent: true }).where(eq(schoolYears.id, to.id));
    await tx.update(schoolYearTransitions).set({ completedAt: new Date() }).where(eq(schoolYearTransitions.id, t.id));
  });
  await audit(db, actorId, "verwaltung.schuljahreswechsel.abschluss", null, { from: from.name, to: to.name, left });
  return { left };
}
