// SEC-14 / Q5-18 (Projektleitung 2026-10-11): Der Backupserver startet mit LUKS-Passphrase (oder TPM2 + PIN) nach Debian-Updates nicht
// selbst neu – sonst hinge er nachts an der Eingabe. Damit das nicht unbemerkt bleibt: ein Dienst auf dem Host
// (schulos-hoststatus.timer, vom Installer) schreibt /run/schulos-host/status.json, die Backup-App liest es (Bind-Mount /host,
// nur lesend) und zeigt „Neustart nötig – Passphrase erforderlich“ als Statuskarte samt Alarm-Mail über ihren SMTP-Weg.
// G4E-O03: dazu der Zustand der TPM2-Bindung (vollständig an PCR 7+8+9?) · G4E-O15: veralteter Status meldet sich selbst.
import { existsSync, readFileSync } from "node:fs";
import { TPM_STATE_DIR, tpmBindingProblems, tpmNeedsHuman, type TpmFacts } from "./boot-hardening";
import type { Alarm } from "./mail";

export const HOST_STATUS_FILE = "/host/status.json";
/** ab so vielen Tagen dringend (wie im Hauptsystem, @schulos/server/system REBOOT_RED_DAYS) */
export const HOST_REBOOT_RED_DAYS = 14;
/** G4E-O15: der Timer schreibt alle 10 Minuten – älter als das gilt der Status als veraltet (Timer steht) */
export const HOST_STATUS_MAX_AGE_MS = 60 * 60_000;

export interface HostStatus {
  rebootRequired: boolean;
  /** beim Start ist eine Eingabe nötig (Passphrase bzw. TPM2-PIN) */
  passphrase: boolean;
  /** seit wann der Neustart aussteht (ISO) */
  since: string | null;
  checkedAt: string;
  /** G4E-O03: TPM2 ohne PIN – Zustand der Bindung; null = kein TPM2 ohne PIN (bzw. ältere Skriptfassung) */
  tpm: TpmFacts | null;
}

const isoOrNull = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;

/** TPM-Teil der Datei (nur bekannte Felder; die Fehlermeldung selbst steht im Journal des Hosts) */
function parseTpm(v: unknown): TpmFacts | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  return {
    mode: "tpm2",
    secureBoot: typeof t.secureBoot === "boolean" ? t.secureBoot : undefined,
    markerSince: isoOrNull(t.markerSince),
    bootedAt: isoOrNull(t.bootedAt),
    error: t.error === true ? "siehe Journal des Backupservers (journalctl -t schulos-tpm)" : null,
    efiChanged: t.efiChanged === true,
    pcrSets: Array.isArray(t.pcrSets) ? t.pcrSets.filter((p): p is string => typeof p === "string" && /^[\d+]*$/.test(p)) : null,
  };
}

/** Datei vom Host (nicht vertrauenswürdig formatiert): nur bekannte Felder, sonst null */
export function parseHostStatus(text: string): HostStatus | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (
      v.version !== 1 ||
      typeof v.checkedAt !== "string" ||
      Number.isNaN(Date.parse(v.checkedAt))
    )
      return null;
    return {
      rebootRequired: v.rebootRequired === true,
      passphrase: v.passphrase === true,
      since: isoOrNull(v.since),
      checkedAt: new Date(v.checkedAt).toISOString(),
      tpm: parseTpm(v.tpm),
    };
  } catch {
    return null;
  }
}

export function readHostStatus(
  file = process.env.SCHULOS_HOST_STATUS ?? HOST_STATUS_FILE,
): HostStatus | null {
  try {
    return existsSync(file)
      ? parseHostStatus(readFileSync(file, "utf8"))
      : null;
  } catch {
    return null;
  }
}

/** Neustart nötig und nur mit Eingabe möglich? Dann Tage seitdem (0 = heute), sonst null */
export function pendingPassphraseReboot(
  s: HostStatus | null,
  now = new Date(),
): number | null {
  if (!s?.rebootRequired || !(s.passphrase || (s.tpm && tpmNeedsHuman(s.tpm)))) return null;
  const since = s.since ? Date.parse(s.since) : Date.parse(s.checkedAt);
  return Math.max(0, Math.floor((now.getTime() - since) / 86_400_000));
}

