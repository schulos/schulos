// Systemschritte (B-42, Teil 1): aus dem Installationsplan eine Liste von Befehlen (argv, keine Shell-Zeichenketten) und
// Dateien – rein und testbar. Ausgeführt werden sie von run.ts im Live-System als root.
import { GRUB_PASSWORD_KEY, type InstallPlan } from "../generate";
import type { Answers } from "../questions";
import {
  BOOT_LABEL,
  INSTALLED_MARKER,
  BOOT_MD_NAME,
  BOOT_PART_LABEL,
  BOOT_SIZE,
  ESP_SIZE,
  layout,
  MD_NAME,
  PART_LABEL,
  ROOT_LABEL,
  SUBVOLUMES,
  type Encryption,
  usesTpm2,
  type Layout,
} from "./layout";
import {
  aptProxy,
  aptSources,
  BASE_PACKAGES,
  crypttab,
  dracutConf,
  fstab,
  grubDefaults,
  hostsFile,
  IMAGE_PACKAGES,
  installSource,
  KERNEL_PACKAGES,
  consoleSetupFile,
  keyboardFile,
  LOCALE,
  networkFile,
  sshdConf,
  SSH_NET_FILE,
  SSH_NET_UNIT,
  SSH_REQUIRES_DROPIN,
  sshNetRules,
  sshNets,
  sshNetUnit,
  sshRequiresDropin,
} from "./target-config";
import {
  GRUB_DEFAULT_ENTRY_FILE,
  GRUB_DEFAULT_ENTRY_SCRIPT,
  GRUB_PASSWORD_FILE,
  grubPasswordScript,
  grubPbkdf2,
  TPM_APT_HOOK,
  TPM_APT_HOOK_FILE,
  TPM_MARKER,
  TPM_SCRIPT,
  TPM_SCRIPT_CONTENT,
  TPM_STATE_DIR,
  TPM_UNIT,
  TPM_UNIT_FILE,
} from "@schulos/server/boot-hardening";
import { markerContent, type MarkerInfo } from "./existing";
import { schulosSteps, SCHULOS_PACKAGES } from "./schulos-steps";
import { updateSteps, UPDATE_PACKAGES } from "./update-steps";

export type Step =
  | {
      kind: "run";
      title: string;
      argv: string[];
      /** Eingabe auf stdin (Passphrase, Passwort) – nie im Protokoll */
      stdin?: string;
      /** Ausgabe merken (z. B. den LUKS-Wiederherstellungsschlüssel) */
      capture?: "recoveryKey";
      /** Fehler ignorieren (Aufräumen) */
      allowFail?: boolean;
    }
  | { kind: "write"; title: string; path: string; content: string; mode: number };

export interface StepOptions {
  /** Einhängepunkt des neuen Systems im Live-System */
  target: string;
  /** Debian-Paketquelle für debootstrap: Offline-Quelle der ISO (B-44) bzw. ein Spiegel für Tests */
  mirror: string;
  /** Datei mit einem zufälligen Schlüssel (TPM2: erster LUKS-Schlüssel, wird nach dem Eintragen von TPM2 und Wiederherstellungsschlüssel gelöscht) */
  keyFile: string;
}

const run = (title: string, argv: string[], extra: Partial<Extract<Step, { kind: "run" }>> = {}): Step => ({ kind: "run", title, argv, ...extra });
const write = (title: string, path: string, content: string, mode = 0o644): Step => ({ kind: "write", title, path, content, mode });
const s = (a: Answers, id: string, d = "") => (typeof a[id] === "string" ? (a[id] as string) : d);

export function planLayout(plan: InstallPlan): Layout {
  const sys = plan.system;
  return layout(sys["disk.devices"] as string[], (sys["disk.encryption"] as Encryption) ?? "none");
}

