// Was der Installer über die Maschine wissen muss (Platten, TPM2) – im Live-System per lsblk bzw. /sys ermittelt.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { secureBootFromEfivar } from "@schulos/server/boot-hardening";
import type { Disk, InstallContext } from "./questions";

interface LsblkDevice {
  path?: string;
  size?: number | string;
  model?: string | null;
  type?: string;
  ro?: boolean | string;
  mountpoints?: (string | null)[];
  mountpoint?: string | null;
  children?: LsblkDevice[];
}

function mounts(d: LsblkDevice): string[] {
  const own = [...(d.mountpoints ?? []), d.mountpoint ?? null].filter((m): m is string => !!m);
  return [...own, ...(d.children ?? []).flatMap(mounts)];
}

/**
 * `lsblk -J -b -o PATH,SIZE,MODEL,TYPE,RO,MOUNTPOINTS` auswerten: nur beschreibbare Platten, nicht das Startmedium
 * (Live-System unter /run/live) und nichts, was gerade eingehängt ist.
 */
export function parseLsblk(json: string): Disk[] {
  const data = JSON.parse(json) as { blockdevices?: LsblkDevice[] };
  return (data.blockdevices ?? [])
    .filter((d) => d.type === "disk" && d.path && d.ro !== true && d.ro !== "1" && Number(d.size) > 0 && mounts(d).length === 0)
    .map((d) => ({ path: d.path!, sizeBytes: Number(d.size), model: d.model?.trim() || "unbekannt" }));
}

const SECURE_BOOT_VAR = "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c";

/** TPM2 und Secure Boot (SEC-09: TPM2 nur mit Secure Boot); ohne EFI-Variable unbekannt */
function security(env: Record<string, string | undefined> = process.env): Pick<InstallContext, "tpm2" | "secureBoot"> {
  let sb: boolean | undefined;
  try {
    sb = secureBootFromEfivar(existsSync(SECURE_BOOT_VAR) ? readFileSync(SECURE_BOOT_VAR) : null);
  } catch {
    sb = undefined;
  }
  // Q-4E-60: im CI-Testmodus (start-installer.sh setzt SCHULOS_TESTMODUS nur mit Kernel-Parameter) gilt fehlendes Secure
  // Boot als „unbekannt“ – TPM2 bleibt dann wählbar
  if (sb === false && env.SCHULOS_TESTMODUS === "1") sb = undefined;
  return { tpm2: existsSync("/sys/class/tpm/tpm0"), ...(sb === undefined ? {} : { secureBoot: sb }) };
}

/** SCHULOS_INSTALLER_PLATTEN_UNGEPRUEFT=1: Plattennamen nicht gegen lsblk prüfen (Tests mit Loop-Geräten) */
export function detectContext(env: Record<string, string | undefined> = process.env): InstallContext {
  if (env.SCHULOS_INSTALLER_PLATTEN_UNGEPRUEFT === "1") return security(env);
  let disks: Disk[] = [];
  try {
    disks = parseLsblk(execFileSync("lsblk", ["-J", "-b", "-o", "PATH,SIZE,MODEL,TYPE,RO,MOUNTPOINTS"], { encoding: "utf8" }));
  } catch {
    // kein lsblk (Entwicklung unter Windows) → Platten werden nicht gegen den Rechner geprüft
    return security(env);
  }
  return { disks, ...security(env) };
}
