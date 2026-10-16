import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError, writePlan } from "./cli";
import { BACKUP, CTX, PRODUCTION } from "./fixtures";
import { backupCheckFor, nextStep, question, submitAnswer, visibleSteps } from "./flow";
import { generate } from "./generate";
import { parseLsblk } from "./system-info";

describe("Ablauf", () => {
  it("sichtbare Fragen hängen an früheren Antworten bzw. Vorgaben", () => {
    const ids = (a: Record<string, never> | typeof PRODUCTION) => visibleSteps(a, CTX).map((s) => s.question.id);
    expect(ids({})).toContain("web.domain");
    expect(ids({})).not.toContain("instance");
    expect(ids({ role: "main", instance: "demo" } as never)).toEqual([
      "locale.language",
      "locale.keyboard",
      "locale.timezone",
      "role",
      "instance",
      "disk.devices",
      "disk.encryption",
      "network.hostname",
      "network.mode",
      "network.proxy",
      "network.internal_nets",
      "access.password",
      "access.ssh",
      "access.console",
      "updates.channel",
      "updates.window",
      "web.domain",
      "web.tls",
      "web.public_access",
      "backup.mode",
    ]);
    const steps = visibleSteps(PRODUCTION, CTX);
    expect(steps.find((s) => s.question.id === "school.state")?.value).toBe("NW");
    expect(steps.map((s) => s.question.id)).toContain("backup.code");
  });

  it("„alle“ geht jede Frage durch, „fehlende“ nur Lücken und Fehler", () => {
    expect(nextStep({}, CTX, "alle", null)?.question.id).toBe("locale.language");
    expect(nextStep({}, CTX, "alle", "locale.timezone")?.question.id).toBe("role");
    expect(nextStep({}, CTX, "fehlende", null)?.question.id).toBe("role");
    expect(nextStep(PRODUCTION, CTX, "fehlende", null)).toBeNull();
    const noPw = { ...PRODUCTION, "admin.password": "zu kurz" };
    expect(nextStep(noPw, CTX, "fehlende", null)?.question.id).toBe("admin.password");
    expect(nextStep(PRODUCTION, CTX, "alle", "backup.code")).toBeNull();
  });

  it("Antwort übernehmen: Typ, Prüfung im Zusammenhang, optional leer, Hinweis", () => {
    const a = { role: "main", instance: "production" };
    expect(submitAnswer(question("school.number"), "12345", a, CTX)).toEqual({ ok: false, error: "Schulnummer in NRW: 6 Ziffern" });
    expect(submitAnswer(question("school.number"), "123456", a, CTX)).toMatchObject({ ok: true, answers: { "school.number": "123456" } });
    expect(submitAnswer(question("network.proxy"), "", { ...a, "network.proxy": "http://p:1" }, CTX)).toEqual({ ok: true, answers: a, warning: null });
    expect(submitAnswer(question("web.domain"), "", a, CTX)).toEqual({ ok: false, error: "Bitte ausfüllen" });
    expect(submitAnswer(question("disk.devices"), [], a, CTX)).toMatchObject({ ok: false, error: expect.stringContaining("Leertaste") });
    expect(submitAnswer(question("access.ssh"), "vielleicht", a, CTX)).toEqual({ ok: false, error: "ja oder nein" });
    expect(submitAnswer(question("school.state"), "BY", a, CTX)).toMatchObject({ ok: true, warning: expect.stringContaining("Nordrhein-Westfalen") });
    expect(submitAnswer(question("network.dns"), "10.0.0.1, 10.0.0.2", a, CTX)).toMatchObject({ ok: true, answers: { "network.dns": ["10.0.0.1", "10.0.0.2"] } });
  });

  it("Backupserver prüfen nur beim Hauptsystem mit „jetzt koppeln“", () => {
    expect(backupCheckFor(PRODUCTION, CTX)).toEqual({ url: "https://backup.gs-musterstadt.de", code: "k7q2 9mxa 4rt1" });
    expect(backupCheckFor({ ...PRODUCTION, "backup.mode": "later" }, CTX)).toBeNull();
    expect(backupCheckFor(BACKUP, CTX)).toBeNull();
  });
});

