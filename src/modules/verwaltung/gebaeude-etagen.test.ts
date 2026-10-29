// RS-10: Gebäude und Etagen als Stammdaten – Demo-Seed, Sortierung und Filter im Raumfinder, Rechte (nur verwaltung.school),
// Anlegen/Umbenennen/Löschen samt Anzeigekopie an den Räumen, Ort im Raumformular (Etage legt das Gebäude fest).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buildingFloors, rooms } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import {
  createBuilding,
  createFloor,
  deleteBuilding,
  deleteFloor,
  listBuildings,
  parsePlaceValue,
  placeName,
  placeValue,
  resolvePlace,
  updateBuilding,
  updateFloor,
} from "./gebaeude-etagen";
import { roomDirectory } from "./raumsteckbrief";
import { getRoom, listRooms, updateRoom, type RoomInput } from "./rooms";
import { ValidationError } from "./users";

const SABINE = "u-sabine.kowalski"; // Sekretariat: verwaltung.school
const KLAUS = "u-klaus.berger"; // Hausmeister: Raumdaten pflegen, aber keine Stammdaten
const JANA = "u-jana.brandt"; // Lehrkraft
const LEA = "u-lea.schaefer"; // Schülerin

describe("RS-10: Gebäude und Etagen", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("rein: Namen und Auswahlwerte", () => {
    expect(placeName("  1.   OG ")).toBe("1. OG");
    expect(parsePlaceValue("f:abc")).toEqual({ buildingId: null, floorId: "abc" });
    expect(parsePlaceValue("b:xyz")).toEqual({ buildingId: "xyz", floorId: null });
    expect(parsePlaceValue("")).toEqual({ buildingId: null, floorId: null });
    expect(parsePlaceValue("f:")).toEqual({ buildingId: null, floorId: null });
    expect(placeValue({ buildingId: "b1", floorId: "f1" })).toBe("f:f1");
    expect(placeValue({ buildingId: "b1", floorId: null })).toBe("b:b1");
  });

  it("Demo-Seed: Gebäude und Etagen in Reihenfolge, jeder Raum verknüpft, Anzeigekopie gleich den Stammdaten", async () => {
    const list = await listBuildings(h.db);
    expect(list.map((b) => b.name)).toEqual(["Hauptgebäude", "Naturwissenschaften", "Pavillon", "Sporthalle"]);
    expect(list[0]!.floors.map((f) => f.name)).toEqual(["EG", "1. OG", "2. OG"]);
    expect(list[1]!.floors.map((f) => [f.name, f.rooms])).toEqual([
      ["EG", 2],
      ["1. OG", 1],
    ]);
    const names = new Map(list.flatMap((b) => [[b.id, b.name] as const, ...b.floors.map((f) => [f.id, f.name] as const)]));
    for (const r of await h.db.select().from(rooms)) {
      expect(r.buildingId, r.id).not.toBeNull();
      expect(r.floorId, r.id).not.toBeNull();
      expect(names.get(r.buildingId!)).toBe(r.building);
      expect(names.get(r.floorId!)).toBe(r.floor);
    }
  });

  it("Raumfinder: sortiert nach Gebäude- und Etagenreihenfolge (Kürzel numerisch), Filter nach Gebäude und Etage", async () => {
    const all = await roomDirectory(h.db);
    const order = all.map((r) => `${r.building}|${r.floor}`);
    // Hauptgebäude EG … 2. OG, dann Naturwissenschaften EG/1. OG, Pavillon, Sporthalle
    expect([...new Set(order)]).toEqual([
      "Hauptgebäude|EG",
      "Hauptgebäude|1. OG",
      "Hauptgebäude|2. OG",
      "Naturwissenschaften|EG",
      "Naturwissenschaften|1. OG",
      "Pavillon|EG",
      "Sporthalle|EG",
    ]);
    // Kürzel numerisch innerhalb der Etage („015“ vor „101“, „110“ nach „109“)
    const eg = all.filter((r) => r.building === "Hauptgebäude" && r.floor === "EG").map((r) => r.id);
    expect(eg.slice(0, 3)).toEqual(["015", "101", "102"]);
    expect(eg.indexOf("110")).toBe(eg.indexOf("109") + 1);
    const list = await listBuildings(h.db);
    const pavillon = list.find((b) => b.name === "Pavillon")!;
    expect((await roomDirectory(h.db, undefined, 500, { buildingId: pavillon.id })).map((r) => r.id)).toEqual(["KU1", "MU1"]);
    const nwOg = list.find((b) => b.name === "Naturwissenschaften")!.floors.find((f) => f.name === "1. OG")!;
    expect((await roomDirectory(h.db, undefined, 500, { floorId: nwOg.id })).map((r) => r.id)).toEqual(["NW3"]);
    expect((await roomDirectory(h.db, "Physik", 500, { buildingId: pavillon.id })).map((r) => r.id)).toEqual([]);
    // Stammdaten-Liste ebenfalls nach der Reihenfolge der Gebäude
    const blocks = (await listRooms(h.db)).map((r) => r.building).filter((b, i, a) => b !== a[i - 1]);
    expect(blocks).toEqual(["Hauptgebäude", "Naturwissenschaften", "Pavillon", "Sporthalle"]);
  });

  it("Rechte: nur verwaltung.school pflegt Gebäude und Etagen (Hausmeister mit Raumdaten-Recht, Lehrkraft, Schülerin nicht)", async () => {
    const [b] = await listBuildings(h.db);
    for (const who of [KLAUS, JANA, LEA]) {
      const perms = await p(who);
      await expect(createBuilding(h.db, perms, { name: "Verboten" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateBuilding(h.db, perms, b!.id, { name: "Umbenannt" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteBuilding(h.db, perms, b!.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createFloor(h.db, perms, b!.id, { name: "3. OG" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateFloor(h.db, perms, b!.floors[0]!.id, { name: "Keller" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteFloor(h.db, perms, b!.floors[0]!.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await listBuildings(h.db)).map((x) => x.name)).not.toContain("Verboten");
    expect((await listBuildings(h.db))[0]!.name).toBe("Hauptgebäude");
  });

  it("Anlegen, Umbenennen (zieht die Anzeigekopie mit), Ort im Raumformular, Löschen nur ohne Räume, Audit", async () => {
    const admin = await p(SABINE);
    await expect(createBuilding(h.db, admin, { name: "  " })).rejects.toMatchObject({ fieldErrors: { name: "Name angeben" } });
    await expect(createBuilding(h.db, admin, { name: "hauptgebäude" })).rejects.toMatchObject({ fieldErrors: { name: expect.stringMatching(/gibt es schon/) } });
    await expect(createBuilding(h.db, admin, { name: "Neubau", sortOrder: "-1" })).rejects.toBeInstanceOf(ValidationError);
    const neubau = await createBuilding(h.db, admin, { name: " Neubau " });
    // ohne Reihenfolge ans Ende
    expect((await listBuildings(h.db)).at(-1)!.name).toBe("Neubau");
    const og = await createFloor(h.db, admin, neubau, { name: "1. OG" });
    const eg = await createFloor(h.db, admin, neubau, { name: "EG", sortOrder: 0 });
    await expect(createFloor(h.db, admin, neubau, { name: "eg" })).rejects.toMatchObject({ fieldErrors: { name: expect.stringMatching(/gibt es/) } });
    expect((await listBuildings(h.db)).at(-1)!.floors.map((f) => f.name)).toEqual(["EG", "1. OG"]);

    // Raum 101 zieht in den Neubau, 1. OG
    const room = (await getRoom(h.db, "101"))!;
    const input = (more: Partial<RoomInput>): RoomInput => ({ code: "101", name: room.name, kind: room.kind, capacity: room.capacity, accessible: room.accessible, active: true, ...more });
    await updateRoom(h.db, SABINE, "101", input({ floorId: og }));
    expect(await getRoom(h.db, "101")).toMatchObject({ buildingId: neubau, floorId: og, building: "Neubau", floor: "1. OG" });
    // Etage aus einem anderen Gebäude bzw. unbekannte IDs → Fehler am Feld „place“
    const nw = (await listBuildings(h.db)).find((b) => b.name === "Naturwissenschaften")!;
    await expect(updateRoom(h.db, SABINE, "101", input({ buildingId: nw.id, floorId: og }))).rejects.toMatchObject({ fieldErrors: { place: expect.stringMatching(/anderen Gebäude/) } });
    await expect(updateRoom(h.db, SABINE, "101", input({ floorId: "gibt-es-nicht" }))).rejects.toMatchObject({ fieldErrors: { place: "Etage gibt es nicht" } });
    await expect(resolvePlace(h.db, { buildingId: "nix" })).rejects.toMatchObject({ fieldErrors: { place: "Gebäude gibt es nicht" } });

    // Umbenennen zieht die Anzeigekopie mit (Mängel, Prüfungen, Raumsuche lesen sie)
    await updateBuilding(h.db, admin, neubau, { name: "Neubau Nord", sortOrder: 5 });
    await updateFloor(h.db, admin, og, { name: "1. Obergeschoss" });
    expect(await getRoom(h.db, "101")).toMatchObject({ building: "Neubau Nord", floor: "1. Obergeschoss" });
    // Reihenfolge 5 → jetzt vorn
    expect((await listBuildings(h.db))[0]!.name).toBe("Neubau Nord");
    expect((await roomDirectory(h.db))[0]!.id).toBe("101");

    // Löschen nur ohne Räume
    await expect(deleteFloor(h.db, admin, og)).rejects.toMatchObject({ fieldErrors: { name: expect.stringMatching(/Noch 1 Raum/) } });
    await expect(deleteBuilding(h.db, admin, neubau)).rejects.toMatchObject({ fieldErrors: { name: expect.stringMatching(/Noch 1 Raum/) } });
    await updateRoom(h.db, SABINE, "101", input({ buildingId: neubau }));
    expect(await getRoom(h.db, "101")).toMatchObject({ buildingId: neubau, floorId: null, floor: null });
    await deleteFloor(h.db, admin, og);
    const hg = (await listBuildings(h.db)).find((b) => b.name === "Hauptgebäude")!;
    await updateRoom(h.db, SABINE, "101", input({ floorId: hg.floors[0]!.id }));
    await deleteBuilding(h.db, admin, neubau);
    expect(await h.db.select().from(buildingFloors).where(eq(buildingFloors.id, eg))).toEqual([]);
    expect(await getRoom(h.db, "101")).toMatchObject({ building: "Hauptgebäude", floor: "EG" });

    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action).filter((a) => a.startsWith("verwaltung.room.building") || a.startsWith("verwaltung.room.floor"));
    expect(new Set(actions)).toEqual(
      new Set([
        "verwaltung.room.building.create",
        "verwaltung.room.building.update",
        "verwaltung.room.building.delete",
        "verwaltung.room.floor.create",
        "verwaltung.room.floor.update",
        "verwaltung.room.floor.delete",
      ]),
    );
  });
});
