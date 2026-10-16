import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Exec } from "@schulos/server/exec";
import { atRestKey, seal } from "@schulos/server/pairing";
import { createUserWithPassword } from "@/auth/auth";
import type { DbHandle } from "@/db/client";
import { auditLog, instances } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { tick } from "@/jobs";
import { listSnapshots, parseForget, parseSnapshots, type LocalRestic } from "@/restic/local";
import { duePrunes, lastMaintenance, runPrune, updateRetention } from "./service";

const SECRET = "test-secret";
const FORGET = JSON.stringify([{ keep: [{}, {}, {}], remove: [{}] }, { keep: [{}], remove: null }]);

describe("Wartung auf dem Backupserver", () => {
  let h: DbHandle;
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  let fail = false;
  const exec: Exec = async (_cmd, args, opts) => {
    calls.push({ args, env: opts?.env });
    if (fail) return { code: 1, stdout: "", stderr: "Fatal: repository is already locked by PID 7" };
    if (args[0] === "forget") return { code: 0, stdout: `${FORGET}\n`, stderr: "" };
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const ctx: LocalRestic = { exec, bin: "restic", restDir: "/srv/rest" };

  beforeAll(async () => {
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "adm", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash: "x:y" });
    await h.db.insert(instances).values({
      id: "i1",
      name: "Lindenhof",
      restUser: "i-1",
      repoPasswordEnc: seal(atRestKey(SECRET, "repo"), "repo-pw", "repo-password"),
      agentTokenHash: "x",
    });
  });
  afterAll(() => h.close());

  it("Aufräumen mit der Aufbewahrung der Instanz, lokal auf dem Repository-Ordner; Ergebnis protokolliert", async () => {
    const inst = (await h.db.select().from(instances))[0]!;
    const r = await runPrune(h.db, inst, ctx, SECRET, null);
    expect(r).toEqual({ ok: true, kept: 4, removed: 1 });
    const c = calls.at(-1)!;
    expect(c.args).toEqual(["forget", "--json", "--prune", "--retry-lock", "10m", "--keep-daily", "14", "--keep-weekly", "4", "--keep-monthly", "3"]);
    expect(c.env).toEqual({ RESTIC_REPOSITORY: path.join("/srv/rest", "i-1"), RESTIC_PASSWORD: "repo-pw" });
    expect(await lastMaintenance(h.db, "i1", "prune")).toMatchObject({ status: "ok", details: { behalten: 4, entfernt: 1 } });

    fail = true;
    expect(await runPrune(h.db, inst, ctx, SECRET, null)).toMatchObject({ ok: false, error: expect.stringContaining("already locked") });
    expect(await lastMaintenance(h.db, "i1", "prune")).toMatchObject({ status: "failed" });
    fail = false;
  });

  it("geänderte Aufbewahrung gilt beim nächsten Lauf; ohne Monatsstufe kein --keep-monthly; Änderung im Protokoll", async () => {
    await updateRetention(h.db, "adm", "i1", { daily: 7, weekly: 2, monthly: 0 }, null);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "instanz.aufbewahrung")))[0]).toMatchObject({ actorId: "adm", target: "i1" });
    const inst = (await h.db.select().from(instances))[0]!;
    await runPrune(h.db, inst, ctx, SECRET, null);
    expect(calls.at(-1)!.args).toEqual(["forget", "--json", "--prune", "--retry-lock", "10m", "--keep-daily", "7", "--keep-weekly", "2"]);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "instanz.aufgeraeumt"))).toHaveLength(0); // automatisch: kein Personen-Eintrag
  });

  it("täglich ab der Uhrzeit einmal fällig (Berlin), der Takt räumt auf", async () => {
    const h2 = await createTestDb();
    await h2.db.insert(instances).values({ id: "i2", name: "Weg", restUser: "i-2", repoPasswordEnc: seal(atRestKey(SECRET, "repo"), "pw", "repo-password"), agentTokenHash: "y" });
    expect(await duePrunes(h2.db, new Date("2026-10-05T11:59:00Z"), "14:00")).toHaveLength(0); // 13:59 Berlin
    expect((await duePrunes(h2.db, new Date("2026-10-05T12:00:00Z"), "14:00")).map((i) => i.id)).toEqual(["i2"]);
    const done = await tick(h2.db, new Date("2026-10-05T12:30:00Z"), ctx, SECRET);
    expect(done).toEqual(["aufgeräumt Weg: 1 entfernt, 4 behalten"]);
    expect(await duePrunes(h2.db, new Date("2026-10-05T20:00:00Z"), "14:00")).toHaveLength(0);
    await h2.close();
  });

  it("restic-Ausgaben lesen; ohne Repository leere Liste", async () => {
    expect(parseForget(`Applying Policy\n${FORGET}\nprune done`)).toEqual({ kept: 4, removed: 1 });
    const snaps = parseSnapshots(
      JSON.stringify([
        { id: "a", short_id: "aa", time: "2026-10-04T23:30:00Z", hostname: "schulos-i1", tags: ["schulos"], summary: { total_bytes_processed: 99 } },
        { id: "b", short_id: "bb", time: "2026-10-05T23:30:00Z", hostname: "schulos-i1" },
      ]),
    );
    expect(snaps.map((s) => [s.shortId, s.bytes])).toEqual([
      ["bb", null],
      ["aa", 99],
    ]);
    const none: Exec = async () => ({ code: 10, stdout: "", stderr: "Fatal: repository does not exist" });
    expect(await listSnapshots({ ...ctx, exec: none }, "i-1", "pw")).toEqual([]);
  });
});

describe("restic fehlt", () => {
  it("klare Meldung statt spawn ENOENT", async () => {
    const missing: Exec = async () => ({ code: 127, stdout: "", stderr: "spawn restic ENOENT" });
    await expect(listSnapshots({ exec: missing, bin: "restic", restDir: "/x" }, "i-1", "pw")).rejects.toThrow("nicht installiert");
  });
});
