import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@schulos/server/pairing";
import type { DbHandle } from "@/db/client";
import { instances } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { agentPlan, authenticateAgent, instanceStatus, recentRuns, recordReport, ReportRejected, requestRun } from "./service";

const TOKEN = "agent-token-xyz";

describe("Agent-Schnittstelle des Backupservers", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(instances).values({ id: "i1", name: "Lindenhof", restUser: "i-1", repoPasswordEnc: "x", agentTokenHash: sha256Hex(TOKEN) });
    await h.db
      .insert(instances)
      .values({ id: "i2", name: "Weg", restUser: "i-2", repoPasswordEnc: "x", agentTokenHash: sha256Hex("alt"), removedAt: new Date() });
  });
  afterAll(() => h.close());

  it("Token: nur „Bearer <token>“ einer gekoppelten Instanz", async () => {
    expect((await authenticateAgent(h.db, `Bearer ${TOKEN}`))?.id).toBe("i1");
    expect(await authenticateAgent(h.db, TOKEN)).toBeNull();
    expect(await authenticateAgent(h.db, "Bearer falsch")).toBeNull();
    expect(await authenticateAgent(h.db, "Bearer alt")).toBeNull(); // entkoppelt
    expect(await authenticateAgent(h.db, null)).toBeNull();
  });

  it("Plan mit Standard-Zeitplan; „Jetzt sichern“ bleibt stehen, bis ein Lauf ihn meldet – eine neuere Anforderung bleibt", async () => {
    const inst = (await authenticateAgent(h.db, `Bearer ${TOKEN}`))!;
    expect(await agentPlan(h.db, inst)).toEqual({ instanceId: "i1", instanceName: "Lindenhof", schedule: ["01:30"], runRequestedAt: null, restore: null, immutable: null });

    const t1 = new Date("2026-10-05T08:00:00Z");
    await requestRun(h.db, "i1", null, t1);
    const plan = await agentPlan(h.db, (await authenticateAgent(h.db, `Bearer ${TOKEN}`))!);
    expect(plan.runRequestedAt).toBe(t1.toISOString());

    const base = { trigger: "angefordert" as const, startedAt: "2026-10-05T08:01:00Z", finishedAt: "2026-10-05T08:03:00Z", agentVersion: "0.1.0" };
    await requestRun(h.db, "i1", null, new Date("2026-10-05T08:02:00Z")); // neuer während des Laufs
    await recordReport(h.db, inst, { ...base, status: "ok", snapshotId: "abc", bytesTotal: 1000, bytesAdded: 10, requestedAt: t1.toISOString() });
    expect((await agentPlan(h.db, (await authenticateAgent(h.db, `Bearer ${TOKEN}`))!)).runRequestedAt).toBe("2026-10-05T08:02:00.000Z");
    await recordReport(h.db, inst, { ...base, status: "ok", requestedAt: "2026-10-05T08:02:00.000Z" });
    expect((await agentPlan(h.db, (await authenticateAgent(h.db, `Bearer ${TOKEN}`))!)).runRequestedAt).toBeNull();
  });

  it("Ampel aus den gemeldeten Läufen; ungültige Meldungen werden abgelehnt", async () => {
    const inst = (await authenticateAgent(h.db, `Bearer ${TOKEN}`))!;
    expect((await instanceStatus(h.db, "i1", new Date("2026-10-05T09:00:00Z"))).health).toBe("ok");
    await recordReport(h.db, inst, {
      trigger: "zeitplan",
      status: "failed",
      startedAt: "2026-10-05T23:30:00Z",
      finishedAt: "2026-10-05T23:31:00Z",
      error: "pg_dump: Verbindung verweigert",
      agentVersion: "0.1.0",
    });
    const s = await instanceStatus(h.db, "i1", new Date("2026-10-06T00:00:00Z"));
    expect(s.health).toBe("failed");
    expect(s.lastRun).toMatchObject({ status: "failed", error: "pg_dump: Verbindung verweigert" });
    expect(s.lastOkAt?.toISOString()).toBe("2026-10-05T08:03:00.000Z");
    expect(await recentRuns(h.db, "i1")).toHaveLength(3);

    await expect(recordReport(h.db, inst, { trigger: "zeitplan", status: "vielleicht" as "ok", startedAt: "x", finishedAt: "x", agentVersion: "" })).rejects.toThrow(
      ReportRejected,
    );
    await expect(recordReport(h.db, inst, { trigger: "zeitplan", status: "ok", startedAt: "kaputt", finishedAt: "x", agentVersion: "" })).rejects.toThrow(
      ReportRejected,
    );
  });
});
