import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailMessage } from "@schulos/server/mail";
import { sha256Hex } from "@schulos/server/pairing";
import type { DbHandle } from "@/db/client";
import { backupRuns, instances, maintenanceRuns } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { collectAlarms, runAlarms } from "./alarms";

describe("Alarme des Backupservers", () => {
  let h: DbHandle;
  const now = new Date("2026-10-05T12:00:00Z");
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(instances).values({ id: "i1", name: "Lindenhof", restUser: "i-1", repoPasswordEnc: "x", agentTokenHash: sha256Hex("t") });
    await h.db.insert(backupRuns).values({
      id: "r1",
      instanceId: "i1",
      trigger: "zeitplan",
      status: "ok",
      startedAt: new Date("2026-10-03T23:30:00Z"),
      finishedAt: new Date("2026-10-03T23:31:00Z"),
    });
    await h.db.insert(maintenanceRuns).values({
      id: "m1",
      instanceId: "i1",
      kind: "offsite",
      status: "failed",
      startedAt: new Date("2026-10-04T15:00:00Z"),
      finishedAt: new Date("2026-10-04T15:01:00Z"),
      error: "Offsite-Ziel nicht erreichbar: connection refused",
    });
  });
  afterAll(() => h.close());

  it("überfällige Sicherung, fehlgeschlagene Wartung, knapper Platz", async () => {
    const alarms = await collectAlarms(h.db, now, 93);
    expect(alarms.map((a) => a.key)).toEqual(["backup:i1", "offsite:i1", "platz"]);
    expect(alarms[1]!.title).toBe("Offsite-Kopie fehlgeschlagen: Lindenhof");
    expect((await collectAlarms(h.db, now, 50)).map((a) => a.key)).not.toContain("platz");
  });

  it("SEC-14: Neustart nötig, aber nur mit Passphrase (Status vom Host) → Alarm vorneweg", async () => {
    const host = { rebootRequired: true, passphrase: true, since: now.toISOString(), checkedAt: now.toISOString(), tpm: null };
    const alarms = await collectAlarms(h.db, now, 50, host);
    expect(alarms[0]).toMatchObject({ key: "neustart", title: "Neustart nötig – Passphrase erforderlich" });
    expect((await collectAlarms(h.db, now, 50, { ...host, passphrase: false })).map((a) => a.key)).not.toContain("neustart");
  });

  it("G4E-O03/O15: TPM-Bindung unvollständig und veralteter Host-Status alarmieren", async () => {
    const tpm = { mode: "tpm2" as const, secureBoot: false, markerSince: null, bootedAt: null, error: null, efiChanged: false, pcrSets: ["7"] };
    const host = { rebootRequired: false, passphrase: false, since: null, checkedAt: now.toISOString(), tpm };
    const keys = (await collectAlarms(h.db, now, 50, host)).map((a) => a.key);
    expect(keys).toContain("tpm");
    expect(keys).not.toContain("hoststatus");
    const old = { ...host, tpm: null, checkedAt: new Date(now.getTime() - 2 * 3600_000).toISOString() };
    expect((await collectAlarms(h.db, now, 50, old)).map((a) => a.key)).toContain("hoststatus");
  });

  it("eine Mail je Durchgang, danach still", async () => {
    const sent: MailMessage[] = [];
    const config = { host: "smtp", port: 587, secure: false, user: null, password: null, from: "backup@schule.de", to: ["it@schule.de"] };
    await runAlarms(h.db, { config, sender: async (m) => void sent.push(m), now, disk: 40 });
    await runAlarms(h.db, { config, sender: async (m) => void sent.push(m), now: new Date("2026-10-05T12:01:00Z"), disk: 40 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("[SchulOS Backup] 2 Probleme");
  });
});
