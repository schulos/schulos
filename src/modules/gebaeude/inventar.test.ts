// INV-01/INV-02: Kategorien (Vorlage, eigene, verantwortliche Gruppe), Rechte (`gebaeude.inventory` über die Gruppe, Kategorie-
// Verantwortung, Lehrkraft/Schülerin nicht), automatische Inventarnummern (Zähler je Präfix, Formate, belegte Nummern
// überspringen), Ändern/Ausmustern/Löschen, CSV mit neuen Spalten und Auto-Nummer, Etiketten (`/i/<code>`, Rechte, Neuerzeugen).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { gebaeudeAssetCategories, gebaeudeAssets, gebaeudeInspections, groupMembers, groups, labelCodes } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { LABEL_FORMATS, LABEL_KINDS, labelFormat, labelPath, labelsPerPage } from "@/core/etiketten/codes";
import { resolveLabelCode } from "@/core/etiketten/service";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { assetCode, canPrintLabels, inventoryLabels, printableAssets, renewAssetCode } from "./etiketten";
import { canSeeInventory, createCategory, deleteCategory, ensureCategories, listCategories, maintainableCategories, nextInventoryNo, updateCategory } from "./inventar";
import { ASSET_CATEGORY_TEMPLATE, categoryKeyFromName, matchCategory } from "./kategorien";
import { formatInventoryNo, inventoryCounterKey, parsePriceCents } from "./labels";
import { createAsset, deleteAsset, getAsset, importAssets, listAssets, listInspectionTypes, setAssetActive, updateAsset, updateInspectionType } from "./pruefungen";
import { INVENTORY_NO_FORMAT } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: configure
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.inventory über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft, im Test Mitglied der Gruppe „IT-Team“ (verantwortlich für die Kategorie IT)
const LEA = "u-lea.schaefer"; // Schülerin

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Inventar (rein)", () => {
  it("Vorlage: eindeutige Schlüssel und Präfixe, die alten Enum-Werte bleiben; Kurzformen und Namen werden erkannt", () => {
    expect(new Set(ASSET_CATEGORY_TEMPLATE.map((t) => t.key)).size).toBe(ASSET_CATEGORY_TEMPLATE.length);
    expect(new Set(ASSET_CATEGORY_TEMPLATE.map((t) => t.prefix)).size).toBe(ASSET_CATEGORY_TEMPLATE.length);
    for (const k of ["elektro_ortsveraenderlich", "feuerloescher", "spielgeraet", "sportgeraet", "aufzug", "tor_tuer", "leiter", "erste_hilfe", "lueftung", "sonstiges"])
      expect(ASSET_CATEGORY_TEMPLATE.some((t) => t.key === k)).toBe(true);
    const cats = ASSET_CATEGORY_TEMPLATE.map((t) => ({ id: t.key, key: t.key, name: t.name, prefix: t.prefix }));
    expect(matchCategory("Feuerlöscher", cats)?.key).toBe("feuerloescher");
    expect(matchCategory("it", cats)?.key).toBe("it");
    expect(matchCategory("IT (Laptops, Tablets, PCs, Drucker, Server, Netzwerk, USV)", cats)?.key).toBe("it");
    expect(matchCategory("MO", cats)?.key).toBe("moebel");
    expect(matchCategory("Verbandkasten", cats)?.key).toBe("erste_hilfe");
    expect(matchCategory("Rakete", cats)).toBeNull();
    expect(categoryKeyFromName("Robotik-Koffer (Fördermittel)")).toBe("robotik-koffer-foerdermittel");
  });

  it("Inventarnummern: Formate und Zählerschlüssel; Preis in Cent", () => {
    expect(formatInventoryNo("prefix-4", "IT", 7, 2026)).toBe("IT-0007");
    expect(formatInventoryNo("prefix-year-4", "IT", 7, 2026)).toBe("IT-2026-0007");
    expect(formatInventoryNo("prefix-6", "IT", 12345, 2026)).toBe("IT-012345");
    expect(inventoryCounterKey("prefix-4", "IT", 2026)).toBe("IT");
    expect(inventoryCounterKey("prefix-year-4", "IT", 2026)).toBe("IT:2026");
    expect(parsePriceCents("1.234,56")).toBe(123456);
    expect(parsePriceCents("1234.5")).toBe(123450);
    expect(parsePriceCents("12 €")).toBe(1200);
    expect(parsePriceCents("")).toBeNull();
    expect(parsePriceCents("abc")).toBeNaN();
  });

  it("Etiketten: Art „inventar“ mit Kurz-URL /i/, Formate mit Etiketten je Blatt", () => {
    expect(LABEL_KINDS).toContain("inventar");
    expect(labelPath("inventar", "7K3M9QXZ2HPA4T6W")).toBe("/i/7K3M9QXZ2HPA4T6W");
    expect(labelsPerPage("bogen-3x8")).toBe(24);
    expect(labelsPerPage("bogen-4x13")).toBe(52);
    expect(labelsPerPage("rolle-62")).toBe(1);
    expect(LABEL_FORMATS["bogen-3x8"].cols * LABEL_FORMATS["bogen-3x8"].widthMm).toBeLessThanOrEqual(210);
    expect(LABEL_FORMATS["bogen-4x13"].topMm + 13 * LABEL_FORMATS["bogen-4x13"].heightMm).toBeLessThanOrEqual(297);
    expect(labelFormat("rolle-62")).toBe("rolle-62");
    expect(labelFormat("quatsch")).toBe("bogen-3x8");
  });
});

