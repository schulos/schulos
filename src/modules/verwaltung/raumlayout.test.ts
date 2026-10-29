// RS-08/RS-09: Raumlayouts (Speichern, Prüfen, Rechte inkl. Raumverantwortliche und fremder Raum, Sicht nur Personal),
// Sitzplan aus einem Layout als Kopie (spätere Layoutänderung lässt den Sitzplan unverändert) und Prüfungsplätze im Klausurplan.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, exams, roomLayouts, sitzplanPlans } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { cellKey } from "@/core/raster";
import { capacityHint, examSeatKeys, layoutGridError, seatCount, seatKeys, variantCells, type LayoutCells } from "@/core/raumlayout-raster";
import { createExam, examSeatWarnings } from "@/modules/klausurplan/service";
import { createPlan, planLayoutSource } from "@/modules/sitzplan/service";
import {
  createRoomLayout,
  deleteRoomLayout,
  examSeatWarning,
  examSeatsByRoom,
  getRoomLayout,
  layoutOptions,
  listRoomLayouts,
  setDefaultRoomLayout,
  updateRoomLayout,
} from "./raumlayout";
import { roomHistory } from "./raumverantwortliche";
import { ValidationError } from "./users";

const SABINE = "u-sabine.kowalski"; // Sekretariat: Raumdaten pflegen
const KLAUS = "u-klaus.berger"; // Hausmeister: Recht über die Gruppe Hausmeisterei
const ALBERS = "u-henrik.albers"; // Lehrkraft, verantwortlich für NW2
const JANA = "u-jana.brandt"; // Lehrkraft ohne Verantwortung, KL 7b
const LEA = "u-lea.schaefer"; // Schülerin
const TODAY = "2026-10-07";

/** 2 × 4: vorn Tafel und Pult, hinten vier Plätze nebeneinander. */
const SMALL: LayoutCells = { "0:0": "tafel", "0:3": "pult", "1:0": "platz", "1:1": "platz", "1:2": "platz", "1:3": "platz" };

