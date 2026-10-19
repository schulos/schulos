// Abbild je Rolle (B-46, INSTALLATION.md §2 „qcow2“): Die ISO installiert in einer VM nur den rollenabhängigen Teil – Debian,
// Docker, Images, Stack-Dateien – ohne Antworten, ohne Verschlüsselung, auf eine Platte. Beim ersten Start in Proxmox/QEMU liest
// ein schlanker eigener Dienst `schulos-install.yaml` vom Cloud-Init-Laufwerk (NoCloud) und richtet ein, was sonst der Installer
// schreibt: Name, Netz, Wartungskonto, SSH, .env/schulos.env, Erststart. Die Wurzel wächst bei jedem Start auf die VM-Platte.
// Rein – ausgeführt von run.ts.
import { formatGrubPassword } from "@schulos/server/boot-hardening";
import { GRUB_PASSWORD_KEY, type InstallPlan } from "../generate";
import { ESP_MOUNT, layout } from "./layout";
import { GRUB_PASSWORD_CONSOLE_FILE, LIB_DIR, PAIRING_CODE_FILE, schulosConfigSteps, schulosImageSteps, type Role } from "./schulos-steps";
import { bootSteps, debianSteps, espMarkers, grubConfigSteps, installedMarker, layoutCleanupSteps, layoutDiskSteps, systemConfigSteps, type Step, type StepOptions } from "./steps";
import { IMAGE_PACKAGES, networkFile } from "./target-config";
import { updateConfigSteps, updateImageSteps } from "./update-steps";

/** Rolle und Version des Abbilds – daran erkennt der Installer beim ersten Start, was er einrichtet */
export const IMAGE_FILE = "/etc/schulos/abbild";
/** eingerichtet – danach läuft die Einrichtung nicht mehr */
export const CONFIGURED_FILE = "/etc/schulos/eingerichtet";
export const IMAGE_INSTALLER = `${LIB_DIR}/schulos-installer.mjs`;
export const CONFIGURE_LOG = "/var/log/schulos-einrichtung.log";

const run = (title: string, argv: string[], extra: Partial<Extract<Step, { kind: "run" }>> = {}): Step => ({ kind: "run", title, argv, ...extra });
const write = (title: string, path: string, content: string, mode = 0o644): Step => ({ kind: "write", title, path, content, mode });

export function imageFile(role: Role, version: string): string {
  return `ROLE=${role}\nVERSION=${version}\n`;
}

export function parseImageFile(text: string): { role: Role; version: string } | null {
  const role = /^ROLE=(main|backup)$/m.exec(text)?.[1] as Role | undefined;
  return role ? { role, version: /^VERSION=(.*)$/m.exec(text)?.[1] ?? "" } : null;
}

/**
 * Einrichtung beim ersten Start: Antworten vom Cloud-Init-Laufwerk (NoCloud, Bezeichnung „cidata“, Datei user-data – Proxmox:
 * `qm set <vm> --cicustom user=local:snippets/schulos-install.yaml`) oder von einem Laufwerk SCHULOSCFG mit
 * schulos-install.yaml (wie bei der ISO). Fehlt etwas, fragt der Installer auf tty1 nach (wie im Live-System).
 */
export function configureScript(): string {
  return `#!/bin/bash
# SchulOS-Abbild – Einrichtung beim ersten Start (schulos-konfigurieren.service)
set -u
CFG=/run/schulos-cfg
ANS=""
serial() { [ -w /dev/ttyS0 ] && echo "SCHULOS-EINRICHTUNG: $*" > /dev/ttyS0 2>/dev/null || true; }
mkdir -p "$CFG"
for label in cidata CIDATA SCHULOSCFG; do
  dev=$(blkid -L "$label" 2>/dev/null || true)
  [ -n "$dev" ] || continue
  mountpoint -q "$CFG" || mount -o ro "$dev" "$CFG" || continue
  # user-data nur, wenn es eine schulos-install.yaml ist (Proxmox erzeugt sonst eine eigene cloud-config mit Benutzern usw.)
  if [ -f "$CFG/user-data" ] && grep -q '^role:' "$CFG/user-data"; then ANS="$CFG/user-data"; break; fi
  if [ -f "$CFG/schulos-install.yaml" ]; then ANS="$CFG/schulos-install.yaml"; break; fi
  umount "$CFG"
done
INST=(/usr/bin/node ${IMAGE_INSTALLER} --konfigurieren)
serial "start \${ANS:-ohne Antworten}"
while true; do
  clear
  if [ -n "$ANS" ]; then
    "\${INST[@]}" --antworten "$ANS" --unbeaufsichtigt
    rc=$?
    # 2 = Antworten unvollständig oder ungültig → in der Oberfläche nachfragen
    if [ $rc = 2 ]; then "\${INST[@]}" --antworten "$ANS"; rc=$?; fi
  else
    "\${INST[@]}"
    rc=$?
  fi
  serial "ende rc=$rc"
  [ $rc = 0 ] && break
  [ -f ${CONFIGURE_LOG} ] && [ -w /dev/ttyS0 ] && tail -n 40 ${CONFIGURE_LOG} > /dev/ttyS0 2>/dev/null
  echo
  echo "Einrichtung nicht abgeschlossen (Code $rc). Protokoll: ${CONFIGURE_LOG}"
  read -r -p "Enter = noch einmal " || sleep 60
done
mountpoint -q "$CFG" && umount "$CFG"
exit 0
`;
}