/** Platte(n) löschen, partitionieren, Spiegel, LUKS, btrfs mit Subvolumes, alles unter `target` einhängen. */
export function diskSteps(plan: InstallPlan, o: StepOptions): Step[] {
  return layoutDiskSteps(planLayout(plan), s(plan.system, "disk.passphrase"), o, s(plan.system, "disk.tpm_pin"));
}

export function layoutDiskSteps(l: Layout, passphrase: string, o: StepOptions, tpmPin = ""): Step[] {
  // Einhängepunkt im Live-System (gibt es dort nicht von selbst)
  const out: Step[] = [run("Einhängepunkt anlegen", ["mkdir", "-p", o.target])];
  for (const d of l.disks) {
    out.push(run(`${d} leeren`, ["wipefs", "--all", "--force", d]));
    out.push(run(`${d} partitionieren`, ["sgdisk", "--zap-all", d]));
  }
  l.disks.forEach((d, i) => {
    const esp = l.esps[i]!;
    out.push(
      run(`${d}: EFI-, Boot- und Systempartition`, [
        "sgdisk",
        `--new=1:0:${ESP_SIZE}`,
        "--typecode=1:ef00",
        `--change-name=1:${esp.label}`,
        `--new=2:0:${BOOT_SIZE}`,
        `--typecode=2:${l.bootMd ? "fd00" : "8300"}`,
        `--change-name=2:${BOOT_PART_LABEL}`,
        "--new=3:0:0",
        `--typecode=3:${l.md ? "fd00" : l.encryption === "none" ? "8300" : "8309"}`,
        `--change-name=3:${PART_LABEL}`,
        d,
      ]),
    );
  });
  out.push(run("Partitionen einlesen", ["partprobe", ...l.disks], { allowFail: true }), run("Geräte abwarten", ["udevadm", "settle"]));
  for (const e of l.esps) out.push(run(`EFI-Partition ${e.label} formatieren`, ["mkfs.vfat", "-F", "32", "-n", e.label, e.device]));
  if (l.md && l.bootMd) {
    const mirror = (dev: string, name: string, parts: string[]) => ["mdadm", "--create", dev, "--name", name, "--level=1", "--raid-devices=2", "--metadata=1.2", "--run", ...parts];
    out.push(
      run("Spiegel für /boot anlegen", mirror(l.bootMd, BOOT_MD_NAME, l.bootParts)),
      run("Spiegel (RAID 1) für das System anlegen", mirror(l.md, MD_NAME, l.parts)),
      run("Geräte abwarten", ["udevadm", "settle"]),
    );
  }
  out.push(run("/boot formatieren (ext4, unverschlüsselt)", ["mkfs.ext4", "-F", "-q", "-L", BOOT_LABEL, l.boot]));
  if (l.encryption === "passphrase") {
    out.push(
      run("Verschlüsselung (LUKS2) einrichten", ["cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", "--key-file=-", l.base], { stdin: passphrase }),
      run("Verschlüsselte Partition öffnen", ["cryptsetup", "open", "--key-file=-", l.base, l.mapper], { stdin: passphrase }),
    );
  } else if (usesTpm2(l.encryption)) {
    // SEC-09: hier nur PCR 7 – PCR 8/9 misst im Live-System die GRUB der ISO. „tpm2“ bindet beim ersten Start des neuen
    // Systems an 7+8+9 (tpm-binden.sh, Markierung aus hardeningSteps); „tpm2-pin“ bleibt bei PCR 7 + PIN (PIN auf stdin).
    const enroll =
      l.encryption === "tpm2-pin"
        ? run(
            "TPM2 mit PIN eintragen",
            ["sh", "-c", 'NEWPIN=$(cat) exec systemd-cryptenroll "$@"', "sh", `--unlock-key-file=${o.keyFile}`, "--tpm2-device=auto", "--tpm2-pcrs=7", "--tpm2-with-pin=yes", l.base],
            { stdin: tpmPin },
          )
        : run("TPM2 eintragen (bis zum ersten Start nur PCR 7)", ["systemd-cryptenroll", `--unlock-key-file=${o.keyFile}`, "--tpm2-device=auto", "--tpm2-pcrs=7", l.base]);
    out.push(
      run("Startschlüssel erzeugen", ["dd", "if=/dev/urandom", `of=${o.keyFile}`, "bs=64", "count=1", "status=none"]),
      run("Verschlüsselung (LUKS2) einrichten", ["cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", `--key-file=${o.keyFile}`, l.base]),
      enroll,
      run("Wiederherstellungsschlüssel erzeugen", ["systemd-cryptenroll", `--unlock-key-file=${o.keyFile}`, "--recovery-key", l.base], { capture: "recoveryKey" }),
      run("Verschlüsselte Partition öffnen", ["cryptsetup", "open", `--key-file=${o.keyFile}`, l.base, l.mapper]),
      // Startschlüssel war Schlüsselplatz 0 – danach öffnen nur noch TPM2 und der Wiederherstellungsschlüssel
      run("Startschlüssel entfernen", ["systemd-cryptenroll", "--wipe-slot=0", `--unlock-key-file=${o.keyFile}`, l.base]),
      run("Startschlüssel löschen", ["shred", "--remove", o.keyFile]),
    );
  }
  const t = o.target;
  out.push(
    run("Dateisystem (btrfs) anlegen", ["mkfs.btrfs", "--force", "--label", ROOT_LABEL, l.root]),
    run("Dateisystem einhängen", ["mount", l.root, t]),
    ...SUBVOLUMES.map((sv) => run(`Subvolume ${sv}`, ["btrfs", "subvolume", "create", `${t}/${sv}`])),
    run("Dateisystem aushängen", ["umount", t]),
    run("System-Subvolume einhängen", ["mount", "-o", "subvol=@,compress=zstd:1,noatime", l.root, t]),
    run("Einhängepunkte anlegen", ["mkdir", "-p", `${t}/srv`, `${t}/.snapshots`, `${t}/boot`]),
    run("Daten-Subvolume einhängen", ["mount", "-o", "subvol=@srv,compress=zstd:1,noatime", l.root, `${t}/srv`]),
    run("Schnappschuss-Subvolume einhängen", ["mount", "-o", "subvol=@snapshots,noatime", l.root, `${t}/.snapshots`]),
    run("/boot einhängen", ["mount", l.boot, `${t}/boot`]),
    run("EFI-Einhängepunkte anlegen", ["mkdir", "-p", ...l.esps.map((e) => `${t}${e.mount}`)]),
    ...l.esps.map((e) => run(`${e.label} einhängen`, ["mount", e.device, `${t}${e.mount}`])),
  );
  return out;
}

