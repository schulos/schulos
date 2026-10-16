import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_STATUS_SCRIPT,
  HOST_STATUS_TIMER,
  hostAlarms,
  hostStatusStale,
  hostTpmProblems,
  parseHostStatus,
  pendingPassphraseReboot,
} from "./host-status";

const now = new Date("2026-10-14T10:00:00Z");
const status = (o: Record<string, unknown>) =>
  JSON.stringify({
    version: 1,
    rebootRequired: false,
    passphrase: false,
    since: null,
    checkedAt: "2026-10-14T09:55:00Z",
    ...o,
  });

describe("SEC-14: Host-Status des Backupservers (Neustart nötig, Passphrase)", () => {
  it("Datei lesen: nur bekannte Felder, Unsinn → null", () => {
    expect(
      parseHostStatus(
        status({
          rebootRequired: true,
          passphrase: true,
          since: "2026-10-12T02:00:00Z",
        }),
      ),
    ).toEqual({
      rebootRequired: true,
      passphrase: true,
      since: "2026-10-12T02:00:00.000Z",
      checkedAt: "2026-10-14T09:55:00.000Z",
      tpm: null,
    });
    // G4E-O03: TPM-Teil nur mit bekannten Feldern
    expect(
      parseHostStatus(
        status({
          tpm: { secureBoot: true, markerSince: null, bootedAt: "2026-10-14T08:00:00Z", error: true, efiChanged: false, pcrSets: ["7+8+9", "x;y"] },
        }),
      )!.tpm,
    ).toEqual({
      mode: "tpm2",
      secureBoot: true,
      markerSince: null,
      bootedAt: "2026-10-14T08:00:00.000Z",
      error: expect.stringContaining("journalctl -t schulos-tpm"),
      efiChanged: false,
      pcrSets: ["7+8+9"],
    });
    expect(parseHostStatus("kaputt")).toBeNull();
    expect(parseHostStatus(JSON.stringify({ version: 2 }))).toBeNull();
  });

  it("Alarm nur mit Neustart UND Passphrase; ab 14 Tagen dringend, gleiche Kennung", () => {
    expect(
      hostAlarms(parseHostStatus(status({ rebootRequired: true })), now),
    ).toEqual([]);
    expect(
      hostAlarms(parseHostStatus(status({ passphrase: true })), now),
    ).toEqual([]);
    const s = parseHostStatus(
      status({
        rebootRequired: true,
        passphrase: true,
        since: "2026-10-12T02:00:00Z",
      }),
    );
    expect(pendingPassphraseReboot(s, now)).toBe(2);
    expect(hostAlarms(s, now)[0]).toMatchObject({
      key: "neustart",
      title: "Neustart nötig – Passphrase erforderlich",
    });
    expect(hostAlarms(s, new Date("2026-10-27T10:00:00Z"))[0]).toMatchObject({
      key: "neustart",
      title: "Neustart seit 15 Tagen überfällig – Passphrase erforderlich",
    });
    expect(hostAlarms(null, now)).toEqual([]);
  });

  it("G4E-O15: Status älter als 1 h → Alarm „veraltet“; G4E-O03: TPM-Probleme → Alarm, shim-Update braucht einen Menschen", () => {
    const old = parseHostStatus(status({ checkedAt: "2026-10-14T08:30:00Z" }));
    expect(hostStatusStale(old, now)).toBe(true);
    expect(hostAlarms(old, now).map((a) => a.key)).toEqual(["hoststatus"]);
    expect(hostStatusStale(parseHostStatus(status({})), now)).toBe(false);
    const tpm = (o: Record<string, unknown>) =>
      parseHostStatus(status({ tpm: { secureBoot: true, markerSince: null, bootedAt: "2026-10-14T08:00:00Z", error: false, efiChanged: false, pcrSets: ["7+8+9"], ...o } }));
    expect(hostTpmProblems(tpm({}), now)).toEqual([]);
    expect(hostAlarms(tpm({ secureBoot: false }), now).map((a) => a.key)).toEqual(["tpm"]);
    expect(hostTpmProblems(tpm({ pcrSets: ["7+8+9", "7"] }), now)[0]).toMatch(/PCR 7\+8\+9 \/ 7/);
    // Markierung von vor dem Start: Neu-Binden ist ausgeblieben
    expect(hostTpmProblems(tpm({ markerSince: "2026-10-13T08:00:00Z" }), now)[0]).toMatch(/Seit dem letzten Start/);
    // nach einem shim-/GRUB-Update startet der Server nicht selbst neu (wie bei der Passphrase)
    const efi = parseHostStatus(
      status({ rebootRequired: true, tpm: { secureBoot: true, markerSince: null, bootedAt: null, error: false, efiChanged: true, pcrSets: ["7+8+9"] } }),
    );
    expect(pendingPassphraseReboot(efi, now)).toBe(0);
    expect(hostAlarms(efi, now).map((a) => a.key)).toEqual(["neustart", "tpm"]);
  });

  it("Timer: beim Start und alle 10 Minuten", () => {
    expect(HOST_STATUS_TIMER).toContain("OnBootSec=1min");
    expect(HOST_STATUS_TIMER).toContain("OnUnitActiveSec=10min");
  });

  const sh = spawnSync("bash", ["-c", "command -v date stat awk"]).status === 0;
  it.skipIf(!sh)(
    "Skript (sh): Neustart-Datei und crypttab → status.json",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "schulos-host-"));
      try {
        writeFileSync(path.join(dir, "host.sh"), HOST_STATUS_SCRIPT);
        const run = (crypttab: string, reboot: boolean) => {
          writeFileSync(path.join(dir, "crypttab"), crypttab);
          rmSync(path.join(dir, "reboot-required"), { force: true });
          if (reboot)
            writeFileSync(
              path.join(dir, "reboot-required"),
              "*** System restart required ***\n",
            );
          const r = spawnSync(
            "bash",
            [
              "-c",
              'D=$(cygpath -u "$D" 2>/dev/null || echo "$D"); SCHULOS_HOST_DIR="$D/out" SCHULOS_REBOOT_FILE="$D/reboot-required" SCHULOS_CRYPTTAB="$D/crypttab" sh "$D/host.sh"',
            ],
            { encoding: "utf8", env: { ...process.env, D: dir } },
          );
          expect(r.status, r.stderr).toBe(0);
          return parseHostStatus(
            readFileSync(path.join(dir, "out", "status.json"), "utf8"),
          )!;
        };
        const pass = run(
          "schulos-root /dev/md/schulos none luks,discard\n",
          true,
        );
        expect(pass).toMatchObject({ rebootRequired: true, passphrase: true });
        expect(pass.since).not.toBeNull();
        expect(
          run(
            "schulos-root /dev/md/schulos none luks,discard,tpm2-device=auto\n",
            true,
          ),
        ).toMatchObject({ rebootRequired: true, passphrase: false });
        expect(
          run(
            "schulos-root PARTLABEL=x none luks,tpm2-device=auto,tpm2-pin=yes\n",
            false,
          ),
        ).toMatchObject({
          rebootRequired: false,
          passphrase: true,
          since: null,
          tpm: null,
        });
        // G4E-O15: Swap mit Zufallsschlüssel bzw. Schlüsseldatei braucht keine Eingabe
        expect(
          run(
            "schulos-root /dev/md/schulos none luks,discard,tpm2-device=auto\nswap /dev/sdb2 /dev/urandom swap\ndaten /dev/sdc1 /etc/keys/daten.key luks\n",
            false,
          ).passphrase,
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!sh)(
    "Skript (sh): G4E-O03 – TPM2-Bindung (Secure Boot, Markierung, Fehler, shim/GRUB geändert, PCR-Sätze) → status.json",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "schulos-host-"));
      try {
        writeFileSync(path.join(dir, "host.sh"), HOST_STATUS_SCRIPT);
        writeFileSync(path.join(dir, "crypttab"), "schulos-root PARTLABEL=schulos-system none luks,discard,tpm2-device=auto\n");
        writeFileSync(path.join(dir, "sb"), Buffer.from([6, 0, 0, 0, 1]));
        mkdirSync(path.join(dir, "stubs"));
        mkdirSync(path.join(dir, "tpm"));
        // cryptsetup-Attrappe: zwei TPM2-Plätze (Bindung + Übergang), JSON wie luksDump mit Zeilenumbrüchen
        writeFileSync(
          path.join(dir, "stubs", "cryptsetup"),
          '#!/bin/sh\n[ "$3" = /dev/disk/by-partlabel/schulos-system ] || exit 1\nprintf \'{"tokens":{"0":{"type":"systemd-tpm2","tpm2-pcrs":[\\n 7,\\n 8,\\n 9\\n]},"1":{"type":"systemd-recovery"},"2":{"type":"systemd-tpm2","tpm2-pcrs":[7]}}}\\n\'\n',
        );
        writeFileSync(path.join(dir, "tpm", "neu-binden"), "");
        writeFileSync(path.join(dir, "tpm", "efi-geaendert"), "");
        const r = spawnSync(
          "bash",
          [
            "-c",
            'D=$(cygpath -u "$D" 2>/dev/null || echo "$D"); chmod +x "$D"/stubs/*; PATH="$D/stubs:$PATH" SCHULOS_HOST_DIR="$D/out" SCHULOS_REBOOT_FILE="$D/none" SCHULOS_CRYPTTAB="$D/crypttab" SCHULOS_TPM_STATE="$D/tpm" SCHULOS_SB_VAR="$D/sb" sh "$D/host.sh"',
          ],
          { encoding: "utf8", env: { ...process.env, D: dir } },
        );
        expect(r.status, r.stderr).toBe(0);
        const s = parseHostStatus(readFileSync(path.join(dir, "out", "status.json"), "utf8"))!;
        expect(s.tpm).toMatchObject({ mode: "tpm2", secureBoot: true, error: null, efiChanged: true, pcrSets: ["7+8+9", "7"] });
        expect(s.tpm!.markerSince).not.toBeNull();
        expect(s.tpm!.bootedAt).not.toBeNull();
        // Fehlerdatei → error; ohne cryptsetup-Ausgabe → pcrSets null (nicht „leer“)
        writeFileSync(path.join(dir, "tpm", "fehler"), "x");
        writeFileSync(path.join(dir, "stubs", "cryptsetup"), "#!/bin/sh\nexit 1\n");
        const r2 = spawnSync(
          "bash",
          [
            "-c",
            'D=$(cygpath -u "$D" 2>/dev/null || echo "$D"); chmod +x "$D"/stubs/*; PATH="$D/stubs:$PATH" SCHULOS_HOST_DIR="$D/out" SCHULOS_REBOOT_FILE="$D/none" SCHULOS_CRYPTTAB="$D/crypttab" SCHULOS_TPM_STATE="$D/tpm" SCHULOS_SB_VAR="$D/sb" sh "$D/host.sh"',
          ],
          { encoding: "utf8", env: { ...process.env, D: dir } },
        );
        expect(r2.status, r2.stderr).toBe(0);
        const s2 = parseHostStatus(readFileSync(path.join(dir, "out", "status.json"), "utf8"))!;
        expect(s2.tpm).toMatchObject({ error: expect.any(String), pcrSets: null });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
