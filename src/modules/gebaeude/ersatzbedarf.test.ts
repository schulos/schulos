// INV-08…INV-11: Vertragsfelder am Gerät (Formular-Validierung, Liste/Filter, CSV-Spalten, eingeschränkte Sicht), Frist-Hinweis
// „Wartungsvertrag“ in „Offen für dich“, Nutzungsdauer je Kategorie (Migration, Vorlage, Formular) und Auswertung Ersatzbedarf
// (rein und mit Rechten: Werte nur configure/view_all, verantwortliche Gruppe nur eigene Kategorien, Export-Audit nur Zahlen).
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { auditLog, gebaeudeAssetCategories, groupMembers, groups } from "@/core/db/schema";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import { decodeCsvBytes } from "@/core/csv";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { ageYears, buildReplacementReport, canSeeValues, parseHorizon, replacementCsv, replacementReport, replacementState, replacementYear, type ReplacementAsset } from "./ersatzbedarf";
import { createCategory, ensureCategories, listCategories, updateCategory } from "./inventar";
import { assetListCsv, parseAssetCsv, planAssetImport, executeAssetImport, CSV_COLUMNS } from "./inventar-csv";
import { ASSET_CATEGORY_TEMPLATE } from "./kategorien";
import { contractDeadline, deadlineItem, gebaeudeOpen } from "./open";
import { addMonths, createAsset, getAsset, listAssets, serviceNoticeDate, updateAsset } from "./pruefungen";

const SABINE = "u-sabine.kowalski"; // Verwaltung: configure, view_all
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.inventory über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft, im Test im „Musik-Team“ (verantwortlich für Musik)
const LEA = "u-lea.schaefer"; // Schülerin

const cats = ASSET_CATEGORY_TEMPLATE.map((t) => ({ id: t.key, key: t.key, name: t.name, prefix: t.prefix }));

