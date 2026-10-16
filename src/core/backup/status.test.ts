import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalProblem, emptyAgentState, RESTORE_APPROVAL_FILE, type AgentState, type RestoreRequest } from "@schulos/server/agent-api";
import type { StoredPairing } from "@schulos/server/pairing-client";
import { RequestError, type requestJson } from "@schulos/server/pinned-request";
import { createUserWithPassword } from "@/core/auth/auth";
import type { DbHandle } from "@/core/db/client";
import { auditLog } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { PAIRING_FILE } from "./pairing";
import { AGENT_STATE_FILE, backupStatus, BackupRequestError, confirmRestoreOnServer, needsAttention, rejectRestoreOnServer, requestBackupNow } from "./status";

const PAIRING = { version: 1, instanceId: "inst-1", backupUrl: "https://b.test", caPem: null, agentToken: "tok" } as StoredPairing;
const now = new Date("2026-10-05T10:00:00Z");

describe("Sicherungsstand im Hauptsystem", () => {
  let dir: string;
  let h: DbHandle;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-status-"));
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "admin", name: "Admin IT", username: "admin", role: "admin" }, { hash: "x:y" });
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  });

  const writeState = (s: Partial<AgentState>) => writeFileSync(path.join(dir, AGENT_STATE_FILE), JSON.stringify({ ...emptyAgentState("inst-1"), ...s }));

  it("ungekoppelt → Warnung; gekoppelt ohne Lauf → „noch kein Backup“", () => {
    expect(backupStatus(dir, now)).toMatchObject({ paired: false, health: "none" });
    expect(needsAttention(backupStatus(dir, now))).toBe(true);
    writeFileSync(path.join(dir, PAIRING_FILE), JSON.stringify(PAIRING));
    expect(backupStatus(dir, now)).toMatchObject({ paired: true, health: "none" });
    expect(needsAttention(backupStatus(dir, now))).toBe(false);
  });

  it("liest den Zustand des Agenten; überfällig nach 26 h, Fehler sofort; Zustand einer alten Kopplung zählt nicht", () => {
    const run = { trigger: "zeitplan" as const, status: "ok" as const, startedAt: "2026-10-05T01:30:00Z", finishedAt: "2026-10-05T01:31:00Z" };
    writeState({ lastRun: run, lastOkAt: run.finishedAt, lastContactAt: "2026-10-05T09:59:00Z" });
    expect(backupStatus(dir, now)).toMatchObject({ health: "ok", lastOkAt: new Date(run.finishedAt) });
    expect(backupStatus(dir, new Date("2026-10-06T04:00:00Z")).health).toBe("overdue");
    writeState({ lastRun: { ...run, status: "failed", error: "pg_dump fehlgeschlagen" }, lastOkAt: run.finishedAt, lastContactError: "ECONNREFUSED" });
    const s = backupStatus(dir, now);
    expect(s).toMatchObject({ health: "failed", contactError: "ECONNREFUSED" });
    expect(needsAttention(s)).toBe(true);
    writeFileSync(path.join(dir, AGENT_STATE_FILE), JSON.stringify({ ...emptyAgentState("alte-instanz"), lastOkAt: run.finishedAt }));
    expect(backupStatus(dir, now)).toMatchObject({ health: "none", lastOkAt: null });
  });

  it("„Jetzt sichern“ geht mit dem Agent-Token an den Backupserver und steht im Protokoll", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const ok = (async (url: string, o: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: o.headers?.authorization });
      return { status: 200, body: { ok: true } };
    }) as unknown as typeof requestJson;
    await requestBackupNow(h.db, "admin", PAIRING, ok);
    expect(seen).toEqual([{ url: "https://b.test/api/agent/run", auth: "Bearer tok" }]);
    expect((await h.db.select().from(auditLog)).map((a) => a.action)).toContain("verwaltung.backup.angefordert");

    const unknown = (async () => ({ status: 401, body: null })) as unknown as typeof requestJson;
    await expect(requestBackupNow(h.db, "admin", PAIRING, unknown)).rejects.toThrow(/entkoppelt/);
    const down = (async () => {
      throw new RequestError("ECONNREFUSED", "network");
    }) as unknown as typeof requestJson;
    await expect(requestBackupNow(h.db, "admin", PAIRING, down)).rejects.toThrow(BackupRequestError);
    await expect(requestBackupNow(h.db, "admin", null, ok)).rejects.toThrow(/Kein Backupserver/);
  });
});

