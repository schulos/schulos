// INST-07: unbeaufsichtigte Installation nur im CI-Testmodus (Kernel-Parameter schulos.testmodus + Laufwerk SCHULOSCFG).
// Geprüft wird der Aufruf (cli.ts), start-installer.sh (statisch), die Test-Kopie der ISO (awk aus iso/testmodus-iso.sh auf das
// echte Bootmenü) und die Kennzeichnung im Abschluss. Der echte Start mit und ohne Parameter läuft in scripts/qemu-test.sh (Schritt 0).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finalScreen, summaryText, TEST_INSTALL_NOTE } from "./abschluss";
import { parseArgs, UsageError } from "./cli";

const ROOT = path.resolve(__dirname, "../../..");
const START = readFileSync(
  path.join(
    ROOT,
    "iso/live/config/includes.chroot/usr/local/lib/schulos/start-installer.sh",
  ),
  "utf8",
);
const REMASTER = readFileSync(path.join(ROOT, "iso/testmodus-iso.sh"), "utf8");
const GRUB = readFileSync(
  path.join(ROOT, "iso/live/config/bootloaders/grub-pc/grub.cfg"),
  "utf8",
);
const BUILD = readFileSync(path.join(ROOT, "iso/build.sh"), "utf8");

/** Bootmenü wie nach live-build (Platzhalter ersetzt) */
const BUILT_GRUB = GRUB.replaceAll("@KERNEL_LIVE@", "/live/vmlinuz")
  .replaceAll("@INITRD_LIVE@", "/live/initrd.img")
  .replaceAll(
    "@APPEND_LIVE@",
    "boot=live components quiet console=ttyS0,115200 console=tty0",
  )
  .replaceAll(
    "@APPEND_VERIFY_CHECKSUMS@",
    "boot=live components verify-checksums",
  );

describe("INST-07: Aufruf nur im Testmodus", () => {
  it("unbeaufsichtigt installieren, ohne Bestätigung und Abbild nur mit --testmodus", () => {
    const base = [
      "--antworten",
      "a.yaml",
      "--unbeaufsichtigt",
      "--installieren",
    ];
    expect(() => parseArgs(base)).toThrow(UsageError);
    expect(() => parseArgs(base)).toThrow(/CI-Testmodus/);
    expect(
      parseArgs([...base, "--testmodus", "--vorschau-verstanden"]),
    ).toMatchObject({
      unattended: true,
      install: true,
      testMode: true,
    });
    // REPO-03: auch im Testmodus nur mit bestätigtem Vorschau-Hinweis
    expect(() => parseArgs([...base, "--testmodus"])).toThrow(
      /Vorschau-Hinweis nicht bestätigt/,
    );
    expect(() =>
      parseArgs([
        "--antworten",
        "a.yaml",
        "--unbeaufsichtigt",
        "--ohne-bestaetigung",
      ]),
    ).toThrow(/CI-Testmodus/);
    expect(() => parseArgs(["--abbild", "main"])).toThrow(/CI-Testmodus/);
    // Plan schreiben (ohne Installation) und Abbild einrichten (Cloud-Init) bleiben ohne Testmodus möglich
    expect(
      parseArgs(["--antworten", "a.yaml", "--unbeaufsichtigt"]),
    ).toMatchObject({ unattended: true, install: false, testMode: false });
    expect(
      parseArgs(["--konfigurieren", "--antworten", "u", "--unbeaufsichtigt"]),
    ).toMatchObject({ configure: true, testMode: false });
    // REPO-03: Hinweis per Datei bestätigen nur im Testmodus
    expect(() => parseArgs(["--vorschau-verstanden"])).toThrow(/CI-Testmodus/);
    expect(
      parseArgs([...base, "--testmodus", "--vorschau-verstanden"]),
    ).toMatchObject({ previewAccepted: true });
  });
});

