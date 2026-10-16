import { describe, expect, it } from "vitest";
import { parseArgs } from "./core";
import { passphraseAtBoot, recoverySlots, tpm2DeviceFromCrypttab } from "./recovery";

describe("schulosctl wiederherstellungsschluessel (INST-01)", () => {
  it("Aufruf", () => {
    expect(parseArgs(["wiederherstellungsschluessel"]).command).toEqual({ name: "wiederherstellungsschluessel", yes: false });
    expect(parseArgs(["wiederherstellungsschluessel", "--yes"]).command).toEqual({ name: "wiederherstellungsschluessel", yes: true });
    expect(() => parseArgs(["wiederherstellungsschluessel", "x"])).toThrow();
  });

  it("Gerät aus der crypttab des Installers (eine Platte bzw. Spiegel), nur mit TPM2", () => {
    const tab = (dev: string, opts: string) => `# SchulOS – entsperrt per TPM2\nschulos-root ${dev} none ${opts}\n`;
    expect(tpm2DeviceFromCrypttab(tab("/dev/disk/by-partlabel/schulos-system", "luks,discard,tpm2-device=auto"))).toBe("/dev/disk/by-partlabel/schulos-system");
    expect(tpm2DeviceFromCrypttab(tab("/dev/md/schulos", "luks,discard,tpm2-device=auto"))).toBe("/dev/md/schulos");
    expect(tpm2DeviceFromCrypttab(tab("UUID=1234-ab", "luks,tpm2-device=auto"))).toBe("/dev/disk/by-uuid/1234-ab");
    expect(tpm2DeviceFromCrypttab(tab("/dev/md/schulos", "luks,discard"))).toBeNull();
    expect(tpm2DeviceFromCrypttab("")).toBeNull();
  });

  it("Wiederherstellungs-Schlüsselplätze aus luksDump --dump-json-metadata", () => {
    const json = JSON.stringify({
      keyslots: { "1": {}, "2": {} },
      tokens: { "0": { type: "systemd-tpm2", keyslots: ["1"] }, "1": { type: "systemd-recovery", keyslots: ["2"] }, "2": { type: "systemd-recovery", keyslots: ["4"] } },
    });
    expect(recoverySlots(json)).toEqual([2, 4]);
    expect(recoverySlots(JSON.stringify({ keyslots: {} }))).toEqual([]);
  });
});

describe("Neustart nur ohne Passphrase (Q5-18)", () => {
  it("TPM2 oder Schlüsseldatei → startet von selbst; Passphrase → nicht", () => {
    expect(passphraseAtBoot("# SchulOS – entsperrt per TPM2\nschulos-root /dev/md/schulos none luks,discard,tpm2-device=auto\n")).toBe(false);
    expect(passphraseAtBoot("# SchulOS – Passphrase beim Start\nschulos-root /dev/disk/by-partlabel/schulos-system none luks,discard\n")).toBe(true);
    expect(passphraseAtBoot("schulos-root UUID=12-ab -\n")).toBe(true);
    expect(passphraseAtBoot("swap /dev/sda3 /dev/urandom swap,cipher=aes-xts-plain64\ndaten /dev/sdb1 /etc/keys/daten.key luks\n")).toBe(false);
    expect(passphraseAtBoot("swap /dev/sda3 /dev/urandom swap\nschulos-root /dev/sda2 none luks,discard\n")).toBe(true);
    // unverschlüsselt (Demo): keine crypttab bzw. nur Kommentare
    expect(passphraseAtBoot("")).toBe(false);
    expect(passphraseAtBoot("# <target name> <source device> <key file> <options>\n")).toBe(false);
  });
});
