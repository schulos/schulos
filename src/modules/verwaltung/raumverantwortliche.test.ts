// RS-06: Raumverantwortliche, Recht „Raumdaten pflegen“ und Historie (Service-Ebene, Demo-Schule).
// Rechte-Matrix: Recht (Sekretariat über die Rolle, Hausmeisterei über die Gruppe) vs. Verantwortliche (Person bzw. Gruppe) vs.
// normale Lehrkraft vs. Schülerin; fremder Raum verboten; Stammdaten bleiben bei verwaltung.school; Kontolöschung; Historie ohne Texte.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, roomResponsibles, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { ForbiddenError, hasPermission, loadPermissions, requiresTwoFactor } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { addRoomEquipment, roomEquipment, setRoomEquipmentQuantities } from "./raumausstattung";
import { addRoomPhoto, deleteRoomPhoto, listRoomPhotos } from "./raumfotos";
import { ROOM_DATA_PERMISSION, canEditRoomInfo, canMaintainAllRooms } from "./raum-rechte";
import { roomInfoForm, setRoomInfo } from "./raumsteckbrief";
import { HISTORY_ACTIONS, addResponsible, listResponsibles, removeResponsible, responsibleCandidates, responsiblesFor, roomHistory } from "./raumverantwortliche";
import { ValidationError } from "./users";

const SABINE = "u-sabine.kowalski"; // Sekretariat: verwaltung.school + verwaltung.rooms_info über die Rolle
const KLAUS = "u-klaus.berger"; // Hausmeister (Rolle personal): verwaltung.rooms_info über die Gruppe Hausmeisterei
const ALBERS = "u-henrik.albers"; // Lehrkraft, im Demo-Seed verantwortlich für NW2 (Person)
const YILMAZ = "u-murat.yilmaz"; // Lehrkraft in der Fachschaft Informatik, die für IF1 verantwortlich ist (Gruppe)
const JANA = "u-jana.brandt"; // Lehrkraft ohne Verantwortung
const LEA = "u-lea.schaefer"; // Schülerin
const SECRET = "Code 4711 am Schrank";

async function jpeg(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 30, g: 120, b: 90 } } }).jpeg().toBuffer());
}

