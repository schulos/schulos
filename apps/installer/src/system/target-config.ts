// Konfigurationsdateien des installierten Systems (Teil 1: Platte, Netz, Sprache, Zugang, Paketquellen). Rein.
import { sshdConfig, sshNetList } from "@schulos/server/ssh-netz";
import type { Answers } from "../questions";
import { BOOT_LABEL, ROOT_LABEL, usesTpm2, type Layout } from "./layout";

const s = (a: Answers, id: string, d = "") => (typeof a[id] === "string" ? (a[id] as string) : d);
const xs = (a: Answers, id: string) => (Array.isArray(a[id]) ? (a[id] as string[]) : []);

export function fstab(l: Layout): string {
  const btrfs = (mount: string, subvol: string, extra = ",compress=zstd:1") => `LABEL=${ROOT_LABEL}  ${mount.padEnd(12)} btrfs  subvol=${subvol},noatime${extra}  0 0`;
  return [
    "# SchulOS – angelegt vom Installer. System (@) und Daten (@srv) sind getrennte Subvolumes: Schnappschüsse des Systems lassen die Daten unberührt.",
    btrfs("/", "@"),
    btrfs("/srv", "@srv"),
    btrfs("/.snapshots", "@snapshots", ""),
    `LABEL=${BOOT_LABEL}  ${"/boot".padEnd(12)} ext4   defaults,noatime  0 2`,
    // nofail: fällt im Spiegel eine Platte aus, startet das System trotzdem
    ...l.esps.map((e) => `PARTLABEL=${e.label}  ${e.mount.padEnd(12)} vfat   umask=0077,nofail,x-systemd.device-timeout=10s  0 2`),
    "",
  ].join("\n");
}

export function crypttab(l: Layout): string | null {
  if (l.encryption === "none") return null;
  // SEC-09: tpm2-pin=yes kennzeichnet die PIN-Abfrage (schulosctl: kein Neustart ohne Mensch); maßgeblich sind die Token-Daten
  const opts = ["luks", "discard", ...(usesTpm2(l.encryption) ? ["tpm2-device=auto"] : []), ...(l.encryption === "tpm2-pin" ? ["tpm2-pin=yes"] : [])];
  const what =
    l.encryption === "tpm2"
      ? "entsperrt per TPM2 an PCR 7+8+9 (Wiederherstellungsschlüssel als Rückweg)"
      : l.encryption === "tpm2-pin"
        ? "entsperrt per TPM2 + PIN (Wiederherstellungsschlüssel als Rückweg)"
        : "Passphrase beim Start";
  return `# SchulOS – ${what}\n${l.mapper} ${l.baseStable} none ${opts.join(",")}\n`;
}

/**
 * dracut: Verschlüsselung (systemd-cryptsetup, TPM2), Spiegel und btrfs im Initramfs. `hostonly` = nur die Treiber dieser
 * Maschine; das Abbild (B-46) startet auf fremden VMs (virtio-blk, virtio-scsi, SATA …) und bekommt alle.
 */
export function dracutConf(l: Layout, hostonly = true): string {
  const modules = ["btrfs", ...(l.md ? ["mdraid"] : []), ...(l.encryption !== "none" ? ["crypt", "systemd-cryptsetup"] : []), ...(usesTpm2(l.encryption) ? ["tpm2-tss"] : [])];
  return [`# SchulOS`, `hostonly="${hostonly ? "yes" : "no"}"`,`add_dracutmodules+=" ${modules.join(" ")} "`, ...(l.encryption !== "none" ? [`install_items+=" /etc/crypttab "`] : []), ""].join("\n");
}

export function networkFile(a: Answers): string {
  const lines = ["# SchulOS – Netzwerk (Installer)", "[Match]", "Name=en* eth*", "", "[Network]"];
  if (a["network.mode"] === "static") {
    lines.push(`Address=${s(a, "network.address")}`, `Gateway=${s(a, "network.gateway")}`, ...xs(a, "network.dns").map((d) => `DNS=${d}`));
  } else {
    lines.push("DHCP=yes");
  }
  return lines.join("\n") + "\n";
}

export function hostsFile(hostname: string): string {
  return `127.0.0.1 localhost\n127.0.1.1 ${hostname}\n::1 localhost ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n`;
}

/** Tastatur für Konsole (console-setup): „de-nodeadkeys“ = Layout de, Variante nodeadkeys */
export function keyboardFile(layoutName: string): string {
  const [layout, variant = ""] = layoutName.split("-");
  return `XKBMODEL="pc105"\nXKBLAYOUT="${layout}"\nXKBVARIANT="${variant}"\nXKBOPTIONS=""\nBACKSPACE="guess"\n`;
}

/**
 * console-setup im Zielsystem (INST-03): ohne diese Datei nimmt setupcon ISO-8859-15 – tty1 zeigt „Â·“ statt „·“. UTF-8 mit der
 * Uni2-Terminus-Schrift; die SchulOS-Schrift (passende Größe) lädt konsole.sh darüber (setfont).
 */
