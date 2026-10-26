import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { timetableLessons, timetableSubstitutions, timetableTeacherSubjects, users } from "@/core/db/schema";
import { setModuleEnabled } from "@/core/modules/registry";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  checkSubjectFit,
  executeTeacherSubjectImport,
  loadPickList,
  offSubjectConfirmed,
  offSubjectKey,
  offSubjectText,
  parseTeacherSubjectCsv,
  pickList,
  planTeacherSubjectImport,
  rankTeachers,
  selectableTeachers,
  setTeacherSubjects,
  subjectFit,
  subjectFilterOn,
  subjectMismatch,
  teacherSubjectMap,
  type PickTeacher,
} from "./lehrfaecher";
import stundenplanManifest from "./manifest";
import { planAssignmentImport } from "./verteilung-import";
import { planningYear } from "./verteilung";
import { suggestSubstitutes } from "./vorschlaege";

const p = (id: string, name: string, subjectIds: string[], rest: number): PickTeacher => ({ id, code: id.toUpperCase(), name, subjectIds, rest });

describe("Lehrervorschläge passend zum Fach (rein)", () => {
  const list = [p("a", "Adler", ["M"], 2), p("b", "Bauer", ["M", "PH"], 6), p("c", "Christ", ["D"], 10), p("d", "Dorn", [], 12), p("e", "Ernst", ["M"], 6)];

  it("nur Lehrkräfte mit dem Fach, nach Restdeputat absteigend, dann Name; Rest getrennt", () => {
    const r = rankTeachers(list, "M");
    expect(r.matching.map((t) => t.id)).toEqual(["b", "e", "a"]);
    expect(r.unmaintained.map((t) => t.id)).toEqual(["d"]);
    expect(r.others.map((t) => t.id)).toEqual(["c"]);
  });

  it("ohne Fach: alle nach Restdeputat", () => {
    expect(rankTeachers(list, null)).toEqual({ matching: ["d", "c", "b", "e", "a"].map((id) => list.find((t) => t.id === id)), unmaintained: [], others: [] });
  });

  it("Passung, Abweichungen und Warnhinweis", () => {
    expect(subjectFit(["M"], "M")).toBe("fits");
    expect(subjectFit(["M"], "PH")).toBe("off");
    expect(subjectFit([], "PH")).toBe("unmaintained");
    expect(subjectFit(undefined, "PH")).toBe("unmaintained");
    const map = new Map([["a", ["M"]], ["c", ["D"]]]);
    expect(subjectMismatch(map, "M", ["a", "c", "x", "c"])).toEqual({ off: ["c"], unmaintained: ["x"] });
    expect(offSubjectText(["LIN"], "Physik")).toBe("LIN unterrichtet Physik laut Stammdaten nicht");
    expect(offSubjectText(["LIN", "KLE"], "Physik")).toBe("LIN, KLE unterrichten Physik laut Stammdaten nicht");
  });

  it("Auswahlliste: Restdeputat = Soll − Lehraufträge", () => {
    expect(pickList([{ id: "a", code: "A", name: "Adler", target: 25.5, assigned: 20 }], new Map([["a", ["M"]]]))).toEqual([{ id: "a", code: "A", name: "Adler", subjectIds: ["M"], rest: 5.5 }]);
  });

  it("R2-P2: nicht aktive Lehrkräfte sind markiert und nur als schon gewählter Wert auswählbar", () => {
    const accounts = [
      { id: "a", code: "A", name: "Adler", target: 25, assigned: 20 },
      { id: "x", code: "X", name: "Xaver", target: 25, assigned: 0 },
    ];
    const list = pickList(accounts, new Map([["a", ["M"]], ["x", ["M"]]]), new Set(["a"]));
    expect(list.map((t) => [t.id, !!t.inactive])).toEqual([
      ["a", false],
      ["x", true],
    ]);
    expect(selectableTeachers(list, "").map((t) => t.id)).toEqual(["a"]);
    expect(selectableTeachers(list, "x").map((t) => t.id)).toEqual(["a", "x"]);
  });

  it("R2-P3: „Trotzdem zuweisen“ gilt nur für das eigene Feld und die dort gewählte Lehrkraft", () => {
    const form = new FormData();
    form.set(offSubjectKey("teacherId"), "u-a");
    expect(offSubjectConfirmed(form, "teacherId", "u-a")).toBe(true);
    expect(offSubjectConfirmed(form, "teacher2Id", "u-b")).toBe(false);
    expect(offSubjectConfirmed(form, "teacherId", "u-b")).toBe(false);
    expect(offSubjectConfirmed(form, "teacherId", null)).toBe(false);
  });

  it("R2-P7: ohne gepflegte Lehrfächer greift kein Fachfilter – alle normal wählbar", () => {
    const none = [p("a", "Adler", [], 2), p("b", "Bauer", [], 6)];
    expect(subjectFilterOn(none)).toBe(false);
    expect(rankTeachers(none, "M")).toEqual({ matching: [none[1], none[0]], unmaintained: [], others: [] });
    expect(subjectFilterOn([...none, p("c", "Christ", ["D"], 1)])).toBe(true);
    // nur nicht aktive mit Lehrfächern zählen nicht
    expect(subjectFilterOn([...none, { ...p("c", "Christ", ["D"], 1), inactive: true }])).toBe(false);
    // ohne Deputat (Stundenplan aus): Name entscheidet
    expect(rankTeachers([{ ...p("b", "Bauer", [], 0), rest: null }, { ...p("a", "Adler", [], 0), rest: null }], "M").matching.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("CSV: Kopfzeile optional, Fächer mit Leerzeichen, „/“, „+“ oder in eigenen Spalten", () => {
    expect(parseTeacherSubjectCsv("Lehrkraft;Lehrfächer\nKLE;M PH\nLIN;GE/D\n\nBRA;D;E\n").rows).toEqual([
      { line: 2, teacher: "KLE", subjects: ["M", "PH"] },
      { line: 3, teacher: "LIN", subjects: ["GE", "D"] },
      { line: 5, teacher: "BRA", subjects: ["D", "E"] },
    ]);
    expect(parseTeacherSubjectCsv("KLE,\"M, PH\"").rows[0]).toEqual({ line: 1, teacher: "KLE", subjects: ["M", "PH"] });
    expect(parseTeacherSubjectCsv("\n").errors).toEqual(["Keine Lehrkräfte in der Datei"]);
  });
});

async function fieldErrors(pr: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await pr;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Lehrfächer (Demo-Schule)", () => {
  let h: DbHandle;
  const MO = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Seed: Lehrfächer aus den Stammdaten, alle Lehrkräfte gepflegt", async () => {
    const map = await teacherSubjectMap(h.db);
    expect(map.get("u-tobias.kleine")).toEqual(expect.arrayContaining(["M", "PH"]));
    expect(map.get("u-petra.lindner")).toEqual(expect.arrayContaining(["GE", "D"]));
    const pick = await loadPickList(h.db, MO);
    expect(pick.length).toBe(28);
    expect(pick.every((t) => t.subjectIds.length > 0)).toBe(true);
  });

  it("pflegen: ersetzen, leeren, nur Lehrkräfte und vorhandene Fächer", async () => {
    await setTeacherSubjects(h.db, "u-admin", "u-sophie.wagner", ["E", "F", "E"]);
    expect((await teacherSubjectMap(h.db)).get("u-sophie.wagner")).toEqual(expect.arrayContaining(["E", "F"]));
    await setTeacherSubjects(h.db, "u-admin", "u-sophie.wagner", []);
    expect((await teacherSubjectMap(h.db)).has("u-sophie.wagner")).toBe(false);
    expect(await fieldErrors(setTeacherSubjects(h.db, "u-admin", "u-lea.schaefer", ["M"]))).toHaveProperty("teacherId");
    expect(await fieldErrors(setTeacherSubjects(h.db, "u-admin", "u-sophie.wagner", ["XX"]))).toHaveProperty("subjectIds");
    await setTeacherSubjects(h.db, "u-admin", "u-sophie.wagner", ["E", "F"]);
  });

  it("Zuweisung: fachfremd nur mit Bestätigung, ohne gepflegte Lehrfächer ohne Sperre", async () => {
    // LIN (Geschichte/Deutsch) soll Physik geben
    const fe = await fieldErrors(checkSubjectFit(h.db, "PH", ["u-petra.lindner"], false));
    expect(fe.teacherIds).toBe("LIN unterrichtet Physik laut Stammdaten nicht – zum Speichern „Trotzdem zuweisen“ ankreuzen");
    expect(await checkSubjectFit(h.db, "PH", ["u-petra.lindner"], true)).toEqual(["LIN"]);
    expect(await checkSubjectFit(h.db, "PH", ["u-tobias.kleine"], false)).toEqual([]);
    expect(await fieldErrors(checkSubjectFit(h.db, "PH", ["u-tobias.kleine", "u-petra.lindner"], false, "p1-teacherId"))).toHaveProperty("p1-teacherId");
    await setTeacherSubjects(h.db, "u-admin", "u-sophie.wagner", []);
    expect(await checkSubjectFit(h.db, "PH", ["u-sophie.wagner"], false)).toEqual([]);
    expect(await checkSubjectFit(h.db, "", ["u-petra.lindner"], false)).toEqual([]);
    await setTeacherSubjects(h.db, "u-admin", "u-sophie.wagner", ["E", "F"]);
  });

  it("R2-P2: nicht aktive Lehrkraft – in der Auswahlliste markiert, beim Speichern abgelehnt", async () => {
    await h.db.update(users).set({ status: "locked" }).where(eq(users.id, "u-sophie.wagner"));
    try {
      const pick = await loadPickList(h.db, MO);
      expect(pick.find((t) => t.id === "u-sophie.wagner")?.inactive).toBe(true);
      expect(pick.filter((t) => !t.inactive)).toHaveLength(27);
      const fe = await fieldErrors(checkSubjectFit(h.db, "E", ["u-sophie.wagner"], true, "teacher2Id"));
      expect(fe.teacher2Id).toMatch(/nicht mehr aktiv/);
    } finally {
      await h.db.update(users).set({ status: "active" }).where(eq(users.id, "u-sophie.wagner"));
    }
  });

  it("R2-P7: Stundenplanmodul aus → kein Fachfilter (keine Lehrfächer, kein Deputat in der Liste, keine Bestätigung nötig)", async () => {
    await setModuleEnabled(h.db, stundenplanManifest, false);
    try {
      const pick = await loadPickList(h.db, MO);
      expect(pick).toHaveLength(28);
      expect(pick.every((t) => t.subjectIds.length === 0 && t.rest === null)).toBe(true);
      expect(subjectFilterOn(pick)).toBe(false);
      expect(await checkSubjectFit(h.db, "PH", ["u-petra.lindner"], false)).toEqual([]);
    } finally {
      await setModuleEnabled(h.db, stundenplanManifest, true);
    }
    expect(await fieldErrors(checkSubjectFit(h.db, "PH", ["u-petra.lindner"], false))).toHaveProperty("teacherIds");
  });

  it("CSV-Import der Unterrichtsverteilung warnt bei fachfremder Lehrkraft, sperrt aber nicht", async () => {
    const year = (await planningYear(h.db))!;
    const plan = await planAssignmentImport(h.db, year, "Klasse/Kurs;Fach;Stunden;Lehrkraft\n7b;PH;2;LIN\n7b;PH;2;KLE\n");
    expect(plan.preview.rows[0]!.warnings).toEqual(["LIN unterrichtet Physik laut Stammdaten nicht"]);
    expect(plan.preview.rows[0]!.status).not.toBe("fehler");
    expect(plan.preview.rows[1]!.warnings).toEqual([]);
  });

  it("CSV-Import der Lehrfächer: Vorschau mit Fehlern, ganz oder gar nicht", async () => {
    const bad = await planTeacherSubjectImport(h.db, "KLE;M PH CH\nNIEMAND;M\nLIN;XY\n");
    expect(bad.preview.counts).toEqual({ aendern: 1, gleich: 0, fehler: 2 });
    expect(bad.preview.ok).toBe(false);
    expect(bad.preview.rows[1]!.notes).toEqual(["Lehrkraft „NIEMAND“ gibt es nicht"]);
    expect(bad.preview.rows[2]!.notes).toEqual(["Fach „XY“ gibt es nicht"]);
    await expect(executeTeacherSubjectImport(h.db, "u-admin", bad)).rejects.toThrow();
    const before = (await teacherSubjectMap(h.db)).get("u-tobias.kleine");
    const good = await planTeacherSubjectImport(h.db, `Lehrkraft;Lehrfächer\nKLE;${[...before!, "CH"].join(" ")}\nLIN;GE/D\nKLE;M\n`);
    expect(good.preview.rows.map((r) => r.status)).toEqual(["aendern", expect.any(String), "fehler"]);
    expect(good.preview.rows[2]!.notes).toEqual(["steht schon in Zeile 2"]);
    const ok = await planTeacherSubjectImport(h.db, `KLE;${[...before!, "CH"].join(" ")}\n`);
    expect(ok.preview.rows[0]!.notes).toEqual(["neu: CH"]);
    expect(await executeTeacherSubjectImport(h.db, "u-admin", ok)).toBe(1);
    expect((await teacherSubjectMap(h.db)).get("u-tobias.kleine")).toContain("CH");
    const same = await planTeacherSubjectImport(h.db, `KLE;${[...before!, "CH"].join(" ")}\n`);
    expect(same.preview).toMatchObject({ ok: false, counts: { gleich: 1 } });
  });

  it("Vertretungsvorschläge: Lehrfach aus den Stammdaten zählt als „unterrichtet das Fach“", async () => {
    await h.db.delete(timetableSubstitutions);
    const all = (await h.db.select().from(timetableLessons)).filter((l) => l.weekday === 0 && l.teacherId);
    let found = false;
    for (const target of all) {
      const before = await suggestSubstitutes(h.db, target.id, MO);
      const c = before.find((x) => !x.reasons.some((r) => r.label === "unterrichtet das Fach"));
      if (!c) continue;
      const own = (await teacherSubjectMap(h.db)).get(c.id) ?? [];
      await h.db.delete(timetableTeacherSubjects).where(eq(timetableTeacherSubjects.teacherId, c.id));
      await setTeacherSubjects(h.db, "u-admin", c.id, [...own, target.subjectId]);
      const after = await suggestSubstitutes(h.db, target.id, MO);
      expect(after.find((x) => x.id === c.id)!.reasons.map((r) => r.label)).toContain("unterrichtet das Fach");
      await setTeacherSubjects(h.db, "u-admin", c.id, own);
      found = true;
      break;
    }
    expect(found).toBe(true);
  });
});
