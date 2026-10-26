// SEC-09 (Projektleitung 2026-10-11/-13): Schutz gegen physischen Zugriff – für den Installer (neue Server) und `schulosctl
// sicherheit-nachruesten` (bestehende Server) dieselben Dateien:
//   • GRUB-Superuser „schulos“ mit einem eigenen, zufälligen Bootmenü-Passwort (password_pbkdf2; G4E-O04/O05, Q-4E-61 – nicht
//     mehr das Wartungspasswort): Bearbeiten der Einträge, GRUB-Kommandozeile und alle Einträge außer dem Standardeintrag
//     „SchulOS“ (--unrestricted) brauchen das Passwort – kein `init=/bin/sh` mehr am Bootmenü.
//   • TPM2 an PCR 7+8+9 (Secure-Boot-Zustand + GRUB-Befehle + gelesene Dateien: Kernel, Initramfs, grub.cfg). Ändert sich
//     etwas davon (Kernel-Update, update-grub), legt `tpm-binden.sh pruefen` (nach jedem dpkg-Lauf und beim Herunterfahren)
//     einen Übergangsschlüssel nur an PCR 7 an; beim nächsten Start bindet `tpm-binden.sh start` neu an 7+8+9 und löscht alle
//     anderen TPM2-Plätze. Nur mit Secure Boot und nur ohne eingelegtes Startmedium (dessen GRUB misst andere Werte).
//   • TPM2 + PIN als Installer-Wahl: PCR 7 + PIN, kein Neu-Binden nötig (der PIN schützt), Neustarts nur mit Eingabe.
// Rein bis auf die PBKDF2-Berechnung.
import { pbkdf2Sync, randomBytes } from "node:crypto";

export const GRUB_SUPERUSER = "schulos";
export const GRUB_PASSWORD_FILE = "/etc/grub.d/01_schulos-passwort";
export const GRUB_DEFAULT_ENTRY_FILE = "/etc/grub.d/09_schulos-standard";
export const TPM_SCRIPT = "/usr/local/lib/schulos/tpm-binden.sh";
export const TPM_UNIT_FILE = "/etc/systemd/system/schulos-tpm.service";
export const TPM_APT_HOOK_FILE = "/etc/apt/apt.conf.d/99schulos-tpm";
export const TPM_STATE_DIR = "/var/lib/schulos/tpm";
/** liegt sie, bindet der nächste Start neu an PCR 7+8+9 */
export const TPM_MARKER = `${TPM_STATE_DIR}/neu-binden`;
export const TPM_PCRS = "7+8+9";
export const TPM_PCRS_TRANSITION = "7";
/** Bezeichnung des ISO-Dateisystems (iso/live/auto/config `--iso-volume`) – steckt es, startet die Platte über die GRUB der ISO */
export const ISO_VOLUME = "SCHULOS";
export const EFI_SECURE_BOOT =
  "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c";
export const PBKDF2_ITERATIONS = 100_000;

/** GRUB-Passwort-Hash im Format von grub-mkpasswd-pbkdf2 (PBKDF2-HMAC-SHA512, 64 Byte Salz und Ergebnis, Hex groß). */
export function grubPbkdf2(
  password: string,
  salt: Buffer = randomBytes(64),
  iterations = PBKDF2_ITERATIONS,
): string {
  if (!password) throw new Error("GRUB-Passwort leer");
  const hash = pbkdf2Sync(
    Buffer.from(password, "utf8"),
    salt,
    iterations,
    64,
    "sha512",
  );
  return `grub.pbkdf2.sha512.${iterations}.${salt.toString("hex").toUpperCase()}.${hash.toString("hex").toUpperCase()}`;
}

/**
 * G4E-O04/O05 (Q-4E-61): eigenes Bootmenü-Passwort statt des Wartungspassworts. Der Hash liegt auf dem unverschlüsselten /boot
 * (offline angreifbar) – ein zufälliges Passwort verrät dort nichts über sudo/SSH. Und am GRUB-Prompt gilt die US-Belegung:
 * nur Zeichen, die auf deutscher und US-Tastatur an derselben Stelle liegen (Kleinbuchstaben ohne y/z, Ziffern), ohne
 * leicht verwechselbare (i, l, o, 0, 1). 16 Zeichen aus 29 ≈ 77 Bit.
 */
