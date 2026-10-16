import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_STATUS_FILE, type SystemStatus } from "@schulos/server/system";
import { createTestDb } from "@/core/db/testing";
import type { DbHandle } from "@/core/db/client";
import { auditLog } from "@/core/db/schema";
import { createUserWithPassword } from "@/core/auth/auth";
import { pendingOrder, placeOrder, readSystemStatus, statusIsStale, SystemOrderError } from "./status";

const STATUS: SystemStatus = {
  version: 1,
  checkedAt: "2026-10-05T10:00:00Z",
  current: "1.4.0",
  channel: "stabil",
  update: {
    status: "verfügbar",
    kind: "minor",
    securityRelevant: false,
    steps: [{ version: "1.5.0", publishedAt: "2026-09-01T00:00:00Z", securityRelevant: false, changes: [{ kind: "neu", text: "Elternsprechtag" }] }],
  },
  approved: null,
  protocol: [],
  os: null,
};

describe("Verwaltung → System: Dateien zum Host", () => {
  let dir: string;
  let h: DbHandle;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-system-"));
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "u-admin", name: "Admin", username: "admin", role: "admin" }, { hash: "x" });
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  });

  it("ohne Status: nichts; kaputter Status: nichts", () => {
    expect(readSystemStatus(dir)).toBeNull();
    writeFileSync(path.join(dir, SYSTEM_STATUS_FILE), "{kaputt");
    expect(readSystemStatus(dir)).toBeNull();
  });

  it("Freigabe nur für die verfügbare Version; Auftrag liegt für den Host bereit, Protokoll im Audit-Log", async () => {
    writeFileSync(path.join(dir, SYSTEM_STATUS_FILE), JSON.stringify(STATUS));
    expect(readSystemStatus(dir)?.current).toBe("1.4.0");
    await expect(placeOrder(h.db, "u-admin", { action: "freigabe", target: "1.4.9", when: "jetzt" }, dir)).rejects.toThrow(SystemOrderError);
    const o = await placeOrder(h.db, "u-admin", { action: "freigabe", target: "1.5.0", when: "wartungsfenster" }, dir);
    expect(pendingOrder(dir)).toEqual(o);
    expect(o).toMatchObject({ action: "freigabe", target: "1.5.0", when: "wartungsfenster", by: "u-admin" });
    const log = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.system.update_freigegeben"));
    expect(log[0]?.meta).toEqual({ version: "1.5.0", wann: "wartungsfenster" });
  });

  it("Kanalwechsel ersetzt einen noch nicht abgeholten Auftrag", async () => {
    await placeOrder(h.db, "u-admin", { action: "kanal", channel: "beta" }, dir);
    await placeOrder(h.db, "u-admin", { action: "kanal", channel: "stabil" }, dir);
    expect(pendingOrder(dir)).toMatchObject({ action: "kanal", channel: "stabil" });
  });

  it("Neustart von Hand nur, wenn einer aussteht (Q5-18)", async () => {
    await expect(placeOrder(h.db, "u-admin", { action: "neustart" }, dir)).rejects.toThrow("kein Neustart");
    writeFileSync(path.join(dir, SYSTEM_STATUS_FILE), JSON.stringify(STATUS));
    await expect(placeOrder(h.db, "u-admin", { action: "neustart" }, dir)).rejects.toThrow(SystemOrderError);
    writeFileSync(path.join(dir, SYSTEM_STATUS_FILE), JSON.stringify({ ...STATUS, reboot: { since: "2026-10-01T02:30:00Z", reason: "passphrase" } }));
    const o = await placeOrder(h.db, "u-admin", { action: "neustart" }, dir);
    expect(pendingOrder(dir)).toEqual(o);
    expect(o).toMatchObject({ action: "neustart", by: "u-admin" });
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.system.neustart"))).toHaveLength(1);
  });

  it("veralteter Status (Timer läuft nicht)", () => {
    expect(statusIsStale(STATUS, new Date("2026-10-05T10:20:00Z"))).toBe(false);
    expect(statusIsStale(STATUS, new Date("2026-10-05T10:31:00Z"))).toBe(true);
  });
});