describe("Wiederherstellung bestätigen/ablehnen (über den Backupserver)", () => {
  it("schickt Code bzw. Ablehnung mit dem Agent-Token; Ergebnis und Protokoll", async () => {
    const h = await createTestDb();
    await createUserWithPassword(h.db, { id: "admin", name: "Admin IT", username: "admin", role: "admin" }, { hash: "x:y" });
    const sent: unknown[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { ergebnis: "bestaetigt" } };
    const fake = (async (url: string, o: { body?: unknown; headers?: Record<string, string> }) => {
      expect(url).toBe("https://b.test/api/agent/restore");
      expect(o.headers?.authorization).toBe("Bearer tok");
      sent.push(o.body);
      return answer;
    }) as unknown as typeof requestJson;

    const dir = mkdtempSync(path.join(tmpdir(), "schulos-restore-ok-"));
    const req: RestoreRequest = {
      id: "job-1",
      snapshotId: "7da39b69".padEnd(64, "e"),
      snapshotShort: "7da39b69",
      snapshotTime: "2026-10-04T23:30:00Z",
      scope: "komplett",
      requestedBy: "Ina Tech",
      createdAt: "2026-10-05T08:00:00Z",
      status: "wartet",
    };
    writeFileSync(path.join(dir, AGENT_STATE_FILE), JSON.stringify({ ...emptyAgentState("inst-1"), restoreRequest: req }));
    const approvalFile = path.join(dir, RESTORE_APPROVAL_FILE);
    const confirm = (code: string, id = "job-1") => confirmRestoreOnServer(h.db, "admin", id, code, PAIRING, fake, dir, now);

    expect(await confirm("123 456")).toBe("bestaetigt");
    expect(sent.at(-1)).toEqual({ aktion: "bestaetigen", id: "job-1", code: "123 456" });
    // SEC-06: lokale Freigabe genau für diesen Auftrag, 30 Minuten
    const approval = JSON.parse(readFileSync(approvalFile, "utf8")) as unknown;
    expect(approvalProblem(approval, req, now)).toBeNull();
    expect(approvalProblem(approval, { ...req, snapshotId: "f".repeat(64) }, now)).toMatch(/passt nicht/);
    expect(approvalProblem(approval, req, new Date(now.getTime() + 31 * 60_000))).toMatch(/abgelaufen/);
    rmSync(approvalFile);

    expect(await confirm("12")).toBe("falsch"); // Format: gar nicht erst senden
    expect(sent).toHaveLength(1);
    // Auftrag, den der Agent nicht kennt (z. B. vom Backupserver untergeschoben) → gar nicht erst senden
    await expect(confirm("123456", "job-2")).rejects.toThrow(/nicht \(mehr\) vor/);
    expect(sent).toHaveLength(1);
    answer = { status: 200, body: { ergebnis: "falsch" } };
    expect(await confirm("000000")).toBe("falsch");
    expect(existsSync(approvalFile)).toBe(false); // falscher Code → keine Freigabe
    answer = { status: 200, body: { ergebnis: "verworfen" } };
    expect(await confirm("000000")).toBe("verworfen");
    expect(existsSync(approvalFile)).toBe(false);
    answer = { status: 409, body: { error: "Kein wartender Auftrag." } };
    await expect(confirm("000000")).rejects.toThrow("Kein wartender Auftrag.");
    expect(existsSync(approvalFile)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    answer = { status: 200, body: { ok: true } };
    await rejectRestoreOnServer(h.db, "admin", "job-1", PAIRING, fake);
    expect(sent.at(-1)).toEqual({ aktion: "ablehnen", id: "job-1" });
    const actions = (await h.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["verwaltung.backup.wiederherstellung_bestaetigt", "verwaltung.backup.wiederherstellung_code_falsch", "verwaltung.backup.wiederherstellung_abgelehnt"]),
    );
    await h.close();
  });
});
