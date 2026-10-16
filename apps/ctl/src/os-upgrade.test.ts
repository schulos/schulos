import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProtocolEntry } from "@schulos/server/system";
import { checkAfterBoot, MIN_FREE_BYTES, nextCodename, rewriteSources, runOsUpgrade, type OsDeps, type OsUpgradeMarker } from "./os-upgrade";

function fake(over: Partial<OsDeps> & { code?: string; healthy?: boolean; upgradeError?: string; restoreOk?: boolean; broken?: number } = {}) {
  const calls: string[] = [];
  const log: ProtocolEntry[] = [];
  let marker: OsUpgradeMarker | null = null;
  let broken = over.broken ?? 0;
  let code = over.code ?? "trixie";
  const d: OsDeps = {
    now: () => new Date("2026-10-05T03:00:00Z"),
    log: (e) => log.push(e),
    codename: async () => code,
    freeBytes: async () => 20 * 1024 ** 3,
    backup: async () => void calls.push("backup"),
    testRestore: async () => (calls.push("test-restore"), { ok: true }),
    snapshot: async () => void calls.push("snapshot"),
    setSources: async (f, t) => void calls.push(`sources ${f}→${t}`),
    upgrade: async () => {
      calls.push("upgrade");
      if (over.upgradeError) throw new Error(over.upgradeError);
    },
    restore: async () => void calls.push("restore"),
    reboot: async () => void calls.push("reboot"),
    removeBroken: async () => {
      const n = broken;
      broken = 0;
      return n;
    },
    stackHealthy: async () => (calls.push("healthy?"), over.healthy ?? true),
    marker: { read: () => marker, write: (m) => void (marker = m), clear: () => void (marker = null) },
    ...over,
  };
  return { d, calls, log, getMarker: () => marker, setCode: (c: string) => (code = c) };
}

