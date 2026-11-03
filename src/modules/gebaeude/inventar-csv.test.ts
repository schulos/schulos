// INV-06: Inventarliste im Schulträgerformat (Export → unverändert wieder importierbar, Vorschau ohne Schreiben, Spaltenzuordnung,
// leere Zellen lassen Werte stehen, Ausgemustertes bleibt, Rechte je Kategorie, Formel-Schutz, Größenlimit), Frist-Hinweise in
// „Offen für dich“ (nur Pflegende, Vorlauf als Einstellung) und Karte „Inventar“ im Raumsteckbrief.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { auditLog, gebaeudeAssetCategories, gebaeudeAssets, groupMembers, groups } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { decodeCsvBytes } from "@/core/csv";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { ensureCategories, updateCategory } from "./inventar";
import { ASSET_CATEGORY_TEMPLATE } from "./kategorien";
import {
  CSV_COLUMNS,
  CSV_FIELDS,
  MAX_ASSET_CSV_BYTES,
  assetListCsv,
  detectLayout,
  executeAssetImport,
  fieldForHeader,
  importAssets,
  parseAssetCsv,
  planAssetImport,
} from "./inventar-csv";
import { deadlineItem, gebaeudeOpen } from "./open";
import { createAsset, setAssetActive } from "./pruefungen";
import { roomInventory } from "./raum-inventar";
import { DEADLINE_DAYS } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: configure, view_all
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.inventory über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft, im Test im „IT-Team“ (verantwortlich für IT)
const LEA = "u-lea.schaefer"; // Schülerin

const text = (bytes: Uint8Array) => decodeCsvBytes(bytes).text;
const cats = ASSET_CATEGORY_TEMPLATE.map((t) => ({ id: t.key, key: t.key, name: t.name, prefix: t.prefix }));

describe("Inventarliste: Format (rein)", () => {
  it("Kopfzeile des Exports, Schreibweisen und alte Spalten werden erkannt; ohne Kopfzeile gilt die alte Spaltenfolge", () => {
    for (const f of CSV_FIELDS) expect(fieldForHeader(CSV_COLUMNS[f].header)).toBe(f);
    expect(fieldForHeader(" INV.-NR. ")).toBe("inventoryNo");
    expect(fieldForHeader("Gewährleistung bis")).toBe("warrantyUntil");
    expect(fieldForHeader("Art")).toBe("category");
    expect(fieldForHeader("Bemerkung")).toBeNull();
    expect(detectLayout("Inventarnummer;Bezeichnung;Bemerkung;Kategorie\n")).toMatchObject({ header: true, columns: ["inventoryNo", "name", null, "category"] });
    // doppelte Spalte: die erste gewinnt
    expect(detectLayout("Name;Bezeichnung;Kategorie\n").columns).toEqual(["name", null, "category"]);
    const legacy = detectLayout("Beamer;IT;106\n");
    expect(legacy.header).toBe(false);
    expect(legacy.columns.slice(0, 4)).toEqual(["name", "category", "roomId", "inventoryNo"]);
  });

  it("neue Spalten: Zustand, Preis, Datumsangaben, Gebäude; Fehler je Zeile; Formel-Hochkomma aus dem Export fällt weg", () => {
    const csv =
      "Inventarnummer;Bezeichnung;Kategorie;Zustand;Preis (EUR);Garantie bis;Zweckbindung bis;Gebäude;Etage\n" +
      "IT-1;Laptop;IT;Gut;1.234,50;31.12.2027;2030-01-31;Hauptgebäude;EG\n" +
      "IT-2;Laptop 2;IT;kaputt;;;;;\n" +
      "IT-3;Laptop 3;IT;;12,345;;;;\n" +
      "IT-4;Laptop 4;IT;;;31.02.2027;;;\n" +
      "IT-5;'=SUMME(A1);IT;;;;;;\n";
    const r = parseAssetCsv(csv, cats);
    expect(r.rows[0]).toMatchObject({ inventoryNo: "IT-1", condition: "gut", priceCents: 123450, warrantyUntil: "2027-12-31", boundUntil: "2030-01-31", building: "Hauptgebäude", floor: "EG" });
    expect(r.errors.map((e) => [e.line, e.message])).toEqual([
      [3, "Zustand „kaputt“ unbekannt (neu, gut, gebraucht, defekt)"],
      [4, "Preis „12,345“ nicht lesbar (z. B. 1234,56)"],
      [5, "Datum „31.02.2027“ nicht lesbar (TT.MM.JJJJ)"],
    ]);
    expect(r.rows[1]).toMatchObject({ inventoryNo: "IT-5", name: "=SUMME(A1)" });
    // Zuordnung von Hand: unbekannte Köpfe, erste Zeile ist Kopfzeile
    const own = parseAssetCsv("Gerät;Gruppe X;Ort\nBeamer;AV;106\n", cats, { header: true, columns: ["name", "category", "roomId"] });
    expect(own.rows).toEqual([expect.objectContaining({ line: 2, name: "Beamer", categoryId: "praesentation", roomId: "106" })]);
  });

  it("Frist-Punkt: Anzahl, die ersten zwei Geräte, frühestes Datum; leer → nichts", () => {
    expect(deadlineItem("garantie", [])).toBeNull();
    expect(
      deadlineItem("garantie", [
        { name: "Laptop B", date: "2026-12-01" },
        { name: "Laptop A", date: "2026-11-20" },
        { name: "Beamer", date: "2026-12-24" },
      ]),
    ).toEqual({ id: "gebaeude:garantie", moduleId: "gebaeude", label: "Garantie läuft ab", count: 3, detail: "Laptop A · Laptop B … · ab 20.11.2026", href: "/gebaeude/inventar?frist=garantie", tone: "warn" });
    expect(deadlineItem("zweckbindung", [{ name: "Tafel", date: "2027-01-01" }])).toMatchObject({ tone: "info", label: "Zweckbindung endet" });
  });
});

