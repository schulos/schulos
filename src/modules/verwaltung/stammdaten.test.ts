import { ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { groups, periods, subjects, timetableLessons, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { SCHOOL_FORMS } from "@/core/school/catalog";
import { TIME_GRIDS, defaultTimeGrid, maxWeeklyHours, stundentafelTemplate } from "@/core/school/templates";
import { createGroup, listGroups, updateGroup } from "./groups";
import { saveSchoolSettings } from "./school";
import {
  addPeriod,
  applyCurriculumTemplate,
  applyGradeTemplate,
  applyTimeGrid,
  breaks,
  checkPeriods,
  deleteSubject,
  ensureGradeLevels,
  gradeLabel,
  groupFormOptions,
  leaderLabel,
  listCurriculum,
  listGradeLevels,
  listPeriods,
  listSubjects,
  moveSubject,
  removeLastPeriod,
  saveCurriculum,
  saveGradeLevels,
  savePeriods,
  saveSubjects,
  subjectUsage,
} from "./stammdaten";
import { ValidationError } from "./users";

const codes = async (h: DbHandle) => (await listGradeLevels(h.db)).map((g) => g.code);

describe("Stammdaten · Jahrgänge", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", email: "admin@test", role: "admin" });
  });
  afterAll(() => h.close());

  it("legt die Jahrgänge aus dem Schulprofil einmalig an", async () => {
    await ensureGradeLevels(h.db);
    expect(await codes(h)).toEqual(["5", "6", "7", "8", "9", "10", "EF", "Q1", "Q2"]);
    const q1 = (await listGradeLevels(h.db)).find((g) => g.code === "Q1")!;
    expect(q1).toMatchObject({ level: 12, name: "Qualifikationsphase 1", stage: "oberstufe" });
    // zweiter Aufruf überschreibt nichts
    await saveGradeLevels(h.db, "u-admin", (await listGradeLevels(h.db)).map((g) => ({ ...g, name: g.level === 5 ? "Fünfer" : g.name })));
    await ensureGradeLevels(h.db);
    expect((await listGradeLevels(h.db))[0]!.name).toBe("Fünfer");
  });

  it("speichert Kürzel auch beim Tausch und validiert", async () => {
    const rows = await listGradeLevels(h.db);
    await saveGradeLevels(h.db, "u-admin", rows.map((g) => ({ ...g, code: g.code === "5" ? "6" : g.code === "6" ? "5" : g.code })));
    expect((await codes(h)).slice(0, 2)).toEqual(["6", "5"]);
    try {
      await saveGradeLevels(h.db, "u-admin", rows.map((g) => ({ ...g, code: g.level === 7 ? "EF" : g.level === 8 ? " " : g.code, name: g.level === 9 ? "" : g.name })));
      throw new Error("erwartet ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual(["code-11", "code-8", "name-9"]);
    }
    expect((await codes(h)).slice(0, 2)).toEqual(["6", "5"]); // nichts halb gespeichert
    await saveGradeLevels(h.db, "u-admin", rows); // zurück
  });

  it("Gruppen: Jahrgang muss existieren, Niveau aus dem Katalog; Liste zeigt das Kürzel", async () => {
    const id = await createGroup(h.db, "u-admin", { name: "Mathe Q1 LK", kind: "kurs", gradeLevel: 12, level: "LK" });
    await expect(createGroup(h.db, "u-admin", { name: "Falsch", kind: "kurs", gradeLevel: 4, level: "XL" })).rejects.toMatchObject({
      fieldErrors: { gradeLevel: "Unbekannter Jahrgang", level: "Unbekanntes Niveau" },
    });
    const levels = await listGradeLevels(h.db);
    const row = (await listGroups(h.db)).find((g) => g.id === id)!;
    expect(row).toMatchObject({ gradeLevel: 12, level: "LK" });
    expect(gradeLabel(levels, row.gradeLevel)).toBe("Q1");
    expect(gradeLabel(levels, null)).toBeNull();
    expect(gradeLabel(levels, 99)).toBe("99");
    expect(await groupFormOptions(h.db)).toMatchObject({ levels: ["E", "G", "GK", "LK"] });
  });

  it("Vorlage übernehmen: entfernt ungenutzte Jahrgänge, behält benutzte", async () => {
    await saveSchoolSettings(h.db, "u-admin", { name: "Realschule Nord", number: "", color: "#0e7c66", state: "NI", form: "realschule", oberstufe: false, abitur: "g9" });
    const { kept } = await applyGradeTemplate(h.db, "u-admin");
    expect(kept).toEqual([12]); // Q1 hängt noch am Kurs
    expect(await codes(h)).toEqual(["5", "6", "7", "8", "9", "10", "Q1"]);
    expect((await listGradeLevels(h.db))[0]!.name).toBe("Jahrgang 5"); // Name aus der Vorlage
    expect((await groupFormOptions(h.db)).levels).toEqual([]);

    // Kurs umhängen → beim nächsten Übernehmen verschwindet Q1
    const kurs = (await listGroups(h.db)).find((g) => g.name === "Mathe Q1 LK")!;
    await updateGroup(h.db, "u-admin", kurs.id, { name: "Mathe 10", kind: "kurs", gradeLevel: 10, level: null });
    expect((await applyGradeTemplate(h.db, "u-admin")).kept).toEqual([]);
    expect(await codes(h)).toEqual(["5", "6", "7", "8", "9", "10"]);
  });

  it("Berliner Gymnasium (G8) beginnt mit Jahrgang 7, Oberstufe ohne NRW-Kürzel", async () => {
    await saveSchoolSettings(h.db, "u-admin", { name: "Gymnasium Mitte", number: "", color: "#0e7c66", state: "BE", form: "gymnasium", oberstufe: true, abitur: "g8" });
    await applyGradeTemplate(h.db, "u-admin");
    expect(await codes(h)).toEqual(["7", "8", "9", "10", "11", "12"]);
    expect((await listGradeLevels(h.db)).at(-1)).toMatchObject({ level: 12, stage: "oberstufe" });
  });

});

