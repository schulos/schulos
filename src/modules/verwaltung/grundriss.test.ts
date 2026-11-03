// RS-13: Grundriss je Etage – Upload (verkleinert, ohne Metadaten), Pflicht-Alternativtext, Punkte je Raum, Sichtbarkeit
// (Moduleinstellung „nur Personal“), Rechte (`verwaltung.school`, nicht die Raumverantwortlichen), Dateispeicher und Audit.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buildingFloors, rooms } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { rasterSize } from "@/core/images";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { referencedStorageKeys } from "@/core/privacy/dateispeicher";
import { getRoom, updateRoom, type RoomInput } from "./rooms";
import { addResponsible } from "./raumverantwortliche";
import {
  FLOOR_PLAN_EDGE,
  canViewFloorPlans,
  deleteFloorPlan,
  floorPlanEditor,
  floorPlanFile,
  floorPlansFor,
  normalizePlanAlt,
  parsePlanPercent,
  setFloorPlan,
  setFloorPlanAlt,
  setRoomPlanPoint,
} from "./grundriss";
import { roomHistory } from "./raumverantwortliche";
import { FLOOR_PLAN_VISIBILITY } from "./settings";
import { ValidationError } from "./users";

const JANA = "u-jana.brandt"; // Lehrkraft
const LEA = "u-lea.schaefer"; // Schülerin
const SABINE = "u-sabine.kowalski"; // Sekretariat: verwaltung.school
const ALT = "Flur von West nach Ost, Treppenhaus in der Mitte";

const contains = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));

async function planImage(width: number, height: number, format: "jpeg" | "png" = "jpeg"): Promise<Uint8Array> {
  const img = sharp({ create: { width, height, channels: 3, background: { r: 250, g: 250, b: 250 } } }).withExif({ IFD0: { Artist: "Max Mustermann" } });
  return new Uint8Array(await (format === "png" ? img.png() : img.jpeg()).toBuffer());
}

describe("RS-13: reine Helfer", () => {
  it("Prozent → Anteil, Komma erlaubt, leer = kein Punkt, außerhalb 0–100 abgelehnt", () => {
    expect(parsePlanPercent("25", "x")).toBe(0.25);
    expect(parsePlanPercent("33,35", "y")).toBe(0.3335);
    expect(parsePlanPercent(" ", "x")).toBeNull();
    expect(() => parsePlanPercent("101", "x")).toThrow(ValidationError);
    expect(() => parsePlanPercent("-1", "y")).toThrow(ValidationError);
    expect(() => parsePlanPercent("abc", "x")).toThrow(ValidationError);
  });
  it("Alternativtext ist Pflicht (10–300 Zeichen), Leerraum zusammengefasst", () => {
    expect(normalizePlanAlt(`  ${ALT}  `)).toBe(ALT);
    expect(() => normalizePlanAlt("Plan")).toThrow(ValidationError);
    expect(() => normalizePlanAlt("")).toThrow(ValidationError);
    expect(() => normalizePlanAlt("x".repeat(301))).toThrow(ValidationError);
  });
});