export const GRUB_PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwx23456789"; // gitleaks:allow – Zeichenvorrat, kein Geheimnis
export const GRUB_PASSWORD_LENGTH = 16;
/** Mindestlänge eines eigenen Bootmenü-Passworts (`schulosctl sicherheit-nachruesten --passwort-stdin`) */
export const GRUB_PASSWORD_MIN = 12;

export function generateGrubPassword(random: (n: number) => Buffer = randomBytes): string {
  const a = GRUB_PASSWORD_ALPHABET;
  // Ablehnungsverfahren: nur Bytes < 29·8 = 232 – gleich verteilt
  let out = "";
  while (out.length < GRUB_PASSWORD_LENGTH)
    for (const b of random(32)) {
      if (b < a.length * Math.floor(256 / a.length) && out.length < GRUB_PASSWORD_LENGTH) out += a[b % a.length];
    }
  return out;
}

/** Zum Abschreiben in Vierergruppen – eingetippt wird es ohne Leerzeichen */
export function formatGrubPassword(pw: string): string {
  return pw.replace(/(.{4})(?!$)/g, "$1 ");
}

/** Eigenes Bootmenü-Passwort prüfen: am GRUB-Prompt (US-Belegung) auf deutscher Tastatur sicher eingebbar? null = in Ordnung */
export function grubPasswordProblem(pw: string): string | null {
  if (pw.length < GRUB_PASSWORD_MIN) return `mindestens ${GRUB_PASSWORD_MIN} Zeichen`;
  if (!/^[A-Xa-x0-9]+$/.test(pw))
    return "nur Buchstaben a–x bzw. A–X und Ziffern – am Bootmenü gilt die US-Tastaturbelegung (y/z vertauscht, Sonderzeichen und Umlaute woanders bzw. gar nicht eingebbar)";
  return null;
}

/** Prüft ein Passwort gegen einen Hash aus {@link grubPbkdf2} (Tests, Nachrüsten). */
export function verifyGrubPbkdf2(password: string, hash: string): boolean {
  const m = /^grub\.pbkdf2\.sha512\.(\d+)\.([0-9A-F]+)\.([0-9A-F]+)$/.exec(
    hash,
  );
  if (!m) return false;
  return grubPbkdf2(password, Buffer.from(m[2]!, "hex"), Number(m[1])) === hash;
}

/** /etc/grub.d/01_schulos-passwort (0700): Superuser + Hash. grub-mkconfig lässt grub.cfg mit „password“ nur für root lesbar. */
export function grubPasswordScript(hash: string): string {
  if (!/^grub\.pbkdf2\.sha512\.\d+\.[0-9A-F]+\.[0-9A-F]+$/.test(hash))
    throw new Error("Kein GRUB-PBKDF2-Hash");
  return [
    "#!/bin/sh",
    "# SchulOS (SEC-09): GRUB-Superuser – Einträge bearbeiten, GRUB-Kommandozeile und alle Einträge außer „SchulOS“ nur mit dem",
    "# Bootmenü-Passwort (Benutzer schulos). Neu erzeugen: sudo schulosctl sicherheit-nachruesten",
    "cat <<'EOF'",
    `set superusers="${GRUB_SUPERUSER}"`,
    `password_pbkdf2 ${GRUB_SUPERUSER} ${hash}`,
    "EOF",
    "",
  ].join("\n");
}

/**
 * /etc/grub.d/09_schulos-standard (0755): Standardeintrag „SchulOS“ ohne Passwort (--unrestricted) für den neuesten Kernel –
 * vor den Einträgen aus 10_linux, die mit Superuser nur noch mit Passwort starten (Rückweg, ältere Kernel). Angaben wie 10_linux:
 * Gerät für /boot über grub-mkconfig_lib, Wurzel per UUID, Subvolume @ (Aufteilung des Installers), GRUB_CMDLINE_LINUX.
 */