describe("Rechner erkennen", () => {
  it("lsblk: nur freie, beschreibbare Platten – nicht das Startmedium, kein Loop/CD", () => {
    const json = JSON.stringify({
      blockdevices: [
        { path: "/dev/loop0", size: 900_000_000, model: null, type: "loop", ro: true, mountpoints: ["/run/live/rootfs/filesystem.squashfs"] },
        {
          path: "/dev/sda",
          size: 16_000_000_000,
          model: "USB Stick  ",
          type: "disk",
          ro: false,
          mountpoints: [null],
          children: [{ path: "/dev/sda1", size: 1, type: "part", ro: false, mountpoints: ["/run/live/medium"] }],
        },
        { path: "/dev/nvme0n1", size: 512_110_190_592, model: "Samsung SSD 980 PRO", type: "disk", ro: false, mountpoints: [null], children: [{ path: "/dev/nvme0n1p1", type: "part", mountpoints: [null] }] },
        { path: "/dev/sdb", size: "2000398934016", model: null, type: "disk", ro: "0", mountpoints: [null] },
        { path: "/dev/sr0", size: 1_000_000, model: "DVD", type: "rom", ro: true, mountpoints: [null] },
        { path: "/dev/sdc", size: 0, model: "Kartenleser", type: "disk", ro: false, mountpoints: [null] },
      ],
    });
    expect(parseLsblk(json)).toEqual([
      { path: "/dev/nvme0n1", sizeBytes: 512_110_190_592, model: "Samsung SSD 980 PRO" },
      { path: "/dev/sdb", sizeBytes: 2_000_398_934_016, model: "unbekannt" },
    ]);
  });
});

describe("Aufruf", () => {
  it("Argumente", () => {
    const base = { answersFile: null, unattended: false, outDir: "/run/schulos-installer", install: false, planFile: null, target: "/target", mirror: "file:///run/live/medium/debian", medium: "/run/live/medium/schulos", image: null, configure: false, skipConfirmation: false, overwrite: false, testMode: false, previewAccepted: false };
    expect(parseArgs([])).toEqual(base);
    expect(parseArgs(["--antworten", "a.yaml", "--unbeaufsichtigt", "--ausgabe", "/tmp/x", "--installieren", "--testmodus", "--vorschau-verstanden"])).toEqual({
      ...base,
      answersFile: "a.yaml",
      unattended: true,
      outDir: "/tmp/x",
      install: true,
      testMode: true,
      previewAccepted: true,
    });
    expect(parseArgs(["--plan", "p.json", "--ziel", "/mnt", "--quelle", "http://deb.debian.org/debian"])).toEqual({
      ...base,
      planFile: "p.json",
      install: true,
      target: "/mnt",
      mirror: "http://deb.debian.org/debian",
    });
    expect(() => parseArgs(["--plan", "p.json", "--antworten", "a.yaml"])).toThrow(/schließen sich aus/);
    expect(parseArgs(["-h"])).toBe("help");
    expect(() => parseArgs(["--unbeaufsichtigt"])).toThrow(UsageError);
    // INST-05: Schalter nur für Tests, nur unbeaufsichtigt
    expect(parseArgs(["--antworten", "a.yaml", "--unbeaufsichtigt", "--ohne-bestaetigung", "--testmodus"])).toMatchObject({ unattended: true, skipConfirmation: true });
    expect(() => parseArgs(["--ohne-bestaetigung"])).toThrow(/nur zusammen mit --unbeaufsichtigt/);
    // INST-06: Überschreibschutz-Schalter, nicht für Abbild/Einrichtung
    expect(parseArgs(["--antworten", "a.yaml", "--unbeaufsichtigt", "--ueberschreiben", "--installieren", "--testmodus", "--vorschau-verstanden"])).toMatchObject({ unattended: true, overwrite: true });
    expect(parseArgs(["--plan", "p.json", "--ueberschreiben"])).toMatchObject({ planFile: "p.json", overwrite: true });
    expect(() => parseArgs(["--abbild", "main", "--ueberschreiben", "--testmodus"])).toThrow(/nur beim Installieren/);
    expect(() => parseArgs(["--antworten"])).toThrow(/braucht einen Wert/);
    expect(() => parseArgs(["--x"])).toThrow(/Unbekannte Angabe/);
  });

  it("Plan ablegen: plan.json mit Systemangaben, Dateien unter root/", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-plan-"));
    const plan = await generate({ ...BACKUP, "disk.encryption": "passphrase", "disk.passphrase": "Platte-im-Keller-2026" }, { hashPassword }, CTX);
    const file = writePlan(plan, dir);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.system).toMatchObject({ role: "backup", "disk.devices": ["/dev/sda", "/dev/sdb"], "disk.passphrase": "Platte-im-Keller-2026", "access.password": "Wartung-im-Keller-2026" });
    expect(Object.keys(saved.system).some((k) => k.startsWith("admin.") || k.startsWith("web."))).toBe(false);
    expect(readFileSync(path.join(dir, "root/opt/schulos-backup/backup.env"), "utf8")).toContain("SCHULOS_INITIAL_PAIRING_CODE=");
    rmSync(dir, { recursive: true, force: true });
  });
});