export function consoleSetupFile(): string {
  return [
    "# SchulOS (INST-03): UTF-8-Konsole",
    'ACTIVE_CONSOLES="/dev/tty[1-6]"',
    'CHARMAP="UTF-8"',
    'CODESET="Uni2"',
    'FONTFACE="TerminusBold"',
    'FONTSIZE="16"',
    'VIDEOMODE=""',
    "",
  ].join("\n");
}

export const LOCALE = "de_DE.UTF-8";

export function aptSources(): string {
  return [
    "Types: deb",
    "URIs: http://deb.debian.org/debian",
    "Suites: trixie trixie-updates",
    "Components: main",
    "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
    "",
    "Types: deb",
    "URIs: http://security.debian.org/debian-security",
    "Suites: trixie-security",
    "Components: main",
    "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
    "",
  ].join("\n");
}

export function aptProxy(proxy: string): string {
  return `Acquire::http::Proxy "${proxy}";\nAcquire::https::Proxy "${proxy}";\n`;
}

/**
 * GRUB: kurzes Menü, Ausgabe auch seriell (Fernwartung per IPMI/Serial-over-LAN, QEMU-Tests). Hauptkonsole (Passphrase,
 * Startfehler) nach Wahl: Bildschirm (Vorgabe) oder seriell.
 */
export function grubDefaults(primary: "screen" | "serial" = "screen"): string {
  // die zuletzt genannte Konsole ist /dev/console: dort fragt systemd nach der Passphrase und meldet Startfehler
  const consoles = primary === "serial" ? "console=tty0 console=ttyS0,115200" : "console=ttyS0,115200 console=tty0";
  return [
    "# SchulOS",
    "GRUB_TIMEOUT=3",
    `GRUB_CMDLINE_LINUX="${consoles}"`,
    'GRUB_TERMINAL="console serial"',
    'GRUB_SERIAL_COMMAND="serial --unit=0 --speed=115200"',
    "",
  ].join("\n");
}

/** SSH: nur für das Wartungskonto; mit Schlüssel keine Passwort-Anmeldung; SEC-12: nur aus den erlaubten Netzen (zusätzlich zur Firewall) */
export function sshdConf(a: Answers): string {
  return sshdConfig(sshNets(a), xs(a, "access.ssh_keys").length > 0);
}

/** SEC-12: erlaubte Netze für SSH; null = von überall (0.0.0.0/0 bzw. ::/0 eingetragen) */
export function sshNets(a: Answers): string[] | null {
  return sshNetList(xs(a, "network.internal_nets"));
}

// SEC-12/G4E-O06/O17: Regel, Dienst und die Bindung von ssh.service liegen in @schulos/server/ssh-netz (auch für schulosctl ssh-netze)
export { SSH_NET_FILE, SSH_NET_UNIT, SSH_REQUIRES_DROPIN, sshNetRules, sshNetUnit, sshRequiresDropin } from "@schulos/server/ssh-netz";

/** Pakete des Grundsystems (debootstrap aus der Offline-Paketquelle der ISO) */
export const BASE_PACKAGES = [
  "grub-efi-amd64",
  "efibootmgr",
  "cryptsetup",
  "systemd-cryptsetup",
  "tpm2-tools",
  "btrfs-progs",
  "mdadm",
  "dosfstools",
  "e2fsprogs",
  "locales",
  "console-setup",
  "keyboard-configuration",
  "tzdata",
  "sudo",
  "openssh-server",
  "ca-certificates",
  "curl",
];

/**
 * Kernel und Initramfs danach per apt in der chroot: debootstrap löst „initramfs-tools | linux-initramfs-tool“ nicht auf und
 * installiert initramfs-tools neben dracut (Konflikt). apt nimmt dracut, wenn es mit angefordert ist.
 * systemd-resolved ebenfalls hier: sein postinst biegt /etc/resolv.conf um und scheitert in debootstrap; apt lädt erst alle
 * Pakete und konfiguriert danach, DNS wird dann nicht mehr gebraucht.
 */
// shim + signiertes GRUB: Start auch mit Secure Boot, und dieselbe Startkette wie die ISO – shim misst in PCR 7, an das der
// TPM2-Schlüssel gebunden ist; ohne shim im Zielsystem passt PCR 7 beim Start von der Platte nicht (QEMU-Test: Abfrage des
// Wiederherstellungsschlüssels)
// nftables: SEC-12 (SSH nur aus dem Schulnetz)
export const KERNEL_PACKAGES = ["dracut", "linux-image-amd64", "firmware-linux-free", "systemd-resolved", "shim-signed", "grub-efi-amd64-signed", "nftables"];

/** Abbild (B-46): growpart (Wurzel wächst mit der VM-Platte) und der Gast-Agent für Proxmox (IP in der Übersicht, sauberes Herunterfahren) */
export const IMAGE_PACKAGES = ["cloud-guest-utils", "qemu-guest-agent"];

/** Paketquelle während der Installation: dieselbe wie für debootstrap; die eigene Offline-Quelle der ISO ist nicht signiert */
export function installSource(mirror: string): string {
  return `deb ${mirror.startsWith("file:") ? "[trusted=yes] " : ""}${mirror} trixie main\n`;
}