export function configureUnit(): string {
  return `# SchulOS-Abbild – Einrichtung beim ersten Start (schulos-install.yaml vom Cloud-Init-Laufwerk, sonst Fragen auf tty1)
[Unit]
Description=SchulOS: Einrichtung beim ersten Start
After=systemd-udev-settle.service local-fs.target systemd-networkd.service schulos-wachsen.service
Wants=systemd-udev-settle.service
Before=docker.service schulos-erststart.service schulos-konsole.service getty@tty1.service
Conflicts=getty@tty1.service
ConditionPathExists=!${CONFIGURED_FILE}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${LIB_DIR}/konfigurieren.sh
StandardInput=tty
StandardOutput=tty
StandardError=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
Environment=TERM=linux LANG=C.UTF-8
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
`;
}

/** Wurzel auf die Größe der VM-Platte bringen – bei jedem Start (auch nach `qm resize`); ohne Änderung tut es nichts. */
export function growScript(): string {
  return `#!/bin/bash
# SchulOS-Abbild – Systempartition und btrfs auf die Größe der Platte vergrößern (schulos-wachsen.service)
set -u
src=$(findmnt -nvo SOURCE /)
part=$(basename "$(readlink -f "$src")")
disk=$(lsblk -no PKNAME "/dev/$part")
n=$(cat "/sys/class/block/$part/partition")
# Exitcode 1 = NOCHANGE (schon so groß wie die Platte)
growpart "/dev/$disk" "$n" || true
btrfs filesystem resize max /
`;
}

export function growUnit(): string {
  return `# SchulOS-Abbild – Wurzel wächst mit der VM-Platte
[Unit]
Description=SchulOS: Systempartition auf Plattengröße
After=local-fs.target
Before=schulos-konfigurieren.service docker.service

[Service]
Type=oneshot
ExecStart=${LIB_DIR}/wachsen.sh

[Install]
WantedBy=multi-user.target
`;
}

export interface ImageOptions extends StepOptions {
  dist: string;
  /** Zielplatte in der Bau-VM */
  disk: string;
  /** gebündelter Installer (im Live-System /usr/local/bin/schulos-installer) – kommt ins Abbild für die Einrichtung */
  installer: string;
  version: string;
}

