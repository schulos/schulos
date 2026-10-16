// SEC-09: geführter Nachrüst-Schritt für bestehende Server (`schulosctl sicherheit-nachruesten`, auch auf dem Backupserver mit
// kopierter schulosctl.mjs): Bootmenü-Passwort setzen und – bei TPM2 ohne PIN – die Bindung an PCR 7+8+9 vorbereiten. Dieselben
// Dateien wie der Installer (@schulos/server/boot-hardening). Rein: welche Dateien, welche Befehle, welche Hinweise.
//
// G4E-O01: Ist die Platte schon an PCR 7+8+9 gebunden (Stand-Datei liegt), ändert das neue grub.cfg (neuer Salt/Hash) PCR 8/9 –
// ohne Übergangsschlüssel verlangte jeder weitere Start den Wiederherstellungsschlüssel. Dann also NICHT die Erstbindungs-
// Markierung schreiben, sondern nach `update-grub` wie nach einem Kernel-Update `tpm-binden.sh pruefen` aufrufen: legt den
// Übergang an PCR 7 an und markiert – der nächste Start bindet neu.
import {
  GRUB_DEFAULT_ENTRY_FILE,
  GRUB_DEFAULT_ENTRY_SCRIPT,
  GRUB_PASSWORD_FILE,
  grubPasswordScript,
  TPM_APT_HOOK,
  TPM_APT_HOOK_FILE,
  TPM_MARKER,
  TPM_SCRIPT,
  TPM_SCRIPT_CONTENT,
  TPM_STATE_DIR,
  TPM_UNIT,
  TPM_UNIT_FILE,
  type unlockMode,
} from "@schulos/server/boot-hardening";
import { HOST_STATUS_SCRIPT, HOST_STATUS_SCRIPT_PATH, HOST_STATUS_SERVICE, HOST_STATUS_TIMER } from "@schulos/server/host-status";

export type UnlockMode = ReturnType<typeof unlockMode>;

export interface HardeningPlan {
  files: { path: string; content: string; mode: number }[];
  dirs: string[];
  commands: string[][];
  notes: string[];
}

/** Befehl, der nach `update-grub` den TPM2-Übergang anlegt (schon gebundene Server) */
export const TRANSITION_COMMAND = [TPM_SCRIPT, "pruefen"];

export function hardeningPlan(
  grubHash: string,
  mode: UnlockMode,
  secureBoot: boolean | undefined,
  /** SEC-14: Backupserver – Host-Status (Neustart nötig, Passphrase) für die Backup-App nachrüsten */
  backupHost = false,
  /** G4E-O01: Platte ist schon an PCR 7+8+9 gebunden (`/var/lib/schulos/tpm/stand` liegt) */
  bound = false,
): HardeningPlan {
  const plan: HardeningPlan = {
    files: [
      {
        path: GRUB_DEFAULT_ENTRY_FILE,
        content: GRUB_DEFAULT_ENTRY_SCRIPT,
        mode: 0o755,
      },
      {
        path: GRUB_PASSWORD_FILE,
        content: grubPasswordScript(grubHash),
        mode: 0o700,
      },
    ],
    dirs: [],
    commands: [],
    notes: [
      "GRUB: Standardeintrag „SchulOS“ startet ohne Passwort; Bearbeiten, Kommandozeile und andere Einträge nur mit dem neuen Bootmenü-Passwort (Benutzer schulos, US-Tastaturbelegung).",
    ],
  };
  const tpm = mode === "tpm2";
  if (tpm) {
    plan.files.push(
      { path: TPM_SCRIPT, content: TPM_SCRIPT_CONTENT, mode: 0o755 },
      { path: TPM_UNIT_FILE, content: TPM_UNIT, mode: 0o644 },
      { path: TPM_APT_HOOK_FILE, content: TPM_APT_HOOK, mode: 0o644 },
      // Erstbindung: Markierung → nächster Start bindet an 7+8+9. Schon gebunden: den Übergang legt `pruefen` an (unten)
      ...(bound ? [] : [{ path: TPM_MARKER, content: "", mode: 0o600 }]),
    );
    plan.dirs.push(TPM_STATE_DIR);
    plan.commands.push(
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "schulos-tpm.service"],
    );
    plan.notes.push(
      secureBoot === false
        ? "TPM2: Secure Boot ist aus – die Platte bleibt an PCR 7 gebunden. Im UEFI Secure Boot einschalten; beim nächsten Start bindet SchulOS dann an PCR 7+8+9."
        : bound
          ? "TPM2: Das neue Bootmenü ändert die Messwerte (PCR 8/9) – SchulOS hat einen Übergangsschlüssel an PCR 7 angelegt; der nächste Neustart ohne Startmedium entsperrt damit und bindet neu an PCR 7+8+9."
          : "TPM2: Beim nächsten Neustart ohne eingelegtes Startmedium bindet SchulOS die Platte an PCR 7+8+9 (Secure Boot, GRUB, Kernel/Initramfs). Nach Kernel-Updates bindet es selbst neu.",
    );
  } else if (mode === "tpm2-pin")
    plan.notes.push(
      "TPM2 + PIN: bleibt an PCR 7 + PIN – nichts weiter zu tun.",
    );
  else if (mode === "passphrase")
    plan.notes.push(
      "Passphrase beim Start: kein TPM2 – nur das Bootmenü-Passwort wird gesetzt.",
    );
  else
    plan.notes.push(
      "Ohne Verschlüsselung (Demo/Abbild): nur das Bootmenü-Passwort wird gesetzt.",
    );
  if (backupHost) {
    plan.files.push(
      { path: HOST_STATUS_SCRIPT_PATH, content: HOST_STATUS_SCRIPT, mode: 0o755 },
      { path: "/etc/systemd/system/schulos-hoststatus.service", content: HOST_STATUS_SERVICE, mode: 0o644 },
      { path: "/etc/systemd/system/schulos-hoststatus.timer", content: HOST_STATUS_TIMER, mode: 0o644 },
    );
    plan.commands.push(["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", "schulos-hoststatus.timer"]);
    plan.notes.push("Backupserver: Host-Status für „Neustart nötig – Passphrase erforderlich“ und die TPM2-Bindung (Übersicht, Alarm-Mail) eingerichtet.");
  }
  // Bootmenü zuletzt neu erzeugen (liest die neuen grub.d-Dateien) – bei schon gebundener Platte danach den Übergang anlegen
  plan.commands.push(["update-grub"]);
  if (tpm && bound) plan.commands.push(TRANSITION_COMMAND);
  return plan;
}

/** Hinweis, wenn der Übergang nach `update-grub` nicht angelegt werden konnte – vor dem nächsten Neustart handeln */
export const TRANSITION_FAILED =
  "ACHTUNG: Das Bootmenü ist neu, aber der TPM2-Übergangsschlüssel ließ sich nicht anlegen – der nächste Start verlangt sonst den " +
  `Wiederherstellungsschlüssel. Erneut versuchen: sudo ${TPM_SCRIPT} pruefen. Klappt das nicht: beim nächsten Start den ` +
  "Wiederherstellungsschlüssel eingeben und danach an der Konsole sudo schulosctl tpm-neu-binden ausführen.";
