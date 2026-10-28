// RS-04/RS-05: Fotos und Ausstattungskatalog im Raumsteckbrief (Service-Ebene, Demo-Schule).
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, roomEquipmentItems, roomEquipmentTypes, roomPhotos } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { rasterSize } from "@/core/images";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { referencedStorageKeys } from "@/core/privacy/dateispeicher";
import { listRooms, searchRooms } from "@/modules/stundenplan/raeume";
import {
  DEFAULT_EQUIPMENT_TYPES,
  addRoomEquipment,
  deleteEquipmentType,
  equipmentLabel,
  listEquipmentTypes,
  mergeEquipmentTypes,
  renameEquipmentType,
  roomEquipment,
  setRoomEquipmentQuantities,
} from "./raumausstattung";
import { ROOM_PHOTOS_MAX, addRoomPhoto, coverPhotos, deleteRoomPhoto, listRoomPhotos, photoFile, setCoverPhoto, setPhotoCaption } from "./raumfotos";
import { roomDirectory, roomProfile } from "./raumsteckbrief";
import { ValidationError } from "./users";

const JANA = "u-jana.brandt"; // Lehrkraft
const LEA = "u-lea.schaefer"; // Schülerin
const SABINE = "u-sabine.kowalski"; // Sekretariat: verwaltung.school
const PROFILE = { today: "2027-03-02", monday: "2027-03-01", modules: { stundenplan: false, gebaeude: false, buchungen: false } };

const contains = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));

