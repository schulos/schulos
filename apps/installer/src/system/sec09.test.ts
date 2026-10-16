// SEC-09: GRUB-Superuser und TPM2 an PCR 7+8+9 bzw. TPM2 + PIN – Installer-Schritte und Fragen. Der echte Start (swtpm,
// OVMF mit Secure Boot, Neustart mit gebundenem TPM2) läuft nur in der CI (scripts/qemu-test.sh).
import {
  GRUB_DEFAULT_ENTRY_FILE,
  GRUB_PASSWORD_FILE,
  TPM_APT_HOOK_FILE,
  TPM_MARKER,
  TPM_SCRIPT,
  TPM_UNIT_FILE,
  verifyGrubPbkdf2,
} from "@schulos/server/boot-hardening";
import { describe, expect, it } from "vitest";
import { resolve } from "../answers";
import { CTX, PRODUCTION } from "../fixtures";
import { generate, GRUB_PASSWORD_KEY, type InstallPlan } from "../generate";
import { QUESTION_BY_ID, type Answers } from "../questions";
import { layout } from "./layout";
import { installSteps, type Step } from "./steps";
import { crypttab, dracutConf } from "./target-config";
import { updateConfigSteps } from "./update-steps";

const O = {
  target: "/target",
  mirror: "file:///run/live/medium/debian",
  keyFile: "/run/schulos-installer/startschluessel",
};
const PW = "Wartung-im-Keller-2026";

function plan(system: Answers, role: "main" | "backup" = "main"): InstallPlan {
  return {
    role,
    stackDir: role === "main" ? "/opt/schulos" : "/opt/schulos-backup",
    composeSource: "compose.yaml",
    files: [],
    system: { "access.password": PW, [GRUB_PASSWORD_KEY]: GRUB_PW, "disk.devices": ["/dev/sda"], ...system },
  };
}
const GRUB_PW = "abcdefghjkmn2345";
const runs = (steps: Step[]) =>
  steps.filter((s): s is Extract<Step, { kind: "run" }> => s.kind === "run");
const written = (steps: Step[], p: string) =>
  (
    steps.find((s) => s.kind === "write" && s.path === p) as
      Extract<Step, { kind: "write" }> | undefined
  )?.content;
const writeStep = (steps: Step[], p: string) =>
  steps.find((s) => s.kind === "write" && s.path === p) as
    Extract<Step, { kind: "write" }> | undefined;

describe("SEC-09: GRUB-Superuser", () => {
  it("G4E-O04/O05: generate erzeugt ein eigenes Bootmenü-Passwort (US/DE-gleiche Zeichen), nicht das Wartungspasswort", async () => {
    const p = await generate({ ...PRODUCTION }, { hashPassword: async () => "x", randomSecret: () => "s" }, CTX);
    const g = p.system[GRUB_PASSWORD_KEY];
    expect(typeof g).toBe("string");
    expect(g).toMatch(/^[a-hjkmnp-x2-9]{16}$/);
    expect(g).not.toBe(p.system["access.password"]);
    // nicht in den exportierten Antworten (schulos-install.yaml)
    expect(p.files.map((f) => f.content).join("\n")).not.toContain(g as string);
  });

  it("jede Installation: Standardeintrag ohne Passwort, Superuser mit dem Bootmenü-Passwort (nur als Hash), vor update-grub", () => {
    for (const enc of ["tpm2", "passphrase", "none"]) {
      const { steps } = installSteps(
        plan({
          "disk.encryption": enc,
          "disk.passphrase": "Platte-im-Keller-2026",
        }),
        O,
      );
      const pw = written(steps, `/target${GRUB_PASSWORD_FILE}`)!;
      expect(pw).toContain('set superusers="schulos"');
      const hash = /password_pbkdf2 schulos (\S+)/.exec(pw)![1]!;
      expect(verifyGrubPbkdf2(GRUB_PW, hash)).toBe(true);
      expect(verifyGrubPbkdf2(PW, hash)).toBe(false);
      expect(pw).not.toContain(GRUB_PW);
      expect(writeStep(steps, `/target${GRUB_PASSWORD_FILE}`)!.mode).toBe(
        0o700,
      );
      expect(written(steps, `/target${GRUB_DEFAULT_ENTRY_FILE}`)).toContain(
        "--unrestricted",
      );
      const i = steps.findIndex(
        (s) => s.kind === "write" && s.path === `/target${GRUB_PASSWORD_FILE}`,
      );
      const u = steps.findIndex(
        (s) => s.kind === "run" && s.argv.includes("update-grub"),
      );
      expect(i).toBeGreaterThan(-1);
      expect(i).toBeLessThan(u);
    }
  });
});

