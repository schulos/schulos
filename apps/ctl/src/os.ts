// Echte Schritte für den Debian-Versionswechsel und den Neustart im Wartungsfenster (B-43) – auf dem Host als root.
// Layout vom Installer (B-42): btrfs mit @ (System, eingehängt als /), @srv (/srv), @snapshots (/.snapshots); /boot eigene
// ext4-Partition. Der Schnappschuss von @ enthält /boot nicht – deshalb liegt daneben eine tar-Sicherung von /boot.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exec } from "@schulos/server/exec";
import { parseOsRelease } from "@schulos/server/system";
import { parseDf } from "./core";
import type { OsDeps, OsUpgradeMarker } from "./os-upgrade";
import { rewriteSources } from "./os-upgrade";
import { stackStable, testRestore, type Stack } from "./stack";
import type { UpdateDeps } from "./update";

export const SNAPSHOT = "/.snapshots/vor-os-upgrade";
/** auf @srv: bleibt beim Zurücktauschen von @ erhalten */
export const MARKER = "/srv/schulos-os-upgrade.json";
export const BOOT_BACKUP = "/srv/schulos-os-upgrade-boot.tar";
export const SOURCES = "/etc/apt/sources.list.d/debian.sources";
export const REBOOT_REQUIRED = "/run/reboot-required";
const TOP = "/run/schulos-btrfs";

async function must(cmd: string, args: string[], what: string, env?: Record<string, string>): Promise<string> {
  const r = await exec(cmd, args, env ? { env } : {});
  if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? `Exit ${r.code}`}`);
  return r.stdout;
}

/** Gerät des btrfs unter / (findmnt zeigt „/dev/mapper/schulos-root[/@]“) */
async function rootDevice(): Promise<string> {
  return (await must("findmnt", ["-no", "SOURCE", "/"], "Wurzelgerät")).trim().replace(/\[.*\]$/, "");
}

/** btrfs-Wurzel (subvolid=5) einhängen, in der @, @srv, @snapshots und die @kaputt-… liegen */
async function withTop<T>(fn: (top: string) => Promise<T>): Promise<T> {
  const dev = await rootDevice();
  await must("mkdir", ["-p", TOP], "Einhängepunkt");
  await must("mount", ["-o", "subvolid=5", dev, TOP], "btrfs-Wurzel einhängen");
  try {
    return await fn(TOP);
  } finally {
    await exec("umount", [TOP]);
  }
}

export function osDeps(
  s: Stack,
  o: {
    log: OsDeps["log"];
    healthTimeoutMs: number;
    /** Sicherung wie bei Updates (stackDeps) */
    backup: UpdateDeps["backup"];
    /** Update-Sperre (/opt/schulos/updates/update.lock) – liegt auf @ und darf nicht im Schnappschuss landen */
    lockFile: string;
  },
): OsDeps {
  return {
    now: () => new Date(),
    log: o.log,
    codename: async () => parseOsRelease(readFileSync("/etc/os-release", "utf8")).codename,
    freeBytes: async () => parseDf(await must("df", ["-P", "-B1", "/"], "Speicherplatz"))?.freeBytes ?? 0,
    backup: o.backup,
    testRestore: async () => {
      const r = await testRestore(s, o.healthTimeoutMs);
      return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
    },
    snapshot: async () => {
      if (existsSync(SNAPSHOT)) await must("btrfs", ["subvolume", "delete", SNAPSHOT], "alten Schnappschuss löschen");
      await must("btrfs", ["subvolume", "snapshot", "/", SNAPSHOT], "Schnappschuss von /");
      // os-upgrade läuft unter der Update-Sperre: ohne dies brächte jeder Rückweg eine verwaiste Sperre zurück
      rmSync(path.join(SNAPSHOT, o.lockFile), { force: true });
      writeFileSync(`${SNAPSHOT}.kernel`, (await must("uname", ["-r"], "Kernel")).trim() + "\n");
      await must("tar", ["-C", "/boot", "--exclude=./efi", "--exclude=./efi2", "-cpf", BOOT_BACKUP, "."], "/boot sichern");
      // Bootmenü-Eintrag für den Rückweg von Hand (/etc/grub.d/41_schulos-rueckweg)
      await must("update-grub", [], "Bootmenü");
    },
    setSources: async (from, to) => writeFileSync(SOURCES, rewriteSources(readFileSync(SOURCES, "utf8"), from, to)),
    upgrade: async () => {
      const env = { DEBIAN_FRONTEND: "noninteractive", NEEDRESTART_MODE: "a", APT_LISTCHANGES_FRONTEND: "none" };
      await must("apt-get", ["update"], "Paketlisten", env);
      // vorher getestete Antworten: eigene Konfigurationsdateien behalten, neue Vorgaben nur, wo nichts geändert wurde
      await must("apt-get", ["--yes", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "full-upgrade"], "full-upgrade", env);
    },
    restore: async () => {
      if (!existsSync(SNAPSHOT)) throw new Error(`Kein Schnappschuss ${SNAPSHOT} – Rückweg nur über die Neuinstallation (aus Backup)`);
      await withTop(async (top) => {
        // laufendes System bleibt bis zum Neustart auf dem umbenannten Subvolume (danach gelöscht: removeBroken)
        const broken = `${top}/@kaputt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await must("mv", [`${top}/@`, broken], "@ beiseitelegen");
        await must("btrfs", ["subvolume", "snapshot", `${top}/@snapshots/vor-os-upgrade`, `${top}/@`], "Schnappschuss als @");
      });
      // /boot passend zum alten System (Kernel, Initramfs, grub.cfg); die EFI-Partitionen bleiben
      await must("find", ["/boot", "-mindepth", "1", "-maxdepth", "1", "!", "-name", "efi", "!", "-name", "efi2", "-exec", "rm", "-rf", "{}", "+"], "/boot leeren");
      await must("tar", ["-C", "/boot", "-xpf", BOOT_BACKUP], "/boot zurückspielen");
    },
    reboot: async () => void (await exec("systemctl", ["reboot"])),
    removeBroken: () =>
      withTop(async (top) => {
        const broken = readdirSync(top).filter((n) => n.startsWith("@kaputt-"));
        for (const n of broken) await must("btrfs", ["subvolume", "delete", `${top}/${n}`], `${n} löschen`);
        return broken.length;
      }),
    stackHealthy: async () => {
      // nach dem Start: bis zur Frist warten, bis alle Dienste laufen und stabil bleiben
      const until = Date.now() + o.healthTimeoutMs;
      while (Date.now() < until) {
        if ((await exec("systemctl", ["is-active", "--quiet", "docker"])).code === 0 && (await stackStable(s, 20_000))) return true;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      return false;
    },
    marker: {
      read: () => (existsSync(MARKER) ? (JSON.parse(readFileSync(MARKER, "utf8")) as OsUpgradeMarker) : null),
      write: (m) => writeFileSync(MARKER, `${JSON.stringify(m)}\n`, { mode: 0o600 }),
      clear: () => rmSync(MARKER, { force: true }),
    },
  };
}

/** Muss neu gestartet werden (Kernel, libc …)? Debian legt dafür /run/reboot-required an. */
export function rebootRequired(): boolean {
  return existsSync(REBOOT_REQUIRED);
}
