// INV-03: Asset-Seite – Zustand/Standort per Knopf (Rechte, Audit), Fotos (verkleinert, ohne Metadaten, Grenze, Sichtbarkeit,
// Löschen mit dem Inventargut), Historie aus dem Audit, Meldungen mit `asset_id` (Vorbelegung des Standorts, ausgemustert,
// Sichtbarkeit, Zählung offener) und Mängel aus Prüfungen mit Gerätebezug.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { gebaeudeAssetCategories, gebaeudeAssetPhotos, gebaeudeAssets, gebaeudeInspections, gebaeudeTickets, groupMembers, groups } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { rasterSize } from "@/core/images";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { referencedStorageKeys } from "@/core/privacy/dateispeicher";
import { toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { addAssetPhoto, assetHistory, assetPhotoFile, deleteAssetPhoto, listAssetPhotos, moveAsset, setAssetCondition } from "./asset-seite";
import { ensureCategories, updateCategory } from "./inventar";
import { ASSET_PHOTOS_MAX, ticketCategoryForAsset } from "./labels";
import { createAsset, deleteAsset, getAsset, recordInspection, setAssetActive } from "./pruefungen";
import { createTicket, getTicket, listTickets, openTicketCountForAsset } from "./service";

const SABINE = "u-sabine.kowalski"; // Verwaltung: configure, manage, view_all
const KLAUS = "u-klaus.berger"; // Hausmeisterei: inventory + manage über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft: report; im Test Mitglied der verantwortlichen Gruppe für IT
const FRANK = "u-frank.schulte"; // Lehrkraft: nur report
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

/** Echtes JPEG mit EXIF (Name, GPS-Angabe). */
async function jpegWithExif(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 60, g: 120, b: 180 } } })
    .withExif({ IFD0: { Artist: "Max Mustermann", ImageDescription: "Aufnahmeort Lindenhof" }, IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" } })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}
const contains = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));

describe("INV-03 (rein)", () => {
  it("Meldungskategorie je Inventar-Kategorie", () => {
    expect(ticketCategoryForAsset("it")).toBe("it");
    expect(ticketCategoryForAsset("praesentation")).toBe("it");
    expect(ticketCategoryForAsset("aufzug")).toBe("technik");
    expect(ticketCategoryForAsset("feuerloescher")).toBe("sicherheit");
    expect(ticketCategoryForAsset("moebel")).toBe("gebaeude");
    expect(ticketCategoryForAsset(null)).toBe("gebaeude");
  });
});

