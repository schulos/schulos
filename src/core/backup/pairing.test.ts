import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aad, open, pairingKey, pairingLookup, seal, type PairingClaim } from "@schulos/server/pairing";
import type { RequestFn } from "@schulos/server/pairing-client";
import { createUserWithPassword } from "@/core/auth/auth";
import type { DbHandle } from "@/core/db/client";
import { auditLog } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { confirmRecoveryKey, PAIRING_FILE, pairingView, pairNow, PairingError, readPairing, unpairLocal } from "./pairing";

const CODE = "K7Q2-9MXA-4RT1";

/** Backupserver-Attrappe: antwortet nach Protokoll (der echte Server ist in apps/backup über TLS getestet). */
function fakeBackup(): RequestFn {
  const lookup = pairingLookup(CODE);
  const key = pairingKey(CODE);
  let used = false;
  return (async (url: string, opts: { body?: unknown }) => {
    if (url.endsWith("/api/pairing/hello")) return { status: 200, body: { sealed: seal(key, { caPem: null, serverName: "Backup" }, aad.hello(lookup)) } };
    if (used) return { status: 404, body: { error: "x" } };
    used = true;
    const req = open<PairingClaim>(key, (opts.body as { request: string }).request, aad.claim(lookup));
    const result = { nonce: req.nonce, instanceId: "inst-1", repoUrl: "https://b/restic/i-1/", restUser: "i-1", restPassword: "rp", agentToken: "tok" };
    return { status: 200, body: { sealed: seal(key, result, aad.claimOk(lookup)) } };
  }) as RequestFn;
}

describe("Kopplung im Hauptsystem", () => {
  let h: DbHandle;
  let dir: string;
  beforeAll(async () => {
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "admin", name: "Admin IT", username: "admin", role: "admin" }, { hash: "x:y" });
    dir = mkdtempSync(path.join(tmpdir(), "schulos-cfg-"));
  });
  afterAll(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("speichert die Zugangsdaten als Datei (0600), zeigt den Wiederherstellungsschlüssel bis zur Bestätigung", async () => {
    const input = { backupUrl: "https://backup.schule.de/", code: CODE, instanceName: "Lindenhof", mainUrl: "https://schulos.schule.de" };
    const p = await pairNow(h.db, "admin", input, { dir, request: fakeBackup() });
    expect(p).toMatchObject({ backupUrl: "https://backup.schule.de", instanceId: "inst-1", restUser: "i-1", agentToken: "tok" });
    expect(readPairing(dir)).toEqual(p);
    if (process.platform !== "win32") expect(statSync(path.join(dir, PAIRING_FILE)).mode & 0o777).toBe(0o600);

    const view = pairingView(readPairing(dir))!;
    expect(view.recoveryKeyToConfirm).toBe(p.recoveryKey);
    expect(JSON.stringify(view)).not.toContain(p.repoPassword);
    expect(JSON.stringify(view)).not.toContain("tok");

    await confirmRecoveryKey(h.db, "admin", dir);
    expect(pairingView(readPairing(dir))!.recoveryKeyToConfirm).toBeNull();

    await expect(pairNow(h.db, "admin", input, { dir, request: fakeBackup() })).rejects.toThrow(/schon gekoppelt/);
    await unpairLocal(h.db, "admin", dir);
    expect(readPairing(dir)).toBeNull();

    const actions = (await h.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(["verwaltung.backup.gekoppelt", "verwaltung.backup.wiederherstellungsschluessel", "verwaltung.backup.entkoppelt"]);
  });

  it("protokolliert Fehlschläge, speichert dann nichts", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "schulos-cfg-"));
    const used = fakeBackup();
    await pairNow(h.db, "admin", { backupUrl: "https://b", code: CODE, instanceName: "x", mainUrl: "" }, { dir: d, request: used });
    rmSync(path.join(d, PAIRING_FILE));
    await expect(pairNow(h.db, "admin", { backupUrl: "https://b", code: CODE, instanceName: "x", mainUrl: "" }, { dir: d, request: used })).rejects.toThrow(PairingError);
    expect(readPairing(d)).toBeNull();
    const failed = (await h.db.select().from(auditLog)).filter((a) => a.action === "verwaltung.backup.kopplung_fehlgeschlagen");
    expect(failed).toHaveLength(1);
    rmSync(d, { recursive: true, force: true });
  });
});
