import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatGrubPassword,
  generateGrubPassword,
  GRUB_DEFAULT_ENTRY_SCRIPT,
  grubPasswordProblem,
  grubPasswordScript,
  grubPbkdf2,
  secureBootFromEfivar,
  TPM_APT_HOOK,
  TPM_SCRIPT,
  TPM_SCRIPT_CONTENT,
  TPM_UNIT,
  tpm2PcrSets,
  tpmBindingProblems,
  tpmNeedsHuman,
  unlockMode,
  verifyGrubPbkdf2,
  type TpmFacts,
} from "./boot-hardening";

describe("SEC-09: GRUB-Superuser", () => {
  it("Hash im Format von grub-mkpasswd-pbkdf2, prüfbar, je Aufruf neues Salz", () => {
    const h = grubPbkdf2("Wartung-im-Keller-2026", undefined, 1000);
    expect(h).toMatch(
      /^grub\.pbkdf2\.sha512\.1000\.[0-9A-F]{128}\.[0-9A-F]{128}$/,
    );
    expect(verifyGrubPbkdf2("Wartung-im-Keller-2026", h)).toBe(true);
    expect(verifyGrubPbkdf2("falsch", h)).toBe(false);
    expect(grubPbkdf2("x", undefined, 1000)).not.toBe(
      grubPbkdf2("x", undefined, 1000),
    );
    expect(() => grubPbkdf2("")).toThrow();
    // Vorgabe: 100 000 Runden
    expect(grubPbkdf2("x", Buffer.alloc(64, 1))).toMatch(
      /^grub\.pbkdf2\.sha512\.100000\./,
    );
  });

  it("Passwort-Datei setzt Superuser und Hash, nimmt nur einen echten Hash", () => {
    const h = grubPbkdf2("geheim-geheim", undefined, 1000);
    const s = grubPasswordScript(h);
    expect(s).toContain('set superusers="schulos"');
    expect(s).toContain(`password_pbkdf2 schulos ${h}`);
    expect(s).not.toContain("geheim-geheim");
    expect(() => grubPasswordScript("klartext")).toThrow(
      "Kein GRUB-PBKDF2-Hash",
    );
    expect(() => grubPasswordScript(`${h}\nset superusers=""`)).toThrow();
  });

  it("G4E-O04/O05: Bootmenü-Passwort zufällig, nur Zeichen, die auf US- und DE-Tastatur gleich liegen; eigenes nur geprüft", () => {
    const pw = generateGrubPassword();
    expect(pw).toMatch(/^[a-hjkmnp-x2-9]{16}$/);
    expect(generateGrubPassword()).not.toBe(pw);
    // gleich verteilt: Bytes ≥ 232 werden verworfen
    let n = 0;
    const fixed = generateGrubPassword((k) => Buffer.from(Array.from({ length: k }, () => (n++ % 2 ? 255 : 0))));
    expect(fixed).toBe("a".repeat(16));
    expect(formatGrubPassword("abcdefgh23456789")).toBe("abcd efgh 2345 6789");
    expect(grubPasswordProblem("abcdefghjkmn")).toBeNull();
    expect(grubPasswordProblem("ABCDefgh2345")).toBeNull();
    expect(grubPasswordProblem("kurz")).toMatch(/mindestens 12/);
    expect(grubPasswordProblem("Wartung-im-Keller-2026")).toMatch(/US-Tastaturbelegung/);
    expect(grubPasswordProblem("zeitzonenwechsel")).toMatch(/US-Tastaturbelegung/);
    expect(grubPasswordProblem("Grüße-aus-dem-Keller")).not.toBeNull();
  });

  it("Standardeintrag ohne Passwort nur zum Starten, neuester Kernel, Wurzel wie 10_linux", () => {
    expect(GRUB_DEFAULT_ENTRY_SCRIPT).toContain("--unrestricted");
    expect(GRUB_DEFAULT_ENTRY_SCRIPT).toContain("sort -V | tail -n 1");
    expect(GRUB_DEFAULT_ENTRY_SCRIPT).toContain(
      'prepare_grub_to_access_device "${GRUB_DEVICE_BOOT}"',
    );
    expect(GRUB_DEFAULT_ENTRY_SCRIPT).toContain(
      "root=UUID=$GRUB_DEVICE_UUID rootflags=subvol=@ ro $GRUB_CMDLINE_LINUX",
    );
  });
});

