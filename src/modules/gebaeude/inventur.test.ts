// INV-04: Inventur je Raum – Soll beim Start, Erfassen per Etikett/Scan/Eingabe/Knopf, falscher Raum und Übernehmen, Sammelposten,
// Abschluss (offen → fehlt), Rechte (durchführen nur `inventory`/`configure`, lesen auch `view_all`), Protokoll-CSV ohne Namen und
// gegen Formeln entschärft, Historie am Gerät.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, gebaeudeAssetCategories, gebaeudeAssets, gebaeudeInventoryItems, rooms } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ensureLabelCodes } from "@/core/etiketten/service";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { assetHistory } from "./asset-seite";
import { ensureCategories } from "./inventar";
import {
  adoptInventoryItem,
  closeInventory,
  deleteInventory,
  getInventory,
  inventoryCsv,
  inventoryFileName,
  listInventories,
  openInventoriesForAsset,
  roomLabelOf,
  scanAsset,
  scanInput,
  setInventoryItem,
  sortInventoryItems,
  startInventory,
  summarizeInventory,
} from "./inventur";
import { parseScanInput } from "./labels";
import { createAsset, setAssetActive } from "./pruefungen";

const SABINE = "u-sabine.kowalski"; // Verwaltung: configure, view_all
const KLAUS = "u-klaus.berger"; // Hausmeisterei: inventory über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft: report
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

describe("INV-04 (rein)", () => {
  it("Scan-Eingabe: Kurz-URL, Pfad, Raum-Etikett, Text", () => {
    expect(parseScanInput("https://schule.example/i/7K3M9QXZ2HPA4T6W")).toEqual({ kind: "inventar", value: "7K3M9QXZ2HPA4T6W" });
    expect(parseScanInput(" /i/7k3m9qxz2hpa4t6w/ ")).toEqual({ kind: "inventar", value: "7k3m9qxz2hpa4t6w" });
    expect(parseScanInput("https://schule.example/r/7K3M9QXZ2HPA4T6W?x=1")).toEqual({ kind: "raum", value: "7K3M9QXZ2HPA4T6W" });
    expect(parseScanInput("IT-0042")).toEqual({ kind: "text", value: "IT-0042" });
    expect(parseScanInput("https://andere.example/i/kurz")).toEqual({ kind: "text", value: "https://andere.example/i/kurz" });
  });

  it("Zählung, Reihenfolge, Raumtext, Dateiname", () => {
    const items = [
      { expected: true, state: "gefunden" as const, quantity: 10, counted: 7, inventoryNo: "M-0002", name: "Stühle" },
      { expected: true, state: "offen" as const, quantity: 1, counted: null, inventoryNo: "IT-0010", name: "Beamer" },
      { expected: true, state: "fehlt" as const, quantity: 1, counted: null, inventoryNo: "IT-0002", name: "Laptop" },
      { expected: false, state: "falscher_raum" as const, quantity: 1, counted: null, inventoryNo: null, name: "Tablet" },
    ];
    expect(summarizeInventory(items)).toEqual({ expected: 3, done: 2, found: 1, missing: 1, open: 1, wrongRoom: 1, moved: 0, short: 1 });
    expect(sortInventoryItems(items).map((i) => i.name)).toEqual(["Beamer", "Tablet", "Laptop", "Stühle"]);
    expect(roomLabelOf({ id: "112", name: "112", building: "Hauptgebäude" })).toBe("Raum 112 · Hauptgebäude");
    expect(roomLabelOf({ id: "IF1", name: "Informatik 1", building: null })).toBe("IF1 – Informatik 1");
    expect(inventoryFileName("A 1/2", new Date("2026-11-02T10:00:00Z"))).toBe("inventur-A_1_2-2026-11-02");
  });
});

