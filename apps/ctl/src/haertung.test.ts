import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GRUB_PASSWORD_FILE,
  grubPbkdf2,
  TPM_MARKER,
  TPM_SCRIPT,
  TPM_SCRIPT_CONTENT,
  TPM_STAND_FILE,
  TPM_STATE_DIR,
} from "@schulos/server/boot-hardening";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./core";
import { hardeningPlan, TRANSITION_COMMAND, type HardeningPlan } from "./haertung";
import { passphraseAtBoot } from "./recovery";

const HASH = grubPbkdf2("abcdefghjkmn2345", undefined, 1000);

describe("SEC-09: schulosctl sicherheit-nachruesten", () => {
  it("Aufruf (auch --passwort-stdin), tpm-neu-binden, ssh-netze", () => {
    expect(parseArgs(["sicherheit-nachruesten"]).command).toEqual({
      name: "sicherheit-nachruesten",
      yes: false,
      passwordStdin: false,
    });
    expect(parseArgs(["sicherheit-nachruesten", "--yes", "--passwort-stdin"]).command).toEqual({
      name: "sicherheit-nachruesten",
      yes: true,
      passwordStdin: true,
    });
    expect(() => parseArgs(["sicherheit-nachruesten", "x"])).toThrow();
    expect(parseArgs(["tpm-neu-binden"]).command).toEqual({ name: "tpm-neu-binden" });
    expect(() => parseArgs(["tpm-neu-binden", "x"])).toThrow();
    expect(parseArgs(["ssh-netze"]).command).toEqual({ name: "ssh-netze", nets: [], yes: false });
    expect(parseArgs(["ssh-netze", "10.0.0.0/8", "fd00::/8", "--yes"]).command).toEqual({ name: "ssh-netze", nets: ["10.0.0.0/8", "fd00::/8"], yes: true });
  });

  it("TPM2, noch nicht gebunden: GRUB-Dateien, Skript/Dienst/Hook, Markierung, Dienst einschalten, update-grub zuletzt", () => {
    const p = hardeningPlan(HASH, "tpm2", true);
    const paths = p.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([GRUB_PASSWORD_FILE, TPM_SCRIPT, TPM_MARKER]));
    expect(p.files.find((f) => f.path === GRUB_PASSWORD_FILE)!.mode).toBe(0o700);
    expect(p.commands).toContainEqual(["systemctl", "enable", "schulos-tpm.service"]);
    expect(p.commands.at(-1)).toEqual(["update-grub"]);
    expect(p.notes.join(" ")).toContain("PCR 7+8+9");
    // Secure Boot aus: trotzdem vorbereiten, aber deutlich sagen, dass es bei PCR 7 bleibt
    expect(hardeningPlan(HASH, "tpm2", false).notes.join(" ")).toMatch(/Secure Boot ist aus/);
  });

  it("G4E-O01: schon gebunden – keine Erstbindungs-Markierung, nach update-grub den Übergang anlegen (tpm-binden.sh pruefen)", () => {
    const p = hardeningPlan(HASH, "tpm2", true, false, true);
    expect(p.files.map((f) => f.path)).not.toContain(TPM_MARKER);
    expect(p.files.map((f) => f.path)).toContain(TPM_SCRIPT);
    expect(p.commands.slice(-2)).toEqual([["update-grub"], [TPM_SCRIPT, "pruefen"]]);
    expect(p.commands.at(-1)).toBe(TRANSITION_COMMAND);
    expect(p.notes.join(" ")).toMatch(/Übergangsschlüssel an PCR 7/);
  });

  it("PIN, Passphrase, ohne Verschlüsselung: nur das Bootmenü-Passwort", () => {
    for (const m of ["tpm2-pin", "passphrase", "none"] as const) {
      for (const bound of [false, true]) {
        const p = hardeningPlan(HASH, m, true, false, bound);
        expect(p.files.map((f) => f.path)).not.toContain(TPM_MARKER);
        expect(p.files.map((f) => f.path)).toContain(GRUB_PASSWORD_FILE);
        expect(p.commands).toEqual([["update-grub"]]);
      }
    }
  });

  it("Neustart im Wartungsfenster: TPM2 + PIN braucht wie die Passphrase einen Menschen", () => {
    expect(passphraseAtBoot("schulos-root /dev/md/schulos none luks,discard,tpm2-device=auto\n")).toBe(false);
    expect(passphraseAtBoot("schulos-root /dev/md/schulos none luks,discard,tpm2-device=auto,tpm2-pin=yes\n")).toBe(true);
  });
});