describe("SEC-09: Entsperren und Secure Boot", () => {
  it("crypttab → Art des Entsperrens", () => {
    expect(
      unlockMode(
        "# SchulOS\nschulos-root /dev/md/schulos none luks,discard,tpm2-device=auto\n",
      ),
    ).toBe("tpm2");
    expect(
      unlockMode(
        "schulos-root PARTLABEL=x none luks,tpm2-device=auto,tpm2-pin=yes\n",
      ),
    ).toBe("tpm2-pin");
    expect(unlockMode("schulos-root /dev/sda3 none luks,discard\n")).toBe(
      "passphrase",
    );
    expect(unlockMode("# leer\n")).toBe("none");
  });

  it("Secure Boot aus der EFI-Variablen", () => {
    expect(secureBootFromEfivar(new Uint8Array([6, 0, 0, 0, 1]))).toBe(true);
    expect(secureBootFromEfivar(new Uint8Array([6, 0, 0, 0, 0]))).toBe(false);
    expect(secureBootFromEfivar(null)).toBeUndefined();
    expect(secureBootFromEfivar(new Uint8Array([6]))).toBeUndefined();
  });

  it("G4E-O03: PCR-Sätze aus luksDump, Bewertung der Bindung", () => {
    const dump = JSON.stringify({
      tokens: {
        "0": { type: "systemd-tpm2", "tpm2-pcrs": [9, 7, 8] },
        "1": { type: "systemd-recovery", keyslots: ["2"] },
        "2": { type: "systemd-tpm2", "tpm2-pcrs": [7] },
      },
    });
    expect(tpm2PcrSets(dump)).toEqual(["7+8+9", "7"]);
    const now = new Date("2026-10-14T10:00:00Z");
    const ok: TpmFacts = { mode: "tpm2", secureBoot: true, markerSince: null, bootedAt: "2026-10-14T06:00:00Z", error: null, efiChanged: false, pcrSets: ["7+8+9"] };
    expect(tpmBindingProblems(ok, now)).toEqual([]);
    expect(tpmBindingProblems({ ...ok, mode: "passphrase", secureBoot: false }, now)).toEqual([]);
    expect(tpmBindingProblems({ ...ok, secureBoot: false }, now)[0]).toMatch(/Secure Boot ist aus/);
    expect(tpmBindingProblems({ ...ok, pcrSets: ["7"] }, now)[0]).toMatch(/PCR 7 statt nur 7\+8\+9/);
    expect(tpmBindingProblems({ ...ok, pcrSets: [] }, now)[0]).toMatch(/Kein TPM2-Schlüsselplatz/);
    expect(tpmBindingProblems({ ...ok, error: "2026-10-14 Binden fehlgeschlagen" }, now)[0]).toMatch(/gescheitert/);
    // Übergang seit heute (nach dem Start angelegt): in Ordnung; seit 8 Tagen: Neustart anmahnen; von vor dem Start: Neu-Binden ausgeblieben
    expect(tpmBindingProblems({ ...ok, markerSince: "2026-10-14T09:00:00Z", pcrSets: ["7+8+9", "7"] }, now)).toEqual([]);
    expect(tpmBindingProblems({ ...ok, bootedAt: "2026-10-01T00:00:00Z", markerSince: "2026-10-06T09:00:00Z" }, now)[0]).toMatch(/seit 8 Tagen/);
    expect(tpmBindingProblems({ ...ok, markerSince: "2026-10-13T09:00:00Z" }, now)[0]).toMatch(/Seit dem letzten Start/);
    expect(tpmNeedsHuman({ mode: "tpm2", efiChanged: true })).toBe(true);
    expect(tpmNeedsHuman({ mode: "tpm2", efiChanged: false })).toBe(false);
    expect(tpmBindingProblems({ ...ok, efiChanged: true }, now)[0]).toMatch(/shim bzw\. GRUB/);
  });

  it("Dienst bindet beim Start, prüft beim Herunterfahren; dpkg-Hook prüft nach jedem Lauf", () => {
    expect(TPM_UNIT).toContain(`ExecStart=${TPM_SCRIPT} start`);
    expect(TPM_UNIT).toContain(`ExecStop=${TPM_SCRIPT} pruefen`);
    expect(TPM_UNIT).toContain("After=cryptsetup.target");
    expect(TPM_APT_HOOK).toContain("DPkg::Post-Invoke");
    expect(TPM_APT_HOOK).toContain(`${TPM_SCRIPT} pruefen || true`);
  });
});

// Das Skript echt in bash ausführen – systemd-cryptenroll und blkid als Attrappen, die ihre Aufrufe mitschreiben
const bash =
  spawnSync("bash", ["-c", "command -v sha256sum od awk find"]).status === 0;