describe("RS-13: Grundriss je Etage", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let floorId: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const stored = async (key: string) => new Uint8Array(await new Response(await storage.get(key)).arrayBuffer());
  const floor = async () => (await h.db.select().from(buildingFloors).where(eq(buildingFloors.id, floorId)))[0]!;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-grundriss-"));
    storage = localStorage(dir);
    floorId = (await getRoom(h.db, "NW2"))!.floorId!;
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("nur `verwaltung.school` lädt hoch und verortet – Lehrkraft, Schülerin und Raumverantwortliche nicht", async () => {
    const sabine = await p(SABINE);
    // Lehrkraft als Raumverantwortliche für NW2: pflegt Raumdaten, aber keinen Grundriss (rs-3)
    await addResponsible(h.db, sabine, "NW2", { target: `u:${JANA}` });
    const img = await planImage(100, 80);
    for (const id of [JANA, LEA]) {
      const viewer = await p(id);
      await expect(setFloorPlan(h.db, storage, viewer, floorId, { image: img, alt: ALT })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setRoomPlanPoint(h.db, viewer, "NW2", { x: 0.5, y: 0.5 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(floorPlanEditor(h.db, viewer, floorId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteFloorPlan(h.db, storage, viewer, floorId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setFloorPlanAlt(h.db, viewer, floorId, ALT)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await floor()).planKey).toBeNull();
  });

  it("ohne Plan: kein Punkt möglich, Raumfinder ohne Grundriss, Route 404", async () => {
    await expect(setRoomPlanPoint(h.db, await p(SABINE), "NW2", { x: 0.2, y: 0.2 })).rejects.toMatchObject({ fieldErrors: { room: expect.stringMatching(/keiner Etage mit Grundriss/) } });
    expect((await floorPlansFor(h.db, await p(JANA), [floorId])).size).toBe(0);
    expect(await floorPlanFile(h.db, await p(JANA), floorId, false)).toBeNull();
  });

  it("Upload: verkleinert auf 2400 px (Vorschau 800 px), ohne EXIF, Pflicht-Alternativtext, nur JPEG/PNG/WebP", async () => {
    const sabine = await p(SABINE);
    await expect(setFloorPlan(h.db, storage, sabine, floorId, { image: await planImage(50, 50), alt: "kurz" })).rejects.toMatchObject({ fieldErrors: { alt: expect.any(String) } });
    await expect(setFloorPlan(h.db, storage, sabine, floorId, { image: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), alt: ALT })).rejects.toMatchObject({
      fieldErrors: { plan: expect.stringMatching(/JPEG, PNG oder WebP/) },
    });
    await expect(setFloorPlan(h.db, storage, sabine, floorId, { image: new TextEncoder().encode("%PDF-1.7\n"), alt: ALT })).rejects.toBeInstanceOf(ValidationError);
    await expect(setFloorPlan(h.db, storage, sabine, floorId, { image: new Uint8Array(), alt: ALT })).rejects.toBeInstanceOf(ValidationError);

    const input = await planImage(4000, 2000, "png");
    await setFloorPlan(h.db, storage, sabine, floorId, { image: input, alt: `  ${ALT} ` });
    const f = await floor();
    expect(f).toMatchObject({ planMime: "image/jpeg", planWidth: FLOOR_PLAN_EDGE, planHeight: 1200, planAlt: ALT });
    const full = await stored(f.planKey!);
    expect(rasterSize(full, "image/jpeg")).toEqual({ width: 2400, height: 1200 });
    expect(rasterSize(await stored(f.planThumbKey!), "image/jpeg")).toEqual({ width: 800, height: 400 });
    expect(contains(full, "Mustermann")).toBe(false);
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.floor.plan_add"));
    expect(a).toMatchObject({ actorId: SABINE, target: floorId });
    // Dateispeicher kennt beide Schlüssel (Aufräumlauf löscht sie nicht, Backup über files/)
    const known = await referencedStorageKeys(h.db);
    expect(known.has(f.planKey!) && known.has(f.planThumbKey!)).toBe(true);
  });

  it("Punkte: nur Räume der Etage mit Plan, 0–1, entfernen; Raumfinder zeigt aktive verortete Räume; Historie", async () => {
    const sabine = await p(SABINE);
    await setRoomPlanPoint(h.db, sabine, "NW2", { x: 0.25, y: 0.5 });
    await expect(setRoomPlanPoint(h.db, sabine, "NW2", { x: 1.5, y: 0.5 })).rejects.toMatchObject({ fieldErrors: { x: expect.any(String) } });
    await expect(setRoomPlanPoint(h.db, sabine, "gibt-es-nicht", { x: 0.5, y: 0.5 })).rejects.toBeInstanceOf(ValidationError);
    // ein Raum ohne Etage mit Plan
    const other = (await h.db.select({ id: rooms.id, floorId: rooms.floorId }).from(rooms)).find((r) => r.floorId !== floorId)!;
    await expect(setRoomPlanPoint(h.db, sabine, other.id, { x: 0.5, y: 0.5 })).rejects.toMatchObject({ fieldErrors: { room: expect.any(String) } });
    // die DB-Prüfung hält auch direkte Schreibversuche auf (beide oder keiner, 0–1)
    await expect(h.db.update(rooms).set({ planX: 0.3, planY: null }).where(eq(rooms.id, "NW1"))).rejects.toThrow();

    const view = (await floorPlansFor(h.db, await p(LEA), [floorId])).get(floorId)!;
    expect(view).toMatchObject({ building: "Naturwissenschaften", floor: "EG", alt: ALT, width: 2400, height: 1200 });
    expect(view.rooms).toEqual([{ id: "NW2", name: "Chemie-Raum", active: true, x: 0.25, y: 0.5 }]);
    const editor = (await floorPlanEditor(h.db, sabine, floorId))!;
    expect(editor.rooms.map((r) => r.id)).toContain("NW1");
    expect(editor.rooms.find((r) => r.id === "NW1")).toMatchObject({ x: null, y: null });

    const history = await roomHistory(h.db, sabine, "NW2");
    expect(history[0]).toMatchObject({ label: "Raum auf dem Grundriss verortet" });
    await setRoomPlanPoint(h.db, sabine, "NW1", { x: 0.75, y: 0.5 });
    await setRoomPlanPoint(h.db, sabine, "NW1", null);
    expect(await getRoom(h.db, "NW1")).toMatchObject({ planX: null, planY: null });
  });

  it("Sicht: Personal immer; Schüler:innen/Eltern nur mit Vorgabe „alle“ – sonst kein Plan und Route 404", async () => {
    const [jana, lea] = [await p(JANA), await p(LEA)];
    expect(await canViewFloorPlans(h.db, lea)).toBe(true);
    expect(await floorPlanFile(h.db, lea, floorId, true)).toMatchObject({ mime: "image/jpeg" });
    await writeModuleSetting(h.db, FLOOR_PLAN_VISIBILITY, "personal");
    expect(await canViewFloorPlans(h.db, lea)).toBe(false);
    expect(await floorPlanFile(h.db, lea, floorId, false)).toBeNull();
    expect((await floorPlansFor(h.db, lea, [floorId])).size).toBe(0);
    expect(await floorPlanFile(h.db, jana, floorId, false)).not.toBeNull();
    expect((await floorPlansFor(h.db, jana, [floorId])).size).toBe(1);
    await writeModuleSetting(h.db, FLOOR_PLAN_VISIBILITY, "alle");
    // unbekannte Etage → null (einheitlich 404)
    expect(await floorPlanFile(h.db, jana, "gibt-es-nicht", false)).toBeNull();
  });

  it("Etagenwechsel leert den Punkt; Ersetzen behält Punkte und löscht alte Dateien; Löschen leert alle Punkte", async () => {
    const sabine = await p(SABINE);
    // NW2 zieht ins Hauptgebäude (andere Etage) → Punkt weg
    const room = (await getRoom(h.db, "NW2"))!;
    const target = (await h.db.select().from(buildingFloors)).find((f) => f.id !== floorId)!;
    const input = (more: Partial<RoomInput>): RoomInput => ({ code: "NW2", name: room.name, kind: room.kind, capacity: room.capacity, accessible: room.accessible, active: true, ...more });
    await updateRoom(h.db, SABINE, "NW2", input({ floorId: room.floorId }));
    expect(await getRoom(h.db, "NW2")).toMatchObject({ planX: 0.25, planY: 0.5 });
    await updateRoom(h.db, SABINE, "NW2", input({ floorId: target.id }));
    expect(await getRoom(h.db, "NW2")).toMatchObject({ planX: null, planY: null });
    await updateRoom(h.db, SABINE, "NW2", input({ floorId: room.floorId }));

    await setRoomPlanPoint(h.db, sabine, "NW1", { x: 0.1, y: 0.1 });
    const old = await floor();
    await setFloorPlan(h.db, storage, sabine, floorId, { image: await planImage(1200, 900), alt: ALT });
    const now = await floor();
    expect(now.planKey).not.toBe(old.planKey);
    expect(now.planWidth).toBe(1200);
    expect(await storage.get(old.planKey!)).toBeNull();
    expect(await getRoom(h.db, "NW1")).toMatchObject({ planX: 0.1, planY: 0.1 });
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.floor.plan_replace"))).length).toBe(1);

    await setFloorPlanAlt(h.db, sabine, floorId, "Neuer Text für den Plan der Etage");
    expect((await floor()).planAlt).toBe("Neuer Text für den Plan der Etage");

    await deleteFloorPlan(h.db, storage, sabine, floorId);
    const gone = await floor();
    expect(gone).toMatchObject({ planKey: null, planThumbKey: null, planAlt: null, planWidth: null });
    expect(await getRoom(h.db, "NW1")).toMatchObject({ planX: null, planY: null });
    expect(await storage.get(now.planKey!)).toBeNull();
    expect(await storage.get(now.planThumbKey!)).toBeNull();
  });
});
