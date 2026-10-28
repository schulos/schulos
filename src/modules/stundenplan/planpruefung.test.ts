// SP3-03: Prüfung & Freigabe – Statusregeln (wer darf was, ohne Vier-Augen-Zwang), Bearbeiten nur im Entwurf, Kommentare (Bezug, Sichtbarkeit,
// erledigen), Lehrkräfte-Vorschau „Mein Plan ab …“ (nur eigener Plan), Auskunft/Kontolöschung und Querschnitt „Kommentare und Entwurf nie
// außerhalb der Planung“ (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1, §5).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, grants, timetableDraftLessons, timetablePlanComments, timetablePlanVersions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, requiresTwoFactor } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { ValidationError } from "@/modules/verwaltung/users";
import { createLesson, lessonsOfGroup } from "./manage";
import { draftOf } from "./plan-quelle";
import {
  addComment,
  addPreviewComment,
  allowedTransitions,
  approveVersion,
  canComment,
  canSeeVersion,
  commentTargets,
  listComments,
  ownComments,
  previewVersions,
  resolveComment,
  returnToPlanning,
  reviewQueue,
  setTeacherPreview,
  submitForReview,
  teacherPreview,
  type Viewer,
} from "./planpruefung";
import { createDraft, getVersion } from "./planversionen";
import { writableSource } from "./quelle";
import { PLAN_REVIEW } from "./rechte";
import { planningYear } from "./verteilung";

const today = "2026-10-05";
const cutoff = "2027-02-01";
const PLANER = "u-frank.schulte";
const SL = "u-petra.lindner";
const JANA = "u-jana.brandt";

