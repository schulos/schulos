import { spawnSync } from "node:child_process";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { resolve } from "../answers";
import { parseArgs } from "../cli";
import { BACKUP, PRODUCTION } from "../fixtures";
import { generate } from "../generate";
import {
  CONFIGURED_FILE,
  configureScript,
  configureSteps,
  configureUnit,
  growScript,
  IMAGE_FILE,
  IMAGE_INSTALLER,
  imageFile,
  imageSteps,
  parseImageFile,
} from "./image";
import { FIRSTBOOT_ENV, PAIRING_CODE_FILE } from "./schulos-steps";
import type { Step } from "./steps";

const deps = { hashPassword, randomSecret: () => "zufall", pairingCode: () => "AB12-CD34-EF56" };
const O = {
  target: "/target",
  mirror: "file:///run/live/medium/debian",
  keyFile: "/run/k",
  dist: "/run/live/medium/schulos",
  disk: "/dev/vda",
  installer: "/usr/local/bin/schulos-installer",
  version: "1.2.0",
};
const runs = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: "run" }> => s.kind === "run");
const argvs = (steps: Step[]) => runs(steps).map((s) => s.argv.join(" "));
const writes = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: "write" }> => s.kind === "write");
const written = (steps: Step[], path: string) => writes(steps).find((s) => s.path === path)?.content;
const bashSyntax = (script: string) => {
  const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return r.status === 0 ? "ok" : r.stderr;
};
/** Abbild ohne Antworten: Rolle steht fest, Platte/Verschlüsselung entfallen */
const withoutDisk = (a: typeof PRODUCTION) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("disk."))) as typeof PRODUCTION;

describe("Abbild bauen (qcow2, B-46)", () => {
  it("eine Platte ohne LUKS, allgemeines Initramfs, growpart und Gast-Agent, keine Antworten im Abbild", () => {
    const { steps, cleanup } = imageSteps("main", O);
    const a = argvs(steps);
    expect(a).toEqual(expect.arrayContaining([expect.stringContaining("--typecode=3:8300 --change-name=3:schulos-system /dev/vda")]));
    expect(a.filter((x) => /^(cryptsetup|systemd-cryptenroll|mdadm) /.test(x))).toEqual([]);
    expect(a).toContain("mkfs.btrfs --force --label schulos /dev/vda3");
    expect(written(steps, "/target/etc/dracut.conf.d/schulos.conf")).toContain('hostonly="no"');
    expect(written(steps, "/target/etc/crypttab")).toBeUndefined();
    expect(a.find((x) => x.startsWith("chroot /target apt-get install"))).toMatch(/ cloud-guest-utils qemu-guest-agent$/);
    // nichts aus Antworten: kein Passwort, kein Hostname, keine .env, keine Erststart-Angaben
    expect(runs(steps).some((s) => s.stdin !== undefined)).toBe(false);
    for (const p of ["/target/etc/hostname", "/target/opt/schulos/.env", `/target${FIRSTBOOT_ENV}`, `/target${CONFIGURED_FILE}`]) expect(written(steps, p)).toBeUndefined();
    expect(written(steps, "/target/etc/systemd/network/10-schulos.network")).toContain("DHCP=yes");
    // Rollenteil wie bei der ISO: Compose, schulosctl, Timer, Images, Erststart
    expect(a).toContain("cp /run/live/medium/schulos/compose.yaml /target/opt/schulos/compose.yaml");
    expect(a).toContain('sh -c [ ! -f "$1" ] || install -D -m 0644 "$1" "$2" sh /run/live/medium/schulos/STUECKLISTE.json /target/usr/share/doc/schulos/stueckliste.json');
    expect(a).toContain("chroot /target systemctl enable schulos-sync.timer schulos-wartung.timer schulos-vorschau.timer");
    expect(a).toContain("chroot /target grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --no-nvram --uefi-secure-boot --bootloader-id=schulos");
    // Einrichtung beim ersten Start
    expect(a).toContain(`install -D -m 0755 /usr/local/bin/schulos-installer /target${IMAGE_INSTALLER}`);
    expect(parseImageFile(written(steps, `/target${IMAGE_FILE}`)!)).toEqual({ role: "main", version: "1.2.0" });
    expect(a).toContain("chroot /target systemctl enable schulos-konfigurieren.service schulos-wachsen.service");
    // jede Kopie eigene Host-Schlüssel und machine-id; SSH erst nach der Einrichtung
    expect(a).toContain("chroot /target systemctl disable ssh");
    expect(a.indexOf("chroot /target systemctl disable ssh")).toBeGreaterThan(a.indexOf("chroot /target systemctl enable docker schulos-erststart.service schulos-konsole.service"));
    expect(a).toContain('sh -c rm -f "$1"/etc/ssh/ssh_host_* sh /target');
    expect(a).toEqual(expect.arrayContaining([expect.stringMatching(/^sh -c : > "\$1\/etc\/machine-id".* sh \/target$/)]));
    expect(a.at(-1)).toBe("fstrim --verbose /target/boot");
    expect(argvs(cleanup)).toEqual(["sh -c sync; umount --recursive \"$1\" || umount --recursive --lazy \"$1\" _ /target"]);
  });

  it("Backupserver: Compose des Backupservers, ohne schulosctl", () => {
    const a = argvs(imageSteps("backup", O).steps);
    expect(a).toContain("cp /run/live/medium/schulos/compose.backup.yaml /target/opt/schulos-backup/compose.yaml");
    expect(a.filter((x) => x.includes("schulosctl"))).toEqual([]);
    expect(a.filter((x) => x.includes("schulos-neustart.timer"))).toEqual([]);
  });

  it("Skripte und Dienste", () => {
    expect(bashSyntax(configureScript())).toBe("ok");
    expect(bashSyntax(growScript())).toBe("ok");
    expect(configureScript()).toContain("blkid -L \"$label\"");
    expect(configureScript()).toMatch(/--antworten "\$ANS" --unbeaufsichtigt/);
    expect(configureUnit()).toMatch(/^Before=docker\.service schulos-erststart\.service/m);
    expect(configureUnit()).toContain(`ConditionPathExists=!${CONFIGURED_FILE}`);
    expect(imageFile("backup", "dev")).toBe("ROLE=backup\nVERSION=dev\n");
    expect(parseImageFile("ROLE=x\n")).toBeNull();
  });

  it("Aufruf", () => {
    expect(parseArgs(["--abbild", "backup", "--testmodus"])).toMatchObject({ image: "backup", configure: false, install: false });
    // INST-07: Abbild bauen löscht die einzige Platte – nur im CI-Testmodus
    expect(() => parseArgs(["--abbild", "backup"])).toThrow(/CI-Testmodus/);
    expect(parseArgs(["--konfigurieren", "--antworten", "/run/c/user-data", "--unbeaufsichtigt"])).toMatchObject({ configure: true, unattended: true });
    expect(() => parseArgs(["--abbild", "demo"])).toThrow(/main oder/);
    expect(() => parseArgs(["--abbild", "main", "--antworten", "a.yaml", "--testmodus"])).toThrow();
    expect(() => parseArgs(["--konfigurieren", "--installieren"])).toThrow();
  });
});

