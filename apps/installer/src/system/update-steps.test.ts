import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { generate } from "../generate";
import { BACKUP, CTX, PRODUCTION } from "../fixtures";
import type { Step } from "./steps";
import { backupRebootUnits, needrestartConf, unattendedConf, updateSteps } from "./update-steps";

const deps = { hashPassword, randomSecret: () => "zufall", pairingCode: () => "AB12-CD34-EF56" };
const O = { target: "/target", mirror: "file:///m", keyFile: "/run/k", dist: "/run/live/medium/schulos" };
const argvs = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: "run" }> => s.kind === "run").map((s) => s.argv.join(" "));
const paths = (steps: Step[]) => steps.filter((s) => s.kind === "write").map((s) => (s as Extract<Step, { kind: "write" }>).path);

describe("Debian-Updates (B-43)", () => {
  it("nur Debian-Quellen der laufenden Version, kein automatischer Neustart, Dienste ohne Rückfrage neu", () => {
    const u = unattendedConf();
    expect(u).toContain('"origin=Debian,codename=${distro_codename}-security,label=Debian-Security";');
    expect(u).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
    expect(u).not.toMatch(/forky|testing|unstable/);
    expect(needrestartConf()).toContain("$nrconf{restart} = 'a';");
  });

  it("Hauptsystem: Rückweg-Eintrag im Bootmenü und Prüfdienst nach dem Versionswechsel", async () => {
    const steps = updateSteps(await generate(PRODUCTION, deps, CTX), O);
    expect(paths(steps)).toEqual(
      expect.arrayContaining(["/target/etc/apt/apt.conf.d/52schulos-unattended", "/target/etc/needrestart/conf.d/schulos.conf", "/target/etc/snapper/configs/root"]),
    );
    expect(argvs(steps)).toEqual(
      expect.arrayContaining([
        "install -m 0755 /run/live/medium/schulos/grub.d/41_schulos-rueckweg /target/etc/grub.d/41_schulos-rueckweg",
        "chroot /target systemctl enable schulos-os-upgrade-pruefen.service",
        "chroot /target systemctl enable snapper-cleanup.timer",
      ]),
    );
    expect(argvs(steps).some((a) => a.includes("schulos-neustart"))).toBe(false);
  });

  it("Backupserver: eigener Neustart-Timer im eigenen Fenster, nur wenn Debian einen Neustart verlangt", async () => {
    const plan = await generate({ ...BACKUP, "updates.window": "04:00-06:00" }, deps, CTX);
    const steps = updateSteps(plan, O);
    expect(argvs(steps)).toContain("chroot /target systemctl enable schulos-neustart.timer");
    const u = backupRebootUnits("04:00-06:00");
    expect(u.timer).toContain("OnCalendar=*-*-* 04:30:00");
    expect(u.service).toContain("ConditionPathExists=/run/reboot-required");
    expect(argvs(steps).some((a) => a.includes("41_schulos-rueckweg"))).toBe(false);
  });

  it("Backupserver mit Passphrase: kein Neustart-Timer – er hinge nachts an der Eingabe (Q5-18)", async () => {
    const plan = await generate({ ...BACKUP, "disk.encryption": "passphrase", "disk.passphrase": "Platte-im-Keller-2026" }, deps, CTX);
    const steps = updateSteps(plan, O);
    expect(argvs(steps).some((a) => a.includes("schulos-neustart"))).toBe(false);
    expect(paths(steps).some((p) => p.includes("schulos-neustart"))).toBe(false);
  });
});