const planer: Viewer = { userId: PLANER, manage: true, review: false };
const sl: Viewer = { userId: SL, manage: false, review: true };
const both: Viewer = { userId: PLANER, manage: true, review: true };
const nobody: Viewer = { userId: JANA, manage: false, review: false };

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Prüfung & Freigabe (SP3-03, Demo-Schule)", () => {
  let h: DbHandle;
  let yearId: string;
  let draftId: string;
  const actions = async (id: string) =>
    (await h.db.select({ action: auditLog.action, meta: auditLog.meta }).from(auditLog).where(eq(auditLog.target, id)).orderBy(asc(auditLog.id))).filter((a) => a.action.startsWith("stundenplan.plan."));
  beforeAll(async () => {
    h = await createSeededTestDb();
    yearId = (await planningYear(h.db))!.id;
    draftId = (await createDraft(h.db, PLANER, { schoolYearId: yearId, source: "live_copy", validFrom: cutoff, numbering: "major", name: "Halbjahr" }, today)).id;
  });
  afterAll(() => h.close());

  it("Recht `stundenplan.review`: Schulleitung hat es (Seed wie Migration 0112), zählt für die 2FA-Pflicht wie die Planungsrechte", async () => {
    const rows = await h.db.select().from(grants).where(eq(grants.permission, PLAN_REVIEW)).orderBy(asc(grants.id));
    expect(rows.map((g) => g.groupId)).toEqual(["g-schulleitung"]);
    const petra = await loadPermissions(h.db, SL);
    expect(petra.granted.has(PLAN_REVIEW)).toBe(true);
    const jana = await loadPermissions(h.db, JANA);
    expect(jana.granted.has(PLAN_REVIEW)).toBe(false);
    expect(requiresTwoFactor("lehrkraft", [PLAN_REVIEW])).toBe(true);
    expect(requiresTwoFactor("lehrkraft", ["stundenplan.*"])).toBe(true);
    expect(requiresTwoFactor("lehrkraft", ["stundenplan.absence_approve"])).toBe(false);
  });

  it("Sichtbarkeit: Planung sieht jede Version, Prüfung erst ab „in Prüfung“, ohne Recht niemand", async () => {
    const v = (await getVersion(h.db, draftId))!;
    expect(v.status).toBe("entwurf");
    expect(canSeeVersion(planer, v)).toBe(true);
    expect(canSeeVersion(sl, v)).toBe(false);
    expect(canSeeVersion(nobody, v)).toBe(false);
    expect(canSeeVersion(sl, { status: "pruefung" })).toBe(true);
    expect(canSeeVersion(sl, { status: "freigegeben" })).toBe(true);
    expect(canSeeVersion(sl, { status: "verworfen" })).toBe(false);
    expect(allowedTransitions(planer, v)).toEqual({ submit: true, approve: false, giveBack: false });
    expect(allowedTransitions(sl, v)).toEqual({ submit: false, approve: false, giveBack: false });
    expect(allowedTransitions(sl, { status: "pruefung" })).toEqual({ submit: false, approve: true, giveBack: true });
    expect(allowedTransitions(planer, { status: "pruefung" })).toEqual({ submit: false, approve: false, giveBack: true });
    expect(canComment(sl, v)).toBe(false);
    expect(canComment(planer, v)).toBe(true);
    expect(await listComments(h.db, sl, v)).toEqual([]);
  });

  it("Statuswege: nur die Planung reicht ein, nur die Prüfung gibt frei; Bearbeiten nur im Entwurf; zurück an die Planung lässt die Freigabe verfallen", async () => {
    // Prüfung darf nicht einreichen, Planung nicht freigeben
    expect(await errorOf(submitForReview(h.db, sl, draftId))).toMatch(/nur die Stundenplanung/);
    expect(await errorOf(approveVersion(h.db, planer, draftId))).toMatch(/Freigeben darf nur/);
    expect(await errorOf(approveVersion(h.db, sl, draftId))).toMatch(/nur eine Version in Prüfung/);
    expect(await errorOf(returnToPlanning(h.db, sl, draftId))).toMatch(/in Prüfung oder freigegeben/);

    const submitted = await submitForReview(h.db, planer, draftId, new Date("2026-10-05T10:00:00Z"));
    expect(submitted).toMatchObject({ status: "pruefung", submittedBy: PLANER, approvedBy: null });
    expect(await errorOf(submitForReview(h.db, planer, draftId))).toMatch(/nur ein Entwurf/);
    expect((await reviewQueue(h.db)).map((v) => v.id)).toEqual([draftId]);

    // in Prüfung nur lesbar – eine Änderung setzt den Status nicht still zurück
    const source = draftOf(draftId);
    const l = (await lessonsOfGroup(h.db, "g-7b", cutoff, source))[0]!.l;
    const input = { groupId: "g-7b", weekday: l.weekday, periodNr: 9, subjectId: l.subjectId, teacherId: null, roomId: null, week: "all" as const, validFrom: cutoff, validUntil: null };
    expect(await errorOf(createLesson(h.db, PLANER, input, source))).toMatch(/in Prüfung – zum Bearbeiten erst „Zurück an die Planung“/);
    expect((await getVersion(h.db, draftId))!.status).toBe("pruefung");

    const approved = await approveVersion(h.db, sl, draftId, new Date("2026-10-06T08:00:00Z"));
    expect(approved).toMatchObject({ status: "freigegeben", approvedBy: SL });
    expect(await errorOf(createLesson(h.db, PLANER, input, source))).toMatch(/freigegeben – zum Bearbeiten/);
    expect(await errorOf(approveVersion(h.db, sl, draftId))).toMatch(/nur eine Version in Prüfung/);

    // Planung holt zurück (Freigabe verfällt) – danach wieder bearbeitbar
    const back = await returnToPlanning(h.db, planer, draftId, "Raumtausch Mo nachtragen");
    expect(back).toMatchObject({ status: "entwurf", approvedBy: null, approvedAt: null, submittedBy: PLANER });
    expect(await writableSource(h.db, draftId)).toEqual(source);
    const note = await h.db.select().from(timetablePlanComments).where(eq(timetablePlanComments.versionId, draftId)).orderBy(asc(timetablePlanComments.createdAt));
    expect(note.map((c) => [c.targetKind, c.authorId, c.body])).toEqual([["version", PLANER, "Raumtausch Mo nachtragen"]]);

    // erneut einreichen; die Prüfung gibt zurück
    await submitForReview(h.db, planer, draftId);
    const given = await returnToPlanning(h.db, sl, draftId, "");
    expect(given.status).toBe("entwurf");
    expect((await actions(draftId)).map((a) => [a.action, (a.meta as { from?: string; by?: string } | null)?.from ?? null, (a.meta as { by?: string } | null)?.by ?? null])).toEqual([
      ["stundenplan.plan.create", null, null],
      ["stundenplan.plan.submit", null, null],
      ["stundenplan.plan.approve", null, null],
      ["stundenplan.plan.return", "freigegeben", "manage"],
      ["stundenplan.plan.submit", null, null],
      ["stundenplan.plan.return", "pruefung", "review"],
    ]);
  });

  it("ohne Vier-Augen-Zwang (F-10-3): wer beide Rechte hat, gibt den eigenen Entwurf frei – das Audit vermerkt es", async () => {
    await submitForReview(h.db, both, draftId);
    await approveVersion(h.db, both, draftId);
    const approve = (await actions(draftId)).filter((a) => a.action === "stundenplan.plan.approve").at(-1)!;
    expect(approve.meta).toMatchObject({ self: true });
    const first = (await actions(draftId)).filter((a) => a.action === "stundenplan.plan.approve")[0]!;
    expect(first.meta).toMatchObject({ self: false });
    // Freigabe zurücknehmen (Prüfung) → Entwurf
    await returnToPlanning(h.db, sl, draftId);
    expect((await getVersion(h.db, draftId))!).toMatchObject({ status: "entwurf", approvedBy: null });
  });

  it("Kommentare: Bezug nur aus dem Entwurf, Prüfung ab „in Prüfung“, erledigen nur die Planung", async () => {
    // Planung kommentiert im Entwurf, die Prüfung noch nicht
    const targets = await commentTargets(h.db, draftId);
    expect(targets.teachers.length).toBeGreaterThan(5);
    expect(targets.groups.some((g) => g.label === "Klasse 7b")).toBe(true);
    await addComment(h.db, planer, draftId, { targetKind: "group", groupId: "g-7b", body: "7b prüfen" });
    expect(await errorOf(addComment(h.db, sl, draftId, { targetKind: "version", body: "zu früh" }))).toBe("Die Version gibt es nicht (mehr)");

    await submitForReview(h.db, planer, draftId);
    const c1 = await addComment(h.db, sl, draftId, { targetKind: "teacher", teacherId: JANA, body: "Hohlstunde Di prüfen" });
    const c2 = await addComment(h.db, sl, draftId, { targetKind: "slot", weekday: 0, periodNr: 1, groupId: "g-7b", body: "Mo 1. zu früh" });
    expect(c2).toMatchObject({ targetKind: "slot", weekday: 0, periodNr: 1, groupId: "g-7b" });
    expect(await errorOf(addComment(h.db, sl, draftId, { targetKind: "teacher", teacherId: "u-lea.schaefer", body: "x" }))).toMatch(/Lehrkraft aus dem Entwurf/);
    expect(await errorOf(addComment(h.db, sl, draftId, { targetKind: "group", groupId: "gibt-es-nicht", body: "x" }))).toMatch(/Klasse oder Kurs/);
    expect(await errorOf(addComment(h.db, sl, draftId, { targetKind: "slot", weekday: 5, periodNr: 1, body: "x" }))).toMatch(/Wochentag/);
    expect(await errorOf(addComment(h.db, sl, draftId, { targetKind: "version", body: "   " }))).toMatch(/Text eingeben/);
    expect(await errorOf(addComment(h.db, sl, draftId, { targetKind: "version", body: "x".repeat(501) }))).toMatch(/500 Zeichen/);

    const v = (await getVersion(h.db, draftId))!;
    const list = await listComments(h.db, sl, v);
    expect(list.map((c) => c.targetText)).toEqual(["ganze Version", "Klasse 7b", expect.stringMatching(/^Lehrkraft BRA – /), "Mo 1. Stunde · Klasse 7b"]);
    expect(list.every((c) => c.comment.resolvedAt === null)).toBe(true);

    expect(await errorOf(resolveComment(h.db, sl, c1.id, true))).toMatch(/nur die Stundenplanung/);
    await resolveComment(h.db, planer, c1.id, true);
    const after = await listComments(h.db, planer, v);
    expect(after.at(-1)).toMatchObject({ comment: { id: c1.id, resolvedBy: PLANER }, resolvedByName: expect.any(String) });
    await resolveComment(h.db, planer, c1.id, false);
    expect((await listComments(h.db, planer, v)).find((c) => c.comment.id === c1.id)!.comment.resolvedAt).toBeNull();
  });

  it("Lehrkräfte-Vorschau: aus (Vorgabe) bzw. im Entwurf unsichtbar; an + in Prüfung nur die eigenen Stunden; Rückmeldung nur zum eigenen Plan", async () => {
    const v0 = (await getVersion(h.db, draftId))!;
    expect(v0).toMatchObject({ status: "pruefung", teacherPreview: false });
    expect(await teacherPreview(h.db, JANA, draftId)).toBeNull();
    expect(await previewVersions(h.db)).toEqual([]);
    expect(await errorOf(setTeacherPreview(h.db, sl, draftId, true))).toMatch(/nur die Stundenplanung/);
    await setTeacherPreview(h.db, planer, draftId, true);
    expect((await previewVersions(h.db)).map((v) => v.id)).toEqual([draftId]);

    const preview = (await teacherPreview(h.db, JANA, draftId))!;
    const own = await h.db.select().from(timetableDraftLessons).where(and(eq(timetableDraftLessons.versionId, draftId), eq(timetableDraftLessons.teacherId, JANA)));
    expect(own.length).toBeGreaterThan(5);
    expect(preview.lessons.map((l) => l.id).sort()).toEqual(own.map((l) => l.id).sort());
    // nichts Internes: keine Lehrkraft-Kennungen, keine Herkunft, keine Kommentare – nur Fach, Gruppe, Raum, Zeit
    for (const l of preview.lessons) expect(Object.keys(l).sort()).toEqual(["groupName", "id", "periodNr", "roomId", "subjectColor", "subjectName", "validFrom", "validUntil", "week", "weekday"]);
    expect(JSON.stringify(preview)).not.toMatch(/u-[a-z]+\.[a-z]+/);

    // Rückmeldung: ganze eigene Person oder eigene Stunde, nie eine fremde
    const slot = preview.lessons[0]!;
    const c = await addPreviewComment(h.db, JANA, draftId, { weekday: slot.weekday, periodNr: slot.periodNr, body: "Bitte nicht in der 1." });
    expect(c).toMatchObject({ authorId: JANA, teacherId: JANA, fromPreview: true, targetKind: "slot" });
    const free = [0, 1, 2, 3, 4].flatMap((wd) => [1, 2, 3, 4, 5, 6].map((p) => [wd, p] as const)).find(([wd, p]) => !preview.lessons.some((l) => l.weekday === wd && l.periodNr === p))!;
    expect(await errorOf(addPreviewComment(h.db, JANA, draftId, { weekday: free[0], periodNr: free[1], body: "x" }))).toMatch(/aus deinem Plan/);
    await addPreviewComment(h.db, JANA, draftId, { body: "Insgesamt passt es." });
    // eigene Kommentare: nur die eigenen (nicht der der Schulleitung über sie)
    const mine = await ownComments(h.db, JANA, draftId);
    expect(mine.map((m) => m.comment.body)).toEqual(["Bitte nicht in der 1.", "Insgesamt passt es."]);
    // die Planung sieht sie mit Herkunft „Vorschau“
    const all = await listComments(h.db, planer, (await getVersion(h.db, draftId))!);
    expect(all.filter((x) => x.comment.fromPreview).map((x) => x.comment.authorId)).toEqual([JANA, JANA]);

    // zurück an die Planung: Vorschau wirkt nicht mehr (Schalter bleibt), Rückmeldung abgelehnt
    await returnToPlanning(h.db, planer, draftId);
    expect(await teacherPreview(h.db, JANA, draftId)).toBeNull();
    expect(await errorOf(addPreviewComment(h.db, JANA, draftId, { body: "x" }))).toMatch(/nicht \(mehr\) freigeschaltet/);
    expect((await getVersion(h.db, draftId))!.teacherPreview).toBe(true);
  });

  it("Auskunft (Art. 15): eigene Kommentare mit Text; Kommentare über eine Lehrkraft (Entwurf ohne Außenwirkung) nicht; Kontolöschung leert Verfasser:in und Bezug", async () => {
    const jana = (await collectPersonalData(h.db, JANA))!;
    const own = jana.sections.filter((s) => s.table === "timetable_plan_comments");
    expect(own).toHaveLength(1);
    expect(own[0]!.asActor).toBeFalsy();
    expect(own[0]!.rows.map((r) => r.body).sort()).toEqual(["Bitte nicht in der 1.", "Insgesamt passt es."]);
    const petra = (await collectPersonalData(h.db, SL))!;
    const sec = petra.sections.find((s) => s.table === "timetable_plan_comments" && !s.asActor)!;
    expect(sec.rows.map((r) => r.body)).toEqual(expect.arrayContaining(["Hohlstunde Di prüfen"]));

    await deleteAccounts(h.db, [JANA]);
    const rows = await h.db.select().from(timetablePlanComments).where(eq(timetablePlanComments.versionId, draftId));
    expect(rows.some((r) => r.authorId === JANA || r.teacherId === JANA)).toBe(false);
    expect(rows.filter((r) => r.fromPreview)).toHaveLength(2);
    // Version verworfen und gelöscht → Kommentare gehen mit (Löschklasse „folgt der Version“)
    await h.db.delete(timetablePlanVersions).where(eq(timetablePlanVersions.id, draftId));
    expect(await h.db.$count(timetablePlanComments, eq(timetablePlanComments.versionId, draftId))).toBe(0);
  });
});