describe("Abbild einrichten (erster Start)", () => {
  it("Antworten: Rolle aus dem Abbild, keine Platte, falsche Rolle abgelehnt", () => {
    const r = resolve(Object.fromEntries(Object.entries(withoutDisk(PRODUCTION)).filter(([k]) => k !== "role")), { image: "main" });
    expect(r.missing).toEqual([]);
    expect(r.answers.role).toBe("main");
    expect(Object.keys(r.answers).filter((k) => k.startsWith("disk."))).toEqual([]);
    expect(resolve(BACKUP, { image: "main" }).errors).toContainEqual({ id: "role", message: expect.stringContaining("Hauptsystem") });
  });

  it("Hauptsystem: ohne chroot und Platte, Angaben + Stack + Erststart, dann anwenden", async () => {
    const plan = await generate(withoutDisk(PRODUCTION), deps, { image: "main" });
    const steps = configureSteps(plan);
    const a = argvs(steps);
    expect(a[0]).toBe("ssh-keygen -A");
    expect(a.filter((x) => /^(chroot|mkfs|sgdisk|debootstrap|grub-install|dracut)/.test(x))).toEqual([]);
    expect(written(steps, "/etc/hostname")).toBe("schulos\n");
    expect(runs(steps).find((s) => s.argv[0] === "chpasswd")!.stdin).toBe("schulos-admin:Wartung-im-Keller-2026\n");
    expect(written(steps, "/opt/schulos/.env")).toContain("SCHULOS_DOMAIN=schulos.gs-musterstadt.de");
    expect(a).toContain('sh -c cat "$1" >> "$2" sh /usr/local/lib/schulos/images.env /opt/schulos/.env');
    expect(written(steps, FIRSTBOOT_ENV)).toContain("PAIR_URL='https://backup.gs-musterstadt.de'");
    expect(a).toContain("update-grub");
    expect(a).toContain("systemctl restart systemd-networkd");
    expect(a).toContain("systemctl try-restart --no-block schulos-wartung.timer");
    expect(written(steps, PAIRING_CODE_FILE)).toBeUndefined();
    // zuletzt: eingerichtet – vorher darf nichts scheitern, sonst läuft die Einrichtung beim nächsten Start erneut
    expect(steps.at(-1)).toMatchObject({ kind: "write", path: CONFIGURED_FILE });
    // GATE-4f C-03: eingerichtet = fertig installiert – das Startmenü eines Mediums startet dann die Platte
    expect(steps.at(-2)).toMatchObject({ kind: "write", path: "/boot/grub/schulos-installiert" });
    // INST-08: auch auf der EFI-Partition – das Startmenü eines Mediums startet unter UEFI die GRUB der Platte
    expect(steps.at(-3)).toMatchObject({ kind: "write", path: "/boot/efi/EFI/schulos/installiert" });
  });

  it("Backupserver: Kopplungscode für die Konsole (0600), Neustart-Timer im Wartungsfenster", async () => {
    const plan = await generate(withoutDisk(BACKUP), deps, { image: "backup" });
    const steps = configureSteps(plan);
    expect(writes(steps).find((s) => s.path === PAIRING_CODE_FILE)).toMatchObject({ content: "AB12-CD34-EF56\n", mode: 0o600 });
    expect(written(steps, "/etc/systemd/system/schulos-neustart.timer")).toContain("OnCalendar=");
    expect(argvs(steps)).toContain("systemctl start --no-block schulos-neustart.timer");
    expect(argvs(steps).filter((x) => x.includes("start --no-block ssh"))).toEqual([]);
  });
});