/**
 * Befehl im neuen System: per chroot aus dem Live-System – oder direkt, wenn `t` leer ist (Einrichtung eines vorbereiteten
 * Abbilds beim ersten Start, B-46: das neue System ist dann das laufende).
 */
export const inTarget = (t: string, title: string, argv: string[], extra: Partial<Extract<Step, { kind: "run" }>> = {}): Step =>
  run(title, t ? ["chroot", t, ...argv] : argv, extra);
const chroot = inTarget;

/** GRUB-Einstellung mit den UUIDs der Spiegel (rd.md.uuid=…) – im Zielsystem, nach schulos.cfg eingelesen */
export const ZZ_RAID_CFG = "/etc/default/grub.d/zz-schulos-raid.cfg";

export interface DebianOptions {
  /** zusätzliche Pakete (Abbild: growpart, Gast-Agent) */
  extraPackages?: string[];
  /** Initramfs nur für diese Hardware (Vorgabe) bzw. allgemein (Abbild für fremde VMs) */
  hostonly?: boolean;
}

/** Grundsystem per debootstrap, Paketquellen, Kernel, Docker, Sprache, Wartungskonto – unabhängig von den Antworten. */
export function debianSteps(l: Layout, o: StepOptions, d: DebianOptions = {}): Step[] {
  const t = o.target;
  const ct = crypttab(l);
  return [
    // die Offline-Quelle der ISO ist nicht signiert (das Medium selbst wird geprüft) – Netz-Spiegel dagegen schon
    run("Debian 13 installieren (debootstrap)", [
      "debootstrap",
      "--arch=amd64",
      "--components=main",
      ...(o.mirror.startsWith("file:") ? ["--no-check-gpg"] : []),
      `--include=${BASE_PACKAGES.join(",")}`,
      "trixie",
      t,
      o.mirror,
    ]),
    write("fstab", `${t}/etc/fstab`, fstab(l)),
    ...(ct ? [write("crypttab", `${t}/etc/crypttab`, ct, 0o600)] : []),
    write("dracut", `${t}/etc/dracut.conf.d/schulos.conf`, dracutConf(l, d.hostonly ?? true)),
    write("Sprache", `${t}/etc/locale.gen`, `${LOCALE} UTF-8\n`),
    write("Sprache", `${t}/etc/default/locale`, `LANG=${LOCALE}\n`),
    // Systemverzeichnisse für chroot (apt, Initramfs, Bootloader, efivars); /run enthält auch das Startmedium mit der Paketquelle
    ...["/dev", "/proc", "/sys", "/run"].flatMap((dir) => [
      run(`${dir} einbinden`, ["mount", "--rbind", dir, `${t}${dir}`]),
      run(`${dir} entkoppeln`, ["mount", "--make-rslave", `${t}${dir}`]),
    ]),
    // Kernel + dracut aus derselben Quelle wie debootstrap, danach die Paketquellen für den Betrieb
    write("Paketquelle für die Installation", `${t}/etc/apt/sources.list`, installSource(o.mirror)),
    chroot(t, "Paketliste lesen", ["apt-get", "update"]),
    chroot(t, "Kernel, Initramfs (dracut), Docker und Update-Werkzeuge installieren", [
      "apt-get",
      "install",
      "--yes",
      "--no-install-recommends",
      ...KERNEL_PACKAGES,
      ...SCHULOS_PACKAGES,
      ...UPDATE_PACKAGES,
      ...(d.extraPackages ?? []),
    ]),
    run("Paketquelle der Installation entfernen", ["rm", "-f", `${t}/etc/apt/sources.list`]),
    write("Paketquellen", `${t}/etc/apt/sources.list.d/debian.sources`, aptSources()),
    chroot(t, "Sprache erzeugen", ["locale-gen"]),
    chroot(t, "Netzwerkdienste", ["systemctl", "enable", "systemd-networkd", "systemd-resolved"]),
    chroot(t, "Wartungskonto anlegen", ["useradd", "--create-home", "--shell", "/bin/bash", "--groups", "sudo", "schulos-admin"]),
    chroot(t, "root-Anmeldung sperren", ["passwd", "--lock", "root"]),
  ];
}