/** Abbild bauen (im Live-System der ISO, Bau-VM): eine Platte ohne Verschlüsselung, alles Rollenabhängige, keine Antworten. */
export function imageSteps(role: Role, o: ImageOptions): { steps: Step[]; cleanup: Step[] } {
  const l = layout([o.disk], "none");
  const t = o.target;
  const chroot = (title: string, argv: string[]) => run(title, ["chroot", t, ...argv]);
  const steps: Step[] = [
    ...layoutDiskSteps(l, "", o),
    ...debianSteps(l, o, { extraPackages: IMAGE_PACKAGES, hostonly: false }),
    // bis zur Einrichtung: DHCP (Proxmox-Konsole zeigt die Adresse)
    write("Netzwerk (DHCP bis zur Einrichtung)", `${t}/etc/systemd/network/10-schulos.network`, networkFile({})),
    ...bootSteps(l, {}, t),
    ...schulosImageSteps(role, o),
    ...updateImageSteps(role, o),
    run("Installer für die Einrichtung", ["install", "-D", "-m", "0755", o.installer, `${t}${IMAGE_INSTALLER}`]),
    write("Rolle des Abbilds", `${t}${IMAGE_FILE}`, imageFile(role, o.version)),
    write("Einrichtung: Skript", `${t}${LIB_DIR}/konfigurieren.sh`, configureScript(), 0o755),
    write("Einrichtung: Dienst", `${t}/etc/systemd/system/schulos-konfigurieren.service`, configureUnit()),
    write("Wachsen: Skript", `${t}${LIB_DIR}/wachsen.sh`, growScript(), 0o755),
    write("Wachsen: Dienst", `${t}/etc/systemd/system/schulos-wachsen.service`, growUnit()),
    chroot("Einrichtung beim ersten Start einschalten", ["systemctl", "enable", "schulos-konfigurieren.service", "schulos-wachsen.service"]),
    // SSH erst nach der Einrichtung (Schlüssel, Passwort) – und jede Kopie bekommt eigene Host-Schlüssel und machine-id
    chroot("SSH bis zur Einrichtung aus", ["systemctl", "disable", "ssh"]),
    run("SSH-Host-Schlüssel entfernen", ["sh", "-c", `rm -f "$1"/etc/ssh/ssh_host_*`, "sh", t]),
    run("machine-id leeren (neu je Kopie)", ["sh", "-c", `: > "$1/etc/machine-id"; rm -f "$1/var/lib/systemd/random-seed"`, "sh", t]),
    chroot("Paket-Zwischenspeicher leeren", ["apt-get", "clean"]),
    // freigegebene Blöcke an die qcow2-Datei melden (discard=unmap) → kleineres Abbild
    run("Freien Platz freigeben", ["fstrim", "--verbose", t], { allowFail: true }),
    run("Freien Platz freigeben (/boot)", ["fstrim", "--verbose", `${t}/boot`], { allowFail: true }),
  ];
  return { steps, cleanup: layoutCleanupSteps(l, o) };
}

/**
 * Einrichtung beim ersten Start – im laufenden System (kein chroot): dieselben Angaben wie bei der Installation von der ISO,
 * danach anwenden (Name, Netz, SSH mit neuen Host-Schlüsseln, Timer). Der Erststart (Images laden, starten, koppeln) folgt
 * direkt danach als eigener Dienst.
 */
export function configureSteps(plan: InstallPlan): Step[] {
  const sys = plan.system;
  const hostname = typeof sys["network.hostname"] === "string" ? sys["network.hostname"] : "schulos";
  const ssh = sys["access.ssh"] === true;
  const grubPw = typeof sys[GRUB_PASSWORD_KEY] === "string" ? (sys[GRUB_PASSWORD_KEY] as string) : "";
  return [
    run("SSH-Host-Schlüssel erzeugen", ["ssh-keygen", "-A"]),
    ...systemConfigSteps(sys, ""),
    ...grubConfigSteps(sys, ""),
    ...schulosConfigSteps(plan, ""),
    ...updateConfigSteps(plan, ""),
    ...(plan.pairingCode ? [write("Kopplungscode für die Konsole", PAIRING_CODE_FILE, `${plan.pairingCode}\n`, 0o600)] : []),
    // G4E-O04/O05: Bootmenü-Passwort bis zum Neustart auf der Konsole (tty1) – sonst kennt es niemand
    ...(grubPw ? [write("Bootmenü-Passwort für die Konsole", GRUB_PASSWORD_CONSOLE_FILE, `${formatGrubPassword(grubPw)}\n`, 0o600)] : []),
    run("Hostname setzen", ["hostname", hostname]),
    run("Dienste neu einlesen", ["systemctl", "daemon-reload"]),
    run("Netz neu einrichten", ["systemctl", "restart", "systemd-networkd"]),
    run("Netz abwarten", ["/usr/lib/systemd/systemd-networkd-wait-online", "--timeout=60"], { allowFail: true }),
    run("Tastatur", ["setupcon", "--force"], { allowFail: true }),
    // --no-block: aus einem Dienst beim Start heraus nicht auf andere Startaufträge warten
    ...(ssh ? [run("SSH starten", ["systemctl", "start", "--no-block", "ssh"])] : []),
    plan.role === "main"
      ? run("Wartungsfenster übernehmen", ["systemctl", "try-restart", "--no-block", "schulos-wartung.timer"], { allowFail: true })
      : run("Neustart-Timer starten", ["systemctl", "start", "--no-block", "schulos-neustart.timer"]),
    // INST-08: auch auf der EFI-Partition (Abbild: eine Platte) – das Startmenü eines Mediums startet dann deren shim
    ...espMarkers("", [ESP_MOUNT], { role: plan.role }),
    installedMarker("", { role: plan.role }),
    write("Einrichtung abgeschlossen", CONFIGURED_FILE, "eingerichtet\n"),
  ];
}