describe("Querschnitt: Kommentare, Vorschau und Entwurfsstunden nie außerhalb der Planung (SP3-03, §5 a/c)", () => {
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

  it("`timetable_plan_comments` liest nur das Modul (Schema, Manifest, Prüfung) – kein Plan-, Monitor-, Gong- oder Export-Leser; die Auskunft nennt sie nur zum Auslassen des Bezugs", () => {
    const hits = files.filter((f) => /timetablePlanComments|timetable_plan_comments/.test(f.text)).map((f) => f.path).sort();
    expect(hits).toEqual(["src/core/privacy/auskunft.ts", "src/modules/stundenplan/manifest.ts", "src/modules/stundenplan/planpruefung.ts", "src/modules/stundenplan/schema.ts"]);
    expect(files.find((f) => f.path === "src/core/privacy/auskunft.ts")!.text).toMatch(/EXPORT_SKIP_REFS[\s\S]*"timetable_plan_comments\.teacher_id"/);
  });

  it("Prüf-Services nutzen nur Planungsseiten und die Lehrkräfte-Vorschau – Schülersicht, Monitor, Gong, Druck und Exporte nicht", () => {
    const users = files.filter((f) => /planpruefung/.test(f.text) && f.path !== "src/modules/stundenplan/planpruefung.ts").map((f) => f.path).sort();
    expect(users).toEqual([
      // SP3-06: Planungsfahrplan (Sichtbarkeit wie die Versionsliste, offene Kommentare in Schritt 8)
      "src/app/(shell)/planung/fahrplan/page.tsx",
      "src/app/(shell)/planung/page.tsx",
      "src/app/(shell)/planung/versionen/aenderungen/page.tsx",
      "src/app/(shell)/planung/versionen/page.tsx",
      "src/app/(shell)/planung/versionen/pruefung/page.tsx",
      "src/app/(shell)/stundenplan/page.tsx",
      "src/app/(shell)/stundenplan/vorschau/page.tsx",
      "src/modules/stundenplan/actions.ts",
      "src/modules/stundenplan/fahrplan.ts",
    ]);
    // der Wochenplan ruft nur die Liste freigeschalteter Versionen ab – und nur für Lehrkräfte
    const plan = files.find((f) => f.path === "src/app/(shell)/stundenplan/page.tsx")!.text;
    expect(plan.match(/planpruefung";/g)).toHaveLength(1);
    expect(plan).toMatch(/import \{ previewVersions \} from "@\/modules\/stundenplan\/planpruefung"/);
    expect(plan).toMatch(/user\.role === "lehrkraft" \? previewVersions\(db\)/);
    // die Vorschau-Seite prüft die Rolle, bevor sie lädt
    expect(files.find((f) => f.path === "src/app/(shell)/stundenplan/vorschau/page.tsx")!.text).toMatch(/if \(user\.role !== "lehrkraft"\) notFound\(\);/);
    for (const reader of ["monitor", "druck", "api", "eltern"]) expect(users.some((u) => u.includes(`/${reader}/`))).toBe(false);
  });
});
