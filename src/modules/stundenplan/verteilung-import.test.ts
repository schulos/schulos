// SP2-06: CSV-Import der Unterrichtsverteilung – Vorschau mit Fehlern je Zeile, ganz oder gar nicht, Bänder bleiben erhalten.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { createTestDb } from "@/core/db/testing";
import { csvBytes, decodeCsvBytes, toCsv } from "@/core/csv";
import { auditLog, groups, rooms, schoolYears, subjects, timetableAssignments, timetableBands, users } from "@/core/db/schema";
import { buildExport } from "./exporte";
import { createAssignment, createBand, listAssignments, listBands } from "./verteilung";
import { assignmentCsvTemplate, executeAssignmentImport, parseAssignmentCsv, planAssignmentImport } from "./verteilung-import";

describe("parseAssignmentCsv", () => {
  it("Kopfzeile in beliebiger Reihenfolge, Komma oder Semikolon, Teamteaching mit „/“", () => {
    const r = parseAssignmentCsv("Fach,Klasse,Stunden,Lehrkraft\nM,7a,4,ABC/DEF\n\n");
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ line: 2, group: "7a", subject: "M", hours: "4", teachers: ["ABC", "DEF"], doubles: "", room: "", band: "", validFrom: "", validUntil: "" }]);
  });

  it("ohne Kopfzeile gilt die Reihenfolge der Vorlage", () => {
    const r = parseAssignmentCsv("7a;D;4;ABC;1;R101;Band X");
    expect(r.rows[0]).toMatchObject({ line: 1, group: "7a", subject: "D", hours: "4", doubles: "1", room: "R101", band: "Band X" });
  });

  it("Kopfzeile ohne Pflichtspalte bzw. leere Datei → Fehler", () => {
    expect(parseAssignmentCsv("Klasse;Fach;Lehrkraft\n7a;D;ABC").errors[0]).toContain("„Stunden“ fehlt");
    expect(parseAssignmentCsv("\n\n").errors).toEqual(["Keine Lehraufträge in der Datei"]);
  });
});

