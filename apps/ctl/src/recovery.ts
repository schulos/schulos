// Neuer LUKS-Wiederherstellungsschlüssel (INST-01, `schulosctl wiederherstellungsschluessel`): Gerät aus /etc/crypttab,
// Schlüsselplätze aus `cryptsetup luksDump --dump-json-metadata`. Rein.

/** LUKS-Gerät der TPM2-Zeile in crypttab (vom Installer: `schulos-root /dev/disk/by-partlabel/… none luks,discard,tpm2-device=auto`) */
export function tpm2DeviceFromCrypttab(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [, device, , options = ""] = line.split(/\s+/);
    if (!device || !options.split(",").some((o) => o.startsWith("tpm2-device="))) continue;
    const m = /^(UUID|PARTUUID|LABEL|PARTLABEL)=(.+)$/.exec(device);
    if (!m) return device;
    return `/dev/disk/by-${m[1]!.toLowerCase()}/${m[2]}`;
  }
  return null;
}

/**
 * Q5-18: Braucht der Start eine Passphrase? Ja, sobald ein Eintrag in crypttab weder per TPM2 (`tpm2-device=`) noch per
 * Schlüsseldatei (3. Feld) entsperrt wird. Ohne crypttab bzw. ohne Einträge (unverschlüsselte Demo) startet er von selbst.
 */
export function passphraseAtBoot(crypttab: string): boolean {
  for (const raw of crypttab.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [, device, keyFile = "none", options = ""] = line.split(/\s+/);
    if (!device) continue;
    const opts = options.split(",");
    // SEC-09: TPM2 + PIN fragt beim Start nach der PIN – wie eine Passphrase (kein Neustart ohne Mensch)
    if (opts.some((o) => o.startsWith("tpm2-device=")) && !opts.some((o) => /^tpm2-pin=(yes|true|1)$/.test(o))) continue;
    // swap/tmp mit Zufallsschlüssel bzw. Schlüsseldatei: kein Eingriff nötig
    if (keyFile !== "none" && keyFile !== "-") continue;
    return true;
  }
  return false;
}

/** Schlüsselplätze mit Wiederherstellungsschlüssel (Token „systemd-recovery“), aufsteigend */
export function recoverySlots(luksJson: string): number[] {
  const meta = JSON.parse(luksJson) as { tokens?: Record<string, { type?: string; keyslots?: string[] }> };
  return Object.values(meta.tokens ?? {})
    .filter((t) => t.type === "systemd-recovery")
    .flatMap((t) => (t.keyslots ?? []).map(Number))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}
