// Schulbücherei – Bestand (BU-01): Exemplarnummern, ISBN, Rechte, Aussondern, CSV-Import.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiCopies, buechereiTitles } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { copyNumber, isValidCopyNumber, luhnDigit, normalizeIsbn } from "./labels";
import { addCopies, createTitle, deleteTitle, getTitle, importTitles, listTitles, parseMediaType, parseTitleCsv, restoreCopy, stockSummary, updateCopy, updateTitle, withdrawCopy } from "./service";

const TODAY = "2026-10-19";
const SABINE = "u-sabine.kowalski"; // Sekretariat (Rolle verwaltung)
const AYLIN = "u-aylin.demir"; // Leitung Büchereiteam
const JANA = "u-jana.brandt"; // Lehrkraft ohne Team
const LEA = "u-lea.schaefer";

describe("Bücherei – reine Prüfungen", () => {
  it("Exemplarnummer mit Prüfziffer", () => {
    expect(luhnDigit("004711")).toBe(luhnDigit("004711"));
    expect(copyNumber(1)).toMatch(/^B-000001-\d$/);
    expect(copyNumber(4711)).toMatch(/^B-004711-\d$/);
    for (const n of [1, 9, 10, 4711, 123456]) expect(isValidCopyNumber(copyNumber(n))).toBe(true);
    const [p, d, c] = copyNumber(4711).split("-");
    expect(isValidCopyNumber(`${p}-${d}-${(Number(c) + 1) % 10}`)).toBe(false);
    // Zahlendreher fallen auf
    expect(isValidCopyNumber(`B-007411-${c}`)).toBe(luhnDigit("007411") === Number(c));
    expect(isValidCopyNumber("B-12-3")).toBe(false);
  });

  it("ISBN: Prüfziffer, Bindestriche, 10 → 13", () => {
    expect(normalizeIsbn("978-3-00-000001-0")).toBe("9783000000010");
    expect(normalizeIsbn("978-3-00-000001-1")).toBeNull();
    expect(normalizeIsbn("3-499-13599-X")).toBe("9783499135996");
    expect(normalizeIsbn("0-306-40615-2")).toBe("9780306406157");
    expect(normalizeIsbn("0-306-40615-3")).toBeNull();
    expect(normalizeIsbn("12345")).toBeNull();
  });

  it("Medienart aus Beschriftung oder Kurzform", () => {
    expect(parseMediaType("")).toBe("buch");
    expect(parseMediaType("Film")).toBe("film");
    expect(parseMediaType("DVD")).toBe("film");
    expect(parseMediaType("Gerät")).toBe("geraet");
    expect(parseMediaType("Zeitschrift")).toBeNull();
  });

  it("CSV mit Kopfzeile, Fehlern und Vorgaben", () => {
    const { rows, errors } = parseTitleCsv(
      "﻿Titel;Autor;ISBN;Exemplare;Medienart\nEins;A;978-3-00-000001-0;2;\nZwei;;;;DVD\n;Ohne Titel;;;\nDrei;;123;;\nVier;;;0;\n",
    );
    expect(rows.map((r) => [r.title, r.count, r.mediaType, r.isbn])).toEqual([
      ["Eins", 2, "buch", "9783000000010"],
      ["Zwei", 1, "film", null],
    ]);
    expect(errors.map((e) => e.line)).toEqual([4, 5, 6]);
  });

  it("CSV ohne Kopfzeile in fester Reihenfolge", () => {
    const { rows, errors } = parseTitleCsv("Titel A,Autor A,,Verlag,2020,Spiel,SP A,Regal 1,3");
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ title: "Titel A", author: "Autor A", publisher: "Verlag", year: 2020, mediaType: "spiel", signature: "SP A", location: "Regal 1", count: 3 });
  });
});

