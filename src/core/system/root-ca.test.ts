import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { rootCaInfo } from "@schulos/server/root-ca";
import { ROOT_CA_FILE } from "@schulos/server/system";
import type { BackupStatus } from "@/core/backup/status";
import type { DbHandle } from "@/core/db/client";
import { auditLog, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { collectAlarms } from "./alarms";
import { confirmRootCa, readRootCa, RootCaError, rootCaState } from "./root-ca";

const fixtures = path.join(import.meta.dirname, "../../../packages/server/test-fixtures");
const ca = readFileSync(path.join(fixtures, "ca.pem"), "utf8");
const other = readFileSync(path.join(fixtures, "other-ca.pem"), "utf8");
const A = rootCaInfo(ca)!;
const B = rootCaInfo(other)!;
const now = new Date("2026-11-02T10:00:00Z");
const backup: BackupStatus = { paired: true, health: "ok", lastOkAt: now, lastRun: null, contactError: null, lastContactAt: now, runningSince: null, restoreRequest: null, lastRestore: null };

let h: DbHandle | undefined;
let dir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Schul-Zertifikat in der App (CA-03)", () => {
  it("liest nur die abgelegte Root; fehlt sie oder ist sie keine CA → null", () => {
    dir = mkdtempSync(path.join(tmpdir(), "root-ca-"));
    expect(readRootCa(dir)).toBeNull();
    writeFileSync(path.join(dir, ROOT_CA_FILE), ca);
    expect(readRootCa(dir)?.info).toEqual(A);
    expect(readRootCa(dir)?.pem).not.toContain("PRIVATE");
    writeFileSync(path.join(dir, ROOT_CA_FILE), readFileSync(path.join(fixtures, "localhost.pem")));
    expect(readRootCa(dir)).toBeNull();
  });

  it("erste Root still übernommen, Wechsel → Alarm bis zur Bestätigung (mit Protokoll)", async () => {
    h = await createSeededTestDb();
    const [{ id: admin }] = (await h.db.select({ id: users.id }).from(users).where(eq(users.username, "admin"))) as [{ id: string }];
    expect(await rootCaState(h.db, null, now)).toEqual({ current: null, confirmed: null, changed: false });
    const first = await rootCaState(h.db, A, now);
    expect(first).toMatchObject({ changed: false, confirmed: { fingerprint: A.fingerprint, by: null } });
    expect(collectAlarms({ backup, system: null, now, rootCa: first })).toEqual([]);

    const changed = await rootCaState(h.db, B, now);
    expect(changed.changed).toBe(true);
    const [alarm, ...rest] = collectAlarms({ backup, system: null, now, rootCa: changed });
    expect(rest).toEqual([]);
    expect(alarm!.key).toMatch(/^zertifikat:root:[0-9A-F]{16}$/);
    expect(alarm!.title).toBe("Schul-Zertifikat gewechselt – Geräte müssen neu vertrauen");
    expect(alarm!.detail).toContain(B.fingerprint);

    // nur genau die aktuelle Root lässt sich bestätigen
    await expect(confirmRootCa(h.db, admin, A.fingerprint, B, now)).rejects.toBeInstanceOf(RootCaError);
    await expect(confirmRootCa(h.db, admin, B.fingerprint, null, now)).rejects.toBeInstanceOf(RootCaError);
    await confirmRootCa(h.db, admin, B.fingerprint, B, now);
    const after = await rootCaState(h.db, B, now);
    expect(after).toMatchObject({ changed: false, confirmed: { fingerprint: B.fingerprint, by: admin } });
    expect(collectAlarms({ backup, system: null, now, rootCa: after })).toEqual([]);
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.system.zertifikat_bestaetigt"));
    expect(entry).toMatchObject({ actorId: admin, meta: { fingerabdruck: B.fingerprint, vorher: A.fingerprint } });
  });
});