export const GRUB_DEFAULT_ENTRY_SCRIPT = [
  "#!/bin/sh",
  "# SchulOS (SEC-09): Standardeintrag ohne GRUB-Passwort – nur starten, nicht bearbeiten; neuester Kernel unter /boot",
  "set -e",
  '. "${pkgdatadir:-/usr/share/grub}/grub-mkconfig_lib"',
  'K=$(for f in /boot/vmlinuz-*; do [ -f "$f" ] && echo "${f#/boot/vmlinuz-}"; done | sort -V | tail -n 1)',
  '[ -n "$K" ] && [ -f "/boot/initrd.img-$K" ] || exit 0',
  '[ -n "${GRUB_DEVICE_UUID:-}" ] || exit 0',
  "echo \"menuentry 'SchulOS' --unrestricted --class gnu-linux --id schulos-standard {\"",
  'prepare_grub_to_access_device "${GRUB_DEVICE_BOOT}" | sed "s/^/  /"',
  'echo "  linux /vmlinuz-$K root=UUID=$GRUB_DEVICE_UUID rootflags=subvol=@ ro $GRUB_CMDLINE_LINUX $GRUB_CMDLINE_LINUX_DEFAULT"',
  'echo "  initrd /initrd.img-$K"',
  'echo "}"',
  "",
].join("\n");

/** Stand der Startdateien beim letzten Binden (Prüfsumme über alles unter /boot) */
export const TPM_STAND_FILE = `${TPM_STATE_DIR}/stand`;
/** G4E-O01/O03: Fehlermeldung des letzten gescheiterten Bindens (Überwachung, Alarm) */
export const TPM_ERROR_FILE = `${TPM_STATE_DIR}/fehler`;
/** G4E-O02: shim/GRUB (EFI-Programme) seit dem Binden geändert – der nächste Start kann den Wiederherstellungsschlüssel verlangen */
export const TPM_EFI_CHANGED_FILE = `${TPM_STATE_DIR}/efi-geaendert`;

/**
 * /usr/local/lib/schulos/tpm-binden.sh (0755) – `start` (beim Hochfahren) bzw. `pruefen` (nach dpkg, beim Herunterfahren, nach
 * `schulosctl sicherheit-nachruesten`), `gebunden` (nach `schulosctl tpm-neu-binden`). Nur für TPM2 ohne PIN (crypttab:
 * tpm2-device=, ohne tpm2-pin=yes). Pfade per Umgebung überschreibbar (Tests).
 */