describe("Stammdaten · Fächer und Zeitraster", () => {
  let h: DbHandle;
  let groupId: string;
  const subj = (id: string, name: string, color = "#336699", roomKind = "") => ({ id, code: id, name, color, roomKind });
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", email: "admin@test", role: "admin" });
    await h.db.insert(subjects).values([
      { id: "M", name: "Mathematik", color: "#1971C2", sortOrder: 0 },
      { id: "MA", name: "Mathe alt", color: "#000000", sortOrder: 1 },
      { id: "SP", name: "Sport", color: "#E8590C", sortOrder: 2, roomKind: "sport" },
    ]);
    await h.db.insert(periods).values([
      { nr: 1, startsAt: "08:00", endsAt: "08:45" },
      { nr: 2, startsAt: "08:50", endsAt: "09:35" },
    ]);
    groupId = await createGroup(h.db, "u-admin", { name: "Klasse 7b", kind: "klasse", subjectId: "M" });
    await h.db.insert(timetableLessons).values({ groupId, weekday: 0, periodNr: 2, subjectId: "M", validFrom: "2026-08-01" });
  });
  afterAll(() => h.close());

  it("Kürzel tauschen zieht Stundenplan und Gruppe mit, neues Fach kommt ans Ende", async () => {
    const rows = (await listSubjects(h.db)).map((s) => ({ id: s.id, code: s.id, name: s.name, color: s.color, roomKind: s.roomKind ?? "" }));
    rows[0]!.code = "MA";
    rows[1]!.code = "M";
    await saveSubjects(h.db, "u-admin", rows, subj("CH", "Chemie", "#0c8599", "nw"));
    const list = await listSubjects(h.db);
    expect(list.map((s) => [s.id, s.name, s.sortOrder])).toEqual([
      ["MA", "Mathematik", 0],
      ["M", "Mathe alt", 1],
      ["SP", "Sport", 2],
      ["CH", "Chemie", 3],
    ]);
    expect(list.at(-1)).toMatchObject({ color: "#0C8599", roomKind: "nw" });
    const [lesson] = await h.db.select().from(timetableLessons);
    expect(lesson!.subjectId).toBe("MA");
    expect((await listGroups(h.db)).length).toBe(2); // + Funktionsgruppe Stundenplanung (Migration 0088)
    const [g] = await h.db.select({ subjectId: groups.subjectId }).from(groups).where(ne(groups.slug, "stundenplanung"));
    expect(g!.subjectId).toBe("MA");
  });

  it("validiert Kürzel, Farbe, Raumart und Dubletten – ohne halb zu speichern", async () => {
    const rows = (await listSubjects(h.db)).map((s) => ({ id: s.id, code: s.id, name: s.name, color: s.color, roomKind: s.roomKind ?? "" }));
    const bad = rows.map((r) => (r.id === "SP" ? { ...r, code: "S P", color: "orange", roomKind: "weltraum" } : r));
    await expect(saveSubjects(h.db, "u-admin", bad, subj("ma", "Doppelt"))).rejects.toMatchObject({
      fieldErrors: { "code-SP": expect.any(String), "color-SP": "Farbe als #RRGGBB", "roomKind-SP": "Unbekannte Raumart", "code-new": "Kürzel doppelt" },
    });
    expect((await listSubjects(h.db)).map((s) => s.id)).toEqual(["MA", "M", "SP", "CH"]);
  });

  it("Reihenfolge verschieben, Löschen nur wenn unbenutzt", async () => {
    await moveSubject(h.db, "u-admin", "CH", -1);
    await moveSubject(h.db, "u-admin", "MA", -1); // schon oben → nichts
    expect((await listSubjects(h.db)).map((s) => s.id)).toEqual(["MA", "M", "CH", "SP"]);
    expect((await subjectUsage(h.db)).get("MA")).toBe(1);
    await expect(deleteSubject(h.db, "u-admin", "MA")).rejects.toBeInstanceOf(ValidationError);
    await deleteSubject(h.db, "u-admin", "M");
    expect((await listSubjects(h.db)).map((s) => s.id)).toEqual(["MA", "CH", "SP"]);
  });

  it("Zeitraster: Prüfung, Pausen, Stunde anhängen und entfernen", async () => {
    expect(checkPeriods([{ nr: 1, startsAt: "8:00", endsAt: "08:45" }, { nr: 2, startsAt: "08:40", endsAt: "09:25" }, { nr: 3, startsAt: "10:00", endsAt: "09:30" }])).toEqual({
      "start-1": "Uhrzeit als HH:MM",
      "end-3": "Ende muss nach dem Beginn liegen",
    });
    expect(checkPeriods([{ nr: 1, startsAt: "08:00", endsAt: "08:45" }, { nr: 2, startsAt: "08:40", endsAt: "09:25" }])).toEqual({ "start-2": "Beginnt vor dem Ende der 1. Stunde" });

    await savePeriods(h.db, "u-admin", [
      { nr: 1, startsAt: "07:55", endsAt: "08:40" },
      { nr: 2, startsAt: "09:00", endsAt: "09:45" },
    ]);
    const list = await listPeriods(h.db);
    expect([...breaks(list)]).toEqual([[2, 20]]);
    await expect(savePeriods(h.db, "u-admin", [{ nr: 1, startsAt: "09:00", endsAt: "08:00" }])).rejects.toBeInstanceOf(ValidationError);

    expect(await addPeriod(h.db, "u-admin")).toBe(3);
    expect((await listPeriods(h.db)).at(-1)).toEqual({ nr: 3, startsAt: "09:50", endsAt: "10:35" });
    await removeLastPeriod(h.db, "u-admin");
    expect((await listPeriods(h.db)).length).toBe(2);
    // die 2. Stunde ist verplant
    await expect(removeLastPeriod(h.db, "u-admin")).rejects.toMatchObject({ fieldErrors: { "start-2": expect.stringContaining("1× verplant") } });
  });
});

