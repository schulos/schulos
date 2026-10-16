// SEC-11: unveränderliche Kopie – Prüfung der Schnappschüsse des Offsite-Ziels (rclone als Attrappe), Aufzeichnung als
// Wartungslauf, Plan an das Hauptsystem, Alarm. Gegen eine echte Storage Box nur von Hand (INSTALLATION.md §4).
import {
  IMMUTABLE_MAX_HOURS,
  immutableHealth,
  sanitizeImmutable,
} from "@schulos/server/agent-api";
import type { Exec } from "@schulos/server/exec";
import { atRestKey, seal } from "@schulos/server/pairing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectAlarms } from "@/alarms";
import { immutableFor } from "@/agent/service";
import type { DbHandle } from "@/db/client";
import { instances } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { checkImmutable, snapshotConfig, snapshotTime } from "./immutable";
import { lastMaintenance, maintenancePlan, runImmutableFor } from "./service";
import { tick } from "@/jobs";

const NOW = new Date("2026-10-14T18:00:00Z");
type Dir = { Name: string; ModTime?: string; IsDir?: boolean };

function fake(
  dirs: Dir[],
  contains: string[],
  opts: { fail?: boolean; snapshots?: { code: number; stdout: string }; size?: { count: number; bytes: number } } = {},
) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (opts.fail)
      return {
        code: 1,
        stdout: "",
        stderr: "Failed to lsjson: couldn't connect SSH: ssh: handshake failed",
      };
    if (args[0] === "lsjson")
      return { code: 0, stdout: JSON.stringify(dirs), stderr: "" };
    if (args[0] === "lsf")
      return contains.some((c) => args[2]!.includes(`/${c}/`))
        ? { code: 0, stdout: "config\nkeys/\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    // G4E-O07: restic snapshots direkt im Schnappschuss, rclone size der Pack-Daten
    if (cmd === "restic" && args[0] === "snapshots") {
      const s = opts.snapshots ?? { code: 0, stdout: JSON.stringify([{ id: "a1", short_id: "a1", time: "2026-10-13T23:30:00Z", hostname: "h" }]) };
      return { ...s, stderr: s.code ? "Fatal: wrong password or no key found" : "" };
    }
    if (args[0] === "size") return { code: 0, stdout: JSON.stringify(opts.size ?? { count: 40, bytes: 900e6 }), stderr: "" };
    return { code: 99, stdout: "", stderr: "?" };
  };
  return {
    ctx: { exec, bin: "restic", restDir: "/srv/rest", rclone: "rclone" },
    calls,
  };
}
const OFFSITE = { base: "storagebox:schulos" };
const SNAPS = { root: "storagebox:.zfs/snapshot", maxHours: 48 };

