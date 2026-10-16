import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@schulos/server/pairing";
import { createUserWithPassword } from "@/auth/auth";
import type { DbHandle } from "@/db/client";
import { auditLog, instances, type Instance } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { confirmRestore, createRestoreJob, listRestoreJobs, MAX_CODE_ATTEMPTS, openRestoreRequest, recordRestoreReport, rejectRestore, RestoreRejected } from "./service";

const SNAP = { snapshotId: "7da39b69e2fa4f8c".padEnd(64, "0"), snapshotShort: "7da39b69", snapshotTime: new Date("2026-10-04T23:30:00Z") };
const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");

describe("Wiederherstellungsaufträge", () => {
  let h: DbHandle;
  let inst: Instance;
  beforeAll(async () => {
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "adm", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash: "x:y" });
    await h.db.insert(instances).values({ id: "i1", name: "Lindenhof", restUser: "i-1", repoPasswordEnc: "x", agentTokenHash: sha256Hex("t") });
    inst = (await h.db.select().from(instances))[0]!;
  });
  afterAll(() => h.close());

  it("Auftrag → im Plan sichtbar → Bestätigung nur mit dem richtigen Code → laufen → fertig", async () => {
    const { id, code } = await createRestoreJob(h.db, "adm", inst, { ...SNAP, scope: "komplett" });
    expect(code).toMatch(/^\d{6}$/);
    expect(await openRestoreRequest(h.db, "i1")).toMatchObject({ id, scope: "komplett", status: "wartet", requestedBy: "Ina Tech", snapshotShort: "7da39b69" });

    await expect(recordRestoreReport(h.db, inst, { id, status: "laeuft" })).rejects.toThrow(RestoreRejected); // unbestätigt darf nichts laufen
    expect(await confirmRestore(h.db, inst, id, wrong(code))).toBe("falsch");
    expect(await confirmRestore(h.db, inst, id, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe("bestaetigt");
    expect((await openRestoreRequest(h.db, "i1"))!.status).toBe("bestaetigt");

    // der Agent darf nur „läuft/fertig/fehlgeschlagen“ melden – nicht zurück auf „wartet“ (B-55)
    await expect(recordRestoreReport(h.db, inst, { id, status: "wartet" as never })).rejects.toThrow("Unbekannter Status");
    await recordRestoreReport(h.db, inst, { id, status: "laeuft" });
    expect(await openRestoreRequest(h.db, "i1")).toBeNull();
    await expect(createRestoreJob(h.db, "adm", inst, { ...SNAP, scope: "dateien" })).rejects.toThrow("läuft schon");
    await recordRestoreReport(h.db, inst, { id, status: "fertig", details: { sicherungVorher: "ok" } });
    expect((await listRestoreJobs(h.db, "i1"))[0]).toMatchObject({ status: "fertig", details: { sicherungVorher: "ok" } });
    const actions = (await h.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["wiederherstellung.angefordert", "wiederherstellung.bestaetigt", "wiederherstellung.fertig"]));
  });

  it("nach 5 falschen Codes verworfen; ein neuer Auftrag ersetzt den offenen; Ablehnung vom Hauptsystem", async () => {
    const a = await createRestoreJob(h.db, "adm", inst, { ...SNAP, scope: "dateien" });
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) expect(await confirmRestore(h.db, inst, a.id, wrong(a.code))).toBe("falsch");
    expect(await confirmRestore(h.db, inst, a.id, wrong(a.code))).toBe("verworfen");
    await expect(confirmRestore(h.db, inst, a.id, a.code)).rejects.toThrow(RestoreRejected);

    const b = await createRestoreJob(h.db, "adm", inst, { ...SNAP, scope: "dateien" });
    const c = await createRestoreJob(h.db, "adm", inst, { ...SNAP, scope: "komplett" });
    expect((await listRestoreJobs(h.db, "i1")).find((j) => j.id === b.id)).toMatchObject({ status: "abgelehnt", error: "durch neuen Auftrag ersetzt" });
    await rejectRestore(h.db, inst, c.id, null, "auf dem Hauptsystem abgelehnt");
    expect(await openRestoreRequest(h.db, "i1")).toBeNull();
    await expect(createRestoreJob(h.db, "adm", inst, { ...SNAP, snapshotId: "kein-hex!", scope: "komplett" })).rejects.toThrow("Stand unbekannt");
    await expect(createRestoreJob(h.db, "adm", inst, { ...SNAP, snapshotId: "7da39b69", scope: "komplett" })).rejects.toThrow("Stand unbekannt"); // nur volle ID (SEC-06)
  });
});
