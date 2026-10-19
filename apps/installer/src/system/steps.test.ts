import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InstallPlan } from "../generate";
import type { Answers } from "../questions";
import { ESP_MARKER, INSTALLED_MARKER, layout, partition } from "./layout";
import { extractRecoveryKey } from "./run";
import { installSteps, type Step } from "./steps";
import { consoleSetupFile, crypttab, dracutConf, fstab, keyboardFile, networkFile, sshdConf } from "./target-config";

const O = { target: "/target", mirror: "file:///run/live/medium/debian", keyFile: "/run/schulos-installer/startschluessel" };

function plan(system: Answers): InstallPlan {
  return { role: "main", stackDir: "/opt/schulos", composeSource: "compose.yaml", files: [], system: { "access.password": "Wartung-im-Keller-2026", ...system } };
}
const runs = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: "run" }> => s.kind === "run");
const argvs = (steps: Step[]) => runs(steps).map((s) => s.argv.join(" "));
const written = (steps: Step[], path: string) => (steps.find((s) => s.kind === "write" && s.path === path) as Extract<Step, { kind: "write" }> | undefined)?.content;

describe("Plattenaufteilung", () => {
  it("Partitionsnamen je Gerätetyp", () => {
    expect(partition("/dev/sda", 2)).toBe("/dev/sda2");
    expect(partition("/dev/nvme0n1", 1)).toBe("/dev/nvme0n1p1");
    expect(partition("/dev/loop3", 2)).toBe("/dev/loop3p2");
    expect(partition("/dev/disk/by-id/ata-WDC_WD20", 1)).toBe("/dev/disk/by-id/ata-WDC_WD20-part1");
  });

  it("eine Platte: Partition direkt, LUKS über das Partitions-Label; zwei Platten: md-Spiegel, zwei EFI-Partitionen", () => {
    expect(layout(["/dev/sda"], "passphrase")).toMatchObject({
      esps: [{ device: "/dev/sda1", label: "EFI", mount: "/boot/efi" }],
      md: null,
      base: "/dev/sda3",
      baseStable: "/dev/disk/by-partlabel/schulos-system",
      root: "/dev/mapper/schulos-root",
    });
    expect(layout(["/dev/sda", "/dev/sdb"], "tpm2")).toMatchObject({
      esps: [{ label: "EFI" }, { device: "/dev/sdb1", label: "EFI2", mount: "/boot/efi2" }],
      parts: ["/dev/sda3", "/dev/sdb3"],
      md: "/dev/md/schulos",
      base: "/dev/md/schulos",
      baseStable: "/dev/md/schulos",
    });
    expect(layout(["/dev/vda"], "none").root).toBe("/dev/vda3");
    expect(() => layout([], "none")).toThrow();
  });
});