describe.skipIf(!bash)("SEC-09: tpm-binden.sh (bash, Attrappen)", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function setup(
    crypttab = "schulos-root PARTLABEL=schulos-system none luks,discard,tpm2-device=auto\n",
  ) {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-tpm-"));
    for (const d of ["stubs", "boot/grub", "state"])
      mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(path.join(dir, "tpm-binden.sh"), TPM_SCRIPT_CONTENT);
    writeFileSync(path.join(dir, "crypttab"), crypttab);
    writeFileSync(path.join(dir, "boot/vmlinuz-6.12.1"), "kernel");
    writeFileSync(path.join(dir, "boot/initrd.img-6.12.1"), "initrd");
    writeFileSync(path.join(dir, "boot/grub/grub.cfg"), "menuentry");
    writeFileSync(path.join(dir, "sb"), Buffer.from([6, 0, 0, 0, 1]));
    writeFileSync(
      path.join(dir, "stubs/systemd-cryptenroll"),
      '#!/bin/bash\necho "$*" >> "$CALLS"\nexit ${ENROLL_RC:-0}\n',
    );
    writeFileSync(
      path.join(dir, "stubs/blkid"),
      '#!/bin/bash\n[ -n "${MEDIUM:-}" ] && echo /dev/sr0\nexit 0\n',
    );
    const run = (arg: string, env: Record<string, string> = {}) => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          'u() { cygpath -u "$1" 2>/dev/null || echo "$1"; }; D=$(u "$D"); chmod +x "$D"/stubs/*; ' +
            'PATH="$D/stubs:$PATH" SCHULOS_TPM_STATE="$D/state" SCHULOS_CRYPTTAB="$D/crypttab" SCHULOS_BOOT_DIR="$D/boot" ' +
            'SCHULOS_SB_VAR="$D/sb" CALLS="$D/calls" bash "$D/tpm-binden.sh" "$1"',
          "_",
          arg,
        ],
        { encoding: "utf8", env: { ...process.env, D: dir, ...env } },
      );
      return r;
    };
    const calls = () =>
      existsSync(path.join(dir, "calls"))
        ? readFileSync(path.join(dir, "calls"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
        : [];
    const marker = () => existsSync(path.join(dir, "state/neu-binden"));
    const mark = () => writeFileSync(path.join(dir, "state/neu-binden"), "");
    return { run, calls, marker, mark };
  }

  it("Ablauf: Erststart bindet an 7+8+9, Kernel-Update → Übergang an PCR 7, nächster Start bindet neu", () => {
    const t = setup();
    // ohne Markierung: nichts
    expect(t.run("start").status).toBe(0);
    expect(t.calls()).toEqual([]);
    // Installer hat markiert → Start bindet an 7+8+9 und löscht alle anderen TPM2-Plätze
    t.mark();
    const r = t.run("start");
    expect(r.status, r.stderr).toBe(0);
    expect(t.calls()).toEqual([
      "--unlock-tpm2-device=auto --tpm2-device=auto --tpm2-pcrs=7+8+9 --wipe-slot=tpm2 /dev/disk/by-partlabel/schulos-system",
    ]);
    expect(t.marker()).toBe(false);
    // nichts geändert → Prüfen tut nichts
    expect(t.run("pruefen").status).toBe(0);
    expect(t.calls()).toHaveLength(1);
    // neues Initramfs (Kernel-Update) → Übergangsschlüssel an PCR 7, Markierung
    writeFileSync(path.join(dir, "boot/initrd.img-6.12.1"), "initrd neu");
    expect(t.run("pruefen").status).toBe(0);
    expect(t.calls()[1]).toBe(
      "--unlock-tpm2-device=auto --tpm2-device=auto --tpm2-pcrs=7 /dev/disk/by-partlabel/schulos-system",
    );
    expect(t.marker()).toBe(true);
    // zweites Prüfen (z. B. beim Herunterfahren): kein weiterer Übergangsschlüssel
    expect(t.run("pruefen").status).toBe(0);
    expect(t.calls()).toHaveLength(2);
    // nächster Start bindet neu
    expect(t.run("start").status).toBe(0);
    expect(t.calls()[2]).toContain("--tpm2-pcrs=7+8+9 --wipe-slot=tpm2");
    expect(t.marker()).toBe(false);
    // geänderte grub.cfg zählt ebenfalls
    writeFileSync(path.join(dir, "boot/grub/grub.cfg"), "menuentry neu");
    t.run("pruefen");
    expect(t.marker()).toBe(true);
  });

  it("nicht binden: Startmedium steckt, Secure Boot aus, Binden scheitert (Übergang bleibt)", () => {
    const t = setup();
    t.mark();
    expect(t.run("start", { MEDIUM: "1" }).status).toBe(0);
    expect(t.calls()).toEqual([]);
    expect(t.marker()).toBe(true);
    writeFileSync(path.join(dir, "sb"), Buffer.from([6, 0, 0, 0, 0]));
    expect(t.run("start").status).toBe(0);
    expect(t.calls()).toEqual([]);
    writeFileSync(path.join(dir, "sb"), Buffer.from([6, 0, 0, 0, 1]));
    expect(t.run("start", { ENROLL_RC: "1" }).status).toBe(1);
    expect(t.marker()).toBe(true);
  });

  it("G4E-O02: jede Datei unter /boot zählt – Sprachdatei, Stub-grub.cfg auf der EFI-Partition; neues shim → zusätzlich efi-geaendert", () => {
    const t = setup();
    mkdirSync(path.join(dir, "boot/grub/locale"), { recursive: true });
    mkdirSync(path.join(dir, "boot/efi/EFI/debian"), { recursive: true });
    writeFileSync(path.join(dir, "boot/grub/locale/de.mo"), "mo");
    writeFileSync(path.join(dir, "boot/efi/EFI/debian/grub.cfg"), "search");
    writeFileSync(path.join(dir, "boot/efi/EFI/debian/shimx64.efi"), "shim 1");
    t.mark();
    expect(t.run("start").status).toBe(0);
    expect(existsSync(path.join(dir, "state/efi-stand"))).toBe(true);
    // neue Sprachdatei (grub-common) → Übergang, aber kein efi-geaendert
    writeFileSync(path.join(dir, "boot/grub/locale/de.mo"), "mo neu");
    expect(t.run("pruefen").status).toBe(0);
    expect(t.marker()).toBe(true);
    expect(existsSync(path.join(dir, "state/efi-geaendert"))).toBe(false);
    expect(t.run("start").status).toBe(0);
    // Stub-grub.cfg auf der ESP (Tiefe 3) → Übergang
    writeFileSync(path.join(dir, "boot/efi/EFI/debian/grub.cfg"), "search neu");
    t.run("pruefen");
    expect(t.marker()).toBe(true);
    expect(t.run("start").status).toBe(0);
    // neues shim → Übergang UND efi-geaendert (kein automatischer Neustart, Überwachung meldet)
    writeFileSync(path.join(dir, "boot/efi/EFI/debian/shimx64.efi"), "shim 2");
    expect(t.run("pruefen").status).toBe(0);
    expect(t.marker()).toBe(true);
    expect(existsSync(path.join(dir, "state/efi-geaendert"))).toBe(true);
    expect(t.calls().at(-1)).toContain("--tpm2-pcrs=7 ");
    // nächster Start bindet neu und löscht die Vermerke
    expect(t.run("start").status).toBe(0);
    expect(existsSync(path.join(dir, "state/efi-geaendert"))).toBe(false);
  });

  it("G4E-O01: Binden scheitert → Fehlerdatei (Überwachung); `gebunden` (nach tpm-neu-binden) merkt den Stand und räumt auf", () => {
    const t = setup();
    t.mark();
    expect(t.run("start", { ENROLL_RC: "1" }).status).toBe(1);
    expect(readFileSync(path.join(dir, "state/fehler"), "utf8")).toMatch(/tpm-neu-binden/);
    expect(t.marker()).toBe(true);
    expect(t.run("gebunden").status).toBe(0);
    expect(t.marker()).toBe(false);
    expect(existsSync(path.join(dir, "state/fehler"))).toBe(false);
    expect(existsSync(path.join(dir, "state/stand"))).toBe(true);
    // Übergang scheitert → ebenfalls Fehlerdatei, keine Markierung
    writeFileSync(path.join(dir, "boot/vmlinuz-6.12.1"), "kernel neu");
    expect(t.run("pruefen", { ENROLL_RC: "1" }).status).toBe(1);
    expect(t.marker()).toBe(false);
    expect(readFileSync(path.join(dir, "state/fehler"), "utf8")).toMatch(/Übergangsschlüssel nicht angelegt/);
    expect(t.run("x").status).toBe(64);
  });

  it("TPM2 mit PIN, Passphrase oder ohne crypttab: nie etwas tun", () => {
    for (const ct of [
      "schulos-root PARTLABEL=x none luks,tpm2-device=auto,tpm2-pin=yes\n",
      "schulos-root /dev/sda3 none luks,discard\n",
      "",
    ]) {
      const t = setup(ct);
      t.mark();
      expect(t.run("start").status).toBe(0);
      expect(t.calls()).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = "";
  });
});