describe("Inventar – Service", () => {
  let h: DbHandle;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const cats = new Map<string, string>();
  const cat = (key: string) => cats.get(key)!;
  const GROUP = "g-e2e-it-team";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await ensureCategories(h.db);
    for (const c of await h.db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)) cats.set(c.key, c.id);
    await h.db.insert(groups).values({ id: GROUP, name: "IT-Team", slug: "it-team", kind: "frei" });
    await h.db.insert(groupMembers).values({ groupId: GROUP, userId: JANA });
  }, 60_000);
  afterAll(() => h.close());

  it("Vorlage idempotent, Demo-Anlagen tragen Kategorien; Kategorie anlegen/ändern/löschen nur mit configure", async () => {
    await ensureCategories(h.db);
    const list = await listCategories(h.db);
    expect(list.filter((c) => ASSET_CATEGORY_TEMPLATE.some((t) => t.key === c.key))).toHaveLength(ASSET_CATEGORY_TEMPLATE.length);
    expect(list.find((c) => c.key === "feuerloescher")!.assetCount).toBeGreaterThanOrEqual(2);
    const [sabine, klaus] = await Promise.all([p(SABINE), p(KLAUS)]);
    const input = { name: "Robotik-Koffer", prefix: "rb", inspectionRequired: false, responsibleGroupId: null, sortOrder: 500, active: true };
    await expect(createCategory(h.db, klaus, input)).rejects.toThrow(ForbiddenError);
    const id = await createCategory(h.db, sabine, input);
    const own = (await listCategories(h.db)).find((c) => c.id === id)!;
    expect(own).toMatchObject({ key: "robotik-koffer", prefix: "RB" });
    expect(await fieldErrors(createCategory(h.db, sabine, { ...input, name: "robotik-koffer" }))).toEqual({ name: "Diese Kategorie gibt es schon" });
    expect(await fieldErrors(createCategory(h.db, sabine, { ...input, name: "X", prefix: "zu-lang!" }))).toMatchObject({ name: expect.any(String), prefix: expect.any(String) });
    await updateCategory(h.db, sabine, id, { ...input, name: "Robotik", responsibleGroupId: GROUP });
    expect((await listCategories(h.db)).find((c) => c.id === id)).toMatchObject({ name: "Robotik", responsibleGroupName: "IT-Team" });
    // Vorlage nur ausschalten, eigene ohne Inventar löschen
    expect(await fieldErrors(deleteCategory(h.db, sabine, cat("moebel")))).toEqual({ name: "Kategorien der Vorlage lassen sich nur ausschalten" });
    await deleteCategory(h.db, sabine, id);
    expect((await listCategories(h.db)).some((c) => c.id === id)).toBe(false);
  });

  it("Rechte: inventory über die Gruppe (Hausmeisterei) pflegt alles; verantwortliche Gruppe nur ihre Kategorie; Lehrkraft/Schülerin nichts", async () => {
    const [sabine, klaus, jana, lea] = await Promise.all([p(SABINE), p(KLAUS), p(JANA), p(LEA)]);
    expect(await maintainableCategories(h.db, sabine)).toBeNull();
    expect(await maintainableCategories(h.db, klaus)).toBeNull();
    expect((await maintainableCategories(h.db, jana))!.size).toBe(0);
    expect(await canSeeInventory(h.db, jana)).toBe(false);
    expect(await canSeeInventory(h.db, lea)).toBe(false);
    await expect(listAssets(h.db, jana)).rejects.toThrow(ForbiddenError);
    // IT-Team wird verantwortlich für IT → Jana sieht und pflegt nur IT
    await updateCategory(h.db, sabine, cat("it"), { name: "IT", prefix: "IT", inspectionRequired: false, responsibleGroupId: GROUP, sortOrder: 100, active: true });
    expect([...(await maintainableCategories(h.db, jana))!]).toEqual([cat("it")]);
    expect(await canSeeInventory(h.db, jana)).toBe(true);
    const mine = await listAssets(h.db, jana);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.categoryId === cat("it"))).toBe(true);
    const id = await createAsset(h.db, jana, { name: "Laptop Lehrerzimmer", categoryId: cat("it"), roomId: null, inventoryNo: null, condition: "neu", price: "899,00" }, today);
    await expect(createAsset(h.db, jana, { name: "Leiter", categoryId: cat("leiter"), roomId: null, inventoryNo: null }, today)).rejects.toThrow(ForbiddenError);
    await expect(createAsset(h.db, lea, { name: "Laptop", categoryId: cat("it"), roomId: null, inventoryNo: null }, today)).rejects.toThrow(ForbiddenError);
    // Kategoriewechsel aus der eigenen Kategorie heraus braucht beide Rechte
    await expect(updateAsset(h.db, jana, id, { name: "Laptop", categoryId: cat("leiter"), roomId: null, inventoryNo: null }, today)).rejects.toThrow(ForbiddenError);
    // Asset-Seite: volle Sicht für Pflegende, eingeschränkt für andere Angemeldete (inv-5)
    const full = (await getAsset(h.db, jana, id))!;
    expect(full.full).toBe(true);
    expect(full.maintain).toBe(true);
    if (full.full) expect(full.asset.priceCents).toBe(89900);
    const fl = (await listAssets(h.db, sabine)).find((a) => a.inventoryNo === "FL-002")!;
    const limited = (await getAsset(h.db, jana, fl.id))!;
    expect(limited.full).toBe(false);
    expect(limited.maintain).toBe(false);
    expect(Object.keys(limited.asset)).not.toContain("serial");
    expect(Object.keys(limited.asset)).not.toContain("priceCents");
    expect(limited.asset).toMatchObject({ name: "Feuerlöscher Chemie", roomId: "NW2" });
    expect((await getAsset(h.db, lea, fl.id))!.full).toBe(false);
    expect(await getAsset(h.db, lea, "gibtsnicht")).toBeNull();
    // Hausmeisterei pflegt alles (Gruppenrecht), auch IT
    await updateAsset(h.db, klaus, id, { name: "Laptop Lehrerzimmer 2", categoryId: cat("it"), roomId: "IF1", inventoryNo: null, quantity: "1" }, today);
    expect((await getAsset(h.db, klaus, id))!.asset.name).toBe("Laptop Lehrerzimmer 2");
  });

  it("Automatische Inventarnummern: Zähler je Präfix, belegte Nummern übersprungen, Format mit Jahr, von Hand vergebene bleiben", async () => {
    const sabine = await p(SABINE);
    // Demo hat IT-0001 von Hand → der Zähler überspringt sie
    const a = await createAsset(h.db, sabine, { name: "Tablet A", categoryId: cat("it"), roomId: null, inventoryNo: null }, today);
    const b = await createAsset(h.db, sabine, { name: "Tablet B", categoryId: cat("it"), roomId: null, inventoryNo: null }, today);
    const nos = (await h.db.select({ id: gebaeudeAssets.id, inventoryNo: gebaeudeAssets.inventoryNo }).from(gebaeudeAssets)).filter((x) => [a, b].includes(x.id)).map((x) => x.inventoryNo);
    expect(nos).not.toContain("IT-0001");
    expect(nos.every((n) => /^IT-\d{4}$/.test(n!))).toBe(true);
    expect(new Set(nos).size).toBe(2);
    // ohne Zähler-Lücken: nächste Nummer folgt
    const next = await nextInventoryNo(h.db, "IT", "prefix-4", today);
    expect(Number(next.slice(3))).toBe(Math.max(...nos.map((n) => Number(n!.slice(3)))) + 1);
    // Format mit Jahr (Moduleinstellung)
    await writeModuleSetting(h.db, INVENTORY_NO_FORMAT, "prefix-year-4");
    const c = await createAsset(h.db, sabine, { name: "Mikroskop", categoryId: cat("sammlung"), roomId: "NW1", inventoryNo: null, quantity: 12 }, today);
    const [row] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.id, c));
    expect(row!.inventoryNo).toBe(`FS-${today.slice(0, 4)}-0001`);
    expect(row!.quantity).toBe(12);
    await writeModuleSetting(h.db, INVENTORY_NO_FORMAT, "prefix-4");
    // von Hand: bleibt; doppelt: Fehler; Validierung der neuen Felder
    const d = await createAsset(h.db, sabine, { name: "Tische 7b", categoryId: cat("moebel"), roomId: "205", inventoryNo: "TISCHE-7B", quantity: "15", price: "1.500,00", warrantyUntil: "2028-12-31" }, today);
    expect((await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.id, d)))[0]).toMatchObject({ inventoryNo: "TISCHE-7B", quantity: 15, priceCents: 150000, warrantyUntil: "2028-12-31" });
    expect(await fieldErrors(createAsset(h.db, sabine, { name: "Doppelt", categoryId: cat("moebel"), roomId: null, inventoryNo: "TISCHE-7B", quantity: "0", price: "abc", condition: "kaputt", boundUntil: "bald" }, today))).toEqual({
      inventoryNo: "Inventarnummer ist schon vergeben",
      quantity: "Menge 1 bis 9999",
      price: "Preis in Euro, z. B. 1.234,56",
      condition: "Zustand wählen",
      boundUntil: "Datum angeben",
    });
    expect(await fieldErrors(createAsset(h.db, sabine, { name: "Ohne Kategorie", categoryId: "gibtsnicht", roomId: null, inventoryNo: null }, today))).toEqual({ categoryId: "Kategorie wählen" });
  });

  it("Kategoriewechsel räumt fremde offene Prüfungen; Ausmustern blendet aus, Löschen nur ausgemustert und nur mit configure", async () => {
    const [sabine, klaus] = await Promise.all([p(SABINE), p(KLAUS)]);
    const id = await createAsset(h.db, sabine, { name: "Stehleiter Werkraum", categoryId: cat("leiter"), roomId: "KU1", inventoryNo: null }, today);
    const open = async () => (await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.assetId, id))).filter((i) => !i.doneOn).length;
    expect(await open()).toBe(1); // Prüfart „Leitern“ ist in der Demo eingeschaltet
    await updateAsset(h.db, sabine, id, { name: "Stehleiter Werkraum", categoryId: cat("moebel"), roomId: "KU1", inventoryNo: null }, today);
    expect(await open()).toBe(0);
    await updateAsset(h.db, sabine, id, { name: "Stehleiter Werkraum", categoryId: cat("leiter"), roomId: "KU1", inventoryNo: null }, today);
    expect(await open()).toBe(1);
    await setAssetActive(h.db, klaus, id, false, today, "verbogen, entsorgt");
    expect(await open()).toBe(0);
    expect((await listAssets(h.db, sabine)).some((a) => a.id === id)).toBe(false);
    const gone = (await listAssets(h.db, sabine, { inactive: true })).find((a) => a.id === id)!;
    expect(gone).toMatchObject({ active: false, retiredOn: today, retiredReason: "verbogen, entsorgt" });
    await expect(deleteAsset(h.db, klaus, id)).rejects.toThrow(ForbiddenError);
    await setAssetActive(h.db, klaus, id, true, today);
    expect(await fieldErrors(deleteAsset(h.db, sabine, id))).toEqual({ asset: "Nur ausgemustertes Inventar lässt sich löschen" });
    await setAssetActive(h.db, sabine, id, false, today);
    await deleteAsset(h.db, sabine, id);
    expect(await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.id, id))).toHaveLength(0);
  });

  it("CSV-Import: Kategorien nach Name/Präfix/Kurzform, neue Spalten, fehlende Nummern automatisch, verantwortliche Gruppe nur eigene Kategorie", async () => {
    const [sabine, jana] = await Promise.all([p(SABINE), p(JANA)]);
    const csv = "Name;Kategorie;Raum;Inventarnummer;letzte Prüfung;Menge;Hersteller;Modell;Seriennummer\nDrucker Sekretariat;IT;015;;;;Musterwerk;Laser 3;SN-123\nStühle 7b;Möbel;205;;;30;;;\nLeiter Bühne;Leiter;;LE-CSV;01.03.2025;;;;\n";
    expect(await importAssets(h.db, sabine, csv, today)).toEqual({ created: 3, updated: 0 });
    const rows = await listAssets(h.db, sabine, { q: "Drucker Sekretariat" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ categoryKey: "it", manufacturer: "Musterwerk", model: "Laser 3", serial: "SN-123", roomId: "015" });
    expect(rows[0]!.inventoryNo).toMatch(/^IT-\d{4}$/);
    expect((await listAssets(h.db, sabine, { q: "Stühle 7b" }))[0]).toMatchObject({ quantity: 30, categoryKey: "moebel" });
    const [ladder] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "LE-CSV"));
    const insp = await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.assetId, ladder!.id));
    expect(insp.some((i) => i.doneOn === "2025-03-01")).toBe(true);
    // Jana (IT-Team) darf IT importieren, nicht Leitern
    expect(await importAssets(h.db, jana, "Name;Kategorie;Raum\nWLAN Punkt Flur;IT;\n", today)).toEqual({ created: 1, updated: 0 });
    await expect(importAssets(h.db, jana, "Name;Kategorie;Raum\nLeiter Flur;Leiter;\n", today)).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(importAssets(h.db, sabine, "Name;Kategorie;Raum\nDing;Rakete;\n", today))).toEqual({ file: "Zeile 2: Kategorie „Rakete“ unbekannt" });
  });

  it("Prüfart mit Kategorie: Kategorie statt Art, Validierung; Filter der Liste", async () => {
    const sabine = await p(SABINE);
    const types = await listInspectionTypes(h.db);
    const ladder = types.find((t) => t.templateKey === "leitern")!;
    expect(ladder.categoryId).toBe(cat("leiter"));
    expect(ladder.categoryName).toBe("Leiter/Tritt");
    expect(await fieldErrors(updateInspectionType(h.db, sabine, ladder.id, { ...ladder, categoryId: "gibtsnicht" }, today))).toEqual({ categoryId: "Kategorie wählen" });
    const it = await listAssets(h.db, sabine, { categoryId: cat("it") });
    expect(it.length).toBeGreaterThan(0);
    expect(it.every((a) => a.categoryKey === "it")).toBe(true);
    const neu = await listAssets(h.db, sabine, { condition: "neu" });
    expect(neu.every((a) => a.condition === "neu")).toBe(true);
    const inRoom = await listAssets(h.db, sabine, { roomId: "205" });
    expect(inRoom.every((a) => a.roomId === "205")).toBe(true);
    expect(inRoom.some((a) => a.inventoryNo === "MO-0001")).toBe(true);
  });

  it("Etiketten (INV-02): Codes beim Druck, nur pflegbares Inventar, Kurz-URL löst auf, Neuerzeugen entwertet, Löschen räumt den Code", async () => {
    const [sabine, klaus, jana, lea] = await Promise.all([p(SABINE), p(KLAUS), p(JANA), p(LEA)]);
    expect(await canPrintLabels(h.db, lea)).toBe(false);
    expect(await canPrintLabels(h.db, jana)).toBe(true); // IT-Team
    expect(await canPrintLabels(h.db, klaus)).toBe(true);
    const all = await listAssets(h.db, sabine);
    const fl = all.find((a) => a.inventoryNo === "FL-002")!;
    const tab = all.find((a) => a.inventoryNo === "IT-0001")!;
    // Jana darf nur IT drucken – FL-002 fällt still weg
    const janaLabels = await inventoryLabels(h.db, jana, [fl.id, tab.id]);
    expect(janaLabels.map((l) => l.inventoryNo)).toEqual(["IT-0001"]);
    expect(await assetCode(h.db, jana, fl.id, fl.categoryId)).toBeNull();
    const code = janaLabels[0]!.code;
    expect(await assetCode(h.db, jana, tab.id, tab.categoryId)).toBe(code);
    expect(await resolveLabelCode(h.db, "inventar", code)).toBe(tab.id);
    expect(await resolveLabelCode(h.db, "raum", code)).toBeNull();
    // Nachdruck: gleicher Code; Sammeldruck „alle“ nach Filter
    expect((await inventoryLabels(h.db, sabine, [tab.id]))[0]!.code).toBe(code);
    const noLabel = await printableAssets(h.db, sabine, { withoutLabel: true });
    expect(noLabel.some((a) => a.id === tab.id)).toBe(false);
    expect(noLabel.some((a) => a.id === fl.id)).toBe(true);
    const itAll = await inventoryLabels(h.db, sabine, "alle", { categoryId: cat("it") });
    expect(itAll.length).toBeGreaterThan(1);
    expect(itAll.every((l) => /^IT-/.test(l.inventoryNo))).toBe(true);
    // Neuerzeugen: alter Code ungültig, Lehrkraft ohne Verantwortung darf nicht
    await expect(renewAssetCode(h.db, lea, tab.id)).rejects.toThrow(ForbiddenError);
    await expect(renewAssetCode(h.db, jana, fl.id)).rejects.toThrow(ForbiddenError);
    const fresh = await renewAssetCode(h.db, jana, tab.id);
    expect(fresh).not.toBe(code);
    expect(await resolveLabelCode(h.db, "inventar", code)).toBeNull();
    expect(await resolveLabelCode(h.db, "inventar", fresh)).toBe(tab.id);
    expect((await listAssets(h.db, sabine, { withoutLabel: true })).some((a) => a.id === tab.id)).toBe(false);
    // Löschen räumt den Code (Kaskade)
    const tmp = await createAsset(h.db, sabine, { name: "Wegwerf", categoryId: cat("sonstiges"), roomId: null, inventoryNo: null }, today);
    const tmpCode = (await inventoryLabels(h.db, sabine, [tmp]))[0]!.code;
    await setAssetActive(h.db, sabine, tmp, false, today);
    await deleteAsset(h.db, sabine, tmp);
    expect(await h.db.select().from(labelCodes).where(eq(labelCodes.code, tmpCode))).toHaveLength(0);
  });
});