describe("Verträge und Ersatzbedarf (rein)", () => {
  it("Kündigungstag: Ende minus Frist, Monatsende begrenzt; ohne Frist das Ende; maßgebliches Datum ab heute", () => {
    expect(serviceNoticeDate("2027-05-31", 3)).toBe("2027-02-28");
    expect(serviceNoticeDate("2027-06-30", null)).toBe("2027-06-30");
    expect(serviceNoticeDate(null, 3)).toBeNull();
    expect(contractDeadline({ serviceEnd: "2027-06-30", serviceNoticeMonths: 3 }, "2027-01-01")).toEqual({ date: "2027-03-30", notice: true });
    // Kündigungstag vorbei → das Vertragsende zählt
    expect(contractDeadline({ serviceEnd: "2027-06-30", serviceNoticeMonths: 3 }, "2027-04-01")).toEqual({ date: "2027-06-30", notice: false });
    expect(contractDeadline({ serviceEnd: "2027-06-30", serviceNoticeMonths: null }, "2027-07-01")).toBeNull();
    expect(contractDeadline({ serviceEnd: null, serviceNoticeMonths: 2 }, "2027-01-01")).toBeNull();
    expect(deadlineItem("vertrag", [{ name: "Aufzug", date: "2027-03-30" }])).toMatchObject({ id: "gebaeude:vertrag", label: "Wartungsvertrag: Frist", tone: "warn", href: "/gebaeude/inventar?frist=vertrag" });
  });

  it("Alter, Ersatzjahr und Stand gegen die Nutzungsdauer", () => {
    expect(ageYears("2020-06-15", "2026-06-14")).toBe(5);
    expect(ageYears("2020-06-15", "2026-06-15")).toBe(6);
    expect(ageYears(null, "2026-01-01")).toBeNull();
    expect(replacementYear("2020-06-15", 5)).toBe(2025);
    expect(replacementYear("2020-06-15", null)).toBeNull();
    const s = (acquiredOn: string | null, life: number | null) => replacementState({ acquiredOn, categoryLifetimeYears: life }, 2026, 5);
    expect(s("2020-01-01", 5)).toBe("faellig");
    expect(s("2021-12-31", 5)).toBe("faellig");
    expect(s("2022-01-01", 5)).toBe("bald");
    expect(s("2026-01-01", 5)).toBe("bald");
    expect(s("2026-01-01", 6)).toBe("spaeter");
    expect(s(null, 5)).toBe("ohne_datum");
    expect(s("2000-01-01", null)).toBe("ohne_richtwert");
    expect(parseHorizon("10")).toBe(10);
    expect(parseHorizon("7")).toBe(5);
    expect(parseHorizon(null)).toBe(5);
  });

  it("Auswertung je Kategorie, Jahr und Raum; Sammelposten zählen Stück, Werte nur mit Freigabe", () => {
    const base = { categorySort: 0, building: null, floor: null, inventoryNo: null } as const;
    const assets: ReplacementAsset[] = [
      { ...base, id: "a", name: "Laptop alt", categoryId: "it", categoryName: "IT", categoryLifetimeYears: 5, roomId: "IF1", quantity: 1, acquiredOn: "2019-03-01", priceCents: 90000 },
      { ...base, id: "b", name: "Tablets", categoryId: "it", categoryName: "IT", categoryLifetimeYears: 5, roomId: "IF1", quantity: 16, acquiredOn: "2023-09-01", priceCents: 689000 },
      { ...base, id: "c", name: "Tische", categoryId: "mo", categoryName: "Möbel", categorySort: 1, categoryLifetimeYears: 15, roomId: "205", quantity: 15, acquiredOn: null, priceCents: null },
      { ...base, id: "d", name: "Verbandkasten", categoryId: "eh", categoryName: "Erste Hilfe", categorySort: 2, categoryLifetimeYears: null, roomId: null, quantity: 1, acquiredOn: "2010-01-01", priceCents: 3000 },
    ];
    const r = buildReplacementReport(assets, "2026-11-03", 3, true);
    expect(r.totals.faellig).toEqual({ entries: 1, pieces: 1, valueCents: 90000 });
    expect(r.totals.bald).toEqual({ entries: 1, pieces: 16, valueCents: 689000 });
    expect(r.totals.ohne_datum.pieces).toBe(15);
    expect(r.totals.ohne_richtwert.pieces).toBe(1);
    expect(r.byCategory.map((c) => [c.name, c.total.pieces, c.faellig.pieces, c.bald.pieces, c.ohneDatum])).toEqual([
      ["IT", 17, 1, 16, 0],
      ["Möbel", 15, 0, 0, 15],
      ["Erste Hilfe", 1, 0, 0, 0],
    ]);
    // erstes Jahr enthält Überfälliges, Tablets 2023 + 5 = 2028
    expect(r.byYear.map((y) => [y.year, y.overdue, y.counts.pieces])).toEqual([
      [2026, true, 1],
      [2027, false, 0],
      [2028, false, 16],
      [2029, false, 0],
    ]);
    expect(r.byPlace).toEqual([expect.objectContaining({ place: "Raum IF1", roomId: "IF1", faellig: expect.objectContaining({ pieces: 1 }), bald: expect.objectContaining({ pieces: 16 }) })]);
    expect(r.items.map((i) => [i.id, i.year, i.age])).toEqual([
      ["a", 2024, 7],
      ["b", 2028, 3],
    ]);
    // ohne Freigabe: keine Werte, keine Preise an den Einträgen
    const n = buildReplacementReport(assets, "2026-11-03", 3, false);
    expect(n.values).toBe(false);
    expect(n.totals.faellig.valueCents).toBeNull();
    expect(n.items.every((i) => i.priceCents === null)).toBe(true);
  });

  it("CSV: Spalten für den Vertrag, Kündigungsfrist streng geprüft", () => {
    expect(CSV_COLUMNS.servicePartner.header).toBe("Wartungspartner");
    const r = parseAssetCsv(
      "Bezeichnung;Kategorie;Wartungsfirma;Vertrag bis;Kündigungsfrist\nAufzug Haus A;Aufzug;Lift GmbH;30.06.2027;3\nTor;Tor;;;viel\nTor 2;Tor;;;40\n",
      cats,
    );
    expect(r.rows[0]).toMatchObject({ servicePartner: "Lift GmbH", serviceEnd: "2027-06-30", serviceNoticeMonths: 3 });
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(r.errors[0]!.message).toContain("Kündigungsfrist");
  });
});

