// RS-11: Tür-QR – Codes (nicht erratbar, eindeutig, stabil), Neuerzeugen entwertet den alten Code, Rechte (Raumdaten pflegen,
// Verantwortliche nur für den eigenen Raum, Lehrkraft/Schülerin nicht), Auflösung der Kurz-URL, Umbenennen/Löschen des Raums.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, labelCodes } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { LABEL_CODE_ALPHABET, LABEL_CODE_LENGTH, labelPath, newLabelCode, normalizeLabelCode, paginate, signFormat } from "@/core/etiketten/codes";
import { labelUrl, qrSvg } from "@/core/etiketten/qr";
import { ensureLabelCodes, resolveLabelCode } from "@/core/etiketten/service";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { isPublicPath } from "@/core/public-paths";
import { roomHistory } from "./raumverantwortliche";
import { createRoom, deleteRoom, updateRoom } from "./rooms";
import { canPrintDoorSigns, doorSigns, printableRooms, renewRoomCode, roomCode } from "./tuer-qr";

const SABINE = "u-sabine.kowalski"; // Sekretariat: Raumdaten pflegen (alle Räume)
const KLAUS = "u-klaus.berger"; // Hausmeister: Recht über die Gruppe Hausmeisterei
const ALBERS = "u-henrik.albers"; // Lehrkraft, verantwortlich für NW2
const JANA = "u-jana.brandt"; // Lehrkraft ohne Verantwortung
const LEA = "u-lea.schaefer"; // Schülerin

