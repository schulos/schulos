// SP3-01: Planversionen + Entwurfsbereich – Bestand 1.0, Entwurf anlegen (gültiger Plan ab Stichtag, leer, Vorversion), Variante,
// Verwerfen, Nummern, Nachtjob, Auskunft/Kontolöschung und der Querschnittstest „kein fremder Leser“ (docs/STUNDENPLAN-LEBENSZYKLUS.md §5).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, schoolYears, timetableDraftLessons, timetableLessons, timetablePlanVersions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { ValidationError } from "@/modules/verwaltung/users";
import { lessonTable, planFigures, planLessons } from "./plan-quelle";
import {
  cleanupVersions,
  createDraft,
  createVariant,
  discardVersion,
  ensureBaseVersions,
  listVersions,
  nextNumber,
  suggestedValidFrom,
  validVersion,
  versionSource,
} from "./planversionen";
import { regularSlots } from "./service";

const today = "2026-10-05";
const cutoff = "2027-02-01";

describe("Planversionen (Demo-Schule)", () => {
  let h: DbHandle;
  let yearId: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    // der Seed legt „Bestand 1.0“ mit dem echten Datum an – hier mit festem „heute“ neu
    await h.db.update(timetableLessons).set({ planVersionId: null });
    await h.db.delete(timetablePlanVersions);
    await ensureBaseVersions(h.db, today);
    yearId = (await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)))[0]!.id;
  });
  afterAll(() => h.close());

  const liveSnapshot = async () => (await h.db.select().from(timetableLessons)).sort((a, b) => a.id.localeCompare(b.id));

  it("Bestand 1.0: gültig ab Schuljahresbeginn, heutige Stunden tragen die Herkunft, idempotent", async () => {
    const base = (await validVersion(h.db, yearId))!;
    expect(base).toMatchObject({ major: 1, minor: 0, name: "Bestand", status: "gueltig", source: "bestand", validFrom: "2026-08-01", validUntil: null, createdBy: null });
    const lessons = await h.db.select().from(timetableLessons);
    expect(lessons.length).toBeGreaterThan(100);
    expect(lessons.every((l) => l.planVersionId === base.id)).toBe(true);
    expect(await ensureBaseVersions(h.db, today)).toBe(0);
    expect(await h.db.$count(timetablePlanVersions)).toBe(1);
    // Kennzahlen der Karte = gültiger Plan am Stichtag
    const [card] = await listVersions(h.db, yearId, today);
    expect(card).toMatchObject({ label: "1.0", figuresOn: today });
    expect(card!.figures.lessons).toBe(lessons.length);
    expect(card!.figures.groups).toBe(new Set(lessons.map((l) => l.groupId)).size);
  });

  it("Entwurf aus dem gültigen Plan ab Stichtag: Kopie mit Herkunft, gültiger Plan und Leser unverändert", async () => {
    // eine Stunde endet vor dem Stichtag (kommt nicht mit), eine beginnt danach (kommt mit, eigener Beginn)
    const [first, second] = (await h.db.select().from(timetableLessons).where(eq(timetableLessons.groupId, "g-7b"))).sort((a, b) => a.weekday - b.weekday || a.periodNr - b.periodNr);
    await h.db.update(timetableLessons).set({ validUntil: "2027-01-29" }).where(eq(timetableLessons.id, first!.id));
    const [later] = await h.db
      .insert(timetableLessons)
      .values({ groupId: "g-7a", weekday: 4, periodNr: 8, subjectId: second!.subjectId, validFrom: "2027-03-01", validUntil: "2027-07-31" })
      .returning();
    const before = await liveSnapshot();
    const plan7bBefore = await regularSlots(h.db, { kind: "group", id: "g-7b" }, cutoff);

    const v = await createDraft(h.db, "u-frank.schulte", { schoolYearId: yearId, source: "live_copy", validFrom: cutoff, numbering: "major", name: null }, today);
    expect(v).toMatchObject({ major: 2, minor: 0, status: "entwurf", source: "live_copy", validFrom: cutoff, name: "Ab 01.02.2027", createdBy: "u-frank.schulte" });
    expect(v.parentVersionId).toBe((await validVersion(h.db, yearId))!.id);

    const rows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, v.id));
    expect(rows.length).toBe(before.length - 1);
    expect(rows.some((r) => r.originLessonId === first!.id)).toBe(false);
    expect(rows.find((r) => r.originLessonId === later!.id)).toMatchObject({ validFrom: "2027-03-01", validUntil: "2027-07-31" });
    const copied = rows.find((r) => r.originLessonId === second!.id)!;
    expect(copied).toMatchObject({ groupId: second!.groupId, weekday: second!.weekday, periodNr: second!.periodNr, teacherId: second!.teacherId, roomId: second!.roomId, couplingId: second!.couplingId, validFrom: cutoff, validUntil: second!.validUntil });
    expect(rows.every((r) => r.validFrom >= cutoff && r.originLessonId !== null)).toBe(true);

    // gültiger Plan bleibt Zeile für Zeile, wie er war; Leser sehen den Entwurf nicht
    expect(await liveSnapshot()).toEqual(before);
    expect(await regularSlots(h.db, { kind: "group", id: "g-7b" }, cutoff)).toEqual(plan7bBefore);
    // Planquelle: dieselbe Zeilenform aus beiden Tabellen
    expect(lessonTable({ kind: "draft", versionId: v.id })).toBe(timetableDraftLessons);
    expect(lessonTable({ kind: "live", refYmd: cutoff })).toBe(timetableLessons);
    const live = await planLessons(h.db, { kind: "live", refYmd: cutoff });
    const draft = await planLessons(h.db, { kind: "draft", versionId: v.id });
    expect(Object.keys(draft[0]!).sort()).toEqual([...Object.keys(live[0]!), "originLessonId"].sort());
    expect(planFigures(draft).lessons).toBe(rows.length);
    expect(versionSource(v, today)).toEqual({ kind: "draft", versionId: v.id });

    const [entry] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "stundenplan.plan.create"), eq(auditLog.target, v.id)));
    expect(entry!.meta).toMatchObject({ version: "2.0", source: "live_copy", lessons: rows.length });
  });

  it("prüft Stichtag, Name, Nummer und Vorversion", async () => {
    const base = { schoolYearId: yearId, source: "live_copy" as const, numbering: "major" as const };
    const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ValidationError ? e.fieldErrors : e));
    expect(await err(createDraft(h.db, "u-admin", { ...base, validFrom: today }, today))).toMatchObject({ validFrom: expect.stringContaining("Zukunft") });
    expect(await err(createDraft(h.db, "u-admin", { ...base, validFrom: "2027-08-02" }, today))).toMatchObject({ validFrom: expect.stringContaining("Schuljahr") });
    expect(await err(createDraft(h.db, "u-admin", { ...base, validFrom: "2027-02-06" }, today))).toMatchObject({ validFrom: expect.stringContaining("Wochenende") });
    expect(await err(createDraft(h.db, "u-admin", { ...base, validFrom: "kein-datum" }, today))).toMatchObject({ validFrom: "Datum wählen" });
    expect(await err(createDraft(h.db, "u-admin", { ...base, validFrom: cutoff, name: "x".repeat(81) }, today))).toMatchObject({ name: expect.any(String) });
    expect(await err(createDraft(h.db, "u-admin", { ...base, source: "previous_version", validFrom: cutoff, previousVersionId: (await validVersion(h.db, yearId))!.id }, today))).toMatchObject({
      previousVersionId: expect.stringContaining("archivierte oder verworfene"),
    });
    expect(await err(createDraft(h.db, "u-admin", { ...base, source: "bestand" as never, validFrom: cutoff }, today))).toMatchObject({ source: expect.any(String) });
    expect(await suggestedValidFrom(h.db, { startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: "2027-02-01" }, today)).toBe(cutoff);
    expect(await suggestedValidFrom(h.db, { startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: null }, "2026-10-09")).toBe("2026-10-12");
  });

  it("Folgeversion, leerer Entwurf mit fixierten Stunden, Variante, Verwerfen, Kopie einer verworfenen Version", async () => {
    expect(await nextNumber(h.db, yearId, "minor")).toEqual({ major: 1, minor: 1 });
    const fixedLesson = (await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.groupId, "g-7a"), eq(timetableLessons.validFrom, "2026-08-01"))))[0]!;
    await h.db.update(timetableLessons).set({ fixed: true }).where(eq(timetableLessons.id, fixedLesson.id));
    const empty = await createDraft(h.db, "u-admin", { schoolYearId: yearId, source: "empty", validFrom: "2026-11-02", numbering: "minor", withFixed: true, name: "  Raumtausch   Mo " }, today);
    expect(empty).toMatchObject({ major: 1, minor: 1, name: "Raumtausch Mo", parentVersionId: null });
    const emptyRows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, empty.id));
    expect(emptyRows.map((r) => [r.originLessonId, r.fixed])).toEqual([[fixedLesson.id, true]]);

    // Variante: gleiche Nummer, gleiche Stunden (neue ids, gleiche Herkunft), eigener Status
    const variant = await createVariant(h.db, "u-admin", empty.id);
    expect(variant).toMatchObject({ major: 1, minor: 1, status: "entwurf", source: "variant_of", parentVersionId: empty.id, validFrom: "2026-11-02", name: "Raumtausch Mo – Variante" });
    const variantRows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, variant.id));
    expect(variantRows.map((r) => r.originLessonId)).toEqual([fixedLesson.id]);
    expect(variantRows[0]!.id).not.toBe(emptyRows[0]!.id);
    // Varianten zählen nicht: die nächste Folgeversion bleibt 1.2
    expect(await nextNumber(h.db, yearId, "minor")).toEqual({ major: 1, minor: 2 });

    // verwerfen: Status, Stunden bleiben; doppelt oder gültige Version → Fehler
    const discarded = await discardVersion(h.db, "u-admin", variant.id);
    expect(discarded).toMatchObject({ status: "verworfen", discardedBy: "u-admin" });
    expect(await h.db.$count(timetableDraftLessons, eq(timetableDraftLessons.versionId, variant.id))).toBe(1);
    await expect(discardVersion(h.db, "u-admin", variant.id)).rejects.toMatchObject({ fieldErrors: { version: expect.stringContaining("schon verworfen") } });
    await expect(discardVersion(h.db, "u-admin", (await validVersion(h.db, yearId))!.id)).rejects.toMatchObject({ fieldErrors: { version: expect.stringContaining("Nur Entwürfe") } });
    await expect(createVariant(h.db, "u-admin", variant.id)).rejects.toBeInstanceOf(ValidationError);

    // aus Vorversion: Kopie der verworfenen Variante, Stichtag neu
    const copy = await createDraft(h.db, "u-admin", { schoolYearId: yearId, source: "previous_version", previousVersionId: variant.id, validFrom: "2026-11-09", numbering: "major" }, today);
    expect(copy).toMatchObject({ source: "previous_version", parentVersionId: variant.id, name: "Kopie von 1.1", major: 3 });
    const copyRows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, copy.id));
    expect(copyRows.map((r) => [r.originLessonId, r.validFrom])).toEqual([[fixedLesson.id, "2026-11-09"]]);

    // Liste: offene und gültige oben, verworfene unten
    const list = await listVersions(h.db, yearId, today);
    expect(list.at(-1)!.version.status).toBe("verworfen");
    expect(list.find((s) => s.version.id === variant.id)!.parentLabel).toBe("1.1");
    expect(list.filter((s) => s.version.status === "gueltig")).toHaveLength(1);
  });

  it("Nachtjob: Rücknahme-Daten ab dem Stichtag weg, offene Entwürfe abgelaufener Schuljahre verworfen", async () => {
    const base = (await validVersion(h.db, yearId))!;
    await h.db.update(timetablePlanVersions).set({ undo: { ended: [{ id: "x", teacherId: "u-jana.brandt" }] } }).where(eq(timetablePlanVersions.id, base.id));
    // vor Schuljahresende: Entwürfe bleiben; Bestand hat Stichtag 01.08. → Rücknahme-Daten weg
    expect(await cleanupVersions(h.db, new Date("2026-10-06T03:00:00+02:00"))).toEqual({ undoCleared: 1, discarded: 0, based: 0 });
    const open = await h.db.$count(timetablePlanVersions, eq(timetablePlanVersions.status, "entwurf"));
    expect(open).toBeGreaterThan(0);
    // nach Schuljahresende: offene Entwürfe verworfen, gültige Version bleibt (Archivieren ist SP3-07)
    const after = await cleanupVersions(h.db, new Date("2027-08-02T03:00:00+02:00"));
    expect(after).toEqual({ undoCleared: 0, discarded: open, based: 0 });
    expect(await h.db.$count(timetablePlanVersions, eq(timetablePlanVersions.status, "entwurf"))).toBe(0);
    expect((await validVersion(h.db, yearId))!.id).toBe(base.id);
  });

  it("Auskunft: Entwurfsstunden erscheinen bei der Lehrkraft nicht, die Planung nur als Handelnde; Kontolöschung leert die Lehrkraft", async () => {
    const teacher = (await h.db.select().from(timetableDraftLessons).where(isNotNull(timetableDraftLessons.teacherId)))[0]!.teacherId!;
    const data = (await collectPersonalData(h.db, teacher))!;
    expect(data.sections.some((s) => s.table === "timetable_draft_lessons")).toBe(false);
    expect(data.sections.some((s) => s.table === "timetable_lessons")).toBe(true);
    const planer = (await collectPersonalData(h.db, "u-frank.schulte"))!;
    const versions = planer.sections.filter((s) => s.table === "timetable_plan_versions");
    expect(versions.map((s) => s.asActor)).toEqual([true]);
    expect(Object.keys(versions[0]!.rows[0]!).every((k) => ["id", "created_by"].includes(k) || k.endsWith("_at"))).toBe(true);

    await deleteAccounts(h.db, [teacher]);
    expect(await h.db.$count(timetableDraftLessons, eq(timetableDraftLessons.teacherId, teacher))).toBe(0);
  });
});