describe("CSV-Import der Unterrichtsverteilung", () => {
  let h: DbHandle;
  const year = { id: "sj", startsOn: "2026-08-01", endsOn: "2027-07-31" };

  beforeAll(async () => {
    h = await createTestDb();
    const db = h.db;
    await db.insert(schoolYears).values([
      { ...year, name: "2026/27", isCurrent: true },
      { id: "alt", name: "2025/26", startsOn: "2025-08-01", endsOn: "2026-07-31" },
    ]);
    await db.insert(subjects).values([
      { id: "D", name: "Deutsch", color: "#1C7ED6" },
      { id: "M", name: "Mathematik", color: "#D9480F" },
      { id: "KR", name: "Katholische Religion", color: "#868E96" },
      { id: "PL", name: "Philosophie", color: "#868E96" },
    ]);
    await db.insert(groups).values([
      { id: "g-7a", name: "7a", slug: "7a", kind: "klasse", gradeLevel: 7, schoolYearId: "sj" },
      { id: "g-7b", name: "7b", slug: "7b", kind: "klasse", gradeLevel: 7, schoolYearId: "sj" },
      { id: "g-7a-alt", name: "7a", slug: "7a-alt", kind: "klasse", gradeLevel: 7, schoolYearId: "alt" },
      { id: "g-ag", name: "Theater", slug: "theater", kind: "fachschaft" },
    ]);
    await db.insert(users).values([
      { id: "t1", name: "Anna Bauer", email: "t1@x", role: "lehrkraft", shortCode: "BAU" },
      { id: "t2", name: "Carl Diehl", email: "t2@x", role: "lehrkraft", shortCode: "DIE" },
      { id: "t3", name: "Eva Förster", email: "t3@x", role: "lehrkraft", shortCode: "FRA" },
      { id: "s1", name: "Lea Schüler", email: "s1@x", role: "schueler" },
    ]);
    await db.insert(rooms).values([
      { id: "R101", name: "Raum 101" },
      { id: "ALT", name: "Altbau", active: false },
    ]);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.db.delete(timetableAssignments);
    await h.db.delete(timetableBands);
  });

  const plan = (text: string) => planAssignmentImport(h.db, year, text);

  it("legt neue Lehraufträge an – Zuordnung über Kürzel oder Namen, Archiv-Gruppe anderer Jahre zählt nicht", async () => {
    const p = await plan("Klasse/Kurs;Fach;Stunden;Lehrkraft;Doppelstunden;Raumwunsch\n7a;d;4;bau;1;raum 101\n7B;Mathematik;4;Carl Diehl/FRA;;\n7a;M;3;;;");
    expect(p.preview.fileErrors).toEqual([]);
    expect(p.preview.rows.map((r) => r.status)).toEqual(["neu", "neu", "neu"]);
    expect(p.preview.ok).toBe(true);
    const out = await executeAssignmentImport(h.db, "t1", year, p);
    expect(out).toEqual({ created: 3, updated: 0, bands: 0 });
    const list = await listAssignments(h.db, year.id);
    const d = list.find((a) => a.subjectId === "D")!;
    expect(d).toMatchObject({ hours: 4, doubleLessons: 1, roomId: "R101", groups: [{ id: "g-7a", name: "7a" }] });
    expect(d.teachers.map((t) => t.code)).toEqual(["BAU"]);
    expect(list.find((a) => a.groups[0]!.id === "g-7b")!.teachers.map((t) => t.code)).toEqual(["DIE", "FRA"]);
    expect(list.find((a) => a.subjectId === "M" && a.groups[0]!.id === "g-7a")!.teachers).toEqual([]);
    const log = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.assignment.csv_import"));
    expect(log).toHaveLength(1);
  });

  it("Fehler je Zeile: unbekannt, falsche Rolle, inaktiver Raum, Stunden, Doppelstunden, drei Lehrkräfte, doppelt – dann nichts übernehmen", async () => {
    const p = await plan(
      [
        "Klasse;Fach;Stunden;Lehrkraft;Doppelstunden;Raum",
        "7z;D;4;BAU",
        "7a;XY;4;BAU",
        "7a;D;4;Lea Schüler",
        "7a;D;4;BAU;;ALT",
        "7a;D;13;BAU",
        "7a;D;4;BAU;3",
        "7a;D;4;BAU/DIE/FRA",
        "Theater;D;2;BAU",
        "7a;M;4;BAU",
        "7a;M;2;BAU",
        "7b;D;x;BAU",
      ].join("\n"),
    );
    const notes = p.preview.rows.map((r) => [r.status, r.notes.join(" | ")]);
    expect(notes).toEqual([
      ["fehler", "Klasse/Kurs „7z“ gibt es nicht"],
      ["fehler", "Fach „XY“ gibt es nicht"],
      ["fehler", "Lehrkraft „Lea Schüler“ gibt es nicht"],
      ["fehler", "Raum „ALT“ gibt es nicht"],
      ["fehler", "Stunden: 1 bis 12 Wochenstunden"],
      ["fehler", "Doppelstunden: höchstens 2"],
      ["fehler", "höchstens zwei Lehrkräfte (Teamteaching) – weitere Gruppen über ein Band"],
      ["fehler", "Klasse/Kurs „Theater“ gibt es nicht"],
      ["neu", ""],
      ["fehler", "steht schon in Zeile 10"],
      ["fehler", "Stunden: 1 bis 12 Wochenstunden"],
    ]);
    expect(p.preview.ok).toBe(false);
    await expect(executeAssignmentImport(h.db, "t1", year, p)).rejects.toThrow(/nichts übernommen/);
    expect(await listAssignments(h.db, year.id)).toEqual([]);
  });

  it("vorhandene Lehraufträge: ändern bzw. unverändert; leere Spalten lassen Doppelstunden/Raum stehen", async () => {
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7a", subjectId: "D", hours: 4, teacherIds: ["t1"], doubleLessons: 1, roomId: "R101", note: null });
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7b", subjectId: "D", hours: 4, teacherIds: ["t2"], doubleLessons: 2, roomId: null, note: null });
    const p = await plan("7a;D;4;BAU\n7b;D;3;DIE/FRA");
    expect(p.preview.rows.map((r) => [r.status, r.notes])).toEqual([
      ["gleich", []],
      ["aendern", ["Stunden 4 → 3", "Lehrkräfte DIE → DIE/FRA"]],
    ]);
    expect(await executeAssignmentImport(h.db, "t1", year, p)).toEqual({ created: 0, updated: 1, bands: 0 });
    const b = (await listAssignments(h.db, year.id)).find((a) => a.groups[0]!.id === "g-7b")!;
    // Doppelstunden gekappt (2 bei 3 Stunden geht nicht)
    expect(b).toMatchObject({ hours: 3, doubleLessons: 1 });
    expect(b.teachers.map((t) => t.code)).toEqual(["DIE", "FRA"]);
    // nur Unverändertes → nichts zu übernehmen
    expect((await plan("7a;D;4;BAU")).preview.ok).toBe(false);
  });

  it("Bänder: neues Band anlegen, vorhandenem beitreten (Stunden müssen passen), bisheriges Band bleibt", async () => {
    const reli = await createBand(h.db, "t1", { schoolYearId: year.id, name: "Reli 7", hours: 2, doubleLessons: 0 });
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7a", subjectId: "KR", hours: 2, teacherIds: ["t1"], doubleLessons: 0, roomId: null, note: null, bandId: reli });
    const bad = await plan(
      ["Klasse;Fach;Stunden;Lehrkraft;Doppelstunden;Raum;Band", "7a;KR;3;BAU", "7b;PL;3;DIE;;;reli 7", "7a;M;4;FRA;;;Mathe 7", "7b;M;3;FRA;;;Mathe 7", "7a;KR;2;BAU;;;Mathe 7"].join("\n"),
    );
    expect(bad.preview.rows.map((r) => r.notes.join(" | "))).toEqual([
      "Band „Reli 7“ hat 2 Wochenstunden – Stunden am Band ändern",
      "Band „Reli 7“ hat 2 Wochenstunden – Stunden am Band ändern",
      "neues Band „Mathe 7“",
      "neues Band „Mathe 7“ hat in Zeile 4 4 Wochenstunden",
      "steht schon in Zeile 2",
    ]);

    expect((await plan("7a;KR;2;BAU;;;Mathe 7")).preview.rows[0]!.notes).toEqual(["steht im Band „Reli 7“ – dort herausnehmen oder dieses Band angeben"]);

    const p = await plan(["Klasse;Fach;Stunden;Lehrkraft;Band", "7a;KR;2;BAU", "7b;PL;2;DIE;Reli 7", "7a;M;4;FRA;Mathe 7", "7b;M;4;FRA;Mathe 7"].join("\n"));
    expect(p.preview.rows.map((r) => r.status)).toEqual(["gleich", "neu", "neu", "neu"]);
    expect(p.preview.newBands).toEqual(["Mathe 7"]);
    expect(await executeAssignmentImport(h.db, "t1", year, p)).toEqual({ created: 3, updated: 0, bands: 1 });
    const bands = await listBands(h.db, year.id);
    expect(bands.map((b) => [b.name, b.hours, b.memberIds.length]).sort()).toEqual([
      ["Mathe 7", 4, 2],
      ["Reli 7", 2, 2],
    ]);
  });

  it("Q-SP2-13: „gültig ab/bis“ (ISO oder TT.MM.JJJJ) legt befristete Lehraufträge an; ohne die Spalten bleibt es ganzjährig", async () => {
    const p = await plan(
      [
        "Klasse;Fach;Stunden;Lehrkraft;gültig ab;gültig bis",
        "7a;D;4;BAU;;2027-01-31",
        "7a;D;4;BAU;01.02.2027;",
        "7b;M;3;DIE;;",
      ].join("\n"),
    );
    expect(p.preview.rows.map((r) => [r.status, r.validFrom, r.validUntil])).toEqual([
      ["neu", "", "2027-01-31"],
      ["neu", "01.02.2027", ""],
      ["neu", "", ""],
    ]);
    expect(await executeAssignmentImport(h.db, "t1", year, p)).toEqual({ created: 3, updated: 0, bands: 0 });
    const list = await listAssignments(h.db, year.id);
    const d = list.filter((a) => a.subjectId === "D").map((a) => [a.validFrom, a.validUntil]);
    expect(d.sort()).toEqual([
      [null, "2027-01-31"],
      ["2027-02-01", null],
    ]);
    expect(list.find((a) => a.subjectId === "M")).toMatchObject({ validFrom: null, validUntil: null });
  });

  it("Q-SP2-13: Datumsfehler je Zeile – kein Datum, außerhalb des Schuljahrs, bis vor ab; Überschneidungen", async () => {
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7a", subjectId: "D", hours: 4, teacherIds: ["t1"], doubleLessons: 0, roomId: null, note: null, validUntil: "2027-01-31" });
    const p = await plan(
      [
        "Klasse;Fach;Stunden;Lehrkraft;gültig ab;gültig bis",
        "7b;D;4;BAU;31.02.2027;",
        "7b;D;4;BAU;;morgen",
        "7b;D;4;BAU;2026-07-31;",
        "7b;D;4;BAU;2027-03-01;2027-02-01",
        "7a;D;4;BAU;2027-01-15;",
        "7a;D;4;BAU;2027-02-01;",
        "7a;D;4;BAU;2027-03-01;",
        "7b;M;2;DIE;2026-09-01;2027-01-31",
        "7b;M;2;DIE;2027-01-15;2027-07-31",
      ].join("\n"),
    );
    expect(p.preview.rows.map((r) => [r.status, r.notes.join(" | ")])).toEqual([
      ["fehler", "gültig ab: Datum angeben (JJJJ-MM-TT oder TT.MM.JJJJ)"],
      ["fehler", "gültig bis: Datum angeben (JJJJ-MM-TT oder TT.MM.JJJJ)"],
      ["fehler", "gültig ab: muss im Schuljahr liegen"],
      ["fehler", "„gültig bis“ liegt vor „gültig ab“"],
      ["fehler", "überschneidet sich mit dem vorhandenen Lehrauftrag (gültig von Beginn bis 2027-01-31) – dort die Gültigkeit ändern"],
      ["neu", "gültig ab 2027-02-01"],
      ["fehler", "steht schon in Zeile 7"],
      ["neu", "gültig ab 2026-09-01 bis 2027-01-31"],
      ["fehler", "steht schon in Zeile 9"],
    ]);
    expect(p.preview.ok).toBe(false);
  });

  it("Q-SP2-13: Export ↔ Import – die Verteilungs-CSV mit Zeiträumen wird als „gleich“ wiedererkannt", async () => {
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7a", subjectId: "D", hours: 4, teacherIds: ["t1"], doubleLessons: 0, roomId: null, note: null, validUntil: "2027-01-31" });
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7a", subjectId: "D", hours: 3, teacherIds: ["t1"], doubleLessons: 0, roomId: null, note: null, validFrom: "2027-02-01" });
    await createAssignment(h.db, "t1", { schoolYearId: year.id, groupId: "g-7b", subjectId: "M", hours: 4, teacherIds: ["t2"], doubleLessons: 0, roomId: null, note: null });
    const t = await buildExport(h.db, "verteilung", { today: "2026-10-01" });
    expect(t.rows).toHaveLength(3);
    expect(t.rows.map((r) => [r[7], r[8]]).sort()).toEqual([
      ["", ""],
      ["", "2027-01-31"],
      ["2027-02-01", ""],
    ]);
    const p = await plan(decodeCsvBytes(new TextEncoder().encode(toCsv([t.head, ...t.rows]))).text);
    expect(p.preview.rows.map((r) => r.status)).toEqual(["gleich", "gleich", "gleich"]);
  });

  it("Windows-1252 und Vorlage: Umlaute im Fachnamen, Vorlage ist selbst importierbar", async () => {
    const { text, encoding } = decodeCsvBytes(csvBytes([["Klasse", "Fach", "Stunden", "Lehrkraft"], ["7a", "Katholische Religion", 2, "Eva Förster"]], "cp1252"));
    expect(encoding).toBe("cp1252");
    expect((await plan(text)).preview.rows[0]!.status).toBe("neu");
    const tpl = await assignmentCsvTemplate(h.db);
    expect(tpl.split("\r\n")[0]).toBe("﻿Klasse/Kurs;Fach;Stunden;Lehrkraft;Doppelstunden;Raumwunsch;Band;gültig ab;gültig bis");
    const p = await plan(decodeCsvBytes(new TextEncoder().encode(tpl)).text);
    expect(p.preview.rows.map((r) => r.status)).toEqual(["neu", "neu"]);
  });
});