describe("SEC-11: Schnappschüsse des Offsite-Ziels", () => {
  it("Einstellung: nur mit Pfad, Unsinn abgelehnt, Höchstalter", () => {
    expect(snapshotConfig({})).toBeNull();
    expect(
      snapshotConfig({
        SCHULOS_OFFSITE_SNAPSHOTS: "storagebox:.zfs/snapshot/",
      }),
    ).toEqual({
      root: "storagebox:.zfs/snapshot",
      maxHours: IMMUTABLE_MAX_HOURS,
    });
    expect(
      snapshotConfig({
        SCHULOS_OFFSITE_SNAPSHOTS: "s:x",
        SCHULOS_OFFSITE_SNAPSHOT_MAX_HOURS: "72",
      })!.maxHours,
    ).toBe(72);
    expect(() =>
      snapshotConfig({ SCHULOS_OFFSITE_SNAPSHOTS: "x:$(id)" }),
    ).toThrow();
    expect(maintenancePlan({}).immutable).toEqual({
      at: "18:00",
      everyDays: 1,
    });
  });

  it("Zeit aus dem Namen, sonst aus der Änderungszeit", () => {
    expect(snapshotTime({ Name: "2026-10-14T01-00-00" })!.toISOString()).toBe(
      "2026-10-14T01:00:00.000Z",
    );
    expect(
      snapshotTime({
        Name: "daily",
        ModTime: "2026-10-13T02:00:00Z",
      })!.toISOString(),
    ).toBe("2026-10-13T02:00:00.000Z");
    expect(snapshotTime({ Name: "x" })).toBeNull();
  });

  it("neuester Schnappschuss, der die Kopie dieser Instanz enthält", async () => {
    const f = fake(
      [
        { Name: "2026-10-12T01-00-00" },
        { Name: "2026-10-14T01-00-00" },
        { Name: "2026-10-13T01-00-00" },
      ],
      ["2026-10-13T01-00-00", "2026-10-12T01-00-00"],
    );
    const r = await checkImmutable(f.ctx, OFFSITE, SNAPS, "i-1", NOW);
    expect(r).toEqual({
      letzteKopie: "2026-10-13T01:00:00.000Z",
      schnappschuss: "2026-10-13T01-00-00",
      alterStunden: 41,
    });
    expect(f.calls[0]).toEqual([
      "rclone",
      "lsjson",
      "--dirs-only",
      "storagebox:.zfs/snapshot",
    ]);
    // der neueste (ohne die Kopie) wurde zuerst gefragt
    expect(f.calls[1]).toEqual([
      "rclone",
      "lsf",
      "--files-only",
      "storagebox:.zfs/snapshot/2026-10-14T01-00-00/schulos/i-1",
    ]);
  });

  it("G4E-O07: Inhalt prüfen – Stände entschlüsselbar, Pack-Daten da und nicht stark geschrumpft", async () => {
    const snap = [{ Name: "2026-10-14T01-00-00" }];
    const ok = fake(snap, ["2026-10-14T01-00-00"]);
    const r = await checkImmutable(ok.ctx, OFFSITE, SNAPS, "i-1", NOW, { password: "pw", previousBytes: 1000e6 });
    expect(r).toMatchObject({ staende: 1, neuesterStand: "2026-10-13T23:30:00.000Z", packs: 40, packBytes: 900e6 });
    const restic = ok.calls.find((c) => c[0] === "restic")!;
    expect(restic.slice(1)).toEqual(["snapshots", "--json", "--no-lock"]);
    expect(ok.calls.at(-1)).toEqual(["rclone", "size", "--json", "storagebox:.zfs/snapshot/2026-10-14T01-00-00/schulos/i-1/data"]);
    // Ransomware: Dateien verschlüsselt/ersetzt → restic kann nichts lesen
    await expect(
      checkImmutable(fake(snap, ["2026-10-14T01-00-00"], { snapshots: { code: 1, stdout: "" } }).ctx, OFFSITE, SNAPS, "i-1", NOW, { password: "pw", previousBytes: null }),
    ).rejects.toThrow("nicht lesbar – verschlüsselt, ersetzt oder beschädigt?");
    // alle Stände gelöscht
    await expect(
      checkImmutable(fake(snap, ["2026-10-14T01-00-00"], { snapshots: { code: 0, stdout: "[]" } }).ctx, OFFSITE, SNAPS, "i-1", NOW, { password: "pw", previousBytes: null }),
    ).rejects.toThrow("keinen Sicherungsstand");
    // Packs größtenteils weg
    await expect(
      checkImmutable(fake(snap, ["2026-10-14T01-00-00"], { size: { count: 3, bytes: 100e6 } }).ctx, OFFSITE, SNAPS, "i-1", NOW, { password: "pw", previousBytes: 900e6 }),
    ).rejects.toThrow("stark geschrumpft");
  });

  it("keine Schnappschüsse, keiner mit der Kopie, Ziel nicht lesbar → verständlicher Fehler", async () => {
    await expect(
      checkImmutable(fake([], []).ctx, OFFSITE, SNAPS, "i-1", NOW),
    ).rejects.toThrow("Keine Schnappschüsse");
    await expect(
      checkImmutable(
        fake([{ Name: "2026-10-14T01-00-00" }], []).ctx,
        OFFSITE,
        SNAPS,
        "i-1",
        NOW,
      ),
    ).rejects.toThrow("Kein Schnappschuss enthält die Offsite-Kopie");
    await expect(
      checkImmutable(
        fake([], [], { fail: true }).ctx,
        OFFSITE,
        SNAPS,
        "i-1",
        NOW,
      ),
    ).rejects.toThrow("Schnappschüsse des Offsite-Ziels nicht lesbar");
  });
});

