import { spawnSync } from "node:child_process";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { generate, type InstallPlan } from "../generate";
import { BACKUP, CTX, PRODUCTION } from "../fixtures";
import { consoleScript, consoleUnit, dockerDaemonJson, firstbootEnv, firstbootScript, schulosSteps } from "./schulos-steps";
import type { Step } from "./steps";

const deps = { hashPassword, randomSecret: () => "zufall", pairingCode: () => "AB12-CD34-EF56" };
const O = { target: "/target", mirror: "file:///run/live/medium/debian", keyFile: "/run/k", dist: "/run/live/medium/schulos" };
const argvs = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: "run" }> => s.kind === "run").map((s) => s.argv.join(" "));
const written = (steps: Step[], path: string) => (steps.find((s) => s.kind === "write" && s.path === path) as Extract<Step, { kind: "write" }> | undefined)?.content;

/** Syntax mit bash prüfen (bash -n) – dieselbe Shell wie auf dem Server */
function bashSyntax(script: string): string {
  const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return r.status === 0 ? "ok" : r.stderr;
}

/** Erststart-Angaben so lesen, wie bash sie lädt (set -a; . datei) */
function sourceEnv(text: string, names: string[]): Record<string, string> {
  // über stdin – unter Windows verbiegt die Argumentübergabe Anführungszeichen und Zeilenumbrüche
  const script = `set -a\n${text}\nfor n in ${names.join(" ")}; do printf '%s=%s\\n' "$n" "\${!n}"; done\n`;
  const r = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

describe("SchulOS-Schritte", () => {
  it("Hauptsystem: Docker mit containerd-Speicher unter /srv, Node 24, Stack, schulosctl, Timer, Images, Erststart, Konsole", async () => {
    const plan = await generate(PRODUCTION, deps, CTX);
    const steps = schulosSteps(plan, O);
    const a = argvs(steps);
    expect(JSON.parse(written(steps, "/target/etc/docker/daemon.json")!)).toEqual({
      features: { "containerd-snapshotter": true },
      "data-root": "/srv/docker",
      "log-driver": "local",
      "live-restore": true,
      // GATE-4c: IPv6 nicht über docker-proxy mit der Gateway-Adresse („Schulnetz“) einschleusen
      "userland-proxy": false,
    });
    expect(a).toContain("cp -a /run/live/medium/schulos/node /target/opt/schulos-node");
    expect(a).toContain("cp /run/live/medium/schulos/compose.yaml /target/opt/schulos/compose.yaml");
    expect(written(steps, "/target/opt/schulos/schulos.env")).toContain("SCHULOS_INSTANCE=production");
    expect(written(steps, "/target/etc/systemd/system/schulos-wartung.timer.d/fenster.conf")).toContain("OnCalendar=*-*-* 02:30:00");
    expect(written(steps, "/target/usr/local/bin/schulosctl")).toContain("exec /usr/bin/node /opt/schulos/schulosctl.mjs --dir /opt/schulos");
    expect(a).toContain("chroot /target systemctl enable schulos-sync.timer schulos-wartung.timer schulos-vorschau.timer");
    expect(a).toContain("chroot /target systemctl enable docker schulos-erststart.service schulos-konsole.service");
    expect(a).toContain("chroot /target usermod --append --groups docker schulos-admin");
    expect(steps.find((s) => s.kind === "write" && s.path.endsWith("erststart.env"))).toMatchObject({ mode: 0o600 });
    // Konsole: Adresse + letztes Backup aus dem Zustand des Agenten
    const konsole = written(steps, "/target/usr/local/lib/schulos/konsole.sh")!;
    expect(konsole).toContain("URL='https://schulos.gs-musterstadt.de'");
    expect(konsole).toContain("j.lastOkAt");
    expect(konsole).toContain('echo "  Web-Oberfläche:  $URL"');
    expect(konsole).toContain("https://$ip");
    // kein QR-Code (INST-05), kein Kopplungshinweis auf dem Hauptsystem
    expect(konsole).not.toMatch(/qrencode|Kopplungscode erzeugen/);
  });

  it("Backupserver: kein schulosctl/Timer, Stack aus compose.backup.yaml, Offsite-Host für den Schlüsselabgleich", async () => {
    const plan = await generate({ ...BACKUP, "offsite.type": "sftp", "offsite.host": "u1.your-storagebox.de", "offsite.port": 23, "offsite.user": "u1", "offsite.password": "Box-Pass-1" }, deps, CTX);
    const steps = schulosSteps(plan, O);
    const a = argvs(steps);
    expect(a).toContain("cp /run/live/medium/schulos/compose.backup.yaml /target/opt/schulos-backup/compose.yaml");
    expect(a.some((x) => x.includes("schulosctl") || x.includes("schulos-sync.timer"))).toBe(false);
    const konsole = written(steps, "/target/usr/local/lib/schulos/konsole.sh")!;
    expect(konsole).not.toContain("Letztes Backup");
    // INST-05: Adresse + wo es weitere Kopplungscodes gibt
    expect(konsole).toContain('echo "  Web-Oberfläche:  $URL"');
    expect(konsole).toContain("unter „Instanzen“ → „Kopplungscode erzeugen“");
    expect(konsole).not.toContain("qrencode");
    const env = sourceEnv(written(steps, "/target/etc/schulos/erststart.env")!, ["ROLE", "STACK", "OFFSITE_HOST", "OFFSITE_PORT", "PAIR_URL"]);
    expect(env).toEqual({ ROLE: "backup", STACK: "/opt/schulos-backup", OFFSITE_HOST: "u1.your-storagebox.de", OFFSITE_PORT: "23", PAIR_URL: "" });
  });

  it("Erststart-Angaben: Kopplung bzw. Wiederherstellung, Werte mit Sonderzeichen kommen in bash unverändert an", async () => {
    const pair = await generate(PRODUCTION, deps, CTX);
    expect(sourceEnv(firstbootEnv(pair), ["ROLE", "PAIR_URL", "PAIR_CODE", "RESTORE"])).toEqual({
      ROLE: "main",
      PAIR_URL: "https://backup.gs-musterstadt.de",
      PAIR_CODE: "K7Q2-9MXA-4RT1",
      RESTORE: "",
    });
    const fromBackup = await generate({ ...PRODUCTION, instance: "restore-backup" }, deps, CTX);
    expect(fromBackup.restore).toEqual({ mode: "backup" });
    expect(sourceEnv(firstbootEnv(fromBackup), ["RESTORE", "PAIR_CODE"])).toEqual({ RESTORE: "backup", PAIR_CODE: "K7Q2-9MXA-4RT1" });

    const plan: InstallPlan = {
      ...fromBackup,
      pairing: undefined,
      restore: { mode: "offsite", recoveryKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", env: { SCHULOS_OFFSITE: "offsite:schulos", RCLONE_CONFIG_OFFSITE_PASS: "a'b $x `y`" } },
    };
    expect(sourceEnv(firstbootEnv(plan), ["RESTORE", "SCHULOS_RECOVERY_KEY", "SCHULOS_OFFSITE", "RCLONE_CONFIG_OFFSITE_PASS", "PAIR_URL"])).toEqual({
      RESTORE: "offsite",
      SCHULOS_RECOVERY_KEY: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF",
      SCHULOS_OFFSITE: "offsite:schulos",
      RCLONE_CONFIG_OFFSITE_PASS: "a'b $x `y`",
      PAIR_URL: "",
    });
  });

  it("Skripte sind gültiges bash; Docker-Konfiguration ist JSON", async () => {
    expect(bashSyntax(firstbootScript())).toBe("ok");
    expect(bashSyntax(consoleScript(await generate(PRODUCTION, deps, CTX), "schulos.schule.de"))).toBe("ok");
    expect(bashSyntax(consoleScript(await generate(BACKUP, deps, CTX), "backup.schule.de"))).toBe("ok");
    expect(() => JSON.parse(dockerDaemonJson())).not.toThrow();
    // Wiederherstellen vor dem ersten App-Start, Kopplung sonst erst danach (und nicht fatal)
    const s = firstbootScript();
    expect(s.indexOf("wiederherstellen\n")).toBeLessThan(s.indexOf('status "SchulOS starten"'));
    expect(s).toMatch(/koppeln "\$PAIR_URL" "\$PAIR_CODE" \|\| echo "Kopplung fehlgeschlagen/);
  });
});

describe("Konsolenstatus (INST-03)", () => {
  it("UTF-8-Modus, SchulOS-Schrift (ohne QR-Code, INST-05), Enter = Anmeldung per agetty", async () => {
    const plan = await generate(PRODUCTION, deps, CTX);
    const k = consoleScript(plan, "schulos.schule.de");
    expect(bashSyntax(k)).toBe("ok");
    expect(k).toContain("printf '"+String.fromCharCode(92)+"033%%G'");
    expect(k).toContain("FONT_DIR=/usr/local/share/schulos/konsolenschrift");
    expect(k).toContain("setfont -C /dev/tty1");
    // größte Größe zuerst; Schriften aus console-font.ts
    expect(k).toContain("for size in 16x32 14x28 12x24 11x22 10x20 8x16; do");
    // Schrift vor jedem Zeichnen neu laden (INST-05)
    expect(k).toContain("while true; do\n  load_font\n  clear\n");
    expect(k).toContain("read -r -s -t 30");
    expect(k).toContain("exec /sbin/agetty --noclear");
    expect(k).toContain("Enter drücken zum Anmelden");
    expect(k).toContain("Strg+Alt+F2");
    expect(k).not.toMatch(/autologin/i);
  });

  it("Unit: tty1 mit Terminal, Neustart nach dem Abmelden", () => {
    const u = consoleUnit();
    expect(u).toContain("StandardInput=tty");
    expect(u).toContain("TTYPath=/dev/tty1");
    expect(u).toContain("Restart=always");
    expect(u).toContain("Conflicts=getty@tty1.service");
    expect(u).not.toMatch(/autologin/i);
  });

  it("Schritte: Schrift kopieren (tolerant), console-setup, getty@tty2", async () => {
    const steps = schulosSteps(await generate(PRODUCTION, deps, CTX), O);
    const a = argvs(steps);
    const copy = a.find((x) => x.includes("konsolenschrift") && x.startsWith("sh -c"))!;
    expect(copy).toContain("[ ! -d \"$1\" ] ||");
    expect(copy).toContain("/usr/local/share/schulos/konsolenschrift /target/usr/local/share/schulos/konsolenschrift");
    expect(a).toContain("chroot /target systemctl enable getty@tty2.service");
  });
});

describe("Wiederherstellungs-Modi im Installer", () => {
  it("aus Backup: kein Admin/keine Schule, Ersatz-Kopplungscode; aus Offsite: Ziel + Wiederherstellungsschlüssel", async () => {
    const { resolve } = await import("../answers");
    const base = { role: "main", "disk.devices": ["/dev/sda"], "access.password": "Wartung-im-Keller-2026", "web.domain": "schulos.gs-musterstadt.de" };
    const rb = resolve({ ...base, instance: "restore-backup" }, CTX);
    expect(rb.missing).toEqual(["backup.url", "backup.code"]);
    expect(Object.keys(rb.answers).some((k) => k.startsWith("admin.") || k.startsWith("school."))).toBe(false);
    const ro = resolve({ ...base, instance: "restore-offsite" }, CTX);
    expect(ro.missing).toEqual(["offsite.type", "restore.recovery_key"]);
    const full = resolve(
      {
        ...base,
        instance: "restore-offsite",
        "offsite.type": "sftp",
        "offsite.host": "u1.your-storagebox.de",
        "offsite.port": 23,
        "offsite.user": "u1",
        "offsite.password": "Box-Pass-1",
        "restore.recovery_key": "aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff",
      },
      CTX,
    );
    expect(full.complete).toBe(true);
    const plan = await generate(full.answers, deps, CTX);
    expect(plan.pairing).toBeUndefined();
    expect(plan.restore).toMatchObject({
      mode: "offsite",
      recoveryKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF",
      env: { SCHULOS_OFFSITE: "offsite:schulos", RCLONE_CONFIG_OFFSITE_TYPE: "sftp", RCLONE_CONFIG_OFFSITE_KNOWN_HOSTS_FILE: "/run/offsite_known_hosts" },
    });
    // Offsite-Zugang landet nicht in schulos.env (das Hauptsystem richtet keine Offsite-Kopie ein)
    expect(plan.files.find((f) => f.path.endsWith("schulos.env"))!.content).not.toContain("RCLONE");
    expect(plan.files.find((f) => f.path.endsWith("schulos.env"))!.content).toContain("SCHULOS_INSTANCE=production");
    expect(resolve({ ...full.answers, "restore.recovery_key": "zu-kurz" }, CTX).errors[0]!.id).toBe("restore.recovery_key");
  });
});