/** Angaben aus den Antworten: Name, Netz, Tastatur, Zeitzone, Proxy, Passwort des Wartungskontos, SSH. */
export function systemConfigSteps(a: Answers, t: string): Step[] {
  const hostname = s(a, "network.hostname", "schulos");
  const tz = s(a, "locale.timezone", "Europe/Berlin");
  const proxy = s(a, "network.proxy");
  const ssh = a["access.ssh"] === true;
  const keys = Array.isArray(a["access.ssh_keys"]) ? (a["access.ssh_keys"] as string[]) : [];
  return [
    write("Hostname", `${t}/etc/hostname`, `${hostname}\n`),
    write("hosts", `${t}/etc/hosts`, hostsFile(hostname)),
    write("Netzwerk", `${t}/etc/systemd/network/10-schulos.network`, networkFile(a)),
    write("Tastatur", `${t}/etc/default/keyboard`, keyboardFile(s(a, "locale.keyboard", "de"))),
    write("Konsole: UTF-8", `${t}/etc/default/console-setup`, consoleSetupFile()),
    write("Zeitzone", `${t}/etc/timezone`, `${tz}\n`),
    chroot(t, "Zeitzone setzen", ["ln", "-sf", `/usr/share/zoneinfo/${tz}`, "/etc/localtime"]),
    ...(proxy ? [write("Proxy für apt", `${t}/etc/apt/apt.conf.d/90schulos-proxy`, aptProxy(proxy))] : []),
    chroot(t, "Passwort des Wartungskontos", ["chpasswd"], { stdin: `schulos-admin:${s(a, "access.password")}\n` }),
    write("SSH", `${t}/etc/ssh/sshd_config.d/schulos.conf`, sshdConf(a)),
    ...(keys.length
      ? [
          run("SSH-Ordner", ["install", "-d", "-m", "0700", `${t}/home/schulos-admin/.ssh`]),
          write("SSH-Schlüssel", `${t}/home/schulos-admin/.ssh/authorized_keys`, keys.join("\n") + "\n", 0o600),
          chroot(t, "SSH-Rechte", ["chown", "-R", "schulos-admin:schulos-admin", "/home/schulos-admin/.ssh"]),
        ]
      : []),
    chroot(t, ssh ? "SSH an" : "SSH aus", ["systemctl", ssh ? "enable" : "disable", "ssh"]),
    ...sshNetSteps(a, t),
  ];
}