/** Echtes JPEG mit EXIF (Name, GPS-Angabe) und gewünschter Größe/Ausrichtung. */
async function jpegWithExif(width: number, height: number, orientation = 1): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 60 } } })
    .withExif({ IFD0: { Artist: "Max Mustermann", ImageDescription: "Aufnahmeort Lindenhof" }, IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" } })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("RS-05: Ausstattungskatalog mit Menge je Raum", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Demo-Seed: die acht Vorgaben im Katalog, Räume mit Mengen", async () => {
    const types = await listEquipmentTypes(h.db);
    expect(types.map((t) => t.id).sort()).toEqual(DEFAULT_EQUIPMENT_TYPES.map((t) => t.id).sort());
    expect((await roomEquipment(h.db, "IF1")).map(equipmentLabel)).toEqual(["Beamer", "Lehrer-PC", "26 × Schüler-PCs"]);
  });

  it("Katalog wächst beim Eintragen: neuer Name einmal angelegt, danach für andere Räume wählbar (Groß-/Kleinschreibung egal)", async () => {
    const sabine = await p(SABINE);
    const first = await addRoomEquipment(h.db, sabine, "NW2", { name: "  Lötstation ", quantity: "6" });
    expect(first).toMatchObject({ name: "Lötstation", created: true });
    expect((await listEquipmentTypes(h.db)).find((t) => t.name === "Lötstation")).toMatchObject({ id: first.typeId, rooms: 1 });
    // zweiter Raum: Typeahead liefert denselben Eintrag – auch mit anderer Schreibweise kein zweiter Katalogeintrag
    const second = await addRoomEquipment(h.db, sabine, "NW3", { name: "lötstation", quantity: "" });
    expect(second).toEqual({ typeId: first.typeId, name: "Lötstation", created: false });
    expect((await h.db.select().from(roomEquipmentTypes)).filter((t) => t.name.toLowerCase() === "lötstation")).toHaveLength(1);
    expect(await roomEquipment(h.db, "NW3")).toContainEqual({ typeId: first.typeId, name: "Lötstation", quantity: 1 });
    // erneut eintragen = Menge ändern
    await addRoomEquipment(h.db, sabine, "NW3", { name: "Lötstation", quantity: 2 });
    expect((await roomEquipment(h.db, "NW3")).find((e) => e.typeId === first.typeId)!.quantity).toBe(2);
    const [created] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.equipment_type.create"));
    expect(created).toMatchObject({ actorId: SABINE, target: first.typeId, meta: { name: "Lötstation", roomId: "NW2" } });
    // die Raumsuche findet beide Räume über die Katalog-ID
    const hits = searchRooms(await listRooms(h.db), new Map(), { periodNrs: [], equipment: [first.typeId] }, [1]);
    expect(hits.map((r) => r.id).sort()).toEqual(["NW2", "NW3"]);
  });

  it("prüft Name und Menge", async () => {
    const sabine = await p(SABINE);
    await expect(addRoomEquipment(h.db, sabine, "NW2", { name: "   " })).rejects.toMatchObject({ fieldErrors: { name: "Ausstattung angeben" } });
    await expect(addRoomEquipment(h.db, sabine, "NW2", { name: "x".repeat(61) })).rejects.toBeInstanceOf(ValidationError);
    await expect(addRoomEquipment(h.db, sabine, "NW2", { name: "Tisch", quantity: "0" })).rejects.toMatchObject({ fieldErrors: { quantity: "Menge 1–9999" } });
    await expect(addRoomEquipment(h.db, sabine, "NW2", { name: "Tisch", quantity: "2.5" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addRoomEquipment(h.db, sabine, "GIBTSNICHT", { name: "Tisch" })).rejects.toBeInstanceOf(ValidationError);
    // nichts angelegt
    expect((await listEquipmentTypes(h.db)).some((t) => t.name === "Tisch")).toBe(false);
  });

  it("Mengen ändern, 0 entfernt (Katalogeintrag bleibt)", async () => {
    const sabine = await p(SABINE);
    expect(await setRoomEquipmentQuantities(h.db, sabine, "NW1", { waschbecken: "6", beamer: "1" })).toBe(1);
    expect(await roomEquipment(h.db, "NW1")).toEqual([
      { typeId: "beamer", name: "Beamer", quantity: 1 },
      { typeId: "waschbecken", name: "Waschbecken", quantity: 6 },
    ]);
    expect(await setRoomEquipmentQuantities(h.db, sabine, "NW1", { beamer: "0" })).toBe(1);
    expect((await roomEquipment(h.db, "NW1")).map((e) => e.typeId)).toEqual(["waschbecken"]);
    expect((await listEquipmentTypes(h.db)).some((t) => t.id === "beamer")).toBe(true);
    await expect(setRoomEquipmentQuantities(h.db, sabine, "NW1", { waschbecken: "-1" })).rejects.toMatchObject({ fieldErrors: { waschbecken: "Menge 1–9999" } });
    await expect(setRoomEquipmentQuantities(h.db, sabine, "NW1", { abzug: "1" })).rejects.toMatchObject({ fieldErrors: { abzug: "Diese Ausstattung steht nicht am Raum" } });
  });

  it("Rechte: pflegen nur mit verwaltung.school (bis RS-06) – Lehrkraft und Schülerin nicht, auch nicht den Katalog", async () => {
    for (const who of [JANA, LEA]) {
      const viewer = await p(who);
      await expect(addRoomEquipment(h.db, viewer, "101", { name: "Beamer" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setRoomEquipmentQuantities(h.db, viewer, "101", { beamer: "3" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(renameEquipmentType(h.db, viewer, "beamer", "Projektor")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(mergeEquipmentTypes(h.db, viewer, "audio", "beamer")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteEquipmentType(h.db, viewer, "abzug")).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("Verwaltung benennt um (gilt überall) – ein vorhandener Name verlangt Zusammenführen", async () => {
    const sabine = await p(SABINE);
    await renameEquipmentType(h.db, sabine, "dokukamera", "Dokumentenkamera (Visualizer)");
    expect((await roomEquipment(h.db, "NW3")).map((e) => e.name)).toContain("Dokumentenkamera (Visualizer)");
    await expect(renameEquipmentType(h.db, sabine, "dokukamera", "beamer")).rejects.toMatchObject({ fieldErrors: { name: "„Beamer“ gibt es schon – stattdessen zusammenführen" } });
    const [row] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.equipment_type.rename"));
    expect(row).toMatchObject({ target: "dokukamera", meta: { name: "Dokumentenkamera (Visualizer)", nameFrom: "Dokumentenkamera" } });
  });

  it("Dubletten zusammenführen: Räume bekommen den Zieleintrag, bei beiden gilt die größere Menge, die Dublette verschwindet", async () => {
    const sabine = await p(SABINE);
    const dup = await addRoomEquipment(h.db, sabine, "IF1", { name: "Schueler-PC", quantity: 30 }); // IF1 hat schon 26 Schüler-PCs
    await addRoomEquipment(h.db, sabine, "015", { name: "Schueler-PC", quantity: 4 });
    expect(await mergeEquipmentTypes(h.db, sabine, dup.typeId, "schueler_pcs")).toBe(2);
    expect((await roomEquipment(h.db, "IF1")).find((e) => e.typeId === "schueler_pcs")!.quantity).toBe(30);
    expect((await roomEquipment(h.db, "015")).find((e) => e.typeId === "schueler_pcs")!.quantity).toBe(4);
    expect((await roomEquipment(h.db, "BIB")).find((e) => e.typeId === "schueler_pcs")!.quantity).toBe(8);
    expect(await h.db.select().from(roomEquipmentTypes).where(eq(roomEquipmentTypes.id, dup.typeId))).toEqual([]);
    expect(await h.db.select().from(roomEquipmentItems).where(eq(roomEquipmentItems.typeId, dup.typeId))).toEqual([]);
    await expect(mergeEquipmentTypes(h.db, sabine, "beamer", "beamer")).rejects.toBeInstanceOf(ValidationError);
    const [row] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.equipment_type.merge"));
    expect(row).toMatchObject({ target: "schueler_pcs", meta: { merged: "Schueler-PC", rooms: 2 } });
  });

  it("Löschen nur, wenn kein Raum den Eintrag mehr hat", async () => {
    const sabine = await p(SABINE);
    await expect(deleteEquipmentType(h.db, sabine, "abzug")).rejects.toMatchObject({ fieldErrors: { name: expect.stringContaining("steht noch in 1 Raum") } });
    const t = await addRoomEquipment(h.db, sabine, "KU1", { name: "Brennofen" });
    await setRoomEquipmentQuantities(h.db, sabine, "KU1", { [t.typeId]: "0" });
    await deleteEquipmentType(h.db, sabine, t.typeId);
    expect((await listEquipmentTypes(h.db)).some((x) => x.name === "Brennofen")).toBe(false);
  });

  it("grobe Ausstattung sehen alle: Steckbrief für Schülerin mit Mengen", async () => {
    const prof = await roomProfile(h.db, await p(LEA), "IF1", PROFILE);
    expect(prof!.room.equipment.map(equipmentLabel)).toContain("30 × Schüler-PCs");
  });
});

describe("RS-04: Raumfotos", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const p = (id: string) => loadPermissions(h.db, id);
  const stored = async (key: string) => new Uint8Array(await new Response(await storage.get(key)).arrayBuffer());
  const keys = async () => (await storage.list()).map((f) => f.key);
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-raumfotos-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("verkleinert auf 1600 px (Vorschau 480 px), entfernt EXIF, dreht nach EXIF-Ausrichtung; erstes Foto wird Titelbild", async () => {
    const input = await jpegWithExif(3200, 2400);
    expect(contains(input, "Mustermann")).toBe(true);
    const id = await addRoomPhoto(h.db, storage, await p(SABINE), "NW2", { photo: input, caption: "  Blick zur Tafel " });
    const [row] = await h.db.select().from(roomPhotos).where(eq(roomPhotos.id, id));
    expect(row).toMatchObject({ roomId: "NW2", mime: "image/jpeg", width: 1600, height: 1200, caption: "Blick zur Tafel", isCover: true });
    const full = await stored(row!.storageKey);
    const thumb = await stored(row!.thumbKey);
    expect(rasterSize(full, "image/jpeg")).toEqual({ width: 1600, height: 1200 });
    expect(rasterSize(thumb, "image/jpeg")).toEqual({ width: 480, height: 360 });
    expect(row!.size).toBe(full.length);
    for (const b of [full, thumb]) {
      expect(contains(b, "Exif")).toBe(false);
      expect(contains(b, "Mustermann")).toBe(false);
      expect(contains(b, "Lindenhof")).toBe(false);
    }
    // Hochformat, als Querformat mit Ausrichtung 6 gespeichert (Handykamera) → gedreht, ohne Ausrichtung
    const rotated = await addRoomPhoto(h.db, storage, await p(SABINE), "NW2", { photo: await jpegWithExif(2000, 1000, 6) });
    const [r2] = await h.db.select().from(roomPhotos).where(eq(roomPhotos.id, rotated));
    expect([r2!.width, r2!.height, r2!.isCover]).toEqual([800, 1600, false]);
    // kleine Bilder bleiben so groß; PNG mit Transparenz wird JPEG
    const png = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const small = await addRoomPhoto(h.db, storage, await p(SABINE), "NW2", { photo: png });
    const [r3] = await h.db.select().from(roomPhotos).where(eq(roomPhotos.id, small));
    expect(r3).toMatchObject({ mime: "image/jpeg", width: 64, height: 48 });
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "verwaltung.room.photo.add"), eq(auditLog.target, "NW2"))).orderBy(desc(auditLog.id)).limit(1);
    expect(audit).toMatchObject({ actorId: SABINE, meta: { photo: small } });
  });

  it("lehnt Nicht-Bilder und kaputte Bilder ab, speichert dann nichts", async () => {
    const sabine = await p(SABINE);
    const before = (await keys()).length;
    await expect(addRoomPhoto(h.db, storage, sabine, "NW1", { photo: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>") })).rejects.toMatchObject({
      fieldErrors: { photo: "Nur Fotos im Format JPEG, PNG oder WebP" },
    });
    await expect(addRoomPhoto(h.db, storage, sabine, "NW1", { photo: new Uint8Array() })).rejects.toBeInstanceOf(ValidationError);
    const broken = (await jpegWithExif(200, 100)).slice(0, 400);
    await expect(addRoomPhoto(h.db, storage, sabine, "NW1", { photo: broken })).rejects.toBeInstanceOf(ValidationError);
    await expect(addRoomPhoto(h.db, storage, sabine, "NW1", { photo: await jpegWithExif(20, 20), caption: "x".repeat(121) })).rejects.toMatchObject({ fieldErrors: { caption: expect.any(String) } });
    expect((await keys()).length).toBe(before);
    expect(await listRoomPhotos(h.db, sabine, "NW1")).toEqual([]);
  });

  it("höchstens 8 Fotos je Raum", async () => {
    const sabine = await p(SABINE);
    const img = await jpegWithExif(40, 30);
    for (let i = 0; i < ROOM_PHOTOS_MAX; i++) await addRoomPhoto(h.db, storage, sabine, "KU1", { photo: img });
    await expect(addRoomPhoto(h.db, storage, sabine, "KU1", { photo: img })).rejects.toMatchObject({ fieldErrors: { photo: expect.stringContaining("Höchstens 8 Fotos") } });
    expect(await listRoomPhotos(h.db, sabine, "KU1")).toHaveLength(ROOM_PHOTOS_MAX);
  });

  it("Sichtbarkeit: Titelbild sehen alle (Liste, Kopf, Route), die Galerie nur Beschäftigte", async () => {
    const [lea, jana] = [await p(LEA), await p(JANA)];
    const all = await listRoomPhotos(h.db, jana, "NW2");
    expect(all).toHaveLength(3);
    const cover = all[0]!;
    expect(cover).toMatchObject({ isCover: true, caption: "Blick zur Tafel" });
    expect(await listRoomPhotos(h.db, lea, "NW2")).toEqual([cover]);

    const famProfile = await roomProfile(h.db, lea, "NW2", PROFILE);
    expect(famProfile).toMatchObject({ cover, photos: null });
    const staffProfile = await roomProfile(h.db, jana, "NW2", PROFILE);
    expect(staffProfile!.cover).toEqual(cover);
    expect(staffProfile!.photos).toEqual(all);
    expect((await roomDirectory(h.db, "NW2")).find((r) => r.id === "NW2")!.coverId).toBe(cover.id);
    expect((await coverPhotos(h.db)).get("NW2")!.id).toBe(cover.id);

    const other = all[1]!.id;
    expect(await photoFile(h.db, lea, cover.id, false)).not.toBeNull();
    expect(await photoFile(h.db, lea, cover.id, true)).not.toBeNull();
    expect(await photoFile(h.db, lea, other, false)).toBeNull();
    expect(await photoFile(h.db, lea, other, true)).toBeNull();
    expect(await photoFile(h.db, jana, other, false)).toMatchObject({ mime: "image/jpeg" });
    expect(await photoFile(h.db, jana, "gibt-es-nicht", false)).toBeNull();
  });

  it("Rechte: hochladen, Titelbild, Unterschrift, löschen nur mit verwaltung.school (bis RS-06)", async () => {
    const [cover, other] = await listRoomPhotos(h.db, await p(SABINE), "NW2");
    for (const who of [JANA, LEA]) {
      const viewer = await p(who);
      await expect(addRoomPhoto(h.db, storage, viewer, "NW2", { photo: await jpegWithExif(20, 20) })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setCoverPhoto(h.db, viewer, other!.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setPhotoCaption(h.db, viewer, cover!.id, "anders")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteRoomPhoto(h.db, storage, viewer, cover!.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("Titelbild wechseln, Unterschrift ändern; Löschen des Titelbilds macht das älteste übrige zum Titelbild und entfernt die Dateien", async () => {
    const sabine = await p(SABINE);
    const [cover, second, third] = await listRoomPhotos(h.db, sabine, "NW2");
    await setCoverPhoto(h.db, sabine, third!.id);
    expect((await listRoomPhotos(h.db, sabine, "NW2")).map((x) => [x.id, x.isCover])).toEqual([
      [third!.id, true],
      [cover!.id, false],
      [second!.id, false],
    ]);
    await setPhotoCaption(h.db, sabine, cover!.id, "  Fensterseite ");
    expect((await listRoomPhotos(h.db, sabine, "NW2")).find((x) => x.id === cover!.id)!.caption).toBe("Fensterseite");
    await setPhotoCaption(h.db, sabine, cover!.id, "");
    expect((await listRoomPhotos(h.db, sabine, "NW2")).find((x) => x.id === cover!.id)!.caption).toBeNull();

    const [row] = await h.db.select().from(roomPhotos).where(eq(roomPhotos.id, third!.id));
    await deleteRoomPhoto(h.db, storage, sabine, third!.id);
    const rest = await listRoomPhotos(h.db, sabine, "NW2");
    expect(rest.map((x) => [x.id, x.isCover])).toEqual([
      [cover!.id, true],
      [second!.id, false],
    ]);
    const files = await keys();
    expect(files).not.toContain(row!.storageKey);
    expect(files).not.toContain(row!.thumbKey);
  });

  it("Dateispeicher-Abgleich kennt Foto und Vorschau (Aufräumlauf löscht sie nicht)", async () => {
    const known = await referencedStorageKeys(h.db);
    const rows = await h.db.select().from(roomPhotos);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(known.has(r.storageKey)).toBe(true);
      expect(known.has(r.thumbKey)).toBe(true);
    }
  });
});