describe("Inventarliste im Schulträgerformat (INV-06)", () => {
  let h: DbHandle;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const catId = new Map<string, string>();
  const GROUP = "g-test-it-team";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await ensureCategories(h.db);
    for (const c of await h.db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)) catId.set(c.key, c.id);
    await h.db.insert(groups).values({ id: GROUP, name: "IT-Team", slug: "it-team-csv", kind: "frei" });
    await h.db.insert(groupMembers).values({ groupId: GROUP, userId: JANA });
    await updateCategory(h.db, await p(SABINE), catId.get("it")!, { name: "IT", prefix: "IT", inspectionRequired: false, responsibleGroupId: GROUP, sortOrder: 100, active: true });
  }, 60_000);
  afterAll(() => h.close());

  it("Export → unverändert wieder importiert: alles „unverändert“, nichts zu übernehmen; Audit ohne Inhalte", async () => {
    const sabine = await p(SABINE);
    await createAsset(
      h.db,
      sabine,
      { name: "=HYPERLINK(\"x\")", categoryId: catId.get("it")!, roomId: "IF1", inventoryNo: "IT-CSV-1", price: "899,00", warrantyUntil: addDays(today, 20), condition: "neu", supplier: "Musterhandel GmbH" },
      today,
    );
    const csv = text(await assetListCsv(h.db, sabine, {}));
    const [head, ...lines] = csv.trim().split("\r\n");
    expect(head).toBe(CSV_FIELDS.map((f) => CSV_COLUMNS[f].header).join(";"));
    const line = lines.find((l) => l.startsWith("IT-CSV-1;"))!;
    // Formel entschärft, Preis mit Komma, Datum deutsch
    expect(line).toContain(`;"'=HYPERLINK(""x"")";`);
    expect(line).toContain(";899,00;Musterhandel GmbH;");
    expect(line).toContain(`;${addDays(today, 20).split("-").reverse().join(".")};`);
    const plan = await planAssetImport(h.db, sabine, csv);
    expect(plan.preview.counts).toMatchObject({ neu: 0, aendern: 0, fehler: 0 });
    expect(plan.preview.counts.gleich).toBe(lines.length);
    expect(plan.preview.ok).toBe(false);
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "gebaeude.asset.export"));
    expect(JSON.stringify(entry!.meta ?? {})).not.toContain("HYPERLINK");
    // cp1252 für ältere Tabellenprogramme
    const cp = await assetListCsv(h.db, sabine, { q: "IT-CSV-1" }, "cp1252");
    expect(decodeCsvBytes(cp).encoding).toBe("cp1252");
    expect(decodeCsvBytes(cp).text).toContain("Gebäude");
  });

  it("Vorschau schreibt nichts; Übernahme ändert nur gefüllte Zellen, legt neu an, überspringt Ausgemustertes", async () => {
    const sabine = await p(SABINE);
    const before = (await h.db.select().from(gebaeudeAssets)).length;
    const retired = await createAsset(h.db, sabine, { name: "Alter Beamer", categoryId: catId.get("praesentation")!, roomId: null, inventoryNo: "AV-ALT" }, today);
    await setAssetActive(h.db, sabine, retired, false, today, "defekt");
    const csv =
      "Inventarnummer;Bezeichnung;Kategorie;Raum;Preis (EUR);Lieferant;Gebäude;Ausgemustert am\n" +
      "IT-CSV-1;Laptop Lehrerzimmer;IT;;;;;\n" + // nur Name ändert sich, Raum/Preis/Lieferant bleiben
      ";Stühle Aula;Möbel;;;;;\n" + // neu, Nummer vom Zähler
      "AV-ALT;Alter Beamer;AV;;;;;\n" + // ausgemustert → bleibt
      "AV-WEG;Kaputter Beamer;AV;;;;;01.01.2025\n"; // ausgemustert, unbekannt → nicht anlegen
    const plan = await planAssetImport(h.db, sabine, csv);
    expect(plan.preview.rows.map((r) => [r.line, r.status])).toEqual([
      [2, "aendern"],
      [3, "neu"],
      [4, "uebersprungen"],
      [5, "uebersprungen"],
    ]);
    expect(plan.preview.rows[0]!.notes).toEqual(["ändert: Bezeichnung"]);
    expect(plan.preview.ok).toBe(true);
    expect((await h.db.select().from(gebaeudeAssets)).length).toBe(before + 1); // nur „Alter Beamer“ von oben
    expect(await executeAssetImport(h.db, sabine, plan, today)).toEqual({ created: 1, updated: 1, skipped: 2 });
    const [laptop] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "IT-CSV-1"));
    expect(laptop).toMatchObject({ name: "Laptop Lehrerzimmer", roomId: "IF1", priceCents: 89900, supplier: "Musterhandel GmbH" });
    expect((await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "AV-WEG"))).length).toBe(0);
    const [chairs] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.name, "Stühle Aula"));
    expect(chairs!.inventoryNo).toMatch(/^MO-\d{4}$/);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "gebaeude.asset.import"));
    expect(audits.at(-1)!.meta).toEqual({ created: 1, updated: 1, skipped: 2 });
  });

  it("Gebäude/Etage nur ohne Raum, gegen die Stammdaten; Fehler sammeln, Größe und Zeilenzahl begrenzt", async () => {
    const sabine = await p(SABINE);
    const plan = await planAssetImport(h.db, sabine, "Bezeichnung;Kategorie;Raum;Gebäude;Etage\nSchrank;Möbel;999;;\nSchrank 2;Möbel;;Nirgendwo;\nSchrank 3;Möbel;;;EG\nSchrank 4;Möbel;106;Nirgendwo;\n");
    expect(plan.preview.rows.map((r) => [r.line, r.status, r.notes[0]])).toEqual([
      [2, "fehler", "Raum „999“ gibt es nicht"],
      [3, "fehler", "Gebäude „Nirgendwo“ gibt es nicht"],
      [4, "fehler", "Etage ohne Gebäude"],
      [5, "neu", "Inventarnummer wird vergeben"],
    ]);
    expect(plan.preview.ok).toBe(false);
    await expect(executeAssetImport(h.db, sabine, plan, today)).rejects.toThrow();
    const big = await planAssetImport(h.db, sabine, "x".repeat(MAX_ASSET_CSV_BYTES + 1));
    expect(big.preview.fileErrors).toEqual(["Datei zu groß (höchstens 512 KB)"]);
    const many = await planAssetImport(h.db, sabine, "Bezeichnung;Kategorie\n" + "Stuhl;Möbel\n".repeat(2001));
    expect(many.preview.fileErrors).toContain("Höchstens 2000 Zeilen je Import");
    expect(many.preview.ok).toBe(false);
  });

  it("Rechte: verantwortliche Gruppe nur ihre Kategorie (Zeilenfehler, Ein-Schritt-Import verboten); ohne Inventarrecht weder Vorschau noch Export", async () => {
    const [jana, lea, klaus] = await Promise.all([p(JANA), p(LEA), p(KLAUS)]);
    const plan = await planAssetImport(h.db, jana, "Bezeichnung;Kategorie\nWLAN Flur;IT\nLeiter Flur;Leiter\n");
    expect(plan.forbidden).toBe(true);
    expect(plan.preview.rows.map((r) => [r.status, r.notes[0]])).toEqual([
      ["neu", "Inventarnummer wird vergeben"],
      ["fehler", "Kategorie „Leiter/Tritt“ pflegst du nicht"],
    ]);
    await expect(importAssets(h.db, jana, "Bezeichnung;Kategorie\nLeiter Flur;Leiter\n", today)).rejects.toThrow(ForbiddenError);
    // fremdes Gut über die Inventarnummer ändern: verboten
    const other = await planAssetImport(h.db, jana, "Inventarnummer;Bezeichnung;Kategorie\nAV-ALT;Mein Beamer;IT\n");
    expect(other.forbidden).toBe(true);
    // Export der Gruppe: nur IT
    const csv = text(await assetListCsv(h.db, jana, {}));
    expect(csv).toContain("IT-CSV-1");
    expect(csv).not.toContain("Stühle Aula");
    await expect(planAssetImport(h.db, lea, "Bezeichnung;Kategorie\nX;IT\n")).rejects.toThrow(ForbiddenError);
    await expect(assetListCsv(h.db, lea, {})).rejects.toThrow(ForbiddenError);
    // Hausmeisterei (inventory) darf alles
    expect((await planAssetImport(h.db, klaus, "Bezeichnung;Kategorie\nLeiter Flur;Leiter\n")).preview.ok).toBe(true);
  });

  it("„Offen für dich“: Garantie/Zweckbindung im Vorlauf nur für Pflegende ihrer Kategorien; Einstellung „aus“", async () => {
    const sabine = await p(SABINE);
    await createAsset(h.db, sabine, { name: "Leiter Bühne", categoryId: catId.get("leiter")!, roomId: null, inventoryNo: "LE-FRIST", boundUntil: addDays(today, 40) }, today);
    const now = fromBerlinLocal(`${today}T08:00`);
    const items = async (id: string) => gebaeudeOpen.collect(h.db, { perms: await p(id) } as CurrentUser, now);
    const s = await items(SABINE);
    expect(s.find((i) => i.id === "gebaeude:garantie")).toMatchObject({ count: 1, href: "/gebaeude/inventar?frist=garantie" });
    expect(s.find((i) => i.id === "gebaeude:zweckbindung")).toMatchObject({ count: 1 });
    // Jana (IT-Team): nur die IT-Garantie, nicht die Leiter
    expect((await items(JANA)).map((i) => i.id)).toEqual(["gebaeude:garantie"]);
    expect(await items(LEA)).toEqual([]);
    // Vorlauf 30 Tage: Zweckbindung in 40 Tagen fällt heraus
    await writeModuleSetting(h.db, DEADLINE_DAYS, "30");
    expect((await items(SABINE)).map((i) => i.id)).toEqual(["gebaeude:garantie"]);
    await writeModuleSetting(h.db, DEADLINE_DAYS, "0");
    expect(await items(SABINE)).toEqual([]);
    await writeModuleSetting(h.db, DEADLINE_DAYS, "60");
  });

  it("Raumsteckbrief: Inventar je Kategorie mit Stückzahl; ohne Sicht aufs Inventar keine Karte", async () => {
    const sabine = await p(SABINE);
    await createAsset(h.db, sabine, { name: "Tische", categoryId: catId.get("moebel")!, roomId: "IF1", inventoryNo: null, quantity: 15 }, today);
    const inv = (await roomInventory(h.db, sabine, "IF1"))!;
    expect(inv.categories.find((c) => c.id === catId.get("moebel"))).toMatchObject({ entries: 1, pieces: 15 });
    expect(inv.categories.find((c) => c.id === catId.get("it"))!.entries).toBeGreaterThanOrEqual(1);
    expect(inv.pieces).toBeGreaterThan(inv.entries);
    // Jana sieht nur IT, Lea nichts
    expect((await roomInventory(h.db, await p(JANA), "IF1"))!.categories.map((c) => c.id)).toEqual([catId.get("it")]);
    expect(await roomInventory(h.db, await p(LEA), "IF1")).toBeNull();
    expect((await roomInventory(h.db, sabine, "TH1"))?.entries ?? 0).toBeGreaterThanOrEqual(0);
  });
});