// G4E-O01 durchgespielt: Server ist an PCR 7+8+9 gebunden, `sicherheit-nachruesten` schreibt ein neues Bootmenü (update-grub →
// neue grub.cfg), danach muss der Übergang liegen, damit der nächste Start ohne Wiederherstellungsschlüssel entsperrt und neu bindet.
// Echtes tpm-binden.sh in bash; systemd-cryptenroll, blkid, systemctl und update-grub als Attrappen; Pfade unter einem Temp-Ordner.
const bash = spawnSync("bash", ["-c", "command -v sha256sum od awk find"]).status === 0;
describe.skipIf(!bash)("G4E-O01: gebunden → nachrüsten → prüfen → Start (Attrappen)", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const root = (p: string) => path.join(dir, "root", p);
  function sh(args: string[], env: Record<string, string> = {}) {
    return spawnSync(
      "bash",
      [
        "-c",
        'u() { cygpath -u "$1" 2>/dev/null || echo "$1"; }; D=$(u "$D"); chmod +x "$D"/stubs/*; R="$D/root"; ' +
          'PATH="$D/stubs:$PATH" SCHULOS_TPM_STATE="$R/var/lib/schulos/tpm" SCHULOS_CRYPTTAB="$R/etc/crypttab" SCHULOS_BOOT_DIR="$R/boot" ' +
          'SCHULOS_SB_VAR="$D/sb" CALLS="$D/calls" bash "$R/usr/local/lib/schulos/tpm-binden.sh" "$@"',
        "_",
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, D: dir, ...env } },
    );
  }
  const calls = () => (existsSync(path.join(dir, "calls")) ? readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean) : []);

  /** Plan wie hardenExisting ausführen – Dateien unter root/, Befehle als Attrappen bzw. das echte Skript */
  function apply(plan: HardeningPlan): number {
    for (const d of plan.dirs) mkdirSync(root(d), { recursive: true });
    for (const f of plan.files) {
      mkdirSync(path.dirname(root(f.path)), { recursive: true });
      writeFileSync(root(f.path), f.content);
    }
    for (const c of plan.commands) {
      if (c[0] === "systemctl") continue;
      if (c[0] === "update-grub") {
        // neue grub.cfg mit dem neuen Passwort-Hash (neuer Salt) – ändert, was GRUB misst (PCR 8/9)
        writeFileSync(root("boot/grub/grub.cfg"), `${readFileSync(root(GRUB_PASSWORD_FILE), "utf8")}menuentry 'SchulOS' --unrestricted {}\n`);
        continue;
      }
      if (c === TRANSITION_COMMAND) {
        const r = sh(["pruefen"]);
        if (r.status !== 0) return r.status ?? 1;
        continue;
      }
      throw new Error(`unerwarteter Befehl ${c.join(" ")}`);
    }
    return 0;
  }

  function setup() {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-nachruesten-"));
    for (const d of ["stubs", "root/boot/grub", "root/etc", `root${TPM_STATE_DIR}`, "root/usr/local/lib/schulos"]) mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(root("etc/crypttab"), "schulos-root PARTLABEL=schulos-system none luks,discard,tpm2-device=auto\n");
    writeFileSync(root("boot/vmlinuz-6.12.1"), "kernel");
    writeFileSync(root("boot/initrd.img-6.12.1"), "initrd");
    writeFileSync(root("boot/grub/grub.cfg"), "set superusers=alt\n");
    writeFileSync(root(TPM_SCRIPT), TPM_SCRIPT_CONTENT);
    writeFileSync(path.join(dir, "sb"), Buffer.from([6, 0, 0, 0, 1]));
    writeFileSync(path.join(dir, "stubs/systemd-cryptenroll"), '#!/bin/bash\necho "$*" >> "$CALLS"\nexit ${ENROLL_RC:-0}\n');
    writeFileSync(path.join(dir, "stubs/blkid"), "#!/bin/bash\nexit 0\n");
    // Installer: Markierung, erster Start bindet an 7+8+9
    writeFileSync(root(TPM_MARKER), "");
    expect(sh(["start"]).status).toBe(0);
    expect(existsSync(root(TPM_STAND_FILE))).toBe(true);
    expect(existsSync(root(TPM_MARKER))).toBe(false);
  }

  it("Übergang an PCR 7 nach update-grub, nächster Start bindet neu an 7+8+9", () => {
    setup();
    const plan = hardeningPlan(grubPbkdf2("abcdefghjkmn2345", undefined, 1000), "tpm2", true, false, existsSync(root(TPM_STAND_FILE)));
    expect(apply(plan)).toBe(0);
    expect(calls().at(-1)).toBe("--unlock-tpm2-device=auto --tpm2-device=auto --tpm2-pcrs=7 /dev/disk/by-partlabel/schulos-system");
    expect(existsSync(root(TPM_MARKER))).toBe(true);
    // Herunterfahren (pruefen): kein zweiter Übergang
    expect(sh(["pruefen"]).status).toBe(0);
    expect(calls()).toHaveLength(2);
    // nächster Start: entsperrt per Übergang (Attrappe), bindet neu an 7+8+9 und löscht die anderen TPM2-Plätze
    expect(sh(["start"]).status).toBe(0);
    expect(calls().at(-1)).toContain("--tpm2-pcrs=7+8+9 --wipe-slot=tpm2");
    expect(existsSync(root(TPM_MARKER))).toBe(false);
  });

  it("vorher (Fehlerbild): Erstbindungs-Markierung auf gebundenem System → pruefen tut nichts, kein Übergang", () => {
    setup();
    const plan = hardeningPlan(grubPbkdf2("abcdefghjkmn2345", undefined, 1000), "tpm2", true, false, false);
    expect(apply(plan)).toBe(0);
    // so sah es vor G4E-O01 aus: Markierung liegt, aber kein PCR-7-Übergang angelegt → jeder Start bräuchte den Wiederherstellungsschlüssel
    expect(existsSync(root(TPM_MARKER))).toBe(true);
    expect(sh(["pruefen"]).status).toBe(0);
    expect(calls()).toHaveLength(1);
  });

  it("Übergang scheitert → Exit ≠ 0 (hardenExisting meldet TRANSITION_FAILED), Fehlerdatei für die Überwachung", () => {
    setup();
    const plan = hardeningPlan(grubPbkdf2("abcdefghjkmn2345", undefined, 1000), "tpm2", true, false, true);
    const old = process.env.ENROLL_RC;
    process.env.ENROLL_RC = "1";
    try {
      expect(apply(plan)).not.toBe(0);
    } finally {
      if (old === undefined) delete process.env.ENROLL_RC;
      else process.env.ENROLL_RC = old;
    }
    expect(existsSync(root(`${TPM_STATE_DIR}/fehler`))).toBe(true);
  });
});