export const TPM_SCRIPT_CONTENT = [
  "#!/bin/bash",
  "# SchulOS (SEC-09): TPM2 an PCR 7+8+9 binden und nach Änderungen an /boot sicher neu binden.",
  "#   start    – liegt die Markierung, an die Werte dieses Starts binden (7+8+9), alle anderen TPM2-Plätze löschen",
  "#   pruefen  – hat sich unter /boot etwas geändert (Kernel, Initramfs, grub.cfg, GRUB-Module/Sprachdateien/Schriften, shim und",
  "#              GRUB auf der EFI-Partition): Übergangsschlüssel nur an PCR 7 bis zum nächsten Start; neue EFI-Programme",
  "#              zusätzlich vermerken (efi-geaendert) – ein neues shim kann auch PCR 7 ändern, dann startet nur ein Mensch neu",
  "#   gebunden – nach dem Binden von Hand (schulosctl tpm-neu-binden): Stand merken, Markierungen löschen",
  "set -u",
  `STATE=\${SCHULOS_TPM_STATE:-${TPM_STATE_DIR}}`,
  "CRYPTTAB=${SCHULOS_CRYPTTAB:-/etc/crypttab}",
  "BOOT=${SCHULOS_BOOT_DIR:-/boot}",
  `SB=\${SCHULOS_SB_VAR:-${EFI_SECURE_BOOT}}`,
  'log() { echo "schulos-tpm: $*"; command -v logger >/dev/null && logger -t schulos-tpm "$*"; return 0; }',
  '# Fehler für die Überwachung festhalten (Verwaltung → System bzw. Backupserver: Alarm „TPM-Bindung unvollständig“)',
  'fehler() { printf "%s %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >"$STATE/fehler"; log "$*"; }',
  "# TPM2-Gerät ohne PIN aus crypttab (PIN: PCR 7 + PIN, kein Neu-Binden)",
  "line=$(awk '$1 !~ /^#/ && $4 ~ /tpm2-device=/ && $4 !~ /tpm2-pin=(yes|true|1)/ { print $2; exit }' \"$CRYPTTAB\" 2>/dev/null)",
  '[ -n "$line" ] || exit 0',
  'case "$line" in',
  '  PARTLABEL=*) dev="/dev/disk/by-partlabel/${line#PARTLABEL=}" ;;',
  '  LABEL=*) dev="/dev/disk/by-label/${line#LABEL=}" ;;',
  '  UUID=*) dev="/dev/disk/by-uuid/${line#UUID=}" ;;',
  '  PARTUUID=*) dev="/dev/disk/by-partuuid/${line#PARTUUID=}" ;;',
  '  *) dev="$line" ;;',
  "esac",
  "# G4E-O02: Stand über ALLES unter /boot (rekursiv, auch die EFI-Partition) – GRUB misst jede gelesene Datei (PCR 9: Kernel,",
  "# Initramfs, grub.cfg, grubenv, Sprachdateien, Schriften, Module) und seine Befehle (PCR 8); lieber ein Übergang zu viel.",
  "# Ein sha256sum-Aufruf für alle Dateien (xargs) statt einer je Datei: gleiche Ausgabe, also gleicher Stand wie vorher",
  "stand() {",
  '  find "$BOOT" -type f -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d\' \' -f1',
  "}",
  "# EFI-Programme (shim, GRUB, MOK-Verwaltung): ein neues shim kann PCR 7 ändern (SBAT-Stand) – dann trägt auch der Übergang nicht",
  "efi_stand() {",
  '  find "$BOOT/efi" -type f -iname "*.efi" -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d\' \' -f1',
  "}",
  'merken() { stand >"$STATE/stand" && efi_stand >"$STATE/efi-stand" && rm -f "$STATE/neu-binden" "$STATE/fehler" "$STATE/efi-geaendert"; }',
  'secure_boot() { [ -r "$SB" ] && [ "$(od -An -t u1 -j4 -N1 "$SB" 2>/dev/null | tr -d \' \')" = 1 ]; }',
  `medium() { [ -n "$(blkid -t LABEL=${ISO_VOLUME} -o device 2>/dev/null)" ]; }`,
  'mkdir -p "$STATE"',
  'case "${1:-}" in',
  "  start)",
  '    [ -f "$STATE/neu-binden" ] || exit 0',
  '    if ! secure_boot; then log "Secure Boot aus – TPM2 bleibt an PCR 7 (im UEFI einschalten, dann neu starten)"; exit 0; fi',
  '    if medium; then log "Startmedium steckt (Start über dessen GRUB) – neu gebunden wird erst beim Start ohne Medium"; exit 0; fi',
  `    if systemd-cryptenroll --unlock-tpm2-device=auto --tpm2-device=auto --tpm2-pcrs=${TPM_PCRS} --wipe-slot=tpm2 "$dev"; then`,
  "      merken",
  `      log "TPM2 an PCR ${TPM_PCRS} gebunden"`,
  "    else",
  "      # G4E-O01: kein passender TPM2-Platz (z. B. nach einem Start mit dem Wiederherstellungsschlüssel) – laut melden",
  '      fehler "Binden an PCR 7+8+9 fehlgeschlagen – Abhilfe an der Konsole: sudo schulosctl tpm-neu-binden (Wiederherstellungsschlüssel bereithalten)"; exit 1',
  "    fi",
  "    ;;",
  "  pruefen)",
  "    # noch nie an 7+8+9 gebunden (Erstbindung steht aus): nichts zu tun",
  '    [ -f "$STATE/stand" ] || exit 0',
  '    [ "$(stand)" = "$(cat "$STATE/stand")" ] && exit 0',
  '    if [ -f "$STATE/efi-stand" ] && [ ! -f "$STATE/efi-geaendert" ] && [ "$(efi_stand)" != "$(cat "$STATE/efi-stand")" ]; then',
  '      : >"$STATE/efi-geaendert"',
  '      log "shim bzw. GRUB auf der EFI-Partition geändert – der nächste Start kann den Wiederherstellungsschlüssel verlangen (kein automatischer Neustart)"',
  "    fi",
  '    [ -f "$STATE/neu-binden" ] && exit 0',
  `    if systemd-cryptenroll --unlock-tpm2-device=auto --tpm2-device=auto --tpm2-pcrs=${TPM_PCRS_TRANSITION} "$dev"; then`,
  '      : >"$STATE/neu-binden"',
  '      log "Startdateien geändert – Übergangsschlüssel an PCR 7 bis zum nächsten Start"',
  "    else",
  '      fehler "Übergangsschlüssel nicht angelegt – beim nächsten Start ist der Wiederherstellungsschlüssel nötig (erneut: sudo $0 pruefen; sonst nach dem Start mit dem Wiederherstellungsschlüssel: sudo schulosctl tpm-neu-binden)"; exit 1',
  "    fi",
  "    ;;",
  "  gebunden)",
  "    merken",
  '    log "TPM2 von Hand an PCR 7+8+9 gebunden – Stand gemerkt"',
  "    ;;",
  '  *) echo "Aufruf: $0 start|pruefen|gebunden" >&2; exit 64 ;;',
  "esac",
  "",
].join("\n");

