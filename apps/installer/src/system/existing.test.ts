import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkOverwrite,
  describeExisting,
  markerContent,
  OVERWRITE_EXIT,
  overwriteConfirmed,
  overwriteDecision,
  parseMarker,
  probeDisk,
  raidDataOffset,
  readIfExists,
  type Exec,
  type ProbeDeps,
} from "./existing";
import { INSTALLED_MARKER } from "./layout";

const SCRIPT = path.resolve(__dirname, "../../../../iso/live/config/includes.chroot/usr/local/lib/schulos/start-installer.sh");
const EXAMINE_12 = "/dev/vda2:\n          Magic : a92b4efc\n        Version : 1.2\n    Data Offset : 2048 sectors\n   Super Offset : 8 sectors\n";

/**
 * Ersatz-Platten mit echtem Dateisystem: „mount“ legt den Inhalt der Boot-Partition (Markierung) ins echte Verzeichnis, „umount“
 * räumt es wieder leer – so laufen mkdtemp, das Lesen der Markierung und rmdir (nur leer möglich) wirklich.
 */
function fakeDisks(parts: Record<string, { type: string; marker?: string; examine?: string; mountFails?: boolean }>) {
  const calls: string[][] = [];
  let mounted: string | null = null;
  const exec: Exec = (argv) => {
    calls.push(argv);
    const [cmd] = argv;
    if (cmd === "blkid") {
      const p = parts[argv.at(-1)!];
      return p ? { code: 0, stdout: `${p.type}\n`, stderr: "" } : { code: 2, stdout: "", stderr: "" };
    }
    if (cmd === "mdadm") return { code: 0, stdout: parts[argv.at(-1)!]?.examine ?? "", stderr: "" };
    if (cmd === "mount") {
      const [dev, dir] = argv.slice(-2) as [string, string];
      const p = parts[dev]!;
      if (p.mountFails) return { code: 32, stdout: "", stderr: "wrong fs type" };
      mkdirSync(path.join(dir, "grub"), { recursive: true });
      if (p.marker !== undefined) writeFileSync(path.join(dir, INSTALLED_MARKER), p.marker);
      mounted = dir;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "umount") {
      expect(argv[1]).toBe(mounted);
      for (const e of readdirSync(argv[1]!)) rmSync(path.join(argv[1]!, e), { recursive: true });
      mounted = null;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unerwartet: ${argv.join(" ")}`);
  };
  return { exec, calls, isMounted: () => mounted !== null };
}

describe("Überschreibschutz (INST-06)", () => {
  let base: string;
  let dirs: string[];
  const deps = (exec: Exec): ProbeDeps => ({
    exec,
    mkdtemp: () => {
      const d = mkdtempSync(path.join(base, "pruefung-"));
      dirs.push(d);
      return d;
    },
    read: readIfExists,
    rmdir: (d) => rmdirSync(d),
  });
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "inst06-"));
    dirs = [];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("Markierung: Rolle/Version/Datum hin und zurück; ältere Markierung ohne Angaben", () => {
    const text = markerContent({ role: "backup", version: "v0.3.2", date: "2026-10-12" });
    expect(text.split("\n")[0]).toBe("SchulOS ist installiert.");
    expect(parseMarker(text)).toEqual({ role: "backup", version: "v0.3.2", date: "2026-10-12" });
    expect(parseMarker("SchulOS ist installiert.\n")).toEqual({});
    expect(describeExisting({ disk: "/dev/vda", role: "main", version: "v0.3.2", date: "2026-10-12" })).toBe("/dev/vda: Hauptsystem, Version v0.3.2, installiert am 2026-10-12");
    expect(describeExisting({ disk: "/dev/vda" })).toBe("/dev/vda: Rolle/Version/Datum nicht lesbar");
  });

  it("Daten-Offset eines Spiegel-Mitglieds aus mdadm --examine", () => {
    expect(raidDataOffset(EXAMINE_12)).toBe(2048 * 512);
    expect(raidDataOffset("Version : 1.0\n")).toBe(0);
  });

  it("erkennt die Markierung auf einer einfachen Boot-Partition – nur lesend eingehängt, danach wieder ausgehängt", () => {
    const f = fakeDisks({ "/dev/vda2": { type: "ext4", marker: markerContent({ role: "main", version: "v0.3.1", date: "2026-10-11" }) } });
    expect(probeDisk("/dev/vda", deps(f.exec))).toEqual({ disk: "/dev/vda", role: "main", version: "v0.3.1", date: "2026-10-11" });
    const mount = f.calls.find((c) => c[0] === "mount")!;
    expect(mount).toEqual(["mount", "-t", "ext4", "-o", "ro,noload,nodev,nosuid,noexec", "/dev/vda2", dirs[0]]);
    expect(f.calls.some((c) => c[0] === "umount")).toBe(true);
    expect(f.isMounted()).toBe(false);
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it("Spiegel (RAID 1, Metadaten 1.2): Mitglied über den Daten-Offset einhängen, ohne den Spiegel zusammenzusetzen", () => {
    const f = fakeDisks({
      "/dev/nvme0n1p2": { type: "linux_raid_member", examine: EXAMINE_12, marker: "SchulOS ist installiert.\n" },
      "/dev/nvme1n1p2": { type: "linux_raid_member", examine: EXAMINE_12, marker: "SchulOS ist installiert.\n" },
    });
    const d = deps(f.exec);
    expect(probeDisk("/dev/nvme0n1", d)).toEqual({ disk: "/dev/nvme0n1" });
    const mount = f.calls.find((c) => c[0] === "mount")!;
    expect(mount[4]).toBe("ro,noload,nodev,nosuid,noexec,offset=1048576");
    expect(mount[5]).toBe("/dev/nvme0n1p2");
    expect(f.calls.some((c) => c[0] === "mdadm" && c[1] !== "--examine")).toBe(false);
  });

  it("keine Markierung, fremdes Dateisystem, keine Partition, Einhängen scheitert: nichts erkannt, nichts bleibt eingehängt", () => {
    const f = fakeDisks({
      "/dev/sda2": { type: "ext4" },
      "/dev/sdb2": { type: "ntfs" },
      "/dev/sdd2": { type: "ext4", mountFails: true },
    });
    const d = deps(f.exec);
    for (const disk of ["/dev/sda", "/dev/sdb", "/dev/sdc", "/dev/sdd"]) expect(probeDisk(disk, d)).toBeNull();
    // ntfs und fehlende Partition werden gar nicht eingehängt
    expect(f.calls.filter((c) => c[0] === "mount").map((c) => c.at(-2))).toEqual(["/dev/sda2", "/dev/sdd2"]);
    expect(f.isMounted()).toBe(false);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("Entscheidung: ohne Fund weiter; interaktiv immer fragen; ohne Oberfläche nur mit Schalter", () => {
    const found = [{ disk: "/dev/vda" }];
    expect(overwriteDecision([], { interactive: false, overwrite: false })).toBe("weiter");
    expect(overwriteDecision(found, { interactive: true, overwrite: true })).toBe("fragen");
    expect(overwriteDecision(found, { interactive: false, overwrite: false })).toBe("abbruch");
    expect(overwriteDecision(found, { interactive: false, overwrite: true })).toBe("weiter");
    expect(overwriteConfirmed(" ÜBERSCHREIBEN ")).toBe(true);
    expect(overwriteConfirmed("überschreiben")).toBe(true);
    expect(overwriteConfirmed("UEBERSCHREIBEN")).toBe(true);
    for (const no of ["", "ja", "j", "y", "UEBERSCHREIBE"]) expect(overwriteConfirmed(no)).toBe(false);
  });

  describe("Ablauf vor dem Löschen", () => {
    const installed = () =>
      fakeDisks({
        "/dev/vda2": { type: "linux_raid_member", examine: EXAMINE_12, marker: markerContent({ role: "backup", version: "v0.3.1", date: "2026-10-11" }) },
        "/dev/vdb2": { type: "linux_raid_member", examine: EXAMINE_12, marker: markerContent({ role: "backup", version: "v0.3.1", date: "2026-10-11" }) },
      });
    function terminal() {
      const input = new PassThrough();
      const output = new PassThrough();
      let screen = "";
      output.on("data", (b: Buffer) => (screen += b.toString("utf8")));
      const type = async (text: string, line: string) => {
        for (let i = 0; i < 200 && !screen.includes(text); i++) await new Promise((r) => setTimeout(r, 5));
        expect(screen).toContain(text);
        input.write(`${line}\n`);
      };
      return { io: { input, output }, input, type, screen: () => screen };
    }

    it("unbeaufsichtigt ohne Schalter: Abbruch mit klarer Meldung, nichts verändert", async () => {
      const t = terminal();
      const r = await checkOverwrite(["/dev/vda", "/dev/vdb"], { interactive: false, overwrite: false }, { ...deps(installed().exec), io: t.io });
      expect(r.ok).toBe(false);
      const msg = r.ok ? "" : r.message;
      expect(msg).toContain("bereits SchulOS installiert");
      expect(msg).toContain("/dev/vda: Backupserver, Version v0.3.1, installiert am 2026-10-11");
      expect(msg).toContain("/dev/vdb");
      expect(msg).toContain("SCHULOSCFG");
      expect(msg).toContain("„ueberschreiben“");
      expect(t.screen()).toBe("");
    });

    it("unbeaufsichtigt mit Schalter: Freigabe mit Protokollzeile", async () => {
      const t = terminal();
      const r = await checkOverwrite(["/dev/vda", "/dev/vdb"], { interactive: false, overwrite: true }, { ...deps(installed().exec), io: t.io });
      expect(r).toMatchObject({ ok: true, notice: expect.stringContaining("/dev/vda, /dev/vdb") });
    });

    it("leere Platte: weiter ohne Rückfrage", async () => {
      const t = terminal();
      const r = await checkOverwrite(["/dev/vda"], { interactive: true, overwrite: false }, { ...deps(fakeDisks({}).exec), io: t.io });
      expect(r).toEqual({ ok: true, found: [], notice: null });
      expect(t.screen()).toBe("");
    });

    it("interaktiv: Rolle/Version/Datum angezeigt, nur „ÜBERSCHREIBEN“ gibt frei", async () => {
      const t = terminal();
      const done = checkOverwrite(["/dev/vda"], { interactive: true, overwrite: false }, { ...deps(installed().exec), io: t.io });
      await t.type("„ÜBERSCHREIBEN“ eintippen", "ÜBERSCHREIBEN");
      expect(t.screen()).toContain("Auf dieser Platte ist bereits SchulOS installiert");
      expect(t.screen()).toContain("Backupserver, Version v0.3.1, installiert am 2026-10-11");
      expect(await done).toMatchObject({ ok: true, notice: null });
    });

    it("interaktiv: alles andere (auch Enter) bricht ab", async () => {
      for (const answer of ["", "ja"]) {
        const t = terminal();
        const done = checkOverwrite(["/dev/vda"], { interactive: true, overwrite: true }, { ...deps(installed().exec), io: t.io });
        await t.type("eintippen", answer);
        expect(await done).toMatchObject({ ok: false, message: expect.stringContaining("bleibt unverändert") });
      }
    });

    it("interaktiv: Eingabe endet (EOF) – keine Freigabe", async () => {
      const t = terminal();
      const done = checkOverwrite(["/dev/vda"], { interactive: true, overwrite: false }, { ...deps(installed().exec), io: t.io });
      for (let i = 0; i < 200 && !t.screen().includes("eintippen"); i++) await new Promise((r) => setTimeout(r, 5));
      t.input.end();
      expect((await done).ok).toBe(false);
    });
  });

  it("start-installer.sh: Schalter „ueberschreiben“, SCHULOSCFG gemeldet, Code 5 ohne Neustart-Schleife", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh).toContain("flag ueberschreiben && ARGS+=(--ueberschreiben)");
    const start = sh.indexOf(`elif [ $rc -eq ${OVERWRITE_EXIT} ]; then`);
    expect(start).toBeGreaterThan(-1);
    const branch = sh.slice(start, sh.indexOf("\nelse\n", start));
    // CI (danach-aus): ausschalten; sonst nur auf Tastendruck – nie von selbst neu starten oder neu installieren
    // „danach-aus“ liegt auf dem Stick – erst lesen, dann aushängen (QEMU 4b hing sonst am Tastendruck)
    expect(branch.indexOf("flag danach-aus && aus=1")).toBeGreaterThan(-1);
    expect(branch.indexOf("flag danach-aus && aus=1")).toBeLessThan(branch.indexOf('umount -l "$CFG"'));
    expect(branch).toContain('[ "$aus" = 1 ] && exec systemctl poweroff');
    expect(branch).not.toMatch(/sleep 30|read -r -t/);
    expect(branch.indexOf("exec systemctl reboot")).toBeGreaterThan(branch.indexOf("read -r -p"));
    expect(branch).toContain("Konfigurations-Stick (SCHULOSCFG) JETZT abziehen");
    expect(branch).toContain("|| sleep 3600");
  });

  // SCHULOSCFG auf eigenem Stick oder auf dem Datenträger des Live-Systems? Die Zeilen aus start-installer.sh mit Ersatz für lsblk/findmnt
  const bash = spawnSync("bash", ["-c", "exit 0"]).status === 0;
  it.skipIf(!bash)("start-installer.sh: SCHULOSCFG auf demselben Datenträger wie das Live-Medium gilt als Medium, sonst als Stick", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    const lines = sh.split("\n");
    const from = lines.findIndex((l) => l.trimStart().startsWith("disk_of() {"));
    const to = lines.findIndex((l) => l.includes("export SCHULOS_CFG_ORT=medium"));
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const snippet = lines.slice(from, to + 1).join("\n");
    const bin = path.join(base, "bin");
    mkdirSync(bin);
    // lsblk -dno PKNAME|KNAME <gerät>: Partition → Platte aus FAKE_PK, ganze Platte → leer bzw. eigener Name
    writeFileSync(path.join(bin, "lsblk"), '#!/bin/sh\nd=$3; n=${d#/dev/}\nif [ "$2" = PKNAME ]; then case "$n" in sd?[0-9]) echo "${n%[0-9]}";; *) echo "";; esac; else echo "$n"; fi\n');
    writeFileSync(path.join(bin, "findmnt"), '#!/bin/sh\necho "$FAKE_LIVE"\n');
    const run = (dev: string, live: string) => {
      const r = spawnSync("bash", ["-c", `cd "${bin.replace(/\\/g, "/")}" && chmod +x lsblk findmnt && export PATH="$(pwd):$PATH" && cd / || exit 1; dev=${dev}\n${snippet}\necho "$SCHULOS_CFG_ORT"`], {
        encoding: "utf8",
        env: { ...process.env, FAKE_LIVE: live },
      });
      expect(r.stderr).toBe("");
      return r.stdout.trim();
    };
    expect(run("/dev/sdc1", "/dev/sdb1")).toBe("stick"); // eigener USB-Stick
    expect(run("/dev/sdb2", "/dev/sdb1")).toBe("medium"); // zusätzliche Partition auf dem ISO-Stick
    expect(run("/dev/vdb", "/dev/sr0")).toBe("stick"); // QEMU: Laufwerk ohne Partitionstabelle, Medium als DVD
    expect(run("/dev/vdb", "")).toBe("stick"); // Live-Medium nicht gefunden (z. B. toram)
  });
});
