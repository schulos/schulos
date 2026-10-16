// Plattenaufteilung (INSTALLATION.md §2, §5a.1): GPT/UEFI, je Platte eine EFI-Partition, eine /boot-Partition und eine
// Systempartition; bei zwei Platten je ein mdadm-Spiegel (RAID 1) für /boot und für das System; auf dem System LUKS2 (TPM2
// oder Passphrase; „aus“ nur Demo) und btrfs mit den Subvolumes @ (System), @srv (Daten, nicht im System-Schnappschuss)
// und @snapshots. /boot bleibt unverschlüsselt: GRUB kann LUKS2 mit Argon2 nicht öffnen (und TPM2 schon gar nicht) – Kernel
// und Initramfs liegen deshalb dort, entsperrt wird im Initramfs (systemd-cryptsetup). Rein.
//
// Alles wird über feste Namen angesprochen (Partitions-Label, md-Name, Dateisystem-Label) statt über UUIDs – so stehen
// fstab und crypttab schon fest, bevor die Platte formatiert ist.

/** SEC-09: „tpm2“ = PCR 7+8+9 (nach dem ersten Start, tpm-binden.sh), „tpm2-pin“ = PCR 7 + PIN bei jedem Start */
export type Encryption = "tpm2" | "tpm2-pin" | "passphrase" | "none";

export const usesTpm2 = (e: Encryption) => e === "tpm2" || e === "tpm2-pin";

export interface Layout {
  disks: string[];
  /** EFI-Partitionen (FAT32), eine je Platte – jede bootfähig, damit der Spiegel auch ohne erste Platte startet */
  esps: { device: string; label: string; mount: string }[];
  /** /boot-Partitionen (eine je Platte) */
  bootParts: string[];
  /** Gerät für /boot (ext4): Partition oder md-Spiegel */
  boot: string;
  bootMd: string | null;
  /** Systempartitionen (eine je Platte) */
  parts: string[];
  /** mdadm-Spiegel über die Systempartitionen (nur bei zwei Platten) */
  md: string | null;
  /** Gerät unter LUKS bzw. btrfs: Partition oder md */
  base: string;
  /** stabiler Pfad für crypttab bzw. fstab */
  baseStable: string;
  encryption: Encryption;
  /** geöffnetes LUKS-Gerät (/dev/mapper/…) bzw. base */
  root: string;
  mapper: string;
}

export const ESP_SIZE = "+512M";
export const BOOT_SIZE = "+1G";
export const ROOT_LABEL = "schulos";
export const BOOT_LABEL = "schulos-boot";
/**
 * GATE-4f C-03: Markierung auf der Boot-Partition, die der Installer erst nach erfolgreichem Abschluss schreibt (bzw. die
 * Einrichtung eines Abbilds). Nur dann bietet das Startmenü des Mediums „Von der Festplatte starten“ als Vorgabe an
 * (iso/live/config/bootloaders/grub-pc/grub.cfg sucht `/grub/schulos-installiert`).
 */
export const INSTALLED_MARKER = "grub/schulos-installiert";
export const PART_LABEL = "schulos-system";
export const BOOT_PART_LABEL = "schulos-boot";
export const MD_NAME = "schulos";
export const BOOT_MD_NAME = "schulos-boot";
export const MAPPER = "schulos-root";
export const SUBVOLUMES = ["@", "@srv", "@snapshots"] as const;

/** n-te Partition eines Geräts: /dev/sda → /dev/sda1, /dev/nvme0n1 → /dev/nvme0n1p1, /dev/disk/by-id/x → x-part1 */
export function partition(disk: string, n: number): string {
  if (disk.startsWith("/dev/disk/by-")) return `${disk}-part${n}`;
  return /\d$/.test(disk) ? `${disk}p${n}` : `${disk}${n}`;
}

export function layout(disks: string[], encryption: Encryption): Layout {
  if (disks.length < 1 || disks.length > 2) throw new Error("Eine oder zwei Platten");
  const mirror = disks.length === 2;
  const esps = disks.map((d, i) => ({ device: partition(d, 1), label: i === 0 ? "EFI" : `EFI${i + 1}`, mount: i === 0 ? "/boot/efi" : `/boot/efi${i + 1}` }));
  const bootParts = disks.map((d) => partition(d, 2));
  const bootMd = mirror ? `/dev/md/${BOOT_MD_NAME}` : null;
  const parts = disks.map((d) => partition(d, 3));
  const md = mirror ? `/dev/md/${MD_NAME}` : null;
  const base = md ?? parts[0]!;
  const baseStable = md ?? `/dev/disk/by-partlabel/${PART_LABEL}`;
  const root = encryption === "none" ? base : `/dev/mapper/${MAPPER}`;
  return { disks, esps, bootParts, boot: bootMd ?? bootParts[0]!, bootMd, parts, md, base, baseStable, encryption, root, mapper: MAPPER };
}
