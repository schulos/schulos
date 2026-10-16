// Debian aktuell halten (B-43, INSTALLATION.md §5a.1): Sicherheits- und Punkt-Updates automatisch (unattended-upgrades),
// Dienste neu starten (needrestart), Schnappschüsse vor jedem apt-Lauf (snapper), Neustart nur im Wartungsfenster und nur
// nach einer Sicherung (Hauptsystem: schulosctl wartungsfenster; Backupserver: eigener Timer). Versionssprung geführt mit
// `schulosctl os-upgrade` (Rückweg: Schnappschuss + Bootmenü-Eintrag). Rein.
import type { InstallPlan } from "../generate";
import { hhmm, parseWindow } from "../checks";
import { HOST_STATUS_SCRIPT, HOST_STATUS_SCRIPT_PATH, HOST_STATUS_SERVICE, HOST_STATUS_TIMER } from "@schulos/server/host-status";
import { DIST } from "./schulos-steps";
import { inTarget, type Step, type StepOptions } from "./steps";

export const UPDATE_PACKAGES = ["unattended-upgrades", "needrestart", "snapper"];

export function autoUpgrades(): string {
  return `// SchulOS: Paketlisten täglich, Updates täglich (unattended-upgrades)\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n`;
}

/** Nur Debian selbst: Sicherheit, Punkt-Releases (Hauptarchiv der laufenden Version) und stable-updates – nie ein Versionssprung */
export function unattendedConf(): string {
  return `// SchulOS (INSTALLATION.md §5a.1) – Neustart macht nicht unattended-upgrades, sondern das Wartungsfenster mit Sicherung
Unattended-Upgrade::Origins-Pattern {
        "origin=Debian,codename=\${distro_codename},label=Debian";
        "origin=Debian,codename=\${distro_codename}-updates,label=Debian";
        "origin=Debian,codename=\${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::SyslogEnable "true";
`;
}

/** needrestart: betroffene Dienste ohne Rückfrage neu starten (Docker mit live-restore: Container laufen weiter) */
export function needrestartConf(): string {
  return `# SchulOS\n$nrconf{restart} = 'a';\n$nrconf{kernelhints} = 0;\n$nrconf{ucodehints} = 0;\n`;
}

/** snapper für / (Subvolume @): Schnappschüsse vor/nach jedem apt-Lauf (Hook des Pakets), die letzten 10 bleiben */
export function snapperRootConf(): string {
  return [
    'SUBVOLUME="/"',
    'FSTYPE="btrfs"',
    'QGROUP=""',
    'SPACE_LIMIT="0.3"',
    'FREE_LIMIT="0.2"',
    'ALLOW_USERS=""',
    'ALLOW_GROUPS=""',
    'SYNC_ACL="no"',
    'BACKGROUND_COMPARISON="yes"',
    'NUMBER_CLEANUP="yes"',
    'NUMBER_MIN_AGE="1800"',
    'NUMBER_LIMIT="10"',
    'NUMBER_LIMIT_IMPORTANT="5"',
    'TIMELINE_CREATE="no"',
    'TIMELINE_CLEANUP="yes"',
    'EMPTY_PRE_POST_CLEANUP="yes"',
    'EMPTY_PRE_POST_MIN_AGE="1800"',
    "",
  ].join("\n");
}

/**
 * Backupserver: kein schulosctl – Neustart nach Debian-Updates über einen eigenen Timer im Wartungsfenster (§5a.1: „nie
 * gleichzeitig mit dem Hauptsystem“ – das Fenster gibt der Installer je Server vor). Gesichert wird dort nichts: die
 * Sicherungen sind die Daten.
 */
export function backupRebootUnits(window: string): { service: string; timer: string } {
  const w = parseWindow(window);
  if (!w.ok) throw new Error(w.error);
  const quarter = Math.min(30, Math.floor(w.minutes / 4));
  return {
    service: `# SchulOS Backup – Neustart nach Debian-Updates (Kernel, libc), nur wenn Debian ihn verlangt
[Unit]
Description=SchulOS Backup: Neustart im Wartungsfenster, falls nötig
ConditionPathExists=/run/reboot-required

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl reboot
`,
    timer: `# Wartungsfenster ${hhmm(w.start)}–${hhmm(w.end)} (Installer)
[Unit]
Description=SchulOS Backup: Wartungsfenster täglich ${hhmm(w.start)}–${hhmm(w.end)}

[Timer]
OnCalendar=*-*-* ${hhmm(w.start + quarter)}:00
RandomizedDelaySec=${quarter}min
Persistent=false

[Install]
WantedBy=timers.target
`,
  };
}