/** G4E-O15: Status älter als eine Stunde (Timer steht) – dann gilt „kein Neustart nötig“ nicht mehr als Aussage */
export function hostStatusStale(s: HostStatus | null, now = new Date()): boolean {
  return s !== null && now.getTime() - Date.parse(s.checkedAt) > HOST_STATUS_MAX_AGE_MS;
}

/** G4E-O03: Probleme der TPM2-Bindung (leer = in Ordnung bzw. kein TPM2 ohne PIN) */
export function hostTpmProblems(s: HostStatus | null, now = new Date()): string[] {
  return s?.tpm ? tpmBindingProblems(s.tpm, now) : [];
}

export function hostAlarms(s: HostStatus | null, now = new Date()): Alarm[] {
  const out: Alarm[] = [];
  const days = pendingPassphraseReboot(s, now);
  if (days !== null)
    out.push({
      key: "neustart",
      title:
        days >= HOST_REBOOT_RED_DAYS
          ? `Neustart seit ${days} Tagen überfällig – Passphrase erforderlich`
          : "Neustart nötig – Passphrase erforderlich",
      detail:
        "Debian-Sicherheitsupdates auf dem Backupserver werden erst nach einem Neustart wirksam. Die Platte wird beim Start per Passphrase (bzw. PIN oder – nach einem shim-/GRUB-Update – ggf. mit dem Wiederherstellungsschlüssel) entsperrt, deshalb startet er nicht von selbst neu: zu einer Zeit ohne Sicherung neu starten (sudo systemctl reboot) und an der Konsole bleiben.",
    });
  const tpm = hostTpmProblems(s, now);
  if (tpm.length)
    out.push({
      key: "tpm",
      title: "TPM-Bindung des Backupservers unvollständig",
      detail: tpm.join(" "),
    });
  if (hostStatusStale(s, now))
    out.push({
      key: "hoststatus",
      title: "Host-Status des Backupservers veraltet",
      detail: `Seit ${new Date(s!.checkedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} kein neuer Stand – läuft schulos-hoststatus.timer? (sudo systemctl status schulos-hoststatus.timer). Bis dahin fehlen Neustart- und TPM-Hinweise.`,
    });
  return out;
}