describe("INST-07: start-installer.sh", () => {
  it("Testmodus nur aus der Kernel-Zeile und nur mit SCHULOSCFG, nie aus einer Datei", () => {
    expect(START).toContain(
      'grep -qw "schulos.testmodus" /proc/cmdline && [ -n "$dev" ] && TESTMODUS=1',
    );
    expect(START).not.toMatch(/flag testmodus|\$CFG\/testmodus/);
  });

  it("alle Test-Schalter stehen im Testmodus-Zweig; sonst Hinweis und Oberfläche", () => {
    const branch = START.slice(
      START.indexOf('if [ "$TESTMODUS" = 1 ]; then'),
      START.indexOf("elif flag unbeaufsichtigt"),
    );
    for (const a of [
      "--unbeaufsichtigt",
      "--ohne-bestaetigung",
      "--ueberschreiben",
      "--vorschau-verstanden",
      "--abbild",
      "--testmodus",
    ]) {
      expect(branch, a).toContain(`(${a}`);
      // außerhalb des Zweigs setzt niemand den Schalter
      expect(START.replace(branch, ""), a).not.toContain(`ARGS+=(${a}`);
    }
    expect(START).toContain('serial "kein-testmodus');
    // Q-4E-60: TPM2 ohne Secure Boot nur im Testmodus – die Variable setzt nur der Testmodus-Zweig
    expect(branch).toContain("export SCHULOS_TESTMODUS=1");
    expect(START.replace(branch, "")).not.toContain("SCHULOS_TESTMODUS=1");
    expect(START).toContain(
      "test_flag seriell-geheimnisse && export SCHULOS_SERIELL_GEHEIMNISSE=1",
    );
    expect(START).toContain(
      "if test_flag seriell-geheimnisse; then cat; return; fi",
    );
    expect(START).not.toMatch(/^flag seriell-geheimnisse/m);
  });
});

const awk = spawnSync("awk", ["BEGIN { exit 0 }"]).status === 0;
describe("INST-07: Test-Kopie der ISO", () => {
  it.skipIf(!awk)(
    "setzt schulos.testmodus nur im Eintrag „SchulOS installieren“ – das Startmenü wählt weiter die Platte",
    () => {
      // Gate-Lauf 3: stand der Parameter auch in schulos_kernel, war der Installer immer die Vorgabe (Backupserver startete
      // mit eingelegtem Medium nicht von der Platte) – Vorgabe hängt nur am Laufwerk SCHULOSCFG bzw. schulos.unbeaufsichtigt
      expect(GRUB).not.toMatch(/regexp '[^']*testmodus/);
      const prog = /awk '\n([\s\S]*?)\n' "\$T\/grub\.cfg"/.exec(REMASTER)?.[1];
      expect(prog).toBeTruthy();
      const r = spawnSync("awk", [prog!], {
        input: BUILT_GRUB,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const lines = r.stdout.split("\n");
      const hits = lines.filter((l) => /schulos\.testmodus/.test(l));
      expect(hits).toHaveLength(1);
      expect(lines.find((l) => l.startsWith("set schulos_kernel="))).not.toContain("testmodus");
      expect(hits[0]).toMatch(
        /^\s*linux\s+\/live\/vmlinuz boot=live .* schulos\.testmodus$/,
      );
      expect(lines.find((l) => l.includes("verify-checksums"))).not.toContain(
        "testmodus",
      );
      // die Bauprüfung (iso/build.sh) erkennt genau das – und lässt die gebaute ISO durch
      const guard = new RegExp(
        /grep -qE '([^']+)' "\$WORK\/grub\.cfg"/
          .exec(BUILD)![1]!
          .replaceAll("[[:space:]]", "\\s"),
        "m",
      );
      expect(guard.test(r.stdout)).toBe(true);
      expect(guard.test(BUILT_GRUB)).toBe(false);
    },
  );
});

describe("INST-07: Abschluss als TESTINSTALLATION", () => {
  it("Zeilen und Bildschirm tragen die Kennzeichnung nur im Testmodus", () => {
    expect(TEST_INSTALL_NOTE).toMatch(/^TESTINSTALLATION/);
    expect(summaryText(null, null, true)).toContain("TESTINSTALLATION");
    expect(summaryText(null, null)).not.toContain("TESTINSTALLATION");
    const boot = { ok: true as const, order: ["0001"] };
    expect(finalScreen(boot, null, null, true).lines.join("\n")).toContain(
      "TESTINSTALLATION",
    );
    expect(finalScreen(boot, null).lines.join("\n")).not.toContain(
      "TESTINSTALLATION",
    );
  });
});