describe("SEC-09: TPM2", () => {
  it("„tpm2“: im Live-System nur PCR 7, Markierung + Dienst + dpkg-Hook – der erste Start bindet an 7+8+9", () => {
    const { steps } = installSteps(plan({ "disk.encryption": "tpm2" }), O);
    const enroll = runs(steps).find((s) =>
      s.argv.includes("--tpm2-device=auto"),
    )!;
    expect(enroll.argv).toContain("--tpm2-pcrs=7");
    expect(enroll.argv).not.toContain("--tpm2-with-pin=yes");
    expect(written(steps, `/target${TPM_SCRIPT}`)).toContain(
      "--tpm2-pcrs=7+8+9 --wipe-slot=tpm2",
    );
    expect(written(steps, `/target${TPM_UNIT_FILE}`)).toContain("ExecStop=");
    expect(written(steps, `/target${TPM_APT_HOOK_FILE}`)).toContain(
      "DPkg::Post-Invoke",
    );
    expect(written(steps, `/target${TPM_MARKER}`)).toBe("");
    expect(
      runs(steps).some(
        (s) =>
          s.argv.join(" ") ===
          "chroot /target systemctl enable schulos-tpm.service",
      ),
    ).toBe(true);
    expect(crypttab(layout(["/dev/sda"], "tpm2"))).toContain(
      "luks,discard,tpm2-device=auto\n",
    );
  });

  it("„tpm2-pin“: PCR 7 + PIN (nur auf stdin), crypttab kennzeichnet die PIN, kein Neu-Binden, kein Neustart-Timer", () => {
    const { steps } = installSteps(
      plan({ "disk.encryption": "tpm2-pin", "disk.tpm_pin": "4711-0815-x" }),
      O,
    );
    const enroll = runs(steps).find((s) =>
      s.argv.includes("--tpm2-with-pin=yes"),
    )!;
    expect(enroll.argv).toContain("--tpm2-pcrs=7");
    expect(enroll.stdin).toBe("4711-0815-x");
    expect(enroll.argv.join(" ")).not.toContain("4711");
    expect(written(steps, `/target${TPM_MARKER}`)).toBeUndefined();
    expect(written(steps, `/target${TPM_SCRIPT}`)).toBeUndefined();
    // Wiederherstellungsschlüssel wie bei „tpm2“
    expect(runs(steps).some((s) => s.capture === "recoveryKey")).toBe(true);
    const l = layout(["/dev/sda"], "tpm2-pin");
    expect(crypttab(l)).toContain("tpm2-device=auto,tpm2-pin=yes");
    expect(dracutConf(l)).toContain("tpm2-tss");
    const timer = (enc: string) =>
      updateConfigSteps(plan({ "disk.encryption": enc }, "backup"), "/target").some(
        (s) => s.kind === "write" && s.path.endsWith("schulos-neustart.timer"),
      );
    expect(timer("tpm2-pin")).toBe(false);
    expect(timer("tpm2")).toBe(true);
    // SEC-14: Host-Status für die Backup-App immer (Statuskarte „Neustart nötig – Passphrase erforderlich“)
    for (const enc of ["tpm2-pin", "tpm2", "passphrase"])
      expect(
        updateConfigSteps(plan({ "disk.encryption": enc }, "backup"), "/target").some(
          (s) => s.kind === "run" && s.argv.join(" ") === "chroot /target systemctl enable schulos-hoststatus.timer",
        ),
      ).toBe(true);
  });

  it("Fragen: TPM2 nur mit Secure Boot; PIN ab 8 Zeichen, geheim, nicht in der .env", () => {
    const q = QUESTION_BY_ID.get("disk.encryption")!;
    const a = { ...PRODUCTION };
    const values = (ctx: typeof CTX) => q.options!(a, ctx).map((o) => o.value);
    expect(values(CTX)).toEqual(["tpm2", "tpm2-pin", "passphrase"]);
    expect(values({ ...CTX, secureBoot: true })).toEqual([
      "tpm2",
      "tpm2-pin",
      "passphrase",
    ]);
    expect(values({ ...CTX, secureBoot: false })).toEqual(["passphrase"]);
    expect(q.default!(a, { ...CTX, secureBoot: false })).toBe("passphrase");
    expect(q.validate!("tpm2", a, { ...CTX, secureBoot: false })).toMatch(
      /Secure Boot/,
    );
    expect(q.validate!("tpm2-pin", a, { ...CTX, tpm2: false })).toMatch(
      /kein TPM2/,
    );
    expect(q.warn!("tpm2-pin", a, CTX)).toMatch(/PIN an der Konsole/);
    const pin = QUESTION_BY_ID.get("disk.tpm_pin")!;
    expect(pin).toMatchObject({
      secret: true,
      notInEnv: true,
      kind: "password",
    });
    const r = resolve(
      { ...a, "disk.encryption": "tpm2-pin" },
      { ...CTX, secureBoot: true },
    );
    expect(r.missing).toContain("disk.tpm_pin");
    expect(pin.validate!("1234567", a, CTX)).toMatch(/8 Zeichen/);
    expect(pin.validate!("12345678", a, CTX)).toBeNull();
  });
});