describe("SEC-11: Wartungslauf, Plan, Alarm", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(instances).values({
      id: "i1",
      name: "Lindenhof",
      restUser: "i-1",
      repoPasswordEnc: seal(atRestKey("s", "repo"), "pw", "repo-password"),
      agentTokenHash: "x",
    });
  });
  afterAll(() => h.close());
  const env = {
    SCHULOS_OFFSITE: "storagebox:schulos",
    SCHULOS_OFFSITE_SNAPSHOTS: "storagebox:.zfs/snapshot",
  };

  it("frisch → ok im Plan; zu alt → fehlgeschlagen mit Stand, Alarm auf dem Backupserver, „veraltet“ im Hauptsystem", async () => {
    const inst = (await h.db.select().from(instances))[0]!;
    expect(await immutableFor(h.db, "i1", env)).toBeNull(); // noch nicht geprüft
    const fresh = fake(
      [{ Name: "2026-10-14T01-00-00" }],
      ["2026-10-14T01-00-00"],
    );
    expect(
      await runImmutableFor(
        h.db,
        inst,
        fresh.ctx,
        OFFSITE,
        SNAPS,
        null,
        () => NOW,
      ),
    ).toMatchObject({ ok: true });
    const plan = await immutableFor(h.db, "i1", env);
    expect(plan).toEqual({
      lastAt: "2026-10-14T01:00:00.000Z",
      checkedAt: NOW.toISOString(),
      ok: true,
      error: null,
    });
    expect(immutableHealth(sanitizeImmutable(plan), NOW)).toBe("ok");
    expect(await immutableFor(h.db, "i1", {})).toBeNull(); // ohne Einstellung: nicht eingerichtet

    const old = fake(
      [{ Name: "2026-10-10T01-00-00" }],
      ["2026-10-10T01-00-00"],
    );
    const r = await runImmutableFor(
      h.db,
      inst,
      old.ctx,
      OFFSITE,
      SNAPS,
      null,
      () => new Date(NOW.getTime() + 60_000),
    );
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("113 Stunden alt"),
    });
    const stale = await immutableFor(h.db, "i1", env);
    expect(stale).toMatchObject({
      lastAt: "2026-10-10T01:00:00.000Z",
      ok: false,
    });
    expect(immutableHealth(sanitizeImmutable(stale), NOW)).toBe("veraltet");
    const alarms = await collectAlarms(h.db, NOW, 10);
    expect(alarms.map((a) => a.title)).toContain(
      "Unveränderliche Kopie fehlgeschlagen: Lindenhof",
    );
  });

  it("G4E-O07: mit Geheimnis Inhalt prüfen, Vergleich mit der Pack-Größe der letzten guten Prüfung", async () => {
    const inst = (await h.db.select().from(instances))[0]!;
    const snap = [{ Name: "2026-10-14T01-00-00" }];
    const t0 = new Date(NOW.getTime() + 3600_000);
    const good = await runImmutableFor(h.db, inst, fake(snap, ["2026-10-14T01-00-00"]).ctx, OFFSITE, SNAPS, null, () => t0, "s");
    expect(good).toMatchObject({ ok: true, details: { packBytes: 900e6 } });
    const shrunk = await runImmutableFor(
      h.db,
      inst,
      fake(snap, ["2026-10-14T01-00-00"], { size: { count: 2, bytes: 50e6 } }).ctx,
      OFFSITE,
      SNAPS,
      null,
      () => new Date(t0.getTime() + 60_000),
      "s",
    );
    expect(shrunk).toMatchObject({ ok: false, error: expect.stringContaining("stark geschrumpft") });
  });

  it("G4E-O08: ungültiges SCHULOS_OFFSITE_SNAPSHOTS → Lauf „fehlgeschlagen“, der Takt läuft weiter, Alarme kommen", async () => {
    const before = { ...process.env };
    process.env.SCHULOS_OFFSITE = "storagebox:schulos";
    process.env.SCHULOS_OFFSITE_SNAPSHOTS = "'storagebox:.zfs/snapshot'";
    process.env.SCHULOS_OFFSITE_TIME = "23:59";
    process.env.SCHULOS_PRUNE_TIME = "23:59";
    process.env.SCHULOS_CHECK_TIME = "23:59";
    process.env.SCHULOS_RESTORE_TEST_TIME = "23:59";
    process.env.SCHULOS_OFFSITE_SNAPSHOT_TIME = "00:00";
    try {
      const at = new Date("2026-10-16T10:00:00Z");
      const done = await tick(h.db, at, fake([], []).ctx, "s");
      expect(done.join("\n")).toMatch(/Einstellung ungültig \(immutable\)/);
      const last = await lastMaintenance(h.db, "i1", "immutable");
      expect(last).toMatchObject({ status: "failed", error: expect.stringContaining("SCHULOS_OFFSITE_SNAPSHOTS") });
      expect((await collectAlarms(h.db, at, 10)).map((a) => a.title)).toContain("Unveränderliche Kopie fehlgeschlagen: Lindenhof");
    } finally {
      process.env = before;
    }
  });

  it("G4E-O08: letzter Lauf älter als zweimal der Abstand → Alarm „läuft nicht mehr“", async () => {
    const env = { SCHULOS_OFFSITE: "storagebox:schulos", SCHULOS_OFFSITE_SNAPSHOTS: "storagebox:.zfs/snapshot" };
    const late = new Date("2026-10-25T10:00:00Z");
    const keys = (await collectAlarms(h.db, late, 10, null, env)).map((a) => a.key);
    // immutable: letzter Lauf (fehlgeschlagen) zählt als Fehlschlag, nicht als „alt“; ohne Offsite-Einstellung kein „alt“
    expect(keys).toContain("immutable:i1");
    const ok = await runImmutableFor(h.db, (await h.db.select().from(instances))[0]!, fake([{ Name: "2026-10-16T01-00-00" }], ["2026-10-16T01-00-00"]).ctx, OFFSITE, SNAPS, null, () => new Date("2026-10-16T12:00:00Z"));
    expect(ok.ok).toBe(true);
    expect((await collectAlarms(h.db, late, 10, null, env)).map((a) => a.key)).toContain("immutable-alt:i1");
    expect((await collectAlarms(h.db, late, 10, null, {})).map((a) => a.key)).not.toContain("immutable-alt:i1");
  });

  it("Ampel im Hauptsystem: aus, fehlt, veraltet (auch wenn die Prüfung selbst alt ist), ok", () => {
    expect(immutableHealth(null, NOW)).toBe("aus");
    expect(
      immutableHealth(
        { lastAt: null, checkedAt: NOW.toISOString(), ok: false, error: "x" },
        NOW,
      ),
    ).toBe("fehlt");
    expect(
      immutableHealth(
        {
          lastAt: "2026-10-14T01:00:00Z",
          checkedAt: "2026-10-11T18:00:00Z",
          ok: true,
          error: null,
        },
        NOW,
      ),
    ).toBe("veraltet");
    expect(
      sanitizeImmutable({
        lastAt: 5,
        checkedAt: "2026-10-14T18:00:00Z",
        ok: "ja",
        error: "x".repeat(900),
      }),
    ).toEqual({
      lastAt: null,
      checkedAt: "2026-10-14T18:00:00.000Z",
      ok: false,
      error: "x".repeat(300),
    });
  });
});