const run = (title: string, argv: string[]): Step => ({ kind: "run", title, argv });
const write = (title: string, path: string, content: string, mode = 0o644): Step => ({ kind: "write", title, path, content, mode });

/** Was nur von der Rolle abhängt: unattended-upgrades, needrestart, snapper; Hauptsystem: Rückweg nach dem Debian-Versionswechsel. */
export function updateImageSteps(role: InstallPlan["role"], o: StepOptions & { dist: string }): Step[] {
  const t = o.target;
  const chroot = (title: string, argv: string[]) => inTarget(t, title, argv);
  return [
    write("Automatische Debian-Updates", `${t}/etc/apt/apt.conf.d/20auto-upgrades`, autoUpgrades()),
    write("Automatische Debian-Updates: Quellen", `${t}/etc/apt/apt.conf.d/52schulos-unattended`, unattendedConf()),
    write("Dienste nach Updates neu starten", `${t}/etc/needrestart/conf.d/schulos.conf`, needrestartConf()),
    write("Schnappschüsse (snapper)", `${t}/etc/snapper/configs/root`, snapperRootConf(), 0o640),
    write("Schnappschüsse (snapper)", `${t}/etc/default/snapper`, 'SNAPPER_CONFIGS="root"\n'),
    chroot("Schnappschüsse aufräumen lassen", ["systemctl", "enable", "snapper-cleanup.timer"]),
    ...(role === "main"
      ? [
          run("Bootmenü-Eintrag für den Rückweg", ["install", "-m", "0755", `${o.dist}/${DIST.grub}/41_schulos-rueckweg`, `${t}/etc/grub.d/41_schulos-rueckweg`]),
          chroot("Prüfung nach Debian-Versionswechsel einschalten", ["systemctl", "enable", "schulos-os-upgrade-pruefen.service"]),
        ]
      : []),
  ];
}

/** Aus den Antworten: Backupserver-Neustart im Wartungsfenster (das Hauptsystem bekommt sein Fenster als Drop-in im Plan). */
export function updateConfigSteps(plan: InstallPlan, t: string): Step[] {
  if (plan.role === "main") return [];
  // SEC-14/Q5-18: Host-Status für die Backup-App (Neustart nötig, Passphrase) – Statuskarte und Alarm-Mail
  const host = [
    write("Host-Status für die Backup-App", `${t}${HOST_STATUS_SCRIPT_PATH}`, HOST_STATUS_SCRIPT, 0o755),
    write("Host-Status für die Backup-App", `${t}/etc/systemd/system/schulos-hoststatus.service`, HOST_STATUS_SERVICE),
    write("Host-Status für die Backup-App", `${t}/etc/systemd/system/schulos-hoststatus.timer`, HOST_STATUS_TIMER),
    inTarget(t, "Host-Status einschalten", ["systemctl", "enable", "schulos-hoststatus.timer"]),
  ];
  // Q5-18: mit Passphrase/PIN hinge der Backupserver nachts an der Eingabe – kein automatischer Neustart, nur von Hand
  if (plan.system["disk.encryption"] === "passphrase" || plan.system["disk.encryption"] === "tpm2-pin") return host;
  const window = typeof plan.system["updates.window"] === "string" ? (plan.system["updates.window"] as string) : "02:00-04:00";
  const u = backupRebootUnits(window);
  return [
    write("Neustart im Wartungsfenster", `${t}/etc/systemd/system/schulos-neustart.service`, u.service),
    write("Neustart im Wartungsfenster", `${t}/etc/systemd/system/schulos-neustart.timer`, u.timer),
    inTarget(t, "Neustart-Timer einschalten", ["systemctl", "enable", "schulos-neustart.timer"]),
    ...host,
  ];
}

export function updateSteps(plan: InstallPlan, o: StepOptions & { dist: string }): Step[] {
  return [...updateImageSteps(plan.role, o), ...updateConfigSteps(plan, o.target)];
}