/** SEC-12: SSH nur aus dem Schulnetz/WireGuard – Firewall-Regel (nftables) samt Dienst; ohne SSH bzw. „von überall“ keine */
export function sshNetSteps(a: Answers, t: string): Step[] {
  const nets = a["access.ssh"] === true ? sshNets(a) : null;
  if (!nets) return [];
  return [
    write("SSH nur aus dem Schulnetz: Regel", `${t}${SSH_NET_FILE}`, sshNetRules(nets)),
    write("SSH nur aus dem Schulnetz: Dienst", `${t}${SSH_NET_UNIT}`, sshNetUnit()),
    // G4E-O06: fail closed – sshd startet nur mit geladener Regel
    write("SSH nur mit Firewall-Regel", `${t}${SSH_REQUIRES_DROPIN}`, sshRequiresDropin()),
    // im laufenden System (Abbild-Einrichtung, t leer) sofort, sonst ab dem ersten Start
    chroot(t, "SSH nur aus dem Schulnetz: einschalten", ["systemctl", "enable", ...(t ? [] : ["--now"]), "schulos-ssh-netz.service"]),
  ];
}

/** GRUB-Einstellungen (Konsole) und Bootmenü neu erzeugen */
export function grubConfigSteps(a: Answers, t: string): Step[] {
  // G4E-O04/O05 (Q-4E-61): eigenes, zufälliges Bootmenü-Passwort (generate) – nicht das Wartungspasswort: der Hash liegt auf dem
  // unverschlüsselten /boot, und am GRUB-Prompt gilt die US-Tastatur
  const password = s(a, GRUB_PASSWORD_KEY);
  return [
    write("Bootmenü-Einstellungen (auch seriell)", `${t}/etc/default/grub.d/schulos.cfg`, grubDefaults(a["access.console"] === "serial" ? "serial" : "screen")),
    // SEC-09: Standardeintrag „SchulOS“ ohne Passwort, alles andere (Bearbeiten, Kommandozeile, Rückweg) mit dem Bootmenü-Passwort
    write("Bootmenü: Standardeintrag", `${t}${GRUB_DEFAULT_ENTRY_FILE}`, GRUB_DEFAULT_ENTRY_SCRIPT, 0o755),
    ...(password ? [write("Bootmenü: Passwort (GRUB-Superuser)", `${t}${GRUB_PASSWORD_FILE}`, grubPasswordScript(grubPbkdf2(password)), 0o700)] : []),
    chroot(t, "Bootmenü erzeugen", ["update-grub"]),
  ];
}