describe("RS-11: Tür-QR", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("rein: Code aus 16 Zeichen ohne Verwechsler, gleichverteilt, eindeutig; Normalisieren; Kurz-URL; Druckseiten", () => {
    expect(LABEL_CODE_ALPHABET).toHaveLength(32);
    expect(LABEL_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    // feste Bytes → fester Code (jedes Byte mod 32)
    expect(newLabelCode((n) => Uint8Array.from({ length: n }, (_, i) => i * 33))).toBe("0123456789ABCDEF".replace(/./g, (_, i: number) => LABEL_CODE_ALPHABET[(i * 33) % 32]!));
    const many = Array.from({ length: 2000 }, () => newLabelCode());
    expect(new Set(many).size).toBe(2000);
    for (const c of many.slice(0, 50)) expect(c).toMatch(new RegExp(`^[${LABEL_CODE_ALPHABET}]{${LABEL_CODE_LENGTH}}$`));
    // 80 Bit: jedes Zeichen kommt an jeder Stelle vor (grobe Gleichverteilung)
    expect(new Set(many.map((c) => c[0])).size).toBe(32);
    const code = many[0]!;
    expect(normalizeLabelCode(code.toLowerCase())).toBe(code);
    expect(normalizeLabelCode(` ${code} `)).toBe(code);
    expect(normalizeLabelCode("O0000000000000IL")).toBe("0000000000000011");
    expect(normalizeLabelCode(code.slice(1))).toBeNull();
    expect(normalizeLabelCode("../../etc/passwd")).toBeNull();
    expect(normalizeLabelCode("UUUUUUUUUUUUUUUU")).toBeNull();
    expect(labelPath("raum", code)).toBe(`/r/${code}`);
    expect(labelUrl("raum", code)).toMatch(new RegExp(`/r/${code}$`));
    expect(qrSvg(labelUrl("raum", code))).toMatch(/^<svg /);
    expect(paginate([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    // `/r/…` ist nie öffentlich: ohne Sitzung leitet der Proxy für jeden Code gleich auf die Anmeldung um
    expect(isPublicPath(`/r/${code}`)).toBe(false);
    expect(isPublicPath("/r/")).toBe(false);
    expect(signFormat("a4")).toBe("a4");
    expect(signFormat("x")).toBe("a5");
  });

  it("Rechte: Raumdaten-Recht für alle Räume, Verantwortliche nur für den eigenen, Lehrkraft und Schülerin nichts", async () => {
    expect(await canPrintDoorSigns(h.db, await p(SABINE))).toBe(true);
    expect(await canPrintDoorSigns(h.db, await p(KLAUS))).toBe(true);
    expect(await canPrintDoorSigns(h.db, await p(ALBERS))).toBe(true);
    expect(await canPrintDoorSigns(h.db, await p(JANA))).toBe(false);
    expect(await canPrintDoorSigns(h.db, await p(LEA))).toBe(false);
    expect((await printableRooms(h.db, await p(ALBERS))).map((r) => r.id)).toEqual(["NW2"]);
    expect((await doorSigns(h.db, await p(ALBERS), ["NW2", "KU1"])).map((s) => s.roomId)).toEqual(["NW2"]);
    expect(await doorSigns(h.db, await p(JANA), ["NW2"])).toEqual([]);
    expect(await doorSigns(h.db, await p(LEA), "alle")).toEqual([]);
    await expect(renewRoomCode(h.db, await p(ALBERS), "KU1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(renewRoomCode(h.db, await p(JANA), "NW2")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(renewRoomCode(h.db, await p(LEA), "NW2")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await roomCode(h.db, await p(JANA), "NW2")).toBeNull();
    // Lehrkraft und Schülerin haben keinen Code erzeugt (nur ALBERS für NW2)
    expect((await h.db.select({ roomId: labelCodes.roomId }).from(labelCodes)).map((r) => r.roomId)).toEqual(["NW2"]);
  });

  it("Codes stabil: Nachdruck behält den Code, je Raum genau einer, Audit nur beim Anlegen; Auflösung", async () => {
    const admin = await p(SABINE);
    const first = await doorSigns(h.db, admin, ["KU1", "MU1", "NW2"]);
    expect(first.map((s) => s.roomId)).toEqual(["NW2", "KU1", "MU1"]);
    const again = await doorSigns(h.db, admin, ["KU1", "MU1", "NW2"]);
    expect(again.map((s) => s.code)).toEqual(first.map((s) => s.code));
    expect(new Set(first.map((s) => s.code)).size).toBe(3);
    expect(await roomCode(h.db, admin, "KU1")).toBe(first[1]!.code);
    const created = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.qr.create"));
    expect(created.map((a) => a.target).sort()).toEqual(["KU1", "MU1", "NW2"]);
    // Gebäude-Sammeldruck: alle aktiven Räume eines Gebäudes, Kopf/Etage dabei
    const pav = (await printableRooms(h.db, admin)).find((r) => r.id === "KU1")!.buildingId!;
    const signs = await doorSigns(h.db, admin, "alle", { buildingId: pav });
    expect(signs.map((s) => [s.roomId, s.building, s.floor])).toEqual([
      ["KU1", "Pavillon", "EG"],
      ["MU1", "Pavillon", "EG"],
    ]);
    // Auflösung: Kleinschreibung geht, falsche Art/unbekannt/kein Format → null
    expect(await resolveLabelCode(h.db, "raum", first[1]!.code.toLowerCase())).toBe("KU1");
    expect(await resolveLabelCode(h.db, "raum", newLabelCode())).toBeNull();
    expect(await resolveLabelCode(h.db, "raum", "KU1")).toBeNull();
  });

  it("Neu erzeugen entwertet den alten Code (auch als Verantwortliche); Historie im Steckbrief ohne Code", async () => {
    const old = (await doorSigns(h.db, await p(SABINE), ["NW2"]))[0]!.code;
    const fresh = await renewRoomCode(h.db, await p(ALBERS), "NW2");
    expect(fresh).not.toBe(old);
    expect(await resolveLabelCode(h.db, "raum", old)).toBeNull();
    expect(await resolveLabelCode(h.db, "raum", fresh)).toBe("NW2");
    expect((await doorSigns(h.db, await p(SABINE), ["NW2"]))[0]!.code).toBe(fresh);
    const history = await roomHistory(h.db, await p(SABINE), "NW2");
    expect(history.map((x) => x.label)).toEqual(expect.arrayContaining(["Tür-QR eines Raums neu erzeugt", "Tür-QR eines Raums angelegt"]));
    const renewals = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.qr.renew"));
    expect(JSON.stringify(renewals)).not.toContain(fresh);
    expect(JSON.stringify(renewals)).not.toContain(old);
  });

  it("Raum umbenennen zieht den Code mit, Löschen nimmt ihn mit; eindeutiger Index je Raum", async () => {
    await createRoom(h.db, SABINE, { code: "QR1", name: "Testraum", kind: "sonstiges", accessible: false, active: true });
    const { codes } = await ensureLabelCodes(h.db, "raum", ["QR1"]);
    const code = codes.get("QR1")!;
    await updateRoom(h.db, SABINE, "QR1", { code: "QR2", name: "Testraum", kind: "sonstiges", accessible: false, active: true });
    expect(await resolveLabelCode(h.db, "raum", code)).toBe("QR2");
    await expect(h.db.insert(labelCodes).values({ code: newLabelCode(), kind: "raum", roomId: "QR2" })).rejects.toThrow();
    await expect(h.db.insert(labelCodes).values({ code: newLabelCode(), kind: "raum" })).rejects.toThrow();
    await deleteRoom(h.db, SABINE, "QR2");
    expect(await resolveLabelCode(h.db, "raum", code)).toBeNull();
    expect(await h.db.select().from(labelCodes).where(eq(labelCodes.code, code))).toEqual([]);
  });
});