describe("Debian-Versionswechsel", () => {
  it("Codenamen und Paketquellen", () => {
    expect(nextCodename("trixie")).toBe("forky");
    expect(nextCodename("duke")).toBeNull();
    expect(nextCodename("sid")).toBeNull();
    const deb822 = "Types: deb\nURIs: http://deb.debian.org/debian\nSuites: trixie trixie-updates\n\nURIs: http://security.debian.org/debian-security\nSuites: trixie-security\n";
    expect(rewriteSources(deb822, "trixie", "forky")).toBe(deb822.replaceAll("trixie", "forky"));
    expect(rewriteSources("deb http://x/trixies trixie main", "trixie", "forky")).toBe("deb http://x/trixies forky main");
  });

  it("geglückt: Sicherung, Test-Restore, Schnappschuss, Quellen, Upgrade, Neustart – nach dem Start Prüfung → fertig", async () => {
    const f = fake();
    expect(await runOsUpgrade(f.d)).toEqual({ status: "neustart", from: "trixie", to: "forky" });
    expect(f.calls).toEqual(["backup", "test-restore", "snapshot", "sources trixie→forky", "upgrade", "reboot"]);
    expect(f.getMarker()).toMatchObject({ phase: "neustart", from: "trixie", to: "forky" });
    // nach dem Neustart
    f.setCode("forky");
    f.calls.length = 0;
    expect(await checkAfterBoot(f.d)).toBe("fertig");
    expect(f.calls).toEqual(["healthy?"]);
    expect(f.getMarker()).toBeNull();
    expect(f.log.at(-1)).toMatchObject({ step: "os-upgrade", ok: true, detail: expect.stringContaining("fertig") });
    expect(await checkAfterBoot(f.d)).toBe("nichts");
  });

  it("Stack nach dem Neustart krank → automatisch zurück auf den Schnappschuss, Neustart, dann als zurückgenommen gemeldet", async () => {
    const f = fake({ healthy: false });
    await runOsUpgrade(f.d);
    f.setCode("forky");
    f.calls.length = 0;
    expect(await checkAfterBoot(f.d)).toBe("zurueck");
    expect(f.calls).toEqual(["healthy?", "restore", "reboot"]);
    expect(f.getMarker()).toMatchObject({ phase: "zurueck", error: expect.stringContaining("nicht gesund") });
    f.setCode("trixie");
    expect(await checkAfterBoot(f.d)).toBe("zurueck-gemeldet");
    expect(f.getMarker()).toBeNull();
    expect(f.log.at(-1)).toMatchObject({ step: "os-upgrade", ok: false, detail: expect.stringContaining("läuft wieder mit trixie") });
  });

  it("Reste früherer Rückwege (@kaputt-…): nach dem gemeldeten Rückweg und vor der Platzprüfung gelöscht", async () => {
    const f = fake({ broken: 1 });
    f.d.marker.write({ from: "trixie", to: "forky", phase: "zurueck", at: "x", error: "Stack krank" });
    expect(await checkAfterBoot(f.d)).toBe("zurueck-gemeldet");
    expect(f.log.at(-1)).toMatchObject({ step: "os-aufraeumen", ok: true, detail: expect.stringContaining("1 beiseitegelegte") });
    // vor dem nächsten Versuch: erst aufräumen, dann Platz messen
    let freedFirst = false;
    const g = fake({ broken: 2, freeBytes: async () => ((freedFirst = g.log.some((e) => e.step === "os-aufraeumen")), 20 * 1024 ** 3) });
    await runOsUpgrade(g.d);
    expect(freedFirst).toBe(true);
    // Löschen scheitert → nur gemeldet, der Versionswechsel läuft trotzdem
    const h = fake({ removeBroken: async () => Promise.reject(new Error("busy")) });
    expect(await runOsUpgrade(h.d)).toMatchObject({ status: "neustart" });
    expect(h.log[0]).toMatchObject({ step: "os-aufraeumen", ok: false, detail: expect.stringContaining("busy") });
  });

  it("Neustart mit alter Version oder unterbrochene Umstellung → zurück", async () => {
    const f = fake();
    await runOsUpgrade(f.d);
    f.calls.length = 0;
    expect(await checkAfterBoot(f.d)).toBe("zurueck"); // codename noch trixie
    expect(f.calls).toEqual(["restore", "reboot"]);
    const g = fake();
    g.d.marker.write({ from: "trixie", to: "forky", phase: "upgrade", at: "x" });
    expect(await checkAfterBoot(g.d)).toBe("zurueck");
    expect(g.getMarker()!.error).toMatch(/unterbrochen/);
  });

  it("apt scheitert → sofort zurück und Neustart, kein zweiter Versuch ohne Prüfung", async () => {
    const f = fake({ upgradeError: "dpkg: Fehler beim Bearbeiten von Paket x" });
    expect(await runOsUpgrade(f.d)).toMatchObject({ status: "fehlgeschlagen", error: expect.stringContaining("dpkg") });
    expect(f.calls).toEqual(["backup", "test-restore", "snapshot", "sources trixie→forky", "upgrade", "restore", "reboot"]);
    expect(f.getMarker()).toMatchObject({ phase: "zurueck" });
    expect(await runOsUpgrade(f.d)).toMatchObject({ status: "blockiert", reason: expect.stringContaining("schon im Gang") });
  });

  it("Vorbedingungen: Ziel, Platz, Sicherung, Test-Restore – nichts wird verändert", async () => {
    const cases: [ReturnType<typeof fake>, RegExp][] = [
      [fake({ code: "duke" }), /Keine neuere/],
      [fake({ freeBytes: async () => MIN_FREE_BYTES - 1 }), /Zu wenig Platz/],
      [fake({ backup: async () => Promise.reject(new Error("Backupserver nicht erreichbar")) }), /Sicherung fehlgeschlagen: Backupserver/],
      [fake({ testRestore: async () => ({ ok: false, error: "App startet nicht" }) }), /Test-Restore nicht grün: App startet nicht/],
    ];
    for (const [f, re] of cases) {
      expect(await runOsUpgrade(f.d)).toMatchObject({ status: "blockiert", reason: expect.stringMatching(re) });
      expect(f.calls.filter((c) => !["backup", "test-restore"].includes(c))).toEqual([]);
      expect(f.getMarker()).toBeNull();
    }
    expect(await runOsUpgrade(fake().d, { target: "duke" })).toMatchObject({ status: "blockiert", reason: expect.stringMatching(/einzeln/) });
    expect(await runOsUpgrade(fake().d, { target: "bookworm" })).toMatchObject({ status: "blockiert" });
  });

  it("GRUB-Eintrag für den Rückweg (deploy/grub.d) ist gültiges sh und bootet den Schnappschuss", () => {
    const script = readFileSync(new URL("../../../deploy/grub.d/41_schulos-rueckweg", import.meta.url), "utf8");
    expect(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
    expect(script).toContain("rootflags=subvol=@snapshots/vor-os-upgrade");
    // Kernel-Zeile wie im normalen Eintrag: Spiegel (rd.md.uuid) und Konsolen aus GRUB_CMDLINE_LINUX
    expect(script).toContain("$GRUB_CMDLINE_LINUX");
  });

  it("Prüfung nach dem Start läuft auch, wenn Docker nicht startet (sonst kein automatischer Rückweg)", () => {
    const unit = readFileSync(new URL("../../../deploy/systemd/schulos-os-upgrade-pruefen.service", import.meta.url), "utf8");
    expect(unit).not.toMatch(/^Requires=.*docker/m);
    expect(unit).toMatch(/^After=.*docker\.service/m);
  });
});