describe("RS-08/09: Raumlayout", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let nw2Default = "";
  let nw2Exam = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(exams);
  }, 60_000);
  afterAll(() => h.close());

  it("rein: Platzzahl, Prüfungsplätze (jeder zweite bzw. Variante Prüfung), Vorlagen, Prüfung, Hinweis zur Kapazität", () => {
    expect(seatCount(SMALL)).toBe(4);
    expect(seatKeys(SMALL)).toEqual(["1:0", "1:1", "1:2", "1:3"]);
    expect(examSeatKeys(SMALL, "reihen")).toEqual(["1:0", "1:2"]);
    expect(examSeatKeys(SMALL, "pruefung")).toHaveLength(4);
    // Schachbrett: Platz davor genommen → nicht direkt dahinter
    const block: LayoutCells = { "0:0": "platz", "0:1": "platz", "1:0": "platz", "1:1": "platz" };
    expect(examSeatKeys(block, "frei").sort()).toEqual(["0:0", "1:1"]);
    const reihen = variantCells("reihen", 6, 8);
    expect(reihen[cellKey(0, 3)]).toBe("tafel");
    expect(seatCount(reihen)).toBe(30);
    expect(Object.values(variantCells("pruefung", 6, 8)).filter((x) => x === "platz")).toHaveLength(20);
    expect(layoutGridError({ rows: 13, cols: 2, cells: {} })).toMatch(/Reihen/);
    expect(layoutGridError({ rows: 2, cols: 2, cells: { "2:0": "platz" } })).toMatch(/außerhalb/);
    expect(layoutGridError({ rows: 2, cols: 2, cells: { "0:0": "sofa" as never } })).toMatch(/Unbekannt/);
    expect(layoutGridError({ rows: 2, cols: 4, cells: SMALL })).toBeNull();
    expect(capacityHint(4, 4)).toBeNull();
    expect(capacityHint(4, 28)).toMatch(/Vorschlag: 4/);
    expect(capacityHint(4, null)).toMatch(/keine Platzzahl/);
  });

  it("Rechte: Raumdaten-Recht und Verantwortliche für den eigenen Raum dürfen pflegen, fremder Raum und Lehrkraft/Schülerin nicht", async () => {
    const input = { name: "Standard", variant: "reihen", rows: 2, cols: 4, cells: SMALL };
    // Gegenprobe der Verantwortlichkeit: Albers ist nur für NW2 eingetragen
    await expect(createRoomLayout(h.db, await p(ALBERS), "MU1", input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createRoomLayout(h.db, await p(JANA), "106", input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createRoomLayout(h.db, await p(LEA), "106", input)).rejects.toBeInstanceOf(ForbiddenError);
    nw2Default = await createRoomLayout(h.db, await p(ALBERS), "NW2", input);
    const mu1 = await createRoomLayout(h.db, await p(KLAUS), "MU1", input);
    const l106 = await createRoomLayout(h.db, await p(SABINE), "106", { ...input, rows: 6, cols: 8, cells: variantCells("reihen", 6, 8) });
    // erstes Layout eines Raums ist Standard
    for (const id of [nw2Default, mu1, l106]) expect((await getRoomLayout(h.db, await p(JANA), id))?.isDefault).toBe(true);
    // Verantwortlicher ändert nur das eigene, nicht das fremde
    await expect(updateRoomLayout(h.db, await p(ALBERS), mu1, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteRoomLayout(h.db, await p(ALBERS), mu1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setDefaultRoomLayout(h.db, await p(JANA), l106)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.layout.create"))).toHaveLength(3);
  });

  it("Prüfung: Name eindeutig je Raum (Schreibweise egal), Variante, Raster; Grenze je Raum", async () => {
    const albers = await p(ALBERS);
    const ok = { name: "Klausur", variant: "pruefung", rows: 2, cols: 4, cells: SMALL };
    await expect(createRoomLayout(h.db, albers, "NW2", { ...ok, name: " standard " })).rejects.toMatchObject({ fieldErrors: { name: /gibt es/ } });
    await expect(createRoomLayout(h.db, albers, "NW2", { ...ok, name: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRoomLayout(h.db, albers, "NW2", { ...ok, variant: "kreis" })).rejects.toMatchObject({ fieldErrors: { variant: /Variante/ } });
    await expect(createRoomLayout(h.db, albers, "NW2", { ...ok, rows: 1, cells: SMALL })).rejects.toMatchObject({ fieldErrors: { layout: /außerhalb/ } });
    nw2Exam = await createRoomLayout(h.db, albers, "NW2", ok);
    const list = await listRoomLayouts(h.db, albers, "NW2");
    expect(list?.map((l) => [l.name, l.isDefault, l.seats, l.examSeats])).toEqual([
      ["Standard", true, 4, 2],
      ["Klausur", false, 4, 4],
    ]);
    const sabine = await p(SABINE);
    for (let i = 0; i < 7; i++) await createRoomLayout(h.db, sabine, "KU1", { ...ok, name: `L${i}` });
    await createRoomLayout(h.db, sabine, "KU1", { ...ok, name: "L7" });
    await expect(createRoomLayout(h.db, sabine, "KU1", { ...ok, name: "L8" })).rejects.toMatchObject({ fieldErrors: { name: /Höchstens 8/ } });
  });

  it("Standard umstellen und löschen (ältestes übriges rückt nach); Historie ohne Personenbezug im Layout", async () => {
    const sabine = await p(SABINE);
    await setDefaultRoomLayout(h.db, sabine, nw2Exam);
    expect((await listRoomLayouts(h.db, sabine, "NW2"))?.map((l) => [l.name, l.isDefault])).toEqual([
      ["Klausur", true],
      ["Standard", false],
    ]);
    await setDefaultRoomLayout(h.db, sabine, nw2Default);
    const history = await roomHistory(h.db, await p(ALBERS), "NW2");
    expect(history.map((x) => x.label)).toEqual(expect.arrayContaining(["Raumlayout angelegt", "Standard-Layout eines Raums gewählt"]));
    expect(history.find((x) => x.label === "Raumlayout angelegt")?.detail).toMatch(/Plätze/);
    const tmp = await createRoomLayout(h.db, sabine, "MU1", { name: "Tmp", variant: "frei", rows: 1, cols: 1, cells: {} });
    const [mu1Default] = (await listRoomLayouts(h.db, sabine, "MU1"))!.filter((l) => l.isDefault);
    await deleteRoomLayout(h.db, sabine, mu1Default!.id);
    expect((await listRoomLayouts(h.db, sabine, "MU1"))?.map((l) => [l.id, l.isDefault])).toEqual([[tmp, true]]);
  });

  it("Sicht: Layouts nur für Beschäftigte – Schülerin bekommt nichts", async () => {
    expect(await listRoomLayouts(h.db, await p(LEA), "NW2")).toBeNull();
    expect(await getRoomLayout(h.db, await p(LEA), nw2Default)).toBeNull();
    expect(await layoutOptions(h.db, await p(LEA))).toEqual([]);
    expect((await layoutOptions(h.db, await p(JANA))).some((o) => o.id === nw2Default)).toBe(true);
  });

  it("RS-09: Sitzplan aus Layout ist eine Kopie – spätere Änderung am Layout lässt den Sitzplan unverändert (nur Hinweis)", async () => {
    const jana = await p(JANA);
    const [l106] = (await listRoomLayouts(h.db, jana, "106"))!;
    const planId = await createPlan(h.db, jana, { groupId: "g-7b", title: "Aus Layout", subjectId: null, roomId: null, rows: 0, cols: 0, preset: "leer", layoutId: l106!.id }, TODAY);
    const [plan] = await h.db.select().from(sitzplanPlans).where(eq(sitzplanPlans.id, planId));
    expect(plan).toMatchObject({ rows: 6, cols: 8, roomId: "106", layoutId: l106!.id });
    expect(plan!.desks).toEqual(seatKeys(l106!.cells));
    expect(await planLayoutSource(h.db, plan!)).toMatchObject({ name: "Standard", roomId: "106", changed: false });
    // Layout ändern: Sitzplan bleibt, wie er war
    await new Promise((r) => setTimeout(r, 5));
    await updateRoomLayout(h.db, await p(SABINE), l106!.id, { name: "Standard", variant: "frei", rows: 2, cols: 4, cells: SMALL });
    const [after] = await h.db.select().from(sitzplanPlans).where(eq(sitzplanPlans.id, planId));
    expect(after).toMatchObject({ rows: 6, cols: 8 });
    expect(after!.desks).toEqual(plan!.desks);
    expect(await planLayoutSource(h.db, after!)).toMatchObject({ changed: true });
    // Layout löschen: Sitzplan bleibt, Verweis entfällt
    const sabine = await p(SABINE);
    await createRoomLayout(h.db, sabine, "106", { name: "Zweites", variant: "reihen", rows: 2, cols: 4, cells: SMALL });
    await deleteRoomLayout(h.db, sabine, l106!.id);
    const [gone] = await h.db.select().from(sitzplanPlans).where(eq(sitzplanPlans.id, planId));
    expect(gone).toMatchObject({ rows: 6, cols: 8, layoutId: null });
    expect(gone!.desks).toEqual(plan!.desks);
    // unbekanntes Layout bzw. Schülerin: kein Plan
    await expect(createPlan(h.db, jana, { groupId: "g-7b", title: "X", subjectId: null, roomId: null, rows: 0, cols: 0, preset: "leer", layoutId: "gibtsnicht" }, TODAY)).rejects.toMatchObject({
      fieldErrors: { preset: /Raumlayout/ },
    });
    expect((await h.db.select().from(roomLayouts).where(eq(roomLayouts.roomId, "106"))).map((l) => l.name)).toEqual(["Zweites"]);
  });

  it("RS-09: Prüfungsplätze – Variante Prüfung vor jedem zweiten Platz; Warnung bei Überbelegung nur für Beschäftigte", async () => {
    const seats = await examSeatsByRoom(h.db, ["NW2", "106", "TH1"]);
    expect(seats.get("NW2")).toEqual({ seats: 4, layoutName: "Klausur", source: "pruefung" });
    expect(seats.get("106")).toEqual({ seats: 2, layoutName: "Zweites", source: "jeder-zweite" });
    expect(seats.has("TH1")).toBe(false);
    expect(examSeatWarning(3, seats.get("NW2"), "NW2")).toBeNull();
    expect(examSeatWarning(5, seats.get("NW2"), "NW2")).toMatch(/5 Schüler:innen, aber nur 4 Prüfungsplätze/);
    const jana = await p(JANA);
    const id = await createExam(
      h.db,
      jana,
      { groupId: "g-7b", subjectId: "D", kind: "klassenarbeit", title: "Arbeit im Fachraum", date: "2026-10-12", periodFrom: 1, periodTo: 2, roomId: "NW2", override: false },
      "2026-10-03",
    );
    const warn = await examSeatWarnings(h.db, jana, [{ id, groupId: "g-7b", roomId: "NW2" }]);
    expect(warn.get(id)).toMatch(/Raum NW2: \d+ Schüler:innen, aber nur 4 Prüfungsplätze \(Layout „Klausur“\)/);
    expect((await examSeatWarnings(h.db, await p(LEA), [{ id, groupId: "g-7b", roomId: "NW2" }])).size).toBe(0);
    expect((await examSeatWarnings(h.db, jana, [{ id, groupId: "g-7b", roomId: null }])).size).toBe(0);
    await expect(
      createExam(h.db, jana, { groupId: "g-7b", subjectId: "D", kind: "test", title: "X", date: "2026-10-13", periodFrom: 1, periodTo: 1, roomId: "GIBTS", override: false }, "2026-10-03"),
    ).rejects.toMatchObject({ fieldErrors: { roomId: /Raum/ } });
  });
});