describe("INV-03: Asset-Seite – Service", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const stored = async (key: string) => new Uint8Array(await new Response(await storage.get(key)).arrayBuffer());
  const storedKeys = async () => (await storage.list()).map((f) => f.key);
  const cats = new Map<string, string>();
  const cat = (key: string) => cats.get(key)!;
  const GROUP = "g-inv03-it";
  let laptop: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-inv03-"));
    storage = localStorage(dir);
    await ensureCategories(h.db);
    for (const c of await h.db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)) cats.set(c.key, c.id);
    await h.db.insert(groups).values({ id: GROUP, name: "IT-Team", slug: "it-team-inv03", kind: "frei" });
    await h.db.insert(groupMembers).values({ groupId: GROUP, userId: JANA });
    await updateCategory(h.db, await p(SABINE), cat("it"), { name: "IT", prefix: "IT", inspectionRequired: false, responsibleGroupId: GROUP, sortOrder: 100, active: true });
    laptop = await createAsset(h.db, await p(KLAUS), { name: "Laptop Lehrerzimmer", categoryId: cat("it"), roomId: "205", inventoryNo: null, condition: "gut" }, today);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Zustand und Standort per Knopf: Pflegende der Kategorie ja, Lehrkraft/Schülerin nein; Audit vorher/nachher; ausgemustert gesperrt", async () => {
    const [klaus, jana, frank, lea] = await Promise.all([p(KLAUS), p(JANA), p(FRANK), p(LEA)]);
    await setAssetCondition(h.db, jana, laptop, "defekt"); // verantwortliche Gruppe der Kategorie IT
    await expect(setAssetCondition(h.db, frank, laptop, "gut")).rejects.toThrow(ForbiddenError);
    await expect(setAssetCondition(h.db, lea, laptop, "gut")).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(setAssetCondition(h.db, klaus, laptop, "kaputt"))).toEqual({ condition: "Zustand wählen" });
    await moveAsset(h.db, klaus, laptop, "IF1");
    await expect(moveAsset(h.db, frank, laptop, "205")).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(moveAsset(h.db, klaus, laptop, "gibtsnicht"))).toEqual({ roomId: "Raum gibt es nicht" });
    expect(await fieldErrors(moveAsset(h.db, klaus, laptop, ""))).toEqual({ roomId: "Raum wählen" });
    const [a] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.id, laptop));
    expect(a).toMatchObject({ condition: "defekt", roomId: "IF1", buildingId: null, floorId: null });
    // gleicher Wert: kein weiterer Audit-Eintrag
    await setAssetCondition(h.db, klaus, laptop, "defekt");
    const hist = await assetHistory(h.db, klaus, laptop);
    expect(hist.map((e) => [e.label, e.detail])).toEqual([
      ["Inventar-Standort geändert", "Raum 205 → Raum IF1"],
      ["Inventar-Zustand geändert", "gut → defekt"],
      ["Inventar angelegt", null],
    ]);
    expect(hist[1]!.actor).toBe("Jana Brandt");
    // Historie nur mit voller Sicht
    await expect(assetHistory(h.db, frank, laptop)).rejects.toThrow(ForbiddenError);
    // ausgemustert: keine Schnellaktionen
    const tmp = await createAsset(h.db, klaus, { name: "Alter Drucker", categoryId: cat("it"), roomId: "205", inventoryNo: null }, today);
    await setAssetActive(h.db, klaus, tmp, false, today, "defekt");
    expect(await fieldErrors(setAssetCondition(h.db, klaus, tmp, "gut"))).toEqual({ condition: "Das Gerät ist ausgemustert" });
    expect(await fieldErrors(moveAsset(h.db, klaus, tmp, "IF1"))).toEqual({ roomId: "Das Gerät ist ausgemustert" });
  });

  it("Fotos: verkleinert, ohne Metadaten, mit Vorschau; Grenze je Gerät; nur volle Sicht; Löschen räumt Dateien; Löschen des Guts nimmt sie mit", async () => {
    const [klaus, sabine, frank, lea, jana] = await Promise.all([p(KLAUS), p(SABINE), p(FRANK), p(LEA), p(JANA)]);
    await expect(addAssetPhoto(h.db, storage, frank, laptop, await jpegWithExif(100, 80))).rejects.toThrow(ForbiddenError);
    const id = await addAssetPhoto(h.db, storage, klaus, laptop, await jpegWithExif(3200, 2400));
    const [row] = await h.db.select().from(gebaeudeAssetPhotos).where(eq(gebaeudeAssetPhotos.id, id));
    expect(row).toMatchObject({ assetId: laptop, mime: "image/jpeg", width: 1600, height: 1200 });
    const full = await stored(row!.storageKey);
    const thumb = await stored(row!.thumbKey);
    expect(rasterSize(full, "image/jpeg")).toEqual({ width: 1600, height: 1200 });
    expect(rasterSize(thumb, "image/jpeg")).toEqual({ width: 480, height: 360 });
    expect(contains(full, "Mustermann") || contains(full, "Lindenhof")).toBe(false);
    // Dateispeicher kennt die Schlüssel (Aufräumlauf löscht sie nicht)
    const keys = await referencedStorageKeys(h.db);
    expect(keys.has(row!.storageKey) && keys.has(row!.thumbKey)).toBe(true);
    // Sichtbarkeit: volle Sicht (view_all, Pflegende) ja, eingeschränkte Sicht nein
    expect((await listAssetPhotos(h.db, sabine, laptop)).map((x) => x.id)).toEqual([id]);
    expect((await listAssetPhotos(h.db, jana, laptop)).map((x) => x.id)).toEqual([id]);
    expect(await listAssetPhotos(h.db, frank, laptop)).toEqual([]);
    expect(await assetPhotoFile(h.db, frank, id, false)).toBeNull();
    expect(await assetPhotoFile(h.db, lea, id, true)).toBeNull();
    expect(await assetPhotoFile(h.db, sabine, id, true)).toEqual({ key: row!.thumbKey, mime: "image/jpeg" });
    // Typ an den Bytes
    expect(await fieldErrors(addAssetPhoto(h.db, storage, klaus, laptop, new TextEncoder().encode("kein Bild")))).toHaveProperty("photo");
    // Grenze
    for (let i = 1; i < ASSET_PHOTOS_MAX; i++) await addAssetPhoto(h.db, storage, klaus, laptop, await jpegWithExif(40, 30));
    expect(await fieldErrors(addAssetPhoto(h.db, storage, klaus, laptop, await jpegWithExif(40, 30)))).toEqual({ photo: `Höchstens ${ASSET_PHOTOS_MAX} Fotos je Gerät – erst ein Foto löschen` });
    // Löschen: nur Pflegende, Dateien weg
    await expect(deleteAssetPhoto(h.db, storage, frank, id)).rejects.toThrow(ForbiddenError);
    expect(await deleteAssetPhoto(h.db, storage, klaus, id)).toBe(laptop);
    expect(await storedKeys()).not.toContain(row!.storageKey);
    expect(await storedKeys()).not.toContain(row!.thumbKey);
    expect((await assetHistory(h.db, klaus, laptop)).slice(0, 2).map((e) => e.label)).toEqual(["Inventar-Foto gelöscht", "Inventar-Foto hinzugefügt"]);
    // Inventargut endgültig löschen → Fotos (Zeilen und Dateien) gehen mit
    const tmp = await createAsset(h.db, klaus, { name: "Altgerät", categoryId: cat("it"), roomId: null, inventoryNo: null }, today);
    const ph = await addAssetPhoto(h.db, storage, klaus, tmp, await jpegWithExif(40, 30));
    const [phRow] = await h.db.select().from(gebaeudeAssetPhotos).where(eq(gebaeudeAssetPhotos.id, ph));
    await setAssetActive(h.db, klaus, tmp, false, today);
    await deleteAsset(h.db, sabine, tmp, storage);
    expect(await h.db.select().from(gebaeudeAssetPhotos).where(eq(gebaeudeAssetPhotos.assetId, tmp))).toEqual([]);
    expect(await storedKeys()).not.toContain(phRow!.storageKey);
  });

  it("Mangel melden mit Gerätebezug: Standort aus dem Gerät, Bezug in der Meldung, Zählung offener; ausgemustert/unbekannt abgelehnt", async () => {
    const [klaus, sabine, frank, jana] = await Promise.all([p(KLAUS), p(SABINE), p(FRANK), p(JANA)]);
    // Gerät ohne Raum, mit Gebäude → Ort aus Gebäude; Gerät mit Raum → Raum
    const base = { category: "it", priority: "normal", roomId: null, location: null, description: "", photos: [] as Uint8Array[] };
    const t1 = await createTicket(h.db, storage, frank, { ...base, title: "Laptop startet nicht", assetId: laptop });
    const [row] = await h.db.select().from(gebaeudeTickets).where(eq(gebaeudeTickets.id, t1.id));
    expect(row).toMatchObject({ assetId: laptop, roomId: "IF1", location: null, reporterId: FRANK });
    const detail = (await getTicket(h.db, frank, t1.id))!;
    expect(detail.ticket).toMatchObject({ assetId: laptop, assetName: "Laptop Lehrerzimmer" });
    // Raum von Hand gewählt hat Vorrang
    const t2 = await createTicket(h.db, storage, jana, { ...base, roomId: "205", title: "Laptop Akku", assetId: laptop });
    expect((await h.db.select({ roomId: gebaeudeTickets.roomId }).from(gebaeudeTickets).where(eq(gebaeudeTickets.id, t2.id)))[0]!.roomId).toBe("205");
    expect(await openTicketCountForAsset(h.db, laptop)).toBe(2);
    // Sichtbarkeit: view_all alle Meldungen zum Gerät, Lehrkraft nur die eigenen
    expect((await listTickets(h.db, sabine, { assetId: laptop })).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect((await listTickets(h.db, frank, { assetId: laptop })).map((t) => t.id)).toEqual([t1.id]);
    // eingeschränkte Asset-Seite (inv-5) für Lehrkraft ohne Pflegerecht
    const view = (await getAsset(h.db, frank, laptop))!;
    expect(view.full).toBe(false);
    expect(view.asset).not.toHaveProperty("serial");
    expect(view.asset).not.toHaveProperty("inventoryNo");
    // unbekannt bzw. ausgemustert
    expect(await fieldErrors(createTicket(h.db, storage, frank, { ...base, title: "Geht nicht", assetId: "gibtsnicht" }))).toMatchObject({ assetId: "Gerät gibt es nicht" });
    const old = await createAsset(h.db, klaus, { name: "Alter Beamer", categoryId: cat("praesentation"), roomId: "106", inventoryNo: null }, today);
    await setAssetActive(h.db, klaus, old, false, today);
    expect(await fieldErrors(createTicket(h.db, storage, frank, { ...base, title: "Geht nicht", assetId: old }))).toMatchObject({ assetId: "Das Gerät ist ausgemustert" });
    // Löschen des Guts lässt die Meldung stehen (ohne Bezug)
    const gone = await createAsset(h.db, klaus, { name: "Wegwerf-Maus", categoryId: cat("it"), roomId: "IF1", inventoryNo: null }, today);
    const t3 = await createTicket(h.db, storage, frank, { ...base, title: "Maus klemmt", assetId: gone });
    await setAssetActive(h.db, klaus, gone, false, today);
    await deleteAsset(h.db, sabine, gone, storage);
    expect((await h.db.select({ assetId: gebaeudeTickets.assetId }).from(gebaeudeTickets).where(eq(gebaeudeTickets.id, t3.id)))[0]!.assetId).toBeNull();
  });

  it("Mangel aus einer Prüfung trägt den Gerätebezug", async () => {
    const klaus = await p(KLAUS);
    const [fl] = await h.db.select({ id: gebaeudeAssets.id }).from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "FL-002"));
    const [open] = await h.db
      .select({ id: gebaeudeInspections.id })
      .from(gebaeudeInspections)
      .where(and(eq(gebaeudeInspections.assetId, fl!.id), isNull(gebaeudeInspections.doneOn)));
    const r = await recordInspection(h.db, storage, klaus, open!.id, { doneOn: today, result: "mangel", company: "Prüfdienst", note: "Plombe fehlt" }, { today });
    const [t] = await h.db.select({ assetId: gebaeudeTickets.assetId, category: gebaeudeTickets.category }).from(gebaeudeTickets).where(eq(gebaeudeTickets.id, r.ticketId!));
    expect(t).toEqual({ assetId: fl!.id, category: "sicherheit" });
    expect(await openTicketCountForAsset(h.db, fl!.id)).toBe(1);
  });
});