describe("INV-04: Inventur – Service", () => {
  let h: DbHandle;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const cats = new Map<string, string>();
  const cat = (key: string) => cats.get(key)!;
  let beamer: string;
  let laptop: string;
  let stuehle: string;
  let fremd: string;
  let alt: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    await ensureCategories(h.db);
    for (const c of await h.db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)) cats.set(c.key, c.id);
    await h.db.insert(rooms).values([
      { id: "INV1", name: "Inventurraum" },
      { id: "INV2", name: "Nebenraum" },
    ]);
    const klaus = await p(KLAUS);
    beamer = await createAsset(h.db, klaus, { name: "Beamer", categoryId: cat("it"), roomId: "INV1", inventoryNo: "IT-9001" }, today);
    laptop = await createAsset(h.db, klaus, { name: "Laptop", categoryId: cat("it"), roomId: "INV1", inventoryNo: "IT-9002" }, today);
    stuehle = await createAsset(h.db, klaus, { name: "=HYPERLINK(\"x\")", categoryId: cat("moebel"), roomId: "INV1", inventoryNo: "MOE-9001", quantity: 10 }, today);
    fremd = await createAsset(h.db, klaus, { name: "Tablet", categoryId: cat("it"), roomId: "INV2", inventoryNo: "IT-9003" }, today);
    alt = await createAsset(h.db, klaus, { name: "Alter Drucker", categoryId: cat("it"), roomId: "INV1", inventoryNo: "IT-9004" }, today);
    await setAssetActive(h.db, klaus, alt, false, today, "defekt");
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("Rechte: durchführen nur mit inventory/configure, lesen auch mit view_all; Lehrkraft und Schülerin nichts", async () => {
    const [jana, lea, sabine] = await Promise.all([p(JANA), p(LEA), p(SABINE)]);
    await expect(startInventory(h.db, jana, "INV1")).rejects.toThrow(ForbiddenError);
    await expect(startInventory(h.db, lea, "INV1")).rejects.toThrow(ForbiddenError);
    await expect(listInventories(h.db, jana)).rejects.toThrow(ForbiddenError);
    expect(await listInventories(h.db, sabine)).toEqual([]);
    expect(await fieldErrors(startInventory(h.db, await p(KLAUS), ""))).toEqual({ roomId: "Raum wählen" });
    expect(await fieldErrors(startInventory(h.db, await p(KLAUS), "gibtsnicht"))).toEqual({ roomId: "Raum gibt es nicht" });
  });

  it("ganzer Ablauf: Soll beim Start, Etikett, Eingabe, falscher Raum, Sammelposten, Übernehmen, Abschluss, Protokoll", async () => {
    const [klaus, jana, sabine] = await Promise.all([p(KLAUS), p(JANA), p(SABINE)]);
    const { id, existing } = await startInventory(h.db, klaus, "INV1");
    expect(existing).toBe(false);
    // je Raum nur eine laufende
    expect(await startInventory(h.db, klaus, "INV1")).toEqual({ id, existing: true });
    let inv = (await getInventory(h.db, klaus, id))!;
    expect(inv.roomLabel).toBe("INV1 – Inventurraum");
    // Soll: aktives Inventar des Raums, ohne Ausgemustertes
    expect(inv.items.map((i) => i.name).sort()).toEqual(["=HYPERLINK(\"x\")", "Beamer", "Laptop"]);
    expect(inv.summary).toMatchObject({ expected: 3, done: 0, open: 3 });

    // Etikett (Geräteseite) – zweimal: beim zweiten Mal „schon erfasst“
    const r1 = await scanAsset(h.db, klaus, id, beamer, "etikett");
    expect(r1).toMatchObject({ state: "gefunden", already: false });
    expect((await scanAsset(h.db, klaus, id, beamer, "etikett")).already).toBe(true);
    await expect(scanAsset(h.db, jana, id, beamer, "etikett")).rejects.toThrow(ForbiddenError);

    // Eingabe: Kurz-URL eines Inventar-Etiketts bzw. Inventarnummer (Groß-/Kleinschreibung egal)
    const { codes } = await ensureLabelCodes(h.db, "inventar", [fremd]);
    const wrong = await scanInput(h.db, klaus, id, `https://schule.example/i/${codes.get(fremd)}`);
    expect(wrong).toMatchObject({ state: "falscher_raum", homeRoomId: "INV2", name: "Tablet" });
    expect(await scanInput(h.db, klaus, id, "it-9002")).toMatchObject({ state: "gefunden", name: "Laptop" });
    expect(await fieldErrors(scanInput(h.db, klaus, id, "gibt-es-nicht"))).toEqual({ code: "Kein Inventar zu diesem Code bzw. dieser Nummer" });
    expect(await fieldErrors(scanInput(h.db, klaus, id, "https://schule.example/r/7K3M9QXZ2HPA4T6W"))).toEqual({ code: "Das ist ein Raum-Etikett, kein Inventar-Etikett" });
    expect(await fieldErrors(scanInput(h.db, klaus, id, "  "))).toEqual({ code: "Code oder Inventarnummer eingeben" });
    expect(await fieldErrors(scanInput(h.db, klaus, id, "IT-9004"))).toEqual({ code: "Alter Drucker ist ausgemustert – bitte im Inventar prüfen" });

    // Geräteseite: laufende Inventuren, die im Raum des Geräts zuerst; ohne Recht nichts
    await startInventory(h.db, klaus, "INV2");
    const opts = await openInventoriesForAsset(h.db, klaus, { id: fremd, roomId: "INV2" });
    expect(opts.map((o) => [o.roomId, o.sameRoom, o.state])).toEqual([
      ["INV2", true, "offen"],
      ["INV1", false, "falscher_raum"],
    ]);
    expect(await openInventoriesForAsset(h.db, jana, { id: fremd, roomId: "INV2" })).toEqual([]);

    // Sammelposten: gezählt 7 von 10; ungültige Menge; 0 = fehlt; Knopf an Fremdgerät nur „zurücknehmen“
    inv = (await getInventory(h.db, klaus, id))!;
    const chairs = inv.items.find((i) => i.assetId === stuehle)!;
    expect(await fieldErrors(setInventoryItem(h.db, klaus, chairs.id, "gefunden", "-1"))).toEqual({ counted: "Gezählte Menge: ganze Zahl ab 0" });
    await setInventoryItem(h.db, klaus, chairs.id, "gefunden", "0");
    expect((await h.db.select().from(gebaeudeInventoryItems).where(eq(gebaeudeInventoryItems.id, chairs.id)))[0]).toMatchObject({ state: "fehlt", counted: 0 });
    await setInventoryItem(h.db, klaus, chairs.id, "gefunden", "7");
    const tablet = inv.items.find((i) => i.assetId === fremd)!;
    expect(await fieldErrors(setInventoryItem(h.db, klaus, tablet.id, "gefunden"))).toEqual({ state: "Gerät aus einem anderen Raum: übernehmen oder zurücksetzen" });
    await expect(setInventoryItem(h.db, jana, chairs.id, "fehlt")).rejects.toThrow(ForbiddenError);

    // Übernehmen: Gerät zieht in den Inventurraum (Umzug mit Audit), Posten „umgezogen“
    await adoptInventoryItem(h.db, klaus, tablet.id);
    expect((await h.db.select({ roomId: gebaeudeAssets.roomId }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, fremd)))[0]!.roomId).toBe("INV1");
    inv = (await getInventory(h.db, klaus, id))!;
    expect(inv.summary).toMatchObject({ expected: 3, done: 3, found: 3, moved: 1, short: 1, open: 0 });
    const hist = await assetHistory(h.db, klaus, fremd);
    expect(hist.slice(0, 3).map((e) => [e.label, e.detail])).toEqual([
      ["Inventur: Gerät erfasst", "umgezogen · Inventur Raum INV1"],
      ["Inventar-Standort geändert", "Raum INV2 → Raum INV1"],
      ["Inventur: Gerät erfasst", "falscher Raum · Inventur Raum INV1"],
    ]);

    // Zurücksetzen, dann Abschluss: Offenes wird „fehlt“
    const lap = inv.items.find((i) => i.assetId === laptop)!;
    await setInventoryItem(h.db, klaus, lap.id, "offen");
    await expect(closeInventory(h.db, jana, id)).rejects.toThrow(ForbiddenError);
    const sum = await closeInventory(h.db, klaus, id);
    expect(sum).toMatchObject({ expected: 3, found: 2, missing: 1, open: 0 });
    expect(await fieldErrors(scanAsset(h.db, klaus, id, laptop, "etikett"))).toEqual({ inventory: "Die Inventur ist abgeschlossen" });
    expect(await fieldErrors(closeInventory(h.db, klaus, id))).toEqual({ inventory: "Die Inventur ist abgeschlossen" });
    // danach lässt sich im Raum neu beginnen
    const again = await startInventory(h.db, klaus, "INV1");
    expect(again.existing).toBe(false);
    await deleteInventory(h.db, klaus, again.id); // laufende abbrechen: wer durchführt

    // Protokoll: lesen auch mit view_all; CSV ohne Namen, Formel entschärft
    expect((await getInventory(h.db, sabine, id))!.closedAt).not.toBeNull();
    const csv = (await inventoryCsv(h.db, sabine, id))!;
    expect(csv.filename).toMatch(/^inventur-INV1-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.body).toContain("Inventarnummer;Bezeichnung;Kategorie;im Soll;Soll-Menge;Ist-Menge;Stand");
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.body).toContain("IT-9002;Laptop;");
    expect(csv.body).toMatch(/IT-9002;Laptop;[^;]+;ja;1;0;fehlt/);
    expect(csv.body).toMatch(/IT-9003;Tablet;[^;]+;nein;1;1;umgezogen;INV2/);
    expect(csv.body).not.toMatch(/Klaus|Berger/);
    await expect(inventoryCsv(h.db, jana, id)).rejects.toThrow(ForbiddenError);

    // abgeschlossene Protokolle löscht nur configure
    await expect(deleteInventory(h.db, klaus, id)).rejects.toThrow(ForbiddenError);
    await deleteInventory(h.db, sabine, id);
    expect(await getInventory(h.db, sabine, id)).toBeNull();

    // Audit ohne Personen in den Daten: Start/Abschluss/Löschen mit Ziel = Inventur
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.target, id))).map((a) => a.action).sort();
    expect(actions).toEqual(["gebaeude.inventory.close", "gebaeude.inventory.delete", "gebaeude.inventory.start"]);
  });

  it("Gerät nach dem Start in den Raum gezogen: gefunden, nicht im Soll; eigener Fund lässt sich zurücknehmen", async () => {
    const klaus = await p(KLAUS);
    const neu = await createAsset(h.db, klaus, { name: "Leeres Regal", categoryId: cat("moebel"), roomId: "INV2", inventoryNo: "MOE-9002" }, today);
    const open = (await listInventories(h.db, klaus, { openOnly: true })).find((i) => i.roomId === "INV2")!;
    const r = await scanAsset(h.db, klaus, open.id, neu, "scan");
    expect(r.state).toBe("gefunden");
    const item = (await getInventory(h.db, klaus, open.id))!.items.find((i) => i.assetId === neu)!;
    expect(item.expected).toBe(false);
    await setInventoryItem(h.db, klaus, item.id, "offen");
    expect((await getInventory(h.db, klaus, open.id))!.items.find((i) => i.assetId === neu)).toBeUndefined();
  });
});
