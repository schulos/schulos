import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Exec } from "@schulos/server/exec";
import { atRestKey, seal } from "@schulos/server/pairing";
import type { DbHandle } from "@/db/client";
import { instances, maintenanceRuns } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { DUMP_PATH, type LocalRestic } from "@/restic/local";
import { restoreTestContext } from "./restore-test";
import { dueFor, lastMaintenance, runCheck, runRestoreTestFor } from "./service";

const SECRET = "test-secret";

describe("Prüfung und Test-Restore", () => {
  let h: DbHandle;
  const calls: { cmd: string; args: string[] }[] = [];
  let checkFails = false;
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "restic" && args[0] === "check")
      return checkFails ? { code: 1, stdout: "", stderr: "Fatal: repository contains errors" } : { code: 0, stdout: "no errors were found", stderr: "" };
    if (cmd === "restic" && args[0] === "snapshots")
      return { code: 0, stdout: JSON.stringify([{ id: "7da39b69e2fa", short_id: "7da39b69", time: "2026-10-05T23:30:00Z", hostname: "h" }]), stderr: "" };
    if (cmd === "restic" && args[0] === "restore") {
      const target = args[args.indexOf("--target") + 1]!;
      const file = path.join(target, DUMP_PATH);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "PGDMP-FAKE");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "pg_restore") return { code: 0, stdout: ";\n; Archive\n219; 1259 16384 TABLE public users\n3435; 0 16384 TABLE DATA public users\n", stderr: "" };
    return { code: 99, stdout: "", stderr: "?" };
  };
  const ctx: LocalRestic = { exec, bin: "restic", restDir: "/srv/rest" };

  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(instances).values({ id: "i1", name: "Lindenhof", restUser: "i-1", repoPasswordEnc: seal(atRestKey(SECRET, "repo"), "pw", "repo-password"), agentTokenHash: "x" });
  });
  afterAll(() => h.close());

  it("Prüfung liest eine Datenstichprobe; Fehler landen im Wartungsprotokoll", async () => {
    const inst = (await h.db.select().from(instances))[0]!;
    expect(await runCheck(h.db, inst, ctx, SECRET, null)).toEqual({ ok: true, details: { stichprobe: "5%" } });
    expect(calls.at(-1)!.args).toEqual(["check", "--retry-lock", "10m", "--read-data-subset=5%"]);
    checkFails = true;
    expect(await runCheck(h.db, inst, ctx, SECRET, null)).toEqual({ ok: false, error: "Prüfung fehlgeschlagen: Fatal: repository contains errors" });
    checkFails = false;
  });

  it("Test-Restore ohne Test-Postgres: nur den Dump zurückholen (mit --verify) und auf Lesbarkeit prüfen", async () => {
    const inst = (await h.db.select().from(instances))[0]!;
    const r = await runRestoreTestFor(h.db, inst, restoreTestContext(ctx, {}), SECRET, null);
    expect(r).toEqual({ ok: true, details: { stand: "7da39b69", dumpBytes: 10, eintraege: 2, tabellen: null, migrationen: null, konten: null } });
    const restore = calls.find((c) => c.args[0] === "restore")!;
    expect(restore.args).toEqual(expect.arrayContaining(["7da39b69e2fa", "--include", DUMP_PATH, "--verify"]));
    expect(calls.at(-1)).toMatchObject({ cmd: "pg_restore", args: ["--list", expect.stringContaining("schulos.dump")] });
    expect(await lastMaintenance(h.db, "i1", "restore_test")).toMatchObject({ status: "ok" });
  });

  it("Fälligkeit: wöchentlich bzw. monatlich ab der Uhrzeit, gezählt in Kalendertagen (Berlin)", async () => {
    await h.db.delete(maintenanceRuns);
    const at = (iso: string) => new Date(iso);
    expect(await dueFor(h.db, "check", at("2026-10-05T12:59:00Z"), "15:00", 7)).toHaveLength(0); // 14:59 Berlin
    expect(await dueFor(h.db, "check", at("2026-10-05T13:00:00Z"), "15:00", 7)).toHaveLength(1);
    const inst = (await h.db.select().from(instances))[0]!;
    await runCheck(h.db, inst, ctx, SECRET, null, () => at("2026-10-05T13:00:00Z"));
    expect(await dueFor(h.db, "check", at("2026-10-11T14:00:00Z"), "15:00", 7)).toHaveLength(0); // 6 Tage später
    expect(await dueFor(h.db, "check", at("2026-10-12T13:00:00Z"), "15:00", 7)).toHaveLength(1); // 7 Tage später
    expect(await dueFor(h.db, "restore_test", at("2026-10-05T14:00:00Z"), "16:00", 30)).toHaveLength(1);
  });
});