describe("Nutzungsdauer: Migration und Vorlage (INV-10)", () => {
  it("die Migration setzt die Richtwerte der Vorlage für schon angelegte Vorlagen-Kategorien", async () => {
    const h = await createTestDb();
    try {
      // vor `ensureCategories`: nur die Zeilen aus der Migration 0124
      const rows = rowsOf<{ key: string; lifetime_years: number | null }>(await h.db.execute(sql`select key, lifetime_years from gebaeude_asset_categories`));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.lifetime_years).toBe(ASSET_CATEGORY_TEMPLATE.find((t) => t.key === r.key)?.lifetimeYears ?? null);
      expect(rows.find((r) => r.key === "aufzug")?.lifetime_years).toBe(25);
      // später hinzugekommene Vorlagen (GS-01) bekommen den Wert über `ensureCategories`
      await ensureCategories(h.db);
      const all = await h.db.select({ key: gebaeudeAssetCategories.key, years: gebaeudeAssetCategories.lifetimeYears }).from(gebaeudeAssetCategories);
      expect(all.find((c) => c.key === "abzug")?.years).toBe(20);
      expect(all.find((c) => c.key === "it")?.years).toBe(5);
      expect(all.find((c) => c.key === "erste_hilfe")?.years).toBeNull();
    } finally {
      await h.close();
    }
  }, 60_000);
});