describe("Stammdaten · Leitungsbezeichnung", () => {
  it("je Art und Stufe", () => {
    expect(leaderLabel("kurs", "oberstufe")).toBe("Kursleitung");
    expect(leaderLabel("klasse", "sek1")).toBe("Klassenleitung");
    expect(leaderLabel("klasse", "oberstufe")).toBe("Stufenleitung");
    expect(leaderLabel("klasse", null)).toBe("Klassenleitung");
    expect(leaderLabel("wahlpflicht", "sek1")).toBe("Kursleitung");
    expect(leaderLabel("ag", null)).toBe("AG-Leitung");
    expect(leaderLabel("frei", null)).toBe("Leitung");
  });
});

describe("Stammdaten · Vorlagen (Stundentafel, Zeitraster)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", email: "admin@test", role: "admin" });
  });
  afterAll(() => h.close());

  it("Stundentafel-Vorlagen je Schulform", () => {
    const gs = stundentafelTemplate("gesamtschule", [5, 6, 7, 8, 9, 10]);
    const hs = stundentafelTemplate("hauptschule", [5, 6, 7, 8, 9, 10]);
    expect(Object.keys(gs)).toEqual(["5", "6", "7", "8", "9", "10"]);
    expect(hs[7]!.F).toBeUndefined();
    expect([hs[7]!.D, hs[7]!.M]).toEqual([gs[7]!.D! + 1, gs[7]!.M! + 1]);
    expect(hs[5]).toEqual(gs[5]); // ohne Französisch in Jg. 5 keine Änderung
    expect(Object.keys(stundentafelTemplate("gymnasium", [7, 8, 9, 10, 11, 12]))).toEqual(["7", "8", "9", "10"]);
    expect(defaultTimeGrid({ form: "gesamtschule" }).periods).toHaveLength(8);
    expect(defaultTimeGrid({ form: "realschule" }).id).toBe("halbtag-45");
    // Gymnasium G9: 31 Wochenstunden in Klasse 8 passen nicht in 30 Vormittagsstunden
    expect(defaultTimeGrid({ form: "gymnasium" }).id).toBe("ganztag-45");
    // jede Schulform: die Stundentafel passt in das vorgeschlagene Raster
    for (const form of SCHOOL_FORMS) expect(maxWeeklyHours(form)).toBeLessThanOrEqual(5 * defaultTimeGrid({ form }).periods.length);
    // alle Zeitraster-Vorlagen sind in sich gültig
    for (const g of TIME_GRIDS) expect(checkPeriods(g.periods)).toEqual({});
  });

  it("Vorlage übernehmen legt fehlende Fächer an und füllt die Sek-I-Jahrgänge", async () => {
    await ensureGradeLevels(h.db); // Vorgabe: NRW-Gesamtschule mit Oberstufe
    await h.db.insert(subjects).values({ id: "D", name: "Deutsch (eigene)", color: "#000000", sortOrder: 0 });
    const { addedSubjects } = await applyCurriculumTemplate(h.db, "u-admin");
    expect(addedSubjects).not.toContain("D");
    expect(addedSubjects).toContain("F");
    const subs = await listSubjects(h.db);
    expect(subs[0]).toMatchObject({ id: "D", name: "Deutsch (eigene)" }); // bestehendes Fach bleibt
    expect(subs.find((x) => x.id === "SP")).toMatchObject({ roomKind: "sport" });
    const cur = await listCurriculum(h.db);
    expect(new Set(cur.map((c) => c.gradeLevel))).toEqual(new Set([5, 6, 7, 8, 9, 10])); // keine Oberstufe
    expect(cur.find((c) => c.gradeLevel === 7 && c.subjectId === "F")!.hours).toBe(3);
    expect((await applyCurriculumTemplate(h.db, "u-admin")).addedSubjects).toEqual([]);
    expect(await listCurriculum(h.db)).toHaveLength(cur.length);
  });

  it("Matrix speichern: 0 oder leer löscht, Unsinn wird abgelehnt", async () => {
    await saveCurriculum(h.db, "u-admin", [
      { gradeLevel: 5, subjectId: "D", hours: "5" },
      { gradeLevel: 5, subjectId: "M", hours: "0" },
      { gradeLevel: 5, subjectId: "E", hours: "" },
      { gradeLevel: 5, subjectId: "SP", hours: "3" },
    ]);
    expect((await listCurriculum(h.db)).filter((c) => c.gradeLevel === 5).map((c) => [c.subjectId, c.hours]).sort()).toEqual([
      ["D", 5],
      ["SP", 3],
    ]);
    expect((await listCurriculum(h.db)).some((c) => c.gradeLevel === 6)).toBe(true); // andere Jahrgänge unberührt
    await expect(saveCurriculum(h.db, "u-admin", [{ gradeLevel: 5, subjectId: "D", hours: "2,5" }, { gradeLevel: 5, subjectId: "M", hours: "13" }])).rejects.toMatchObject({
      fieldErrors: { "h-5-D": "0–12 Stunden", "h-5-M": "0–12 Stunden" },
    });
  });

  it("Zeitraster-Vorlage: setzt Zeiten, kürzt nur unverplante Stunden", async () => {
    await applyTimeGrid(h.db, "u-admin", "ganztag-45");
    expect(await listPeriods(h.db)).toHaveLength(8);
    const groupId = await createGroup(h.db, "u-admin", { name: "Klasse 5a", kind: "klasse" });
    await h.db.insert(timetableLessons).values({ groupId, weekday: 0, periodNr: 7, subjectId: "D", validFrom: "2026-08-01" });
    await expect(applyTimeGrid(h.db, "u-admin", "60")).rejects.toMatchObject({ fieldErrors: { grid: expect.stringContaining("7. Stunde ist noch 1× verplant") } });
    expect(await listPeriods(h.db)).toHaveLength(8); // nichts halb geändert
    await h.db.delete(timetableLessons);
    await applyTimeGrid(h.db, "u-admin", "60");
    expect(await listPeriods(h.db)).toEqual(TIME_GRIDS.find((g) => g.id === "60")!.periods);
    await expect(applyTimeGrid(h.db, "u-admin", "gibtsnicht")).rejects.toBeInstanceOf(ValidationError);
  });
});