/**
 * SEC-09: TPM2 an PCR 7+8+9 – Skript, Dienst (Start: binden, Herunterfahren: prüfen), dpkg-Hook und die Markierung, die den
 * ersten Start binden lässt. Nur für „tpm2“ (mit PIN bleibt es bei PCR 7 + PIN).
 */
export function hardeningSteps(l: Layout, t: string): Step[] {
  if (l.encryption !== "tpm2") return [];
  return [
    write("TPM2-Bindung: Skript", `${t}${TPM_SCRIPT}`, TPM_SCRIPT_CONTENT, 0o755),
    write("TPM2-Bindung: Dienst", `${t}${TPM_UNIT_FILE}`, TPM_UNIT),
    write("TPM2-Bindung: nach Paket-Updates prüfen", `${t}${TPM_APT_HOOK_FILE}`, TPM_APT_HOOK),
    run("TPM2-Bindung: Zustand", ["install", "-d", "-m", "0700", `${t}${TPM_STATE_DIR}`]),
    write("TPM2-Bindung beim ersten Start (PCR 7+8+9)", `${t}${TPM_MARKER}`, "", 0o600),
    chroot(t, "TPM2-Bindung einschalten", ["systemctl", "enable", "schulos-tpm.service"]),
  ];
}

/** Spiegel eintragen, Initramfs, Bootloader auf jede EFI-Partition, Bootmenü. */
export function bootSteps(l: Layout, a: Answers, t: string): Step[] {
  return [
    ...(l.md
      ? [
          // ersetzen statt anhängen: das mdadm-Paket trägt die Spiegel bei der Installation schon ein (mkconf) – doppelte
          // ARRAY-Zeilen lässt mdadm im Initramfs scheitern („Duplicate MD device names“, QEMU-Test) → Wurzel fehlt
          chroot(t, "Spiegel eintragen", ["sh", "-c", "sed -i '/^ARRAY /d' /etc/mdadm/mdadm.conf && mdadm --detail --scan >> /etc/mdadm/mdadm.conf"]),
          // dracut erkennt die Spiegel unter der Wurzel beim Bau in der chroot nicht (hostonly) – dann setzt das Initramfs sie
          // nicht zusammen und der LUKS-Container erscheint nie (QEMU-Test). Ausdrücklich per rd.md.uuid in die Kernel-Zeile;
          // „zz-“: nach schulos.cfg einlesen, das GRUB_CMDLINE_LINUX setzt.
          chroot(t, "Spiegel beim Start zusammensetzen", [
            "sh",
            "-c",
            `u=$(mdadm --detail --scan | sed -n 's/.* UUID=\\([^ ]*\\).*/rd.md.uuid=\\1/p' | tr '\\n' ' '); printf 'GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX %s"\\n' "$u" > ${ZZ_RAID_CFG}`,
          ]),
        ]
      : []),
    chroot(t, "Initramfs erzeugen", ["dracut", "--regenerate-all", "--force"]),
    // --removable: Start ohne NVRAM-Eintrag, auf jeder Platte des Spiegels; --uefi-secure-boot: shim als BOOTX64.EFI (wie die ISO)
    ...l.esps.map((e) =>
      chroot(t, `Bootloader auf ${e.label}`, [
        "grub-install",
        "--target=x86_64-efi",
        `--efi-directory=${e.mount}`,
        "--removable",
        "--no-nvram",
        "--uefi-secure-boot",
        "--bootloader-id=schulos",
      ]),
    ),
    ...grubConfigSteps(a, t),
  ];
}