/** systemd: beim Start binden (nach dem Entsperren), beim Herunterfahren prüfen (deckt auch Änderungen ohne dpkg ab). */
export const TPM_UNIT = [
  "# SchulOS (SEC-09): TPM2 an PCR 7+8+9 binden bzw. vor dem Herunterfahren den Übergang vorbereiten",
  "[Unit]",
  "Description=SchulOS: TPM2-Bindung der Platte",
  "After=cryptsetup.target local-fs.target",
  "",
  "[Service]",
  "Type=oneshot",
  "RemainAfterExit=yes",
  `ExecStart=${TPM_SCRIPT} start`,
  `ExecStop=${TPM_SCRIPT} pruefen`,
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

/** apt/dpkg (auch unattended-upgrades): nach jedem Lauf prüfen – ein Kernel-Update kommt so nie ohne Übergangsschlüssel an */
export const TPM_APT_HOOK = `// SchulOS (SEC-09): nach Paketänderungen TPM2-Übergang vorbereiten\nDPkg::Post-Invoke { "[ -x ${TPM_SCRIPT} ] && ${TPM_SCRIPT} pruefen || true"; };\n`;

/** Secure Boot aus der EFI-Variablen (4 Byte Attribute + 1 Byte Wert); null = keine Variable (kein UEFI) → unbekannt */
export function secureBootFromEfivar(
  bytes: Uint8Array | null,
): boolean | undefined {
  if (!bytes || bytes.length < 5) return undefined;
  return bytes[4] === 1;
}

/** PCR-Sätze der TPM2-Plätze aus `cryptsetup luksDump --dump-json-metadata` (Token systemd-tpm2), z. B. ["7+8+9", "7"] */
export function tpm2PcrSets(luksJson: string): string[] {
  const meta = JSON.parse(luksJson) as {
    tokens?: Record<string, { type?: string; "tpm2-pcrs"?: unknown }>;
  };
  return Object.values(meta.tokens ?? {})
    .filter((t) => t.type === "systemd-tpm2")
    .map((t) =>
      Array.isArray(t["tpm2-pcrs"])
        ? t["tpm2-pcrs"]
            .map(Number)
            .filter((n) => Number.isInteger(n))
            .sort((a, b) => a - b)
            .join("+")
        : "",
    );
}

/**
 * G4E-O03: Was die Überwachung über die TPM2-Bindung weiß (Hauptsystem: `schulosctl system-sync`; Backupserver: hoststatus.sh).
 * Nur bei TPM2 ohne PIN von Belang.
 */
export interface TpmFacts {
  mode: "tpm2" | "tpm2-pin" | "passphrase" | "none";
  secureBoot: boolean | undefined;
  /** seit wann die Markierung „neu-binden“ liegt (ISO), null = keine */
  markerSince: string | null;
  /** Start des laufenden Systems (ISO) */
  bootedAt: string | null;
  /** Inhalt der Fehlerdatei von tpm-binden.sh (Zeitpunkt + Meldung), null = keine */
  error: string | null;
  /** shim/GRUB seit dem Binden geändert */
  efiChanged: boolean;
  /** PCR-Sätze der TPM2-Plätze; null = nicht lesbar */
  pcrSets: string[] | null;
}

/** so lange darf ein Übergangsschlüssel (nur PCR 7) liegen, bevor die Überwachung einen Neustart anmahnt */
export const TPM_TRANSITION_MAX_DAYS = 7;

/**
 * G4E-O03: Ist die Bindung vollständig (7+8+9, Secure Boot an, kein hängender Übergang)? Liefert die Probleme in Klartext
 * (leer = in Ordnung). Bewusst streng: bleibt die Platte unbemerkt nur an PCR 7 gebunden, entsperrt ein beliebiges
 * Debian-signiertes Startmedium per `init=/bin/sh` – genau das soll SEC-09 verhindern.
 */
export function tpmBindingProblems(f: TpmFacts, now = new Date()): string[] {
  if (f.mode !== "tpm2") return [];
  const out: string[] = [];
  if (f.secureBoot === false)
    out.push(
      "Secure Boot ist aus – die Platte ist nur an PCR 7 gebunden (im UEFI einschalten, dann neu starten).",
    );
  if (f.error)
    out.push(
      `TPM2-Bindung gescheitert: ${f.error.slice(0, 300)}`,
    );
  if (f.efiChanged)
    out.push(
      "shim bzw. GRUB wurden aktualisiert – der nächste Start kann den Wiederherstellungsschlüssel verlangen. Neustart nur mit jemandem an der Konsole; danach bindet SchulOS neu (sonst: sudo schulosctl tpm-neu-binden).",
    );
  if (f.markerSince) {
    const since = Date.parse(f.markerSince);
    const days = Math.floor((now.getTime() - since) / 86_400_000);
    if (f.bootedAt && since < Date.parse(f.bootedAt) - 60_000)
      out.push(
        "Seit dem letzten Start ist die Platte nur an PCR 7 gebunden (Neu-Binden beim Start ausgeblieben – Startmedium eingelegt oder Secure Boot aus?). Ohne Medium neu starten bzw. sudo schulosctl tpm-neu-binden.",
      );
    else if (days >= TPM_TRANSITION_MAX_DAYS)
      out.push(
        `Übergangsschlüssel (nur PCR 7) liegt seit ${days} Tagen – bitte neu starten, dann bindet SchulOS wieder an PCR 7+8+9.`,
      );
  } else if (f.pcrSets !== null) {
    const bad = f.pcrSets.filter((p) => p !== TPM_PCRS);
    if (!f.pcrSets.length)
      out.push("Kein TPM2-Schlüsselplatz – die Platte startet nur mit dem Wiederherstellungsschlüssel (sudo schulosctl tpm-neu-binden).");
    else if (bad.length)
      out.push(
        `TPM2-Plätze an PCR ${f.pcrSets.join(" / ")} statt nur ${TPM_PCRS} (sudo schulosctl tpm-neu-binden).`,
      );
  }
  return out;
}

/** G4E-O02: Startet der Server nach einem Neustart sicher ohne Mensch? (sonst kein automatischer Neustart im Wartungsfenster) */
export function tpmNeedsHuman(f: Pick<TpmFacts, "mode" | "efiChanged">): boolean {
  return f.mode === "tpm2" && f.efiChanged;
}

/** crypttab: wie wird beim Start entsperrt? */
export function unlockMode(
  crypttab: string,
): "tpm2" | "tpm2-pin" | "passphrase" | "none" {
  for (const raw of crypttab.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const opts = (line.split(/\s+/)[3] ?? "").split(",");
    if (opts.some((o) => o.startsWith("tpm2-device=")))
      return opts.some((o) => /^tpm2-pin=(yes|true|1)$/.test(o))
        ? "tpm2-pin"
        : "tpm2";
    return "passphrase";
  }
  return "none";
}