/** Host-Skript (Installer, `schulosctl sicherheit-nachruesten`): schreibt den Status alle 10 Minuten und beim Start */
export const HOST_STATUS_SCRIPT = [
  "#!/bin/sh",
  "# SchulOS Backup (SEC-14/Q5-18): Neustart nötig? Eingabe beim Start nötig? TPM2-Bindung vollständig (G4E-O03)?",
  "# → /run/schulos-host/status.json für die Backup-App",
  "set -eu",
  "d=${SCHULOS_HOST_DIR:-/run/schulos-host}",
  "rr=${SCHULOS_REBOOT_FILE:-/run/reboot-required}",
  "ct=${SCHULOS_CRYPTTAB:-/etc/crypttab}",
  `st=\${SCHULOS_TPM_STATE:-${TPM_STATE_DIR}}`,
  "sbv=${SCHULOS_SB_VAR:-/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c}",
  'iso() { date -u -d @"$1" +%Y-%m-%dT%H:%M:%SZ; }',
  'mkdir -p "$d"',
  "r=false; since=null",
  'if [ -f "$rr" ]; then r=true; since="\\"$(iso "$(stat -c %Y "$rr")")\\""; fi',
  "p=false",
  "# Eingabe nötig: ein Eintrag ohne tpm2-device= (Passphrase) oder mit tpm2-pin=yes – außer mit Schlüsseldatei bzw. Zufallsschlüssel",
  "# (Feld 3 ≠ none/-, z. B. Swap mit /dev/urandom; G4E-O15, wie passphraseAtBoot in schulosctl)",
  'if [ -f "$ct" ] && awk \'$1 !~ /^#/ && NF >= 2 && ($3 == "" || $3 == "none" || $3 == "-") && ($4 !~ /tpm2-device=/ || $4 ~ /tpm2-pin=(yes|true|1)/) { f = 1 } END { exit !f }\' "$ct"; then p=true; fi',
  "# G4E-O03: TPM2 ohne PIN – Bindung (Secure Boot, Markierung, Fehler, shim/GRUB geändert, PCR-Sätze der Schlüsselplätze)",
  "tpm=null",
  "dev=$(awk '$1 !~ /^#/ && $4 ~ /tpm2-device=/ && $4 !~ /tpm2-pin=(yes|true|1)/ { print $2; exit }' \"$ct\" 2>/dev/null || true)",
  'if [ -n "$dev" ]; then',
  '  case "$dev" in',
  '    PARTLABEL=*) dev="/dev/disk/by-partlabel/${dev#PARTLABEL=}" ;;',
  '    LABEL=*) dev="/dev/disk/by-label/${dev#LABEL=}" ;;',
  '    UUID=*) dev="/dev/disk/by-uuid/${dev#UUID=}" ;;',
  '    PARTUUID=*) dev="/dev/disk/by-partuuid/${dev#PARTUUID=}" ;;',
  "  esac",
  "  sb=null",
  '  if [ -r "$sbv" ]; then if [ "$(od -An -t u1 -j4 -N1 "$sbv" 2>/dev/null | tr -d \' \')" = 1 ]; then sb=true; else sb=false; fi; fi',
  "  m=null",
  '  if [ -f "$st/neu-binden" ]; then m="\\"$(iso "$(stat -c %Y "$st/neu-binden")")\\""; fi',
  "  e=false; [ -f \"$st/fehler\" ] && e=true",
  "  efi=false; [ -f \"$st/efi-geaendert\" ] && efi=true",
  '  up=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)',
  '  b="\\"$(iso "$(( $(date +%s) - up ))")\\""',
  "  pcrs=null",
  '  if j=$(cryptsetup luksDump --dump-json-metadata "$dev" 2>/dev/null); then',
  "    pcrs=\"[$(printf '%s' \"$j\" | tr -d ' \\n' | grep -o '\"tpm2-pcrs\":\\[[0-9,]*\\]' | sed 's/.*\\[\\(.*\\)\\]/\"\\1\"/' | tr ',' '+' | paste -sd, - || true)]\"",
  "  fi",
  '  tpm="{\\"secureBoot\\":$sb,\\"markerSince\\":$m,\\"bootedAt\\":$b,\\"error\\":$e,\\"efiChanged\\":$efi,\\"pcrSets\\":$pcrs}"',
  "fi",
  'printf \'{"version":1,"rebootRequired":%s,"passphrase":%s,"since":%s,"checkedAt":"%s","tpm":%s}\\n\' "$r" "$p" "$since" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tpm" >"$d/status.json.neu"',
  'mv "$d/status.json.neu" "$d/status.json"',
  "",
].join("\n");

export const HOST_STATUS_SCRIPT_PATH = "/usr/local/lib/schulos/hoststatus.sh";

export const HOST_STATUS_SERVICE = [
  "# SchulOS Backup (SEC-14): Status des Hosts für die Backup-App",
  "[Unit]",
  "Description=SchulOS Backup: Host-Status (Neustart nötig, Passphrase, TPM2-Bindung)",
  "",
  "[Service]",
  "Type=oneshot",
  `ExecStart=${HOST_STATUS_SCRIPT_PATH}`,
  "",
].join("\n");

export const HOST_STATUS_TIMER = [
  "# SchulOS Backup (SEC-14): alle 10 Minuten und kurz nach dem Start",
  "[Unit]",
  "Description=SchulOS Backup: Host-Status alle 10 Minuten",
  "",
  "[Timer]",
  "OnBootSec=1min",
  "OnUnitActiveSec=10min",
  "",
  "[Install]",
  "WantedBy=timers.target",
  "",
].join("\n");