describe("Bücherei – Bestand", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it("Demo-Bestand und Rechte: Verwaltung und Büchereiteam ja, Lehrkraft und Schüler:in nein", async () => {
    const sum = await stockSummary(h.db, await p(SABINE));
    expect(sum.titles).toBeGreaterThan(5);
    expect(sum.withdrawn).toBe(1);
    expect((await listTitles(h.db, await p(AYLIN))).length).toBe(sum.titles);
    await expect(listTitles(h.db, await p(JANA))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTitle(h.db, await p(LEA), { title: "X", mediaType: "buch" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Titel mit Exemplaren anlegen: fortlaufende, gültige Nummern; ISBN normalisiert und nur einmal", async () => {
    const sabine = await p(SABINE);
    const { id, barcodes } = await createTitle(h.db, sabine, { title: "Testbuch", author: "T. Autor", isbn: "3-499-13599-X", year: "2001", mediaType: "buch" }, { count: 3, signature: "T AUT", location: "Regal 9" });
    expect(barcodes).toHaveLength(3);
    expect(barcodes.every(isValidCopyNumber)).toBe(true);
    const seqs = barcodes.map((b) => Number(b.split("-")[1]));
    expect(seqs[1]! - seqs[0]!).toBe(1);
    const t = await getTitle(h.db, sabine, id);
    expect(t?.title.isbn).toBe("9783499135996");
    expect(t?.copies.map((c) => c.signature)).toEqual(["T AUT", "T AUT", "T AUT"]);
    await expect(createTitle(h.db, sabine, { title: "Doppelt", isbn: "978-3-499-13599-6", mediaType: "buch" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTitle(h.db, sabine, { title: "", isbn: "123", year: "99", mediaType: "x" })).rejects.toMatchObject({
      fieldErrors: { title: expect.any(String), isbn: expect.any(String), year: expect.any(String), mediaType: expect.any(String) },
    });
    // Suche über ISBN (auch als ISBN-10), Exemplarnummer und Schlagwort
    expect((await listTitles(h.db, sabine, { q: "3-499-13599-X" })).map((r) => r.id)).toEqual([id]);
    expect((await listTitles(h.db, sabine, { q: barcodes[1]! })).map((r) => r.id)).toEqual([id]);
    expect((await listTitles(h.db, sabine, { q: "testbu" })).map((r) => r.id)).toEqual([id]);
    await updateTitle(h.db, sabine, id, { title: "Testbuch (2. Aufl.)", isbn: "9783499135996", mediaType: "buch", keywords: "Probe" });
    expect((await listTitles(h.db, sabine, { q: "Probe" })).map((r) => r.title)).toEqual(["Testbuch (2. Aufl.)"]);
  });

  it("Exemplare ergänzen, ändern, aussondern und zurückholen – mit Protokoll", async () => {
    const team = await p(AYLIN);
    const { id } = await createTitle(h.db, team, { title: "Aussonderungstest", mediaType: "spiel" });
    const [nr] = await addCopies(h.db, team, id, { count: 1, condition: "neu" });
    const [copy] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.barcode, nr!));
    await updateCopy(h.db, team, copy!.id, { signature: "SP X", location: "Spieleregal", condition: "gut" });
    await expect(withdrawCopy(h.db, team, copy!.id, " ", TODAY)).rejects.toBeInstanceOf(ValidationError);
    await withdrawCopy(h.db, team, copy!.id, "Teile fehlen", TODAY);
    await expect(withdrawCopy(h.db, team, copy!.id, "nochmal", TODAY)).rejects.toBeInstanceOf(ValidationError);
    const [w] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.id, copy!.id));
    expect(w).toMatchObject({ signature: "SP X", condition: "gut", withdrawnOn: TODAY, withdrawnReason: "Teile fehlen" });
    // ganz ausgesonderte Titel nur mit „alle“
    expect((await listTitles(h.db, team, { q: "Aussonderungstest" })).length).toBe(0);
    expect((await listTitles(h.db, team, { q: "Aussonderungstest", withdrawn: true })).length).toBe(1);
    await restoreCopy(h.db, team, copy!.id);
    expect((await listTitles(h.db, team, { q: "Aussonderungstest" }))[0]?.active).toBe(1);
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.target, id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["buecherei.title.create", "buecherei.copy.create", "buecherei.copy.update", "buecherei.copy.withdraw", "buecherei.copy.restore"]));
    // Titel mit Exemplaren lässt sich nicht löschen, ohne schon
    await expect(deleteTitle(h.db, team, id)).rejects.toBeInstanceOf(ValidationError);
    const { id: leer } = await createTitle(h.db, team, { title: "Fehlerfassung", mediaType: "buch" }, { count: 0 });
    await deleteTitle(h.db, team, leer);
    expect(await getTitle(h.db, team, leer)).toBeNull();
  });

  it("CSV-Import: Vorschau schreibt nichts, Dubletten per ISBN bekommen nur Exemplare, Fehler → nichts", async () => {
    const sabine = await p(SABINE);
    const before = (await h.db.select({ id: buechereiTitles.id }).from(buechereiTitles)).length;
    const csv = "Titel;Autor;ISBN;Exemplare\nImport A;X;978-0-306-40615-7;2\nImport A Doppel;X;0-306-40615-2;1\nImport B;Y;;1\nDie Nacht im Leuchtturm;;978-3-00-000001-0;1\n";
    const preview = await importTitles(h.db, sabine, csv, { dryRun: true });
    expect(preview).toEqual({ titles: 2, existing: 2, copies: 5, dryRun: true });
    expect((await h.db.select({ id: buechereiTitles.id }).from(buechereiTitles)).length).toBe(before);
    const done = await importTitles(h.db, sabine, csv);
    expect(done).toEqual({ titles: 2, existing: 2, copies: 5, dryRun: false });
    expect((await h.db.select({ id: buechereiTitles.id }).from(buechereiTitles)).length).toBe(before + 2);
    const [a] = await listTitles(h.db, sabine, { q: "9780306406157" });
    expect(a).toMatchObject({ title: "Import A", copies: 3 });
    await expect(importTitles(h.db, sabine, "Titel;ISBN\nGut;\nSchlecht;978-0-306-40615-8\n")).rejects.toBeInstanceOf(ValidationError);
    expect((await listTitles(h.db, sabine, { q: "Gut" })).length).toBe(0);
    await expect(importTitles(h.db, await p(JANA), csv)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