describe("Systemschritte", () => {
  it("Hauptsystem, eine Platte, Passphrase: Reihenfolge, Geheimnisse nur auf stdin", () => {
    const { steps, cleanup } = installSteps(plan({ "disk.devices": ["/dev/nvme0n1"], "disk.encryption": "passphrase", "disk.passphrase": "Platte-im-Keller-2026", "network.hostname": "schulos" }), O);
    const a = argvs(steps);
    expect(a[0]).toBe("mkdir -p /target");
    expect(a.slice(1, 4)).toEqual(["wipefs --all --force /dev/nvme0n1", "sgdisk --zap-all /dev/nvme0n1", expect.stringContaining("--typecode=3:8309 --change-name=3:schulos-system /dev/nvme0n1")]);
    expect(a).toContain("mkfs.vfat -F 32 -n EFI /dev/nvme0n1p1");
    expect(a).toContain("cryptsetup luksFormat --type luks2 --batch-mode --key-file=- /dev/nvme0n1p3");
    // /boot unverschlüsselt (GRUB kann LUKS2/Argon2 nicht öffnen): eigene ext4-Partition, vor den EFI-Partitionen eingehängt
    expect(a).toContain("mkfs.ext4 -F -q -L schulos-boot /dev/nvme0n1p2");
    expect(a.indexOf("mount /dev/nvme0n1p2 /target/boot")).toBeLessThan(a.indexOf("mount /dev/nvme0n1p1 /target/boot/efi"));
    expect(written(steps, "/target/etc/fstab")).toMatch(/^LABEL=schulos-boot {2}\/boot +ext4/m);
    expect(a).toContain("mkfs.btrfs --force --label schulos /dev/mapper/schulos-root");
    expect(a).toContain("btrfs subvolume create /target/@srv");
    expect(a).toContain("mount -o subvol=@srv,compress=zstd:1,noatime /dev/mapper/schulos-root /target/srv");
    const debootstrap = a.find((x) => x.startsWith("debootstrap"))!;
    expect(debootstrap).toMatch(/--include=grub-efi-amd64,.*btrfs-progs.* trixie \/target file:\/\/\/run\/live\/medium\/debian$/);
    // Kernel + dracut erst per apt (debootstrap würde initramfs-tools daneben installieren), aus derselben Quelle
    expect(debootstrap).not.toMatch(/dracut|linux-image/);
    expect(written(steps, "/target/etc/apt/sources.list")).toBe("deb [trusted=yes] file:///run/live/medium/debian trixie main\n");
    expect(a).toContain("chroot /target apt-get install --yes --no-install-recommends dracut linux-image-amd64 firmware-linux-free systemd-resolved shim-signed grub-efi-amd64-signed nftables docker.io docker-cli docker-compose apparmor openssh-client unattended-upgrades needrestart snapper");
    expect(a.indexOf("chroot /target apt-get install --yes --no-install-recommends dracut linux-image-amd64 firmware-linux-free systemd-resolved shim-signed grub-efi-amd64-signed nftables docker.io docker-cli docker-compose apparmor openssh-client unattended-upgrades needrestart snapper")).toBeLessThan(
      a.indexOf("rm -f /target/etc/apt/sources.list"),
    );
    expect(a).toContain("chroot /target grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --no-nvram --uefi-secure-boot --bootloader-id=schulos");
    expect(a.indexOf("chroot /target dracut --regenerate-all --force")).toBeLessThan(a.indexOf("chroot /target update-grub"));
    // Geheimnisse nie in argv bzw. Dateien
    for (const x of [...a, ...steps.map((s) => (s.kind === "write" ? s.content : ""))]) expect(x).not.toMatch(/Platte-im-Keller|Wartung-im-Keller/);
    expect(runs(steps).filter((s) => s.stdin?.includes("Platte-im-Keller-2026"))).toHaveLength(2);
    expect(runs(steps).find((s) => s.argv.includes("chpasswd"))!.stdin).toBe("schulos-admin:Wartung-im-Keller-2026\n");
    expect(written(steps, "/target/etc/crypttab")).toBe("# SchulOS – Passphrase beim Start\nschulos-root /dev/disk/by-partlabel/schulos-system none luks,discard\n");
    expect(argvs(cleanup)).toEqual(["sh -c sync; umount --recursive \"$1\" || umount --recursive --lazy \"$1\" _ /target", "cryptsetup close schulos-root"]);
    expect(a).not.toContain(expect.stringContaining("mdadm"));
    expect(a).toContain("chroot /target systemctl disable ssh");
  });

  it("Backupserver, zwei Platten, TPM2: Spiegel, Startschlüssel nur bis TPM2 und Wiederherstellungsschlüssel stehen, Bootloader auf beiden", () => {
    const { steps, cleanup } = installSteps(plan({ role: "backup", "disk.devices": ["/dev/sda", "/dev/sdb"], "disk.encryption": "tpm2", "access.ssh": true, "access.ssh_keys": ["ssh-ed25519 AAAA it@pc"] }), O);
    const a = argvs(steps);
    expect(a).toContain("mdadm --create /dev/md/schulos --name schulos --level=1 --raid-devices=2 --metadata=1.2 --run /dev/sda3 /dev/sdb3");
    expect(a).toContain("mdadm --create /dev/md/schulos-boot --name schulos-boot --level=1 --raid-devices=2 --metadata=1.2 --run /dev/sda2 /dev/sdb2");
    expect(a).toContain("mkfs.ext4 -F -q -L schulos-boot /dev/md/schulos-boot");
    const order = [
      "cryptsetup luksFormat --type luks2 --batch-mode --key-file=/run/schulos-installer/startschluessel /dev/md/schulos",
      "systemd-cryptenroll --unlock-key-file=/run/schulos-installer/startschluessel --tpm2-device=auto --tpm2-pcrs=7 /dev/md/schulos",
      "systemd-cryptenroll --unlock-key-file=/run/schulos-installer/startschluessel --recovery-key /dev/md/schulos",
      "cryptsetup open --key-file=/run/schulos-installer/startschluessel /dev/md/schulos schulos-root",
      "systemd-cryptenroll --wipe-slot=0 --unlock-key-file=/run/schulos-installer/startschluessel /dev/md/schulos",
      "shred --remove /run/schulos-installer/startschluessel",
    ].map((x) => a.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(runs(steps).find((s) => s.argv.includes("--recovery-key"))!.capture).toBe("recoveryKey");
    expect(a.filter((x) => x.includes("grub-install"))).toEqual([
      expect.stringContaining("--efi-directory=/boot/efi "),
      expect.stringContaining("--efi-directory=/boot/efi2 "),
    ]);
    expect(a).toContain("chroot /target sh -c sed -i '/^ARRAY /d' /etc/mdadm/mdadm.conf && mdadm --detail --scan >> /etc/mdadm/mdadm.conf");
    // Spiegel beim Start ausdrücklich zusammensetzen (rd.md.uuid), bevor das Bootmenü entsteht
    const raid = a.findIndex((x) => x.includes("rd.md.uuid=") && x.includes("/etc/default/grub.d/zz-schulos-raid.cfg"));
    expect(raid).toBeGreaterThan(-1);
    expect(raid).toBeLessThan(a.indexOf("chroot /target update-grub"));
    expect(written(steps, "/target/etc/crypttab")).toContain("schulos-root /dev/md/schulos none luks,discard,tpm2-device=auto");
    expect(written(steps, "/target/home/schulos-admin/.ssh/authorized_keys")).toBe("ssh-ed25519 AAAA it@pc\n");
    expect(a).toContain("chroot /target systemctl enable ssh");
    expect(argvs(cleanup)).toEqual(expect.arrayContaining(["mdadm --stop /dev/md/schulos", "mdadm --stop /dev/md/schulos-boot"]));
  });

  it("Demo ohne Verschlüsselung: keine LUKS-Schritte, Partitionstyp Linux, keine crypttab", () => {
    const { steps } = installSteps(plan({ "disk.devices": ["/dev/vda"], "disk.encryption": "none" }), O);
    expect(argvs(steps).some((x) => /^(cryptsetup|systemd-cryptenroll) /.test(x))).toBe(false);
    expect(argvs(steps)).toContain("mkfs.btrfs --force --label schulos /dev/vda3");
    expect(argvs(steps)[3]).toContain("--typecode=3:8300");
    expect(written(steps, "/target/etc/crypttab")).toBeUndefined();
  });

  it("Proxy für apt, statisches Netz", () => {
    const { steps } = installSteps(
      plan({ "disk.devices": ["/dev/vda"], "disk.encryption": "none", "network.proxy": "http://proxy:3128", "network.mode": "static", "network.address": "10.0.0.5/24", "network.gateway": "10.0.0.1", "network.dns": ["10.0.0.1", "1.1.1.1"] }),
      O,
    );
    expect(written(steps, "/target/etc/apt/apt.conf.d/90schulos-proxy")).toContain('Acquire::http::Proxy "http://proxy:3128";');
    expect(written(steps, "/target/etc/systemd/network/10-schulos.network")).toContain("Address=10.0.0.5/24\nGateway=10.0.0.1\nDNS=10.0.0.1\nDNS=1.1.1.1\n");
  });
});

describe("Konfigurationsdateien", () => {
  it("fstab: Subvolumes per Label, EFI-Partitionen dürfen fehlen", () => {
    const f = fstab(layout(["/dev/sda", "/dev/sdb"], "tpm2"));
    expect(f).toMatch(/^LABEL=schulos {2}\/ +btrfs {2}subvol=@,noatime,compress=zstd:1 {2}0 0$/m);
    expect(f).toMatch(/^LABEL=schulos {2}\/srv +btrfs {2}subvol=@srv,/m);
    expect(f).toMatch(/^PARTLABEL=EFI2 {2}\/boot\/efi2 +vfat {3}umask=0077,nofail/m);
  });

  it("crypttab/dracut je Verschlüsselung, Tastatur, Netz, SSH", () => {
    expect(crypttab(layout(["/dev/sda"], "none"))).toBeNull();
    expect(dracutConf(layout(["/dev/sda", "/dev/sdb"], "tpm2"))).toContain('add_dracutmodules+=" btrfs mdraid crypt systemd-cryptsetup tpm2-tss "');
    expect(dracutConf(layout(["/dev/sda"], "none"))).toContain('add_dracutmodules+=" btrfs "');
    expect(keyboardFile("de-nodeadkeys")).toContain('XKBLAYOUT="de"\nXKBVARIANT="nodeadkeys"');
    const cs = consoleSetupFile();
    expect(cs).toContain('CHARMAP="UTF-8"');
    expect(cs).toContain('CODESET="Uni2"');
    expect(cs).toContain('FONTFACE="TerminusBold"');
    expect(cs).toContain('FONTSIZE="16"');
    expect(networkFile({ "network.mode": "dhcp" })).toContain("DHCP=yes");
    expect(sshdConf({ "access.ssh_keys": ["k"] })).toContain("PasswordAuthentication no");
    expect(sshdConf({})).toContain("PasswordAuthentication yes");
  });

  it("Wiederherstellungsschlüssel aus der Ausgabe von systemd-cryptenroll", () => {
    const out = "A secret recovery key has been generated for this volume:\n\n    🔐 fvhkbbdg-nnctbgrl-jtrgtvif-ceubtfcb-dlgbvdec-ckdhbgnh-hcteduvg-knnvcrtj\n\nPlease save this secret recovery key at a secure location.\n";
    expect(extractRecoveryKey(out)).toBe("fvhkbbdg-nnctbgrl-jtrgtvif-ceubtfcb-dlgbvdec-ckdhbgnh-hcteduvg-knnvcrtj");
    expect(extractRecoveryKey("nichts")).toBeNull();
  });
});

describe("Startmenü des Mediums erkennt nur fertige Installationen (GATE-4f C-03/C-04)", () => {
  it("die Markierung ist der letzte Installationsschritt – nach Bootloader, Stack und Updates", () => {
    for (const devices of [["/dev/vda"], ["/dev/vda", "/dev/vdb"]]) {
      const { steps } = installSteps(plan({ "disk.devices": devices, "disk.encryption": "tpm2" }), { ...O, dist: "/run/live/medium/schulos" });
      expect(steps.at(-2)).toMatchObject({ kind: "write", path: `/target/boot/${INSTALLED_MARKER}` });
      // danach /boot ausschreiben (GRUB liest das ext4-Journal nicht)
      expect(steps.at(-1)).toMatchObject({ kind: "run", argv: expect.arrayContaining(["/target/boot"]) });
      expect(argvs(steps).at(-1)).toContain("fsfreeze --freeze");
      expect(steps.filter((s) => s.kind === "write" && s.path.endsWith(INSTALLED_MARKER))).toHaveLength(1);
      // INST-06: Rolle, Version, Datum für die Rückfrage des Überschreibschutzes
      const marked = installSteps(plan({ "disk.devices": devices, "disk.encryption": "tpm2" }), { ...O, marker: { version: "v0.3.2", date: "2026-10-12" } });
      expect(written(marked.steps, `/target/boot/${INSTALLED_MARKER}`)).toBe("SchulOS ist installiert.\nrolle=main\nversion=v0.3.2\ndatum=2026-10-12\n");
      expect(argvs(steps).findIndex((a) => a.includes("update-grub"))).toBeGreaterThan(-1);
      // INST-08: dieselbe Markierung auf jeder EFI-Partition, direkt vor der auf /boot (also auch erst ganz am Ende)
      const esp = devices.map((_, i) => `/target/boot/efi${i ? i + 1 : ""}/${ESP_MARKER}`);
      expect(steps.slice(-2 - devices.length, -2).map((s) => (s.kind === "write" ? s.path : s.kind))).toEqual(esp);
      for (const p of esp) expect(written(marked.steps, p)).toBe("SchulOS ist installiert.\nrolle=main\nversion=v0.3.2\ndatum=2026-10-12\n");
    }
  });

  it("ISO-GRUB: sucht die Markierung (nicht die Bezeichnung), lädt mdraid1x vorher, Platte nur ohne Antworten-Laufwerk als Vorgabe", () => {
    const cfg = readFileSync(path.resolve(__dirname, "../../../../iso/live/config/bootloaders/grub-pc/grub.cfg"), "utf8");
    const at = (needle: string) => {
      const i = cfg.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(at(`search --no-floppy --file /${INSTALLED_MARKER} --set=schulos_boot`)).toBeGreaterThan(at("insmod mdraid1x"));
    expect(cfg).not.toMatch(/search[^\n]*--label schulos-boot/);
    // Vorgabe erst ganz am Ende: Installer, außer fertig installiert UND kein SCHULOSCFG/schulos.unbeaufsichtigt
    const tailCfg = cfg.slice(at("set default=schulos-installieren"));
    expect(tailCfg).toMatch(/if \[ -n "\$\{schulos_installiert\}" \]; then\s+if \[ -z "\$\{schulos_antworten\}" \]; then\s+set default=schulos-platte/);
    expect(at("search --no-floppy --label SCHULOSCFG --set=schulos_antworten")).toBeLessThan(at("set default=schulos-installieren"));
    expect(cfg).toContain("regexp 'schulos\\.unbeaufsichtigt'");
    expect(cfg).toContain('menuentry "SchulOS installieren" --id schulos-installieren');
    expect(cfg).toContain('--id schulos-platte');
  });

  it("ISO-GRUB unter Secure Boot (INST-08): Markierung auf der EFI-Partition, GRUB der Platte per chainloader, mdraid nur ohne Sperre", () => {
    const cfg = readFileSync(path.resolve(__dirname, "../../../../iso/live/config/bootloaders/grub-pc/grub.cfg"), "utf8");
    expect(cfg).toContain(`search --no-floppy --file /${ESP_MARKER} --set=schulos_esp`);
    // nur unter UEFI; zuerst die GRUB der Platte (PCR 7 wie ohne Medium), der shim nur als Rückfall
    expect(cfg).toMatch(/if \[ "\$\{grub_platform\}" = "efi" \]; then\s+if \[ -n "\$\{schulos_esp\}" \]; then\s+set schulos_installiert=esp/);
    const entry = cfg.slice(cfg.indexOf('if [ "${schulos_installiert}" = "esp" ]'), cfg.indexOf("elif [ -n \"${schulos_boot}\" ]"));
    expect(entry).toContain('set root="${schulos_esp}"');
    expect(entry.indexOf("chainloader /EFI/BOOT/grubx64.efi")).toBeGreaterThan(-1);
    expect(entry.indexOf("chainloader /EFI/BOOT/BOOTX64.EFI")).toBeGreaterThan(entry.indexOf("chainloader /EFI/BOOT/grubx64.efi"));
    // alter Weg (BIOS, Installationen ohne Markierung auf der EFI-Partition) bleibt
    expect(cfg).toMatch(/elif \[ -n "\$\{schulos_boot\}" \]; then\s+set schulos_installiert=boot/);
    expect(cfg).toContain("configfile /grub/grub.cfg");
    // Module nachladen ist unter Secure Boot verboten – nur ohne Sperre versuchen (sonst je eine Fehlermeldung)
    expect(cfg).toMatch(/if \[ "\$\{lockdown\}" != "y" \]; then\s+insmod mdraid1x\s+insmod mdraid09\s+fi/);
  });
});
