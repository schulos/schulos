// Sitzplan (P5-01/P5-04): Sichtbarkeit nur für Lehrkräfte der Gruppe und die Klassenleitung, Speichern mit Prüfung,
// Fotos nur mit Einwilligung, Einbindung ins Klassenbuch (auch Vertretung).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, groupMembers, profilePhotos, sitzplanPlans, sitzplanSeats, timetableAssignments, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { arrangeSeats } from "./layout";
import {
  canUseGroup,
  copyPlan,
  createPlan,
  deletePlan,
  getPlan,
  groupStudents,
  listPlans,
  myGroups,
  planForLesson,
  plansByGroup,
  savePlan,
  searchPlans,
  updatePlanMeta,
} from "./service";
import { PHOTOS_SETTING } from "./settings";

const TODAY = "2026-10-07";
const JANA = "u-jana.brandt"; // Klassenleitung 7b
const TOBIAS = "u-tobias.kleine"; // Mathe in der 7b (Stundenplan)
const MURAT = "u-murat.yilmaz"; // Lehrkraft ohne Bezug zur 7b
const LEA = "u-lea.schaefer";

describe("Sitzplan", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let planId = "";
  let students: string[] = [];

  beforeAll(async () => {
    h = await createSeededTestDb();
    // eigener, überschaubarer Stundenplan: nur Mathe bei Herrn Kleine in der 7b
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    await h.db.delete(groupMembers).where(eq(groupMembers.userId, MURAT));
    await h.db.insert(timetableLessons).values({ weekday: 0, validFrom: "2026-08-01", validUntil: null, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: TOBIAS, roomId: "106" });
    students = (await groupStudents(h.db, "g-7b")).map((s) => s.id);
  }, 60_000);
  afterAll(() => h.close());

  it("Klassenleitung und Fachlehrkraft dürfen, andere Lehrkräfte, Verwaltung, Admin, Schüler:innen und Eltern nicht", async () => {
    expect(await canUseGroup(h.db, await p(JANA), "g-7b", TODAY)).toBe(true);
    expect(await canUseGroup(h.db, await p(TOBIAS), "g-7b", TODAY)).toBe(true);
    for (const id of [MURAT, "u-sabine.kowalski", "u-admin", LEA, "u-petra.lindner"]) expect(await canUseGroup(h.db, await p(id), "g-7b", TODAY), id).toBe(false);
    expect((await myGroups(h.db, await p(TOBIAS), TODAY)).map((g) => g.id)).toContain("g-7b");
    expect(await myGroups(h.db, await p(LEA), TODAY)).toEqual([]);
  });

  it("legt einen Plan aus einer Vorlage an (Titel, Fach, Raum geprüft) – nur für eigene Gruppen", async () => {
    const jana = await p(JANA);
    await expect(createPlan(h.db, jana, { groupId: "g-7b", title: " ", subjectId: null, roomId: null, rows: 5, cols: 8, preset: "reihen" }, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await expect(createPlan(h.db, jana, { groupId: "g-7b", title: "X", subjectId: "XX", roomId: null, rows: 5, cols: 8, preset: "reihen" }, TODAY)).rejects.toMatchObject({ fieldErrors: { subjectId: /Fach/ } });
    await expect(createPlan(h.db, jana, { groupId: "g-7b", title: "X", subjectId: null, roomId: null, rows: 13, cols: 8, preset: "reihen" }, TODAY)).rejects.toMatchObject({ fieldErrors: { rows: /Reihen/ } });
    await expect(createPlan(h.db, await p(MURAT), { groupId: "g-7b", title: "X", subjectId: null, roomId: null, rows: 5, cols: 8, preset: "reihen" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPlan(h.db, await p("u-admin"), { groupId: "g-7b", title: "X", subjectId: null, roomId: null, rows: 5, cols: 8, preset: "reihen" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    planId = await createPlan(h.db, jana, { groupId: "g-7b", title: "7b Klassenraum", subjectId: null, roomId: "106", rows: 5, cols: 8, preset: "reihen" }, TODAY);
    const [row] = await h.db.select().from(sitzplanPlans).where(eq(sitzplanPlans.id, planId));
    expect(row).toMatchObject({ ownerId: JANA, rows: 5, cols: 8, roomId: "106" });
    expect(row!.desks).toHaveLength(30);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "sitzplan.anlegen"))).toHaveLength(1);
  });

  it("fremde Pläne sind wie nicht vorhanden (null bzw. verboten) – auch für Admin und Verwaltung", async () => {
    expect(await getPlan(h.db, await p(TOBIAS), planId, TODAY)).not.toBeNull();
    for (const id of [MURAT, "u-sabine.kowalski", "u-admin", LEA, "u-petra.lindner"]) {
      const viewer = await p(id);
      expect(await getPlan(h.db, viewer, planId, TODAY), id).toBeNull();
      expect(await listPlans(h.db, viewer, TODAY), id).toEqual([]);
      expect(await searchPlans(h.db, viewer, "7b", TODAY), id).toEqual([]);
      expect((await plansByGroup(h.db, viewer, ["g-7b"], TODAY)).size, id).toBe(0);
      await expect(savePlan(h.db, viewer, planId, { rows: 5, cols: 8, desks: [], seats: [] }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deletePlan(h.db, viewer, planId, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await getPlan(h.db, await p(JANA), "gibt-es-nicht", TODAY)).toBeNull();
  });

  it("speichert Tische und Plätze geprüft und in einem Schritt", async () => {
    const jana = await p(JANA);
    const view = (await getPlan(h.db, jana, planId, TODAY))!;
    expect(view.students).toHaveLength(students.length);
    const seats = arrangeSeats(students, view.plan.desks, "alphabetisch");
    await expect(savePlan(h.db, jana, planId, { rows: 5, cols: 8, desks: view.plan.desks, seats: [...seats, { studentId: "u-admin", row: 4, col: 7 }] }, TODAY)).rejects.toMatchObject({
      fieldErrors: { seats: /gehört nicht/ },
    });
    await expect(savePlan(h.db, jana, planId, { rows: 5, cols: 8, desks: ["9:9"], seats: [] }, TODAY)).rejects.toMatchObject({ fieldErrors: { layout: /außerhalb/ } });
    expect(await h.db.select().from(sitzplanSeats)).toHaveLength(0);
    await savePlan(h.db, jana, planId, { rows: 5, cols: 8, desks: view.plan.desks, seats }, TODAY);
    const after = (await getPlan(h.db, await p(TOBIAS), planId, TODAY))!;
    expect(after.seats).toHaveLength(Math.min(students.length, 30));
    expect(after.seats[0]).toEqual({ studentId: students[0], row: 0, col: 0 });
    expect((await listPlans(h.db, jana, TODAY))[0]).toMatchObject({ id: planId, title: "7b Klassenraum", groupName: "Klasse 7b", seated: Math.min(students.length, 30) });
  });

  it("wer die Gruppe verlässt, verschwindet aus dem Plan", async () => {
    const leaving = students.at(-1)!;
    await h.db.insert(sitzplanSeats).values({ planId, studentId: leaving, row: 4, col: 7 }).onConflictDoNothing();
    await h.db.delete(groupMembers).where(eq(groupMembers.userId, leaving));
    const view = (await getPlan(h.db, await p(JANA), planId, TODAY))!;
    expect(view.students.map((s) => s.id)).not.toContain(leaving);
    expect(view.seats.map((s) => s.studentId)).not.toContain(leaving);
    await h.db.insert(groupMembers).values({ groupId: "g-7b", userId: leaving });
  });

  it("Profilbild nur mit Einwilligung und nur bei eingeschalteter Einstellung; ohne → Initialen", async () => {
    const withPhoto = students[0]!;
    await h.db.insert(profilePhotos).values({ userId: withPhoto, storageKey: "test/foto", mime: "image/png", consentBasis: "parent", consentOn: TODAY });
    const jana = await p(JANA);
    let view = (await getPlan(h.db, jana, planId, TODAY))!;
    expect(view.students.find((s) => s.id === withPhoto)?.photo).toMatch(/^\/api\/profilbild\//);
    expect(view.students.filter((s) => s.photo)).toHaveLength(1);
    expect(view.students[1]!.initials).toMatch(/^[A-ZÄÖÜ]{2}$/);
    // Druck: ohne Fotos
    expect((await getPlan(h.db, jana, planId, TODAY, { photos: false }))!.students.some((s) => s.photo)).toBe(false);
    await writeModuleSetting(h.db, PHOTOS_SETTING, "aus");
    view = (await getPlan(h.db, jana, planId, TODAY))!;
    expect(view.students.some((s) => s.photo)).toBe(false);
    await writeModuleSetting(h.db, PHOTOS_SETTING, "an");
  });

  it("Klassenbuch: passender Plan für Fachlehrkraft und Vertretung, nicht für Unbeteiligte", async () => {
    const lesson = { groupId: "g-7b", subjectId: "M", roomId: "106", teacherId: TOBIAS };
    expect((await planForLesson(h.db, await p(TOBIAS), lesson, TODAY))?.plan.id).toBe(planId);
    // Herr Yilmaz vertritt an dem Tag → sieht den Plan der Stunde, aber sonst keine Pläne der 7b
    expect((await planForLesson(h.db, await p(MURAT), { ...lesson, teacherId: MURAT }, TODAY))?.plan.id).toBe(planId);
    expect(await planForLesson(h.db, await p(MURAT), lesson, TODAY)).toBeNull();
    expect(await planForLesson(h.db, await p("u-admin"), lesson, TODAY)).toBeNull();
    // Fach-Plan schlägt den allgemeinen
    const mathe = await createPlan(h.db, await p(TOBIAS), { groupId: "g-7b", title: "Mathe", subjectId: "M", roomId: null, rows: 4, cols: 6, preset: "gruppen" }, TODAY);
    expect((await planForLesson(h.db, await p(TOBIAS), lesson, TODAY))?.plan.id).toBe(mathe);
    expect((await planForLesson(h.db, await p(TOBIAS), { ...lesson, subjectId: "D" }, TODAY))?.plan.id).toBe(planId);
    expect((await plansByGroup(h.db, await p(JANA), ["g-7b", "g-9a"], TODAY)).get("g-7b")?.map((x) => x.title)).toEqual(["7b Klassenraum", "Mathe"]);
    expect((await searchPlans(h.db, await p(TOBIAS), "mathe", TODAY)).map((x) => x.id)).toEqual([mathe]);
    await deletePlan(h.db, await p(TOBIAS), mathe, TODAY);
  });

  it("kopieren (mit Plätzen), umbenennen, löschen – protokolliert", async () => {
    const jana = await p(JANA);
    const copy = await copyPlan(h.db, jana, planId, "7b Englisch", TODAY);
    expect((await getPlan(h.db, jana, copy, TODAY))!.seats).toHaveLength((await getPlan(h.db, jana, planId, TODAY))!.seats.length);
    await updatePlanMeta(h.db, jana, copy, { title: "7b Englisch (NW1)", subjectId: "E", roomId: "NW1" }, TODAY);
    expect((await getPlan(h.db, jana, copy, TODAY))!).toMatchObject({ subjectName: "Englisch", roomName: "Biologie-Raum", plan: { title: "7b Englisch (NW1)" } });
    await deletePlan(h.db, jana, copy, TODAY);
    expect(await h.db.select().from(sitzplanSeats).where(eq(sitzplanSeats.planId, copy))).toHaveLength(0);
    const actions = (await h.db.select({ a: auditLog.action }).from(auditLog)).map((r) => r.a).filter((a) => a.startsWith("sitzplan."));
    expect(actions).toEqual(expect.arrayContaining(["sitzplan.anlegen", "sitzplan.kopieren", "sitzplan.loeschen"]));
  });
});