/** Grundsystem, Angaben aus den Antworten (vor dem Initramfs: Tastatur für die Passphrase), Bootloader. */
export function baseSystemSteps(plan: InstallPlan, o: StepOptions): Step[] {
  const l = planLayout(plan);
  return [...debianSteps(l, o), ...systemConfigSteps(plan.system, o.target), ...hardeningSteps(l, o.target), ...bootSteps(l, plan.system, o.target)];
}

/** Am Ende: alles aushängen und schließen (auch nach einem Fehler, deshalb allowFail). */
export function cleanupSteps(plan: InstallPlan, o: StepOptions): Step[] {
  return layoutCleanupSteps(planLayout(plan), o);
}

export function layoutCleanupSteps(l: Layout, o: StepOptions): Step[] {
  return [
    // erst regulär (schreibt alles sauber aus), lazy nur, wenn noch etwas belegt ist
    run("Systemverzeichnisse aushängen", ["sh", "-c", 'sync; umount --recursive "$1" || umount --recursive --lazy "$1"', "_", o.target], { allowFail: true }),
    ...(l.encryption !== "none" ? [run("Verschlüsselung schließen", ["cryptsetup", "close", l.mapper], { allowFail: true })] : []),
    ...(l.md ? [run("Spiegel anhalten", ["mdadm", "--stop", l.md], { allowFail: true })] : []),
    ...(l.bootMd ? [run("Spiegel /boot anhalten", ["mdadm", "--stop", l.bootMd], { allowFail: true })] : []),
  ];
}

/** Pakete für die Offline-Quelle der ISO (B-44): debootstrap-Auswahl und was danach per apt dazukommt (auch fürs Abbild, B-46). */
export function packageLists(): { debootstrap: string[]; apt: string[] } {
  return { debootstrap: BASE_PACKAGES, apt: [...KERNEL_PACKAGES, ...SCHULOS_PACKAGES, ...UPDATE_PACKAGES, ...IMAGE_PACKAGES] };
}

/** Alle Schritte; `dist` = SchulOS-Dateien auf dem Startmedium (ohne: nur Debian-Grundsystem, z. B. im Test ohne Images) */
export function installSteps(plan: InstallPlan, o: StepOptions & { dist?: string; marker?: MarkerInfo }): { steps: Step[]; cleanup: Step[] } {
  const schulos = o.dist ? [...schulosSteps(plan, { ...o, dist: o.dist }), ...updateSteps(plan, { ...o, dist: o.dist })] : [];
  return {
    steps: [...diskSteps(plan, o), ...baseSystemSteps(plan, o), ...schulos, installedMarker(o.target, { role: plan.role, ...o.marker }), flushBoot(o.target)],
    cleanup: cleanupSteps(plan, o),
  };
}

/**
 * Nach der Markierung: /boot einfrieren und wieder freigeben – ext4 schreibt dabei das Journal an die endgültige Stelle.
 * GRUB liest das Journal nicht; ohne diesen Schritt fand das Startmenü des Mediums die Markierung nach dem Neustart nicht
 * (Gate #81, QEMU-Backupserver), weil /target nur lazy ausgehängt wurde.
 */
export function flushBoot(t: string): Step {
  return run("Startdateien auf die Platte schreiben", ["sh", "-c", 'sync -f "$1" && fsfreeze --freeze "$1" && fsfreeze --unfreeze "$1"', "_", `${t}/boot`], {
    allowFail: true,
  });
}

/**
 * Als vorletzter Schritt (GATE-4f C-03): erst jetzt startet das Medium standardmäßig von der Platte; `t` leer = laufendes System.
 * INST-06: mit Rolle/Version/Datum – der Überschreibschutz zeigt sie bei der Rückfrage (system/existing.ts).
 */
export function installedMarker(t: string, info: MarkerInfo = {}): Step {
  return write("Installation als abgeschlossen markieren (Startmenü des Mediums)", `${t}/boot/${INSTALLED_MARKER}`, markerContent(info));
}