describe("RS-06: Raumverantwortliche und Recht „Raumdaten pflegen“", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const p = (id: string) => loadPermissions(h.db, id);
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-rs06-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Demo-Seed: Sekretariat (Rolle) und Hausmeisterei (Gruppe) haben das Recht, Lehrkräfte und Schüler:innen nicht", async () => {
    expect(hasPermission(await p(SABINE), ROOM_DATA_PERMISSION)).toBe(true);
    expect(hasPermission(await p(KLAUS), ROOM_DATA_PERMISSION)).toBe(true);
    for (const who of [ALBERS, YILMAZ, JANA, LEA]) expect(hasPermission(await p(who), ROOM_DATA_PERMISSION)).toBe(false);
    expect((await listResponsibles(h.db, "NW2")).map((r) => [r.kind, r.refId, r.note])).toEqual([["person", ALBERS, "Fachraumleitung Chemie"]]);
    expect((await listResponsibles(h.db, "IF1")).map((r) => [r.kind, r.refId])).toEqual([["gruppe", "g-fs-if"]]);
  });

  it("Rechte-Matrix canEditRoomInfo: Recht für alle Räume, Verantwortliche nur für ihren Raum, sonst niemand", async () => {
    const matrix: [string, string, boolean][] = [
      [SABINE, "NW2", true],
      [SABINE, "101", true],
      [KLAUS, "NW2", true],
      [KLAUS, "101", true],
      [ALBERS, "NW2", true], // Person
      [ALBERS, "NW1", false], // fremder Raum
      [ALBERS, "IF1", false],
      [YILMAZ, "IF1", true], // über die Gruppe
      [YILMAZ, "NW2", false],
      [JANA, "NW2", false],
      [JANA, "IF1", false],
      [LEA, "NW2", false],
      [LEA, "IF1", false],
    ];
    for (const [who, room, ok] of matrix) expect([who, room, await canEditRoomInfo(h.db, await p(who), room)]).toEqual([who, room, ok]);
    expect(await canEditRoomInfo(h.db, await p(ALBERS), "")).toBe(false);
  });

  it("Verantwortliche pflegen Infofelder, Ausstattung und Fotos ihres Raums – im fremden Raum ForbiddenError", async () => {
    const albers = await p(ALBERS);
    expect(await setRoomInfo(h.db, albers, "NW2", { technik: `Beamer über HDMI; ${SECRET}` })).toBe(1);
    await addRoomEquipment(h.db, albers, "NW2", { name: "Schutzbrillen", quantity: "30" });
    expect((await roomEquipment(h.db, "NW2")).find((e) => e.name === "Schutzbrillen")?.quantity).toBe(30);
    const photoId = await addRoomPhoto(h.db, storage, albers, "NW2", { photo: await jpeg(), caption: "Abzug" });
    await deleteRoomPhoto(h.db, storage, albers, photoId);
    expect(await listRoomPhotos(h.db, albers, "NW2")).toEqual([]);

    await expect(setRoomInfo(h.db, albers, "NW1", { technik: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addRoomEquipment(h.db, albers, "NW1", { name: "Beamer" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setRoomEquipmentQuantities(h.db, albers, "NW1", { beamer: "2" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addRoomPhoto(h.db, storage, albers, "NW1", { photo: await jpeg() })).rejects.toBeInstanceOf(ForbiddenError);
    // Gruppe: Mitglied der Fachschaft pflegt IF1
    expect(await setRoomInfo(h.db, await p(YILMAZ), "IF1", { nutzung: "PCs nach der Stunde herunterfahren" })).toBe(1);
    for (const who of [JANA, LEA]) {
      await expect(setRoomInfo(h.db, await p(who), "NW2", { technik: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addRoomEquipment(h.db, await p(who), "IF1", { name: "Beamer" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Hausmeisterei (nur das Recht, keine Stammdaten) pflegt jeden Raum
    expect(await setRoomInfo(h.db, await p(KLAUS), "101", { lueftung: "Fenster klemmen, Meldung läuft" })).toBe(1);
  });

  it("Stammdaten bleiben bei verwaltung.school: weder Recht noch Verantwortung geben es, Verantwortliche tragen niemanden ein", async () => {
    for (const who of [KLAUS, ALBERS, YILMAZ]) expect(hasPermission(await p(who), "verwaltung.school")).toBe(false);
    expect(canMaintainAllRooms(await p(ALBERS))).toBe(false);
    await expect(addResponsible(h.db, await p(ALBERS), "NW2", { target: `u:${JANA}` })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addResponsible(h.db, await p(LEA), "NW2", { target: `u:${LEA}` })).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = await listResponsibles(h.db, "NW2");
    await expect(removeResponsible(h.db, await p(ALBERS), row!.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listResponsibles(h.db, "NW2")).toHaveLength(1);
  });

  it("Gesperrte bzw. Schüler:innen bleiben ohne Pflegerecht, auch wenn eine Zuordnung besteht", async () => {
    // Zuordnung an der Prüfung vorbei: die Rechteprüfung verlangt trotzdem Beschäftigte ohne Sperre
    await h.db.insert(roomResponsibles).values({ roomId: "MU1", userId: LEA });
    expect(await canEditRoomInfo(h.db, await p(LEA), "MU1")).toBe(false);
    await h.db.delete(roomResponsibles).where(and(eq(roomResponsibles.roomId, "MU1"), eq(roomResponsibles.userId, LEA)));
    const albers = await p(ALBERS);
    expect(await canEditRoomInfo(h.db, { ...albers, locked: true }, "NW2")).toBe(false);
    expect(await canEditRoomInfo(h.db, { ...albers, passwordChangePending: true }, "NW2")).toBe(false);
  });

  it("Eintragen prüft: nur Beschäftigte, nur Fachschaft/Gremium/frei, keine Dubletten, Hinweis höchstens 120 Zeichen; Audit ohne Texte", async () => {
    const sabine = await p(SABINE);
    const fail = async (target: string, note?: string) => {
      const err = await addResponsible(h.db, sabine, "KU1", { target, note }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      return Object.keys((err as ValidationError).fieldErrors);
    };
    expect(await fail(`u:${LEA}`)).toEqual(["target"]);
    expect(await fail("g:g-7b")).toEqual(["target"]); // Klasse
    expect(await fail("u:u-gibt-es-nicht")).toEqual(["target"]);
    expect(await fail("irgendwas")).toEqual(["target"]);
    expect(await fail(`u:${JANA}`, "x".repeat(121))).toEqual(["note"]);
    const id = await addResponsible(h.db, sabine, "KU1", { target: `u:${JANA}`, note: "  Fachraumleitung   Kunst " });
    expect(await fail(`u:${JANA}`)).toEqual(["target"]);
    expect((await listResponsibles(h.db, "KU1")).map((r) => [r.name, r.note])).toEqual([["Jana Brandt", "Fachraumleitung Kunst"]]);
    expect(await canEditRoomInfo(h.db, await p(JANA), "KU1")).toBe(true);
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.responsible.add")).orderBy(desc(auditLog.id)).limit(1);
    expect(entry).toMatchObject({ actorId: SABINE, target: "KU1", meta: { userId: JANA } });
    await removeResponsible(h.db, sabine, id);
    expect(await canEditRoomInfo(h.db, await p(JANA), "KU1")).toBe(false);
    // Hausmeisterei darf mit dem Recht ebenfalls eintragen
    const g = await addResponsible(h.db, await p(KLAUS), "KU1", { target: "g:g-fs-ku" });
    await removeResponsible(h.db, await p(KLAUS), g);
    const cand = await responsibleCandidates(h.db);
    expect(cand.people.some((x) => x.id === JANA)).toBe(true);
    expect(cand.people.some((x) => x.id === LEA)).toBe(false);
    expect(cand.groups.some((x) => x.id === "g-fs-if")).toBe(true);
    expect(cand.groups.some((x) => x.id === "g-7b")).toBe(false);
  });

  it("Sichtbarkeit: Verantwortliche sehen nur Beschäftigte", async () => {
    expect(await responsiblesFor(h.db, await p(LEA), "NW2")).toBeNull();
    expect((await responsiblesFor(h.db, await p(JANA), "NW2"))!.map((r) => r.name)).toEqual(["Henrik Albers"]);
    expect((await responsiblesFor(h.db, await p(KLAUS), "IF1"))!.map((r) => r.name)).toEqual(["Fachschaft Informatik"]);
  });

  it("Historie: nur für Pflegende des Raums, aus dem Audit, ohne Texte der Infofelder", async () => {
    const history = await roomHistory(h.db, await p(ALBERS), "NW2");
    const labels = history.map((e) => e.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Infofelder eines Raums geändert", "Ausstattung eines Raums geändert", "Raumfoto hochgeladen", "Raumfoto gelöscht"]),
    );
    const info = history.find((e) => e.label === "Infofelder eines Raums geändert")!;
    expect(info).toMatchObject({ detail: "Technik/Netz", actor: "Henrik Albers" });
    expect(history.find((e) => e.label === "Ausstattung eines Raums geändert")!.detail).toBe("Schutzbrillen: 30");
    // die Texte stehen nicht im Audit und nicht in der Historie – im Raum aber schon
    expect(JSON.stringify(history)).not.toContain("4711");
    expect((await roomInfoForm(h.db, "NW2")).find((f) => f.id === "technik")!.value).toContain("4711");
    const rows = await h.db.select({ meta: auditLog.meta }).from(auditLog).where(eq(auditLog.target, "NW2"));
    expect(JSON.stringify(rows)).not.toContain("4711");
    // nur Vorgänge dieses Raums, keine Katalog-/Infofeld-Verwaltung
    expect(history.every((e) => !e.label.includes("Katalog") && !e.label.includes("Infofeld für Räume"))).toBe(true);
    expect((await roomHistory(h.db, await p(SABINE), "KU1")).map((e) => e.label)).toEqual(["Raumverantwortliche entfernt", "Raumverantwortliche eingetragen", "Raumverantwortliche entfernt", "Raumverantwortliche eingetragen"]);
    expect((await roomHistory(h.db, await p(SABINE), "KU1"))[3]!.detail).toBe("Jana Brandt");
    expect(HISTORY_ACTIONS.every((a) => a.startsWith("verwaltung.room."))).toBe(true);
    for (const who of [JANA, LEA]) await expect(roomHistory(h.db, await p(who), "NW2")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(roomHistory(h.db, await p(ALBERS), "NW1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Recht „Raumdaten pflegen“ ist ein Verwaltungsrecht: Zwei-Faktor-Pflicht sofort (wie verwaltung.*)", () => {
    expect(requiresTwoFactor("personal", [ROOM_DATA_PERMISSION])).toBe(true);
  });

  it("Auskunft enthält die eigene Zuordnung; Kontolöschung entfernt sie (LK-KONTO), Gruppenzuordnungen bleiben", async () => {
    const data = await collectPersonalData(h.db, ALBERS);
    expect(data!.sections.find((s) => s.table === "room_responsibles")!.rows).toEqual([expect.objectContaining({ room_id: "NW2", note: "Fachraumleitung Chemie" })]);
    expect(await deleteAccounts(h.db, [ALBERS])).toBe(1);
    expect(await h.db.select().from(users).where(eq(users.id, ALBERS))).toEqual([]);
    expect(await listResponsibles(h.db, "NW2")).toEqual([]);
    expect(await h.db.select().from(roomResponsibles).where(eq(roomResponsibles.userId, ALBERS))).toEqual([]);
    expect(await listResponsibles(h.db, "IF1")).toHaveLength(1);
    // Historie bleibt, die handelnde Person ist pseudonymisiert
    const history = await roomHistory(h.db, await p(SABINE), "NW2");
    expect(history.find((e) => e.label === "Infofelder eines Raums geändert")!.actor).toMatch(/^Pseudonym /);
  });
});