describe("Verträge, Fristen und Ersatzbedarf mit Rechten", () => {
  let h: DbHandle;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const catId = new Map<string, string>();
  const GROUP = "g-test-musik-team";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await ensureCategories(h.db);
    for (const c of await h.db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)) catId.set(c.key, c.id);
    await h.db.insert(groups).values({ id: GROUP, name: "Musik-Team", slug: "musik-team-inv", kind: "frei" });
    await h.db.insert(groupMembers).values({ groupId: GROUP, userId: JANA });
    await updateCategory(h.db, await p(SABINE), catId.get("musik")!, { name: "Musik", prefix: "MU", inspectionRequired: false, responsibleGroupId: GROUP, sortOrder: 140, active: true });
  }, 60_000);
  afterAll(() => h.close());

  it("Vertragsfelder: speichern, prüfen, Filter, eingeschränkte Sicht ohne Vertrag", async () => {
    const sabine = await p(SABINE);
    const base = { name: "Aufzug Haus A", categoryId: catId.get("aufzug")!, roomId: null, inventoryNo: "AZ-V1" };
    await expect(createAsset(h.db, sabine, { ...base, serviceNoticeMonths: "3" }, today)).rejects.toThrow(ValidationError);
    await expect(createAsset(h.db, sabine, { ...base, serviceEnd: addDays(today, 200), serviceNoticeMonths: "40" }, today)).rejects.toThrow(ValidationError);
    await expect(createAsset(h.db, sabine, { ...base, servicePartner: "x".repeat(121) }, today)).rejects.toThrow(ValidationError);
    const id = await createAsset(h.db, sabine, { ...base, servicePartner: "Lift GmbH", serviceEnd: addDays(today, 200), serviceNoticeMonths: "3", serviceNote: "Wartung 2× jährlich" }, today);
    const full = await getAsset(h.db, sabine, id);
    expect(full!.asset).toMatchObject({ servicePartner: "Lift GmbH", serviceNoticeMonths: 3, serviceNote: "Wartung 2× jährlich", categoryLifetimeYears: 25 });
    // Schülerin: eingeschränkte Sicht ohne Vertragsangaben
    const restricted = await getAsset(h.db, await p(LEA), id);
    expect(restricted!.full).toBe(false);
    expect(JSON.stringify(restricted!.asset)).not.toContain("Lift GmbH");
    // Filter „mit Wartungsvertrag“ und Suche im Partner
    expect((await listAssets(h.db, sabine, { withContract: true })).map((a) => a.inventoryNo)).toContain("AZ-V1");
    expect((await listAssets(h.db, sabine, { withContract: true })).every((a) => a.servicePartner || a.serviceEnd)).toBe(true);
    expect((await listAssets(h.db, sabine, { q: "lift gmbh" })).map((a) => a.inventoryNo)).toEqual(["AZ-V1"]);
    // 0 Monate = keine Frist
    await updateAsset(h.db, sabine, id, { ...base, servicePartner: "Lift GmbH", serviceEnd: addDays(today, 200), serviceNoticeMonths: "0" }, today);
    expect((await getAsset(h.db, sabine, id))!.asset).toMatchObject({ serviceNoticeMonths: null, serviceNote: null });
  });

  it("CSV: Export mit Partner, Ende, Frist (ohne Vertragsnotiz); Import ändert nur gefüllte Zellen", async () => {
    const sabine = await p(SABINE);
    await createAsset(h.db, sabine, { name: "Tor Hof", categoryId: catId.get("tor_tuer")!, roomId: null, inventoryNo: "TT-V1", servicePartner: "Torbau AG", serviceEnd: "2030-12-31", serviceNoticeMonths: "6", serviceNote: "Vertrag 4711" }, today);
    const csv = decodeCsvBytes(await assetListCsv(h.db, sabine, { q: "TT-V1" })).text;
    expect(csv.split("\r\n")[0]).toContain(";Garantie bis;Wartungspartner;Vertragsende;Kündigungsfrist (Monate);Letzte Prüfung;");
    expect(csv).toContain(";Torbau AG;31.12.2030;6;");
    expect(csv).not.toContain("4711");
    const plan = await planAssetImport(h.db, sabine, "Inventarnummer;Bezeichnung;Kategorie;Vertragsende\nTT-V1;Tor Hof;Tor;31.12.2031\n");
    expect(plan.preview.rows[0]).toMatchObject({ status: "aendern", notes: ["ändert: Vertragsende"] });
    await executeAssetImport(h.db, sabine, plan, today);
    const [row] = await listAssets(h.db, sabine, { q: "TT-V1" });
    expect(row).toMatchObject({ serviceEnd: "2031-12-31", servicePartner: "Torbau AG", serviceNoticeMonths: 6, serviceNote: "Vertrag 4711" });
    // Kündigungsfrist ohne Vertragsende → Zeilenfehler
    const bad = await planAssetImport(h.db, sabine, "Bezeichnung;Kategorie;Kündigungsfrist (Monate)\nNeues Tor;Tor;3\n");
    expect(bad.preview.rows[0]).toMatchObject({ status: "fehler", notes: ["Kündigungsfrist ohne Vertragsende"] });
  });

  it("„Offen für dich“: Wartungsvertrag mit Kündigungstag im Vorlauf, nur für Pflegende ihrer Kategorien", async () => {
    const sabine = await p(SABINE);
    // Kündigungstag in 20 Tagen (Ende in 3 Monaten + 20 Tagen), Musik-Gerät für Jana
    const end = addMonths(addDays(today, 20), 3);
    await createAsset(h.db, sabine, { name: "Flügel Aula", categoryId: catId.get("musik")!, roomId: null, inventoryNo: "MU-V1", servicePartner: "Klavierbau KG", serviceEnd: end, serviceNoticeMonths: "3" }, today);
    // Vertrag ohne Frist mit Ende weit weg → kein Hinweis
    await createAsset(h.db, sabine, { name: "Beamer Aula", categoryId: catId.get("praesentation")!, roomId: null, inventoryNo: "AV-V1", servicePartner: "AV-Service", serviceEnd: addDays(today, 400) }, today);
    const now = fromBerlinLocal(`${today}T08:00`);
    const items = async (id: string) => gebaeudeOpen.collect(h.db, { perms: await p(id) } as CurrentUser, now);
    const s = (await items(SABINE)).find((i) => i.id === "gebaeude:vertrag");
    expect(s).toMatchObject({ count: 1, label: "Wartungsvertrag: Frist", href: "/gebaeude/inventar?frist=vertrag" });
    expect(s!.detail).toContain("Flügel Aula");
    expect((await items(JANA)).find((i) => i.id === "gebaeude:vertrag")).toMatchObject({ count: 1 });
    expect((await items(KLAUS)).find((i) => i.id === "gebaeude:vertrag")).toMatchObject({ count: 1 });
    expect(await items(LEA)).toEqual([]);
    // Filter „Frist: vertrag“ der Liste
    const list = await listAssets(h.db, sabine, { deadline: { kind: "vertrag", from: today, until: addDays(today, 60) } });
    expect(list.map((a) => a.inventoryNo)).toEqual(["MU-V1"]);
  });

  it("Nutzungsdauer im Kategorienformular: nur configure, 1–50 oder leer; fehlt das Feld, bleibt der Wert", async () => {
    const sabine = await p(SABINE);
    const musik = catId.get("musik")!;
    const input = { name: "Musik", prefix: "MU", inspectionRequired: false, responsibleGroupId: GROUP, sortOrder: 140, active: true };
    await expect(updateCategory(h.db, sabine, musik, { ...input, lifetimeYears: "0" })).rejects.toThrow(ValidationError);
    await expect(updateCategory(h.db, sabine, musik, { ...input, lifetimeYears: "2,5" })).rejects.toThrow(ValidationError);
    await expect(updateCategory(h.db, await p(KLAUS), musik, { ...input, lifetimeYears: "12" })).rejects.toThrow(ForbiddenError);
    await updateCategory(h.db, sabine, musik, { ...input, lifetimeYears: "12" });
    expect((await listCategories(h.db)).find((c) => c.id === musik)?.lifetimeYears).toBe(12);
    await updateCategory(h.db, sabine, musik, input);
    expect((await listCategories(h.db)).find((c) => c.id === musik)?.lifetimeYears).toBe(12);
    await updateCategory(h.db, sabine, musik, { ...input, lifetimeYears: "" });
    expect((await listCategories(h.db)).find((c) => c.id === musik)?.lifetimeYears).toBeNull();
    const own = await createCategory(h.db, sabine, { name: "Robotik", prefix: "RB", inspectionRequired: false, responsibleGroupId: null, sortOrder: 600, active: true, lifetimeYears: "6" });
    expect((await listCategories(h.db)).find((c) => c.id === own)?.lifetimeYears).toBe(6);
    await updateCategory(h.db, sabine, musik, { ...input, lifetimeYears: "15" });
  });

  it("Ersatzbedarf: Werte nur configure/view_all, verantwortliche Gruppe nur eigene Kategorie, sonst 404; Export-Audit nur Zahlen", async () => {
    const sabine = await p(SABINE);
    await createAsset(h.db, sabine, { name: "Geige alt", categoryId: catId.get("musik")!, roomId: "106", inventoryNo: "MU-E1", acquiredOn: addMonths(today, -12 * 20), price: "450,00" }, today);
    await createAsset(h.db, sabine, { name: "Laptop alt", categoryId: catId.get("it")!, roomId: "IF1", inventoryNo: "IT-E1", acquiredOn: addMonths(today, -12 * 8), price: "900,00" }, today);
    const year = Number(today.slice(0, 4));

    const all = await replacementReport(h.db, sabine, {}, today, 5);
    expect(canSeeValues(sabine)).toBe(true);
    expect(all.values).toBe(true);
    expect(all.items.map((i) => i.inventoryNo)).toEqual(expect.arrayContaining(["MU-E1", "IT-E1"]));
    expect(all.items.find((i) => i.inventoryNo === "IT-E1")).toMatchObject({ state: "faellig", priceCents: 90000 });
    // Demo: Schülertische über der Nutzungsdauer
    expect(all.items.find((i) => i.inventoryNo === "MO-0001")).toMatchObject({ state: "faellig", quantity: 15 });
    expect(all.byYear[0]).toMatchObject({ year, overdue: true });
    // Filter Raum
    expect((await replacementReport(h.db, sabine, { roomId: "106" }, today, 5)).items.map((i) => i.inventoryNo)).toEqual(["MU-E1"]);

    // Hausmeisterei (inventory): alle Kategorien, aber keine Werte
    const klaus = await replacementReport(h.db, await p(KLAUS), {}, today, 5);
    expect(klaus.values).toBe(false);
    expect(klaus.items.find((i) => i.inventoryNo === "IT-E1")?.priceCents).toBeNull();
    // Jana (Musik-Team): nur Musik, keine Werte
    const jana = await replacementReport(h.db, await p(JANA), {}, today, 5);
    expect(jana.values).toBe(false);
    expect(new Set(jana.byCategory.map((c) => c.categoryId))).toEqual(new Set([catId.get("musik")]));
    // Schülerin: kein Zugriff
    await expect(replacementReport(h.db, await p(LEA), {}, today, 5)).rejects.toThrow(ForbiddenError);
    await expect(replacementCsv(h.db, await p(LEA), {}, today, 5)).rejects.toThrow(ForbiddenError);

    // CSV: Preis-Spalte nur mit Freigabe; Audit nur mit Zahlen
    const csvS = decodeCsvBytes(await replacementCsv(h.db, sabine, {}, today, 5)).text;
    expect(csvS.split("\r\n")[0]).toContain(";Preis (EUR)");
    expect(csvS).toContain(";900,00");
    const csvK = decodeCsvBytes(await replacementCsv(h.db, await p(KLAUS), {}, today, 5)).text;
    expect(csvK.split("\r\n")[0]).not.toContain("Preis");
    expect(csvK).not.toContain("900,00");
    const entries = await h.db.select().from(auditLog).where(eq(auditLog.action, "gebaeude.replacement.export"));
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(Object.keys((e.meta ?? {}) as object).sort()).toEqual(["count", "horizon"]);
      expect(JSON.stringify(e.meta)).not.toContain("Laptop");
    }
  });
});