describe("Querschnitt: kein fremder Leser des Entwurfs (SP3-01, §5 b)", () => {
  const root = join(__dirname, "..", "..", "..");
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }
  const files = walk(join(root, "src")).map((f) => ({ path: relative(root, f).replaceAll("\\", "/"), text: readFileSync(f, "utf8") }));
  const DRAFT = /timetableDraftLessons|timetable_draft_lessons|lessonTable\(|PlanSource|plan-quelle/;

  it("außerhalb von src/modules/stundenplan liest niemand `timetable_draft_lessons` (nur das Schema-Register und die Auskunft, die sie auslässt)", () => {
    const hits = files.filter((f) => DRAFT.test(f.text) && !f.path.startsWith("src/modules/stundenplan/")).map((f) => f.path);
    expect(hits).toEqual(["src/core/privacy/auskunft.ts"]);
    expect(files.find((f) => f.path === "src/core/privacy/auskunft.ts")!.text).toMatch(/EXPORT_SKIP_REFS[\s\S]*"timetable_draft_lessons\.teacher_id"/);
  });

  it("im Modul nur Schema, Manifest (Löschklasse), Planquelle, Versionen, die Übernahme in den Entwurf (SP3-02) und die Prüfung (SP3-03) – Plan-Leser (Wochenplan, Vertretung, Monitor, Druck …) bleiben beim gültigen Plan", () => {
    const hits = files.filter((f) => /timetableDraftLessons|timetable_draft_lessons/.test(f.text) && f.path.startsWith("src/modules/stundenplan/")).map((f) => f.path).sort();
    expect(hits).toEqual([
      "src/modules/stundenplan/manifest.ts",
      "src/modules/stundenplan/plan-quelle.ts",
      // SP3-03: Lehrkräfte-Vorschau (nur die eigenen Stunden) und Bezugsauswahl der Kommentare
      "src/modules/stundenplan/planpruefung.ts",
      "src/modules/stundenplan/planversionen.ts",
      "src/modules/stundenplan/schema.ts",
      "src/modules/stundenplan/solverlauf.ts",
      // SP3-04: Veröffentlichen liest die Entwurfsstunden der Version (Diff gegen den gültigen Plan)
      "src/modules/stundenplan/veroeffentlichen.ts",
    ]);
    // Seiten lesen Entwürfe nur über Services des Moduls (Quelle als URL-Wert)
    const pages = files.filter((f) => f.path.startsWith("src/app/") && DRAFT.test(f.text)).map((f) => f.path);
    expect(pages).toEqual([]);
  });

  it("SP3-02: nur die Planung arbeitet mit der Planquelle – Vertretung, Wochenplan, Heute, Anzeige, Freigabe, Gong, Exporte, Periode lesen nur den gültigen Plan", () => {
    const planners = files.filter((f) => f.path.startsWith("src/modules/stundenplan/") && /lessonCols\(|lessonTable\(|PlanSource|plan-quelle/.test(f.text)).map((f) => f.path.replace("src/modules/stundenplan/", "")).sort();
    expect(planners).toEqual(["actions.ts", "diagnose.ts", "manage.ts", "plan-diff.ts", "plan-quelle.ts", "planversionen.ts", "quelle.ts", "schema.ts", "setzhilfe.ts", "solver-input.ts", "solverlauf.ts", "verteilung.ts"]);
    for (const reader of ["service.ts", "vertretung.ts", "today.ts", "display.ts", "widgets.tsx", "freigabe.ts", "vertretung-gong.ts", "abwesenheit.ts", "raumsperren.ts", "exporte.ts", "periode.ts", "arbeitsplatz.ts", "vorschlaege.ts"])
      expect(planners).not.toContain(reader);
  });

  it("`timetable_lessons`-Leser außerhalb des Moduls lesen weiter nur den gültigen Plan (keine Planquelle)", () => {
    const readers = files.filter((f) => /timetableLessons|timetable_lessons/.test(f.text) && !f.path.startsWith("src/modules/stundenplan/"));
    expect(readers.length).toBeGreaterThan(10);
    expect(readers.filter((f) => DRAFT.test(f.text) && f.path !== "src/core/privacy/auskunft.ts").map((f) => f.path)).toEqual([]);
  });
});
